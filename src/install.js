import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, lstatSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { RadioStore } from './store.js';

export function claudeConfig(project, cli, agent = 'claude') {
  return { mcpServers: { 'ai-radio': { command: process.execPath, args: [cli, 'serve', '--project', resolve(project), '--agent', agent, '--provider', 'claude', '--channel'] } } };
}
const owned = (entry, cli) => entry?.args?.[0] === cli && entry?.args?.[1] === 'serve';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const launchCommand = (cli, provider, project) => [process.execPath, cli, 'run', provider, '--project', project].map(shellQuote).join(' ');

function loadConfig(path) {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink. Merge the MCP entry manually using config.`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(`${path} must contain a JSON object.`);
  if (data.mcpServers && (Array.isArray(data.mcpServers) || typeof data.mcpServers !== 'object')) throw new Error('mcpServers must be an object.');
  return data;
}
function atomicWrite(project, path, text) {
  const state = join(project, '.ai-radio');
  const backups = join(state, 'backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  if (existsSync(path)) copyFileSync(path, join(backups, `${path.endsWith('.mcp.json') ? 'mcp' : 'gitignore'}-${Date.now()}-${randomUUID()}.bak`));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export function install(project, cli, { dryRun = false, remove = false } = {}) {
  project = resolve(project);
  const configPath = join(project, '.mcp.json');
  const config = loadConfig(configPath);
  const existing = config.mcpServers?.['ai-radio'];
  if (existing && !owned(existing, cli)) throw new Error('An ai-radio MCP entry from another installation already exists. Remove or rename that entry before installing this checkout.');
  const desired = claudeConfig(project, cli).mcpServers['ai-radio'];
  const changed = remove ? Boolean(existing) : JSON.stringify(existing) !== JSON.stringify(desired);
  if (remove) { if (config.mcpServers) delete config.mcpServers['ai-radio']; }
  else config.mcpServers = { ...config.mcpServers, 'ai-radio': desired };
  const ignorePath = join(project, '.gitignore');
  if (existsSync(ignorePath) && lstatSync(ignorePath).isSymbolicLink()) throw new Error('.gitignore is a symlink. Add .ai-radio/ to it manually before installing.');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  const addIgnore = !remove && !ignore.split(/\r?\n/).some(line => ['.ai-radio/', '/.ai-radio/', '.ai-radio', '/.ai-radio'].includes(line.trim()));
  if (!dryRun) {
    const store = new RadioStore(project);
    try {
      if (!remove) { store.register('codex', 'codex'); store.register('claude', 'claude'); }
      if (changed) atomicWrite(project, configPath, JSON.stringify(config, null, 2) + '\n');
      if (addIgnore) atomicWrite(project, ignorePath, ignore + (ignore && !ignore.endsWith('\n') ? '\n' : '') + '\n# AI Radio local messages and backups\n.ai-radio/\n');
    } finally { store.close(); }
  }
  return { action: remove ? 'uninstall' : 'install', dry_run: dryRun, project, mcp_config_changed: changed, gitignore_changed: addIgnore,
    messages: remove ? 'Local messages and backups are retained under .ai-radio/. Global agent settings are untouched.' : 'Local bus initialized. Global agent settings are untouched.',
    launch: { claude: launchCommand(cli, 'claude', project), codex: launchCommand(cli, 'codex', project) } };
}
export function doctor(project, cli) {
  project = resolve(project);
  const config = loadConfig(join(project, '.mcp.json'));
  const check = command => {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return { available: !result.error && result.status === 0, version: result.stdout?.trim() ?? '', error: result.error?.message };
  };
  return { node: process.version, node_supported: Number(process.versions.node.split('.')[0]) >= 24, project,
    initialized: existsSync(join(project, '.ai-radio', 'radio.sqlite3')),
    claude_configured: owned(config.mcpServers?.['ai-radio'], cli), codex: check('codex'), claude: check('claude'),
    note: 'Checks local prerequisites only. Authentication and Claude channel policy are verified by the agent clients at launch.' };
}
export async function runClaude(project, cli, agent = 'claude', { executable = 'claude', args = [] } = {}) {
  const store = new RadioStore(project);
  try { store.register(agent, 'claude'); } finally { store.close(); }
  const child = spawn(executable, [...args, '--mcp-config', JSON.stringify(claudeConfig(project, cli, agent)), '--dangerously-load-development-channels', 'server:ai-radio'], { cwd: project, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}
