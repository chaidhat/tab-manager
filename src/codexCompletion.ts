import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface CompletionEvidence {
  readonly turnId: string | undefined;
  readonly status: string;
}

export const CODEX_COMPLETIONS_DIR = path.join(
  process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
  'tab-manager',
  'completions',
);

/** Completion requires all three sources to identify the same finished turn. */
export function confirmedCompletion(
  timeline: CompletionEvidence,
  database: CompletionEvidence | undefined,
  hook: unknown,
): string | undefined {
  if (typeof hook !== 'object' || hook === null) {
    return undefined;
  }
  const record = hook as Record<string, unknown>;
  return timeline.status === 'task_complete' &&
    timeline.turnId !== undefined &&
    database?.status === 'completed' &&
    database.turnId === timeline.turnId &&
    record.turnId === timeline.turnId
    ? timeline.turnId
    : undefined;
}

export async function readCompletion(sessionId: string, turnId: string): Promise<unknown> {
  // IDs become filenames. Reject unexpected input rather than allowing paths.
  if (![sessionId, turnId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    return undefined;
  }
  try {
    const text = await fs.readFile(
      path.join(CODEX_COMPLETIONS_DIR, `${sessionId}-${turnId}.json`),
      'utf8',
    );
    const record: unknown = JSON.parse(text);
    if (
      typeof record !== 'object' ||
      record === null ||
      (record as Record<string, unknown>).sessionId !== sessionId
    ) {
      throw new Error('Invalid Codex completion record');
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
