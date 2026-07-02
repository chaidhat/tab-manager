/**
 * Shape of the object returned by the built-in `vscode.getEditorLayout` command
 * and accepted by `vscode.setEditorLayout`. It describes the nested grid of
 * editor groups (splits) and their proportions. These commands are not present
 * in `vscode.d.ts`, so we model the shape ourselves.
 */
export interface EditorGroupLayout {
  /** 0 = horizontal (side by side), 1 = vertical (stacked). */
  orientation?: number;
  groups: GroupLayoutArgument[];
}

export interface GroupLayoutArgument {
  /** Fractional size within the parent orientation; siblings sum to 1. */
  size?: number;
  /** Nested groups, laid out orthogonally to the parent orientation. */
  groups?: GroupLayoutArgument[];
}

/**
 * A single editor tab, reduced to what we need to reopen it. A terminal can't
 * have its live session restored (VS Code exposes no API for that), so we
 * recreate a fresh shell with the same name and, where detectable, folder.
 */
export type TabRef =
  | { kind: 'file'; uri: string }
  | { kind: 'terminal'; name: string; cwd?: string };

/** The files open in one editor pane, identified by its view column. */
export interface GroupSnapshot {
  viewColumn: number;
  /** URI of the tab that should be focused/visible in this pane, if any. */
  activeUri?: string;
  /** Tabs in their on-screen order. */
  tabs: TabRef[];
}

/** A full, serializable snapshot of the editor area. */
export interface CapturedLayout {
  /** The split grid geometry (from `vscode.getEditorLayout`). */
  grid: EditorGroupLayout;
  /** Files per pane, aligned to the grid by view column. */
  groups: GroupSnapshot[];
  /** View column of the pane that had focus when captured. */
  activeViewColumn?: number;
}

/** A worktree row in the sidebar: one folder, one layout slot. */
export interface WorktreeElement {
  /** Folder URI string — the key a layout is stored under. */
  folderUri: string;
  name: string;
  /** Whether this folder is currently open in the VS Code workspace. */
  isOpen: boolean;
}
