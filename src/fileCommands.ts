import * as path from 'path';
import * as vscode from 'vscode';
import { FileEntry } from './files';
import { gitUriAtRef, listBranchNames } from './git';
import { LayoutStore } from './store';

/** Bound to the Files view's filter row (label click) — exported for it. */
export const PICK_COMPARE_BRANCH = 'tabManager.pickCompareBranch';

/** Bound to file rows while the changed-only filter is on — exported for the tree. */
export const OPEN_DIFF = 'tabManager.openDiff';

/** Command ids, mirrored in `package.json` under `contributes.commands`. */
const FILE_COMMANDS = {
  newFile: 'tabManager.newFile',
  newFolder: 'tabManager.newFolder',
  revealInFinder: 'tabManager.revealInFinder',
  openToSide: 'tabManager.openToSide',
  openWith: 'tabManager.openWith',
  cut: 'tabManager.cutFile',
  copy: 'tabManager.copyFile',
  paste: 'tabManager.pasteFile',
  copyPath: 'tabManager.copyPath',
  copyRelativePath: 'tabManager.copyRelativePath',
  rename: 'tabManager.renameFile',
  delete: 'tabManager.deleteFile',
} as const;

/**
 * Cut/Copy/Paste state for the Files view. The built-in Explorer's file
 * clipboard (`filesExplorer.cut` etc.) operates on its own focused items and
 * can't be driven from another tree, so we keep our own single entry — the
 * tree is single-select. The `tabManager.canPaste` context key gates the
 * Paste menu item.
 */
class FileClipboard {
  private entry: { uri: vscode.Uri; cut: boolean } | undefined;

  set(uri: vscode.Uri, cut: boolean): void {
    this.entry = { uri, cut };
    void vscode.commands.executeCommand('setContext', 'tabManager.canPaste', true);
  }

  /** Returns the current entry; a cut entry is one-shot and is consumed. */
  take(): { uri: vscode.Uri; cut: boolean } | undefined {
    const entry = this.entry;
    if (entry?.cut) {
      this.entry = undefined;
      void vscode.commands.executeCommand('setContext', 'tabManager.canPaste', false);
    }
    return entry;
  }
}

export function registerFileCommands(
  context: vscode.ExtensionContext,
  store: LayoutStore
): void {
  const clipboard = new FileClipboard();
  const register = (id: string, handler: (node: FileEntry) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register(FILE_COMMANDS.newFile, (node) => createEntry(node.uri, 'file'));
  register(FILE_COMMANDS.newFolder, (node) => createEntry(node.uri, 'folder'));
  register(FILE_COMMANDS.revealInFinder, (node) =>
    vscode.commands.executeCommand('revealFileInOS', node.uri)
  );
  register(FILE_COMMANDS.openToSide, (node) =>
    vscode.commands.executeCommand('vscode.open', node.uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    })
  );
  register(FILE_COMMANDS.openWith, (node) => openWithPicker(node.uri));
  register(FILE_COMMANDS.cut, (node) => clipboard.set(node.uri, true));
  register(FILE_COMMANDS.copy, (node) => clipboard.set(node.uri, false));
  register(FILE_COMMANDS.paste, (node) => paste(clipboard, node.uri));
  register(FILE_COMMANDS.copyPath, (node) => vscode.env.clipboard.writeText(node.uri.fsPath));
  register(FILE_COMMANDS.copyRelativePath, (node) => copyRelativePath(store, node.uri));
  register(FILE_COMMANDS.rename, (node) => rename(node.uri));
  register(FILE_COMMANDS.delete, (node) => moveToTrash(node));

  context.subscriptions.push(
    vscode.commands.registerCommand(PICK_COMPARE_BRANCH, () => pickCompareBranch(store)),
    vscode.commands.registerCommand(OPEN_DIFF, openDiff)
  );
}

/**
 * Opens `uri` as a diff against its content at `baseRef` (the compare
 * branch's merge-base). Files that don't exist at the ref diff against empty
 * content — an all-added view. Falls back to a plain open if the Git
 * extension can't serve the ref content.
 */
async function openDiff(uri: vscode.Uri, baseRef: string, branchLabel: string): Promise<void> {
  const atBase = await gitUriAtRef(uri, baseRef);
  if (!atBase) {
    await vscode.commands.executeCommand('vscode.open', uri);
    return;
  }
  const title = `${path.basename(uri.fsPath)} (${branchLabel} ↔ Working Tree)`;
  await vscode.commands.executeCommand('vscode.diff', atBase, uri, title, { preview: false });
}

/** Lets the user choose which branch the Files view filter diffs against. */
async function pickCompareBranch(store: LayoutStore): Promise<void> {
  const root = store.activeFolderUri;
  if (!root) {
    vscode.window.showInformationMessage('Activate a worktree first.');
    return;
  }

  const TYPE_A_REF = '$(edit) Type a branch or ref…';
  const branches = await listBranchNames(vscode.Uri.parse(root));
  let choice: string | undefined;

  if (branches.length > 0) {
    choice = await vscode.window.showQuickPick([...branches, TYPE_A_REF], {
      placeHolder: 'Branch to compare files against (e.g. staging)',
    });
    if (choice === undefined) {
      return; // cancelled
    }
  }
  if (!choice || choice === TYPE_A_REF) {
    choice = await vscode.window.showInputBox({
      prompt: 'Branch or ref to compare against',
      value: store.compareBranch ?? 'staging',
    });
  }

  if (choice?.trim()) {
    await store.setCompareBranch(choice.trim());
  }
}

