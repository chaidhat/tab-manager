import * as vscode from 'vscode';
import { COMMANDS } from './commands';
import { LayoutStore } from './store';
import { WorktreeElement } from './types';
import { groupFoldersByRepo } from './worktrees';

/** A collapsible section for one repository and its worktrees. */
export interface RepoSection {
  readonly id: string;
  readonly label: string;
  /** Absolute repo root — undefined for the non-git "Folders" section. */
  readonly repoRoot: string | undefined;
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
        repoRoot: repo.repoRoot,
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

  /** Re-renders the tree (e.g. after a worktree is created on disk). */
  refresh(): void {
    this.emitter.fire();
  }

  private repoItem(section: RepoSection): vscode.TreeItem {
    const item = new vscode.TreeItem(section.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = section.id;
    // Only git repos get the inline "+" (New Worktree).
    item.contextValue = section.repoRoot ? 'repo-git' : 'repo';
    return item;
  }

  private worktreeItem(worktree: WorktreeElement): vscode.TreeItem {
    const isActive = worktree.folderUri === this.store.activeFolderUri;
    const hasLayout = this.store.hasLayout(worktree.folderUri);
    // A worktree linked to a PR takes the PR's title as its display name;
    // the folder name stays available in the tooltip.
    const linked = this.store.linkedPr(worktree.folderUri);
    const label = linked?.title ?? worktree.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    const hints = [!hasLayout && 'no layout', !worktree.isOpen && 'not open'].filter(
      (hint): hint is string => Boolean(hint)
    );

    item.id = `worktree:${worktree.folderUri}`;
    // Menu `when` clauses match these markers: hasLayout gates "Clear Saved
    // Layout", closed (not an open workspace folder) gates "Delete Worktree".
    item.contextValue = [
      'worktree',
      hasLayout ? 'hasLayout' : '',
      worktree.isOpen ? 'open' : 'closed',
    ]
      .filter(Boolean)
      .join('-');
    item.description = isActive ? '●' : hints.join(' · ') || undefined;
    const prNote = linked ? ` — PR #${linked.number}` : '';
    item.tooltip = `Open "${worktree.name}" in a new window${prNote} (right-click to switch layouts in this one)`;
    item.command = {
      command: COMMANDS.openWindow,
      title: 'Open Worktree in New Window',
      arguments: [worktree.folderUri],
    };

    return item;
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.emitter.dispose();
  }
}
