import * as vscode from 'vscode';

/**
 * Whether to collapse the bottom panel after a layout switch, per the
 * `tabManager.hidePanelOnSwitch` setting (declared in package.json). Read
 * live from VS Code configuration — the user sets this in Settings, not
 * through the sidebar.
 */
export function hidePanelOnSwitch(): boolean {
  return vscode.workspace.getConfiguration('tabManager').get<boolean>('hidePanelOnSwitch', true);
}
