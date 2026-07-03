import * as path from 'path';
import * as vscode from 'vscode';
import { git } from './cli';
import { OPEN_DIFF } from './fileCommands';
import { FileEntry, listDirectory } from './files';
import {
  changedFilesVsBranch,
  ensureRepositoryOpen,
  FileChangeKind,
  onRepositoryStateChanged,
} from './gitExtension';
import { log } from './log';
import { resolveWorktreePr } from './pr';
import { LayoutStore } from './store';

export type FilesElement = FileEntry;

/** The view's title without the changed-file count. */
const FILES_VIEW_TITLE = 'Files Changed';

// Marker query put on row resourceUris so ChangedFileDecorationProvider can
// badge them (U/M/D) — a query no other view's URIs carry.
const STATUS_QUERY_KEY = 'tabManagerStatus';

const STATUS_DECORATION: Record<FileChangeKind, vscode.FileDecoration> = {
  added: new vscode.FileDecoration(
    'U',
    'Added (not in the base branch)',
    new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
  ),
  modified: new vscode.FileDecoration(
    'M',
    'Modified vs the base branch',
    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
  ),
  deleted: new vscode.FileDecoration(
    'D',
    'Deleted (exists in the base branch)',
    new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
  ),
};

/**
 * Badges Files-view rows with their status vs the compare base (U added,
 * M modified, D deleted), colored like the Git extension's own decorations.
 * Only URIs stamped with the marker query are decorated, so nothing outside
 * this view (Explorer, tabs) is affected.
 */
export class ChangedFileDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const [key, kind] = uri.query.split('=');
    return key === STATUS_QUERY_KEY ? STATUS_DECORATION[kind as FileChangeKind] : undefined;
  }
}

