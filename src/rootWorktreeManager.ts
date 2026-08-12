import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { COMMANDS } from './commands';
import { log } from './log';
import {
  listOpenPrs,
  prDigitStripIcon,
  prStateLabel,
  prVisualState,
  PrSummary,
  resolveWorktreePr,
  summarizeChecks,
} from './pr';
import { configuredRepos, onDidChangeConfiguredRepos } from './repos';
import { LayoutStore } from './store';
import { currentBranch, discoverClaudeWorktrees } from './worktrees';

/** A collapsible section for one repository and its pull requests. */
export interface RepoSection {
  readonly id: string;
  readonly label: string;
  /** Absolute path of the repository root. */
  readonly repoRoot: string;
}

/**
 * A row under a repository. Usually a pull request and the worktree checked
 * out to its branch, but either half can be missing: `pr` is absent for the
 * main checkout and for worktrees nobody opened a PR for, and `folderUri` is
 * absent for a PR with no worktree yet — clicking that row creates one.
 */
export interface BranchElement {
  readonly id: string;
  readonly repoRoot: string;
  readonly pr: PrSummary | undefined;
  readonly folderUri: string | undefined;
  /** The worktree's folder name, or the branch for the main checkout. */
  readonly name: string;
  /** Whether this is the repo's main checkout, not a linked worktree. */
  readonly isRoot: boolean;
  /** Pull requests that merge into this row's branch, stacked under it. */
  readonly children: BranchElement[];
}

/**
 * The single row a repository shows while its pull requests are being looked
 * up. Rows would otherwise appear under their folder names and then rewrite
 * themselves — and re-sort — as the `gh` call lands.
 */
export interface LoadingElement {
  /** Id of the section being waited on; keeps the row's TreeItem id unique. */
  readonly loadingFor: string;
}

export type TreeElement = RepoSection | BranchElement | LoadingElement;

function isRepoSection(element: TreeElement): element is RepoSection {
  return 'repoRoot' in element && !('children' in element);
}

function isBranch(element: TreeElement): element is BranchElement {
  return 'children' in element;
}

function isLoading(element: TreeElement): element is LoadingElement {
  return 'loadingFor' in element;
}

/**
 * The "Root Worktree Manager" view: a collapsible section per repository, and
 * under it every open pull request — whether or not a worktree exists for it —
 * with the PRs that target another PR's branch nested inside it, so a stack of
 * PRs reads as a stack. The repositories are the saved list, kept in global VS
 * Code settings, so every window shows the same ones.
 *
 * A row carries the PR's state and number (`OPEN - #808`); its title and CI
 * status hang under it as their own rows, since a tree row cannot wrap. A row
 * with a worktree opens it in a new window; a row without one creates the
 * worktree first, exactly as "New Worktree from PR" would.
 */
