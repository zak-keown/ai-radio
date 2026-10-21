import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/install.js';
import { fixture } from './helpers.js';
const cli = fileURLToPath(new URL('../bin/ai-radio.js', import.meta.url));

test('installation preserves other MCP entries, backs up changes and is idempotent', t => {
  const { project } = fixture(t);
  const path = join(project, '.mcp.json');
  const other = { command: 'some-other-tool', args: ['hello'] };
  writeFileSync(path, JSON.stringify({ mcpServers: { existing: other }, extra: true }));
  writeFileSync(join(project, '.gitignore'), 'existing-ignore');
  const plan = install(project, cli, { dryRun: true });
  assert.equal(plan.mcp_config_changed, true);
  assert.equal(JSON.parse(readFileSync(path)).mcpServers['ai-radio'], undefined);
  install(project, cli);
  const installed = JSON.parse(readFileSync(path));
  assert.deepEqual(installed.mcpServers.existing, other);
  assert.equal(installed.extra, true);
  assert.ok(installed.mcpServers['ai-radio'].args.includes('--channel'));
  assert.match(readFileSync(join(project, '.gitignore'), 'utf8'), /^existing-ignore\n/);
  assert.equal(readdirSync(join(project, '.ai-radio', 'backups')).length, 2);
  const again = install(project, cli);
  assert.equal(again.mcp_config_changed, false);
  assert.equal(again.gitignore_changed, false);
  install(project, cli, { remove: true });
  const removed = JSON.parse(readFileSync(path));
  assert.equal(removed.mcpServers['ai-radio'], undefined);
  assert.deepEqual(removed.mcpServers.existing, other);
  assert.ok(existsSync(join(project, '.ai-radio', 'radio.sqlite3')));
});

test('installer rejects malformed config or another ai-radio installation without rewriting it', t => {
  const { project } = fixture(t);
  const path = join(project, '.mcp.json');
  writeFileSync(path, '{broken');
  assert.throws(() => install(project, cli));
  assert.equal(readFileSync(path, 'utf8'), '{broken');
  const foreign = JSON.stringify({ mcpServers: { 'ai-radio': { command: 'foreign' } } });
  writeFileSync(path, foreign);
  assert.throws(() => install(project, cli), /another installation/);
  assert.equal(readFileSync(path, 'utf8'), foreign);
});