/**
 * The "Files" view: the active worktree's file tree, and only that
 * worktree's — unlike the built-in Explorer, which has no way to scope a
 * multi-root workspace down to one root. Rows carry a `resourceUri`, the only
 * way the Tree API can color a row's text; this pulls in the built-in Git
 * extension's own decorations for free (green additions, orange
 * modifications, dimmed ignored files) with no git-status code of our own, at
 * the cost of VS Code also showing that row's file-type icon — an unavoidable
 * pairing, there is no way to get decorated text without it.
 *
 * The tree is filtered to files that differ from the worktree's PR base
 * branch — the branch the PR merges into, resolved via `gh` — falling back
 * to the repo's default branch when there's no PR (merge-base semantics plus
 * uncommitted changes). Folders show only while they contain changed files.
 * When the comparison can't be made, the full tree is shown instead.
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<FilesElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private stateSignature = '';
  private watcher: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private repoSubscription: vscode.Disposable | undefined;
  private repoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private changedFiles: Map<string, FileChangeKind> | undefined;
  private changedDirs: Set<string> | undefined;
  /** The view handle, for the "Files Changed (N)" title. */
  private view: vscode.TreeView<FilesElement> | undefined;
  private compareBase: string | undefined;
  /** Display name of the ref being compared against, for diff-tab titles. */
  private compareLabel: string | undefined;
  private warnedFilterKey: string | undefined;
  // Both caches avoid re-spawning `gh`/`git` on every re-render; keyed so a
  // different root (or re-linked PR) recomputes.
  private cachedCompareRef: { key: string; ref: string | undefined } | undefined;
  private detectedDefault: { root: string; branch: string | undefined } | undefined;

  constructor(private readonly store: LayoutStore) {
    this.subscription = store.onDidChange(() => this.onStoreChange());
    this.applyStoreState();
  }

  refresh(): void {
    this.emitter.fire();
  }

  /** Hooks up the TreeView so the title can carry the changed-file count. */
  attachView(view: vscode.TreeView<FilesElement>): void {
    this.view = view;
    this.updateTitle();
  }

  private updateTitle(): void {
    if (this.view) {
      this.view.title = this.changedFiles
        ? `${FILES_VIEW_TITLE} (${this.changedFiles.size})`
        : FILES_VIEW_TITLE;
    }
  }

  private onStoreChange(): void {
    const signature = this.signature();
    if (signature === this.stateSignature) {
      return;
    }
    this.applyStoreState();
    this.emitter.fire();
  }

  private signature(): string {
    const active = this.store.activeFolderUri;
    const linked = active ? this.store.linkedPr(active)?.number : undefined;
    return `${active}|${linked}`;
  }

  private applyStoreState(): void {
    this.stateSignature = this.signature();
    this.cachedCompareRef = undefined;
    this.watch();
    const root = this.rootUri();
    if (root) {
      void ensureRepositoryOpen(root);
    }
    void this.subscribeToRepository(root);
  }

  /** (Re)creates the file-system watcher so new/deleted files refresh the tree. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const root = this.rootUri();
    if (!root) {
      return;
    }

    const pattern = new vscode.RelativePattern(root, '**/*');
    // Only create/delete affect the tree's shape; content changes are left to
    // the Git decoration provider, which refreshes itself independently.
    const fsWatcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, false);
    const scheduleRefresh = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.emitter.fire(), 300);
    };
    this.watcher = vscode.Disposable.from(
      fsWatcher,
      fsWatcher.onDidCreate(scheduleRefresh),
      fsWatcher.onDidDelete(scheduleRefresh),
    );
  }

  /**
   * While the filter is on, git state changes (commits, edits, stage/unstage)
   * change what should be listed — refresh when the repository reports them.
   */
  private async subscribeToRepository(root: vscode.Uri | undefined): Promise<void> {
    this.repoSubscription?.dispose();
    this.repoSubscription = undefined;
    if (!root) {
      return;
    }
    this.repoSubscription = await onRepositoryStateChanged(root, () => {
      clearTimeout(this.repoRefreshTimer);
      this.repoRefreshTimer = setTimeout(() => this.emitter.fire(), 1000);
    });
  }

  async getChildren(element?: FilesElement): Promise<FilesElement[]> {
    if (element) {
      return element.isDirectory ? this.listChildren(element.uri) : [];
    }

    const root = this.rootUri();
    if (!root) {
      return [];
    }
    await this.recomputeChangedSet(root);
    this.updateTitle();
    return this.listChildren(root);
  }

  private async listChildren(dirUri: vscode.Uri): Promise<FileEntry[]> {
    const entries = await listDirectory(dirUri);
    let filtered = entries;
    if (this.changedFiles && this.changedDirs) {
      filtered = entries.filter((entry) =>
        entry.isDirectory
          ? this.changedDirs!.has(entry.uri.fsPath)
          : this.changedFiles!.has(entry.uri.fsPath),
      );
      // Deleted files are gone from disk, so the listing can't surface them —
      // synthesize their rows from the changed set.
      for (const [fsPath, kind] of this.changedFiles) {
        if (kind === 'deleted' && path.dirname(fsPath) === dirUri.fsPath) {
          filtered.push({
            uri: vscode.Uri.file(fsPath),
            name: path.basename(fsPath),
            isDirectory: false,
          });
        }
      }
      filtered.sort((a, b) =>
        a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
      );
    }
    return Promise.all(filtered.map((entry) => this.compressChain(entry)));
  }

  /**
   * Collapses a run of single-child directories into one row (e.g. `a/b/c`
   * instead of three nested rows), matching VS Code's own "compact folders"
   * explorer behavior. The row's uri points at the deepest folder, so
   * expanding it lists that folder's children directly.
   */
  private async compressChain(entry: FileEntry): Promise<FileEntry> {
    if (!entry.isDirectory) {
      return entry;
    }
    const names = [entry.name];
    let deepest = entry;
    for (;;) {
      const children = await this.listChildren(deepest.uri);
      if (children.length !== 1 || !children[0].isDirectory) {
        break;
      }
      deepest = children[0];
      names.push(deepest.name);
    }
    return names.length === 1
      ? entry
      : { uri: deepest.uri, name: names.join('/'), isDirectory: true };
  }

  /** Refreshes the changed-file set (and the folders containing them). */
  private async recomputeChangedSet(root: vscode.Uri): Promise<void> {
    this.changedFiles = undefined;
    this.changedDirs = undefined;
    this.compareBase = undefined;
    this.compareLabel = undefined;
    const branch = await this.compareRef(root);
    if (!branch) {
      return;
    }

    const comparison = await changedFilesVsBranch(root, branch);
    if (!comparison) {
      this.warnFilterUnavailable(root, branch);
      return; // fall back to the unfiltered listing rather than hiding everything
    }

    const dirs = new Set<string>();
    for (const file of comparison.files.keys()) {
      let dir = path.dirname(file);
      while (dir.length > root.fsPath.length && dir.startsWith(root.fsPath) && !dirs.has(dir)) {
        dirs.add(dir);
        dir = path.dirname(dir);
      }
    }
    this.changedFiles = comparison.files;
    this.changedDirs = dirs;
    this.compareBase = comparison.base;
    this.compareLabel = branch;
  }

  /**
   * The ref changed files are compared against: the base branch of the
   * worktree's PR (as `origin/<base>`, so a stale or missing local branch
   * can't skew the merge-base), else the repo's default branch when there
   * is no PR.
   */
  private async compareRef(root: vscode.Uri): Promise<string | undefined> {
    const linked = this.store.linkedPr(root.toString())?.number;
    const key = `${root.toString()}|${linked}`;
    if (this.cachedCompareRef?.key !== key) {
      const pr = await resolveWorktreePr(root.fsPath, linked);
      const ref = pr ? `origin/${pr.baseRefName}` : await this.defaultBranch(root);
      this.cachedCompareRef = { key, ref };
    }
    return this.cachedCompareRef.ref;
  }

  private warnFilterUnavailable(root: vscode.Uri, branch: string): void {
    const key = `${root.toString()}|${branch}`;
    log(`files filter: cannot diff "${root.fsPath}" against "${branch}" — showing all files`);
    if (this.warnedFilterKey !== key) {
      this.warnedFilterKey = key;
      vscode.window.showWarningMessage(
        `Tab Manager can't compare this worktree against "${branch}" — showing all files. ` +
          'Check that the branch exists on the remote (try fetching).',
      );
    }
  }

  /** The repo's default branch (origin/HEAD), detected once per root. */
  private async defaultBranch(root: vscode.Uri): Promise<string | undefined> {
    if (this.detectedDefault?.root !== root.toString()) {
      let branch: string | undefined;
      try {
        const stdout = await git(
          ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          root.fsPath,
        );
        branch = stdout.trim() || undefined;
      } catch {
        branch = 'origin/main'; // origin/HEAD is often unset locally
      }
      this.detectedDefault = { root: root.toString(), branch };
    }
    return this.detectedDefault.branch;
  }

  private rootUri(): vscode.Uri | undefined {
    const uri = this.store.activeFolderUri;
    return uri ? vscode.Uri.parse(uri) : undefined;
  }

  getTreeItem(element: FilesElement): vscode.TreeItem {
    return this.fileItem(element);
  }

  private fileItem(node: FileEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = node.uri;
    item.contextValue = node.isDirectory ? 'fileDirectory' : 'fileLeaf';
    if (!node.isDirectory) {
      const status = this.changedFiles?.get(node.uri.fsPath);
      if (status) {
        // The marker query makes ChangedFileDecorationProvider badge the row.
        item.resourceUri = node.uri.with({ query: `${STATUS_QUERY_KEY}=${status}` });
      }
      // A modified file opens as a diff against the compare base. An added
      // file has no base-side content to diff against, and a deleted file no
      // working-tree side — those open the one version that exists. Files in
      // the unfiltered fallback (diff unavailable) open normally too.
      const branch = this.compareLabel;
      const asDiff = this.compareBase !== undefined && branch !== undefined && status !== undefined;
      // preview: false — a preview tab would be REPLACED by the next click,
      // making it impossible to build a stack of tabs from this view.
      item.command =
        asDiff && status !== 'added'
          ? {
              command: OPEN_DIFF,
              title: 'Open Diff',
              arguments: [node.uri, this.compareBase, branch, status === 'deleted'],
            }
          : {
              command: 'vscode.open',
              title: 'Open File',
              arguments: [node.uri, { preview: false }],
            };
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.watcher?.dispose();
    this.repoSubscription?.dispose();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.repoRefreshTimer);
    this.emitter.dispose();
  }
}