export class RootWorktreeManager
  implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];
  // repoRoot -> its rows, and the set of repos whose load is in flight. A
  // repository is loaded once and reused until refresh(), so re-rendering the
  // tree (which VS Code does often) doesn't re-spawn `gh`.
  private readonly rows = new Map<string, BranchElement[]>();
  private readonly loading = new Set<string>();
  // Section objects are cached, not rebuilt per render, because reveal() needs
  // the very element instances the tree was given — a fresh object with the
  // same contents is a different element as far as VS Code is concerned.
  private readonly sections = new Map<string, RepoSection>();
  /** Row -> the row above it, the parent chain reveal() walks. */
  private readonly parents = new Map<TreeElement, TreeElement>();
  /** The view handle, for selecting the worktree this window is on. */
  private view: vscode.TreeView<TreeElement> | undefined;

  constructor(private readonly store: LayoutStore) {
    this.subscriptions = [
      store.onDidChange(() => {
        this.emitter.fire();
        this.selectActiveWorktree();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitter.fire()),
      // Re-render, rather than refresh(): adding or removing one repository
      // says nothing about the others, whose rows stay valid.
      onDidChangeConfiguredRepos(() => this.emitter.fire()),
    ];
  }

  /**
   * Re-renders the tree (e.g. after a worktree is created on disk). Drops the
   * loaded rows so every repository re-queries `gh` — new worktrees appear, and
   * merged or renamed PRs refresh.
   */
  refresh(): void {
    this.rows.clear();
    this.parents.clear();
    this.emitter.fire();
  }

  /** Hooks up the TreeView, the only handle that can select a row. */
  attachView(view: vscode.TreeView<TreeElement>): void {
    this.view = view;
    this.selectActiveWorktree();
  }

  // Synchronous: every `gh`/`git` call happens in load(), so the tree paints
  // immediately (as "Loading…") and fills in when the repository lands.
  getChildren(element?: TreeElement): TreeElement[] {
    if (!element) {
      // An empty repository list: show the welcome content instead.
      return configuredRepos().map((repoRoot) => this.section(repoRoot));
    }
    if (isRepoSection(element)) {
      const rows = this.rows.get(element.repoRoot);
      if (!rows) {
        this.load(element.repoRoot);
        const loading: LoadingElement = { loadingFor: element.id };
        this.parents.set(loading, element);
        return [loading];
      }
      return rows;
    }
    if (isBranch(element)) {
      return element.children;
    }
    return [];
  }

  /** The parent chain, which is what {@link vscode.TreeView.reveal} walks. */
  getParent(element: TreeElement): TreeElement | undefined {
    return this.parents.get(element);
  }

  private section(repoRoot: string): RepoSection {
    const existing = this.sections.get(repoRoot);
    if (existing) {
      return existing;
    }
    const section: RepoSection = {
      id: `repo:${repoRoot}`,
      label: path.basename(repoRoot),
      repoRoot,
    };
    this.sections.set(repoRoot, section);
    return section;
  }

  /**
   * Loads a repository's rows in the background — one `gh pr list` for the
   * whole repo, plus a branch lookup per worktree — and re-renders when they
   * land. Repeated calls while one is in flight are ignored.
   */
  private load(repoRoot: string): void {
    if (this.loading.has(repoRoot)) {
      return;
    }
    this.loading.add(repoRoot);
    void buildRows(repoRoot)
      // A repository that cannot be read caches as empty rather than staying
      // unloaded: an unloaded one would be re-queried on the very next render,
      // spawning `gh` in a loop. Refresh retries it.
      .catch((error: unknown) => {
        log(`tree: could not load ${repoRoot} — ${errorMessage(error)}`);
        return [];
      })
      .then((rows) => {
        this.rows.set(repoRoot, rows);
        this.recordParents(rows, this.section(repoRoot));
        this.loading.delete(repoRoot);
        this.emitter.fire();
        this.selectActiveWorktree();
      });
  }

  private recordParents(rows: readonly BranchElement[], parent: TreeElement): void {
    for (const row of rows) {
      this.parents.set(row, parent);
      this.recordParents(row.children, row);
    }
  }

  /**
   * Selects the row for the worktree this window is on, so the Root Worktree
   * Manager shows where you are the same way the Sub Worktree Manager does.
   * Real list selection — the Tree API has no way to tint a single row — which
   * also means clicking another row moves it until the next refresh.
   */
  private selectActiveWorktree(): void {
    const active =
      this.store.activeFolderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    if (!active || !this.view) {
      return;
    }
    const row = this.findRow(active);
    if (!row) {
      return; // its repository is not on the list, or has not loaded yet
    }
    this.view.reveal(row, { select: true, focus: false }).then(undefined, (error: unknown) => {
      log(`tree: could not select the active worktree — ${errorMessage(error)}`);
    });
  }

  /** The row backed by a given worktree folder, at any nesting depth. */
  private findRow(folderUri: string): BranchElement | undefined {
    const search = (rows: readonly BranchElement[]): BranchElement | undefined => {
      for (const row of rows) {
        if (row.folderUri === folderUri) {
          return row;
        }
        const nested = search(row.children);
        if (nested) {
          return nested;
        }
      }
      return undefined;
    };
    for (const rows of this.rows.values()) {
      const found = search(rows);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if (isRepoSection(element)) {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = element.id;
      // Matched by the row's inline "+" (New Worktree) and "×" (Remove Repository).
      item.contextValue = 'repo-git';
      item.tooltip = element.repoRoot;
      return item;
    }
    if (isLoading(element)) {
      const item = new vscode.TreeItem('Loading…', vscode.TreeItemCollapsibleState.None);
      item.id = `loading:${element.loadingFor}`;
      return item;
    }
    return this.branchItem(element);
  }

  private branchItem(element: BranchElement): vscode.TreeItem {
    const pr = element.pr;
    const text = pr ? prLabel(pr) : element.name;
    // Rows backed by a worktree on disk are emphasized. A highlight range over
    // the whole label is the only way the Tree API can weight a row's text.
    const label: vscode.TreeItemLabel = element.folderUri
      ? { label: text, highlights: [[0, text.length]] }
      : { label: text };
    const item = new vscode.TreeItem(
      label,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;

    // A PR gets its digit-color strip as the icon — the same PR-number encoding
    // shown atop the PR view.
    if (pr) {
      item.iconPath = prDigitStripIcon(pr.number);
    }
    if (pr && !element.folderUri) {
      item.description = 'no worktree';
    }

    const isOpen = element.folderUri !== undefined && this.openFolderUris().has(element.folderUri);
    if (element.isRoot) {
      // The `worktree-root-*` markers keep "Delete Worktree" (which matches
      // `worktree-open`/`worktree-closed` exactly) off the main checkout, while
      // `copyWorktreePath` (matching the `worktree` prefix) still applies.
      item.contextValue = isOpen ? 'worktree-root-open' : 'worktree-root-closed';
    } else if (element.folderUri) {
      item.contextValue = isOpen ? 'worktree-open' : 'worktree-closed';
    } else {
      item.contextValue = 'pr-no-worktree';
    }

    const action = element.folderUri
      ? `Open "${element.name}" in a new window`
      : `Create a worktree for PR #${pr?.number} and check it out`;
    // The row truncates in a narrow sidebar, so the tooltip repeats the title in
    // full — it is the one place the whole thing is readable.
    item.tooltip = pr ? `#${pr.number} ${pr.title}\n${action}` : action;
    item.command = this.rowCommand(element);
    return item;
  }

  /**
   * What clicking a row does: open its worktree in its own window, or — for a
   * PR that has none — create the worktree the "New Worktree from PR" way.
   */
  private rowCommand(element: BranchElement): vscode.Command {
    if (element.folderUri) {
      return {
        command: COMMANDS.openWindow,
        title: 'Open Worktree in New Window',
        arguments: [element.folderUri],
      };
    }
    return {
      command: COMMANDS.newWorktreeForPr,
      title: 'Create Worktree for Pull Request',
      arguments: [element.repoRoot, element.pr?.number],
    };
  }

  /** The folders this window has open — the one thing that differs per window. */
  private openFolderUris(): Set<string> {
    return new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()));
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.emitter.dispose();
  }
}

