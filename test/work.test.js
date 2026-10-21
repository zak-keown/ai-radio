import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RadioStore } from '../src/store.js';

test('durable acceptance survives restart and separates transport acknowledgment from completion', t => {
  const { store, project } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'Review parser; return test evidence.' });
  store.work('claude', { id: message.id, state: 'accepted', key: 'parser-review' });
  assert.equal(store.inbox('claude').messages.length, 0);
  assert.equal(store.work('codex', message.id).work.state, 'accepted');
  const resumed = new RadioStore(project); t.after(() => resumed.close());
  assert.equal(resumed.workList('claude', { state: 'accepted' }).work[0].claim_key, 'parser-review');
  assert.throws(() => resumed.work('claude', { id: message.id, state: 'accepted', key: 'new-operation' }), /already claimed/);
  resumed.work('claude', { id: message.id, state: 'in_progress', key: 'parser-review' });
  resumed.work('claude', { id: message.id, state: 'blocked', key: 'parser-review', detail: 'Need fixture' });
  resumed.work('claude', { id: message.id, state: 'in_progress', key: 'parser-review' });
  resumed.work('claude', { id: message.id, state: 'completed', key: 'parser-review', result_ref: 'test/parser.test.js' });
  assert.equal(store.work('codex', message.id).work.result_ref, 'test/parser.test.js');
  assert.throws(() => store.work('claude', { id: message.id, state: 'accepted', key: 'parser-review' }), /Cannot change completed/);
});

test('work claims restrict recipient authority and rollback invalid transitions without acknowledging', t => {
  const { store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'Task' });
  assert.throws(() => store.work('codex', { id: message.id, state: 'accepted', key: 'x' }), /Only the recipient/);
  assert.throws(() => store.work('claude', { id: message.id, state: 'completed', key: 'x' }), /First accept/);
  assert.equal(store.inbox('claude').messages.length, 1);
  store.register('reviewer','claude');
  assert.throws(() => store.work('reviewer', message.id), /not in your conversations/);
  store.work('claude', { id: message.id, state: 'declined', key: 'x', detail: 'Outside scope' });
  assert.equal(store.workList('reviewer').work.length, 0);
  assert.throws(() => store.work('claude', { id: message.id, state: 'in_progress', key: 'x' }), /Cannot change declined/);
});

test('work recovery pages include accepted requests even after inbox acknowledgment', t => {
  const { store } = fixture(t);
  for (let i=0;i<4;i++) {
    const m = store.send('codex', { to:'claude', body:`task ${i}` });
    store.work('claude', { id:m.id, state:'accepted', key:`task-${i}` });
  }
  const first = store.workList('claude', { limit:2 });
  const next = store.workList('claude', { limit:2, after:first.next_after });
  assert.equal(first.has_more,true);
  assert.equal(next.has_more,false);
  assert.equal(new Set([...first.work,...next.work].map(w=>w.message_id)).size,4);
});
