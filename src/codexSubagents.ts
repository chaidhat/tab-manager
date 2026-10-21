import * as os from 'os';
import * as path from 'path';
import { Session, SessionState } from './claudeSessions';
import { errorMessage } from './cli';
import { log } from './log';

const STATE_DATABASE = path.join(os.homedir(), '.codex', 'state_5.sqlite');

interface Database {
  prepare(sql: string): { all(...values: string[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (filename: string, options: { readOnly: boolean }) => Database;
}

interface SubagentRow {
  readonly parentId: string;
  readonly childId: string;
  readonly status: string;
  readonly cwd: string;
  readonly name: string | undefined;
  readonly nickname: string | undefined;
  readonly role: string | undefined;
  readonly agentPath: string | undefined;
  readonly updatedAt: number;
}

interface DisplayState {
  readonly state: SessionState;
  readonly activity: string;
}

const DISPLAY_STATE: Readonly<Record<string, DisplayState>> = {
  pendingInit: { state: 'working', activity: 'starting' },
  running: { state: 'working', activity: 'working' },
  completed: { state: 'done', activity: 'done' },
  interrupted: { state: 'done', activity: 'interrupted' },
  errored: { state: 'done', activity: 'failed' },
};

const reported = new Set<string>();

/** Every visible descendant of one of the supplied top-level Codex threads. */
export async function readCodexSubagents(parentIds: readonly string[]): Promise<Session[]> {
  if (parentIds.length === 0) {
    return [];
  }

  let database: Database | undefined;
  try {
    const moduleName: string = 'node:sqlite';
    const sqlite = (await import(moduleName)) as SqliteModule;
    database = new sqlite.DatabaseSync(STATE_DATABASE, { readOnly: true });
    const placeholders = parentIds.map(() => '?').join(', ');
    const rows = database
      .prepare(
        `WITH RECURSIVE descendants(parent_id, child_id, status, path) AS (
           SELECT parent_thread_id,
                  child_thread_id,
                  status,
                  ',' || parent_thread_id || ',' || child_thread_id || ','
           FROM thread_spawn_edges
           WHERE parent_thread_id IN (${placeholders})

           UNION ALL

           SELECT edge.parent_thread_id,
                  edge.child_thread_id,
                  edge.status,
                  descendants.path || edge.child_thread_id || ','
           FROM thread_spawn_edges AS edge
           JOIN descendants ON edge.parent_thread_id = descendants.child_id
           WHERE instr(descendants.path, ',' || edge.child_thread_id || ',') = 0
         )
         SELECT descendants.parent_id AS parentId,
                descendants.child_id AS childId,
                descendants.status AS status,
                threads.cwd AS cwd,
                threads.name AS name,
                threads.agent_nickname AS nickname,
                threads.agent_role AS role,
                threads.agent_path AS agentPath,
                threads.updated_at_ms AS updatedAt
         FROM descendants
         JOIN threads ON threads.id = descendants.child_id
         WHERE threads.archived = 0`,
      )
      .all(...parentIds);
    reported.delete(STATE_DATABASE);
    return rows.flatMap(toSession);
  } catch (error) {
    reportOnce(
      STATE_DATABASE,
      `codex subagents: cannot read ${STATE_DATABASE} — ${errorMessage(error)}`,
    );
    return [];
  } finally {
    database?.close();
  }
}

function toSession(raw: unknown): Session[] {
  const row = toRow(raw);
  if (row === undefined) {
    reportOnce('malformed-row', 'codex subagents: malformed child record — ignoring it');
    return [];
  }
  if (row.status === 'shutdown' || row.status === 'notFound') {
    return [];
  }
  const display = DISPLAY_STATE[row.status];
  if (display === undefined) {
    reportOnce(
      `status:${row.status}`,
      `codex subagents: unknown state ${row.status} — ignoring it`,
    );
    return [];
  }
  return [
    {
      agent: 'Codex',
      parentSessionId: row.parentId,
      sessionId: row.childId,
      pid: undefined,
      cwd: row.cwd,
      name: displayName(row),
      state: display.state,
      waitingFor: undefined,
      activity: display.activity,
      stateSince: row.updatedAt,
    },
  ];
}

function toRow(raw: unknown): SubagentRow | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  const parentId = nonemptyString(fields.parentId);
  const childId = nonemptyString(fields.childId);
  const status = nonemptyString(fields.status);
  const cwd = nonemptyString(fields.cwd);
  const updatedAt = fields.updatedAt;
  if (
    parentId === undefined ||
    childId === undefined ||
    status === undefined ||
    cwd === undefined ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt)
  ) {
    return undefined;
  }
  return {
    parentId,
    childId,
    status,
    cwd,
    name: nonemptyString(fields.name),
    nickname: nonemptyString(fields.nickname),
    role: nonemptyString(fields.role),
    agentPath: nonemptyString(fields.agentPath),
    updatedAt,
  };
}

function displayName(row: SubagentRow): string {
  return (
    row.nickname ??
    row.name ??
    row.role ??
    (row.agentPath === undefined ? undefined : path.basename(row.agentPath)) ??
    'Subagent'
  );
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function reportOnce(key: string, message: string): void {
  if (!reported.has(key)) {
    reported.add(key);
    log(message);
  }
}
