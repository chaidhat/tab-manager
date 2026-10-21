import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from './cli';
import { Session } from './claudeSessions';
import { readCodexSubagents } from './codexSubagents';
import { readCodexTurnStates } from './codexTurns';
import { log } from './log';
import { readTimeline, Timeline } from './codexTimeline';
import { confirmedCompletion, readCompletion } from './codexCompletion';

// Codex keeps one empty lock per thread currently held by the app or CLI. The
// thread's append-only rollout supplies its folder and current turn state, and
// session_index.jsonl supplies the user-facing name. These are internal files,
// so every value is validated and a changed or partial file is ignored.
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const LOCKS_DIR = path.join(CODEX_DIR, 'thread-writer-locks');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const SESSION_INDEX = path.join(CODEX_DIR, 'session_index.jsonl');
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_LINE_MAX_BYTES = 1024 * 1024;

const reported = new Set<string>();
let nameIndex: { modifiedAt: number; names: ReadonlyMap<string, string> } | undefined;

/**
 * Every open Codex thread whose folder is inside both a configured repository
 * and a currently open VS Code window.
 */
export async function readCodexSessions(
  repoRoots: readonly string[],
  openWindowFolders: readonly string[],
): Promise<Session[]> {
  let lockNames: string[];
  try {
    lockNames = await fs.readdir(LOCKS_DIR);
  } catch (error) {
    reportOnce(LOCKS_DIR, `codex sessions: cannot read ${LOCKS_DIR} — ${errorMessage(error)}`);
    return [];
  }
  reported.delete(LOCKS_DIR);

  const names = await readNameIndex();
  const sessions = await Promise.all(
    lockNames
      .filter((name) => name.endsWith('.lock'))
      .map((name) => name.slice(0, -'.lock'.length))
      .filter((id) => THREAD_ID.test(id))
      .map((id) => readCodexSession(id, names)),
  );
  const rootsFromFiles = sessions
    .filter((session): session is CodexSession => session !== undefined)
    .filter((session) => repoRoots.some((repoRoot) => isInside(session.cwd, repoRoot)))
    .filter((session) => openWindowFolders.some((folder) => isInside(session.cwd, folder)));
  const turnStates = await readCodexTurnStates(rootsFromFiles.map((session) => session.sessionId));
  const roots = await Promise.all(
    rootsFromFiles.map(async (session) => {
      const turn = turnStates.get(session.sessionId);
      const timeline = session.timeline;
      const hook = timeline.turnId
        ? await readCompletion(session.sessionId, timeline.turnId)
        : undefined;
      const completionId = confirmedCompletion(timeline, turn, hook);
      return {
        ...session,
        completionId,
        // Never turn missing evidence, interrupted work, or a stale database row into success.
        state: completionId ? ('done' as const) : ('working' as const),
        activity:
          !completionId && timeline.status !== 'task_started'
            ? 'completion unconfirmed'
            : undefined,
      };
    }),
  );
  return [...roots, ...(await readCodexSubagents(roots.map((session) => session.sessionId)))];
}

interface CodexSession extends Session {
  readonly timeline: Timeline;
}

/** Recheck immediately before notifying, after any other notifications have been sent. */
export async function isCodexCompletionCurrent(session: Session): Promise<boolean> {
  if (!session.completionId) {
    return false;
  }
  const current = await readCodexSession(session.sessionId, new Map());
  if (!current) {
    return false;
  }
  const turns = await readCodexTurnStates([session.sessionId]);
  const hook = await readCompletion(session.sessionId, session.completionId);
  return (
    confirmedCompletion(current.timeline, turns.get(session.sessionId), hook) ===
    session.completionId
  );
}

