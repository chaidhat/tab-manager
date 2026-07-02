import * as vscode from 'vscode';
import { CapturedLayout } from './types';

const LAYOUTS_KEY = 'tabManager.worktreeLayouts';
const ACTIVE_KEY = 'tabManager.activeWorktree';
const FILTER_ENABLED_KEY = 'tabManager.filesFilterEnabled';
const FILTER_BRANCH_KEY = 'tabManager.filesFilterBranch';
const LINKED_PRS_KEY = 'tabManager.linkedPrs';

/** A pull request a worktree is linked to. */
export interface LinkedPr {
  number: number;
  title?: string;
}

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

  /** Whether the Files view shows only files changed vs {@link compareBranch}. */
  get filesFilterEnabled(): boolean {
    return this.memento.get<boolean>(FILTER_ENABLED_KEY, false);
  }

  /** The branch the Files view filter diffs against (e.g. "staging"). */
  get compareBranch(): string | undefined {
    return this.memento.get<string>(FILTER_BRANCH_KEY);
  }

  async setFilesFilterEnabled(enabled: boolean): Promise<void> {
    await this.memento.update(FILTER_ENABLED_KEY, enabled);
    this.emitter.fire();
  }

  async setCompareBranch(branch: string): Promise<void> {
    await this.memento.update(FILTER_BRANCH_KEY, branch);
    this.emitter.fire();
  }

  /** PR manually linked to a worktree ("Link with PR…"), if any. */
  linkedPr(folderUri: string): LinkedPr | undefined {
    const raw = this.linkedPrs()[folderUri];
    // Earlier versions stored just the number.
    return typeof raw === 'number' ? { number: raw } : raw;
  }

  async setLinkedPr(folderUri: string, pr: LinkedPr | undefined): Promise<void> {
    const links = { ...this.linkedPrs() };
    if (pr === undefined) {
      delete links[folderUri];
    } else {
      links[folderUri] = pr;
    }
    await this.memento.update(LINKED_PRS_KEY, links);
    this.emitter.fire();
  }

  /** Keeps the displayed PR title in sync when a fresh one is fetched. */
  async setLinkedPrTitle(folderUri: string, title: string): Promise<void> {
    const linked = this.linkedPr(folderUri);
    if (!linked || linked.title === title) {
      return;
    }
    await this.setLinkedPr(folderUri, { ...linked, title });
  }

  private linkedPrs(): Record<string, number | LinkedPr> {
    return this.memento.get<Record<string, number | LinkedPr>>(LINKED_PRS_KEY, {});
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
