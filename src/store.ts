import * as vscode from 'vscode';

const ACTIVE_KEY = 'tabManager.activeWorktree';
const FILTER_BRANCH_KEY = 'tabManager.filesFilterBranch';
const LINKED_PRS_KEY = 'tabManager.linkedPrs';

/** A pull request a worktree is linked to. */
export interface LinkedPr {
  number: number;
  title?: string;
}

/**
 * Per-workspace state: which worktree this window targets (set in child
 * worktree windows), PR links, and the diff-view compare branch. Emits
 * {@link onDidChange} whenever the data changes so views can refresh.
 */
export class LayoutStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {}

  /** The worktree this window's PR/files views target. */
  get activeFolderUri(): string | undefined {
    return this.memento.get<string>(ACTIVE_KEY);
  }

  async setActive(folderUri: string | undefined): Promise<void> {
    await this.memento.update(ACTIVE_KEY, folderUri);
    this.emitter.fire();
  }

  /** The branch the changed-files view diffs against (e.g. "staging"). */
  get compareBranch(): string | undefined {
    return this.memento.get<string>(FILTER_BRANCH_KEY);
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

  dispose(): void {
    this.emitter.dispose();
  }
}
