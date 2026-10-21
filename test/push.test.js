import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { startPush } from '../src/push.js';
import { fixture, until } from './helpers.js';

test('push retries failures, retains pending mail and excludes competing consumers', async t => {
  const { store } = fixture(t);
  let attempts = 0;
  const received = [];
  const errors = [];
  const stop = startPush(store, 'claude', async messages => {
    if (++attempts === 1) throw new Error('transport unavailable');
    received.push(...messages);
  }, e => errors.push(e.message)); t.after(stop);
  const competitor = [];
  const stopOther = startPush(store, 'claude', async messages => competitor.push(...messages), () => {}); t.after(stopOther);
  const message = store.send('codex', { to: 'claude', body: 'survives' });
  await until(() => received.length === 1);
  assert.equal(received[0].id, message.id);
  assert.ok(errors.includes('transport unavailable'));
  assert.equal(competitor.length, 0);
  assert.equal(store.inbox('claude').messages.length, 1);
  const calls = attempts;
  await setTimeout(1100);
  assert.equal(attempts, calls);
});

test('channel retries transport-accepted but unacknowledged events until recipient acknowledges', async t => {
  const { store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'arrived during startup' });
  let attempts = 0;
  const stop = startPush(store, 'claude', async messages => {
    attempts++;
    // Simulate an initial notification silently dropped by the host client.
    if (attempts === 2) store.acknowledge('claude', messages.map(m => m.id));
  }, e => { throw e; }, { retryAfterMs: 200 }); t.after(stop);
  await until(() => attempts === 2);
  assert.equal(store.inbox('claude').messages.length, 0);
  assert.ok(store.history('claude').messages.find(m => m.id === message.id).delivered_at);
  await setTimeout(1100);
  assert.equal(attempts, 2);
});
