import * as vscode from 'vscode';
import { errorMessage, gh, git } from './cli';
import { log } from './log';
import { LayoutStore } from './store';

const PR_COMMANDS = {
  refresh: 'tabManager.refreshPr',
  editTitle: 'tabManager.editPrTitle',
  editDescription: 'tabManager.editPrDescription',
} as const;

/** One entry of gh's `statusCheckRollup`: a check run or a legacy commit status. */
interface StatusCheck {
  /** Check runs: QUEUED | IN_PROGRESS | COMPLETED. */
  status?: string;
  /** Check runs: SUCCESS | FAILURE | CANCELLED | SKIPPED | …; empty while running. */
  conclusion?: string;
  /** Legacy commit statuses: SUCCESS | FAILURE | ERROR | PENDING. */
  state?: string;
}

/** A worktree's pull request, as reported by `gh pr view`. */
export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  /** The branch the PR merges into — what changed files are diffed against. */
  baseRefName: string;
  /** GitHub's merge check: MERGEABLE, CONFLICTING, or UNKNOWN (still computing). */
  mergeable: string;
  /** Every CI check on the PR's head commit. */
  statusCheckRollup: StatusCheck[] | null;
  body: string;
}

type PrLookup = { kind: 'pr'; pr: PrInfo } | { kind: 'none' } | { kind: 'no-gh' };

/**
 * Fetches the PR for the folder's current branch, resolved by `gh pr view`.
 * Throws when there is no PR or `gh` fails.
 */
async function fetchPr(cwd: string): Promise<PrInfo> {
  const stdout = await gh(
    [
      'pr',
      'view',
      '--json',
      'number,title,state,url,isDraft,baseRefName,mergeable,statusCheckRollup,body',
    ],
    cwd,
  );
  return JSON.parse(stdout) as PrInfo;
}

/** The four states a PR renders as, folding `isDraft` into `state`. */
export type PrVisualState = 'open' | 'draft' | 'merged' | 'closed';

/** Collapses gh's `state` + `isDraft` into a single presentation state. */
export function prVisualState(state: string, isDraft: boolean): PrVisualState {
  const normalized = state.toUpperCase();
  if (normalized === 'MERGED') {
    return 'merged';
  }
  if (normalized === 'CLOSED') {
    return 'closed';
  }
  return isDraft ? 'draft' : 'open';
}

// Codicon id + ThemeColor per state, matching GitHub's palette: open green,
// draft grey, merged purple, closed red. Used for the Worktrees tree rows.
const PR_TREE_ICON: Record<PrVisualState, { codicon: string; color: string }> = {
  open: { codicon: 'git-pull-request', color: 'charts.green' },
  draft: { codicon: 'git-pull-request-draft', color: 'descriptionForeground' },
  merged: { codicon: 'git-merge', color: 'charts.purple' },
  closed: { codicon: 'git-pull-request-closed', color: 'charts.red' },
};

/** A colored PR-state icon for a tree row. */
export function prThemeIcon(state: string, isDraft: boolean): vscode.ThemeIcon {
  const { codicon, color } = PR_TREE_ICON[prVisualState(state, isDraft)];
  return new vscode.ThemeIcon(codicon, new vscode.ThemeColor(color));
}

/** What the webview currently shows, kept for resolving button messages. */
interface PrViewState {
  cwd: string;
  lookup: PrLookup;
  createUrl?: string;
}

/** The `data-vscode-context` payload the "…" button's menu commands receive. */
interface PrMenuContext {
  cwd: string;
  prNumber: number;
  prTitle: string;
}

/** Description files opened for editing, keyed by fsPath — save publishes. */
type PendingEdits = Map<string, { cwd: string; number: number }>;

/** Sets up the Pull Request view, its commands, and the save-to-publish hook. */
export function registerPrView(context: vscode.ExtensionContext, store: LayoutStore): void {
  const provider = new PrWebviewProvider(store, context.extensionUri);
  const pendingEdits: PendingEdits = new Map();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('tab-manager.worktreePr', provider),
    vscode.commands.registerCommand(PR_COMMANDS.refresh, () => provider.refresh()),
    // Both are invoked from the webview's native "…" context menu, which
    // passes the button's `data-vscode-context` object as the sole argument.
    vscode.commands.registerCommand(PR_COMMANDS.editTitle, (menu: PrMenuContext) =>
      editTitle(menu.cwd, menu.prNumber, menu.prTitle, provider),
    ),
    vscode.commands.registerCommand(PR_COMMANDS.editDescription, (menu: PrMenuContext) =>
      editDescription(context, menu.cwd, menu.prNumber, pendingEdits),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      publishSavedDescription(document, pendingEdits),
    ),
  );
}