/** Prompts for a name and creates a file or folder inside `dirUri`. */
async function createEntry(dirUri: vscode.Uri, kind: 'file' | 'folder'): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: kind === 'file' ? 'New file name' : 'New folder name',
    placeHolder: kind === 'file' ? 'name.ts, or sub/dir/name.ts' : 'name',
    validateInput: validateEntryName,
  });
  if (!name) {
    return;
  }

  await withErrorNotice(async () => {
    const target = vscode.Uri.joinPath(dirUri, name);
    if (await exists(target)) {
      throw new Error(`"${name}" already exists.`);
    }
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(target);
      return;
    }
    // Like the Explorer, a name with slashes creates intermediate folders.
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, new Uint8Array());
    await vscode.commands.executeCommand('vscode.open', target);
  });
}

function validateEntryName(value: string): string | undefined {
  if (!value.trim()) {
    return 'Name cannot be empty';
  }
  if (value.split('/').some((segment) => !segment.trim() || segment === '..')) {
    return 'Invalid name';
  }
  return undefined;
}

async function paste(clipboard: FileClipboard, targetDir: vscode.Uri): Promise<void> {
  const entry = clipboard.take();
  if (!entry) {
    return;
  }

  await withErrorNotice(async () => {
    if (isSameOrInside(entry.uri, targetDir)) {
      throw new Error('Cannot paste a folder into itself.');
    }
    const name = path.basename(entry.uri.fsPath);
    if (entry.cut) {
      const dest = vscode.Uri.joinPath(targetDir, name);
      if (dest.fsPath === entry.uri.fsPath) {
        return;
      }
      if (await exists(dest)) {
        throw new Error(`"${name}" already exists here.`);
      }
      await vscode.workspace.fs.rename(entry.uri, dest);
    } else {
      // Like the Explorer, a name collision pastes as "name copy".
      await vscode.workspace.fs.copy(entry.uri, await availableDestination(targetDir, name));
    }
  });
}

async function rename(uri: vscode.Uri): Promise<void> {
  const oldName = path.basename(uri.fsPath);
  const newName = await vscode.window.showInputBox({
    prompt: 'New name',
    value: oldName,
    // Preselect the stem so typing replaces the name but keeps the extension.
    valueSelection: [0, oldName.length - path.extname(oldName).length],
    validateInput: (value) =>
      !value.trim() ? 'Name cannot be empty' : value.includes('/') ? 'Invalid name' : undefined,
  });
  if (!newName || newName === oldName) {
    return;
  }

  await withErrorNotice(async () => {
    const dest = vscode.Uri.joinPath(uri, '..', newName);
    if (await exists(dest)) {
      throw new Error(`"${newName}" already exists.`);
    }
    await vscode.workspace.fs.rename(uri, dest);
  });
}

async function moveToTrash(node: FileEntry): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Move "${node.name}" to Trash?`,
    { modal: true },
    'Move to Trash'
  );
  if (choice !== 'Move to Trash') {
    return;
  }
  await withErrorNotice(() =>
    vscode.workspace.fs.delete(node.uri, { recursive: true, useTrash: true })
  );
}

/**
 * Copies the path relative to the active worktree's root — the root of the
 * Files view. `workspace.asRelativePath` is only the fallback because it
 * doesn't know about discovered worktrees that aren't open workspace folders.
 */
function copyRelativePath(store: LayoutStore, uri: vscode.Uri): Thenable<void> {
  const root = store.activeFolderUri;
  const relative = root
    ? path.relative(vscode.Uri.parse(root).fsPath, uri.fsPath)
    : vscode.workspace.asRelativePath(uri);
  return vscode.env.clipboard.writeText(relative);
}

/** The Explorer's "Open With..." picker; falls back to a plain open. */
async function openWithPicker(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand('explorer.openWith', uri);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

/** First non-colliding "name", "name copy", "name copy 2", … in `dirUri`. */
async function availableDestination(dirUri: vscode.Uri, name: string): Promise<vscode.Uri> {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let n = 0; ; n++) {
    const candidate =
      n === 0 ? name : `${stem} copy${n === 1 ? '' : ` ${n}`}${extension}`;
    const uri = vscode.Uri.joinPath(dirUri, candidate);
    if (!(await exists(uri))) {
      return uri;
    }
  }
}

function isSameOrInside(source: vscode.Uri, target: vscode.Uri): boolean {
  return (
    target.fsPath === source.fsPath || target.fsPath.startsWith(source.fsPath + path.sep)
  );
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function withErrorNotice(action: () => Promise<void> | Thenable<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
