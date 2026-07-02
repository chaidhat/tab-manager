import * as vscode from 'vscode';

/**
 * Minimal slice of the built-in Git extension's exported API (its `git.d.ts`
 * isn't shipped in `@types/vscode`, so the parts we use are declared here).
 */
interface Change {
  readonly uri: vscode.Uri;
}

interface RepositoryState {
  readonly workingTreeChanges: Change[];
  /** Present when `git.untrackedChanges` is set to "separate". */
  readonly untrackedChanges?: Change[];
  readonly onDidChange: vscode.Event<void>;
}

interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  diffWith(ref: string): Promise<Change[]>;
  getBranches?(query: { remote?: boolean }): Promise<{ name?: string }[]>;
}

interface GitApi {
  openRepository?(root: vscode.Uri): Promise<Repository | null>;
  /** URI whose content is `uri` as it exists at `ref` (git content provider). */
  toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/**
 * Opens `folderUri` as its own repository in the built-in Git extension and
 * returns a handle to it. Best-effort: undefined if the Git extension is
 * missing, disabled, or the folder isn't a repository.
 */
async function openRepository(folderUri: vscode.Uri): Promise<Repository | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return (await exports.getAPI(1).openRepository?.(folderUri)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes sure the Git extension treats the folder as its own repository, so
 * its files are decorated — and checked against `.gitignore` — relative to
 * its own root rather than a parent repo's.
 *
 * This matters for git worktrees living under a gitignored path, e.g.
 * `.claude/worktrees/<name>`: the Git extension's own auto-detection skips
 * scanning inside ignored directories (a known limitation —
 * https://github.com/microsoft/vscode/issues/41565), so without this call a
 * worktree that was only discovered on disk (never added to the VS Code
 * workspace) would have its files decorated against the wrong repository,
 * showing everything inside it as ignored.
 */
export async function ensureRepositoryOpen(folderUri: vscode.Uri): Promise<void> {
  await openRepository(folderUri);
}

/** Files changed vs a branch, plus the ref they were compared against. */
export interface BranchComparison {
  /** The merge-base ref the diff was taken against (falls back to the branch). */
  base: string;
  /** fsPaths of every changed file. */
  files: Set<string>;
}

/**
 * The files in `folderUri`'s repository that differ from `branch` — PR-style
 * semantics: committed changes since the merge-base with the branch, plus
 * working-tree and untracked changes. Undefined when the comparison can't be
 * made (no repo, unknown branch/ref).
 */
export async function changedFilesVsBranch(
  folderUri: vscode.Uri,
  branch: string
): Promise<BranchComparison | undefined> {
  const repository = await openRepository(folderUri);
  if (!repository) {
    return undefined;
  }
  try {
    const base = (await repository.getMergeBase(branch, 'HEAD')) ?? branch;
    const diff = await repository.diffWith(base);
    const files = new Set<string>();
    const workingTree = [
      ...repository.state.workingTreeChanges,
      ...(repository.state.untrackedChanges ?? []),
    ];
    for (const change of [...diff, ...workingTree]) {
      files.add(change.uri.fsPath);
    }
    return { base, files };
  } catch {
    return undefined;
  }
}

/**
 * A URI whose content is `uri` as it exists at `ref`, served by the Git
 * extension's content provider — the left side of a diff editor. For files
 * that don't exist at the ref (added since), the provider serves empty
 * content, which renders as an all-added diff.
 */
export async function gitUriAtRef(uri: vscode.Uri, ref: string): Promise<vscode.Uri | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1).toGitUri?.(uri, ref);
  } catch {
    return undefined;
  }
}

/** Branch names (local and remote) of the folder's repository, for pickers. */
export async function listBranchNames(folderUri: vscode.Uri): Promise<string[]> {
  const repository = await openRepository(folderUri);
  if (!repository?.getBranches) {
    return [];
  }
  try {
    const branches = await repository.getBranches({ remote: true });
    const names = branches
      .map((branch) => branch.name)
      .filter((name): name is string => Boolean(name));
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/**
 * Subscribes to the folder's repository state (commits, stage/unstage, file
 * edits git notices). Undefined when there's no repository.
 */
export async function onRepositoryStateChanged(
  folderUri: vscode.Uri,
  listener: () => void
): Promise<vscode.Disposable | undefined> {
  const repository = await openRepository(folderUri);
  return repository?.state.onDidChange(listener);
}
