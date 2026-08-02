import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * macOS GUI apps don't inherit a shell PATH, so `gh` (Homebrew) is often not
 * findable by name from the extension host — try well-known locations too.
 */
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

/** Runs the GitHub CLI in `cwd` and returns stdout; throws on failure. */
export async function gh(args: string[], cwd: string): Promise<string> {
  let lastError: unknown;
  for (const bin of GH_CANDIDATES) {
    try {
      const { stdout } = await run(bin, args, { cwd });
      return stdout;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // try the next location
      }
      throw error;
    }
  }
  throw lastError;
}

/** Runs git in `cwd` and returns stdout; throws on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', args, { cwd });
  return stdout;
}

/**
 * A human-readable message from a failed invocation — a CLI's stderr when it
 * has one (git and gh put their explanations there), else the error itself.
 */
export function errorMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  return stderr?.trim() || (error instanceof Error ? error.message : String(error));
}
