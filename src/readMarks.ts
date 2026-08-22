import { createHash } from 'crypto';
import { createReadStream, mkdirSync, Stats } from 'fs';
import { stat } from 'fs/promises';
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

/**
 * File digests, with a stat-based shortcut: a file whose size and modification
 * time are unchanged since it was last hashed keeps its digest, so re-checking
 * a review's marked files costs one stat each instead of a full read.
 *
 * A stat can lie — two writes within the same millisecond that leave the size
 * alone look identical — so {@link rehash} exists for the cases where a file is
 * known to have just changed, and hashes unconditionally.
 */
export class DigestCache {
  private readonly stamps = new Map<string, { mtimeMs: number; size: number; digest: string }>();

  /** The file's digest, re-reading it only if its stat moved. */
  async digest(fsPath: string): Promise<string | undefined> {
    let info: Stats;
    try {
      info = await stat(fsPath);
    } catch (error) {
      this.stamps.delete(fsPath);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return DELETED_DIGEST;
      }
      log(`read marks: cannot stat ${fsPath}: ${errorMessage(error)}`);
      return undefined;
    }
    const stamp = this.stamps.get(fsPath);
    if (stamp?.mtimeMs === info.mtimeMs && stamp.size === info.size) {
      return stamp.digest;
    }
    return this.rehash(fsPath, info);
  }

  /** The file's digest, read afresh whatever the stat says. */
  async rehash(fsPath: string, info?: Stats): Promise<string | undefined> {
    const digest = await fileDigest(fsPath);
    if (digest === undefined || digest === DELETED_DIGEST) {
      this.stamps.delete(fsPath);
      return digest;
    }
    // Stat after hashing, not before: a file written while we read it then has
    // a stamp that won't match, and the next check hashes it again.
    const stamped = info ?? (await stat(fsPath).catch(() => undefined));
    if (stamped) {
      this.stamps.set(fsPath, { mtimeMs: stamped.mtimeMs, size: stamped.size, digest });
    }
    return digest;
  }
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
  /**
   * Fires when another window changed the marks. Changes made here don't fire:
   * the caller already knows, and knows which rows to redraw.
   */
  readonly onDidChangeElsewhere = this.emitter.event;

  private readonly file: vscode.Uri;
  private readonly tempFile: vscode.Uri;
  private readonly watcher: vscode.FileSystemWatcher;
  private marks: StoredMarks = { version: VERSION, repos: {} };
  /** The file's text as we last saw it, to recognize our own writes. */
  private serialized = '';
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
    await this.adopt();
  }

  /** The digest recorded for a file, or undefined if it isn't marked read. */
  digestOf(scope: ReadScope, relativePath: string): string | undefined {
    return this.marks.repos[scope.repoRoot]?.[scope.id]?.[relativePath];
  }

  /** Every file marked read in this review, as worktree-relative paths. */
  markedPaths(scope: ReadScope): string[] {
    return Object.keys(this.marks.repos[scope.repoRoot]?.[scope.id] ?? {});
  }

  /** Marks one file read at the given digest. Returns whether anything changed. */
  async mark(scope: ReadScope, relativePath: string, digest: string): Promise<boolean> {
    return this.mutate((marks) => {
      const review = ((marks.repos[scope.repoRoot] ??= {})[scope.id] ??= {});
      if (review[relativePath] === digest) {
        return false;
      }
      review[relativePath] = digest;
      return true;
    });
  }

  /** Un-marks files — ticked off by the user, or gone stale. */
  async unmark(scope: ReadScope, relativePaths: readonly string[]): Promise<boolean> {
    return this.mutate((marks) => {
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
   * Applies `change` to the marks as they are on disk right now, writes them
   * back if it reported a change, and says whether it did. Queued behind any
   * cycle already in flight, so concurrent ticks can't lose each other.
   */
  private mutate(change: (marks: StoredMarks) => boolean): Promise<boolean> {
    const done = this.pendingWrite.then(async () => {
      const { marks, text } = await this.read();
      this.marks = marks;
      this.serialized = text;
      if (!change(marks)) {
        return false;
      }
      await this.write(marks);
      return true;
    });
    // The queue only sequences the cycles; a failing one mustn't wedge it.
    this.pendingWrite = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  /** Takes on what's in the file. Returns whether that differs from what we had. */
  private async adopt(): Promise<boolean> {
    const { marks, text } = await this.read();
    if (text === this.serialized) {
      return false;
    }
    this.marks = marks;
    this.serialized = text;
    return true;
  }

  private async reload(): Promise<void> {
    // Our own writes come back through the watcher too; only a change we
    // didn't make is worth telling anyone about.
    if (await this.adopt()) {
      this.emitter.fire();
    }
  }

  private async read(): Promise<{ marks: StoredMarks; text: string }> {
    const empty = { marks: { version: VERSION, repos: {} }, text: '' };
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file));
    } catch {
      return empty; // no marks stored yet
    }
    try {
      const marks = JSON.parse(text) as StoredMarks;
      // Written by us, but a hand-edit or a half-written file shouldn't take
      // the view down — start over rather than trusting a bad shape.
      if (marks?.version !== VERSION || typeof marks.repos !== 'object') {
        throw new Error(`unexpected shape (version ${String(marks?.version)})`);
      }
      return { marks, text };
    } catch (error) {
      log(`read marks: ignoring unreadable ${this.file.fsPath}: ${errorMessage(error)}`);
      return empty;
    }
  }

  /** Writes via a temp file and a rename, so a crash can't truncate the marks. */
  private async write(marks: StoredMarks): Promise<void> {
    const text = JSON.stringify(marks, undefined, 2);
    const encoded = new TextEncoder().encode(text);
    try {
      await vscode.workspace.fs.createDirectory(this.storageUri);
      await vscode.workspace.fs.writeFile(this.tempFile, encoded);
      await vscode.workspace.fs.rename(this.tempFile, this.file, { overwrite: true });
      this.serialized = text;
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
