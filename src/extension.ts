import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('tab-manager.helloWorld', () => {
    const panel = vscode.window.createWebviewPanel(
      'tabManagerHelloWorld',
      'Hello World',
      vscode.ViewColumn.Active,
      {}
    );
    panel.webview.html = `<!DOCTYPE html>
<html>
  <body>
    <h1>Hello World</h1>
  </body>
</html>`;
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
