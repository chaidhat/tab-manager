import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { listOpenPrs, resolveWorktreePr } from './pr';
import { addConfiguredRepos, removeConfiguredRepo } from './repos';
import type { BranchElement, RepoSection } from './rootWorktreeManager';
import {
  addWorktree,
  addWorktreeForPr,
  currentBranch,
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
  newWorktreeForPr: 'tabManager.newWorktreeForPr',
  deleteWorktree: 'tabManager.deleteWorktree',
  switchWorktree: 'tabManager.switchWorktree',
  addRepository: 'tabManager.addRepository',
  removeRepository: 'tabManager.removeRepository',
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
  register(COMMANDS.copyPath, (row: BranchElement) => {
    if (row.folderUri) {
      return vscode.env.clipboard.writeText(vscode.Uri.parse(row.folderUri).fsPath);
    }
  });
  // Both live in the repo row's "+" dropdown (a native submenu, contributed
  // in package.json), so each command is one flavor — no chooser step.
  register(COMMANDS.newWorktreeBlank, (section: RepoSection) =>
    createNewWorktree(section, refreshWorktrees),
  );
  register(COMMANDS.newWorktreeFromPr, (section: RepoSection) =>
    createWorktreeFromPr(section, refreshWorktrees),
  );
  // What clicking a pull request that has no worktree yet runs: create the
  // worktree, then open it, so the click lands in the same place as a click on
  // a row whose worktree already exists.
  register(COMMANDS.newWorktreeForPr, (repoRoot: string, prNumber: number) =>
    createWorktreeForPr(repoRoot, prNumber, refreshWorktrees, true),
  );
  register(COMMANDS.deleteWorktree, (row: BranchElement) => deleteWorktree(row, refreshWorktrees));
  register(COMMANDS.switchWorktree, () => switchWorktree());
  // Both edit the saved repository list; the view re-renders off the resulting
  // settings change, so neither refreshes it itself.
  register(COMMANDS.addRepository, () => addRepository());
  register(COMMANDS.removeRepository, (section: RepoSection) => removeRepository(section));
}

/**
 * Adds one or more repositories to the Root Worktree Manager, so their
 * worktrees are listed without their folders being open in this window. The
 * pick is resolved to the repository root, so choosing a worktree (or the repo
 * itself) both land on the same entry.
 */
async function addRepository(): Promise<void> {
  const picks = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Add Repository',
    title: 'Add a repository to the Root Worktree Manager',
  });
  if (!picks || picks.length === 0) {
    return;
  }

  const repoRoots: string[] = [];
  const notRepos: string[] = [];
  for (const pick of picks) {
    const repoRoot = await repoRootOf(pick);
    if (repoRoot === undefined) {
      notRepos.push(path.basename(pick.fsPath));
    } else {
      repoRoots.push(repoRoot);
    }
  }

  const added = await addConfiguredRepos(repoRoots);
  if (notRepos.length > 0) {
    vscode.window.showWarningMessage(`Not a git repository: ${notRepos.join(', ')}.`);
  }
  if (added.length > 0) {
    vscode.window.showInformationMessage(
      `Added ${added.map((repoRoot) => path.basename(repoRoot)).join(', ')} to the Root Worktree Manager.`,
    );
  } else if (repoRoots.length > 0) {
    vscode.window.showInformationMessage('Already in the Root Worktree Manager.');
  }
}

/**
 * Drops a repository from the saved list, in this window and every other one.
 * Nothing on disk is touched — and since the list is what windows add
 * themselves to, opening one of the repository's folders puts it back.
 */
async function removeRepository(section: RepoSection): Promise<void> {
  if (!section?.repoRoot) {
    return;
  }
  await removeConfiguredRepo(section.repoRoot);
}

