import * as vscode from 'vscode';

const APPLY = 'tabManager.applyLayout';

/**
 * The terminal keep-alive scenario, run inside a live VS Code extension host:
 * arrange a file + editor terminal in worktree A, switch to B (blank), switch
 * back to A — the SAME terminal process must return to the editor area, with
 * no terminals killed, spawned, or misplaced, and a user panel terminal left
 * alone throughout.
 */
export async function run(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length < 2) {
    throw new Error(`expected 2 workspace folders, got ${folders?.length ?? 0}`);
  }
  const [wtA, wtB] = folders.map((folder) => folder.uri);

  if (process.env.TAB_MANAGER_ONLY === 'stacked') {
    await stackedTabsOnly(wtA, wtB);
    return;
  }
  if (process.env.TAB_MANAGER_ONLY === 'terminal-stack') {
    await terminalStackOnly(wtA, wtB);
    return;
  }

  // --- Arrange: file in column 1, editor terminal in column 2, plus a user
  // terminal in the panel that the extension must never touch.
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtA, 'a.ts'), {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
  });
  const keepalive = vscode.window.createTerminal({
    name: 'keepalive',
    cwd: wtA,
    location: { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
  });
  const userPanel = vscode.window.createTerminal({ name: 'userpanel' });
  await until(() => editorTerminalTabCount() === 1, 'editor terminal tab appears');
  await until(() => vscode.window.terminals.length === 2, 'both terminals exist');
  const keepalivePid = await keepalive.processId;
  log(`setup: keepalive pid=${keepalivePid}, terminals=${terminalNames()}`);

  // --- Activate wtA: must ADOPT the current arrangement, not blank it.
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await pause(1000);
  assertEq(editorTerminalTabCount(), 1, 'activating wtA keeps the editor terminal');
  assertEq(fileTabCount(), 1, 'activating wtA keeps the file open');

  // --- Switch to wtB (no layout): blank editor, terminal parked but alive.
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => editorTerminalTabCount() === 0, 'terminal tab leaves the editor area');
  await until(() => fileTabCount() === 0, 'file tabs close');
  assertEq(vscode.window.terminals.length, 2, `no terminal killed/spawned on switch (${terminalNames()})`);
  assert(keepalive.exitStatus === undefined, 'keepalive process alive while parked');
  log(`parked: terminals=${terminalNames()}`);

  // --- Switch back to wtA: the SAME terminal returns to the editor area.
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 1, 'terminal tab returns to the editor area');
  await until(() => fileTabCount() === 1, 'file reopens');
  assertEq(vscode.window.terminals.length, 2, `no duplicates after switch-back (${terminalNames()})`);
  assert(keepalive.exitStatus === undefined, 'keepalive alive after revive');
  assertEq(await keepalive.processId, keepalivePid, 'same pty process after round-trip');
  const revivedLabel = editorTerminalTabs()[0]?.label ?? '(none)';
  assert(
    revivedLabel.includes('keepalive'),
    `the revived tab is the keepalive terminal, not "${revivedLabel}" (wrong-terminal bug)`
  );
  log(`revived: tab="${revivedLabel}", terminals=${terminalNames()}`);
  assertPanelTerminalUntouched();

  // --- Probe: two more rapid round-trips must not duplicate or lose anything.
  for (const target of [wtB, wtA, wtB, wtA]) {
    await vscode.commands.executeCommand(APPLY, target.toString());
    await pause(500);
  }
  await until(() => editorTerminalTabCount() === 1, 'terminal back after rapid round-trips');
  assertEq(vscode.window.terminals.length, 2, `stable after rapid switches (${terminalNames()})`);
  assertEq(await keepalive.processId, keepalivePid, 'same pty process after rapid switches');
  log(`probe rapid switches: terminals=${terminalNames()}`);
  assertPanelTerminalUntouched();

  // --- Probe: a RUNNING process changes the tab label (default title is
  // ${process}) — the original bug's root cause. Keep-alive must still work.
  keepalive.sendText('sleep 300');
  await pause(2000); // let the shell start it and the tab title update
  const runningLabel = editorTerminalTabs()[0]?.label ?? '(gone)';
  log(`probe running-process: tab label is now "${runningLabel}"`);
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => editorTerminalTabCount() === 0, 'busy terminal parks');
  assert(keepalive.exitStatus === undefined, 'busy terminal alive while parked');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 1, 'busy terminal returns to the editor');
  assertEq(await keepalive.processId, keepalivePid, 'same pty while sleep is running');
  assertEq(vscode.window.terminals.length, 2, `no strays with busy terminal (${terminalNames()})`);
  log(`probe running-process: revived tab="${editorTerminalTabs()[0]?.label}"`);
  assertPanelTerminalUntouched();

  // --- Probe: layouts with TWO editor terminals round-trip intact.
  const second = vscode.window.createTerminal({
    name: 'second',
    cwd: wtA,
    location: { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
  });
  await until(() => editorTerminalTabCount() === 2, 'second editor terminal appears');
  const secondPid = await second.processId;
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => editorTerminalTabCount() === 0, 'both terminals park');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'both terminals return');
  assertEq(vscode.window.terminals.length, 3, `three terminals total, no strays (${terminalNames()})`);
  assertEq(await keepalive.processId, keepalivePid, 'keepalive pty intact with two terminals');
  assertEq(await second.processId, secondPid, 'second pty intact with two terminals');
  log(`probe two-terminals: terminals=${terminalNames()}`);
  assertPanelTerminalUntouched();

  // --- Probe: a 3-column file layout survives a round-trip intact.
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 0, 'wtB starts blank');
  for (const [index, name] of ['x.ts', 'y.ts', 'z.ts'].entries()) {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, name), {
      viewColumn: index + 1,
      preview: false,
    });
  }
  await until(() => vscode.window.tabGroups.all.length === 3, 'three panes exist in wtB');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return between pane probes');
  assertPanelTerminalUntouched();
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 3, 'wtB three files return');
  assertEq(vscode.window.tabGroups.all.length, 3, `three panes restored (${describeGroups()})`);
  for (const [index, name] of ['x.ts', 'y.ts', 'z.ts'].entries()) {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === index + 1);
    const labels = group?.tabs.map((tab) => tab.label).join(',') ?? '(no group)';
    assert(labels === name, `column ${index + 1} holds ${name} (got ${labels})`);
  }
  log(`probe 3-col: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  // --- Probe: a 2x2 grid (nested splits) survives a round-trip intact.
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }],
  });
  for (const [index, name] of ['x.ts', 'y.ts', 'z.ts', 'w.ts'].entries()) {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, name), {
      viewColumn: index + 1,
      preview: false,
    });
  }
  await until(() => vscode.window.tabGroups.all.length === 4, 'four panes exist in wtB');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return before grid check');
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 4, 'wtB four files return');
  assertEq(vscode.window.tabGroups.all.length, 4, `2x2 grid restored (${describeGroups()})`);
  const grid = (await vscode.commands.executeCommand('vscode.getEditorLayout')) as {
    groups?: { groups?: unknown[] }[];
  };
  const shape = (grid.groups ?? []).map((g) => g.groups?.length ?? 1).join('+');
  assertEq(shape, '2+2', `grid is nested 2x2 (top-level shape ${shape})`);
  for (const [index, name] of ['x.ts', 'y.ts', 'z.ts', 'w.ts'].entries()) {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === index + 1);
    const labels = group?.tabs.map((tab) => tab.label).join(',') ?? '(no group)';
    assert(labels === name, `grid column ${index + 1} holds ${name} (got ${labels})`);
  }
  log(`probe 2x2: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  // --- Probe: two STACKED rows (horizontal split) — user-reported case.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 1,
    groups: [{}, {}],
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'x.ts'), {
    viewColumn: 1,
    preview: false,
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'y.ts'), {
    viewColumn: 2,
    preview: false,
  });
  await until(() => vscode.window.tabGroups.all.length === 2, 'two stacked rows exist');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return before row probe');
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 2, 'wtB two row files return');
  assertEq(vscode.window.tabGroups.all.length, 2, `two rows restored (${describeGroups()})`);
  assertEq(await gridOrientation(), 1, 'stacked (vertical) orientation restored');
  for (const [index, name] of ['x.ts', 'y.ts'].entries()) {
    const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === index + 1);
    const labels = group?.tabs.map((tab) => tab.label).join(',') ?? '(no group)';
    assert(labels === name, `row ${index + 1} holds ${name} (got ${labels})`);
  }
  log(`probe stacked rows: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  // --- Probe: stacked rows with file on top, TERMINAL below (dev-server setup).
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 1,
    groups: [{}, {}],
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'x.ts'), {
    viewColumn: 1,
    preview: false,
  });
  const rowTerm = vscode.window.createTerminal({
    name: 'rowterm',
    cwd: wtB,
    location: { viewColumn: 2, preserveFocus: true },
  });
  await until(() => editorTerminalTabCount() === 1, 'row terminal appears');
  const rowTermPid = await rowTerm.processId;
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return before row-term probe');
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 1 && editorTerminalTabCount() === 1, 'row file+terminal return');
  assertEq(vscode.window.tabGroups.all.length, 2, `file+terminal rows restored (${describeGroups()})`);
  assertEq(await gridOrientation(), 1, 'stacked orientation restored with terminal');
  assertEq(await rowTerm.processId, rowTermPid, 'row terminal pty intact');
  const rowTwoTabs = vscode.window.tabGroups.all.find((g) => g.viewColumn === 2)?.tabs ?? [];
  assert(
    rowTwoTabs.some((tab) => tab.input instanceof vscode.TabInputTerminal),
    `bottom row holds the terminal (${describeGroups()})`
  );
  log(`probe stacked rows + terminal: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  // --- Probe: stacked rows with a DIFF editor below (diff-mode arrangement).
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 1,
    groups: [{}, {}],
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'x.ts'), {
    viewColumn: 1,
    preview: false,
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.joinPath(wtB, 'y.ts'),
    vscode.Uri.joinPath(wtB, 'z.ts'),
    'y.ts ↔ z.ts',
    { viewColumn: 2, preview: false }
  );
  await until(() => diffTabCount() === 1, 'diff editor opens in row 2');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return before diff probe');
  assertEq(diffTabCount(), 0, 'diff tab closed while in wtA');
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => diffTabCount() === 1, 'diff editor RETURNS on switch-back');
  assertEq(vscode.window.tabGroups.all.length, 2, `rows with diff restored (${describeGroups()})`);
  assertEq(await gridOrientation(), 1, 'stacked orientation restored with diff');
  const diffRow = vscode.window.tabGroups.all.find((g) => g.viewColumn === 2);
  assert(
    (diffRow?.tabs ?? []).some((tab) => tab.input instanceof vscode.TabInputTextDiff),
    `bottom row holds the diff editor (${describeGroups()})`
  );
  log(`probe stacked rows + diff: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  // --- Probe: multiple tabs STACKED in one group, y.ts active among them.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 1,
    groups: [{}, {}],
  });
  for (const name of ['x.ts', 'y.ts', 'w.ts']) {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, name), {
      viewColumn: 1,
      preview: false,
    });
  }
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'z.ts'), {
    viewColumn: 2,
    preview: false,
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'y.ts'), {
    viewColumn: 1,
    preview: false,
  });
  await until(() => fileTabCount() === 4, 'four tabs open across two rows');
  await vscode.commands.executeCommand(APPLY, wtA.toString());
  await until(() => editorTerminalTabCount() === 2, 'wtA terminals return before stacked-tabs probe');
  await vscode.commands.executeCommand(APPLY, wtB.toString());
  await until(() => fileTabCount() === 4, 'all four tabs return');
  assertEq(vscode.window.tabGroups.all.length, 2, `two rows restored (${describeGroups()})`);
  const stackedGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === 1);
  const stackedLabels = stackedGroup?.tabs.map((tab) => tab.label).join(',') ?? '(none)';
  assertEq(stackedLabels, 'x.ts,y.ts,w.ts', 'stacked tabs restored in order');
  assertEq(stackedGroup?.activeTab?.label, 'y.ts', 'active tab within the stack restored');
  log(`probe stacked tabs: ${describeGroups()}`);
  assertPanelTerminalUntouched();

  log('ALL ASSERTIONS PASSED');
}

/** Pure-file stacked-tabs scenario — no terminals, no focus-sensitive moves. */
async function stackedTabsOnly(wtA: vscode.Uri, wtB: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 1,
    groups: [{}, {}],
  });
  for (const name of ['x.ts', 'y.ts', 'w.ts']) {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, name), {
      viewColumn: 1,
      preview: false,
    });
  }
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'z.ts'), {
    viewColumn: 2,
    preview: false,
  });
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'y.ts'), {
    viewColumn: 1,
    preview: false,
  });
  await until(() => fileTabCount() === 4, 'four tabs open across two rows');
  log(`before: ${describeGroups()}`);

  await vscode.commands.executeCommand(APPLY, wtB.toString()); // adopt
  await vscode.commands.executeCommand(APPLY, wtA.toString()); // blank
  await until(() => fileTabCount() === 0, 'editor blanks on no-layout worktree');
  await vscode.commands.executeCommand(APPLY, wtB.toString()); // restore
  await until(() => fileTabCount() === 4, 'all four tabs return');

  assertEq(vscode.window.tabGroups.all.length, 2, `two rows restored (${describeGroups()})`);
  assertEq(await gridOrientation(), 1, 'stacked orientation restored');
  const stackedGroup = vscode.window.tabGroups.all.find((g) => g.viewColumn === 1);
  const stackedLabels = stackedGroup?.tabs.map((tab) => tab.label).join(',') ?? '(none)';
  assertEq(stackedLabels, 'x.ts,y.ts,w.ts', 'stacked tabs restored in order');
  assertEq(stackedGroup?.activeTab?.label, 'y.ts', 'active tab within the stack restored');
  log(`after: ${describeGroups()}`);
  log('ALL ASSERTIONS PASSED');
}

/** A terminal stacked as a tab NEXT TO a file in ONE group must round-trip
 *  back into that same group — not into a pane of its own (user report). */
async function terminalStackOnly(wtA: vscode.Uri, wtB: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(vscode.Uri.joinPath(wtB, 'x.ts'), {
    viewColumn: 1,
    preview: false,
  });
  // Create the terminal the way a user does — into the focused group, where
  // it stacks as a tab next to the file.
  const opened = new Promise<vscode.Terminal>((resolve) => {
    const listener = vscode.window.onDidOpenTerminal((terminal) => {
      listener.dispose();
      resolve(terminal);
    });
  });
  await vscode.commands.executeCommand('workbench.action.createTerminalEditor');
  const term = await opened;
  await until(() => editorTerminalTabCount() === 1, 'terminal tab appears in the file group');
  assertEq(vscode.window.tabGroups.all.length, 1, `single group before (${describeGroups()})`);
  const pid = await term.processId;
  log(`before: ${describeGroups()}`);

  await vscode.commands.executeCommand(APPLY, wtB.toString()); // adopt
  await vscode.commands.executeCommand(APPLY, wtA.toString()); // blank + park
  await until(() => editorTerminalTabCount() === 0, 'terminal parks');
  await vscode.commands.executeCommand(APPLY, wtB.toString()); // revive
  await until(
    () => fileTabCount() === 1 && editorTerminalTabCount() === 1,
    'file and terminal return'
  );
  assertEq(
    vscode.window.tabGroups.all.length,
    1,
    `terminal re-stacks into the file group, not its own pane (${describeGroups()})`
  );
  assertEq(await term.processId, pid, 'same pty after round-trip');
  log(`after: ${describeGroups()}`);
  log('ALL ASSERTIONS PASSED');
}

function diffTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTextDiff).length;
}

async function gridOrientation(): Promise<number | undefined> {
  const grid = (await vscode.commands.executeCommand('vscode.getEditorLayout')) as {
    orientation?: number;
  };
  return grid.orientation;
}

/** The user's panel terminal must never surface as an editor tab. */
function assertPanelTerminalUntouched(): void {
  const labels = editorTerminalTabs().map((tab) => tab.label);
  assert(
    !labels.some((label) => label.includes('userpanel')),
    `user panel terminal stays out of layouts (editor tabs: [${labels.join(', ')}])`
  );
}

function describeGroups(): string {
  return vscode.window.tabGroups.all
    .map((group) => `col${group.viewColumn}:[${group.tabs.map((tab) => tab.label).join(',')}]`)
    .join(' ');
}

function editorTerminalTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputTerminal);
}

function editorTerminalTabCount(): number {
  return editorTerminalTabs().length;
}

function fileTabCount(): number {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputText).length;
}

function terminalNames(): string {
  return `[${vscode.window.terminals.map((t) => t.name).join(', ')}]`;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
  log(`ok: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${expected}, got ${actual})`);
}

async function until(predicate: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`TIMEOUT waiting for: ${what}`);
    }
    await pause(50);
  }
  log(`ok: ${what}`);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[scenario] ${message}`);
}
