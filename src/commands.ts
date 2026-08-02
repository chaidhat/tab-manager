import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { listOpenPrs, resolveWorktreePr } from './pr';
import type { RepoSection } from './rootWorktreeManager';
import { WorktreeElement } from './types';
import {
  addWorktree,
  addWorktreeForPr,
  currentBranch,
  deleteTrashedWorktree,
  discoverClaudeWorktrees,
  removeWorktree,
  repoRootOf,
} from './worktrees';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  openWindow: 'tabManager.openWorktreeWindow',
  copyPath: 'tabManager.copyWorktreePath',
  newWorktreeBlank: 'tabManager.newWorktreeBlank',
  newWorktreeFromPr: 'tabManager.newWorktreeFromPr',
  deleteWorktree: 'tabManager.deleteWorktree',
  switchWorktree: 'tabManager.switchWorktree',
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
  register(COMMANDS.switchWorktree, () => switchWorktree());
}

/**
 * Picks another of the super-repo's worktrees and opens it in its own new
 * window — the same thing clicking a worktree row in the root window's Worktrees view does. That
 * window activates as a sub-worktree window, so its Pull Request and Files
 * Changed views show the picked worktree.
 */
async function switchWorktree(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('No workspace folder open.');
    return;
  }
  const repoRoot = await repoRootOf(folder.uri);
  if (!repoRoot) {
    vscode.window.showWarningMessage('The active folder is not inside a git repository.');
    return;
  }

  const worktrees = await discoverClaudeWorktrees(repoRoot);
  if (worktrees.length === 0) {
    vscode.window.showInformationMessage('No worktrees found under .claude/worktrees.');
    return;
  }

  const currentPath = folder.uri.fsPath;
  // Each row shows the worktree's PR (via the same branch-based `gh` lookup
  // the root Worktrees rows use), falling back to the branch when there's no PR. Passing
  // the promise keeps the quick pick open with a busy bar while gh resolves.
  const items = Promise.all(
    worktrees.map(async (worktree) => {
      const cwd = worktree.uri.fsPath;
      const pr = await resolveWorktreePr(cwd);
      const description = pr ? `#${pr.number} ${pr.title}` : ((await currentBranch(cwd)) ?? '');
      return {
        label: worktree.name,
        description,
        detail: cwd === currentPath ? 'This window' : undefined,
        uri: worktree.uri,
      };
    }),
  );
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open another worktree in a new window…',
    matchOnDescription: true,
  });
  if (!pick || pick.uri.fsPath === currentPath) {
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', pick.uri, { forceNewWindow: true });
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
 *
 * Two steps, each with its own progress notification, because they differ by
 * orders of magnitude: unregistering moves the directory aside and takes
 * milliseconds, while unlinking the files it moved takes seconds on a worktree
 * with `node_modules`. The row disappears after the first, so the slow half
 * runs with the tree already correct.
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
    {
      modal: true,
      detail: 'The worktree is unregistered right away; its files delete in the background.',
    },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  const folderPath = vscode.Uri.parse(worktree.folderUri).fsPath;
  let trashPath: string;
  try {
    trashPath = await unregister(worktree.name, folderPath, false);
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
      trashPath = await unregister(worktree.name, folderPath, true);
    } catch (forceError) {
      vscode.window.showErrorMessage(errorMessage(forceError));
      return;
    }
  }

  // Git has forgotten the worktree and its directory is out of the discovered
  // path, so the row can go now — the files outlive it by a few seconds.
  refreshWorktrees();
  await deleteTrashedFiles(worktree.name, trashPath);
}

/** Step one: unregister and move aside, under a progress notification. */
function unregister(name: string, folderPath: string, force: boolean): Thenable<string> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${force ? 'Force-deleting' : 'Deleting'} worktree "${name}"…`,
    },
    () => removeWorktree(folderPath, force),
  );
}

/**
 * Step two: unlink the moved files. A failure here leaves disk in use but the
 * worktree genuinely deleted, so it reports as a leak to clean up rather than
 * as a delete that didn't happen.
 */
async function deleteTrashedFiles(name: string, trashPath: string): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Deleting worktree "${name}" — removing files…`,
    },
    async () => {
      try {
        await deleteTrashedWorktree(trashPath);
        vscode.window.showInformationMessage(`Deleted worktree "${name}".`);
      } catch (error) {
        log(`delete worktree: leftover files at ${trashPath}: ${errorMessage(error)}`);
        vscode.window.showWarningMessage(
          `Deleted worktree "${name}", but its files are still on disk at ${trashPath}: ${errorMessage(error)}`,
        );
      }
    },
  );
}

export function folderName(folderUri: string): string {
  const uri = vscode.Uri.parse(folderUri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Falls back to the path's last segment for a discovered worktree that
  // isn't an open workspace folder.
  return folder?.name ?? uri.path.split('/').filter(Boolean).pop() ?? folderUri;
}
