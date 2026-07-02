import * as vscode from 'vscode';
import { folderName, registerCommands } from './commands';
import { PICK_COMPARE_BRANCH, registerFileCommands } from './fileCommands';
import { FilesTreeProvider, isFilterRow } from './filesTree';
import { registerPrView } from './pr';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { LayoutTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const store = new LayoutStore(context.workspaceState);
  const terminals = new TerminalManager(context.globalStorageUri);

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
    filesView.onDidChangeCheckboxState(async (event) => {
      for (const [element, state] of event.items) {
        if (!isFilterRow(element)) {
          continue;
        }
        const enable = state === vscode.TreeItemCheckboxState.Checked;
        if (enable && !store.compareBranch) {
          await vscode.commands.executeCommand(PICK_COMPARE_BRANCH);
          if (!store.compareBranch) {
            filesProvider.refresh(); // picker cancelled — snap the checkbox back
            continue;
          }
        }
        await store.setFilesFilterEnabled(enable);
      }
    }),
    vscode.window.registerTreeDataProvider('tab-manager.layouts', layoutsProvider)
  );

  registerCommands(context, store, terminals, () => layoutsProvider.refresh());
  registerFileCommands(context, store);
  registerPrView(context, store);
}

export function deactivate(): void {}
