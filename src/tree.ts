import * as vscode from 'vscode';
import { COMMANDS } from './commands';
import { LayoutStore } from './store';
import { WorktreeElement } from './types';
import { groupFoldersByRepo } from './worktrees';

/** A collapsible section for one repository and its worktrees. */
interface RepoSection {
  readonly id: string;
  readonly label: string;
  readonly worktrees: WorktreeElement[];
}

export type TreeElement = RepoSection | WorktreeElement;

function isRepoSection(element: TreeElement): element is RepoSection {
  return 'worktrees' in element;
}

/**
 * The "Layouts" view: a collapsible section per repository, one row per
 * worktree (workspace folder), each holding a single layout. Clicking a
 * worktree switches to its layout.
 */
export class LayoutTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly store: LayoutStore) {
    this.subscriptions = [
      store.onDidChange(() => this.emitter.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()),
    ];
  }

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element) {
      return isRepoSection(element) ? element.worktrees : [];
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    // No folders open: show the welcome content instead.
    if (folders.length === 0) {
      return [];
    }

    const openUris = new Set(folders.map((folder) => folder.uri.toString()));
    return (await groupFoldersByRepo(folders)).map(
      (repo): RepoSection => ({
        id: `repo:${repo.repoRoot ?? 'non-git'}`,
        label: repo.name,
        worktrees: repo.folders.map((folder) => ({
          folderUri: folder.uri.toString(),
          name: folder.name,
          isOpen: openUris.has(folder.uri.toString()),
        })),
      })
    );
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return isRepoSection(element) ? this.repoItem(element) : this.worktreeItem(element);
  }

  private repoItem(section: RepoSection): vscode.TreeItem {
    const item = new vscode.TreeItem(section.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = section.id;
    item.contextValue = 'repo';
    return item;
  }

  private worktreeItem(worktree: WorktreeElement): vscode.TreeItem {
    const isActive = worktree.folderUri === this.store.activeFolderUri;
    const hasLayout = this.store.hasLayout(worktree.folderUri);
    const item = new vscode.TreeItem(worktree.name, vscode.TreeItemCollapsibleState.None);

    const hints = [!hasLayout && 'no layout', !worktree.isOpen && 'not open'].filter(
      (hint): hint is string => Boolean(hint)
    );

    item.id = `worktree:${worktree.folderUri}`;
    item.contextValue = hasLayout ? 'worktreeWithLayout' : 'worktree';
    item.description = isActive ? '● active' : hints.join(' · ') || undefined;
    item.tooltip = worktree.isOpen
      ? `Switch to the "${worktree.name}" layout`
      : `Switch to the "${worktree.name}" layout (opens its files without adding it to the workspace)`;
    item.command = {
      command: COMMANDS.apply,
      title: 'Switch to Worktree Layout',
      arguments: [worktree.folderUri],
    };

    return item;
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.emitter.dispose();
  }
}
