import { runTests } from '@vscode/test-electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Launches a real VS Code with this extension and runs the scenario in
 * `suite/index.ts` inside its extension host. Uses a throwaway two-folder
 * workspace (simulating two worktrees) so terminal keep-alive across layout
 * switches can be observed against live shell processes.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite');

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-manager-test-'));
  const wtA = path.join(workspaceRoot, 'wtA');
  const wtB = path.join(workspaceRoot, 'wtB');
  fs.mkdirSync(wtA);
  fs.mkdirSync(wtB);
  fs.writeFileSync(path.join(wtA, 'a.ts'), 'export const a = 1;\n');
  for (const name of ['x.ts', 'y.ts', 'z.ts', 'w.ts']) {
    fs.writeFileSync(path.join(wtB, name), `export const v = '${name}';\n`);
  }

  const workspaceFile = path.join(workspaceRoot, 'test.code-workspace');
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'wtA' }, { path: 'wtB' }] }));

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // e.g. `node dist/test/runTests.js stacked` runs only the stacked-tabs
    // scenario (pure files — none of the focus-sensitive terminal moves).
    extensionTestsEnv: { TAB_MANAGER_ONLY: process.argv[2] ?? '' },
    launchArgs: [
      workspaceFile,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
  });
}

main().catch((error) => {
  console.error('Test run failed:', error);
  process.exit(1);
});
