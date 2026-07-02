import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { gh, ghErrorMessage } from './ghCli';

const run = promisify(execFile);

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

/**
 * Groups workspace folders by the git repository they belong to, so several
 * worktrees of one repo share a section. For every repo with an open folder,
 * also discovers sibling worktrees under `<repoRoot>/.claude/worktrees/*` —
 * the convention this user's tooling uses to create worktrees — so they show
 * up without being manually added to the VS Code workspace. Non-git folders
 * are collected into a single trailing "Folders" group.
 */
export async function groupFoldersByRepo(
  folders: readonly vscode.WorkspaceFolder[]
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
    for (const discovered of await discoverClaudeWorktrees(repoRoot)) {
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
  ref: FolderRef
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
    await run('git', ['worktree', 'add', '-b', name, worktreePath], { cwd: repoRoot });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || String(error));
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
    await run('git', ['worktree', 'add', '--detach', worktreePath], { cwd: repoRoot });
  } catch (error) {
    throw new Error(ghErrorMessage(error));
  }
  try {
    await gh(['pr', 'checkout', String(prNumber)], worktreePath);
  } catch (error) {
    await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot }).catch(
      () => undefined
    );
    throw new Error(ghErrorMessage(error));
  }
  return worktreePath;
}

/**
 * Deletes a git worktree — directory and git bookkeeping — via
 * `git worktree remove`, run from the repository root. Without `force`, git
 * refuses when the worktree has modifications; the thrown error's message
 * carries git's explanation.
 */
export async function removeWorktree(folderPath: string, force: boolean): Promise<void> {
  const repoRoot = await repoRootOf(vscode.Uri.file(folderPath));
  if (!repoRoot || repoRoot === folderPath) {
    throw new Error('Not a linked git worktree — refusing to delete a main checkout.');
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), folderPath];
  try {
    await run('git', args, { cwd: repoRoot });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || String(error));
  }
}

/** The branch checked out at `cwd`, or undefined if that fails (e.g. detached HEAD). */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['branch', '--show-current'], { cwd });
    const branch = stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this window's workspace is a single child worktree — strictly the
 * `<repo>/.claude/worktrees/<name>` convention. A folder without `../worktrees`
 * and `../../.claude` above it is treated as a root window even when it is a
 * linked git worktree (e.g. worktrees managed by other tooling elsewhere).
 */
export async function isChildWorktreeWindow(): Promise<boolean> {
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
async function discoverClaudeWorktrees(repoRoot: string): Promise<FolderRef[]> {
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
