import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Tab Manager');

/** Diagnostic log — visible via Output panel → "Tab Manager". */
export function log(message: string): void {
  channel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${message}`);
}
