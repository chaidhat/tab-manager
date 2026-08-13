import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { resolveWorktreePr } from './pr';
import { addConfiguredRepos, removeConfiguredRepo } from './repos';
import type { BranchElement, RepoSection } from './rootWorktreeManager';
import {
  addWorktree,
  addWorktreeForPr,
  BranchInUseError,
  currentBranch,
  discoverClaudeWorktrees,
  forgetWorktree,
  removeWorktree,
  repoRootOf,
} from './worktrees';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  openWindow: 'tabManager.openWorktreeWindow',
  copyPath: 'tabManager.copyWorktreePath',
  newWorktreeBlank: 'tabManager.newWorktreeBlank',
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
  // The repo row's inline "+". Creating a worktree for a pull request has its
  // own way in: clicking the PR's row in the tree.
  register(COMMANDS.newWorktreeBlank, (section: RepoSection) =>
    createNewWorktree(section, refreshWorktrees),
  );
  // What clicking a pull request that has no worktree yet runs: create the
  // worktree, then open it, so the click lands in the same place as a click on
  // a row whose worktree already exists.
  register(COMMANDS.newWorktreeForPr, (repoRoot: string, prNumber: number) =>
    createWorktreeForPr(repoRoot, prNumber, refreshWorktrees),
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
 * Creates the worktree for one pull request, named after its number under
 * `.claude/worktrees/` with the PR's branch checked out, and opens it — this
 * is what clicking a pull request row that has no worktree does, and the click
 * is a request to *go there*, same as on a row that already has one.
 */
async function createWorktreeForPr(
  repoRoot: string,
  prNumber: number,
  refreshWorktrees: () => void,
): Promise<void> {
  const worktreePath = await createPrWorktree(repoRoot, prNumber);
  if (worktreePath === undefined) {
    return;
  }

  refreshWorktrees();
  // The window opening is the confirmation — a notification on top of it would
  // just be in the way.
  await vscode.commands.executeCommand(
    COMMANDS.openWindow,
    vscode.Uri.file(worktreePath).toString(),
  );
}

/**
 * The creation itself, with the one recoverable failure handled: a branch can
 * only be checked out in one worktree at a time, so when another worktree
 * already holds the PR's branch this asks whether to let go of that worktree
 * and, if so, tries once more. Returns the new worktree's path, or undefined
 * when it wasn't created — the failure is shown to the user either way.
 */
async function createPrWorktree(repoRoot: string, prNumber: number): Promise<string | undefined> {
  try {
    return await creatingWorktree(repoRoot, prNumber);
  } catch (error) {
    if (!(error instanceof BranchInUseError)) {
      vscode.window.showErrorMessage(errorMessage(error));
      return undefined;
    }
    if (!(await releaseBranch(repoRoot, error))) {
      return undefined;
    }
  }

  // Only reached once the branch is free — a single retry, so a checkout that
  // keeps failing reports itself instead of asking again.
  try {
    return await creatingWorktree(repoRoot, prNumber);
  } catch (error) {
    vscode.window.showErrorMessage(errorMessage(error));
    return undefined;
  }
}

function creatingWorktree(repoRoot: string, prNumber: number): Thenable<string> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating worktree for #${prNumber}…`,
    },
    () => addWorktreeForPr(repoRoot, prNumber),
  );
}

/**
 * Asks whether to give up the worktree standing in the way of a branch, and
 * does it. Returns whether the branch is now free.
 *
 * Three worktrees can hold a branch and each needs its own answer: the
 * repository's own checkout, which is not ours to delete; one git still lists
 * after its folder was deleted, where there is nothing left to trash and only
 * the bookkeeping to drop; and a real worktree, which goes to the Trash the
 * same way "Delete Worktree" sends one.
 */
async function releaseBranch(repoRoot: string, conflict: BranchInUseError): Promise<boolean> {
  const holderPath = conflict.holder.path;
  const name = path.basename(holderPath);

  if (holderPath === repoRoot) {
    vscode.window.showErrorMessage(
      `Branch "${conflict.branch}" is checked out in the repository itself (${holderPath}) — switch it to another branch first.`,
    );
    return false;
  }
  if (isWorkspaceFolder(vscode.Uri.file(holderPath).toString())) {
    vscode.window.showWarningMessage(
      `Branch "${conflict.branch}" is checked out in "${name}", which is open in this workspace — remove it from the workspace first.`,
    );
    return false;
  }

  if (conflict.holder.stale) {
    const choice = await vscode.window.showWarningMessage(
      `Git still lists a worktree holding branch "${conflict.branch}", but its folder is gone.`,
      {
        modal: true,
        detail: `${holderPath}\n\nUnregister it so the branch can be checked out here?`,
      },
      'Unregister',
    );
    if (choice !== 'Unregister') {
      return false;
    }
    try {
      await forgetWorktree(repoRoot, holderPath);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(errorMessage(error));
      return false;
    }
  }

  const choice = await vscode.window.showWarningMessage(
    `Branch "${conflict.branch}" is already checked out in the worktree "${name}".`,
    {
      modal: true,
      detail: `${holderPath}\n\nDelete that worktree — moving it to the Trash — and create this one instead?`,
    },
    'Delete Worktree',
  );
  if (choice !== 'Delete Worktree') {
    return false;
  }
  return trashWorktree(name, holderPath);
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
  if (isWorkspaceFolder(worktree.folderUri)) {
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
  if (!(await trashWorktree(worktree.name, folderPath))) {
    return;
  }

  refreshWorktrees();
  vscode.window.showInformationMessage(`Moved worktree "${worktree.name}" to the Trash.`);
}

/**
 * Moves a worktree to the Trash, and when git refuses because it has changes,
 * asks the second, explicit question — quoting git's refusal — before forcing
 * it. Returns whether the worktree is gone; a failure is shown to the user.
 */
async function trashWorktree(name: string, folderPath: string): Promise<boolean> {
  try {
    await moveToTrash(name, folderPath, false);
    return true;
  } catch (error) {
    const force = await vscode.window.showWarningMessage(
      `Git refused to delete "${name}".`,
      { modal: true, detail: `${errorMessage(error)}\n\nForce delete and discard its changes?` },
      'Force Delete',
    );
    if (force !== 'Force Delete') {
      return false;
    }
    try {
      await moveToTrash(name, folderPath, true);
      return true;
    } catch (forceError) {
      vscode.window.showErrorMessage(errorMessage(forceError));
      return false;
    }
  }
}

/** Whether a folder is one this window has open — deleting those breaks the workspace. */
function isWorkspaceFolder(folderUri: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (folder) => folder.uri.toString() === folderUri,
  );
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
