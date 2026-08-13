import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, gh, git } from './cli';

/** A folder to show in the sidebar — an open workspace folder or a discovered one. */
export interface FolderRef {
  readonly uri: vscode.Uri;
  readonly name: string;
}

const CLAUDE_WORKTREES_DIR = '.claude/worktrees';

/** A worktree git has a branch checked out in, and the state of its folder. */
export interface BranchWorktree {
  /** Absolute path of the worktree's folder, as git records it. */
  readonly path: string;
  /**
   * Git still lists the worktree but its folder is gone — someone deleted it
   * without telling git. It holds the branch just the same.
   */
  readonly stale: boolean;
}

/**
 * A checkout that failed because another worktree already has the branch —
 * git's "'<branch>' is already used by worktree at …". Separate from a plain
 * failure because this one has a way out: let go of the worktree named in
 * {@link holder} and the checkout works.
 */
export class BranchInUseError extends Error {
  constructor(
    readonly branch: string,
    readonly holder: BranchWorktree,
    gitMessage: string,
    cause: unknown,
  ) {
    super(gitMessage, { cause });
    this.name = 'BranchInUseError';
  }
}

/** Where a pull request's worktree lives, whether or not it has been created. */
export function worktreePathForPr(repoRoot: string, prNumber: number): string {
  return path.join(repoRoot, CLAUDE_WORKTREES_DIR, String(prNumber));
}

/**
 * Creates a new worktree for the repo under `.claude/worktrees/<name>` — the
 * same convention discovery scans — on a new branch of the same name. Returns
 * the new worktree's path; throws with git's message on failure (e.g. the
 * branch already exists).
 */
