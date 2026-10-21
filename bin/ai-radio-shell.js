#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RadioStore } from '../src/store.js';
import { runClaude } from '../src/install.js';
import { runCodex } from '../src/codex.js';
import { shellPlan } from '../src/shell.js';

try {
  const [provider, ...args] = process.argv.slice(2);
  const plan = shellPlan(provider, args, process.env.AI_RADIO_PROJECT ?? process.cwd());
  if (plan.native) {
    const child = spawn(provider, args, { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } else {
    const cli = fileURLToPath(new URL('./ai-radio.js', import.meta.url));
    const store = new RadioStore(plan.project);
    try {
      store.register('codex','codex'); store.register('claude','claude'); store.register('claude-alt','claude');
    } catch (error) { store.close(); throw error; }
    const agent = process.env.AI_RADIO_AGENT ?? provider;
    if (provider === 'codex') {
      try { await runCodex(store, agent, cli, plan); }
      catch (error) { store.close(); throw error; }
    } else {
      store.close();
      process.exitCode = await runClaude(plan.project, cli, agent, { executable: provider, args });
    }
  }
} catch (error) {
  console.error(`[ai-radio] ${error.message}`);
  console.error('For the full original CLI, bypass the shell function with: command codex / command claude / command claude-alt.');
  process.exitCode = 1;
}
