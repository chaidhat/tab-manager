import * as fs from 'fs/promises';
import { watch, FSWatcher } from 'fs';
import { CODEX_COMPLETIONS_DIR } from './codexCompletion';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { errorMessage } from './cli';
import { readSessions, Session, SessionState } from './claudeSessions';
import { isCodexCompletionCurrent, readCodexSessions } from './codexSessions';
import { COMMANDS } from './commands';
import { log } from './log';
import { notify } from './notify';
import { OpenWindowRegistry } from './openWindows';
import { configuredRepos, onDidChangeConfiguredRepos } from './repos';

// How often the session files are re-read. Reading a handful of small files is
// cheap enough not to be worth avoiding, and polling stays right where a file
// watcher would not: a session killed with `SIGKILL` leaves its file behind
// and produces no filesystem event at all, so its row would never disappear.
const POLL_INTERVAL_MS = 1000;

// Where a window records that it has posted a notification, so that the other
// windows — all running this same extension — do not post it again. See
// claimNotification.
const MARKERS_DIR = path.join(os.homedir(), '.claude', 'tab-manager', 'notified');

/** How long a marker outlives its session, for markers no poll got to prune. */
const MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const ICON: Record<SessionState, vscode.ThemeIcon> = {
  asking: new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.red')),
  working: new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue')),
  done: new vscode.ThemeIcon('check'),
};
const SUBAGENT_ICON = new vscode.ThemeIcon('sparkle');

/**
 * The "Agent Sessions" view: every open Claude Code or Codex session in one of your
 * repositories, what it is doing, and how long it has been doing it — sessions
 * that want you at the top.
 *
 * It also posts a macOS notification the moment a session starts asking for
 * something or finishes working, which is the point of the view: a session can
 * otherwise sit on a question for ten minutes in a window you cannot see.
 */
