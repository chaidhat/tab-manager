import * as vscode from 'vscode';
import { TerminalManager } from './terminals';
import { CapturedLayout, EditorGroupLayout, GroupSnapshot, TabRef } from './types';

/** Files that could not be reopened when applying a layout. */
export interface ApplyResult {
  missing: string[];
}

/** What a layout switch needs to know about the worktrees involved. */
export interface SwitchContext {
  /** Worktree being left — its terminals are parked under this pool key. */
  outgoingFolderUri: string | undefined;
  /** Worktree being entered — terminals are revived from its pool. */
  targetFolderUri: string | undefined;
  /** Collapse the bottom panel afterward (the user's setting). */
  hidePanelAfter: boolean;
}

/**
 * Captures the current editor arrangement — the nested split grid plus the
 * files open in each pane — into a serializable snapshot.
 */
export async function captureCurrentLayout(): Promise<CapturedLayout> {
  const grid = await vscode.commands.executeCommand<EditorGroupLayout>('vscode.getEditorLayout');
  const groups: GroupSnapshot[] = vscode.window.tabGroups.all.map((group) => ({
    viewColumn: group.viewColumn,
    activeUri: uriOf(group.activeTab),
    tabs: group.tabs.map(toTabRef).filter((tab): tab is TabRef => tab !== undefined),
  }));

  return {
    grid,
    groups,
    activeViewColumn: vscode.window.tabGroups.activeTabGroup?.viewColumn,
  };
}

/**
 * Restores a saved arrangement: closes the current editors, rebuilds the split
 * grid, then reopens each file in its original pane. Returns any files that
 * could not be opened (e.g. moved or deleted since the layout was saved).
 */
export async function applyLayout(
  layout: CapturedLayout,
  terminals: TerminalManager,
  context: SwitchContext
): Promise<ApplyResult> {
  // Don't hide the panel yet — reviving this layout's terminals below pops it
  // open again regardless; the final hide/keep decision happens once, at the end.
  const parkedCount = await clearEditorArea(terminals, {
    outgoingFolderUri: context.outgoingFolderUri,
    hidePanelAfter: false,
  });

  await vscode.commands.executeCommand('vscode.setEditorLayout', layout.grid);

  // Panes are created with view columns 1..N in grid order, so restoring each
  // tab into its saved view column reproduces the original arrangement.
  const groups = [...layout.groups].sort((a, b) => a.viewColumn - b.viewColumn);
  const missing: string[] = [];

  for (const group of groups) {
    for (const tab of group.tabs) {
      if (tab.kind === 'terminal') {
        await terminals.revive(tab, group.viewColumn, context.targetFolderUri);
      } else if (!(await show(tab.uri, group.viewColumn, true))) {
        missing.push(tab.uri);
      }
    }
  }

  await restoreFocus(layout, groups);

  // Shuffling terminals through the panel pops it open — collapse it again so
  // the parked terminals stay hidden, when the user has the setting enabled.
  const usedTerminals =
    parkedCount > 0 || groups.some((group) => group.tabs.some((tab) => tab.kind === 'terminal'));
  if (usedTerminals && context.hidePanelAfter) {
    await terminals.hidePanel();
  }

  return { missing };
}

/**
 * Closes the editor area down to a single empty pane — used when switching to
 * a worktree with no saved layout, so it starts blank rather than keeping
 * whatever was open before. Editor-area terminals are parked into the panel
 * (kept alive, not closed) rather than lost.
 */
export async function clearEditorArea(
  terminals: TerminalManager,
  options: { outgoingFolderUri: string | undefined; hidePanelAfter: boolean }
): Promise<number> {
  // Close only file editors — never terminal tabs, since closing those kills
  // the process. Dirty files still prompt to save, so we never discard work.
  // Files go first so groups left holding tabs hold only terminals, which is
  // what tab-driven parking relies on.
  const fileTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => !(tab.input instanceof vscode.TabInputTerminal));
  await vscode.window.tabGroups.close(fileTabs, true);

  const parkedCount = await terminals.parkEditorTerminals(options.outgoingFolderUri);

  if (parkedCount > 0 && options.hidePanelAfter) {
    await terminals.hidePanel();
  }

  return parkedCount;
}

/** Reveals each pane's active tab, ending with focus on the active pane. */
async function restoreFocus(layout: CapturedLayout, groups: GroupSnapshot[]): Promise<void> {
  const activeGroup = groups.find((group) => group.viewColumn === layout.activeViewColumn);

  for (const group of groups) {
    if (group !== activeGroup && group.activeUri) {
      await show(group.activeUri, group.viewColumn, true);
    }
  }
  if (activeGroup?.activeUri) {
    await show(activeGroup.activeUri, activeGroup.viewColumn, false);
  }
}

/** Opens a document in a pane; returns false if the file can't be opened. */
async function show(uri: string, viewColumn: number, preserveFocus: boolean): Promise<boolean> {
  try {
    await vscode.window.showTextDocument(vscode.Uri.parse(uri), {
      viewColumn,
      preview: false,
      preserveFocus,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reduces a tab to a reopenable reference. Text editors and editor-area
 * terminals are supported; diffs, notebooks and webviews are skipped. This is
 * the single place to extend support for other tab kinds.
 */
function toTabRef(tab: vscode.Tab): TabRef | undefined {
  if (tab.input instanceof vscode.TabInputText) {
    return { kind: 'file', uri: tab.input.uri.toString() };
  }
  if (tab.input instanceof vscode.TabInputTerminal) {
    // TabInputTerminal carries no data, so the tab label is our only handle on
    // the terminal; the working directory is a best-effort name match.
    return { kind: 'terminal', name: tab.label, cwd: terminalCwd(tab.label) };
  }
  return undefined;
}

function uriOf(tab: vscode.Tab | undefined): string | undefined {
  return tab?.input instanceof vscode.TabInputText ? tab.input.uri.toString() : undefined;
}

/**
 * The workspace folder a captured arrangement belongs to, decided by majority
 * vote over where its files (and terminal working directories) live. Returns
 * the folder's URI string, or undefined when nothing is inside any folder.
 */
export function owningFolderUri(layout: CapturedLayout): string | undefined {
  const votes = new Map<string, number>();

  for (const group of layout.groups) {
    for (const tab of group.tabs) {
      const uri =
        tab.kind === 'file'
          ? vscode.Uri.parse(tab.uri)
          : tab.cwd
            ? vscode.Uri.file(tab.cwd)
            : undefined;
      const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
      if (folder) {
        const key = folder.uri.toString();
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
  }

  let winner: string | undefined;
  let max = 0;
  for (const [key, count] of votes) {
    if (count > max) {
      winner = key;
      max = count;
    }
  }
  return winner;
}

/**
 * Best-effort working directory for a terminal identified only by name. Returns
 * undefined (falling back to the default cwd) when the name is missing or
 * ambiguous, since we can't otherwise tell the terminals apart.
 */
function terminalCwd(name: string): string | undefined {
  const matches = vscode.window.terminals.filter((terminal) => terminal.name === name);
  if (matches.length !== 1) {
    return undefined;
  }
  const options = matches[0].creationOptions;
  const cwd = 'cwd' in options ? options.cwd : undefined;
  if (!cwd) {
    return undefined;
  }
  return typeof cwd === 'string' ? cwd : cwd.fsPath;
}
