import * as vscode from 'vscode';

/** The one method of the built-in Git extension's API this extension calls. */
interface GitApi {
  openRepository?(root: vscode.Uri): Promise<unknown>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitApi;
}

/**
 * Asks the built-in Git extension to open `folderUri` as its own repository,
 * so its files are decorated — and checked against `.gitignore` — relative to
 * its own root rather than a parent repo's.
 *
 * This matters for git worktrees living under a gitignored path, e.g.
 * `.claude/worktrees/<name>`: the Git extension's own auto-detection skips
 * scanning inside ignored directories (a known limitation —
 * https://github.com/microsoft/vscode/issues/41565), so without this call a
 * worktree that was only discovered on disk (never added to the VS Code
 * workspace) would have its files decorated against the wrong repository,
 * showing everything inside it as ignored.
 *
 * Best-effort: does nothing if the Git extension is missing, disabled, or its
 * API doesn't support this.
 */
export async function ensureRepositoryOpen(folderUri: vscode.Uri): Promise<void> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    await exports.getAPI(1).openRepository?.(folderUri);
  } catch {
    // Decorations just won't reflect this worktree's own status.
  }
}
