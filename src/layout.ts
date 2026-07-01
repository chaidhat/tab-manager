import * as vscode from 'vscode';
import { TerminalManager } from './terminals';
import { CapturedLayout, EditorGroupLayout, GroupSnapshot, TabRef } from './types';

/** Files that could not be reopened when applying a layout. */
export interface ApplyResult {
  missing: string[];
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
  terminals: TerminalManager
): Promise<ApplyResult> {
  // Move live terminals into the panel first so closing editors can't kill
  // them; the ones this layout wants are brought back below.
  const parkedCount = await terminals.parkEditorTerminals();

  // Close only file editors — never terminal tabs, since closing those kills
  // the process. Dirty files still prompt to save, so we never discard work.
  const fileTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => !(tab.input instanceof vscode.TabInputTerminal));
  await vscode.window.tabGroups.close(fileTabs, true);

  await vscode.commands.executeCommand('vscode.setEditorLayout', layout.grid);

  // Panes are created with view columns 1..N in grid order, so restoring each
  // tab into its saved view column reproduces the original arrangement.
  const groups = [...layout.groups].sort((a, b) => a.viewColumn - b.viewColumn);
  const missing: string[] = [];

  for (const group of groups) {
    for (const tab of group.tabs) {
      if (tab.kind === 'terminal') {
        await terminals.revive(tab, group.viewColumn);
      } else if (!(await show(tab.uri, group.viewColumn, true))) {
        missing.push(tab.uri);
      }
    }
  }

  await restoreFocus(layout, groups);

  // Shuffling terminals through the panel pops it open — collapse it again so
  // the parked terminals stay hidden at the bottom.
  const usedTerminals =
    parkedCount > 0 || groups.some((group) => group.tabs.some((tab) => tab.kind === 'terminal'));
  if (usedTerminals) {
    await terminals.hidePanel();
  }

  return { missing };
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