/**
 * The "Pull Request" view — a webview, because tree rows have no typography
 * control and the PR title should be big and fully wrapped. Shows the active
 * worktree's PR (looked up from its branch via `gh`) with actions to open,
 * rename, and rewrite its description.
 */
class PrWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly views = new Set<vscode.WebviewView>();
  private readonly subscription: vscode.Disposable;
  private stateSignature: string;
  private lastState: PrViewState | undefined;

  constructor(
    private readonly store: LayoutStore,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.stateSignature = this.signature();
    this.subscription = store.onDidChange(() => {
      const signature = this.signature();
      if (signature !== this.stateSignature) {
        this.stateSignature = signature;
        this.refresh();
      }
    });
  }

  private signature(): string {
    return `${this.store.activeFolderUri}`;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    view.webview.onDidReceiveMessage((message: { type: string }) => this.onMessage(message));
    void this.render();
  }

  refresh(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    if (this.views.size === 0) {
      return;
    }
    const state = await this.computeState();
    this.lastState = state;
    for (const view of this.views) {
      // VS Code's own icon font, mapped to a webview-servable URI per view.
      const codiconsUri = view.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'),
      );
      view.webview.html = renderHtml(state, codiconsUri.toString());
    }
  }

  private async computeState(): Promise<PrViewState | undefined> {
    const folderUri = this.store.activeFolderUri;
    if (!folderUri) {
      return undefined;
    }
    const cwd = vscode.Uri.parse(folderUri).fsPath;
    const lookup = await lookUpPr(cwd);
    const createUrl = lookup.kind === 'none' ? await compareUrl(cwd) : undefined;
    return { cwd, lookup, createUrl };
  }

  private onMessage(message: { type: string }): void {
    const state = this.lastState;
    if (!state) {
      return;
    }
    const pr = state.lookup.kind === 'pr' ? state.lookup.pr : undefined;
    switch (message.type) {
      case 'open':
        if (pr) {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(pr.url));
        }
        break;
      case 'create':
        if (state.createUrl) {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(state.createUrl));
        }
        break;
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

/** An inline VS Code codicon (the same icon font the editor itself uses). */
function codicon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

/** Label and color per PR state for the webview badge (icon: PR_TREE_ICON). */
const PR_WEB_BADGE: Record<PrVisualState, { label: string; color: string }> = {
  open: { label: 'Open', color: 'var(--vscode-charts-green)' },
  draft: { label: 'Draft', color: 'var(--vscode-descriptionForeground)' },
  merged: { label: 'Merged', color: 'var(--vscode-charts-purple)' },
  closed: { label: 'Closed', color: 'var(--vscode-charts-red)' },
};

