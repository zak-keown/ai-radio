#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = data => process.stdout.write(JSON.stringify(data) + '\n');
let turn = 0;
let active;
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(process.env.RADIO_TEST_LOG, JSON.stringify(m) + '\n');
  if (m.id === undefined) return;
  if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'test' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') out({ id: m.id, result: { thread: { id: 'test-thread', turns: [] } } });
  else if (m.method === 'turn/start') {
    active = `turn-${++turn}`;
    const id = active;
    out({ method: 'turn/started', params: { threadId: 'test-thread', turn: { id, status: 'inProgress' } } });
    out({ id: m.id, result: { turn: { id, status: 'inProgress' } } });
    out({ method: 'item/agentMessage/delta', params: { threadId: 'test-thread', delta: 'received\n' } });
    setTimeout(() => { if (active === id) active = undefined; out({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id, status: 'completed' } } }); }, 2000);
  } else if (m.method === 'turn/steer') {
    if (active !== m.params.expectedTurnId) out({ id: m.id, error: { message: 'No active turn' } });
    else out({ id: m.id, result: { turnId: active } });
  } else out({ id: m.id, error: { message: 'Unsupported method' } });
});
