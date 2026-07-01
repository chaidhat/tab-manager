import * as vscode from 'vscode';
import { TabRef } from './types';

type TerminalTab = Extract<TabRef, { kind: 'terminal' }>;

const MOVE_TO_PANEL = 'workbench.action.terminal.moveToTerminalPanel';
const MOVE_TO_EDITOR = 'workbench.action.terminal.moveToEditor';

/** Editor-group focus commands, indexed by view column (1-based). */
const FOCUS_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

/**
 * Keeps editor-area terminals alive across layout switches. VS Code has no API
 * to move a terminal into a specific pane, so this drives the built-in
 * move-to-panel / move-to-editor commands and matches terminals by name — a
 * best-effort dance that can misplace a terminal when several share a name.
 *
 * Every step degrades gracefully: if a live terminal can't be moved, the pane
 * falls back to a fresh shell rather than breaking the layout. State is
 * in-memory, so preservation only spans a single VS Code session.
 */
export class TerminalManager {
  /** Terminals moved into the panel, awaiting revival, in park order. */
  private readonly parked: { terminal: vscode.Terminal; name: string }[] = [];

  /**
   * Moves every editor-area terminal into the panel so a following
   * "close editors" can't kill it. Call before tearing an arrangement down.
   */
  async parkEditorTerminals(): Promise<number> {
    const terminalTabs = editorTerminalTabs();
    let parked = 0;

    for (const tab of terminalTabs) {
      const terminal = this.findLiveTerminal(tab.label);
      if (!terminal) {
        continue;
      }
      try {
        terminal.show(false);
        await vscode.commands.executeCommand(MOVE_TO_PANEL);
        this.parked.push({ terminal, name: tab.label });
        parked++;
      } catch {
        // Couldn't park it — it stays an editor terminal, still alive.
      }
    }
    return parked;
  }

  /**
   * Collapses the bottom panel. Moving terminals in and out of the panel pops it
   * open, so we hide it again to keep the parked terminals out of sight (they
   * stay alive — this only hides the view).
   */
  async hidePanel(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.closePanel');
    } catch {
      // Panel command unavailable — nothing to hide.
    }
  }

  /**
   * Brings a saved terminal into the given pane: revives a parked (still
   * running) terminal by name when one exists, otherwise opens a fresh shell.
   */
  async revive(tab: TerminalTab, viewColumn: number): Promise<void> {
    const index = this.parked.findIndex((entry) => entry.name === tab.name);
    if (index === -1) {
      this.createFresh(tab, viewColumn);
      return;
    }

    const { terminal } = this.parked.splice(index, 1)[0];
    try {
      await focusEditorGroup(viewColumn);
      terminal.show(true); // become the active terminal without stealing group focus
      await vscode.commands.executeCommand(MOVE_TO_EDITOR);
    } catch {
      this.createFresh(tab, viewColumn);
    }
  }

  private createFresh(tab: TerminalTab, viewColumn: number): void {
    vscode.window.createTerminal({
      name: tab.name,
      cwd: tab.cwd,
      location: { viewColumn, preserveFocus: true },
    });
  }

  /** A live terminal with this name that we haven't already parked. */
  private findLiveTerminal(name: string): vscode.Terminal | undefined {
    const alreadyParked = new Set(this.parked.map((entry) => entry.terminal));
    return vscode.window.terminals.find((t) => t.name === name && !alreadyParked.has(t));
  }
}

function editorTerminalTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTerminal);
}

async function focusEditorGroup(viewColumn: number): Promise<void> {
  const command = FOCUS_GROUP_COMMANDS[viewColumn - 1];
  if (command) {
    await vscode.commands.executeCommand(command);
  }
}
