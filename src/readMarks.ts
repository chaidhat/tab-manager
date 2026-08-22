import { createHash } from 'crypto';
import { createReadStream, mkdirSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';

/**
 * Which review a set of read marks belongs to: the repository, plus the pull
 * request whose diff is being read. Worktrees come and go (and a PR's worktree
 * can be deleted and recreated), so the marks are keyed by the review rather
 * than by the folder they happened to be ticked in.
 */
export interface ReadScope {
  /** Absolute path of the main repository (not the worktree). */
  readonly repoRoot: string;
  /** `pr:<number>`, or `branch:<name>` for a worktree with no pull request. */
  readonly id: string;
}

const FILE_NAME = 'read-marks.json';
const TEMP_FILE_NAME = 'read-marks.json.tmp';
const VERSION = 1;

/**
 * Digest recorded for a file that doesn't exist on disk. A deleted file is
 * still a reviewable row, and "gone" is a content state like any other: if the
 * file comes back, its digest stops matching and the mark drops.
 */
const DELETED_DIGEST = 'deleted';

/**
 * The md5 of a file's contents, {@link DELETED_DIGEST} if it isn't there, and
 * undefined if it can't be read at all. Streamed rather than read whole: a
 * diff can include a big file, and hashing incrementally keeps memory flat.
 *
 * md5 rather than a stronger hash because this only has to notice a file the
 * user edited — there is no adversary to defend against, and md5 is the
 * fastest digest Node exposes over OpenSSL.
 */
export function fileDigest(fsPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const hash = createHash('md5');
    const stream = createReadStream(fsPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        resolve(DELETED_DIGEST);
        return;
      }
      log(`read marks: cannot hash ${fsPath}: ${errorMessage(error)}`);
      resolve(undefined);
    });
  });
}

/** Marks as they sit on disk: repo → review → file path → digest. */
interface StoredMarks {
  version: number;
  repos: Record<string, Record<string, Record<string, string>>>;
}

/**
 * The files the user ticked as read, with the digest of the content they read,
 * persisted per repository and pull request.
 *
 * Lives in the extension's global storage rather than in settings: it is
 * bookkeeping, not something anyone hand-edits, and it would bury the useful
 * settings under a wall of hashes. Every mutation re-reads the file before
 * writing it back, so two worktree windows reviewing different PRs of the same
 * repository can't clobber each other, and a file watcher keeps each window's
 * cache current when the other one writes.
 */
export class ReadMarkStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the marks change — here or in another window. */
  readonly onDidChange = this.emitter.event;

  private readonly file: vscode.Uri;
  private readonly tempFile: vscode.Uri;
  private readonly watcher: vscode.FileSystemWatcher;
  private marks: StoredMarks = { version: VERSION, repos: {} };
  /** Serializes read-modify-write cycles against each other. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly storageUri: vscode.Uri) {
    this.file = vscode.Uri.joinPath(storageUri, FILE_NAME);
    this.tempFile = vscode.Uri.joinPath(storageUri, TEMP_FILE_NAME);
    // The extension owns this directory but VS Code doesn't create it. It has
    // to exist before the watcher does, or the watcher has nothing to watch
    // and the first write from another window goes unnoticed here.
    try {
      mkdirSync(storageUri.fsPath, { recursive: true });
    } catch (error) {
      log(`read marks: cannot create ${storageUri.fsPath}: ${errorMessage(error)}`);
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(storageUri, FILE_NAME),
    );
    const reload = () => void this.reload();
    this.watcher.onDidCreate(reload);
    this.watcher.onDidChange(reload);
    this.watcher.onDidDelete(reload);
  }

  /** Loads the marks into memory. Call once, before the views first render. */
  async load(): Promise<void> {
    this.marks = await this.read();
  }

  /** The digest recorded for a file, or undefined if it isn't marked read. */
  digestOf(scope: ReadScope, relativePath: string): string | undefined {
    return this.marks.repos[scope.repoRoot]?.[scope.id]?.[relativePath];
  }

  /** Every file marked read in this review, as worktree-relative paths. */
  markedPaths(scope: ReadScope): string[] {
    return Object.keys(this.marks.repos[scope.repoRoot]?.[scope.id] ?? {});
  }

  /** Marks one file read at the given digest. */
  async mark(scope: ReadScope, relativePath: string, digest: string): Promise<void> {
    await this.mutate((marks) => {
      const review = ((marks.repos[scope.repoRoot] ??= {})[scope.id] ??= {});
      if (review[relativePath] === digest) {
        return false;
      }
      review[relativePath] = digest;
      return true;
    });
  }

  /** Un-marks files — ticked off by the user, or gone stale. */
  async unmark(scope: ReadScope, relativePaths: readonly string[]): Promise<void> {
    await this.mutate((marks) => {
      const repo = marks.repos[scope.repoRoot];
      const review = repo?.[scope.id];
      if (!repo || !review) {
        return false;
      }
      let changed = false;
      for (const relativePath of relativePaths) {
        if (relativePath in review) {
          delete review[relativePath];
          changed = true;
        }
      }
      if (!changed) {
        return false;
      }
      // Don't leave empty shells behind: a finished review shouldn't grow the
      // file forever.
      if (Object.keys(review).length === 0) {
        delete repo[scope.id];
      }
      if (Object.keys(repo).length === 0) {
        delete marks.repos[scope.repoRoot];
      }
      return true;
    });
  }

  /**
   * Applies `change` to the marks as they are on disk right now, and writes
   * them back if it reported a change.
   */
  private mutate(change: (marks: StoredMarks) => boolean): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const marks = await this.read();
      if (!change(marks)) {
        this.marks = marks;
        return;
      }
      this.marks = marks;
      await this.write(marks);
      this.emitter.fire();
    });
    return this.pendingWrite;
  }

  private async reload(): Promise<void> {
    this.marks = await this.read();
    this.emitter.fire();
  }

  private async read(): Promise<StoredMarks> {
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(this.file);
    } catch {
      return { version: VERSION, repos: {} }; // no marks stored yet
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as StoredMarks;
      // Written by us, but a hand-edit or a half-written file shouldn't take
      // the view down — start over rather than trusting a bad shape.
      if (parsed?.version !== VERSION || typeof parsed.repos !== 'object') {
        throw new Error(`unexpected shape (version ${String(parsed?.version)})`);
      }
      return parsed;
    } catch (error) {
      log(`read marks: ignoring unreadable ${this.file.fsPath}: ${errorMessage(error)}`);
      return { version: VERSION, repos: {} };
    }
  }

  /** Writes via a temp file and a rename, so a crash can't truncate the marks. */
  private async write(marks: StoredMarks): Promise<void> {
    const encoded = new TextEncoder().encode(JSON.stringify(marks, undefined, 2));
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(this.tempFile, encoded);
      await vscode.workspace.fs.rename(this.tempFile, this.file, { overwrite: true });
    } catch (error) {
      log(`read marks: cannot save ${this.file.fsPath}: ${errorMessage(error)}`);
      void vscode.window.showWarningMessage(
        "Tab Manager couldn't save which files you marked as read — see Output → Tab Manager.",
      );
    }
  }

  dispose(): void {
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

/**
 * A file's path relative to the worktree root, in the stored form: always
 * `/`-separated, so marks survive being read on another platform. Undefined
 * for anything outside the root.
 */
export function storedPath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  const relative = path.relative(root.fsPath, uri.fsPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join('/');
}

/** The absolute path of a stored, `/`-separated path. */
export function absolutePath(root: vscode.Uri, relativePath: string): string {
  return path.join(root.fsPath, ...relativePath.split('/'));
}