export async function addWorktree(repoRoot: string, name: string): Promise<string> {
  const worktreePath = path.join(repoRoot, CLAUDE_WORKTREES_DIR, name);
  try {
    await git(['worktree', 'add', '-b', name, worktreePath], repoRoot);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
  return worktreePath;
}

/**
 * Creates a worktree checked out to a pull request's branch, named after the
 * PR number under `.claude/worktrees/`. The worktree starts detached and
 * `gh pr checkout` runs inside it — gh handles fetching, branch creation and
 * fork remotes. A failed checkout removes the half-made worktree again.
 *
 * Throws {@link BranchInUseError} when the checkout failed because another
 * worktree already holds the PR's branch, so the caller can offer to delete
 * that worktree; every other failure throws with git's or gh's own message.
 */
export async function addWorktreeForPr(repoRoot: string, prNumber: number): Promise<string> {
  const worktreePath = worktreePathForPr(repoRoot, prNumber);
  try {
    await git(['worktree', 'add', '--detach', worktreePath], repoRoot);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
  try {
    await gh(['pr', 'checkout', String(prNumber)], worktreePath);
  } catch (error) {
    // Removed before the branch is looked up, so the half-made worktree isn't
    // itself in the list the lookup reads.
    await git(['worktree', 'remove', '--force', worktreePath], repoRoot).catch(() => undefined);
    throw (
      (await branchInUseError(repoRoot, prNumber, error)) ??
      new Error(errorMessage(error), { cause: error })
    );
  }
  return worktreePath;
}

/**
 * Turns a failed PR checkout into a {@link BranchInUseError} when the reason is
 * that the PR's branch is checked out somewhere else — the one failure the user
 * can be offered a way out of. Returns undefined when the branch is free (the
 * checkout failed for some other reason) or when gh can't say which branch the
 * PR is on, and the caller reports the original failure instead.
 */
async function branchInUseError(
  repoRoot: string,
  prNumber: number,
  cause: unknown,
): Promise<BranchInUseError | undefined> {
  const branch = await prHeadBranch(repoRoot, prNumber);
  if (branch === undefined) {
    return undefined;
  }
  const holder = await worktreeUsingBranch(repoRoot, branch).catch(() => undefined);
  return holder && new BranchInUseError(branch, holder, errorMessage(cause), cause);
}

/** The branch a pull request merges from, or undefined when `gh` can't say. */
async function prHeadBranch(repoRoot: string, prNumber: number): Promise<string | undefined> {
  try {
    const stdout = await gh(['pr', 'view', String(prNumber), '--json', 'headRefName'], repoRoot);
    return (JSON.parse(stdout) as { headRefName?: string }).headRefName || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The worktree git considers to have `branch` checked out, if any — the one
 * whose existence makes a second checkout of it fail. That includes the
 * repository's own checkout, and worktrees whose folder has been deleted
 * without git being told: git keeps listing those, and they keep the branch.
 */
export async function worktreeUsingBranch(
  repoRoot: string,
  branch: string,
): Promise<BranchWorktree | undefined> {
  const entries = await worktreeEntries(repoRoot);
  const holder = entries.find((entry) => entry.lines.includes(`branch refs/heads/${branch}`));
  return (
    holder && {
      path: holder.path,
      stale: holder.lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
    }
  );
}

/**
 * Unregisters a worktree git lists but whose folder is gone. `git worktree
 * remove` is right here where {@link removeWorktree}'s trash-then-unregister
 * isn't: there are no files left to move. It still refuses if the folder turns
 * out to be there after all, and it drops this one entry, where `git worktree
 * prune` would unregister every other missing worktree along with it.
 */
export async function forgetWorktree(repoRoot: string, folderPath: string): Promise<void> {
  try {
    await git(['worktree', 'remove', folderPath], repoRoot);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

/**
 * Unregisters a git worktree and moves its directory to the OS trash.
 * Deliberately not `git worktree remove`: that command unlinks the directory
 * inline, and for a worktree carrying `node_modules` (~150k files) that is
 * ~12s of syscalls the user sits through. Trashing is a rename — 12ms at the
 * same file count — so nothing is left running once the command returns, and
 * the files stay recoverable until the trash is emptied.
 *
 * Without `force`, the same conditions git refuses on — a locked worktree, or
 * modified/untracked files — throw here instead, with git's wording, so the
 * caller's force prompt reads the way it always has.
 */
export async function removeWorktree(folderPath: string, force: boolean): Promise<void> {
  const repoRoot = await repoRootOf(vscode.Uri.file(folderPath));
  if (!repoRoot || repoRoot === folderPath) {
    throw new Error('Not a linked git worktree — refusing to delete a main checkout.');
  }
  // Read before the move: afterwards the `.git` pointer is inside the trash.
  const adminDir = await adminDirOf(folderPath);
  if (!adminDir) {
    throw new Error(`Could not resolve the git directory of "${path.basename(folderPath)}".`);
  }
  if (!force) {
    await checkRemovable(folderPath, repoRoot);
  }

  // Files first: a failure here leaves the worktree entirely untouched, where
  // unregistering first would leave one git had forgotten but disk still had.
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(folderPath), {
      recursive: true,
      useTrash: true,
    });
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }

  // What `git worktree remove` does once the files are gone: drop the
  // bookkeeping for this worktree alone. A blanket `git worktree prune` would
  // also unregister every other worktree whose directory is currently missing.
  try {
    await fs.rm(adminDir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `The worktree is in the trash, but git still lists it: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * The gates `git worktree remove` applies before deleting anything, replicated
 * because we no longer call it. Messages mirror git's so the force prompt that
 * quotes them is unchanged.
 */
async function checkRemovable(folderPath: string, repoRoot: string): Promise<void> {
  const lockReason = await lockReasonOf(folderPath, repoRoot);
  if (lockReason !== undefined) {
    const reason = lockReason ? `, reason: ${lockReason}` : '';
    throw new Error(`cannot remove a locked working tree${reason}`);
  }
  // Exactly git's own check: any porcelain output — modified *or* untracked —
  // means dirty. Ignored files (a worktree's `node_modules`) don't count.
  const status = await git(['status', '--porcelain', '--ignore-submodules=none'], folderPath);
  if (status.trim()) {
    throw new Error(
      `'${folderPath}' contains modified or untracked files, use --force to delete it`,
    );
  }
}

/**
 * The lock reason recorded for a worktree: undefined when unlocked, and the
 * empty string when locked without one. Falls back to "unlocked" if the
 * worktree isn't in git's list, since the dirty check that follows is the gate
 * that matters and a missing entry means there is nothing to unlock.
 */
async function lockReasonOf(folderPath: string, repoRoot: string): Promise<string | undefined> {
  const entry = (await worktreeEntries(repoRoot)).find((each) => each.path === folderPath);
  const locked = entry?.lines.find((line) => line === 'locked' || line.startsWith('locked '));
  return locked === undefined ? undefined : locked.slice('locked'.length).trim();
}

/** One worktree as `git worktree list --porcelain` describes it. */
interface WorktreeEntry {
  /** The absolute path on its `worktree` line. */
  readonly path: string;
  /** Every line of the entry, including the `worktree` one. */
  readonly lines: readonly string[];
}

/**
 * Every worktree of the repo, main checkout included, straight from git's
 * porcelain listing: one blank-line-separated block each, whose first line is
 * `worktree <path>` and whose remaining lines are the attributes git recorded
 * (`branch`, `detached`, `locked`, `prunable`).
 */
async function worktreeEntries(repoRoot: string): Promise<WorktreeEntry[]> {
  const stdout = await git(['worktree', 'list', '--porcelain'], repoRoot);
  const entries: WorktreeEntry[] = [];
  for (const block of stdout.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line !== '');
    if (lines[0]?.startsWith('worktree ')) {
      entries.push({ path: lines[0].slice('worktree '.length), lines });
    }
  }
  return entries;
}

/**
 * A linked worktree's bookkeeping directory — `<repo>/.git/worktrees/<id>` —
 * read from the `gitdir:` pointer in the worktree's own `.git` file. The id is
 * not always the folder name (git disambiguates collisions), so it has to come
 * from the pointer rather than be assembled from the path.
 */
async function adminDirOf(folderPath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(path.join(folderPath, '.git'), 'utf8');
    const gitDirLine = /^gitdir:\s*(.+)\s*$/m.exec(content);
    return gitDirLine ? path.resolve(folderPath, gitDirLine[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** The branch checked out at `cwd`, or undefined if that fails (e.g. detached HEAD). */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const stdout = await git(['branch', '--show-current'], cwd);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this window's workspace is a single sub-worktree — strictly the
 * `<repo>/.claude/worktrees/<name>` convention. A folder without `../worktrees`
 * and `../../.claude` above it is treated as a root window even when it is a
 * linked git worktree (e.g. worktrees managed by other tooling elsewhere).
 */
export async function isSubWorktreeWindow(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length !== 1) {
    return false;
  }
  const folderPath = folders[0].uri.fsPath;
  const parent = path.dirname(folderPath);
  if (path.basename(parent) !== 'worktrees' || path.basename(path.dirname(parent)) !== '.claude') {
    return false;
  }
  const root = await repoRootOf(folders[0].uri);
  return root !== undefined && root !== folderPath;
}

/**
 * Resolves the repository root a folder belongs to. A checkout's `.git` is a
 * directory at the repo root; a linked worktree's `.git` is a file containing
 * `gitdir: <repo>/.git/worktrees/<name>`, which we follow back to the repo.
 * Returns undefined for folders that aren't inside a git checkout.
 */
export async function repoRootOf(folderUri: vscode.Uri): Promise<string | undefined> {
  const dotGit = vscode.Uri.joinPath(folderUri, '.git');
  let stat: vscode.FileStat;
  try {
    stat = await vscode.workspace.fs.stat(dotGit);
  } catch {
    return undefined;
  }

  if (stat.type & vscode.FileType.Directory) {
    return folderUri.fsPath;
  }

  try {
    const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(dotGit));
    const gitDirLine = /^gitdir:\s*(.+)\s*$/m.exec(content);
    if (!gitDirLine) {
      return folderUri.fsPath;
    }
    const gitDir = path.resolve(folderUri.fsPath, gitDirLine[1].trim());
    const worktreesDir = path.dirname(gitDir); // <repo>/.git/worktrees
    const commonGitDir = path.dirname(worktreesDir); // <repo>/.git
    if (path.basename(worktreesDir) === 'worktrees' && path.basename(commonGitDir) === '.git') {
      return path.dirname(commonGitDir);
    }
    return folderUri.fsPath;
  } catch {
    return folderUri.fsPath;
  }
}

/** Subdirectories of `<repoRoot>/.claude/worktrees` that are git worktrees. */
export async function discoverClaudeWorktrees(repoRoot: string): Promise<FolderRef[]> {
  const dir = vscode.Uri.file(path.join(repoRoot, CLAUDE_WORKTREES_DIR));
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }

  const refs: FolderRef[] = [];
  for (const [name, type] of entries) {
    if (!(type & vscode.FileType.Directory)) {
      continue;
    }
    const uri = vscode.Uri.joinPath(dir, name);
    if (await hasDotGit(uri)) {
      refs.push({ uri, name });
    }
  }
  return refs;
}

async function hasDotGit(folderUri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folderUri, '.git'));
    return true;
  } catch {
    return false;
  }
}
