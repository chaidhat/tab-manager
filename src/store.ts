import * as vscode from 'vscode';

const ACTIVE_KEY = 'tabManager.activeWorktree';
// Older versions stored manually-linked PR numbers here; PRs are now always
// resolved from the worktree's branch via `gh`, so stale data is cleared.
const DEPRECATED_LINKED_PRS_KEY = 'tabManager.linkedPrs';

/**
 * Per-workspace state: which worktree this window targets (set in child
 * worktree windows). Emits {@link onDidChange} whenever the data changes so
 * views can refresh.
 */
export class LayoutStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    void memento.update(DEPRECATED_LINKED_PRS_KEY, undefined);
  }

  /** The worktree this window's PR/files views target. */
  get activeFolderUri(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  async setActive(folderUri: string | undefined): Promise<void> {
    await this.memento.update(ACTIVE_KEY, folderUri);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
