import * as vscode from 'vscode';
import { log } from './log';
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
 * Keeps editor-area terminals alive across layout switches. VS Code has no
 * API to move a terminal into a specific pane, so this drives the built-in
 * move-to-panel / move-to-editor commands.
 *
 * Two hard-won constraints shape the design:
 *
 * - Terminals can NOT be matched to tabs by name: a terminal tab's label
 *   tracks the running process (default title `${process}`, e.g. "node"),
 *   while `Terminal.name` keeps the creation name (e.g. "zsh"). Parking is
 *   therefore driven by tabs — with file tabs closed first, a group that
 *   still has tabs holds only terminals, so focusing it makes its terminal
 *   the active one and `moveToTerminalPanel` moves exactly that terminal.
 *
 * - Parked terminals are pooled per worktree, so switching back revives that
 *   worktree's own sessions and never another worktree's.
 *
 * Every step degrades gracefully: if a live terminal can't be moved, the pane
 * falls back to a fresh shell rather than breaking the layout. State is
 * in-memory, so preservation only spans a single VS Code session.
 */
export class TerminalManager {
  /** Parked terminals awaiting revival, keyed by the worktree they belong to. */
  private readonly pools = new Map<string, vscode.Terminal[]>();

  /**
   * Moves every editor-area terminal into the panel (still running) and pools
   * it under `poolKey`. Must be called after file tabs are closed — see the
   * class doc for why parking is driven by group focus rather than names.
   */
  async parkEditorTerminals(poolKey: string | undefined): Promise<number> {
    const pool = this.pool(poolKey);
    let parked = 0;

    // Bounded loop: each pass parks one terminal; bail out on any failure to
    // make progress rather than risk spinning.
    for (let guard = 0; guard < 32; guard++) {
      const group = groupWithTerminalTab();
      if (!group) {
        break;
      }
      const before = countEditorTerminalTabs();
      try {
        await focusEditorGroup(group.viewColumn);
        await vscode.commands.executeCommand(MOVE_TO_PANEL);
      } catch (error) {
        log(`park: move command failed in column ${group.viewColumn}: ${String(error)}`);
        break;
      }
      // The tab model updates asynchronously after the move; wait for it so
      // the next pass sees fresh state (and so we know the move worked).
      if (!(await settled(() => countEditorTerminalTabs() < before))) {
        log(`park: no progress in column ${group.viewColumn} (still ${before} terminal tabs)`);
        break;
      }
      // The just-moved terminal ends up focused in the panel. Wait for the
      // active-terminal model to catch up before trusting it.
      await settled(() => {
        const active = vscode.window.activeTerminal;
        return active !== undefined && !this.isPooled(active);
      }, 500);
      const moved = vscode.window.activeTerminal;
      if (moved && !this.isPooled(moved)) {
        pool.push(moved);
        log(`park: pooled "${moved.name}" under ${poolKey ?? '(none)'}`);
      } else {
        log(`park: moved a terminal but could not identify it; it stays in the panel`);
      }
      parked++;
    }
    return parked;
  }

  /**
   * Brings a terminal into the given pane: revives one parked from this
   * worktree when available (preferring a name match, else oldest first),
   * otherwise opens a fresh shell in the worktree's folder.
   */
  async revive(tab: TerminalTab, viewColumn: number, poolKey: string | undefined): Promise<void> {
    const terminal = this.takeFromPool(poolKey, tab.name);
    if (!terminal) {
      log(`revive: no pooled terminal for ${poolKey ?? '(none)'} — fresh shell in column ${viewColumn}`);
      this.createFresh(tab, viewColumn, poolKey);
      return;
    }

    try {
      const before = countEditorTerminalTabs();
      // Focus the target group first — move-to-editor drops the terminal into
      // the active group. Then genuinely FOCUS the terminal (show(false)):
      // the move command targets the focused terminal, and a preserve-focus
      // reveal does not reliably make ours the active one — moving whatever
      // happened to be focused instead was a source of misplaced terminals.
      await focusEditorGroup(viewColumn);
      terminal.show(false);
      if (!(await settled(() => vscode.window.activeTerminal === terminal, 500))) {
        // Never run the move while some other terminal is focused — that
        // would yank the wrong one (possibly the user's) into the layout.
        log(`revive: "${terminal.name}" did not become active; re-pooling, fresh shell instead`);
        this.pool(poolKey).unshift(terminal);
        this.createFresh(tab, viewColumn, poolKey);
        return;
      }
      await vscode.commands.executeCommand(MOVE_TO_EDITOR);
      if (!(await settled(() => countEditorTerminalTabs() > before))) {
        throw new Error('terminal did not appear in the editor area');
      }
      log(`revive: moved "${terminal.name}" into column ${viewColumn}`);
    } catch (error) {
      log(`revive: failed for "${terminal.name}": ${String(error)} — fresh shell instead`);
      this.createFresh(tab, viewColumn, poolKey);
    }
  }

  /**
   * Collapses the bottom panel. Moving terminals in and out of the panel pops
   * it open, so we hide it again to keep the parked terminals out of sight
   * (they stay alive — this only hides the view).
   */
  async hidePanel(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.closePanel');
    } catch {
      // Panel command unavailable — nothing to hide.
    }
  }

  private takeFromPool(poolKey: string | undefined, preferredName: string): vscode.Terminal | undefined {
    const pool = this.pool(poolKey);
    // Terminals can die while parked (process exit, closed from the panel).
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].exitStatus !== undefined) {
        pool.splice(i, 1);
      }
    }
    const named = pool.findIndex((terminal) => terminal.name === preferredName);
    return named !== -1 ? pool.splice(named, 1)[0] : pool.shift();
  }

  private createFresh(tab: TerminalTab, viewColumn: number, poolKey: string | undefined): void {
    vscode.window.createTerminal({
      name: tab.name,
      cwd: tab.cwd ?? (poolKey ? vscode.Uri.parse(poolKey) : undefined),
      location: { viewColumn, preserveFocus: true },
    });
  }

  private pool(key: string | undefined): vscode.Terminal[] {
    const normalized = key ?? '';
    let pool = this.pools.get(normalized);
    if (!pool) {
      pool = [];
      this.pools.set(normalized, pool);
    }
    return pool;
  }

  private isPooled(terminal: vscode.Terminal): boolean {
    for (const pool of this.pools.values()) {
      if (pool.includes(terminal)) {
        return true;
      }
    }
    return false;
  }
}

function countEditorTerminalTabs(): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTerminal).length;
}

function groupWithTerminalTab(): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal)
  );
}

async function focusEditorGroup(viewColumn: number): Promise<void> {
  const command = FOCUS_GROUP_COMMANDS[viewColumn - 1];
  if (command) {
    await vscode.commands.executeCommand(command);
  }
}

/** Polls until `predicate` holds; false if it doesn't within the timeout. */
async function settled(predicate: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}
