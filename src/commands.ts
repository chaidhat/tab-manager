import * as vscode from 'vscode';
import {
  applyLayout,
  captureCurrentLayout,
  clearEditorArea,
  describeLayout,
  owningFolderUri,
} from './layout';
import { log } from './log';
import { hidePanelOnSwitch } from './settings';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import type { RepoSection } from './tree';
import { WorktreeElement } from './types';
import { addWorktree, removeWorktree } from './worktrees';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  save: 'tabManager.saveLayout',
  apply: 'tabManager.applyLayout',
  clear: 'tabManager.clearLayout',
  deleteWorktree: 'tabManager.deleteWorktree',
  copyPath: 'tabManager.copyWorktreePath',
  newWorktree: 'tabManager.newWorktree',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  store: LayoutStore,
  terminals: TerminalManager,
  refreshWorktrees: () => void
): void {
  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  // Switches are serialized with latest-wins coalescing: a click during an
  // in-flight switch queues its target (replacing any earlier queued one)
  // instead of overlapping two teardown/restore choreographies.
  let queuedTarget: string | undefined;
  let switching = false;
  const requestSwitch = async (folderUri: string): Promise<void> => {
    queuedTarget = folderUri;
    if (switching) {
      return;
    }
    switching = true;
    try {
      while (queuedTarget !== undefined) {
        const target = queuedTarget;
        queuedTarget = undefined;
        await switchToWorktree(store, terminals, target);
      }
    } finally {
      switching = false;
    }
  };

  register(COMMANDS.save, () => saveCurrentArrangement(store));
  register(COMMANDS.apply, (folderUri: string) => requestSwitch(folderUri));
  register(COMMANDS.clear, (worktree: WorktreeElement) => clearWorktreeLayout(store, worktree));
  register(COMMANDS.deleteWorktree, (worktree: WorktreeElement) =>
    deleteWorktree(store, worktree)
  );
  register(COMMANDS.copyPath, (worktree: WorktreeElement) =>
    vscode.env.clipboard.writeText(vscode.Uri.parse(worktree.folderUri).fsPath)
  );
  register(COMMANDS.newWorktree, (section: RepoSection) =>
    newWorktree(section, refreshWorktrees)
  );
}

/**
 * Saves the current arrangement into the active worktree's slot. With no
 * active worktree yet, the owning worktree is inferred from the open files.
 */
async function saveCurrentArrangement(store: LayoutStore): Promise<void> {
  const captured = await captureCurrentLayout();
  const target = store.activeFolderUri ?? owningFolderUri(captured);
  if (!target) {
    vscode.window.showInformationMessage(
      'Open a file from one of the worktrees (or click a worktree in the list) first.'
    );
    return;
  }

  await store.saveLayout(target, captured);
  if (store.activeFolderUri !== target) {
    await store.setActive(target);
  }
  vscode.window.showInformationMessage(`Saved layout for "${folderName(target)}".`);
}

/**
 * The core "auto-save & swap": saves the current arrangement into the worktree
 * you're leaving, then loads the clicked worktree's layout. A worktree without
 * a saved layout starts blank (no panes) rather than keeping whatever was open
 * before — arrange it and switch away to save a layout for it.
 */
async function switchToWorktree(
  store: LayoutStore,
  terminals: TerminalManager,
  folderUri: string
): Promise<void> {
  if (store.activeFolderUri === folderUri) {
    return;
  }

  const captured = await captureCurrentLayout();
  // No active worktree yet (first use): file the arrangement under the
  // worktree its files belong to, so it isn't lost when the target applies.
  const previous = store.activeFolderUri ?? owningFolderUri(captured);
  log(`switch → ${folderName(folderUri)}: saving ${previous ? folderName(previous) : '(none)'} ← ${describeLayout(captured)}`);
  if (previous === folderUri) {
    // Activating the worktree that owns the current files adopts the
    // arrangement as its layout — clearing to blank here would destroy it.
    await store.saveLayout(folderUri, captured);
    await store.setActive(folderUri);
    return;
  }
  if (previous) {
    await store.saveLayout(previous, captured);
  }

  await store.setActive(folderUri);
  const saved = store.getLayout(folderUri);
  log(
    saved
      ? `switch → ${folderName(folderUri)}: applying ${describeLayout(saved)}`
      : `switch → ${folderName(folderUri)}: no saved layout, going blank`
  );
  if (saved) {
    const result = await applyLayout(saved, terminals, {
      outgoingFolderUri: previous,
      targetFolderUri: folderUri,
      hidePanelAfter: hidePanelOnSwitch(),
    });
    warnIfMissing(result.missing);
  } else {
    await clearEditorArea(terminals, {
      outgoingFolderUri: previous,
      hidePanelAfter: hidePanelOnSwitch(),
    });
  }
}

/**
 * Creates a worktree for the repo under `.claude/worktrees/<name>`, on a new
 * branch of the same name, and refreshes the sidebar so it appears.
 */
async function newWorktree(section: RepoSection, refreshWorktrees: () => void): Promise<void> {
  if (!section.repoRoot) {
    return;
  }
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
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Deletes the git worktree itself — directory and all. Modal-confirmed; a
 * dirty worktree gets a second, explicit force confirmation quoting git's
 * refusal. Open workspace folders never get this action (menu-gated), since
 * deleting a folder out from under the workspace breaks it.
 */
async function deleteWorktree(store: LayoutStore, worktree: WorktreeElement): Promise<void> {
  if (worktree.isOpen) {
    vscode.window.showWarningMessage(
      'This worktree is open in the workspace — remove it from the workspace first.'
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete the worktree "${worktree.name}" and its files?`,
    { modal: true, detail: 'Runs `git worktree remove`. This deletes the directory.' },
    'Delete'
  );
  if (choice !== 'Delete') {
    return;
  }

  const folderPath = vscode.Uri.parse(worktree.folderUri).fsPath;
  try {
    await removeWorktree(folderPath, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const force = await vscode.window.showWarningMessage(
      `Git refused to delete "${worktree.name}".`,
      { modal: true, detail: `${message}\n\nForce delete and discard its changes?` },
      'Force Delete'
    );
    if (force !== 'Force Delete') {
      return;
    }
    try {
      await removeWorktree(folderPath, true);
    } catch (forceError) {
      vscode.window.showErrorMessage(
        forceError instanceof Error ? forceError.message : String(forceError)
      );
      return;
    }
  }

  await store.clearLayout(worktree.folderUri);
  if (store.activeFolderUri === worktree.folderUri) {
    await store.setActive(undefined);
  }
  vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}".`);
}

async function clearWorktreeLayout(store: LayoutStore, worktree: WorktreeElement): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Clear the saved layout for "${worktree.name}"?`,
    { modal: true },
    'Clear'
  );
  if (choice === 'Clear') {
    await store.clearLayout(worktree.folderUri);
  }
}

export function folderName(folderUri: string): string {
  const uri = vscode.Uri.parse(folderUri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  // Falls back to the path's last segment for a discovered worktree that
  // isn't an open workspace folder.
  return folder?.name ?? uri.path.split('/').filter(Boolean).pop() ?? folderUri;
}

function warnIfMissing(missing: string[]): void {
  if (missing.length === 0) {
    return;
  }
  const names = missing.map((uri) => vscode.Uri.parse(uri).path.split('/').pop()).join(', ');
  vscode.window.showWarningMessage(
    `Some files couldn't be reopened (they may have been moved or deleted): ${names}`
  );
}
