import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { FilesTreeProvider } from './filesTree';
import { registerPrView } from './pr';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { LayoutTreeProvider } from './tree';
import { isChildWorktreeWindow } from './worktrees';

export function activate(context: vscode.ExtensionContext): void {
  const store = new LayoutStore(context.workspaceState);
  const terminals = new TerminalManager(context.globalStorageUri);

  const layoutsProvider = new LayoutTreeProvider(store);
  // The child-worktree container's Files view: diff mode locked on.
  const changedFilesProvider = new FilesTreeProvider(store, true);

  // A window opened at a linked worktree gets the dedicated container (the
  // regular one hides); its views target the (single) workspace folder.
  void isChildWorktreeWindow().then(async (isChild) => {
    await vscode.commands.executeCommand('setContext', 'tabManager.isChildWorktree', isChild);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (isChild && folder && !store.activeFolderUri) {
      await store.setActive(folder.uri.toString());
    }
  });
  context.subscriptions.push(
    store,
    layoutsProvider,
    changedFilesProvider,
    vscode.window.registerTreeDataProvider('tab-manager.worktreeFiles', changedFilesProvider),
    vscode.window.registerTreeDataProvider('tab-manager.layouts', layoutsProvider)
  );

  registerCommands(context, store, terminals, () => layoutsProvider.refresh());
  registerFileCommands(context, store);
  registerPrView(context, store);
}

export function deactivate(): void {}
