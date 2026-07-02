import * as vscode from 'vscode';

/** One entry in a directory listing for the Files tree. */
export interface FileEntry {
  readonly uri: vscode.Uri;
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * Lists a directory's contents for the Files tree: folders first, then files,
 * both alphabetical, skipping `.git`. Returns an empty list if the directory
 * can't be read (e.g. it was deleted).
 */
export async function listDirectory(dirUri: vscode.Uri): Promise<FileEntry[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }

  return entries
    .filter(([name]) => name !== '.git')
    .map(([name, type]): FileEntry => ({
      uri: vscode.Uri.joinPath(dirUri, name),
      name,
      isDirectory: (type & vscode.FileType.Directory) !== 0,
    }))
    .sort((a, b) =>
      a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
    );
}
