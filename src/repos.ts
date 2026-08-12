import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { log } from './log';
import { repoRootOf } from './worktrees';

// Where the Root Worktree Manager's repository list lives. User (global)
// settings rather than workspace settings: the list is the user's own, not a
// property of whichever folder happens to be open, and the paths only mean
// anything on this machine.
const SECTION = 'tabManager';
const KEY = 'repositories';
const SETTING = `${SECTION}.${KEY}`;

/**
 * The repositories the user added to the Root Worktree Manager, as absolute
 * paths. Since the list is a normal VS Code setting it can also be hand-edited
 * in settings.json, so entries are normalized here: `~` is expanded, trailing
 * separators are dropped, and anything that isn't a non-empty absolute path is
 * ignored (and logged, so a typo isn't silently swallowed).
 */
export function configuredRepos(): string[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  const repos: string[] = [];
  for (const entry of raw) {
    const repoRoot = normalize(entry);
    if (repoRoot === undefined) {
      log(`repos: ignoring invalid ${SETTING} entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (!repos.includes(repoRoot)) {
      repos.push(repoRoot);
    }
  }
  return repos;
}

/**
 * Adds repositories to the list, skipping any already on it. Returns the paths
 * actually added. The whole list is written in a single update so adding
 * several folders at once can't drop entries to interleaved writes.
 */
export async function addConfiguredRepos(repoRoots: readonly string[]): Promise<string[]> {
  const repos = configuredRepos();
  const added: string[] = [];
  for (const repoRoot of repoRoots) {
    const normalized = normalize(repoRoot);
    if (normalized !== undefined && !repos.includes(normalized)) {
      repos.push(normalized);
      added.push(normalized);
    }
  }
  if (added.length > 0) {
    await write(repos);
  }
  return added;
}

/**
 * Puts the repositories this window has open onto the list. Called when a
 * window starts (and when its folders change), so opening a worktree is all it
 * takes for its repository to appear — here and, since the list is global, in
 * every other window too. Failures are logged rather than shown: the window is
 * starting up, and the user did not ask for anything yet.
 */
export async function rememberOpenRepos(): Promise<void> {
  const repoRoots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const repoRoot = await repoRootOf(folder.uri);
    if (repoRoot !== undefined) {
      repoRoots.push(repoRoot);
    }
  }
  try {
    const added = await addConfiguredRepos(repoRoots);
    if (added.length > 0) {
      log(`repos: added open ${added.join(', ')} to ${SETTING}`);
    }
  } catch (error) {
    log(`repos: could not save the open repositories: ${errorMessage(error)}`);
  }
}

/** Drops a repository from the list. A path that isn't on it is a no-op. */
export async function removeConfiguredRepo(repoRoot: string): Promise<void> {
  const repos = configuredRepos();
  const remaining = repos.filter((repo) => repo !== repoRoot);
  if (remaining.length !== repos.length) {
    await write(remaining);
  }
}

/** Fires when the list changes — including edits made in settings.json. */
export function onDidChangeConfiguredRepos(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SETTING)) {
      listener();
    }
  });
}

/** An entry in its stored form, or undefined if it isn't a usable path. */
function normalize(entry: unknown): string | undefined {
  if (typeof entry !== 'string' || entry.trim() === '') {
    return undefined;
  }
  const trimmed = entry.trim();
  const expanded =
    trimmed === '~' || trimmed.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  if (!path.isAbsolute(expanded)) {
    return undefined;
  }
  const normalized = path.normalize(expanded);
  // Guarded on length so a repo at the filesystem root doesn't normalize away.
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

function write(repos: string[]): Thenable<void> {
  return vscode.workspace
    .getConfiguration(SECTION)
    .update(KEY, repos, vscode.ConfigurationTarget.Global);
}
