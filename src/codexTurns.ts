import * as os from 'os';
import * as path from 'path';
import { SessionState } from './claudeSessions';
import { errorMessage } from './cli';
import { log } from './log';

const TURN_DATABASE = path.join(
  process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  'thread_history_1.sqlite',
);

interface Database {
  prepare(sql: string): { all(...values: string[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (filename: string, options: { readOnly: boolean }) => Database;
}

export interface CodexTurnState {
  readonly turnId: string;
  readonly status: string;
  readonly state: SessionState;
  readonly stateSince: number;
}

const reported = new Set<string>();

/** The latest turn state recorded by Codex for each requested thread. */
export async function readCodexTurnStates(
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, CodexTurnState>> {
  if (threadIds.length === 0) {
    return new Map();
  }

  let database: Database | undefined;
  try {
    const moduleName: string = 'node:sqlite';
    const sqlite = (await import(moduleName)) as SqliteModule;
    database = new sqlite.DatabaseSync(TURN_DATABASE, { readOnly: true });
    const placeholders = threadIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `SELECT threadId, turnId, status, startedAt, completedAt
         FROM (
           SELECT thread_id AS threadId,
                  turn_id AS turnId,
                  status AS status,
                  started_at AS startedAt,
                  completed_at AS completedAt,
                  ROW_NUMBER() OVER (
                    PARTITION BY thread_id
                    ORDER BY started_at DESC, rollout_ordinal DESC
                  ) AS position
           FROM thread_turns
           WHERE thread_id IN (${placeholders})
         )
         WHERE position = 1`,
      )
      .all(...threadIds);

    const states = new Map<string, CodexTurnState>();
    for (const raw of rows) {
      const parsed = toState(raw);
      if (parsed !== undefined) {
        states.set(parsed.threadId, parsed.state);
      }
    }
    reported.delete(TURN_DATABASE);
    return states;
  } catch (error) {
    reportOnce(
      TURN_DATABASE,
      `codex sessions: cannot read ${TURN_DATABASE} — ${errorMessage(error)}`,
    );
    return new Map();
  } finally {
    database?.close();
  }
}

function toState(
  raw: unknown,
): { readonly threadId: string; readonly state: CodexTurnState } | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const threadId = fields.threadId;
  const status = fields.status;
  const turnId = fields.turnId;
  const startedAt = fields.startedAt;
  const completedAt = fields.completedAt;
  if (
    typeof threadId !== 'string' ||
    threadId === '' ||
    typeof status !== 'string' ||
    typeof turnId !== 'string' ||
    turnId === '' ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt)
  ) {
    return undefined;
  }
  if (status === 'inProgress') {
    return {
      threadId,
      state: { turnId, status, state: 'working', stateSince: startedAt * 1000 },
    };
  }
  if (status === 'completed' || status === 'interrupted') {
    return {
      threadId,
      state: {
        turnId,
        status,
        state: 'done',
        stateSince:
          typeof completedAt === 'number' && Number.isFinite(completedAt)
            ? completedAt * 1000
            : startedAt * 1000,
      },
    };
  }
  reportOnce(`status:${status}`, `codex sessions: unknown turn state ${status} — ignoring it`);
  return undefined;
}

function reportOnce(key: string, message: string): void {
  if (!reported.has(key)) {
    reported.add(key);
    log(message);
  }
}
