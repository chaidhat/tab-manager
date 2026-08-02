import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, gh, git, removeDirectory } from './cli';
import { log } from './log';

/** A folder to show in the sidebar — an open workspace folder or a discovered one. */
export interface FolderRef {
  readonly uri: vscode.Uri;
  readonly name: string;
}

/** Folders that belong to the same git repository. */
export interface RepoGroup {
  /** Absolute path of the repository root, or undefined for non-git folders. */
  readonly repoRoot: string | undefined;
  readonly name: string;
  readonly folders: FolderRef[];
}

const CLAUDE_WORKTREES_DIR = '.claude/worktrees';
// Deleted worktrees are renamed in here and unlinked afterwards. A sibling of
// `worktrees/` rather than a child, so a pending delete is never discovered as
// a row, and inside the repo so the rename stays on one filesystem.
const TRASH_DIR = '.claude/.tab-manager-trash';

/**
 * Groups workspace folders by the git repository they belong to, so several
 * worktrees of one repo share a section. For every repo with an open folder,
 * also discovers sibling worktrees under `<repoRoot>/.claude/worktrees/*` —
 * the convention this user's tooling uses to create worktrees — so they show
 * up without being manually added to the VS Code workspace. Non-git folders
 * are collected into a single trailing "Folders" group.
 */
export async function groupFoldersByRepo(
  folders: readonly vscode.WorkspaceFolder[],
): Promise<RepoGroup[]> {
  const repos = new Map<string, { name: string; folders: FolderRef[] }>();
  const nonGit: FolderRef[] = [];

  for (const folder of folders) {
    const ref: FolderRef = { uri: folder.uri, name: folder.name };
    const repoRoot = await repoRootOf(folder.uri);
    if (repoRoot === undefined) {
      nonGit.push(ref);
      continue;
    }
    addFolder(repos, repoRoot, ref);
  }

  for (const [repoRoot, group] of repos) {
    // The main checkout itself, then its sibling worktrees. The checkout is
    // already in the group in a root window (it is the open folder); in a sub
    // worktree window it is not, and the section would otherwise omit it.
    const rootRef: FolderRef = { uri: vscode.Uri.file(repoRoot), name: path.basename(repoRoot) };
    for (const discovered of [rootRef, ...(await discoverClaudeWorktrees(repoRoot))]) {
      if (!group.folders.some((existing) => existing.uri.fsPath === discovered.uri.fsPath)) {
        group.folders.push(discovered);
      }
    }
  }

  const groups: RepoGroup[] = [...repos.entries()].map(([repoRoot, group]) => ({
    repoRoot,
    ...group,
  }));
  if (nonGit.length > 0) {
    groups.push({ repoRoot: undefined, name: 'Folders', folders: nonGit });
  }
  return groups;
}

function addFolder(
  repos: Map<string, { name: string; folders: FolderRef[] }>,
  repoRoot: string,
  ref: FolderRef,
): void {
  const existing = repos.get(repoRoot);
  if (existing) {
    existing.folders.push(ref);
  } else {
    repos.set(repoRoot, { name: path.basename(repoRoot), folders: [ref] });
  }
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
 */
export async function addWorktreeForPr(repoRoot: string, prNumber: number): Promise<string> {
  const worktreePath = path.join(repoRoot, CLAUDE_WORKTREES_DIR, String(prNumber));
  try {
    await git(['worktree', 'add', '--detach', worktreePath], repoRoot);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
  try {
    await gh(['pr', 'checkout', String(prNumber)], worktreePath);
  } catch (error) {
    await git(['worktree', 'remove', '--force', worktreePath], repoRoot).catch(() => undefined);
    throw new Error(errorMessage(error), { cause: error });
  }
  return worktreePath;
}

/**
 * Unregisters a git worktree and moves its files aside, returning the path
 * they were moved to. Deliberately not `git worktree remove`: that command
 * deletes the directory inline, and for a worktree carrying `node_modules`
 * (~150k files) the recursive unlink is ~12s of syscalls the user would sit
 * through. Renaming is one syscall, so the worktree is gone from git and from
 * the tree in milliseconds; the caller then hands the returned path to
 * {@link deleteTrashedWorktree} off the path anything waits on.
 *
 * Without `force`, the same conditions git refuses on — a locked worktree, or
 * modified/untracked files — throw here instead, with git's wording, so the
 * caller's force prompt reads the way it always has.
 */
export async function removeWorktree(folderPath: string, force: boolean): Promise<string> {
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

  // Same repository, hence same filesystem, so this is a directory-entry
  // update rather than a copy. Node's rename is used over the VS Code file API
  // precisely because it fails on a cross-device path (a `.claude/worktrees`
  // symlinked to another volume) instead of silently copying gigabytes.
  const trashPath = path.join(repoRoot, TRASH_DIR, `${path.basename(folderPath)}-${Date.now()}`);
  await fs.mkdir(path.dirname(trashPath), { recursive: true });
  try {
    await fs.rename(folderPath, trashPath);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }

  // What `git worktree remove` does once the files are gone: drop the
  // bookkeeping for this worktree alone. A blanket `git worktree prune` would
  // also unregister every other worktree whose directory is currently missing.
  try {
    await removeDirectory(adminDir);
  } catch (error) {
    throw new Error(
      `Files were moved to ${trashPath}, but git still lists the worktree: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return trashPath;
}

/**
 * Deletes files moved aside by {@link removeWorktree}. Slow in proportion to
 * the file count — seconds for a worktree with `node_modules` — but nothing
 * depends on it: git and the tree have already forgotten the worktree.
 */
export async function deleteTrashedWorktree(trashPath: string): Promise<void> {
  await removeDirectory(trashPath);
}

/**
 * Deletes anything left in the repos' trash directories by a window that
 * closed mid-delete, so an interrupted removal can't strand the files
 * indefinitely. Best-effort and logged rather than surfaced: it runs at
 * activation, where the user has asked for nothing.
 */
export async function sweepWorktreeTrash(): Promise<void> {
  const repoRoots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const repoRoot = await repoRootOf(folder.uri);
    if (repoRoot) {
      repoRoots.add(repoRoot);
    }
  }

  for (const repoRoot of repoRoots) {
    const trashDir = path.join(repoRoot, TRASH_DIR);
    let entries: string[];
    try {
      entries = await fs.readdir(trashDir);
    } catch {
      continue; // No trash directory — nothing has ever been deleted here.
    }
    for (const entry of entries) {
      const target = path.join(trashDir, entry);
      try {
        await removeDirectory(target);
        log(`trash sweep: removed ${target}`);
      } catch (error) {
        log(`trash sweep: failed for ${target}: ${errorMessage(error)}`);
      }
    }
    // Leave no empty scaffolding in the repo. Fails harmlessly while another
    // window has a delete in flight, and the next sweep gets it.
    await fs.rmdir(trashDir).catch(() => undefined);
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
  const stdout = await git(['worktree', 'list', '--porcelain'], repoRoot);
  for (const entry of stdout.split('\n\n')) {
    const lines = entry.split('\n');
    if (lines[0] !== `worktree ${folderPath}`) {
      continue;
    }
    const locked = lines.find((line) => line === 'locked' || line.startsWith('locked '));
    return locked === undefined ? undefined : locked.slice('locked'.length).trim();
  }
  return undefined;
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
