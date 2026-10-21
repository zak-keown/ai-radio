import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { RadioStore } from '../src/store.js';

export function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), 'ai-radio-test-'));
  const store = new RadioStore(project);
  store.register('codex', 'codex'); store.register('claude', 'claude');
  t.after(() => { try { store.close(); } catch {} rmSync(project, { recursive: true, force: true }); });
  return { project, store };
}
export async function until(fn, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await setTimeout(25); }
  throw new Error('Timed out waiting for condition.');
}
