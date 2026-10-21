import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fixture } from './helpers.js';
import { RadioStore } from '../src/store.js';

test('commit, reopen, non-destructive reads and recipient-only atomic receipts', t => {
  const { project, store } = fixture(t);
  const first = store.send('codex', { to: 'claude', body: 'review' });
  const second = store.send('claude', { to: 'codex', body: 'ready' });
  const other = new RadioStore(project); t.after(() => other.close());
  assert.equal(other.inbox('claude').messages[0].id, first.id);
  assert.equal(other.inbox('claude').messages.length, 1);
  assert.throws(() => other.acknowledge('claude', [first.id, second.id]), /not in your inbox/);
  assert.equal(other.inbox('claude').messages.length, 1);
  other.acknowledge('claude', [first.id]); other.acknowledge('claude', [first.id]);
  assert.equal(store.inbox('claude').messages.length, 0);
  assert.ok(store.history('claude').messages[0].acknowledged_at);
  if (process.platform !== 'win32') {
    assert.equal(statSync(store.directory).mode & 0o777, 0o700);
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
  }
});

test('retries are idempotent, collisions rejected, thread participants enforced', t => {
  const { store } = fixture(t);
  const input = { to: 'claude', body: 'question', key: 'request-1' };
  const first = store.send('codex', input);
  assert.equal(store.send('codex', input).id, first.id);
  assert.throws(() => store.send('codex', { ...input, body: 'different' }), /Retry key/);
  const reply = store.send('claude', { to: 'codex', body: 'answer', reply_to: first.id });
  assert.equal(reply.thread_id, first.thread_id);
  store.register('reviewer', 'claude');
  assert.throws(() => store.send('reviewer', { to: 'codex', body: 'intrude', reply_to: first.id }), /between you/);
  assert.equal(store.history('reviewer').messages.length, 0);
  assert.throws(() => store.register('codex', 'claude'), /belongs to/);
  assert.throws(() => store.register('other', 'gemini'));
  assert.throws(() => store.send('codex', { to: 'claude', body: ' ' }));
  assert.throws(() => store.send('codex', { to: 'missing', body: 'x' }), /Unknown agent/);
});

test('pagination stays ordered across gaps and filters exclude other conversations', t => {
  const { store } = fixture(t);
  store.register('reviewer', 'claude');
  for (let i = 0; i < 5; i++) {
    store.send('codex', { to: 'claude', body: String(i) });
    store.send('codex', { to: 'reviewer', body: 'other' });
  }
  const first = store.inbox('claude', { limit: 2 });
  assert.equal(first.has_more, true);
  const next = store.inbox('claude', { limit: 2, after: first.next_after });
  assert.deepEqual([...first.messages, ...next.messages].map(m => m.body), ['0','1','2','3']);
  assert.equal(store.history('claude', { peer: 'reviewer' }).messages.length, 0);
  assert.throws(() => store.inbox('claude', { limit: -1 }));
  assert.throws(() => store.inbox('claude', { after: NaN }));
});

test('push lease excludes another consumer, renews without constant writes, expires', t => {
  const { store } = fixture(t);
  assert.equal(store.lease('claude', 'a', 1000), true);
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
  const before = changes();
  assert.equal(store.lease('claude', 'a', 2000), true);
  assert.equal(changes(), before);
  assert.equal(store.lease('claude', 'b', 2000), false);
  assert.equal(store.lease('claude', 'b', 11001), true);
  store.release('claude', 'a');
  assert.equal(store.lease('claude', 'a', 12000), false);
});

test('peer packets preserve message identity in a structured envelope', async () => {
  const { peerText } = await import('../src/store.js');
  const packet = JSON.parse(peerText([{id:12,sender:'claude',recipient:'codex',body:'Ready.',thread_id:'thread',reply_to:9}]));
  assert.equal(packet.messages[0].id, 12);
  assert.equal(packet.messages[0].reply_to, 9);
  assert.equal(packet.messages[0].body, 'Ready.');
});