function renderHtml(state: PrViewState | undefined, codiconsHref: string): string {
  let content: string;
  if (!state) {
    content = `<p class="muted">Click a worktree in the Layouts section to see its pull request.</p>`;
  } else if (state.lookup.kind === 'no-gh') {
    content = `<p class="muted">GitHub CLI (gh) not found — <code>brew install gh</code>.</p>`;
  } else if (state.lookup.kind === 'none') {
    const create = state.createUrl
      ? `<div class="actions"><button class="primary" data-cmd="create">Create PR…</button></div>`
      : '';
    content = `
      <p class="muted">No pull request for this worktree yet.</p>
      ${create}`;
  } else {
    const pr = state.lookup.pr;
    const visual = prVisualState(pr.state, pr.isDraft);
    const badge = PR_WEB_BADGE[visual];
    const mergeability = renderMergeability(pr);
    const checks = renderChecks(pr);
    // The "…" button opens a native context menu (contributed under
    // `webview/context` in package.json); its data-vscode-context payload is
    // what the menu's commands receive.
    const menuContext: PrMenuContext = { cwd: state.cwd, prNumber: pr.number, prTitle: pr.title };
    content = `
      <div class="title">${escapeHtml(pr.title)}</div>
      <div class="meta">
        <span class="state" style="color: ${badge.color}">${codicon(PR_TREE_ICON[visual].codicon)}${badge.label}</span>
        <span class="num">#${pr.number}</span>
      </div>
      ${mergeability ? `<div class="meta">${mergeability}</div>` : ''}
      ${checks ? `<div class="meta">${checks}</div>` : ''}
      <div class="actions">
        <button class="primary" data-cmd="open">Open on GitHub</button>
        <button class="icon-button" id="more" aria-label="More actions"
          data-vscode-context="${escapeHtml(JSON.stringify({ webviewSection: 'prActions', preventDefaultContextMenuItems: true, ...menuContext }))}"
        >${codicon('ellipsis')}</button>
      </div>
      <div class="description">${renderMarkdown(pr.body)}</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<link rel="stylesheet" href="${codiconsHref}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
  .title { font-size: 1.35em; font-weight: 600; line-height: 1.35; word-wrap: break-word; }
  .meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .state { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; }
  .state .codicon { font-size: 14px; }
  .num { opacity: 0.75; }
  .muted { opacity: 0.75; }
  .description { margin-top: 12px; line-height: 1.5; word-wrap: break-word; }
  .description :first-child { margin-top: 0; }
  .description :last-child { margin-bottom: 0; }
  .description h1, .description h2, .description h3 { font-size: 1.1em; }
  .description pre {
    background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 3px;
    overflow-x: auto;
  }
  .description a { color: var(--vscode-textLink-foreground); }
  .actions { margin-top: 12px; display: flex; align-items: stretch; gap: 6px; }
  .actions .primary, .actions .secondary { flex: 1; }
  button {
    border: none; padding: 5px 10px; text-align: center; cursor: pointer;
    border-radius: 2px; font-family: inherit;
  }
  button.primary {
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon-button {
    align-self: center; padding: 3px; display: flex; align-items: center; justify-content: center;
    color: var(--vscode-icon-foreground); background: transparent; border-radius: 5px;
  }
  button.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
  ${content}
  <script>
    const api = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button[data-cmd]')) {
      button.addEventListener('click', () => api.postMessage({ type: button.dataset.cmd }));
    }
    // A left-click on "…" opens the button's native context menu (VS Code
    // builds it from the data-vscode-context attribute).
    document.getElementById('more')?.addEventListener('click', (event) => {
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, clientX: event.clientX, clientY: event.clientY,
      }));
      event.stopPropagation();
    });
  </script>
</body>
</html>`;
}

/**
 * The merge-conflict indicator next to the PR state: red alert when GitHub
 * reports conflicts with the base branch, green check when clean. Empty for
 * merged/closed PRs (moot) and while GitHub is still computing (UNKNOWN).
 */
function renderMergeability(pr: PrInfo): string {
  const visual = prVisualState(pr.state, pr.isDraft);
  if (visual === 'merged' || visual === 'closed') {
    return '';
  }
  const mergeable = pr.mergeable?.toUpperCase();
  if (mergeable === 'CONFLICTING') {
    return `<span class="state" style="color: var(--vscode-charts-red)">${codicon('warning')}Conflicts with ${escapeHtml(pr.baseRefName)}</span>`;
  }
  if (mergeable === 'MERGEABLE') {
    return `<span class="state" style="color: var(--vscode-charts-green)">${codicon('check')}No conflicts</span>`;
  }
  return '';
}

// gh's per-check outcomes, folded into pass/fail; anything else (QUEUED,
// IN_PROGRESS, PENDING, EXPECTED, empty-while-running) counts as pending.
const CHECK_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAIL = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

/**
 * The CI-checks line under the merge indicator: red X when any check failed,
 * a spinner while checks are running, green check when all passed. Empty for
 * merged/closed PRs and PRs with no checks at all.
 */
function renderChecks(pr: PrInfo): string {
  const visual = prVisualState(pr.state, pr.isDraft);
  if (visual === 'merged' || visual === 'closed') {
    return '';
  }
  const rollup = pr.statusCheckRollup ?? [];
  if (rollup.length === 0) {
    return '';
  }
  let passed = 0;
  let failed = 0;
  for (const check of rollup) {
    const outcome = (check.conclusion || check.state || check.status || '').toUpperCase();
    if (CHECK_PASS.has(outcome)) {
      passed++;
    } else if (CHECK_FAIL.has(outcome)) {
      failed++;
    }
  }
  const pending = rollup.length - passed - failed;
  if (failed > 0) {
    return `<span class="state" style="color: var(--vscode-charts-red)">${codicon('x')}${failed} of ${rollup.length} checks failed</span>`;
  }
  if (pending > 0) {
    return `<span class="state" style="color: var(--vscode-charts-yellow)">${codicon('loading codicon-modifier-spin')}Checks running (${passed}/${rollup.length})</span>`;
  }
  return `<span class="state" style="color: var(--vscode-charts-green)">${codicon('check')}All checks passed</span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders a small, safe subset of GitHub-flavored markdown (headers, bold,
 * italic, inline/fenced code, links, lists) to HTML. All text is HTML-escaped
 * first, so no raw markdown input can inject markup.
 */
function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) {
    return '<p class="muted">No description.</p>';
  }

  const escaped = escapeHtml(markdown).replace(/\r\n/g, '\n');
  const inline = (text: string): string =>
    text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  const lines = escaped.split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let inCodeBlock = false;
  const codeLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push(`<ul>${list.join('')}</ul>`);
      list = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        blocks.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        codeLines.length = 0;
      } else {
        flushParagraph();
        flushList();
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (listItem) {
      flushParagraph();
      list.push(`<li>${inline(listItem[1])}</li>`);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  if (inCodeBlock && codeLines.length > 0) {
    blocks.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
  }

  return blocks.join('\n');
}

/**
 * The pull request for a worktree, for the Worktrees list. Returns undefined
 * when there's no PR (or `gh` fails); failures are logged, not surfaced,
 * since this runs speculatively for every worktree row.
 */
export async function resolveWorktreePr(cwd: string): Promise<PrInfo | undefined> {
  try {
    return await fetchPr(cwd);
  } catch (error) {
    log(`tree: pr lookup failed for ${cwd}: ${errorMessage(error)}`);
    return undefined;
  }
}

/** The repo's open PRs, for pickers. Empty on any failure (logged). */
export interface OpenPr {
  number: number;
  title: string;
  headRefName: string;
}

export async function listOpenPrs(cwd: string): Promise<OpenPr[]> {
  try {
    const stdout = await gh(
      ['pr', 'list', '--json', 'number,title,headRefName', '--limit', '100'],
      cwd,
    );
    return JSON.parse(stdout) as OpenPr[];
  } catch (error) {
    log(`pr: listing PRs failed: ${errorMessage(error)}`);
    return [];
  }
}

async function editTitle(
  cwd: string,
  prNumber: number,
  currentTitle: string,
  provider: PrWebviewProvider,
): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: `New title for PR #${prNumber}`,
    value: currentTitle,
    validateInput: (value) => (value.trim() ? undefined : 'Title cannot be empty'),
  });
  if (!title || title === currentTitle) {
    return;
  }
  try {
    await gh(['pr', 'edit', String(prNumber), '--title', title.trim()], cwd);
    vscode.window.showInformationMessage(`Renamed PR #${prNumber}.`);
    provider.refresh();
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

/**
 * Opens the PR body as a markdown file (in extension storage); every SAVE of
 * that file publishes it back to the PR via `gh pr edit --body-file`.
 */
async function editDescription(
  context: vscode.ExtensionContext,
  cwd: string,
  prNumber: number,
  pendingEdits: PendingEdits,
): Promise<void> {
  try {
    const stdout = await gh(['pr', 'view', String(prNumber), '--json', 'body'], cwd);
    const { body } = JSON.parse(stdout) as { body: string };

    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'pr-edit');
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `PR-${prNumber}.md`);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(body));

    pendingEdits.set(file.fsPath, { cwd, number: prNumber });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), {
      preview: false,
    });
    vscode.window.showInformationMessage(
      `Editing PR #${prNumber} description — save the file to publish it.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function publishSavedDescription(
  document: vscode.TextDocument,
  pendingEdits: PendingEdits,
): Promise<void> {
  const edit = pendingEdits.get(document.uri.fsPath);
  if (!edit) {
    return;
  }
  try {
    await gh(['pr', 'edit', String(edit.number), '--body-file', document.uri.fsPath], edit.cwd);
    vscode.window.showInformationMessage(`Updated PR #${edit.number} description.`);
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function lookUpPr(cwd: string): Promise<PrLookup> {
  try {
    return { kind: 'pr', pr: await fetchPr(cwd) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'no-gh' };
    }
    log(`pr: gh lookup failed: ${errorMessage(error)}`);
    return { kind: 'none' };
  }
}

/** The GitHub compare URL for the current branch — the "create a PR" page. */
async function compareUrl(cwd: string): Promise<string | undefined> {
  try {
    const branch = (await git(['branch', '--show-current'], cwd)).trim();
    if (!branch) {
      return undefined;
    }
    const stdout = await gh(['repo', 'view', '--json', 'url'], cwd);
    const { url } = JSON.parse(stdout) as { url: string };
    return `${url}/compare/${encodeURIComponent(branch)}?expand=1`;
  } catch {
    return undefined;
  }
}
