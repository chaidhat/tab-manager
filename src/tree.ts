import * as vscode from 'vscode';
import { COMMANDS } from './commands';
import { PrInfo, prThemeIcon, resolveWorktreePr } from './pr';
import { LayoutStore } from './store';
import { WorktreeElement } from './types';
import { currentBranch, groupFoldersByRepo } from './worktrees';

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
 * The "Worktrees" view: a collapsible section per repository, one row per
 * worktree. Clicking a worktree opens it in a new window rooted at its
 * folder; a row whose branch has a PR displays the PR's title, resolved in
 * the background via `gh`.
 */
export class LayoutTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];
  // folderUri -> resolved PR (null = looked up, no PR). Populated in the
  // background so a row can show its PR title without blocking the tree; the
  // presence of a key also stops us re-querying `gh` on every re-render.
  private readonly prCache = new Map<string, PrInfo | null>();
  private readonly resolving = new Set<string>();
  // Same background-resolution scheme as prCache, but for the repo-root row's
  // current branch — it shows a branch name instead of a PR, and is never
  // linkable to one.
  private readonly branchCache = new Map<string, string | null>();
  private readonly resolvingBranch = new Set<string>();

  constructor(private readonly store: LayoutStore) {
    this.subscriptions = [
      store.onDidChange(() => this.emitter.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()),
    ];
  }

  /**
   * Re-renders the tree (e.g. after a worktree is created on disk). Drops the
   * resolved-PR cache so rows re-query — new worktrees get looked up and any
   * renamed PRs refresh.
   */
  refresh(): void {
    this.prCache.clear();
    this.branchCache.clear();
    this.emitter.fire();
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
    const sections = (await groupFoldersByRepo(folders)).map((repo): RepoSection => ({
      id: `repo:${repo.repoRoot ?? 'non-git'}`,
      label: repo.name,
      repoRoot: repo.repoRoot,
      worktrees: repo.folders.map((folder) => ({
        folderUri: folder.uri.toString(),
        name: folder.name,
        isOpen: openUris.has(folder.uri.toString()),
        isRoot: repo.repoRoot !== undefined && folder.uri.fsPath === repo.repoRoot,
      })),
    }));
    const worktrees = sections.flatMap((section) => section.worktrees);
    this.syncPrTitles(worktrees.filter((worktree) => !worktree.isRoot));
    this.syncBranches(worktrees.filter((worktree) => worktree.isRoot));
    return sections;
  }

  /**
   * Looks up the PR for each not-yet-resolved worktree in the background and
   * re-renders once the batch lands, so rows flip from folder name to PR title
   * without blocking the initial paint. Already-cached and in-flight folders
   * are skipped, so repeated re-renders don't re-spawn `gh`.
   */
  private syncPrTitles(worktrees: WorktreeElement[]): void {
    const targets = worktrees.filter(
      (worktree) =>
        !this.prCache.has(worktree.folderUri) && !this.resolving.has(worktree.folderUri),
    );
    if (targets.length === 0) {
      return;
    }
    targets.forEach((worktree) => this.resolving.add(worktree.folderUri));

    void Promise.all(
      targets.map(async (worktree) => {
        const cwd = vscode.Uri.parse(worktree.folderUri).fsPath;
        const pr = await resolveWorktreePr(cwd);
        this.resolving.delete(worktree.folderUri);
        this.prCache.set(worktree.folderUri, pr ?? null);
        return pr !== undefined;
      }),
    ).then((found) => {
      if (found.some(Boolean)) {
        this.emitter.fire();
      }
    });
  }

  /** Same background-refresh scheme as {@link syncPrTitles}, for root rows' branch names. */
  private syncBranches(roots: WorktreeElement[]): void {
    const targets = roots.filter(
      (worktree) =>
        !this.branchCache.has(worktree.folderUri) && !this.resolvingBranch.has(worktree.folderUri),
    );
    if (targets.length === 0) {
      return;
    }
    targets.forEach((worktree) => this.resolvingBranch.add(worktree.folderUri));

    void Promise.all(
      targets.map(async (worktree) => {
        const cwd = vscode.Uri.parse(worktree.folderUri).fsPath;
        const branch = await currentBranch(cwd);
        this.resolvingBranch.delete(worktree.folderUri);
        this.branchCache.set(worktree.folderUri, branch ?? null);
        return branch !== undefined;
      }),
    ).then((found) => {
      if (found.some(Boolean)) {
        this.emitter.fire();
      }
    });
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    return isRepoSection(element) ? this.repoItem(element) : this.worktreeItem(element);
  }

  private repoItem(section: RepoSection): vscode.TreeItem {
    const item = new vscode.TreeItem(section.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = section.id;
    // Only git repos get the inline "+" (New Worktree).
    item.contextValue = section.repoRoot ? 'repo-git' : 'repo';
    return item;
  }

  private worktreeItem(worktree: WorktreeElement): vscode.TreeItem {
    // The repo's main checkout is never linked to a PR — it shows its current
    // branch name instead (falling back to the folder name while that
    // background lookup is in flight).
    if (worktree.isRoot) {
      return this.rootItem(worktree);
    }

    // A worktree with a PR takes the PR's title as its display name; the folder
    // name stays available in the tooltip. The PR is whatever the background
    // lookup resolved for the worktree's branch.
    const resolved = this.prCache.get(worktree.folderUri);
    const prNumber = resolved?.number;
    const label = resolved ? `#${resolved.number}: ${resolved.title}` : worktree.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // A resolved PR gets a state-colored icon (open green, draft grey, merged
    // purple, closed red).
    if (resolved) {
      item.iconPath = prThemeIcon(resolved.state, resolved.isDraft);
    }

    item.id = `worktree:${worktree.folderUri}`;
    // Menu `when` clauses match these exact markers: closed (not an open
    // workspace folder) gates "Delete Worktree".
    item.contextValue = worktree.isOpen ? 'worktree-open' : 'worktree-closed';
    const prNote = prNumber ? ` — PR #${prNumber}` : '';
    item.tooltip = `Open "${worktree.name}" in a new window${prNote}`;
    item.command = {
      command: COMMANDS.openWindow,
      title: 'Open Worktree in New Window',
      arguments: [worktree.folderUri],
    };

    return item;
  }

  private rootItem(worktree: WorktreeElement): vscode.TreeItem {
    const branch = this.branchCache.get(worktree.folderUri);
    const label = branch ?? worktree.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.id = `worktree:${worktree.folderUri}`;
    // The `worktree-root-*` markers keep "Delete Worktree" (which matches
    // `worktree-open`/`worktree-closed` exactly) off this row, while
    // `copyWorktreePath` (matching the `worktree` prefix) still applies.
    item.contextValue = worktree.isOpen ? 'worktree-root-open' : 'worktree-root-closed';
    item.tooltip = `Open "${worktree.name}" in a new window — branch "${label}"`;
    item.command = {
      command: COMMANDS.openWindow,
      title: 'Open Worktree in New Window',
      arguments: [worktree.folderUri],
    };

    return item;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.emitter.dispose();
  }
}
