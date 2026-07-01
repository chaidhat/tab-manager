import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { LayoutStore } from './store';
import { TerminalManager } from './terminals';
import { LayoutTreeProvider } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const store = new LayoutStore(context.workspaceState);
  const provider = new LayoutTreeProvider(store);
  const terminals = new TerminalManager();

  context.subscriptions.push(
    store,
    provider,
    vscode.window.registerTreeDataProvider('tab-manager.layouts', provider)
  );

  registerCommands(context, store, terminals);
}

export function deactivate(): void {}
