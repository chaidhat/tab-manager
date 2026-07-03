import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { listOpenPrs } from './pr';
import type { RepoSection } from './tree';
import { WorktreeElement } from './types';
import { addWorktree, addWorktreeForPr, removeWorktree } from './worktrees';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  openWindow: 'tabManager.openWorktreeWindow',
  copyPath: 'tabManager.copyWorktreePath',
  newWorktreeBlank: 'tabManager.newWorktreeBlank',
  newWorktreeFromPr: 'tabManager.newWorktreeFromPr',
  deleteWorktree: 'tabManager.deleteWorktree',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
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
  // Both live in the repo row's "+" dropdown (a native submenu, contributed
  // in package.json), so each command is one flavor — no chooser step.
  register(COMMANDS.newWorktreeBlank, (section: RepoSection) => {
    if (section.repoRoot) {
      return createNewWorktree({ ...section, repoRoot: section.repoRoot }, refreshWorktrees);
    }
  });
  register(COMMANDS.newWorktreeFromPr, (section: RepoSection) => {
    if (section.repoRoot) {
      return createWorktreeFromPr({ ...section, repoRoot: section.repoRoot }, refreshWorktrees);
    }
  });
  register(COMMANDS.deleteWorktree, (worktree: WorktreeElement) =>
    deleteWorktree(worktree, refreshWorktrees),
  );
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
 * Picks (searchably) one of the repo's open PRs and creates a worktree named
 * after its number with the PR's branch checked out — the row then shows the
 * PR title via the branch-based `gh` lookup.
 */
async function createWorktreeFromPr(
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
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating worktree for #${pick.pr.number}…`,
      },
      () => addWorktreeForPr(section.repoRoot, pick.pr.number),
    );
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
