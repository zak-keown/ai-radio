#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { install, doctor, runClaude } from '../src/install.js';
import { RadioStore } from '../src/store.js';

const help = `ai-radio — local messaging for Codex and Claude Code (Node 24+)

  install [--dry-run]           Configure this project and initialize the bus
  uninstall [--dry-run]         Remove this MCP entry; retain local history
  doctor                       Check Node, CLIs, and project installation
  init                         Create local bus and default codex/claude peers
  join --agent NAME --provider codex|claude
  agents                       List peers and push connections
  send --from NAME --to NAME --body TEXT [--reply-to ID] [--key KEY]
  inbox --agent NAME [--after ID] [--limit N]
  ack --agent NAME --ids 1,2    Acknowledge processed messages
  history --agent NAME [--peer NAME] [--thread UUID] [--after ID] [--limit N]
  serve --agent NAME --provider codex|claude [--channel]
  run claude [--agent NAME]     Launch native Claude Code with channel push
  run codex [--agent NAME] [--thread ID] [--sandbox read-only|workspace-write]
  config                       Print Claude MCP config and launch commands

All commands accept --project PATH (default: current directory).
Claude push: use config's MCP entry, then launch with the development-channel flag.
Codex push: run codex starts a dedicated local app-server thread; it does not
attach to an arbitrary existing terminal or desktop session.
`;
const options = Object.fromEntries(['project','agent','provider','from','to','body','reply-to','key','after','limit','ids','peer','thread','sandbox'].map(key => [key, { type: 'string' }]));
options.help = { type: 'boolean', short: 'h' };
options.channel = { type: 'boolean' };
options['dry-run'] = { type: 'boolean' };
let store;
try {
  const { values: v, positionals } = parseArgs({ options, allowPositionals: true });
  const [command, target] = positionals;
  if (v.help || !command) { console.log(help); }
  else {
    if (!['install','uninstall','doctor','init','join','agents','send','inbox','ack','history','serve','run','config'].includes(command)) throw new Error(`Unknown command ${command}. Run with --help.`);
    const required = key => { if (!v[key]) throw new Error(`Missing --${key}. Run with --help.`); return v[key]; };
    const cli = fileURLToPath(import.meta.url);
    const project = resolve(v.project ?? process.cwd());
    const print = value => console.log(JSON.stringify(value, null, 2));
    if (command === 'install' || command === 'uninstall') {
      print(install(project, cli, { dryRun: v['dry-run'] ?? false, remove: command === 'uninstall' }));
    } else if (command === 'doctor') {
      const report = doctor(project, cli); print(report);
      if (!report.node_supported || !report.initialized || !report.claude_configured || !report.codex.available || !report.claude.available) process.exitCode = 1;
    } else if (command === 'run' && target === 'claude') {
      process.exitCode = await runClaude(project, cli, v.agent ?? 'claude');
    } else if (command === 'config') {
      const args = [cli, 'serve', '--project', project, '--agent', 'claude', '--provider', 'claude', '--channel'];
      print({
        claude_mcp_json: { mcpServers: { 'ai-radio': { command: process.execPath, args } } },
        claude_launch: ['claude', '--dangerously-load-development-channels', 'server:ai-radio'],
        codex_launch: [process.execPath, cli, 'run', 'codex', '--project', project],
        note: 'Merge claude_mcp_json into the project .mcp.json. The Claude flag enables this custom preview channel; it does not bypass tool permissions. No global settings are modified.',
      });
    } else {
      store = new RadioStore(project);
      switch (command) {
        case 'init': print({ project: store.project, agents: [store.register('codex','codex'), store.register('claude','claude')], database: store.path }); break;
        case 'join': print(store.register(required('agent'), required('provider'))); break;
        case 'agents': print({ agents: store.agents() }); break;
        case 'send': print({ message: store.send(required('from'), { to: required('to'), body: required('body'), ...(v['reply-to'] ? { reply_to: Number(v['reply-to']) } : {}), ...(v.key ? { key: v.key } : {}) }) }); break;
        case 'inbox': print(store.inbox(required('agent'), { after: Number(v.after ?? 0), limit: Number(v.limit ?? 20) })); break;
        case 'ack': print(store.acknowledge(required('agent'), required('ids').split(',').map(Number))); break;
        case 'history': print(store.history(required('agent'), { peer: v.peer, thread_id: v.thread, after: Number(v.after ?? 0), limit: Number(v.limit ?? 20) })); break;
        case 'serve': {
          const { serve } = await import('../src/mcp.js');
          await serve(store, required('agent'), required('provider'), v.channel ?? false);
          store = undefined;
          break;
        }
        case 'run': {
          if (target !== 'codex') throw new Error('Use run codex. Claude runs in its native CLI with the channel enabled; see config.');
          const { runCodex } = await import('../src/codex.js');
          await runCodex(store, v.agent ?? 'codex', cli, { thread: v.thread, sandbox: v.sandbox });
          store = undefined;
          break;
        }
      }
      store?.close();
    }
  }
} catch (error) {
  try { store?.close(); } catch {}
  console.error(`[ai-radio] ${error.message}`);
  process.exitCode = 1;
}
