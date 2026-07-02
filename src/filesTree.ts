import * as vscode from 'vscode';
import { FileEntry, listDirectory } from './files';
import { ensureRepositoryOpen } from './git';
import { LayoutStore } from './store';

/** One file or folder in the tree — also the element context menus receive. */
export interface FileNode {
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly isDirectory: boolean;
}

function toFileNode(entry: FileEntry): FileNode {
  return { uri: entry.uri, name: entry.name, isDirectory: entry.isDirectory };
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
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<FileNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private activeFolderUri: string | undefined;
  private watcher: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly store: LayoutStore) {
    this.activeFolderUri = store.activeFolderUri;
    this.subscription = store.onDidChange(() => this.onStoreChange());
    this.watch();
    this.ensureGitRepositoryOpen();
  }

  private onStoreChange(): void {
    if (this.store.activeFolderUri === this.activeFolderUri) {
      return;
    }
    this.activeFolderUri = this.store.activeFolderUri;
    this.emitter.fire();
    this.watch();
    this.ensureGitRepositoryOpen();
  }

  /**
   * Makes sure the Git extension treats the active worktree as its own
   * repository, so ignored/modified status is computed against its own root
   * rather than a parent repo's (see `ensureRepositoryOpen`'s doc comment).
   * Decorations pick up the result on their own once the repository opens —
   * no tree refresh needed here.
   */
  private ensureGitRepositoryOpen(): void {
    const rootUri = this.rootUri();
    if (rootUri) {
      void ensureRepositoryOpen(rootUri);
    }
  }

  /** (Re)creates the file-system watcher so new/deleted files refresh the tree. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (!this.activeFolderUri) {
      return;
    }

    const pattern = new vscode.RelativePattern(vscode.Uri.parse(this.activeFolderUri), '**/*');
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

  async getChildren(element?: FileNode): Promise<FileNode[]> {
    const dirUri = element ? element.uri : this.rootUri();
    if (!dirUri) {
      return [];
    }
    return (await listDirectory(dirUri)).map(toFileNode);
  }

  private rootUri(): vscode.Uri | undefined {
    return this.activeFolderUri ? vscode.Uri.parse(this.activeFolderUri) : undefined;
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = node.uri;
    item.contextValue = node.isDirectory ? 'fileDirectory' : 'fileLeaf';
    if (!node.isDirectory) {
      item.command = { command: 'vscode.open', title: 'Open File', arguments: [node.uri] };
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.watcher?.dispose();
    clearTimeout(this.refreshTimer);
    this.emitter.dispose();
  }
}
