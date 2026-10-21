import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, until } from './helpers.js';
const cli = fileURLToPath(new URL('../bin/ai-radio.js', import.meta.url));
async function connect(project, agent, provider, channel = false) {
  const client = new Client({ name: 'radio-test', version: '1' });
  const events = [];
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), e => events.push(e));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'serve', '--project', project, '--agent', agent, '--provider', provider, ...(channel ? ['--channel'] : [])], stderr: 'pipe' });
  await client.connect(transport);
  return { client, events, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('real stdio MCP: cross-provider send pushes channel event without inbox read; ack and history work', async t => {
  const { project, store } = fixture(t);
  const claude = await connect(project, 'claude', 'claude', true); t.after(() => claude.client.close());
  const codex = await connect(project, 'codex', 'codex'); t.after(() => codex.client.close());
  assert.ok(claude.client.getServerCapabilities().experimental['claude/channel']);
  const tools = await codex.client.listTools();
  assert.equal(tools.tools.length, 13);
  const paused = await call(codex.client, 'radio_presence', { mode: 'paused' });
  assert.equal(paused.structuredContent.mode, 'paused');
  assert.equal((await call(codex.client, 'radio_presence')).structuredContent.agent, 'codex');
  const identity = await call(codex.client, 'radio_identity');
  assert.equal(identity.structuredContent.agent, 'codex');
  const sent = await call(codex.client, 'radio_send', { to: 'claude', body: 'hello via MCP', key: 'hello' });
  assert.equal(sent.isError, undefined);
  const id = sent.structuredContent.message.id;
  await until(() => claude.events.length === 1);
  assert.equal(claude.events[0].params.meta.message_id, String(id));
  assert.match(claude.events[0].params.content, /hello via MCP/);
  await until(() => store.history('claude').messages[0].delivered_at);
  assert.equal(store.inbox('claude').messages.length, 1);
  const forbidden = await call(codex.client, 'radio_ack', { ids: [id] });
  assert.equal(forbidden.isError, true);
  const ack = await call(claude.client, 'radio_ack', { ids: [id] });
  assert.deepEqual(ack.structuredContent.acknowledged, [id]);
  assert.equal(store.inbox('claude').messages.length, 0);
  const invalid = await call(codex.client, 'radio_send', { to: 'claude', body: '' });
  assert.equal(invalid.isError, true);
  const history = await call(codex.client, 'radio_history', { peer: 'claude' });
  assert.ok(history.structuredContent.messages[0].acknowledged_at);
});

test('unacknowledged push replays on reconnect; acknowledged mail does not', async t => {
  const { project, store } = fixture(t);
  const first = store.send('codex', { to: 'claude', body: 'pending' });
  let session = await connect(project, 'claude', 'claude', true);
  await until(() => session.events.length === 1);
  await session.client.close();
  session = await connect(project, 'claude', 'claude', true);
  await until(() => session.events.length === 1);
  await call(session.client, 'radio_ack', { ids: [first.id] });
  await session.client.close();
  const third = await connect(project, 'claude', 'claude', true); t.after(() => third.client.close());
  const next = store.send('codex', { to: 'claude', body: 'next' });
  await until(() => third.events.length === 1);
  assert.equal(third.events[0].params.meta.message_id, String(next.id));
});

test('MCP profiles remain bound to caller identity and paused sends advertise delivery mode', async t => {
  const { project, store } = fixture(t);
  const codex = await connect(project, 'codex', 'codex'); t.after(() => codex.client.close());
  const claude = await connect(project, 'claude', 'claude'); t.after(() => claude.client.close());
  const profile = await call(codex.client, 'radio_profile', {
    agent: 'claude', role: 'reviewer', capabilities: ['tests', 'Swift'], current_task: 'reviewing transport', sandbox: 'read-only',
  });
  assert.equal(profile.isError, undefined);
  assert.equal(profile.structuredContent.agent, 'codex');
  assert.equal(profile.structuredContent.role, 'reviewer');
  assert.equal(store.profile('claude').role, null);
  await call(claude.client, 'radio_presence', { mode: 'paused' });
  const peers = (await call(codex.client, 'radio_agents')).structuredContent.agents;
  assert.deepEqual(peers.find(peer => peer.name === 'codex').advertised.capabilities, ['tests', 'Swift']);
  const pausedPeer = peers.find(peer => peer.name === 'claude');
  assert.equal(pausedPeer.delivery_mode, 'paused');
  assert.equal(pausedPeer.observed.session_freshness, 'disconnected');
  const sent = await call(codex.client, 'radio_send', { to: 'claude', body: 'wait for a human resume' });
  assert.equal(sent.structuredContent.recipient.delivery_mode, 'paused');
  const delivery = await call(codex.client, 'radio_delivery', { id: sent.structuredContent.message.id });
  assert.equal(delivery.structuredContent.attempt, null);
  assert.match(delivery.structuredContent.recovery, /human resume/);
});

test('MCP supports direct retrieval, recent/search history, threads and structured participant denial', async t => {
  const { project, store } = fixture(t);
  const first = store.send('codex', { to: 'claude', body: 'review request with literal 100% marker' });
  const reply = store.send('claude', { to: 'codex', body: 'review evidence', reply_to: first.id });
  const latest = store.send('codex', { to: 'claude', body: 'separate question' });
  const codex = await connect(project, 'codex', 'codex'); t.after(() => codex.client.close());
  const outsider = await connect(project, 'other', 'codex'); t.after(() => outsider.client.close());
  const lookup = await call(codex.client, 'radio_message', { id: first.id });
  assert.equal(lookup.structuredContent.message.body, first.body);
  const denied = await call(outsider.client, 'radio_message', { id: first.id });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'MESSAGE_NOT_ACCESSIBLE');
  assert.equal(denied.structuredContent.error.retryable, false);
  assert.match(denied.structuredContent.error.recovery, /own inbox or history/);
  const recent = (await call(codex.client, 'radio_history', { order: 'desc', limit: 1 })).structuredContent;
  assert.deepEqual(recent.messages.map(message => message.id), [latest.id]);
  assert.equal(recent.next_before, latest.id);
  const older = (await call(codex.client, 'radio_history', { order: 'desc', before: recent.next_before, limit: 1 })).structuredContent;
  assert.equal(older.messages[0].id, reply.id);
  const search = (await call(codex.client, 'radio_history', { query: '100%' })).structuredContent;
  assert.deepEqual(search.messages.map(message => message.id), [first.id]);
  const threads = (await call(codex.client, 'radio_threads', { peer: 'claude' })).structuredContent.threads;
  assert.deepEqual(threads.map(thread => thread.thread_id), [latest.thread_id, first.thread_id]);
  assert.equal(threads[1].message_count, 2);
});

