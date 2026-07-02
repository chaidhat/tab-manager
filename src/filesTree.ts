import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { OPEN_DIFF, PICK_COMPARE_BRANCH } from './fileCommands';
import { FileEntry, listDirectory } from './files';
import { changedFilesVsBranch, ensureRepositoryOpen, onRepositoryStateChanged } from './git';
import { log } from './log';
import { LayoutStore } from './store';

/**
 * The checkbox row pinned above the file list: filters the tree down to files
 * changed vs the compare branch. Identified by object identity — the provider
 * always hands out this same instance.
 */
export const FILTER_ROW = Object.freeze({ row: 'changedOnly' as const });

/** A row is either the filter checkbox or a file/folder (`FileEntry`). */
export type FilesElement = FileEntry | typeof FILTER_ROW;

export function isFilterRow(element: FilesElement): element is typeof FILTER_ROW {
  return element === FILTER_ROW;
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
 * A checkbox row at the top optionally filters the tree to files that differ
 * from a chosen branch (merge-base semantics plus uncommitted changes);
 * folders show only while they contain changed files.
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
  private changedFiles: Set<string> | undefined;
  private changedDirs: Set<string> | undefined;
  private compareBase: string | undefined;
  private warnedFilterKey: string | undefined;
  private detectedDefault: { root: string; branch: string | undefined } | undefined;

  /**
   * @param forceDiffMode Locks the changed-files filter ON (no checkbox row)
   * — used by the child-worktree "Changed Files" view. With no branch picked,
   * the compare base falls back to the repo's default branch (origin/HEAD).
   */
  constructor(
    private readonly store: LayoutStore,
    private readonly forceDiffMode = false
  ) {
    this.subscription = store.onDidChange(() => this.onStoreChange());
    this.applyStoreState();
  }

  /** Re-renders the tree from current store state (e.g. to snap a checkbox back). */
  refresh(): void {
    this.emitter.fire();
  }

  private onStoreChange(): void {
    const signature = this.signature();
    if (signature === this.stateSignature) {
      return;
    }
    this.applyStoreState();
    this.emitter.fire();
  }

  private filterOn(): boolean {
    return this.forceDiffMode || this.store.filesFilterEnabled;
  }

  private signature(): string {
    const { activeFolderUri, filesFilterEnabled, compareBranch } = this.store;
    return `${activeFolderUri}|${filesFilterEnabled}|${compareBranch}`;
  }

  private applyStoreState(): void {
    this.stateSignature = this.signature();
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
      fsWatcher.onDidDelete(scheduleRefresh)
    );
  }

  /**
   * While the filter is on, git state changes (commits, edits, stage/unstage)
   * change what should be listed — refresh when the repository reports them.
   */
  private async subscribeToRepository(root: vscode.Uri | undefined): Promise<void> {
    this.repoSubscription?.dispose();
    this.repoSubscription = undefined;
    if (!root || !this.filterOn()) {
      return;
    }
    this.repoSubscription = await onRepositoryStateChanged(root, () => {
      clearTimeout(this.repoRefreshTimer);
      this.repoRefreshTimer = setTimeout(() => this.emitter.fire(), 1000);
    });
  }

  async getChildren(element?: FilesElement): Promise<FilesElement[]> {
    if (element) {
      if (isFilterRow(element) || !element.isDirectory) {
        return [];
      }
      return this.listChildren(element.uri);
    }

    const root = this.rootUri();
    if (!root) {
      return [];
    }
    if (this.filterOn()) {
      await this.recomputeChangedSet(root);
    }
    const filterRow = this.forceDiffMode ? [] : [FILTER_ROW];
    return [...filterRow, ...(await this.listChildren(root))];
  }

  private async listChildren(dirUri: vscode.Uri): Promise<FileEntry[]> {
    const entries = await listDirectory(dirUri);
    if (!this.filterOn() || !this.changedFiles || !this.changedDirs) {
      return entries;
    }
    return entries.filter((entry) =>
      entry.isDirectory
        ? this.changedDirs!.has(entry.uri.fsPath)
        : this.changedFiles!.has(entry.uri.fsPath)
    );
  }

  /** Refreshes the changed-file set (and the folders containing them). */
  private async recomputeChangedSet(root: vscode.Uri): Promise<void> {
    this.changedFiles = undefined;
    this.changedDirs = undefined;
    this.compareBase = undefined;
    const branch = this.store.compareBranch ?? (await this.defaultBranch(root));
    if (!branch) {
      return;
    }

    const comparison = await changedFilesVsBranch(root, branch);
    if (!comparison) {
      this.warnFilterUnavailable(root, branch);
      return; // fall back to the unfiltered listing rather than hiding everything
    }

    const dirs = new Set<string>();
    for (const file of comparison.files) {
      let dir = path.dirname(file);
      while (dir.length > root.fsPath.length && dir.startsWith(root.fsPath) && !dirs.has(dir)) {
        dirs.add(dir);
        dir = path.dirname(dir);
      }
    }
    this.changedFiles = comparison.files;
    this.changedDirs = dirs;
    this.compareBase = comparison.base;
  }

  private warnFilterUnavailable(root: vscode.Uri, branch: string): void {
    const key = `${root.toString()}|${branch}`;
    log(`files filter: cannot diff "${root.fsPath}" against "${branch}" — showing all files`);
    if (this.warnedFilterKey !== key) {
      this.warnedFilterKey = key;
      vscode.window.showWarningMessage(
        `Tab Manager can't compare this worktree against "${branch}" — showing all files. ` +
          'Check that the branch exists (click the filter row to pick another).'
      );
    }
  }

  /** The repo's default branch (origin/HEAD), detected once per root. */
  private async defaultBranch(root: vscode.Uri): Promise<string | undefined> {
    if (this.detectedDefault?.root !== root.toString()) {
      let branch: string | undefined;
      try {
        const { stdout } = await promisify(execFile)(
          'git',
          ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          { cwd: root.fsPath }
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
    return isFilterRow(element) ? this.filterItem() : this.fileItem(element);
  }

  private filterItem(): vscode.TreeItem {
    const branch = this.store.compareBranch;
    const item = new vscode.TreeItem(
      branch ? `Only files changed vs ${branch}` : 'Only changed files…'
    );
    item.id = 'tab-manager.filesFilter';
    item.contextValue = 'filesFilter';
    item.checkboxState = this.store.filesFilterEnabled
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip =
      'Show only files that differ from the chosen branch (what a PR against it would contain, ' +
      'plus uncommitted changes). Click the label to pick the branch.';
    item.command = {
      command: PICK_COMPARE_BRANCH,
      title: 'Pick Compare Branch',
    };
    return item;
  }

  private fileItem(node: FileEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = node.uri;
    item.contextValue = node.isDirectory ? 'fileDirectory' : 'fileLeaf';
    if (!node.isDirectory) {
      // In diff mode (filter on), a changed file opens as a diff against the
      // compare base; otherwise it opens normally.
      const branch = this.store.compareBranch ?? this.detectedDefault?.branch;
      const asDiff =
        this.filterOn() &&
        this.compareBase !== undefined &&
        branch !== undefined &&
        this.changedFiles?.has(node.uri.fsPath);
      // preview: false — a preview tab would be REPLACED by the next click,
      // making it impossible to build a stack of tabs from this view.
      item.command = asDiff
        ? {
            command: OPEN_DIFF,
            title: 'Open Diff',
            arguments: [node.uri, this.compareBase, branch],
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
