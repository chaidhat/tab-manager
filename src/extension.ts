import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { registerPrView } from './pr';
import { ReadMarkStore } from './readMarks';
import { rememberOpenRepos } from './repos';
import { RootWorktreeManager, WorktreeRowDecorationProvider } from './rootWorktreeManager';
import { SessionMonitor } from './sessionMonitor';
import { LayoutStore } from './store';
import { ChangedFileDecorationProvider, SubWorktreeManager } from './subWorktreeManager';
import { isSubWorktreeWindow } from './worktrees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new LayoutStore(context.workspaceState);
  // Which changed files have been read is per repository and pull request, not
  // per window, so it lives in global storage — loaded before the views render
  // so the first paint already shows the ticks.
  const marks = new ReadMarkStore(context.globalStorageUri);
  await marks.load();
  const rootManager = new RootWorktreeManager(store);
  const subManager = new SubWorktreeManager(store, marks);
  const sessionMonitor = new SessionMonitor();

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
    // manageCheckboxStateManually: the "read" ticks are ours to persist (per
    // repository and pull request), so VS Code must not remember them itself.
    const filesView = vscode.window.createTreeView('tab-manager.subWorktreeFiles', {
      treeDataProvider: subManager,
      manageCheckboxStateManually: true,
    });
    subManager.attachView(filesView);
    context.subscriptions.push(filesView);
  }

  // Like the Files view, createTreeView rather than registerTreeDataProvider:
  // the monitor needs the view handle to put the waiting-session count on the
  // activity-bar icon.
  const sessionsView = vscode.window.createTreeView('tab-manager.claudeSessions', {
    treeDataProvider: sessionMonitor,
  });
  sessionMonitor.attachView(sessionsView);
  context.subscriptions.push(sessionsView);

  // The Root Worktree Manager's repository list is global (VS Code settings),
  // so every window lists the same repositories — and a window opening on a
  // worktree is what puts that worktree's repository on the list.
  void rememberOpenRepos();

  context.subscriptions.push(
    store,
    marks,
    rootManager,
    subManager,
    sessionMonitor,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rememberOpenRepos()),
    vscode.window.registerFileDecorationProvider(new ChangedFileDecorationProvider()),
    vscode.window.registerFileDecorationProvider(new WorktreeRowDecorationProvider()),
    vscode.window.registerTreeDataProvider('tab-manager.rootWorktrees', rootManager),
    // The Files view's title toggle — one of the two shows at a time, gated
    // on the tabManager.filesExpanded context key.
    vscode.commands.registerCommand('tabManager.filesExpandAll', () =>
      subManager.setExpandAll(true),
    ),
    vscode.commands.registerCommand('tabManager.filesCollapseAll', () =>
      subManager.setExpandAll(false),
    ),
    // Show only files not yet marked read, and back again — one of the two
    // shows at a time, gated on the tabManager.filesUnreviewedOnly context key.
    vscode.commands.registerCommand('tabManager.filesShowUnreviewedOnly', () =>
      subManager.setUnreviewedOnly(true),
    ),
    vscode.commands.registerCommand('tabManager.filesShowAll', () =>
      subManager.setUnreviewedOnly(false),
    ),
    // The Root Worktree Manager view's title refresh — drops the PR/branch
    // caches so rows re-query gh and pick up merged/renamed PRs.
    vscode.commands.registerCommand('tabManager.refreshWorktrees', () => rootManager.refresh()),
  );

  registerCommands(context, () => rootManager.refresh());
  registerFileCommands(context, store);
  const refreshPr = registerPrView(context, store);

  // The Sub Worktree Manager's refresh. It sits on the Pull Request view's
  // title because that is the topmost row an extension can contribute an icon
  // to — the container header is reserved for built-in views — so it refreshes
  // both panes rather than only the one it is rendered on.
  context.subscriptions.push(
    vscode.commands.registerCommand('tabManager.refreshSubWorktree', () => {
      refreshPr();
      subManager.refresh();
    }),
  );
}

export function deactivate(): void {}
