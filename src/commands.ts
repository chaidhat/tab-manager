import * as vscode from 'vscode';
import { applyLayout, captureCurrentLayout } from './layout';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { Layout } from './types';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
export const COMMANDS = {
  save: 'tabManager.saveLayout',
  apply: 'tabManager.applyLayout',
  update: 'tabManager.updateLayout',
  rename: 'tabManager.renameLayout',
  delete: 'tabManager.deleteLayout',
} as const;

export function registerCommands(
  context: vscode.ExtensionContext,
  store: LayoutStore,
  terminals: TerminalManager
): void {
  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register(COMMANDS.save, () => saveLayout(store));
  register(COMMANDS.apply, (id: string) => switchToLayout(store, terminals, id));
  register(COMMANDS.update, (layout: Layout) => updateLayout(store, layout));
  register(COMMANDS.rename, (layout: Layout) => renameLayout(store, layout));
  register(COMMANDS.delete, (layout: Layout) => deleteLayout(store, layout));
}

/** Snapshots the current arrangement as a new, active layout. */
async function saveLayout(store: LayoutStore): Promise<void> {
  await store.add(await captureCurrentLayout());
}

/**
 * The core "auto-save & swap": saves the current arrangement back into the
 * active layout, then loads the clicked one. Each button therefore keeps its
 * own arrangement as you click between them.
 */
async function switchToLayout(
  store: LayoutStore,
  terminals: TerminalManager,
  id: string
): Promise<void> {
  const target = store.get(id);
  if (!target || store.activeId === id) {
    return;
  }

  const previousId = store.activeId;
  if (previousId && store.get(previousId)) {
    await store.update(previousId, await captureCurrentLayout());
  }

  await store.setActive(id);
  warnIfMissing((await applyLayout(target, terminals)).missing);
}

/** Overwrites a layout with the current arrangement. */
async function updateLayout(store: LayoutStore, layout: Layout): Promise<void> {
  await store.update(layout.id, await captureCurrentLayout());
  vscode.window.showInformationMessage(`Updated "${layout.name}".`);
}

async function renameLayout(store: LayoutStore, layout: Layout): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Rename layout',
    value: layout.name,
    validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty'),
  });
  if (name?.trim()) {
    await store.rename(layout.id, name.trim());
  }
}

async function deleteLayout(store: LayoutStore, layout: Layout): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Delete "${layout.name}"?`,
    { modal: true },
    'Delete'
  );
  if (choice === 'Delete') {
    await store.remove(layout.id);
  }
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
