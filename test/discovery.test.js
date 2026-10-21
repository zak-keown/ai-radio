import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RadioStore } from '../src/store.js';
import { installDiscovery, getProfile, updateProfile, listAgents } from '../src/discovery.js';

function discovery(t) {
  const context = fixture(t);
  installDiscovery(context.store);
  return context;
}

test('discovery distinguishes paused delivery, advertised claims, and live consumer leases', t => {
  const { store } = discovery(t);
  store.setPresence('claude', 'paused');
  updateProfile(store, 'claude', { role: 'reviewer', capabilities: ['code review'], current_task: 'Reviewing storage', sandbox: 'read-only' });
  store.send('codex', { to: 'claude', body: 'Review the change' });
  store.lease('claude', 'channel');
  const peer = listAgents(store).find(a => a.name === 'claude');
  assert.equal(peer.delivery_mode, 'paused');
  assert.equal(peer.pending, 1);
  assert.equal(peer.observed.session_freshness, 'leased');
  assert.equal(peer.push_connected, true);
  assert.equal(peer.advertised.source, 'self_advertised');
  assert.equal(peer.advertised.sandbox, 'read-only');
  assert.equal(peer.advertised.current_task, 'Reviewing storage');
  assert.ok(peer.observed.lease_expires_at);
  assert.equal('ready' in peer.observed, false);
  store.db.prepare('UPDATE leases SET expires=? WHERE agent=?').run(Date.now() - 1, 'claude');
  const expired = listAgents(store).find(a => a.name === 'claude');
  assert.equal(expired.observed.session_freshness, 'expired');
  assert.equal(expired.push_connected, false);
  assert.deepEqual(expired.advertised, peer.advertised);
  store.release('claude', 'channel');
  assert.equal(listAgents(store).find(a => a.name === 'claude').observed.session_freshness, 'disconnected');
});

test('profiles persist, allow clearing, and partial writes preserve unrelated fields', t => {
  const { store, project } = discovery(t);
  assert.deepEqual(getProfile(store, 'codex'), { agent: 'codex', source: 'self_advertised', role: null, capabilities: [], current_task: null, sandbox: 'unknown', updated_at: null });
  updateProfile(store, 'codex', { role: ' coder ', capabilities: ['JavaScript', 'JavaScript'], current_task: 'Fix bug', sandbox: 'workspace-write' });
  const updated = updateProfile(store, 'codex', { current_task: null });
  assert.equal(updated.role, 'coder');
  assert.equal(updated.current_task, null);
  assert.deepEqual(updated.capabilities, ['JavaScript']);
  assert.ok(updated.updated_at);
  assert.equal(getProfile(store, 'claude').updated_at, null);
  const other = new RadioStore(project); t.after(() => other.close());
  installDiscovery(other);
  assert.deepEqual(getProfile(other, 'codex'), updated);
  assert.deepEqual(updateProfile(store, 'codex', {}), updated);
  assert.deepEqual(updateProfile(store, 'codex', { capabilities: undefined, role: undefined }), updated);
});

test('profile validation rejects unknown peers, permissions, and oversized claims', t => {
  const { store } = discovery(t);
  assert.throws(() => updateProfile(store, 'codex', { agent: 'claude', role: 'spoofed' }));
  assert.throws(() => updateProfile(store, 'codex', { role: ' ' }));
  assert.throws(() => updateProfile(store, 'codex', { capabilities: Array(33).fill('skill') }));
  assert.throws(() => updateProfile(store, 'codex', { current_task: 'x'.repeat(2001) }));
  assert.throws(() => updateProfile(store, 'codex', { sandbox: 'root' }));
  assert.throws(() => getProfile(store, 'missing'), /Unknown agent/);
  assert.throws(() => updateProfile(store, 'missing', { role: 'reviewer' }), /Unknown agent/);
});
