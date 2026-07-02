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

/** One row in the Pull Request view. */
interface PrRow {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly command?: vscode.Command;
}

/** Description files opened for editing, keyed by fsPath — save publishes. */
type PendingEdits = Map<string, { cwd: string; number: number }>;

/** Sets up the Pull Request view, its commands, and the save-to-publish hook. */
export function registerPrView(context: vscode.ExtensionContext, store: LayoutStore): void {
  const provider = new PrTreeProvider(store);
  const pendingEdits: PendingEdits = new Map();

  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider('tab-manager.pr', provider),
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
 * The "Pull Request" view: the active worktree's PR — manually linked via
 * "Link with PR…" on the worktree, else looked up from the branch — with
 * rows to rename it and rewrite its description.
 */
class PrTreeProvider implements vscode.TreeDataProvider<PrRow>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private stateSignature: string;

  constructor(private readonly store: LayoutStore) {
    this.stateSignature = this.signature();
    this.subscription = store.onDidChange(() => {
      const signature = this.signature();
      if (signature !== this.stateSignature) {
        this.stateSignature = signature;
        this.emitter.fire();
      }
    });
  }

  private signature(): string {
    const active = this.store.activeFolderUri;
    const linked = active ? this.store.linkedPr(active) : undefined;
    return `${active}|${linked?.number}|${linked?.title}`;
  }

  refresh(): void {
    this.emitter.fire();
  }

  async getChildren(element?: PrRow): Promise<PrRow[]> {
    const folderUri = this.store.activeFolderUri;
    if (element || !folderUri) {
      return []; // leaf rows; no active worktree → welcome content shows
    }
    const cwd = vscode.Uri.parse(folderUri).fsPath;

    const lookup = await lookUpPr(cwd, this.store.linkedPr(folderUri)?.number);
    if (lookup.kind === 'no-gh') {
      return [{ label: 'GitHub CLI (gh) not found', description: 'brew install gh' }];
    }
    if (lookup.kind === 'none') {
      const rows: PrRow[] = [
        { label: 'No pull request', description: 'right-click a worktree to link one' },
      ];
      const url = await compareUrl(cwd);
      if (url) {
        rows.push({
          label: 'Create PR on GitHub…',
          tooltip: 'Open GitHub compare view for this branch',
          command: openUrlCommand(url),
        });
      }
      return rows;
    }

    const { pr } = lookup;
    // Keep the Layouts row (which displays the linked PR's title) fresh.
    if (this.store.linkedPr(folderUri)?.number === pr.number) {
      void this.store.setLinkedPrTitle(folderUri, pr.title);
    }
    return [
      {
        label: `#${pr.number} ${pr.title}`,
        description: pr.isDraft ? `${pr.state} · draft` : pr.state,
        tooltip: 'Open the pull request on GitHub',
        command: openUrlCommand(pr.url),
      },
      {
        label: 'Rename PR…',
        tooltip: 'Change the pull request title',
        command: {
          command: PR_COMMANDS.editTitle,
          title: 'Rename PR',
          arguments: [folderUri, cwd, pr.number, pr.title],
        },
      },
      {
        label: 'Edit description…',
        tooltip: 'Opens the description as markdown — save (⌘S) to publish it to the PR',
        command: {
          command: PR_COMMANDS.editDescription,
          title: 'Edit PR Description',
          arguments: [cwd, pr.number],
        },
      },
    ];
  }

  getTreeItem(row: PrRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.command = row.command;
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
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
  provider: PrTreeProvider
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
