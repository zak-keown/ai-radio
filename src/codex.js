import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Rpc } from './rpc.js';
import { startPush } from './push.js';
import { peerText } from './store.js';

export async function runCodex(store, agent, cli, { thread, sandbox = 'read-only', executable = 'codex', model, profile, configOverrides = [], prompt, onReady } = {}) {
  store.register(agent, 'codex');
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Use --sandbox read-only or workspace-write.');
  const config = { 'mcp_servers.ai-radio': { command: process.execPath, args: [cli, 'serve', '--project', store.project, '--agent', agent, '--provider', 'codex'] } };
  const entry = config['mcp_servers.ai-radio'];
  const child = spawn(executable, [...(profile ? ['--profile', profile] : []), 'app-server', ...configOverrides.flatMap(value => ['-c', value]), '-c', `mcp_servers.ai-radio.command=${JSON.stringify(entry.command)}`, '-c', `mcp_servers.ai-radio.args=${JSON.stringify(entry.args)}`], { cwd: store.project, stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new Rpc(child);
  let threadId;
  let activeTurn;
  const completedTurns = new Set();
  let stopPush;
  let terminal;
  let stopped = false;
  let serial = Promise.resolve();
  const log = text => process.stderr.write(`[ai-radio] ${text}\n`);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopPush?.(); terminal?.close(); rpc.close(); store.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  };
  rpc.on('disconnected', error => { if (!stopped) { log(error.message); process.exitCode = 1; stop(); } });
  rpc.on('diagnostic', log);
  rpc.on('notification', ({ method, params }) => {
    if (params?.threadId && params.threadId !== threadId) return;
    if (method === 'turn/started') activeTurn = params.turn.id;
    if (method === 'turn/completed') {
      completedTurns.add(params.turn.id);
      if (activeTurn === params.turn.id) activeTurn = undefined;
      process.stdout.write('\n');
      if (params.turn.error) log(params.turn.error.message);
    }
    if (method === 'item/agentMessage/delta') process.stdout.write(params.delta);
  });
  rpc.on('request', message => {
    // Never silently approve commands, edits, or external actions on behalf of the user.
    if (message.method.endsWith('/requestApproval')) {
      log(`Declined ${message.method}; this runner does not relay approval dialogs.`);
      rpc.write({ id: message.id, result: { decision: 'decline' } });
    } else rpc.write({ id: message.id, error: { code: -32601, message: 'This runner does not support interactive server requests.' } });
  });
  const submit = text => {
    const action = async () => {
      const input = [{ type: 'text', text }];
      if (activeTurn) {
        // A turn may finish between the event and steer. A rejected steer is safe
        // to retry as a fresh turn; ambiguous timeouts are deliberately retained.
        try { await rpc.request('turn/steer', { threadId, expectedTurnId: activeTurn, input }); return; }
        catch (error) {
          if (!/no active turn|not active|not in progress|turn.*mismatch|expectedTurnId.*match/i.test(error.message)) throw error;
          activeTurn = undefined;
        }
      }
      const result = await rpc.request('turn/start', { threadId, input });
      // Notifications can precede this response. Do not resurrect a completed turn.
      if (result.turn.status === 'inProgress' && !completedTurns.has(result.turn.id)) activeTurn = result.turn.id;
    };
    const task = serial.then(action);
    serial = task.catch(() => {});
    return task;
  };
  try {
    await rpc.request('initialize', { clientInfo: { name: 'ai_radio', title: 'AI Radio', version: '0.1.0' } });
    rpc.write({ method: 'initialized' });
    const result = await rpc.request(thread ? 'thread/resume' : 'thread/start', {
      ...(thread ? { threadId: thread } : {}), ...(model ? { model } : {}), cwd: store.project, sandbox, approvalPolicy: 'never',
    });
    threadId = result.thread.id;
    activeTurn = result.thread.turns?.find(t => t.status === 'inProgress')?.id;
    log(`Codex ${agent}, thread ${threadId}, sandbox ${sandbox}. Type a prompt; /quit exits. Peer mail is pushed here.`);
    stopPush = startPush(store, agent, messages => submit(peerText(messages)), error => log(error.message));
    terminal = createInterface({ input: process.stdin, terminal: false });
    terminal.on('line', line => {
      if (line.trim() === '/quit') stop();
      else if (line.trim()) void submit(line).catch(error => log(error.message));
    });
    terminal.on('close', stop);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    onReady?.({ threadId, rpc, stop });
    if (prompt) void submit(prompt).catch(error => log(error.message));
    return { threadId, rpc, stop };
  } catch (error) { stop(); throw error; }
}
