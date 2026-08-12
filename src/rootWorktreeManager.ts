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

// How a row asks to be colored: a marker in its resourceUri query, which file
// decorations then turn into a color. Decorations are the only way the Tree API
// colors a row's text, and the marker keeps it to this view — nothing else in
// VS Code will ever hand out a URI carrying it.
const ROW_QUERY_KEY = 'tabManagerRow';
type RowMark = 'active' | 'healthy' | 'broken';
// Red and green are the Explorer's own, so a worktree in trouble reads in the
// same red git gives a deleted file and a clean one in the same green it gives
// an added file. The blue is an exact shade, which a decoration can only take
// as a registered id — hence the one color contributed in package.json.
const ROW_DECORATION: Record<RowMark, vscode.FileDecoration> = {
  active: new vscode.FileDecoration(
    undefined,
    'The worktree this window is on',
    new vscode.ThemeColor('tabManager.worktreeActive'),
  ),
  healthy: new vscode.FileDecoration(
    undefined,
    'Checked out on disk',
    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
  ),
  broken: new vscode.FileDecoration(
    undefined,
    'Checked out on disk — failing checks or conflicts',
    new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
  ),
};

/**
 * Colors the rows whose worktree exists on disk — the ones that are somewhere
 * you can go: blue for the one this window is on, red when its pull request
 * has a failing check or conflicts, green when it is clean. A pull request
 * with no worktree carries no decoration at all and stays the plain
 * foreground, which is the black it should be.
 */
export class WorktreeRowDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const [key, mark] = uri.query.split('=');
    return key === ROW_QUERY_KEY ? ROW_DECORATION[mark as RowMark] : undefined;
  }
}

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
 * A row says everything on one line (`O TP #806: refactor(evals): …` — see
 * {@link prLabel}), is emphasized when its worktree exists on disk, and turns
 * green for the worktree this window is on. Clicking it opens that worktree in
 * a new window, or — when there is none — creates it first, exactly as "New
 * Worktree from PR" would.
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
  // Section objects are cached rather than rebuilt per render: VS Code keys
  // its element map on identity, and handing it a fresh object with the same
  // contents on every render makes it a different element each time.
  private readonly sections = new Map<string, RepoSection>();

  constructor(private readonly store: LayoutStore) {
    this.subscriptions = [
      store.onDidChange(() => this.emitter.fire()),
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
    this.emitter.fire();
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
        return [{ loadingFor: element.id }];
      }
      return rows;
    }
    if (isBranch(element)) {
      return element.children;
    }
    return [];
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
        this.loading.delete(repoRoot);
        this.emitter.fire();
      });
  }

  /** The worktree this window is on — the one the tree marks as "you are here". */
  private activeFolderUri(): string | undefined {
    return this.store.activeFolderUri ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString();
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
    const isActive =
      element.folderUri !== undefined && element.folderUri === this.activeFolderUri();
    const item = new vscode.TreeItem(
      pr ? prLabel(pr) : element.name,
      element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = element.id;

    // The marker query is what WorktreeRowDecorationProvider colors the row
    // from; the worktree's own folder carries it. A row with no worktree gets
    // no resourceUri at all — nothing to color, and nothing to decorate.
    const mark = rowMark(element, isActive);
    if (mark && element.folderUri) {
      item.resourceUri = vscode.Uri.parse(element.folderUri).with({
        query: `${ROW_QUERY_KEY}=${mark}`,
      });
    }

    // A PR gets its digit-color strip as the icon — the same PR-number encoding
    // shown atop the PR view. Every other row gets an explicit icon too, since
    // a row carrying a resourceUri would otherwise pull in a file-type icon.
    item.iconPath = pr
      ? prDigitStripIcon(pr.number)
      : new vscode.ThemeIcon(element.isRoot ? 'repo' : 'folder');
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
 * A pull request row's label, all on one line, in as few characters as it can
 * be said — everything spent here is title the row cannot show:
 * `O #798: feat(web): Zod request schemas`. The state leads: O open, D draft,
 * M merged, C closed. Everything else the row has to say, it says in color.
 */
function prLabel(pr: PrSummary): string {
  return `${prStateLabel(prVisualState(pr.state, pr.isDraft))} #${pr.number}: ${pr.title}`;
}

/**
 * How a row is colored. Only a worktree that exists on disk gets a color of
 * its own, since only those are somewhere you can go: blue for the one this
 * window is on, red when its pull request has a failing check or conflicts
 * with its base branch, green when it is clean.
 */
function rowMark(element: BranchElement, isActive: boolean): RowMark | undefined {
  if (!element.folderUri) {
    return undefined; // nothing on disk to be in any state
  }
  if (isActive) {
    return 'active';
  }
  return element.pr && needsAttention(element.pr) ? 'broken' : 'healthy';
}

/** Whether a PR is in trouble — a failing check, or a conflict with its base. */
function needsAttention(pr: PrSummary): boolean {
  const visual = prVisualState(pr.state, pr.isDraft);
  if (visual === 'merged' || visual === 'closed') {
    return false; // neither signal means anything once a PR is done
  }
  return (
    (summarizeChecks(pr.statusCheckRollup)?.failed ?? 0) > 0 ||
    pr.mergeable?.toUpperCase() === 'CONFLICTING'
  );
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
