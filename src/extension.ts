import * as vscode from 'vscode';
import { folderName, registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { FilesTreeProvider } from './filesTree';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { LayoutTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const store = new LayoutStore(context.workspaceState);
  const terminals = new TerminalManager();

  const layoutsProvider = new LayoutTreeProvider(store);
  const filesProvider = new FilesTreeProvider(store);
  const filesView = vscode.window.createTreeView('tab-manager.files', {
    treeDataProvider: filesProvider,
  });
  const updateFilesDescription = () => {
    filesView.description = store.activeFolderUri ? folderName(store.activeFolderUri) : undefined;
  };
  updateFilesDescription();

  context.subscriptions.push(
    store,
    layoutsProvider,
    filesProvider,
    filesView,
    store.onDidChange(updateFilesDescription),
    vscode.window.registerTreeDataProvider('tab-manager.layouts', layoutsProvider)
  );

  registerCommands(context, store, terminals);
  registerFileCommands(context, store);
}

export function deactivate(): void {}