async function readCodexSession(
  sessionId: string,
  names: ReadonlyMap<string, string>,
): Promise<CodexSession | undefined> {
  const rollout = await findRollout(sessionId);
  if (rollout === undefined) {
    return undefined;
  }

  try {
    const handle = await fs.open(rollout, 'r');
    try {
      const stat = await handle.stat();
      const firstLine = await readFirstLine(handle, stat.size);
      const meta = parseSessionMeta(firstLine);
      if (meta === undefined || meta.sessionId !== sessionId) {
        reportOnce(rollout, `codex sessions: ${path.basename(rollout)} has invalid metadata`);
        return undefined;
      }

      const timeline = await readTimeline(rollout, handle);
      reported.delete(rollout);
      return {
        agent: 'Codex',
        timeline,
        parentSessionId: undefined,
        sessionId,
        pid: undefined,
        cwd: meta.cwd,
        name: names.get(sessionId) ?? path.basename(meta.cwd),
        state: timeline.state,
        waitingFor: undefined,
        activity: undefined,
        stateSince: timeline.stateSince,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    reportOnce(
      rollout,
      `codex sessions: cannot read ${path.basename(rollout)} — ${errorMessage(error)}`,
    );
    return undefined;
  }
}

/** Finds a rollout without walking all historical sessions once per poll. */
async function findRollout(sessionId: string): Promise<string | undefined> {
  const timestamp = Number.parseInt(sessionId.replaceAll('-', '').slice(0, 12), 16);
  if (!Number.isSafeInteger(timestamp)) {
    return undefined;
  }
  const created = new Date(timestamp);
  const directory = path.join(
    SESSIONS_DIR,
    String(created.getFullYear()),
    String(created.getMonth() + 1).padStart(2, '0'),
    String(created.getDate()).padStart(2, '0'),
  );
  try {
    const name = (await fs.readdir(directory)).find((candidate) =>
      candidate.endsWith(`-${sessionId}.jsonl`),
    );
    return name === undefined ? undefined : path.join(directory, name);
  } catch {
    return undefined;
  }
}

async function readFirstLine(handle: fs.FileHandle, fileSize: number): Promise<string> {
  const size = Math.min(fileSize, FIRST_LINE_MAX_BYTES);
  const text = (await readBytes(handle, size, 0)).toString('utf8');
  const end = text.indexOf('\n');
  if (end < 0) {
    throw new Error('session metadata line is missing or too large');
  }
  return text.slice(0, end);
}

async function readBytes(handle: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

interface SessionMeta {
  readonly sessionId: string;
  readonly cwd: string;
}

function parseSessionMeta(line: string): SessionMeta | undefined {
  const record = parseRecord(line);
  const payload = objectField(record, 'payload');
  const sessionId = stringField(payload, 'session_id') ?? stringField(payload, 'id');
  const cwd = stringField(payload, 'cwd');
  return stringField(record, 'type') === 'session_meta' && sessionId && cwd
    ? { sessionId, cwd }
    : undefined;
}

async function readNameIndex(): Promise<ReadonlyMap<string, string>> {
  try {
    const stat = await fs.stat(SESSION_INDEX);
    if (nameIndex?.modifiedAt === stat.mtimeMs) {
      return nameIndex.names;
    }
    const names = new Map<string, string>();
    for (const line of (await fs.readFile(SESSION_INDEX, 'utf8')).split('\n')) {
      const record = parseRecord(line);
      const id = stringField(record, 'id');
      const name = stringField(record, 'thread_name');
      if (id && name) {
        names.set(id, name);
      }
    }
    nameIndex = { modifiedAt: stat.mtimeMs, names };
    reported.delete(SESSION_INDEX);
    return names;
  } catch (error) {
    reportOnce(
      SESSION_INDEX,
      `codex sessions: cannot read ${SESSION_INDEX} — ${errorMessage(error)}`,
    );
    return nameIndex?.names ?? new Map();
  }
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (line === '') {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function objectField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return typeof field === 'object' && field !== null
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function reportOnce(key: string, message: string): void {
  if (!reported.has(key)) {
    reported.add(key);
    log(message);
  }
}
