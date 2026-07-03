import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage, gh, git } from './cli';
import { log } from './log';
import { LayoutStore } from './store';
import { WorktreeElement } from './types';

const PR_COMMANDS = {
  refresh: 'tabManager.refreshPr',
  link: 'tabManager.linkPr',
  editTitle: 'tabManager.editPrTitle',
  editDescription: 'tabManager.editPrDescription',
} as const;

/** A worktree's pull request, as reported by `gh pr view`. */
export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  /** The branch the PR merges into — what changed files are diffed against. */
  baseRefName: string;
  body: string;
}

type PrLookup = { kind: 'pr'; pr: PrInfo } | { kind: 'none' } | { kind: 'no-gh' };

/**
 * Fetches the PR for a folder: the linked PR by number if one is given,
 * otherwise the PR for the folder's current branch. Throws when there is no
 * PR or `gh` fails.
 */
async function fetchPr(cwd: string, linkedNumber: number | undefined): Promise<PrInfo> {
  const selector = linkedNumber !== undefined ? [String(linkedNumber)] : [];
  const stdout = await gh(
    ['pr', 'view', ...selector, '--json', 'number,title,state,url,isDraft,baseRefName,body'],
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
  folderUri: string;
  cwd: string;
  lookup: PrLookup;
  createUrl?: string;
}

/** Description files opened for editing, keyed by fsPath — save publishes. */
type PendingEdits = Map<string, { cwd: string; number: number }>;

/** Sets up the Pull Request view, its commands, and the save-to-publish hook. */
export function registerPrView(context: vscode.ExtensionContext, store: LayoutStore): void {
  const provider = new PrWebviewProvider(store);
  const pendingEdits: PendingEdits = new Map();

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider('tab-manager.worktreePr', provider),
    vscode.commands.registerCommand(PR_COMMANDS.refresh, () => provider.refresh()),
    vscode.commands.registerCommand(PR_COMMANDS.link, (worktree: WorktreeElement) =>
      linkPr(store, worktree),
    ),
    vscode.commands.registerCommand(
      PR_COMMANDS.editTitle,
      (folderUri: string, cwd: string, prNumber: number, currentTitle: string) =>
        editTitle(store, folderUri, cwd, prNumber, currentTitle, provider),
    ),
    vscode.commands.registerCommand(PR_COMMANDS.editDescription, (cwd: string, prNumber: number) =>
      editDescription(context, cwd, prNumber, pendingEdits),
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      publishSavedDescription(document, pendingEdits),
    ),
  );
}

/**
 * The "Pull Request" view — a webview, because tree rows have no typography
 * control and the PR title should be big and fully wrapped. Shows the active
 * worktree's PR (manually linked via "Link with PR…", else looked up from
 * the branch) with actions to open, rename, and rewrite its description.
 */
class PrWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly views = new Set<vscode.WebviewView>();
  private readonly subscription: vscode.Disposable;
  private stateSignature: string;
  private lastState: PrViewState | undefined;

  constructor(private readonly store: LayoutStore) {
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
    const active = this.store.activeFolderUri;
    const linked = active ? this.store.linkedPr(active) : undefined;
    return `${active}|${linked?.number}|${linked?.title}`;
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
    const html = renderHtml(state);
    for (const view of this.views) {
      view.webview.html = html;
    }
  }

  private async computeState(): Promise<PrViewState | undefined> {
    const folderUri = this.store.activeFolderUri;
    if (!folderUri) {
      return undefined;
    }
    const cwd = vscode.Uri.parse(folderUri).fsPath;
    const lookup = await lookUpPr(cwd, this.store.linkedPr(folderUri)?.number);
    if (lookup.kind === 'pr' && this.store.linkedPr(folderUri)?.number === lookup.pr.number) {
      // Keep the Layouts row (which displays the linked PR's title) fresh.
      void this.store.setLinkedPrTitle(folderUri, lookup.pr.title);
    }
    const createUrl = lookup.kind === 'none' ? await compareUrl(cwd) : undefined;
    return { folderUri, cwd, lookup, createUrl };
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
      case 'rename':
        if (pr) {
          void vscode.commands.executeCommand(
            PR_COMMANDS.editTitle,
            state.folderUri,
            state.cwd,
            pr.number,
            pr.title,
          );
        }
        break;
      case 'edit-description':
        if (pr) {
          void vscode.commands.executeCommand(PR_COMMANDS.editDescription, state.cwd, pr.number);
        }
        break;
      case 'create':
        if (state.createUrl) {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(state.createUrl));
        }
        break;
      case 'link': {
        const worktree: WorktreeElement = {
          folderUri: state.folderUri,
          name: path.basename(state.cwd),
          isOpen: true,
          isRoot: false,
        };
        void vscode.commands.executeCommand(PR_COMMANDS.link, worktree);
        break;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

// GitHub octicons (16px), colored to match the tree icons via VS Code's chart
// CSS variables so the badge tracks the active theme.
const SVG_OPEN =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>';
const SVG_DRAFT =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0ZM12.75 3a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z"/></svg>';
const SVG_MERGED =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z"/></svg>';
const SVG_CLOSED =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
// Codicon "gear" (16px), used for the PR view's overflow-actions button.
const SVG_GEAR =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.5v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2 4l2-2 2.1 1.4L6.6 1h2.8zM8 10.9c1.6 0 2.9-1.3 2.9-2.9S9.6 5.1 8 5.1 5.1 6.4 5.1 8s1.3 2.9 2.9 2.9z"/></svg>';

/** Icon, label, and color per PR state for the webview badge. */
const PR_WEB_BADGE: Record<PrVisualState, { label: string; color: string; svg: string }> = {
  open: { label: 'Open', color: 'var(--vscode-charts-green)', svg: SVG_OPEN },
  draft: { label: 'Draft', color: 'var(--vscode-descriptionForeground)', svg: SVG_DRAFT },
  merged: { label: 'Merged', color: 'var(--vscode-charts-purple)', svg: SVG_MERGED },
  closed: { label: 'Closed', color: 'var(--vscode-charts-red)', svg: SVG_CLOSED },
};

function renderHtml(state: PrViewState | undefined): string {
  let content: string;
  if (!state) {
    content = `<p class="muted">Click a worktree in the Layouts section to see its pull request.</p>`;
  } else if (state.lookup.kind === 'no-gh') {
    content = `<p class="muted">GitHub CLI (gh) not found — <code>brew install gh</code>.</p>`;
  } else if (state.lookup.kind === 'none') {
    const create = state.createUrl ? `<button class="secondary" data-cmd="create">Create PR…</button>` : '';
    content = `
      <p class="muted">No pull request for this worktree yet.</p>
      <div class="actions">
        <button class="primary" data-cmd="link">Link to PR…</button>
        ${create}
      </div>`;
  } else {
    const pr = state.lookup.pr;
    const badge = PR_WEB_BADGE[prVisualState(pr.state, pr.isDraft)];
    content = `
      <div class="title">${escapeHtml(pr.title)}</div>
      <div class="meta">
        <span class="state" style="color: ${badge.color}">${badge.svg}${badge.label}</span>
        <span class="num">#${pr.number}</span>
      </div>
      <div class="actions">
        <button class="primary" data-cmd="open">Open on GitHub</button>
        <div class="menu">
          <button class="icon-button" id="settings-toggle" aria-label="More actions" aria-haspopup="true">${SVG_GEAR}</button>
          <div class="dropdown" id="settings-dropdown" hidden>
            <button class="dropdown-item" data-cmd="rename">Rename…</button>
            <button class="dropdown-item" data-cmd="edit-description">Edit description…</button>
          </div>
        </div>
      </div>
      <div class="description">${renderMarkdown(pr.body)}</div>`;
  }

  return `<!DOCTYPE html>
<html>
<head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
  .title { font-size: 1.35em; font-weight: 600; line-height: 1.35; word-wrap: break-word; }
  .meta { margin-top: 6px; display: flex; align-items: center; gap: 8px; }
  .state { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; }
  .state svg { width: 14px; height: 14px; fill: currentColor; }
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
  .actions .primary { flex: 1; }
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
  .menu { position: relative; }
  button.icon-button {
    height: 100%; padding: 5px 6px; display: flex; align-items: center; justify-content: center;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button.icon-button:hover, button.icon-button.active { background: var(--vscode-button-secondaryHoverBackground); }
  button.icon-button svg { width: 14px; height: 14px; fill: currentColor; }
  .dropdown {
    position: absolute; top: calc(100% + 4px); right: 0; z-index: 1; min-width: 160px;
    background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border); border-radius: 3px; padding: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); display: flex; flex-direction: column; gap: 2px;
  }
  button.dropdown-item {
    background: transparent; color: inherit; text-align: left; padding: 4px 8px; border-radius: 2px;
  }
  button.dropdown-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
  ${content}
  <script>
    const api = acquireVsCodeApi();
    const toggle = document.getElementById('settings-toggle');
    const dropdown = document.getElementById('settings-dropdown');
    const closeDropdown = () => {
      if (dropdown) {
        dropdown.hidden = true;
        toggle?.classList.remove('active');
      }
    };
    toggle?.addEventListener('click', (event) => {
      event.stopPropagation();
      dropdown.hidden = !dropdown.hidden;
      toggle.classList.toggle('active', !dropdown.hidden);
    });
    document.addEventListener('click', closeDropdown);
    for (const button of document.querySelectorAll('button[data-cmd]')) {
      button.addEventListener('click', () => api.postMessage({ type: button.dataset.cmd }));
    }
  </script>
</body>
</html>`;
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
export async function resolveWorktreePr(
  cwd: string,
  linkedNumber: number | undefined,
): Promise<PrInfo | undefined> {
  try {
    return await fetchPr(cwd, linkedNumber);
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

/** Right-click "Link with PR…": pick from open PRs, type a number, or unlink. */
async function linkPr(store: LayoutStore, worktree: WorktreeElement): Promise<void> {
  if (worktree.isRoot) {
    vscode.window.showWarningMessage("The repo's main checkout can't be linked to a PR.");
    return;
  }
  const cwd = vscode.Uri.parse(worktree.folderUri).fsPath;
  const current = store.linkedPr(worktree.folderUri);

  const ENTER_NUMBER = '$(edit) Enter a PR number…';
  const UNLINK = `$(x) Unlink PR #${current?.number}`;
  const picks: vscode.QuickPickItem[] = (await listOpenPrs(cwd)).map((pr) => ({
    label: `#${pr.number} ${pr.title}`,
    description: pr.headRefName,
  }));
  const extras: vscode.QuickPickItem[] = [{ label: ENTER_NUMBER }];
  if (current !== undefined) {
    extras.push({ label: UNLINK });
  }

  const choice = await vscode.window.showQuickPick([...picks, ...extras], {
    placeHolder: `Link "${worktree.name}" with a pull request`,
    matchOnDescription: true,
  });
  if (!choice) {
    return;
  }

  if (choice.label === UNLINK) {
    await store.setLinkedPr(worktree.folderUri, undefined);
    return;
  }
  let prNumber: number | undefined;
  let prTitle: string | undefined;
  if (choice.label === ENTER_NUMBER) {
    const input = await vscode.window.showInputBox({
      prompt: 'Pull request number',
      validateInput: (value) => (/^\d+$/.test(value.trim()) ? undefined : 'Enter a number'),
    });
    prNumber = input ? Number(input.trim()) : undefined;
    // Title is backfilled by the Pull Request view on its next lookup.
  } else {
    prNumber = Number(/^#(\d+)/.exec(choice.label)?.[1]);
    prTitle = choice.label.replace(/^#\d+\s*/, '');
  }
  if (prNumber === undefined || Number.isNaN(prNumber)) {
    return;
  }
  const conflictingFolderUri = store.folderLinkedToPr(prNumber, worktree.folderUri);
  if (conflictingFolderUri !== undefined) {
    const conflictingName = path.basename(vscode.Uri.parse(conflictingFolderUri).fsPath);
    vscode.window.showWarningMessage(
      `PR #${prNumber} is already linked to "${conflictingName}". Unlink it there first.`,
    );
    return;
  }
  await store.setLinkedPr(worktree.folderUri, { number: prNumber, title: prTitle });
  vscode.window.showInformationMessage(`Linked "${worktree.name}" with PR #${prNumber}.`);
}

async function editTitle(
  store: LayoutStore,
  folderUri: string,
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
    if (store.linkedPr(folderUri)?.number === prNumber) {
      await store.setLinkedPrTitle(folderUri, title.trim());
    }
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

async function lookUpPr(cwd: string, linkedNumber: number | undefined): Promise<PrLookup> {
  try {
    return { kind: 'pr', pr: await fetchPr(cwd, linkedNumber) };
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
