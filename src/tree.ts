import * as vscode from 'vscode';
import { COMMANDS } from './commands';
import { LayoutStore } from './store';
import { Layout } from './types';

/** Renders the saved layouts as a flat, clickable list in the sidebar. */
export class LayoutTreeProvider implements vscode.TreeDataProvider<Layout>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: LayoutStore) {
    this.subscription = store.onDidChange(() => this.emitter.fire());
  }

  getChildren(element?: Layout): Layout[] {
    return element ? [] : this.store.list();
  }

  getTreeItem(layout: Layout): vscode.TreeItem {
    const isActive = layout.id === this.store.activeId;
    const item = new vscode.TreeItem(layout.name, vscode.TreeItemCollapsibleState.None);

    item.id = layout.id;
    item.contextValue = 'layout';
    item.description = isActive ? '● active' : undefined;
    item.tooltip = `Apply "${layout.name}"`;
    item.iconPath = new vscode.ThemeIcon(
      'layout',
      isActive ? new vscode.ThemeColor('list.highlightForeground') : undefined
    );
    item.command = {
      command: COMMANDS.apply,
      title: 'Apply Layout',
      arguments: [layout.id],
    };

    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