test('MCP work claims acknowledge transport while completion and claim recovery survive reconnect', async t => {
  const { project, store } = fixture(t);
  const message = store.send('codex', { to: 'claude', body: 'produce a reviewed result' });
  let session = await connect(project, 'claude', 'claude');
  t.after(() => session.client.close());
  const accepted = await call(session.client, 'radio_work', { id: message.id, state: 'accepted', key: 'stable-operation' });
  assert.equal(accepted.structuredContent.work.state, 'accepted');
  assert.equal(store.inbox('claude').messages.length, 0);
  const receipt = await call(session.client, 'radio_message', { id: message.id });
  assert.ok(receipt.structuredContent.message.acknowledged_at);
  assert.equal(receipt.structuredContent.work.state, 'accepted');
  assert.equal(receipt.structuredContent.work.result_ref, null);
  await session.client.close();
  session = await connect(project, 'claude', 'claude');
  const recovered = await call(session.client, 'radio_work_list', { state: 'accepted' });
  assert.equal(recovered.structuredContent.work[0].message_id, message.id);
  const competing = await call(session.client, 'radio_work', { id: message.id, state: 'accepted', key: 'different-operation' });
  assert.equal(competing.structuredContent.error.code, 'WORK_ALREADY_CLAIMED');
  const completed = await call(session.client, 'radio_work', { id: message.id, state: 'completed', key: 'stable-operation', result_ref: 'src/review.js:12', detail: 'checks passed' });
  assert.equal(completed.structuredContent.work.state, 'completed');
  assert.equal(completed.structuredContent.work.result_ref, 'src/review.js:12');
  const diagnostics = (await call(session.client, 'radio_delivery', { id: message.id })).structuredContent;
  assert.ok(diagnostics.acknowledged_at);
  assert.match(diagnostics.recovery, /inspect radio_work/);
  await session.client.close();
  session = await connect(project, 'claude', 'claude');
  const persisted = (await call(session.client, 'radio_work_list', { state: 'completed' })).structuredContent.work;
  assert.equal(persisted[0].result_ref, 'src/review.js:12');
});

test('channel delivers a bounded large-batch manifest and full bodies remain retrievable', async t => {
  const { project, store } = fixture(t);
  const body = '\u0000'.repeat(16000);
  const messages = Array.from({ length: 100 }, (_, index) => store.send('codex', { to: 'claude', body, key: `batch-${index}` }));
  const claude = await connect(project, 'claude', 'claude', true); t.after(() => claude.client.close());
  await until(() => claude.events.length === 1);
  const { content, meta } = claude.events[0].params;
  assert.ok(content.length <= 12000);
  assert.equal(meta.count, '100');
  assert.equal(meta.message_ids, messages.map(message => message.id).join(','));
  const packet = JSON.parse(content);
  assert.equal(packet.mode, 'manifest');
  assert.equal(packet.body_omitted, true);
  assert.deepEqual(packet.messages.map(row => row[0]), messages.map(message => message.id));
  const retrieved = await call(claude.client, 'radio_message', { id: messages[0].id });
  assert.equal(retrieved.structuredContent.message.body, body);
  await until(() => store.delivery('claude', messages[0].id).attempt?.outcome === 'transport_accepted');
  const diagnostics = (await call(claude.client, 'radio_delivery', { id: messages[0].id })).structuredContent;
  assert.equal(diagnostics.attempt.policy, 'until_acknowledged');
  assert.equal(diagnostics.attempt.attempts, 1);
  assert.equal(diagnostics.attempt.last_error, null);
  assert.ok(diagnostics.attempt.next_retry_at);
  assert.ok(diagnostics.delivered_at);
});
