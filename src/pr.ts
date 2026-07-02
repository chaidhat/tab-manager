import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { log } from './log';
import { LayoutStore } from './store';
import { WorktreeElement } from './types';

const run = promisify(execFile);

/**
 * macOS GUI apps don't inherit a shell PATH, so `gh` (Homebrew) is often not
 * findable by name from the extension host — try well-known locations too.
 */
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

const PR_COMMANDS = {
  refresh: 'tabManager.refreshPr',
  link: 'tabManager.linkPr',
  editTitle: 'tabManager.editPrTitle',
  editDescription: 'tabManager.editPrDescription',
} as const;

interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
}

type PrLookup = { kind: 'pr'; pr: PrInfo } | { kind: 'none' } | { kind: 'no-gh' };

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
      linkPr(store, worktree)
    ),
    vscode.commands.registerCommand(
      PR_COMMANDS.editTitle,
      (folderUri: string, cwd: string, prNumber: number, currentTitle: string) =>
        editTitle(store, folderUri, cwd, prNumber, currentTitle, provider)
    ),
    vscode.commands.registerCommand(PR_COMMANDS.editDescription, (cwd: string, prNumber: number) =>
      editDescription(context, cwd, prNumber, pendingEdits)
    ),
    vscode.workspace.onDidSaveTextDocument((document) =>
      publishSavedDescription(document, pendingEdits)
    )
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
            pr.title
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
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

function renderHtml(state: PrViewState | undefined): string {
  let content: string;
  if (!state) {
    content = `<p class="muted">Click a worktree in the Layouts section to see its pull request.</p>`;
  } else if (state.lookup.kind === 'no-gh') {
    content = `<p class="muted">GitHub CLI (gh) not found — <code>brew install gh</code>.</p>`;
  } else if (state.lookup.kind === 'none') {
    const create = state.createUrl
      ? `<button data-cmd="create">Create PR on GitHub…</button>`
      : '';
    content = `<p class="muted">No pull request — right-click a worktree to link one.</p>${create}`;
  } else {
    const pr = state.lookup.pr;
    const badge = pr.isDraft ? `${pr.state} · draft` : pr.state;
    content = `
      <div class="title">${escapeHtml(pr.title)}</div>
      <div class="meta">#${pr.number} · ${escapeHtml(badge)}</div>
      <div class="actions">
        <button data-cmd="open">Open on GitHub</button>
        <button data-cmd="rename">Rename…</button>
        <button data-cmd="edit-description">Edit description…</button>
      </div>`;
  }

  return `<!DOCTYPE html>
<html>
<head><style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 12px; }
  .title { font-size: 1.35em; font-weight: 600; line-height: 1.35; word-wrap: break-word; }
  .meta { margin-top: 4px; opacity: 0.75; }
  .muted { opacity: 0.75; }
  .actions { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  button {
    border: none; padding: 5px 10px; text-align: center; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    border-radius: 2px; font-family: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
  ${content}
  <script>
    const api = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button')) {
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

/** Right-click "Link with PR…": pick from open PRs, type a number, or unlink. */
async function linkPr(store: LayoutStore, worktree: WorktreeElement): Promise<void> {
  const cwd = vscode.Uri.parse(worktree.folderUri).fsPath;
  const current = store.linkedPr(worktree.folderUri);

  const ENTER_NUMBER = '$(edit) Enter a PR number…';
  const UNLINK = `$(x) Unlink PR #${current?.number}`;
  let picks: vscode.QuickPickItem[] = [];
  try {
    const stdout = await gh(
      ['pr', 'list', '--json', 'number,title,headRefName', '--limit', '100'],
      cwd
    );
    const prs = JSON.parse(stdout) as { number: number; title: string; headRefName: string }[];
    picks = prs.map((pr) => ({ label: `#${pr.number} ${pr.title}`, description: pr.headRefName }));
  } catch (error) {
    log(`pr: listing PRs failed: ${String(error)}`);
  }
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
  await store.setLinkedPr(worktree.folderUri, { number: prNumber, title: prTitle });
  vscode.window.showInformationMessage(`Linked "${worktree.name}" with PR #${prNumber}.`);
}

async function editTitle(
  store: LayoutStore,
  folderUri: string,
  cwd: string,
  prNumber: number,
  currentTitle: string,
  provider: PrWebviewProvider
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
    vscode.window.showErrorMessage(ghErrorMessage(error));
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
  pendingEdits: PendingEdits
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
      `Editing PR #${prNumber} description — save the file to publish it.`
    );
  } catch (error) {
    vscode.window.showErrorMessage(ghErrorMessage(error));
  }
}

async function publishSavedDescription(
  document: vscode.TextDocument,
  pendingEdits: PendingEdits
): Promise<void> {
  const edit = pendingEdits.get(document.uri.fsPath);
  if (!edit) {
    return;
  }
  try {
    await gh(
      ['pr', 'edit', String(edit.number), '--body-file', document.uri.fsPath],
      edit.cwd
    );
    vscode.window.showInformationMessage(`Updated PR #${edit.number} description.`);
  } catch (error) {
    vscode.window.showErrorMessage(ghErrorMessage(error));
  }
}

async function lookUpPr(cwd: string, linkedNumber: number | undefined): Promise<PrLookup> {
  try {
    const selector = linkedNumber !== undefined ? [String(linkedNumber)] : [];
    const stdout = await gh(
      ['pr', 'view', ...selector, '--json', 'number,title,state,url,isDraft'],
      cwd
    );
    return { kind: 'pr', pr: JSON.parse(stdout) as PrInfo };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'no-gh' };
    }
    log(`pr: gh lookup failed: ${ghErrorMessage(error)}`);
    return { kind: 'none' };
  }
}

async function compareUrl(cwd: string): Promise<string | undefined> {
  try {
    const { stdout: branchOut } = await run('git', ['branch', '--show-current'], { cwd });
    const branch = branchOut.trim();
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

function openUrlCommand(url: string): vscode.Command {
  return { command: 'vscode.open', title: 'Open on GitHub', arguments: [vscode.Uri.parse(url)] };
}

async function gh(args: string[], cwd: string): Promise<string> {
  let lastError: unknown;
  for (const bin of GH_CANDIDATES) {
    try {
      const { stdout } = await run(bin, args, { cwd });
      return stdout;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // try the next location
      }
      throw error;
    }
  }
  throw lastError;
}

function ghErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  return stderr?.trim() || (error instanceof Error ? error.message : String(error));
}