export class SessionMonitor implements vscode.TreeDataProvider<Session>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly timer: NodeJS.Timeout;
  private view: vscode.TreeView<Session> | undefined;

  private sessions: Session[] = [];
  // What the rows currently say. The tree is only asked to re-render when this
  // changes, so an unchanged list does not repaint once a second — and because
  // it is the rendered text, a row whose age ticks over does repaint.
  private rendered = '';
  // sessionId -> the state we last saw it in. Empty until the first poll lands,
  // which is what keeps a window that has just opened from announcing every
  // session already sitting there.
  private readonly lastState = new Map<string, SessionState>();
  private readonly lastCompletion = new Map<string, string | undefined>();
  private seeded = false;
  // Whether a poll is still running. Posting a notification means waiting on
  // osascript, so a slow one would otherwise have the next tick start before it
  // finished and leave two passes reading the same files at once.
  private polling = false;
  private pollAgain = false;
  private disposed = false;
  private completionWatcher: FSWatcher | undefined;

  constructor(private readonly openWindows: OpenWindowRegistry) {
    this.subscriptions = [
      // Adding or removing a repository changes which sessions are in scope.
      onDidChangeConfiguredRepos(() => void this.poll()),
    ];
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    void this.watchCompletions();
    void this.poll();
  }

  private async watchCompletions(): Promise<void> {
    try {
      await fs.mkdir(CODEX_COMPLETIONS_DIR, { recursive: true, mode: 0o700 });
      if (this.disposed) {
        return;
      }
      this.completionWatcher = watch(CODEX_COMPLETIONS_DIR, () => void this.poll());
      this.completionWatcher.on('error', () => {
        log('sessions: completion watcher failed, continuing with file checks');
        this.completionWatcher?.close();
      });
    } catch {
      log('sessions: could not watch completions, continuing with file checks');
    }
  }

  /** Gives the monitor its view, which it needs to put a count on the icon. */
  attachView(view: vscode.TreeView<Session>): void {
    this.view = view;
    this.updateBadge();
  }

  getChildren(element?: Session): Session[] {
    return this.sessions.filter((session) =>
      element
        ? session.parentSessionId === element.sessionId
        : session.parentSessionId === undefined,
    );
  }

  getTreeItem(session: Session): vscode.TreeItem {
    const hasChildren = this.sessions.some((child) => child.parentSessionId === session.sessionId);
    const item = new vscode.TreeItem(
      session.parentSessionId === undefined ? `${session.agent} · ${session.name}` : session.name,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = sessionKey(session);
    item.description = describe(session);
    item.iconPath = session.parentSessionId === undefined ? ICON[session.state] : SUBAGENT_ICON;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.parentSessionId === undefined ? `${session.agent} · ` : 'Subagent · '}${session.name}** — ${describe(session)}`,
        // As code, so a path containing underscores stays a path.
        `\`${homeRelative(session.cwd)}\``,
        'Click to open this folder in a new window.',
      ].join('\n\n'),
    );
    item.command = {
      command: COMMANDS.openWindow,
      title: 'Open Session Folder in New Window',
      arguments: [vscode.Uri.file(session.cwd).toString()],
    };
    return item;
  }

  /**
   * Re-reads the session files, announces what changed, and re-renders the
   * view if anything it shows is different. Errors cannot escape: the timer
   * that calls this has nowhere to report them, and a session list that failed
   * to load is an empty one.
   */
  private async poll(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      const repoRoots = configuredRepos();
      const sessions = (
        await Promise.all([
          readSessions(repoRoots),
          this.openWindows.folders().then((folders) => readCodexSessions(repoRoots, folders)),
        ])
      )
        .flat()
        .sort(compareSessions);
      await this.announce(sessions);
      this.sessions = sessions;

      const rendered = sessions
        .map((s) => `${sessionKey(s)}|${s.parentSessionId ?? ''}|${s.name}|${describe(s)}`)
        .join('\n');
      if (rendered !== this.rendered) {
        this.rendered = rendered;
        this.emitter.fire();
        this.updateBadge();
      }
    } catch (error) {
      log(`sessions: poll failed — ${errorMessage(error)}`);
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    }
  }

  /**
   * Posts a notification for each session that has just started asking for
   * something, or has a newly confirmed Codex completion. No inactivity delay
   * is used. The first poll of a
   * window only records where everything stands, so opening a window is silent.
   */
  private async announce(sessions: readonly Session[]): Promise<void> {
    const topLevelSessions = sessions.filter((session) => session.parentSessionId === undefined);
    const live = new Set(topLevelSessions.map(sessionKey));
    const vanished = [...this.lastState.keys()].filter((id) => !live.has(id));
    for (const id of vanished) {
      this.lastState.delete(id);
      this.lastCompletion.delete(id);
    }

    for (const session of topLevelSessions) {
      const key = sessionKey(session);
      const before = this.lastState.get(key);
      const previousCompletion = this.lastCompletion.get(key);
      this.lastState.set(key, session.state);
      this.lastCompletion.set(key, session.completionId);
      if (!this.seeded) {
        continue;
      }

      if (
        session.agent === 'Codex' &&
        session.state === 'done' &&
        session.completionId !== undefined &&
        session.completionId !== previousCompletion
      ) {
        await this.post(
          session,
          `${session.agent} · ${session.name} finished`,
          homeRelative(session.cwd),
        );
      }

      if (session.state === before) {
        continue;
      }
      // Every other move is noise: a session picking up work is not news, and
      // one drifting between its two flavours of idle has not done anything.
      if (session.state === 'asking') {
        await this.post(
          session,
          `${session.agent} · ${session.name} is asking`,
          session.waitingFor ?? 'Waiting for your input',
        );
      } else if (session.agent !== 'Codex' && session.state === 'done' && before === 'working') {
        await this.post(
          session,
          `${session.agent} · ${session.name} finished`,
          homeRelative(session.cwd),
        );
      }
    }

    this.seeded = true;
    if (vanished.length > 0) {
      await pruneMarkers(live);
    }
  }

  /** Posts one notification, unless another window got there first. */
  private async post(session: Session, title: string, message: string): Promise<void> {
    if (session.agent === 'Codex' && !(await isCodexCompletionCurrent(session))) {
      this.lastCompletion.delete(sessionKey(session));
      return;
    }
    if (await claimNotification(session)) {
      log(`sessions: ${title}`);
      await notify(title, message);
    }
  }

  /** The count of sessions waiting on you, on the activity-bar icon. */
  private updateBadge(): void {
    if (!this.view) {
      return;
    }
    const asking = this.sessions.filter((session) => session.state === 'asking').length;
    this.view.badge =
      asking === 0
        ? undefined
        : {
            value: asking,
            tooltip: `${asking} agent session${asking === 1 ? '' : 's'} waiting for you`,
          };
  }

  dispose(): void {
    this.disposed = true;
    this.completionWatcher?.close();
    clearInterval(this.timer);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.emitter.dispose();
  }
}

