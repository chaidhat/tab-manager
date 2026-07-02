import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { FilesTreeProvider } from './filesTree';
import { registerPrView } from './pr';
import { LayoutStore } from './store';
import { LayoutTreeProvider } from './tree';
import { isChildWorktreeWindow } from './worktrees';

export function activate(context: vscode.ExtensionContext): void {
  const store = new LayoutStore(context.workspaceState);
  const worktreesProvider = new LayoutTreeProvider(store);
  const changedFilesProvider = new FilesTreeProvider(store);

  // A window opened at a `.claude/worktrees/<name>` folder gets the dedicated
  // Worktree container (the hub one hides); its views target that folder.
  void isChildWorktreeWindow().then(async (isChild) => {
    await vscode.commands.executeCommand('setContext', 'tabManager.isChildWorktree', isChild);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (isChild && folder && !store.activeFolderUri) {
      await store.setActive(folder.uri.toString());
    }
  });

  context.subscriptions.push(
    store,
    worktreesProvider,
    changedFilesProvider,
    vscode.window.registerTreeDataProvider('tab-manager.worktreeFiles', changedFilesProvider),
    vscode.window.registerTreeDataProvider('tab-manager.layouts', worktreesProvider),
  );

  registerCommands(context, store, () => worktreesProvider.refresh());
  registerFileCommands(context, store);
  registerPrView(context, store);
}

export function deactivate(): void {}
