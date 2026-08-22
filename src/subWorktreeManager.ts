import * as path from 'path';
import * as vscode from 'vscode';
import { git } from './cli';
import { changedLineCounts, DiffStat, totalsByDirectory } from './diffStats';
import { OPEN_DIFF } from './fileCommands';
import { compareEntries, FileEntry, listDirectory } from './files';
import {
  changedFilesVsBranch,
  ensureRepositoryOpen,
  FileChange,
  FileChangeKind,
  onRepositoryStateChanged,
} from './gitExtension';
import { log } from './log';
import { resolveWorktreePr } from './pr';
import { absolutePath, DigestCache, ReadMarkStore, ReadScope, storedPath } from './readMarks';
import { LayoutStore } from './store';
import { currentBranch, repoRootOf } from './worktrees';

export type FilesElement = FileEntry;

/** The view's title without the changed-file count. */
const FILES_VIEW_TITLE = 'Files Changed';

// Marker query put on row resourceUris so ChangedFileDecorationProvider can
// badge them (U/M/D) — a query no other view's URIs carry.
const STATUS_QUERY_KEY = 'tabManagerStatus';

// Struck-through text for rows the user has marked read. A tree row's label is
// plain text — there is no strikethrough on TreeItem, and FileDecoration has
// no such property either — so the only way to draw one is a combining long
// stroke after every character.
const STRIKE = '\u0336';

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
  renamed: new vscode.FileDecoration(
    'R',
    'Renamed since the base branch',
    new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
  ),
};

/** `name` with a line drawn through it, for a file marked read. */
function struckThrough(name: string): string {
  return [...name].map((character) => character + STRIKE).join('');
}

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
 * Groups changed paths into tree rows keyed by their parent directory, adding
 * a row for every ancestor directory up to `root`. Built from the change set
 * rather than from a directory listing so paths that no longer exist on disk
 * still get rows — a deleted file, or a directory that was deleted wholesale.
 */
function buildChangedTree(root: vscode.Uri, files: Iterable<string>): Map<string, FileEntry[]> {
  const rootPrefix = root.fsPath.endsWith(path.sep) ? root.fsPath : root.fsPath + path.sep;
  const children = new Map<string, FileEntry[]>();
  const added = new Set<string>();
  for (const file of files) {
    let isDirectory = false;
    let fsPath = file;
    // Walk up to the root. Once a path is already in the tree so are all of
    // its ancestors, so the rest of the walk can be skipped.
    while (fsPath.startsWith(rootPrefix) && !added.has(fsPath)) {
      added.add(fsPath);
      const parent = path.dirname(fsPath);
      const entry: FileEntry = {
        uri: vscode.Uri.file(fsPath),
        name: path.basename(fsPath),
        isDirectory,
      };
      const siblings = children.get(parent);
      if (siblings) {
        siblings.push(entry);
      } else {
        children.set(parent, [entry]);
      }
      isDirectory = true;
      fsPath = parent;
    }
  }
  for (const siblings of children.values()) {
    siblings.sort(compareEntries);
  }
  return children;
}

/**
 * The Sub Worktree Manager container's "Files Changed" view: the active worktree's
 * file tree, and only that worktree's — unlike the built-in Explorer, which
 * has no way to scope a multi-root workspace down to one root. Rows carry a
 * `resourceUri`, the only way the Tree API can color a row's text; this pulls
 * in the built-in Git extension's own decorations for free (green additions,
 * orange modifications, dimmed ignored files) with no git-status code of our
 * own, at the cost of VS Code also showing that row's file-type icon — an
 * unavoidable pairing, there is no way to get decorated text without it.
 *
 * The tree is filtered to files that differ from the worktree's PR base
 * branch — the branch the PR merges into, resolved via `gh` — falling back
 * to the repo's default branch when there's no PR (merge-base semantics plus
 * uncommitted changes). Folders show only while they contain changed files,
 * and deleted files (or folders) are listed too, even though nothing on disk
 * backs them. Each changed file also carries its `+added -deleted` line counts.
 * When the comparison can't be made, the full tree is shown from disk instead.
 */
