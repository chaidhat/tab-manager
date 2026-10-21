import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';

const WINDOWS_DIR = path.join(os.homedir(), '.claude', 'tab-manager', 'open-windows');
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_MAX_AGE_MS = 6000;

interface WindowMarker {
  readonly folders: readonly string[];
}

/**
 * Shares this window's folders with the extension running in every other VS
 * Code window. A short-lived heartbeat makes a window disappear even when VS
 * Code crashes and cannot remove its marker during shutdown.
 */
export class OpenWindowRegistry implements vscode.Disposable {
  private readonly marker = path.join(WINDOWS_DIR, `${crypto.randomUUID()}.json`);
  private readonly subscription: vscode.Disposable;
  private readonly timer: NodeJS.Timeout;
  private writing = false;
  private disposed = false;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.write());
    this.timer = setInterval(() => void this.write(), HEARTBEAT_INTERVAL_MS);
  }

  /** Writes the first heartbeat before session monitoring begins. */
  async start(): Promise<void> {
    await this.write();
  }

  /** Every folder belonging to a VS Code window with a fresh heartbeat. */
  async folders(): Promise<string[]> {
    const folders = new Set(currentFolders());
    let names: string[];
    try {
      names = await fs.readdir(WINDOWS_DIR);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`open windows: cannot read ${WINDOWS_DIR} — ${errorMessage(error)}`);
      }
      return [...folders];
    }

    const oldest = Date.now() - HEARTBEAT_MAX_AGE_MS;
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const filename = path.join(WINDOWS_DIR, name);
          try {
            const stat = await fs.stat(filename);
            if (stat.mtimeMs < oldest) {
              await fs.rm(filename, { force: true });
              return;
            }
            const marker = parseMarker(JSON.parse(await fs.readFile(filename, 'utf8')));
            for (const folder of marker?.folders ?? []) {
              folders.add(folder);
            }
          } catch {
            // A window can close or replace its marker between the directory
            // read and this read. A half-written marker is retried next poll.
          }
        }),
    );
    return [...folders];
  }

  private async write(): Promise<void> {
    if (this.writing || this.disposed) {
      return;
    }
    this.writing = true;
    try {
      await fs.mkdir(WINDOWS_DIR, { recursive: true });
      await fs.writeFile(this.marker, JSON.stringify({ folders: currentFolders() }), {
        mode: 0o600,
      });
      if (this.disposed) {
        await this.removeMarker();
      }
    } catch (error) {
      log(`open windows: cannot write heartbeat — ${errorMessage(error)}`);
    } finally {
      this.writing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.subscription.dispose();
    void this.removeMarker().catch((error: unknown) => {
      log(`open windows: cannot remove heartbeat — ${errorMessage(error)}`);
    });
  }

  private async removeMarker(): Promise<void> {
    await fs.rm(this.marker, { force: true });
  }
}

function currentFolders(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

function parseMarker(raw: unknown): WindowMarker | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const folders = (raw as Record<string, unknown>).folders;
  return Array.isArray(folders) && folders.every((folder) => typeof folder === 'string')
    ? { folders }
    : undefined;
}
