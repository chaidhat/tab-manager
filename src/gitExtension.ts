import * as vscode from 'vscode';

/**
 * Minimal slice of the built-in Git extension's exported API (its `git.d.ts`
 * isn't shipped in `@types/vscode`, so the parts we use are declared here).
 */
interface Change {
  readonly uri: vscode.Uri;
  /** For renames: the file's previous path. Equals `uri` otherwise. */
  readonly originalUri: vscode.Uri;
  /** A `Status` enum value from the Git extension's `git.d.ts`. */
  readonly status: number;
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

/** How a file differs from the compare base. */
export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** One changed file's kind, plus its old path when the change is a rename. */
export interface FileChange {
  kind: FileChangeKind;
  /** For renames: the file's path at the compare base. */
  originalUri?: vscode.Uri;
}

// Subsets of the Git extension's `Status` enum: INDEX_ADDED, INDEX_COPIED,
// UNTRACKED, INTENT_TO_ADD are "added"; INDEX_DELETED, DELETED are "deleted";
// INDEX_RENAMED, INTENT_TO_RENAME are "renamed"; everything else (modified,
// type-changed…) renders as "modified".
const ADDED_STATUSES = new Set([1, 4, 7, 9]);
const DELETED_STATUSES = new Set([2, 6]);
const RENAMED_STATUSES = new Set([3, 10]);

function toFileChange(change: Change): FileChange {
  if (RENAMED_STATUSES.has(change.status)) {
    return { kind: 'renamed', originalUri: change.originalUri };
  }
  if (ADDED_STATUSES.has(change.status)) {
    return { kind: 'added' };
  }
  if (DELETED_STATUSES.has(change.status)) {
    return { kind: 'deleted' };
  }
  return { kind: 'modified' };
}

/** Files changed vs a branch, plus the ref they were compared against. */
export interface BranchComparison {
  /** The merge-base ref the diff was taken against (falls back to the branch). */
  base: string;
  /** Every changed file, keyed by fsPath (renames keyed by their new path). */
  files: Map<string, FileChange>;
}

/**
 * The files in `folderUri`'s repository that differ from `branch` — PR-style
 * semantics: committed changes since the merge-base with the branch, plus
 * working-tree and untracked changes. Undefined when the comparison can't be
 * made (no repo, unknown branch/ref).
 */
export async function changedFilesVsBranch(
  folderUri: vscode.Uri,
  branch: string,
): Promise<BranchComparison | undefined> {
  const repository = await openRepository(folderUri);
  if (!repository) {
    return undefined;
  }
  try {
    const base = (await repository.getMergeBase(branch, 'HEAD')) ?? branch;
    // diffWith covers everything vs the base except untracked files, and its
    // statuses are already relative to the base — so it wins over the
    // working-tree lists, which are relative to HEAD.
    const files = new Map<string, FileChange>();
    for (const change of await repository.diffWith(base)) {
      files.set(change.uri.fsPath, toFileChange(change));
    }
    const workingTree = [
      ...repository.state.workingTreeChanges,
      ...(repository.state.untrackedChanges ?? []),
    ];
    for (const change of workingTree) {
      if (!files.has(change.uri.fsPath)) {
        files.set(change.uri.fsPath, toFileChange(change));
      }
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

/**
 * Subscribes to the folder's repository state (commits, stage/unstage, file
 * edits git notices). Undefined when there's no repository.
 */
export async function onRepositoryStateChanged(
  folderUri: vscode.Uri,
  listener: () => void,
): Promise<vscode.Disposable | undefined> {
  const repository = await openRepository(folderUri);
  return repository?.state.onDidChange(listener);
}
