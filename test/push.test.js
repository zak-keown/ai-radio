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

test('paused and quiet mailboxes retain mail without delivering, including after restart', async t => {
  const { store, project } = fixture(t);
  store.setPresence('claude','paused');
  const received=[];
  let stop=startPush(store,'claude',async messages=>received.push(...messages));
  const message=store.send('codex',{to:'claude',body:'hold until human resumes'});
  await setTimeout(1100);
  assert.equal(received.length,0);
  stop();
  const { RadioStore }=await import('../src/store.js');
  const second=new RadioStore(project);t.after(()=>second.close());
  assert.equal(second.presence('claude').mode,'paused');
  stop=startPush(second,'claude',async messages=>received.push(...messages));t.after(()=>stop());
  await setTimeout(1100);
  assert.equal(received.length,0);
  assert.equal(second.inbox('claude').messages[0].id,message.id);
  second.setPresence('claude','active');
  await until(()=>received.length===1);
  second.setPresence('claude','quiet');
  second.send('codex',{to:'claude',body:'quiet keeps this too'});
  await setTimeout(1100);
  assert.equal(received.length,1);
});

test('ambiguous queue acceptance is never resent automatically, even after bridge restart', async t => {
  const { store }=fixture(t);
  const message=store.send('claude',{to:'codex',body:'one queue submission only'});
  let attempts=0;
  let stop=startPush(store,'codex',async()=>{attempts++;throw new Error('Timed out after transport acceptance');},()=>{}, {durableOnce:true});
  await until(()=>attempts===1);
  await setTimeout(1100);assert.equal(attempts,1);
  stop();
  stop=startPush(store,'codex',async()=>{attempts++;},()=>{}, {durableOnce:true});t.after(()=>stop());
  await setTimeout(1100);
  assert.equal(attempts,1);
  assert.equal(store.inbox('codex').messages[0].id,message.id);
  assert.equal(store.history('codex').messages[0].delivered_at,null);
});

test('large backlogs advance across bounded batches without starving newer messages', async t => {
  const { store } = fixture(t);
  const ids = Array.from({ length: 225 }, (_, i) => store.send('codex', { to: 'claude', body: `request ${i}` }).id);
  const batches = [];
  const stop = startPush(store, 'claude', async messages => batches.push(messages.map(m => m.id)));
  t.after(stop);
  await until(() => batches.flat().length === ids.length);
  assert.ok(batches.every(batch => batch.length <= 100));
  assert.deepEqual(batches.flat(), ids);
  assert.equal(store.inbox('claude', { limit: 100 }).messages.length, 100);
});

test('recovery hooks expose failures and successful retries in transport order', async t => {
  const { store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'observable transport' });
  const events = [];
  for (const method of ['recordAttempt', 'recordFailure', 'recordDelivery']) {
    store[method] = (agent, ids, ...details) => events.push({ method, agent, ids, details });
  }
  let attempts = 0;
  const stop = startPush(store, 'claude', async () => {
    if (++attempts === 1) throw new Error('offline');
  }, () => {});
  t.after(stop);
  await until(() => events.some(event => event.method === 'recordDelivery'));
  assert.deepEqual(events.map(event => event.method), ['recordAttempt', 'recordFailure', 'recordAttempt', 'recordDelivery']);
  assert.ok(events.every(event => event.agent === 'claude' && event.ids[0] === message.id));
  assert.equal(events[0].details[0].policy, 'session_once');
  assert.equal(events[1].details[0].message, 'offline');
  assert.equal(events[1].details[1].retryAfterMs, Infinity);
});

test('failed attempts honor backoff despite watcher writes and consumer restart', async t => {
  const { store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'offline transport' });
  let attempts = 0;
  const options = { retryAfterMs: 30000 };
  let stop = startPush(store, 'claude', async () => { attempts++; throw new Error('offline'); }, () => {}, options);
  t.after(() => stop());
  await until(() => attempts === 1);
  await setTimeout(1100);
  assert.equal(attempts, 1);
  assert.ok(store.delivery('codex', message.id).attempt.next_retry_at);
  stop();
  assert.equal(store.delivery('codex', message.id).attempt.next_retry_at, null);
  stop = startPush(store, 'claude', async () => { attempts++; }, () => {}, options);
  await setTimeout(1100);
  assert.equal(attempts, 1);
});
