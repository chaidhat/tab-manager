import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { registerPrView } from './pr';
import { RootWorktreeManager } from './rootWorktreeManager';
import { LayoutStore } from './store';
import { ChangedFileDecorationProvider, SubWorktreeManager } from './subWorktreeManager';
import { isSubWorktreeWindow } from './worktrees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new LayoutStore(context.workspaceState);
  const rootManager = new RootWorktreeManager(store);
  const subManager = new SubWorktreeManager(store);

  // A window opened at a `.claude/worktrees/<name>` folder additionally gets
  // the dedicated Sub Worktree Manager container, whose views target that
  // folder. The Root Worktree Manager container stays alongside it in every
  // window, so the worktree list is one activity-bar click away from a
  // worktree window too.
  // The context key has to land before the sub views are created: a view whose
  // `when` is false is not in the registry yet, and registering against it
  // fails with "No view is registered with id".
  const isSubWorktree = await isSubWorktreeWindow();
  await vscode.commands.executeCommand('setContext', 'tabManager.isSubWorktree', isSubWorktree);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (isSubWorktree && folder && !store.activeFolderUri) {
    await store.setActive(folder.uri.toString());
  }

  if (isSubWorktree) {
    // createTreeView (not registerTreeDataProvider) so the provider can retitle
    // the view with the changed-file count.
    const filesView = vscode.window.createTreeView('tab-manager.subWorktreeFiles', {
      treeDataProvider: subManager,
    });
    subManager.attachView(filesView);
    context.subscriptions.push(filesView);
  }

  context.subscriptions.push(
    store,
    rootManager,
    subManager,
    vscode.window.registerFileDecorationProvider(new ChangedFileDecorationProvider()),
    vscode.window.registerTreeDataProvider('tab-manager.rootWorktrees', rootManager),
    // The Files view's title toggle — one of the two shows at a time, gated
    // on the tabManager.filesExpanded context key.
    vscode.commands.registerCommand('tabManager.filesExpandAll', () =>
      subManager.setExpandAll(true),
    ),
    vscode.commands.registerCommand('tabManager.filesCollapseAll', () =>
      subManager.setExpandAll(false),
    ),
    // The Root Worktree Manager view's title refresh — drops the PR/branch
    // caches so rows re-query gh and pick up merged/renamed PRs.
    vscode.commands.registerCommand('tabManager.refreshWorktrees', () => rootManager.refresh()),
  );

  registerCommands(context, () => rootManager.refresh());
  registerFileCommands(context, store);
  registerPrView(context, store);
}

export function deactivate(): void {}
