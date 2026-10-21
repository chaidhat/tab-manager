import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { errorMessage } from './cli';
import { log } from './log';

// Claude Code keeps one file per running session here, named `<pid>.json`, and
// rewrites it whenever the session's status changes. The file is removed when
// the session exits normally.
//
// This is an internal detail of Claude Code, not a documented interface, so
// everything below treats it as untrusted input: a file that has moved, gone
// missing, or changed shape leaves the session list empty rather than throwing.
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

/**
 * What a session is doing, as the view thinks about it. Claude Code writes four
 * raw statuses; `idle` and `shell` both mean "not working, nothing blocking it"
 * — `shell` is only idle with something already typed at the prompt — so they
 * collapse into one state here and nothing downstream has to know the
 * difference.
 */
export type SessionState = 'asking' | 'working' | 'done';

const STATE_OF: Record<string, SessionState> = {
  waiting: 'asking',
  busy: 'working',
  idle: 'done',
  shell: 'done',
};

/** The order rows appear in: whatever wants you first, finished work last. */
const STATE_ORDER: Record<SessionState, number> = { asking: 0, working: 1, done: 2 };

/** One running Claude Code session. */
export interface Session {
  readonly agent: 'Claude' | 'Codex';
  /** Present only when the Codex completion hook and saved turn agree. */
  readonly completionId?: string;
  /** A Codex subagent's direct parent; absent for top-level sessions. */
  readonly parentSessionId: string | undefined;
  /** Stable across the session's life — what notifications are keyed on. */
  readonly sessionId: string;
  /** Claude publishes its process id; Codex identifies liveness with a lock. */
  readonly pid: number | undefined;
  /** The folder the session is running in. */
  readonly cwd: string;
  /** The session's own name, e.g. `tab-manager-ba`. */
  readonly name: string;
  readonly state: SessionState;
  /** What an asking session is blocked on, when it says. */
  readonly waitingFor: string | undefined;
  /** A more specific state label, such as a stopped subagent. */
  readonly activity: string | undefined;
  /** When it entered {@link state} — what the row's age counts from. */
  readonly stateSince: number;
}

// Files we have already complained about, so a malformed one doesn't fill the
// log at the polling interval. A name is forgiven once it reads cleanly again,
// which is what makes a half-written file a one-line blip rather than silence
// if it stays broken.
const reported = new Set<string>();

/**
 * Every live Claude Code session whose folder is inside one of `repoRoots`,
 * ordered by how much it wants your attention.
 *
 * Sessions are dropped — with a line in the log — when their file cannot be
 * read or does not look like a session, and silently when their process is
 * gone (a session killed with `SIGKILL` never gets to delete its file) or when
 * they are running somewhere outside the configured repositories.
 */
export async function readSessions(repoRoots: readonly string[]): Promise<Session[]> {
  let names: string[];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch (error) {
    reportOnce(SESSIONS_DIR, `sessions: cannot read ${SESSIONS_DIR} — ${errorMessage(error)}`);
    return [];
  }
  reported.delete(SESSIONS_DIR);

  const sessions = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readSession(name)),
  );
  return sessions
    .filter((session): session is Session => session !== undefined)
    .filter((session) => repoRoots.some((repoRoot) => isInside(session.cwd, repoRoot)))
    .sort(
      (left, right) =>
        STATE_ORDER[left.state] - STATE_ORDER[right.state] || left.name.localeCompare(right.name),
    );
}

/** One session file, or undefined if it is unreadable, malformed, or dead. */
async function readSession(fileName: string): Promise<Session | undefined> {
  const file = path.join(SESSIONS_DIR, fileName);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    // Also the path a half-written file takes: it reads cleanly a moment later,
    // and reportOnce keeps that from being a line of log per poll.
    reportOnce(file, `sessions: cannot read ${fileName} — ${errorMessage(error)}`);
    return undefined;
  }
  reported.delete(file);

  const session = toSession(raw);
  if (session === undefined) {
    reportOnce(file, `sessions: ${fileName} is not a session file — ignoring it`);
    return undefined;
  }
  // A dead process is the ordinary end of a session, not a fault: no log.
  return session.pid !== undefined && isAlive(session.pid) ? session : undefined;
}

/** The parsed file as a {@link Session}, or undefined if a field is missing. */
function toSession(raw: unknown): Session | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const pid = fields.pid;
  const sessionId = fields.sessionId;
  const cwd = fields.cwd;
  const state = typeof fields.status === 'string' ? STATE_OF[fields.status] : undefined;
  if (
    typeof pid !== 'number' ||
    typeof sessionId !== 'string' ||
    sessionId === '' ||
    typeof cwd !== 'string' ||
    cwd === '' ||
    state === undefined
  ) {
    return undefined;
  }
  return {
    agent: 'Claude',
    parentSessionId: undefined,
    sessionId,
    pid,
    cwd,
    // A session names itself after its folder when nothing has renamed it, so
    // falling back to the folder name matches what it would have called itself.
    name: typeof fields.name === 'string' && fields.name !== '' ? fields.name : path.basename(cwd),
    state,
    waitingFor:
      typeof fields.waitingFor === 'string' && fields.waitingFor !== ''
        ? fields.waitingFor
        : undefined,
    activity: undefined,
    // Missing only for a session that has not changed state since it started,
    // in which case its age is its whole life — which is what we want to show.
    stateSince:
      typeof fields.statusUpdatedAt === 'number'
        ? fields.statusUpdatedAt
        : typeof fields.startedAt === 'number'
          ? fields.startedAt
          : Date.now(),
  };
}

/**
 * Whether a process is still running. Signal 0 does no signalling — it only
 * runs the checks a real signal would, so it answers the question without
 * touching the process. `EPERM` means it exists but belongs to someone else,
 * which still counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether `child` is `parent` or sits inside it. Compared as a relative path
 * rather than a string prefix so `/code/tab-manager-old` is not treated as
 * being inside `/code/tab-manager`.
 */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Logs `message` unless `key` has already been complained about. */
function reportOnce(key: string, message: string): void {
  if (!reported.has(key)) {
    reported.add(key);
    log(message);
  }
}
