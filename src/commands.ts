import * as vscode from 'vscode';
import { applyLayout, captureCurrentLayout, clearEditorArea, owningFolderUri } from './layout';
import { hidePanelOnSwitch } from './settings';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { WorktreeElement } from './types';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  save: 'tabManager.saveLayout',
  apply: 'tabManager.applyLayout',
  clear: 'tabManager.clearLayout',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  store: LayoutStore,
  terminals: TerminalManager
): void {
  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register(COMMANDS.save, () => saveCurrentArrangement(store));
  register(COMMANDS.apply, (folderUri: string) => switchToWorktree(store, terminals, folderUri));
  register(COMMANDS.clear, (worktree: WorktreeElement) => clearWorktreeLayout(store, worktree));
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
