import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { getMessage, readHistory, listThreads } from '../src/retrieval.js';

test('direct retrieval restricts participants and does not change receipts', t => {
  const { store } = fixture(t);
  store.register('reviewer', 'claude');
  const message = store.send('codex', { to: 'claude', body: 'private review' });
  assert.equal(getMessage(store, 'codex', message.id).body, 'private review');
  assert.equal(getMessage(store, 'claude', message.id).acknowledged_at, null);
  assert.throws(() => getMessage(store, 'reviewer', message.id), /not in your conversations/);
  assert.throws(() => getMessage(store, 'reviewer', 999), /not in your conversations/);
  assert.throws(() => getMessage(store, 'claude', 0));
});

test('history traverses latest-first across gaps and supports literal filtered search', t => {
  const { store } = fixture(t);
  store.register('reviewer', 'claude');
  const expected = [];
  for (let i = 0; i < 5; i++) {
    expected.push(store.send('codex', { to: 'claude', body: `Needle_% ${i}` }));
    store.send('codex', { to: 'reviewer', body: 'Needle_% other' });
  }
  const first = readHistory(store, 'claude', { order: 'desc', limit: 2, query: 'needle_%' });
  const second = readHistory(store, 'claude', { order: 'desc', limit: 2, before: first.next_before });
  const third = readHistory(store, 'claude', { order: 'desc', limit: 2, before: second.next_before });
  assert.deepEqual([...first.messages, ...second.messages, ...third.messages].map(m => m.id), expected.map(m => m.id).reverse());
  assert.equal(first.has_more, true);
  assert.equal(third.has_more, false);
  assert.equal(first.next_after, null);
  assert.equal(readHistory(store, 'claude', { query: "' OR 1=1 --" }).messages.length, 0);
  assert.equal(readHistory(store, 'claude', { peer: 'reviewer' }).messages.length, 0);
  assert.equal(readHistory(store, 'claude', { thread_id: expected[1].thread_id }).messages.length, 1);
  const asc = readHistory(store, 'claude', { limit: 2 });
  assert.equal(readHistory(store, 'claude', { after: asc.next_after }).messages[0].id, expected[2].id);
  assert.throws(() => readHistory(store, 'claude', { query: '' }));
  assert.throws(() => readHistory(store, 'claude', { order: 'invalid' }));
  assert.throws(() => readHistory(store, 'claude', { limit: 101 }));
});

test('thread pages use latest activity IDs, keep full summaries and count only recipient pending', t => {
  const { store } = fixture(t);
  store.register('reviewer', 'claude');
  const a = store.send('codex', { to: 'claude', body: 'oldest root' });
  const b = store.send('codex', { to: 'claude', body: 'second root' });
  store.send('codex', { to: 'reviewer', body: 'hidden' });
  const c = store.send('claude', { to: 'codex', body: 'third root' });
  const reply = store.send('claude', { to: 'codex', body: 'x'.repeat(300), reply_to: a.id });
  store.acknowledge('codex', [reply.id]);
  // Timestamp ties cannot reorder pages or cause skipped threads.
  store.db.prepare('UPDATE messages SET created_at=?').run('2026-01-01T00:00:00.000Z');
  const first = listThreads(store, 'codex', { peer: 'claude', limit: 2 });
  const second = listThreads(store, 'codex', { peer: 'claude', limit: 2, before: first.next_before });
  assert.deepEqual([...first.threads, ...second.threads].map(row => row.thread_id), [a.thread_id, c.thread_id, b.thread_id]);
  assert.equal(first.has_more, true);
  assert.equal(second.has_more, false);
  assert.equal(first.threads[0].message_count, 2);
  assert.equal(first.threads[0].pending, 0);
  assert.equal(first.threads[0].latest_message_preview.length, 240);
  assert.equal(first.threads[1].pending, 1);
  assert.equal(first.threads[0].peer, 'claude');
  assert.equal(listThreads(store, 'reviewer').threads.length, 1);
});
