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
  private beaconReady = false;

  constructor(private readonly storageUri: vscode.Uri) {}

  /**
   * The location-probe beacon must be a REAL file: an empty untitled editor
   * gets auto-discarded by VS Code the moment it loses focus (mid-probe),
   * which collapses the active tab back onto a terminal tab and poisons the
   * classification. A file in extension storage sticks around and still
   * closes silently.
   */
  private async beaconFileUri(): Promise<vscode.Uri> {
    const uri = vscode.Uri.joinPath(this.storageUri, 'location-probe.txt');
    if (!this.beaconReady) {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(
          uri,
          new TextEncoder().encode('Tab Manager terminal-location probe\n')
        );
      }
      this.beaconReady = true;
    }
    return uri;
  }

  /**
   * Moves every editor-area terminal into the panel (still running) and pools
   * it under `poolKey`. Must be called after file tabs are closed.
   *
   * Identity is never inferred from focus state: handles are first CLASSIFIED
   * by location (see {@link classifyEditorTerminals}), then each editor
   * terminal is shown — giving that exact handle widget focus — and moved,
   * with the move verified by the editor terminal-tab count dropping. Panel
   * terminals are never touched. Two lessons are baked in: focusing an editor
   * GROUP does not flip `window.activeTerminal`, and the move command targets
   * the editor-area terminal even when a panel terminal has keyboard focus —
   * so neither can identify which handle moved.
   */
  async parkEditorTerminals(poolKey: string | undefined): Promise<number> {
    const pool = this.pool(poolKey);
    let parked = 0;

    // Focus side-effects from one probe can spill into the next (a shown
    // terminal re-selects sibling tabs asynchronously), so a candidate can be
    // skipped defensively — or a probe can false-negative under load. Later
    // rounds pick up whatever earlier ones missed.
    for (let round = 0; round < 3 && countEditorTerminalTabs() > 0; round++) {
      for (const terminal of await this.classifyEditorTerminals()) {
        const before = countEditorTerminalTabs();
        try {
          terminal.show(false);
          await settled(() => vscode.window.activeTerminal === terminal, 400);
          await vscode.commands.executeCommand(MOVE_TO_PANEL);
        } catch (error) {
          log(`park: failed to move "${terminal.name}": ${String(error)}`);
          continue;
        }
        if (await settled(() => countEditorTerminalTabs() < before, 1500)) {
          pool.push(terminal);
          parked++;
          log(`park: pooled "${terminal.name}" under ${poolKey ?? '(none)'}`);
        } else {
          log(`park: "${terminal.name}" did not leave the editor area`);
        }
      }
    }
    if (countEditorTerminalTabs() > 0) {
      log(`park: ${countEditorTerminalTabs()} editor terminal tab(s) could not be parked`);
    }
    return parked;
  }

  /**
   * Which live handles are editor-area terminals. There is no API for a
   * terminal's location, so each handle is probed against a throwaway
   * untitled "beacon" editor that takes focus first: showing an EDITOR
   * terminal moves the active tab off the beacon onto a terminal tab, while
   * showing a PANEL terminal leaves the beacon active. The beacon is reset
   * before each probe and closed afterwards.
   */
  private async classifyEditorTerminals(): Promise<vscode.Terminal[]> {
    const beaconUri = await this.beaconFileUri();
    const beacon = await vscode.workspace.openTextDocument(beaconUri);
    // The beacon gets a group of its OWN, one column past the last: showing a
    // panel terminal re-selects a terminal tab sharing the beacon's group
    // (observed, deterministic), which poisons the signal. In a dedicated
    // group there is no terminal sibling to steal the selection. The empty
    // group auto-closes when the beacon closes.
    const beaconColumn = Math.min(vscode.window.tabGroups.all.length + 1, 9);
    const editorTerminals: vscode.Terminal[] = [];
    try {
      for (const terminal of [...vscode.window.terminals]) {
        if (this.isPooled(terminal) || terminal.exitStatus !== undefined) {
          continue;
        }
        // Confirm the beacon is active before probing — with retries, since a
        // just-shown terminal can asynchronously knock it off right after.
        let baselineClean = false;
        for (let attempt = 0; attempt < 3 && !baselineClean; attempt++) {
          await vscode.window.showTextDocument(beacon, {
            viewColumn: beaconColumn,
            preview: false,
            preserveFocus: false,
          });
          baselineClean = await settled(() => activeTabIs(beaconUri), 800);
        }
        if (!baselineClean) {
          // Probing from a dirty baseline misclassifies — skip; the second
          // park round will retry this candidate.
          log(`park: beacon lost before probing "${terminal.name}" (${describeActiveTab()})`);
          continue;
        }
        terminal.show(false);
        const isEditor = await settled(() => activeTabIsTerminal(), 1000);
        log(`park: probe "${terminal.name}" → ${isEditor ? 'editor' : 'panel'} (${describeActiveTab()})`);
        if (isEditor) {
          editorTerminals.push(terminal);
        }
      }
    } finally {
      await closeTabOf(beaconUri);
    }
    return editorTerminals;
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
      // The focus wait gets a retry: a single missed window here would mint
      // a duplicate via the fresh-shell fallback.
      let focused = false;
      for (let attempt = 0; attempt < 2 && !focused; attempt++) {
        terminal.show(false);
        focused = await settled(() => vscode.window.activeTerminal === terminal, 800);
      }
      if (!focused) {
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

function activeTabIsTerminal(): boolean {
  return (
    vscode.window.tabGroups.activeTabGroup?.activeTab?.input instanceof vscode.TabInputTerminal
  );
}

function describeActiveTab(): string {
  const group = vscode.window.tabGroups.activeTabGroup;
  const tab = group?.activeTab;
  const kind = tab?.input?.constructor?.name ?? 'none';
  return `active tab "${tab?.label ?? '(none)'}" [${kind}] in column ${group?.viewColumn}`;
}

function activeTabIs(uri: vscode.Uri): boolean {
  const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
  return input instanceof vscode.TabInputText && input.uri.toString() === uri.toString();
}

async function closeTabOf(uri: vscode.Uri): Promise<void> {
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (candidate) =>
        candidate.input instanceof vscode.TabInputText &&
        candidate.input.uri.toString() === uri.toString()
    );
  if (tab) {
    await vscode.window.tabGroups.close(tab, true);
  }
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
