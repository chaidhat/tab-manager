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

  // --- Probe: two more rapid round-trips must not duplicate or lose anything.
  for (const target of [wtB, wtA, wtB, wtA]) {
    await vscode.commands.executeCommand(APPLY, target.toString());
    await pause(500);
  }
  await until(() => editorTerminalTabCount() === 1, 'terminal back after rapid round-trips');
  assertEq(vscode.window.terminals.length, 2, `stable after rapid switches (${terminalNames()})`);
  assertEq(await keepalive.processId, keepalivePid, 'same pty process after rapid switches');
  log(`probe rapid switches: terminals=${terminalNames()}`);

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

  log('ALL ASSERTIONS PASSED');
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