export class SubWorktreeManager
  implements vscode.TreeDataProvider<FilesElement>, vscode.Disposable
{
  // Fired with an element to redraw just that row, or with undefined for the
  // whole tree — a full refresh re-runs `git diff` and the line counts, which
  // is far too much work for a checkbox.
  private readonly emitter = new vscode.EventEmitter<FilesElement | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private stateSignature = '';
  private watcher: vscode.Disposable | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private repoSubscription: vscode.Disposable | undefined;
  private repoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private changedFiles: Map<string, FileChange> | undefined;
  /** Line counts for the changed files, for the "+12 -3" row description. */
  private changedStats: Map<string, DiffStat> | undefined;
  /** The same counts rolled up per directory, for the folder rows. */
  private changedDirStats: Map<string, DiffStat> | undefined;
  /** Filtered rows keyed by parent dir; undefined while the filter is off. */
  private changedChildren: Map<string, FileEntry[]> | undefined;
  /** The view handle, for the "Files Changed (N)" title. */
  private view: vscode.TreeView<FilesElement> | undefined;
  private checkboxSubscription: vscode.Disposable | undefined;
  private compareBase: string | undefined;
  /** Display name of the ref being compared against, for diff-tab titles. */
  private compareLabel: string | undefined;
  private warnedFilterKey: string | undefined;
  // Both caches avoid re-spawning `gh`/`git` on every re-render; keyed so a
  // different root (or branch) recomputes. `fromPr` records whether the ref
  // is the PR's target branch or the default-branch fallback — only the
  // fallback is retried (see subscribeToRepository).
  private cachedCompareRef:
    | { key: string; ref: string | undefined; fromPr: boolean; scope: ReadScope | undefined }
    | undefined;
  private detectedDefault: { root: string; branch: string | undefined } | undefined;
  /** The worktree being listed, parsed once — every row asks for it. */
  private root: vscode.Uri | undefined;
  /** The review the read marks on these rows belong to; see {@link ReadScope}. */
  private scope: ReadScope | undefined;
  /** Paths whose content changed and whose read mark still has to be checked. */
  private readonly pendingDigestChecks = new Set<string>();
  private digestTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly digests = new DigestCache();

  // Whether directory rows default to expanded (the view-title toggle). The
  // generation is baked into row ids so each toggle defeats VS Code's
  // remembered per-id expansion state and the new default applies everywhere.
  private expandAll = false;
  private expandGeneration = 0;

  // The "N of M reviewed" line, and the filter that hides reviewed rows. The
  // count is over the full changed set, so it reads the same whether or not the
  // filter is hiding anything.
  private reviewedCount = 0;
  private unreviewedOnly = false;

  constructor(
    private readonly store: LayoutStore,
    private readonly marks: ReadMarkStore,
  ) {
    this.subscription = vscode.Disposable.from(
      store.onDidChange(() => this.onStoreChange()),
      // Ticks made in this window redraw their own row; only another window's
      // are a surprise, and those are rare enough to redraw everything.
      marks.onDidChangeElsewhere(() => this.emitter.fire(undefined)),
    );
    this.applyStoreState();
    void vscode.commands.executeCommand('setContext', 'tabManager.filesExpanded', false);
    void vscode.commands.executeCommand('setContext', 'tabManager.filesUnreviewedOnly', false);
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** The view-title collapse-all/expand-all toggle. */
  setExpandAll(expanded: boolean): void {
    this.expandAll = expanded;
    this.expandGeneration++;
    void vscode.commands.executeCommand('setContext', 'tabManager.filesExpanded', expanded);
    this.emitter.fire(undefined);
  }

  /** The view-title filter: show only files not yet marked read. */
  setUnreviewedOnly(on: boolean): void {
    if (this.unreviewedOnly === on) {
      return;
    }
    this.unreviewedOnly = on;
    void vscode.commands.executeCommand('setContext', 'tabManager.filesUnreviewedOnly', on);
    // Re-filter from the cached change set — no git, no hashing.
    const root = this.root;
    if (root) {
      this.rebuildRows(root);
    }
    this.updateTitle();
    this.emitter.fire(undefined);
  }

  /**
   * Hooks up the TreeView: the title carries the changed-file count, and the
   * row checkboxes drive the read marks. The view is created with
   * `manageCheckboxStateManually`, so a tick is only real once it is stored.
   */
  attachView(view: vscode.TreeView<FilesElement>): void {
    this.view = view;
    this.checkboxSubscription = view.onDidChangeCheckboxState((event) => {
      for (const [node, state] of event.items) {
        void this.setRead(node, state === vscode.TreeItemCheckboxState.Checked);
      }
    });
    this.updateTitle();
  }

  private updateTitle(): void {
    if (!this.view) {
      return;
    }
    this.view.title = this.changedFiles
      ? `${FILES_VIEW_TITLE} (${this.changedFiles.size})`
      : FILES_VIEW_TITLE;
    // The review-progress line sits under the title, in the view's dimmed
    // description slot — the only second line the Tree API offers.
    this.view.description = this.reviewDescription();
  }

  private reviewDescription(): string | undefined {
    const total = this.changedFiles?.size ?? 0;
    if (total === 0) {
      return undefined;
    }
    const percent = Math.round((this.reviewedCount / total) * 100);
    return `${this.reviewedCount} files reviewed out of ${total} changed (${percent}%)`;
  }

  private onStoreChange(): void {
    const signature = this.signature();
    if (signature === this.stateSignature) {
      return;
    }
    this.applyStoreState();
    this.emitter.fire(undefined);
  }

  private signature(): string {
    return `${this.store.activeFolderUri}`;
  }

  private applyStoreState(): void {
    this.stateSignature = this.signature();
    this.cachedCompareRef = undefined;
    const uri = this.store.activeFolderUri;
    this.root = uri ? vscode.Uri.parse(uri) : undefined;
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
    // the Git decoration provider, which refreshes itself independently — but
    // they do invalidate read marks, which is a far cheaper check than a
    // refresh (it only hashes the marked file that was edited).
    const fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const scheduleRefresh = () => {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.emitter.fire(undefined), 300);
    };
    this.watcher = vscode.Disposable.from(
      fsWatcher,
      fsWatcher.onDidCreate(scheduleRefresh),
      fsWatcher.onDidDelete(scheduleRefresh),
      fsWatcher.onDidChange((uri) => this.scheduleDigestCheck(uri)),
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
      // A fallback ref may just mean the PR didn't exist (or `gh` failed)
      // when it was resolved — drop it so the next recompute retries the PR
      // lookup. A PR-derived ref is kept; re-querying gh on every git state
      // change would spam the network for a base that rarely changes.
      if (this.cachedCompareRef && !this.cachedCompareRef.fromPr) {
        this.cachedCompareRef = undefined;
      }
      clearTimeout(this.repoRefreshTimer);
      this.repoRefreshTimer = setTimeout(() => this.emitter.fire(undefined), 1000);
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
    // While the filter is on the rows come from the change set rather than
    // from disk, so deleted paths are listed alongside the ones still there.
    const entries = this.changedChildren
      ? (this.changedChildren.get(dirUri.fsPath) ?? [])
      : await listDirectory(dirUri);
    return Promise.all(entries.map((entry) => this.compressChain(entry)));
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

  /**
   * Queues a re-check of one edited file's read mark. Debounced, and skipped
   * outright for files that aren't marked — a save in a file nobody ticked
   * costs nothing.
   */
  private scheduleDigestCheck(uri: vscode.Uri): void {
    // Every write anywhere in the worktree lands here — builds, installs, a
    // formatter running over the tree — so this bails out as early as it can.
    const root = this.root;
    if (!this.scope || !root) {
      return;
    }
    const relative = storedPath(root, uri);
    if (relative === undefined || this.marks.digestOf(this.scope, relative) === undefined) {
      return;
    }
    this.pendingDigestChecks.add(relative);
    clearTimeout(this.digestTimer);
    this.digestTimer = setTimeout(() => {
      void this.dropStaleMarks(this.pendingDigestChecks, true).then((dropped) => {
        if (dropped) {
          this.emitter.fire(undefined);
        }
      });
    }, 300);
  }

  /**
   * Un-marks files whose content no longer matches what was read. `candidates`
   * is drained as it is taken, so a check in flight can't swallow paths queued
   * behind it. `edited` says the files are known to have just been written, so
   * they must be hashed rather than trusted to their stat.
   *
   * Returns whether any mark was dropped.
   */
  private async dropStaleMarks(candidates: Set<string>, edited: boolean): Promise<boolean> {
    const scope = this.scope;
    const root = this.rootUri();
    const paths = [...candidates];
    candidates.clear();
    if (!scope || !root || paths.length === 0) {
      return false;
    }
    const stale = await Promise.all(
      paths.map(async (relative) => {
        const marked = this.marks.digestOf(scope, relative);
        if (marked === undefined) {
          return undefined; // un-marked while we were queued
        }
        const fsPath = absolutePath(root, relative);
        const digest = edited
          ? await this.digests.rehash(fsPath)
          : await this.digests.digest(fsPath);
        return digest === marked ? undefined : relative;
      }),
    );
    const dropped = stale.filter((relative): relative is string => relative !== undefined);
    if (dropped.length === 0) {
      return false;
    }
    log(`read marks: ${dropped.length} file(s) changed since they were read — un-marking`);
    return this.marks.unmark(scope, dropped);
  }

  /** Refreshes the changed-file set (and the folders containing them). */
  private async recomputeChangedSet(root: vscode.Uri): Promise<void> {
    this.changedFiles = undefined;
    this.changedStats = undefined;
    this.changedDirStats = undefined;
    this.changedChildren = undefined;
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

    this.changedFiles = comparison.files;
    this.compareBase = comparison.base;
    this.compareLabel = branch;
    this.changedStats = await changedLineCounts(root, comparison.base, comparison.files);
    // Catch up on edits made while this window wasn't watching (another window,
    // an agent, a rebase) before the counts and the filter read the marks.
    // Cheap: only a file whose stat moved since it was last hashed is read.
    if (this.scope) {
      await this.dropStaleMarks(new Set(this.marks.markedPaths(this.scope)), false);
    }
    this.rebuildRows(root);
  }

  /**
   * Rebuilds the visible rows and the review count from the cached change set —
   * no git, no hashing — so a tick or a filter toggle is cheap. The count is
   * always over every changed file; the filter only decides which rows show.
   */
  private rebuildRows(root: vscode.Uri): void {
    const files = this.changedFiles;
    if (!files) {
      this.reviewedCount = 0;
      this.changedChildren = undefined;
      this.changedDirStats = undefined;
      return;
    }
    let reviewed = 0;
    const visible = new Set<string>();
    for (const fsPath of files.keys()) {
      const read = this.isReadFsPath(root, fsPath);
      if (read) {
        reviewed++;
      }
      if (!this.unreviewedOnly || !read) {
        visible.add(fsPath);
      }
    }
    this.reviewedCount = reviewed;
    this.changedChildren = buildChangedTree(root, visible);
    const stats = this.changedStats;
    const visibleStats =
      this.unreviewedOnly && stats
        ? new Map([...stats].filter(([fsPath]) => visible.has(fsPath)))
        : stats;
    this.changedDirStats = visibleStats ? totalsByDirectory(root, visibleStats) : undefined;
  }

  /** Whether a changed file (keyed by fsPath, as the change set is) is read. */
  private isReadFsPath(root: vscode.Uri, fsPath: string): boolean {
    if (!this.scope) {
      return false;
    }
    const relative = storedPath(root, vscode.Uri.file(fsPath));
    return relative !== undefined && this.marks.digestOf(this.scope, relative) !== undefined;
  }

  /**
   * The ref changed files are compared against: the base branch of the
   * worktree's PR (as `origin/<base>`, so a stale or missing local branch
   * can't skew the merge-base), else the repo's default branch when there
   * is no PR.
   */
  private async compareRef(root: vscode.Uri): Promise<string | undefined> {
    // The branch is part of the key: checking out another branch changes
    // which PR (and so which target branch) the comparison should follow.
    const branch = await currentBranch(root.fsPath);
    const key = `${root.toString()}|${branch ?? ''}`;
    if (this.cachedCompareRef?.key !== key) {
      const pr = await resolveWorktreePr(root.fsPath);
      // Read marks hang off the same lookup: the repository the worktree
      // belongs to, plus the PR being reviewed (the branch, when there is no
      // PR — a worktree with neither has nowhere to file them).
      const repoRoot = await repoRootOf(root);
      const id = pr ? `pr:${pr.number}` : branch ? `branch:${branch}` : undefined;
      const scope = repoRoot !== undefined && id !== undefined ? { repoRoot, id } : undefined;
      this.cachedCompareRef = pr
        ? { key, ref: `origin/${pr.baseRefName}`, fromPr: true, scope }
        : { key, ref: await this.defaultBranch(root), fromPr: false, scope };
    }
    this.scope = this.cachedCompareRef.scope;
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

  /**
   * Whether a file is marked read, or undefined when it can't be marked at all
   * (no review to file the mark under, or the path isn't inside the worktree).
   */
  private isRead(uri: vscode.Uri): boolean | undefined {
    const root = this.rootUri();
    const relative = root && storedPath(root, uri);
    if (!this.scope || relative === undefined) {
      return undefined;
    }
    return this.marks.digestOf(this.scope, relative) !== undefined;
  }

  /**
   * Handles a row's checkbox. Ticking records the file's current digest, so
   * editing it later drops the mark again.
   */
  private async setRead(node: FilesElement | undefined, read: boolean): Promise<void> {
    const root = this.rootUri();
    if (!node || node.isDirectory || !root || !this.scope) {
      return;
    }
    const relative = storedPath(root, node.uri);
    if (relative === undefined) {
      return;
    }
    if (!read) {
      if (await this.marks.unmark(this.scope, [relative])) {
        this.onReadToggled(node);
      }
      return;
    }
    const digest = await this.digests.rehash(node.uri.fsPath);
    if (digest === undefined) {
      void vscode.window.showWarningMessage(
        `Tab Manager can't read "${relative}", so it can't be marked as read — see Output → Tab Manager.`,
      );
      this.emitter.fire(node); // put the checkbox back the way it was
      return;
    }
    if (await this.marks.mark(this.scope, relative, digest)) {
      this.onReadToggled(node);
    }
  }

  /** After a tick lands: refresh the review line, and redraw what changed. */
  private onReadToggled(node: FilesElement): void {
    const root = this.root;
    if (root) {
      this.rebuildRows(root);
    }
    this.updateTitle();
    // Under the filter the ticked row appears or disappears, so the tree's
    // shape changed — redraw it. Otherwise only that row's own look changed.
    this.emitter.fire(this.unreviewedOnly ? undefined : node);
  }

  private rootUri(): vscode.Uri | undefined {
    return this.root;
  }

  getTreeItem(element: FilesElement): vscode.TreeItem {
    return this.fileItem(element);
  }

  private fileItem(node: FileEntry): vscode.TreeItem {
    const read = node.isDirectory ? undefined : this.isRead(node.uri);
    const item = new vscode.TreeItem(
      read === true ? struckThrough(node.name) : node.name,
      node.isDirectory
        ? this.expandAll
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = node.uri;
    item.contextValue = node.isDirectory ? 'fileDirectory' : 'fileLeaf';
    // A file's own counts; a folder's are everything changed beneath it. Tree
    // rows can't color part of their text, so the two counts can't be
    // green/red — they ride in the description slot, and the status badge stays
    // the row's one splash of color.
    const stat = node.isDirectory
      ? this.changedDirStats?.get(node.uri.fsPath)
      : this.changedStats?.get(node.uri.fsPath);
    if (stat) {
      item.description = `+${stat.added} -${stat.deleted}`;
    }
    if (node.isDirectory) {
      // See setExpandAll — the generation forces the default state to re-apply.
      item.id = `${this.expandGeneration}:${node.uri.toString()}`;
    } else {
      // A stable id: the label changes when the row is ticked, and without an
      // id VS Code identifies rows by what they render.
      item.id = node.uri.toString();
      if (read !== undefined) {
        item.checkboxState = read
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
      }
      const change = this.changedFiles?.get(node.uri.fsPath);
      if (change) {
        // The marker query makes ChangedFileDecorationProvider badge the row.
        item.resourceUri = node.uri.with({ query: `${STATUS_QUERY_KEY}=${change.kind}` });
      }
      // A modified file opens as a diff against the compare base; a renamed
      // file diffs against its old path there. An added file has no base-side
      // content to diff against, and a deleted file no working-tree side —
      // those open the one version that exists. Files in the unfiltered
      // fallback (diff unavailable) open normally too.
      const branch = this.compareLabel;
      const asDiff = this.compareBase !== undefined && branch !== undefined && change !== undefined;
      // preview: true, like Source Control — clicking through the list reuses
      // one tab instead of stacking a tab per file. VS Code pins the tab as
      // soon as it is edited or double-clicked, so a file you actually work on
      // survives the next click.
      item.command =
        asDiff && change.kind !== 'added'
          ? {
              command: OPEN_DIFF,
              title: 'Open Diff',
              arguments: [
                node.uri,
                this.compareBase,
                branch,
                change.kind === 'deleted',
                change.originalUri,
              ],
            }
          : {
              command: 'vscode.open',
              title: 'Open File',
              arguments: [node.uri, { preview: true }],
            };
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.checkboxSubscription?.dispose();
    this.watcher?.dispose();
    this.repoSubscription?.dispose();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.repoRefreshTimer);
    clearTimeout(this.digestTimer);
    this.emitter.dispose();
  }
}
