import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, git } from './cli';
import { FileChange } from './gitExtension';
import { log } from './log';

/** How many lines a changed file gained and lost vs the compare base. */
export interface DiffStat {
  readonly added: number;
  readonly deleted: number;
}

const NEWLINE = 0x0a;

// Untracked files are counted by reading them (see below). Past this size a
// file is almost certainly generated or binary-ish, and reading it would cost
// more than the count is worth.
const UNTRACKED_SIZE_LIMIT = 2 * 1024 * 1024;

/**
 * The added/deleted line counts for the changed files under `root`, keyed by
 * fsPath (renames keyed by their new path, matching `BranchComparison`).
 *
 * Files with no meaningful count are simply absent: binary files, files too
 * large to read, and anything git or the file system refused to report on —
 * callers show no counts for those rather than a misleading zero.
 */
export async function changedLineCounts(
  root: vscode.Uri,
  base: string,
  files: ReadonlyMap<string, FileChange>,
): Promise<Map<string, DiffStat>> {
  let stats: Map<string, DiffStat>;
  try {
    // --relative keeps paths relative to `root` even if it isn't the
    // repository root; -z stops git from quoting unusual path characters.
    const stdout = await git(
      ['diff', '--numstat', '-z', '--find-renames', '--relative', base, '--'],
      root.fsPath,
    );
    stats = parseNumstat(root, stdout);
  } catch (error) {
    log(`diff stats: cannot count lines against "${base}" — ${errorMessage(error)}`);
    return new Map();
  }

  // `git diff` doesn't see untracked files, so nothing above covered them.
  // Their whole content is the addition — count it off disk.
  await Promise.all(
    [...files].map(async ([fsPath, change]) => {
      if (change.kind !== 'added' || stats.has(fsPath)) {
        return;
      }
      const stat = await countLines(vscode.Uri.file(fsPath));
      if (stat) {
        stats.set(fsPath, stat);
      }
    }),
  );
  return stats;
}

/**
 * Rolls the per-file counts up into per-directory totals, keyed by the
 * directory's fsPath, so a folder row can carry what its contents add up to.
 * Every directory between a counted file and `root` (inclusive) gets an entry.
 *
 * A total only covers the files {@link changedLineCounts} could count — a
 * folder holding nothing but binary files has no total at all, the same as the
 * files themselves, rather than a zero that reads as "no changes".
 */
export function totalsByDirectory(
  root: vscode.Uri,
  stats: ReadonlyMap<string, DiffStat>,
): Map<string, DiffStat> {
  const rootPath = root.fsPath.replace(/[\\/]+$/, '');
  const inRoot = (dir: string): boolean => dir === rootPath || dir.startsWith(rootPath + path.sep);
  const totals = new Map<string, DiffStat>();
  for (const [fsPath, stat] of stats) {
    // Up from the file's own directory to the root, adding to each one.
    for (let dir = path.dirname(fsPath); inRoot(dir); dir = path.dirname(dir)) {
      const running = totals.get(dir);
      totals.set(dir, {
        added: (running?.added ?? 0) + stat.added,
        deleted: (running?.deleted ?? 0) + stat.deleted,
      });
      if (dir === rootPath || dir === path.dirname(dir)) {
        break; // the root, or the file system's own root — nowhere left to go
      }
    }
  }
  return totals;
}

/**
 * Parses `git diff --numstat -z`. Each record is
 * `<added> TAB <deleted> TAB <path> NUL`, except a rename, which leaves the
 * path empty and follows the record with the old and new paths as their own
 * NUL-terminated fields.
 */
function parseNumstat(root: vscode.Uri, stdout: string): Map<string, DiffStat> {
  const stats = new Map<string, DiffStat>();
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const [added, deleted, file] = fields[i].split('\t');
    if (file === undefined) {
      continue; // the empty field after the final NUL
    }
    let target = file;
    if (target === '') {
      target = fields[i + 2];
      i += 2;
      if (target === undefined) {
        break; // truncated output — nothing sensible left to read
      }
    }
    const stat = toStat(added, deleted);
    if (stat) {
      stats.set(path.join(root.fsPath, target), stat);
    }
  }
  return stats;
}

/** A record's counts, or undefined for the `-` git writes for binary files. */
function toStat(added: string, deleted: string): DiffStat | undefined {
  const gained = Number(added);
  const lost = Number(deleted);
  return Number.isInteger(gained) && Number.isInteger(lost)
    ? { added: gained, deleted: lost }
    : undefined;
}

/** An untracked file's line count, counted the way git counts additions. */
async function countLines(uri: vscode.Uri): Promise<DiffStat | undefined> {
  let bytes: Uint8Array;
  try {
    if ((await vscode.workspace.fs.stat(uri)).size > UNTRACKED_SIZE_LIMIT) {
      return undefined;
    }
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined; // deleted since git listed it, or unreadable
  }
  if (bytes.includes(0)) {
    return undefined; // binary, which git reports as "-" too
  }

  let added = 0;
  for (const byte of bytes) {
    if (byte === NEWLINE) {
      added++;
    }
  }
  // A trailing partial line still counts as a line, as it does in a diff.
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE) {
    added++;
  }
  return { added, deleted: 0 };
}
