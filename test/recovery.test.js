import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';
import { RadioStore } from '../src/store.js';
import { startPush } from '../src/push.js';
import { errorResult } from '../src/recovery.js';

test('retry times describe eligibility only with a live active consumer', t => {
  const { store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'request' });
  const options = { policy: 'until_acknowledged', retryAfterMs: 30000 };
  store.lease('claude', 'consumer');
  store.recordAttempt('claude', [message.id], options);
  assert.equal(store.delivery('codex', message.id).attempt.next_retry_at, null);
  const before = Date.now();
  store.recordFailure('claude', [message.id], new Error('offline'), options);
  const active = store.delivery('codex', message.id);
  assert.ok(Date.parse(active.attempt.next_retry_at) >= before + 30000);
  assert.equal(active.attempt.next_retry_at, active.attempt.retry_not_before);
  store.release('claude', 'consumer');
  const disconnected = store.delivery('codex', message.id);
  assert.equal(disconnected.attempt.next_retry_at, null);
  assert.equal(disconnected.attempt.retry_not_before, active.attempt.retry_not_before);
  assert.match(disconnected.recovery, /No live push consumer/);
  store.lease('claude', 'consumer');
  store.setPresence('claude', 'paused');
  assert.equal(store.delivery('codex', message.id).attempt.next_retry_at, null);
  store.setPresence('claude', 'active');
  store.acknowledge('claude', [message.id]);
  assert.equal(store.delivery('codex', message.id).attempt.next_retry_at, null);
});

test('durable once ambiguity never advertises an automatic retry', t => {
  const { store } = fixture(t);
  const message = store.send('claude', { to: 'codex', body: 'request' });
  const options = { policy: 'durable_once', retryAfterMs: Infinity };
  store.lease('codex', 'consumer');
  store.recordAttempt('codex', [message.id], options);
  store.recordFailure('codex', [message.id], new Error('ambiguous'), options);
  const result = store.delivery('claude', message.id);
  assert.equal(result.attempt.next_retry_at, null);
  assert.equal(result.attempt.retry_not_before, null);
  assert.match(result.recovery, /resubmission is suppressed/);
});

test('native SQLite busy errors are retryable and internal error codes stay stable', () => {
  for (const error of [Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }), Object.assign(new Error('contention'), { code: 'SQLITE_BUSY_SNAPSHOT' }), Object.assign(new Error('contention'), { errcode: 262 })]) {
    assert.equal(errorResult(error).error.code, 'STORE_BUSY');
    assert.equal(errorResult(error).error.retryable, true);
  }
  const internal = errorResult(Object.assign(new Error('disk failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }));
  assert.equal(internal.error.code, 'OPERATION_FAILED');
  assert.equal(internal.error.retryable, false);
});

test('durable suppression is atomic with telemetry and legacy markers remain visible', t => {
  const { store } = fixture(t);
  const message = store.send('claude', { to: 'codex', body: 'request' });
  store.recordAttempt('codex', [message.id], { policy: 'durable_once' });
  assert.equal(store.attempted('codex', message.id), true);
  store.db.prepare('DELETE FROM delivery_status WHERE message_id=?').run(message.id);
  const legacy = store.delivery('claude', message.id);
  assert.equal(legacy.attempt.policy, 'durable_once');
  assert.equal(legacy.attempt.next_retry_at, null);
  assert.match(legacy.recovery, /resubmission is suppressed/);
  const incoming = store.send('codex', { to: 'claude', body: 'wrong mailbox' });
  assert.throws(() => store.recordAttempt('codex', [message.id, incoming.id], { policy: 'durable_once' }), /not in this mailbox/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM delivery_status').get().n, 0);
});

test('ambiguous durable queue diagnostics survive reopening the database', async t => {
  const { store, project } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'Request' });
  const stop = startPush(store, 'claude', async () => { throw new Error('Timed out after submission'); }, () => {}, { durableOnce: true });
  t.after(stop);
  await until(() => store.delivery('codex', message.id).attempt?.last_error);
  stop();
  const reopened = new RadioStore(project); t.after(() => reopened.close());
  const result = reopened.delivery('claude', message.id);
  assert.equal(result.attempt.attempts, 1);
  assert.equal(result.attempt.policy, 'durable_once');
  assert.equal(result.attempt.outcome, 'ambiguous');
  assert.equal(result.attempt.next_retry_at, null);
  assert.equal(reopened.message('claude', message.id).body, 'Request');
  reopened.register('other', 'claude');
  assert.throws(() => reopened.delivery('other', message.id), /not in your conversations/);
});
