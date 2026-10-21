import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fixture, until } from './helpers.js';

test('Codex bridge pushes to exact idle thread then steers its active turn without an inbox call', async t => {
  const { project, store } = fixture(t);
  const log = join(project, 'rpc.jsonl');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/runner.js', import.meta.url))], {
    env: { ...process.env, RADIO_TEST_PROJECT: project, RADIO_TEST_LOG: log }, stdio: ['pipe','pipe','pipe'],
  });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; }); child.stdout.resume();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.stdin.end('/quit\n'); await until(() => child.exitCode !== null || child.signalCode !== null).catch(e => { console.error(stderr); child.kill('SIGKILL'); throw e; }); } });
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  await until(() => stderr.includes('thread test-thread')).catch(e => { console.error(stderr, requests()); throw e; });
  const first = store.send('claude', { to: 'codex', body: 'idle push' });
  await until(() => store.history('codex').messages.find(m => m.id === first.id)?.delivered_at).catch(e => { console.error(stderr, requests()); throw e; });
  const second = store.send('claude', { to: 'codex', body: 'busy push' });
  await until(() => store.history('codex').messages.find(m => m.id === second.id)?.delivered_at).catch(e => { console.error(stderr, requests()); throw e; });
  const turns = requests().filter(m => m.method.startsWith('turn/'));
  assert.deepEqual(turns.map(m => m.method), ['turn/start','turn/steer']);
  assert.equal(turns[0].params.threadId, 'test-thread');
  assert.equal(turns[1].params.expectedTurnId, 'turn-1');
  assert.match(turns[0].params.input[0].text, /idle push/);
  assert.match(turns[1].params.input[0].text, /busy push/);
  assert.equal(store.inbox('codex').messages.length, 2);
  const thread = requests().find(m => m.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'read-only');
  assert.equal(thread.params.approvalPolicy, 'never');
});
