/** A worktree row in the sidebar. */
export interface WorktreeElement {
  /** Folder URI string — the key PR links and state are stored under. */
  folderUri: string;
  name: string;
  /** Whether this folder is currently open in the VS Code workspace. */
  isOpen: boolean;
  /** Whether this is the repo's main checkout, not a linked worktree. */
  isRoot: boolean;
}
