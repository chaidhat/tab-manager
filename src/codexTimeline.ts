import * as fs from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { CompletionEvidence } from './codexCompletion';

export interface Timeline extends CompletionEvidence {
  readonly state: 'working' | 'done';
  readonly stateSince: number;
}

interface Cursor {
  offset: number;
  pending: string;
  decoder: StringDecoder;
  timeline: Timeline;
  inode: number;
}

const cursors = new Map<string, Cursor>();

export function parseTimelineEvent(line: string): Timeline | undefined {
  let record: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  if (!record || record.type !== 'event_msg' || !record.payload) {
    return undefined;
  }
  const { type, turn_id: turnId } = record.payload;
  if (type !== 'task_started' && type !== 'task_complete' && type !== 'turn_aborted') {
    return undefined;
  }
  const timestamp = Date.parse(record.timestamp ?? '');
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return {
    status: type,
    turnId: typeof turnId === 'string' && turnId !== '' ? turnId : undefined,
    state: type === 'task_started' ? 'working' : 'done',
    stateSince: timestamp,
  };
}

/** Read complete lines once, retaining partial UTF-8 and JSON for the next pass. */
export async function readTimeline(filename: string, handle: fs.FileHandle): Promise<Timeline> {
  const stat = await handle.stat();
  let cursor = cursors.get(filename);
  if (!cursor || cursor.inode !== stat.ino || cursor.offset > stat.size) {
    cursor = {
      offset: 0,
      pending: '',
      decoder: new StringDecoder('utf8'),
      inode: stat.ino,
      timeline: {
        state: 'working',
        stateSince: stat.mtimeMs,
        status: 'unknown',
        turnId: undefined,
      },
    };
    cursors.set(filename, cursor);
  }
  const buffer = Buffer.alloc(64 * 1024);
  while (cursor.offset < stat.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - cursor.offset),
      cursor.offset,
    );
    if (bytesRead === 0) {
      break;
    }
    cursor.offset += bytesRead;
    const lines = (cursor.pending + cursor.decoder.write(buffer.subarray(0, bytesRead))).split(
      '\n',
    );
    cursor.pending = lines.pop() ?? '';
    for (const line of lines) {
      cursor.timeline = parseTimelineEvent(line) ?? cursor.timeline;
    }
  }
  // A partial next event might be a new turn. Do not confirm the preceding finish.
  return cursor.pending.length > 0
    ? { ...cursor.timeline, state: 'working', status: 'partial', turnId: undefined }
    : cursor.timeline;
}