/**
 * Picks another of the super-repo's worktrees and opens it in its own new
 * window — the same thing clicking a worktree row in the Root Worktree Manager
 * view does. That window activates as a sub-worktree window, so its Pull
 * Request and Files Changed views show the picked worktree.
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
  // Each row shows the worktree's PR (via the same branch-based `gh` lookup the
  // Root Worktree Manager's rows use), falling back to the branch when there's
  // no PR. Passing the promise keeps the quick pick open with a busy bar while
  // gh resolves.
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
  section: RepoSection,
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
  section: RepoSection,
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
  await createWorktreeForPr(section.repoRoot, pick.pr.number, refreshWorktrees, false);
}

/**
 * Creates the worktree for one pull request, named after its number under
 * `.claude/worktrees/` with the PR's branch checked out.
 *
 * `openWindow` is what separates the two callers: clicking a pull request row
 * is a request to *go there*, so it opens the new worktree's window the way
 * clicking a row that already has one does, while the "New Worktree from PR"
 * picker only creates it and leaves the user where they were.
 */
async function createWorktreeForPr(
  repoRoot: string,
  prNumber: number,
  refreshWorktrees: () => void,
  openWindow: boolean,
): Promise<void> {
  let worktreePath: string;
  try {
    worktreePath = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating worktree for #${prNumber}…`,
      },
      () => addWorktreeForPr(repoRoot, prNumber),
    );
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
    return;
  }

  refreshWorktrees();
  if (openWindow) {
    // The window opening is the confirmation — a notification on top of it
    // would just be in the way.
    await vscode.commands.executeCommand(
      COMMANDS.openWindow,
      vscode.Uri.file(worktreePath).toString(),
    );
    return;
  }
  vscode.window.showInformationMessage(
    `Created worktree "${prNumber}" with PR #${prNumber} checked out.`,
  );
}

/**
 * Moves the git worktree to the OS trash and unregisters it. Modal-confirmed;
 * a dirty worktree gets a second, explicit force confirmation quoting git's
 * refusal. Open workspace folders never get this action (menu-gated), since
 * deleting a folder out from under the workspace breaks it.
 *
 * Finishes in one step with nothing left running: the trash move is a rename,
 * so even a worktree carrying `node_modules` is gone in milliseconds, and the
 * files sit recoverable in the trash until the user empties it.
 */
async function deleteWorktree(
  worktree: BranchElement,
  refreshWorktrees: () => void,
): Promise<void> {
  if (!worktree.folderUri) {
    return; // a pull request with no worktree — nothing to delete
  }
  const isOpen = (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.toString() === worktree.folderUri,
  );
  if (isOpen) {
    vscode.window.showWarningMessage(
      'This worktree is open in the workspace — remove it from the workspace first.',
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete the worktree "${worktree.name}"?`,
    { modal: true, detail: 'Moves it to the Trash, where it stays until you empty it.' },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  const folderPath = vscode.Uri.parse(worktree.folderUri).fsPath;
  try {
    await moveToTrash(worktree.name, folderPath, false);
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
      await moveToTrash(worktree.name, folderPath, true);
    } catch (forceError) {
      vscode.window.showErrorMessage(errorMessage(forceError));
      return;
    }
  }

  refreshWorktrees();
  vscode.window.showInformationMessage(`Moved worktree "${worktree.name}" to the Trash.`);
}

/**
 * The removal itself, under a progress notification. Usually a few hundred
 * milliseconds — dominated by the uncommitted-changes check, not the move —
 * but a cold filesystem can make that noticeable, and a delete that appears to
 * do nothing reads as broken.
 */
function moveToTrash(name: string, folderPath: string, force: boolean): Thenable<void> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `${force ? 'Force-deleting' : 'Deleting'} worktree "${name}"…`,
    },
    () => removeWorktree(folderPath, force),
  );
}

export function folderName(folderUri: string): string {
  const uri = vscode.Uri.parse(folderUri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Falls back to the path's last segment for a discovered worktree that
  // isn't an open workspace folder.
  return folder?.name ?? uri.path.split('/').filter(Boolean).pop() ?? folderUri;
}
