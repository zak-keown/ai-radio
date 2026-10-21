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
  assert.equal(tools.tools.length, 6);
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
