import { strict as assert } from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { confirmedCompletion } from '../codexCompletion';
import { parseTimelineEvent, readTimeline } from '../codexTimeline';

const finished = { turnId: 'reply-2', status: 'task_complete' };
const database = { turnId: 'reply-2', status: 'completed' };
const hook = { turnId: 'reply-2' };

void test('completion needs matching hook, file and database, without an elapsed-time rule', () => {
  assert.equal(confirmedCompletion(finished, database, hook), 'reply-2');
  assert.equal(confirmedCompletion(finished, database, undefined), undefined);
  assert.equal(confirmedCompletion(finished, undefined, hook), undefined);
  assert.equal(confirmedCompletion(finished, database, { turnId: 'reply-1' }), undefined);
  assert.equal(confirmedCompletion(finished, { ...database, turnId: 'reply-1' }, hook), undefined);
  assert.equal(confirmedCompletion({ ...finished, turnId: undefined }, database, hook), undefined);
});

void test('ongoing and interrupted replies cannot announce success', () => {
  for (const status of ['task_started', 'turn_aborted', 'unknown']) {
    assert.equal(confirmedCompletion({ ...finished, status }, database, hook), undefined);
  }
  for (const status of ['inProgress', 'interrupted', 'failed']) {
    assert.equal(confirmedCompletion(finished, { ...database, status }, hook), undefined);
  }
});

function event(type: string, turnId: string): string {
  return JSON.stringify({
    payload: { turn_id: turnId, type },
    type: 'event_msg',
    timestamp: '2026-09-19T10:00:00Z',
  });
}

void test('event parsing accepts different field order and rejects malformed records', () => {
  assert.equal(parseTimelineEvent(event('task_complete', 'reply-2'))?.turnId, 'reply-2');
  assert.equal(parseTimelineEvent('{'), undefined);
  assert.equal(parseTimelineEvent('null'), undefined);
  assert.equal(parseTimelineEvent(event('agent_message', 'reply-2')), undefined);
});

void test('partial lines, long messages, continuation and truncation preserve the latest turn', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tab-manager-timeline-'));
  const filename = path.join(directory, 'session.jsonl');
  await fs.writeFile(filename, event('task_started', 'reply-1') + '\n');
  const handle = await fs.open(filename, 'r');
  try {
    assert.equal((await readTimeline(filename, handle)).status, 'task_started');
    const end = event('task_complete', 'reply-1');
    await fs.appendFile(filename, end.slice(0, 40));
    assert.equal((await readTimeline(filename, handle)).state, 'working');
    await fs.appendFile(filename, end.slice(40) + '\n');
    assert.equal((await readTimeline(filename, handle)).status, 'task_complete');
    const next = event('task_started', 'reply-2');
    await fs.appendFile(filename, next.slice(0, 20));
    const partial = await readTimeline(filename, handle);
    assert.equal(confirmedCompletion(partial, database, hook), undefined);
    await fs.appendFile(filename, next.slice(20) + '\n');
    await fs.appendFile(filename, JSON.stringify({ message: 'ก'.repeat(300_000) }) + '\n');
    const resumed = await readTimeline(filename, handle);
    assert.equal(resumed.status, 'task_started');
    assert.equal(confirmedCompletion(resumed, database, hook), undefined);
    await fs.truncate(filename, 0);
    assert.equal((await readTimeline(filename, handle)).status, 'unknown');
  } finally {
    await handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
