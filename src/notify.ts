import { execFile } from 'child_process';
import { promisify } from 'util';
import { errorMessage } from './cli';
import { log } from './log';

const run = promisify(execFile);

/** Newlines, tabs and the like, which a notification cannot show anyway. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Posts a macOS notification — a banner now, and an entry in Notification
 * Center after — so a session that wants you is visible without VS Code being
 * the focused app.
 *
 * A failure only costs one banner, so it is logged rather than shown: a popup
 * apologising for a missing popup helps nobody.
 */
export async function notify(title: string, message: string): Promise<void> {
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  try {
    // execFile, not exec: the script reaches osascript as one argument and is
    // never seen by a shell, so nothing in a session name or branch can run.
    await run('osascript', ['-e', script]);
  } catch (error) {
    log(`notify: could not post "${title}" — ${errorMessage(error)}`);
  }
}

/**
 * `text` as an AppleScript string literal. Control characters are dropped
 * first, which leaves JSON's escaping and AppleScript's agreeing on every
 * character that survives — both write a quote as `\"` and a backslash as
 * `\\`, and those are then the only two escapes in play.
 */
function appleScriptString(text: string): string {
  return JSON.stringify(text.replace(CONTROL_CHARACTERS, ' '));
}