/**
 * A pull request row's label, all on one line:
 * `OPEN (TC) #798: feat(web): Zod request schemas`.
 *
 * The bracket only appears when something is wrong — `T` when checks are
 * failing, `C` when GitHub reports a conflict with the base branch, `TC` for
 * both. A PR that is fine reads `OPEN #798: …` with nothing in between, so the
 * eye only has to catch the rows that do carry a warning. Merged and closed PRs
 * never carry one: both signals are moot by then.
 */
function prLabel(pr: PrSummary): string {
  const visual = prVisualState(pr.state, pr.isDraft);
  let warning = '';
  if (visual !== 'merged' && visual !== 'closed') {
    const failing = (summarizeChecks(pr.statusCheckRollup)?.failed ?? 0) > 0 ? 'T' : '';
    const conflicting = pr.mergeable?.toUpperCase() === 'CONFLICTING' ? 'C' : '';
    warning = failing || conflicting ? ` (${failing}${conflicting})` : '';
  }
  return `${prStateLabel(visual)}${warning} #${pr.number}: ${pr.title}`;
}

/** A worktree folder and the branch it currently has checked out. */
interface WorktreeRef {
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly branch: string | undefined;
}

/**
 * Builds one repository's rows: the main checkout first, then every open pull
 * request — nested by which branch each targets — and finally the worktrees no
 * open PR claims. A PR and a worktree belong together when the worktree has the
 * PR's head branch checked out.
 */
