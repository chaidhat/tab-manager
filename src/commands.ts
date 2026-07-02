import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { listOpenPrs } from './pr';
import { LayoutStore } from './store';
import type { RepoSection } from './tree';
import { WorktreeElement } from './types';
import { addWorktree, addWorktreeForPr, removeWorktree } from './worktrees';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  openWindow: 'tabManager.openWorktreeWindow',
  copyPath: 'tabManager.copyWorktreePath',
  newWorktree: 'tabManager.newWorktree',
  deleteWorktree: 'tabManager.deleteWorktree',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  store: LayoutStore,
  refreshWorktrees: () => void,
): void {
  const register = (id: string, handler: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register(COMMANDS.openWindow, (folderUri: string) => {
    log(`open window: ${folderName(folderUri)}`);
    return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(folderUri), {
      forceNewWindow: true,
    });
  });
  register(COMMANDS.copyPath, (worktree: WorktreeElement) =>
    vscode.env.clipboard.writeText(vscode.Uri.parse(worktree.folderUri).fsPath),
  );
  register(COMMANDS.newWorktree, (section: RepoSection) =>
    newWorktree(store, section, refreshWorktrees),
  );
  register(COMMANDS.deleteWorktree, (worktree: WorktreeElement) =>
    deleteWorktree(store, worktree, refreshWorktrees),
  );
}

/** The repo row's "+": choose between a fresh worktree and one from a PR. */
async function newWorktree(
  store: LayoutStore,
  section: RepoSection,
  refreshWorktrees: () => void,
): Promise<void> {
  const repoRoot = section.repoRoot;
  if (!repoRoot) {
    return;
  }
  const CREATE_NEW = 'Create New Worktree…';
  const FROM_PR = 'Create From PR…';
  const mode = await vscode.window.showQuickPick([CREATE_NEW, FROM_PR], {
    placeHolder: `Add a worktree to ${section.label}`,
  });
  if (mode === CREATE_NEW) {
    await createNewWorktree({ ...section, repoRoot }, refreshWorktrees);
  } else if (mode === FROM_PR) {
    await createWorktreeFromPr(store, { ...section, repoRoot }, refreshWorktrees);
  }
}

/**
 * Creates a worktree for the repo under `.claude/worktrees/<name>`, on a new
 * branch of the same name, and refreshes the sidebar so it appears.
 */
async function createNewWorktree(
  section: RepoSection & { repoRoot: string },
  refreshWorktrees: () => void,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: `New worktree for ${section.label} (also the branch name)`,
    placeHolder: 'my-feature',
    validateInput: (value) =>
      /^[\w][\w./-]*$/.test(value.trim()) ? undefined : 'Use letters, digits, ., /, - or _',
  });
  if (!name) {
    return;
  }

  try {
    await addWorktree(section.repoRoot, name.trim());
    refreshWorktrees();
    vscode.window.showInformationMessage(`Created worktree "${name.trim()}" in ${section.label}.`);
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

/**
 * Picks (searchably) one of the repo's open PRs, creates a worktree named
 * after its number with the PR's branch checked out, and links it to the PR
 * so its row shows the PR title.
 */
async function createWorktreeFromPr(
  store: LayoutStore,
  section: RepoSection & { repoRoot: string },
  refreshWorktrees: () => void,
): Promise<void> {
  const prs = await listOpenPrs(section.repoRoot);
  if (prs.length === 0) {
    vscode.window.showInformationMessage(
      `No open pull requests found for ${section.label} (is the GitHub CLI signed in?).`,
    );
    return;
  }

  const pick = await vscode.window.showQuickPick(
    prs.map((pr) => ({ label: `#${pr.number} ${pr.title}`, description: pr.headRefName, pr })),
    { placeHolder: 'Search a pull request…', matchOnDescription: true },
  );
  if (!pick) {
    return;
  }

  try {
    const worktreePath = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating worktree for #${pick.pr.number}…`,
      },
      () => addWorktreeForPr(section.repoRoot, pick.pr.number),
    );
    await store.setLinkedPr(vscode.Uri.file(worktreePath).toString(), {
      number: pick.pr.number,
      title: pick.pr.title,
    });
    refreshWorktrees();
    vscode.window.showInformationMessage(
      `Created worktree "${pick.pr.number}" with PR #${pick.pr.number} checked out.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
  }
}

/**
 * Deletes the git worktree itself — directory and all. Modal-confirmed; a
 * dirty worktree gets a second, explicit force confirmation quoting git's
 * refusal. Open workspace folders never get this action (menu-gated), since
 * deleting a folder out from under the workspace breaks it.
 */
async function deleteWorktree(
  store: LayoutStore,
  worktree: WorktreeElement,
  refreshWorktrees: () => void,
): Promise<void> {
  if (worktree.isOpen) {
    vscode.window.showWarningMessage(
      'This worktree is open in the workspace — remove it from the workspace first.',
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete the worktree "${worktree.name}" and its files?`,
    { modal: true, detail: 'Runs `git worktree remove`. This deletes the directory.' },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  const folderPath = vscode.Uri.parse(worktree.folderUri).fsPath;
  try {
    await removeWorktree(folderPath, false);
  } catch (error) {
    const force = await vscode.window.showWarningMessage(
      `Git refused to delete "${worktree.name}".`,
      { modal: true, detail: `${errorMessage(error)}\n\nForce delete and discard its changes?` },
      'Force Delete',
    );
    if (force !== 'Force Delete') {
      return;
    }
    try {
      await removeWorktree(folderPath, true);
    } catch (forceError) {
      vscode.window.showErrorMessage(errorMessage(forceError));
      return;
    }
  }

  await store.setLinkedPr(worktree.folderUri, undefined);
  refreshWorktrees();
  vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}".`);
}

export function folderName(folderUri: string): string {
  const uri = vscode.Uri.parse(folderUri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Falls back to the path's last segment for a discovered worktree that
  // isn't an open workspace folder.
  return folder?.name ?? uri.path.split('/').filter(Boolean).pop() ?? folderUri;
}
