import * as vscode from 'vscode';
import { CapturedLayout } from './types';

const LAYOUTS_KEY = 'tabManager.worktreeLayouts';
const ACTIVE_KEY = 'tabManager.activeWorktree';

/**
 * Persists one layout per worktree (workspace folder), keyed by folder URI,
 * plus which worktree is active. Lives in workspace state because layouts
 * reference this workspace's files. Emits {@link onDidChange} whenever the
 * data changes so the tree view can refresh.
 */
export class LayoutStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  getLayout(folderUri: string): CapturedLayout | undefined {
    return this.layouts()[folderUri];
  }

  hasLayout(folderUri: string): boolean {
    return folderUri in this.layouts();
  }

  /** The worktree whose slot the current arrangement is saved into on switch. */
  get activeFolderUri(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  async saveLayout(folderUri: string, layout: CapturedLayout): Promise<void> {
    await this.memento.update(LAYOUTS_KEY, { ...this.layouts(), [folderUri]: layout });
    this.emitter.fire();
  }

  async clearLayout(folderUri: string): Promise<void> {
    const { [folderUri]: _removed, ...rest } = this.layouts();
    await this.memento.update(LAYOUTS_KEY, rest);
    this.emitter.fire();
  }

  async setActive(folderUri: string | undefined): Promise<void> {
    await this.memento.update(ACTIVE_KEY, folderUri);
    this.emitter.fire();
  }

  private layouts(): Record<string, CapturedLayout> {
    return this.memento.get<Record<string, CapturedLayout>>(LAYOUTS_KEY, {});
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