async function buildRows(repoRoot: string): Promise<BranchElement[]> {
  const [prs, folders, rootBranch] = await Promise.all([
    listOpenPrs(repoRoot),
    discoverClaudeWorktrees(repoRoot),
    currentBranch(repoRoot),
  ]);
  const worktrees: WorktreeRef[] = await Promise.all(
    folders.map(async (folder) => ({
      uri: folder.uri,
      name: folder.name,
      branch: await currentBranch(folder.uri.fsPath),
    })),
  );

  const worktreeOf = new Map<string, WorktreeRef>();
  for (const worktree of worktrees) {
    if (worktree.branch !== undefined) {
      worktreeOf.set(worktree.branch, worktree);
    }
  }

  const rootUri = vscode.Uri.file(repoRoot);
  const mainCheckout: BranchElement = {
    id: `${repoRoot}|root`,
    repoRoot,
    pr: undefined,
    folderUri: rootUri.toString(),
    name: rootBranch ?? path.basename(repoRoot),
    isRoot: true,
    children: [],
  };

  const prRows = prs.map((pr): BranchElement => ({
    id: `${repoRoot}|pr:${pr.number}`,
    repoRoot,
    pr,
    folderUri: worktreeOf.get(pr.headRefName)?.uri.toString(),
    name: worktreeOf.get(pr.headRefName)?.name ?? String(pr.number),
    isRoot: false,
    children: [],
  }));

  return [mainCheckout, ...stack(prRows), ...(await orphanRows(repoRoot, worktrees, prs))];
}

/**
 * Nests each PR under the one it merges into — PR B's base branch being PR A's
 * head branch is exactly what makes B a PR stacked on A — and orders every
 * level by number, highest first. PRs whose base is nobody's head stay at the
 * top level, and a base/head cycle (which GitHub allows to exist briefly during
 * a rebase) leaves the later PR at the top level rather than swallowing it.
 */
function stack(rows: BranchElement[]): BranchElement[] {
  const byHead = new Map<string, BranchElement>();
  for (const row of rows) {
    if (row.pr) {
      byHead.set(row.pr.headRefName, row);
    }
  }

  const parentOf = new Map<BranchElement, BranchElement>();
  const wouldCycle = (child: BranchElement, parent: BranchElement): boolean => {
    for (let at: BranchElement | undefined = parent; at; at = parentOf.get(at)) {
      if (at === child) {
        return true;
      }
    }
    return false;
  };

  const roots: BranchElement[] = [];
  for (const row of rows) {
    const parent = row.pr && byHead.get(row.pr.baseRefName);
    if (parent && parent !== row && !wouldCycle(row, parent)) {
      parentOf.set(row, parent);
      parent.children.push(row);
    } else {
      roots.push(row);
    }
  }

  const byNumberDesc = (left: BranchElement, right: BranchElement): number =>
    (right.pr?.number ?? 0) - (left.pr?.number ?? 0);
  for (const row of rows) {
    row.children.sort(byNumberDesc);
  }
  return roots.sort(byNumberDesc);
}

/**
 * Rows for the worktrees no open PR claims: a branch nobody opened a PR for, or
 * one whose PR is already merged or closed. Only those get the per-worktree
 * `gh pr view` lookup, so a repo whose worktrees all track open PRs makes no
 * extra calls at all.
 */
async function orphanRows(
  repoRoot: string,
  worktrees: readonly WorktreeRef[],
  prs: readonly PrSummary[],
): Promise<BranchElement[]> {
  const claimed = new Set(prs.map((pr) => pr.headRefName));
  const orphans = worktrees.filter(
    (worktree) => worktree.branch === undefined || !claimed.has(worktree.branch),
  );
  const rows = await Promise.all(
    orphans.map(async (worktree): Promise<BranchElement> => {
      const pr = await resolveWorktreePr(worktree.uri.fsPath);
      return {
        id: `${repoRoot}|worktree:${worktree.uri.toString()}`,
        repoRoot,
        pr,
        folderUri: worktree.uri.toString(),
        name: worktree.name,
        isRoot: false,
        children: [],
      };
    }),
  );
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}