/** A row's right-hand text: what the session is doing, and for how long. */
function describe(session: Session): string {
  const what =
    session.activity ??
    (session.state === 'asking'
      ? (session.waitingFor ?? 'waiting')
      : session.state === 'working'
        ? 'working'
        : 'done');
  return `${what} · ${age(Date.now() - session.stateSince)}`;
}

const STATE_ORDER: Record<SessionState, number> = { asking: 0, working: 1, done: 2 };

function compareSessions(left: Session, right: Session): number {
  return (
    STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
    left.name.localeCompare(right.name) ||
    left.agent.localeCompare(right.agent)
  );
}

function sessionKey(session: Session): string {
  return `${session.agent.toLowerCase()}:${session.sessionId}`;
}

/** A duration, in the largest unit that leaves it readable: `8s`, `14m`, `2h`. */
function age(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 60 * 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.floor(seconds / 3600)}h`;
}

/** A path with the home directory written as `~`, which is how you read it. */
function homeRelative(target: string): string {
  const home = os.homedir();
  return target === home || target.startsWith(`${home}${path.sep}`)
    ? `~${target.slice(home.length)}`
    : target;
}

/**
 * Whether this window should be the one to post a session's notification.
 *
 * Every open VS Code window runs this extension, so all of them notice the same
 * change at the same time. Rather than elect one to be the notifier — a lock
 * to hold, a heartbeat to keep up, and silence if its window is force-quit —
 * each window tries to create the same marker file with the exclusive-create
 * flag, and only the one whose create succeeds posts. The filesystem settles
 * the race, so there is nothing to hold and nothing to recover.
 *
 * A failed claim is logged and does not produce a duplicate notification.
 */
async function claimNotification(session: Session): Promise<boolean> {
  const marker = path.join(MARKERS_DIR, markerName(session));
  try {
    await fs.mkdir(MARKERS_DIR, { recursive: true });
    await fs.writeFile(marker, '', { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false; // another window is posting this one
    }
    log(`sessions: could not claim a notification — ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The marker for one state change. Keyed on when the session entered the state
 * so the same session asking again later is a new notification, and stripped of
 * anything that is not a plain filename character — the parts come out of a
 * file this extension does not write.
 */
function markerName(session: Session): string {
  return `${safeName(sessionKey(session))}-${safeName(session.completionId ?? String(session.stateSince))}-${session.state}`;
}

/** A string reduced to plain filename characters. */
function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Drops markers belonging to sessions that are gone, and any left behind by a
 * session that ended while VS Code was closed.
 */
async function pruneMarkers(live: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(MARKERS_DIR);
  } catch {
    return; // nothing has been written yet
  }
  const oldest = Date.now() - MARKER_MAX_AGE_MS;
  // Matched in the form the markers were written in, not the raw session ids.
  const livePrefixes = [...live].map(safeName);
  await Promise.all(
    names.map(async (name) => {
      const marker = path.join(MARKERS_DIR, name);
      try {
        const belongsToLiveSession = livePrefixes.some((id) => name.startsWith(id));
        if (belongsToLiveSession && (await fs.stat(marker)).mtimeMs > oldest) {
          return;
        }
        await fs.rm(marker, { force: true });
      } catch (error) {
        log(`sessions: could not prune ${name} — ${errorMessage(error)}`);
      }
    }),
  );
}
