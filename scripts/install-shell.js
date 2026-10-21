import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const begin = '# >>> AI Radio shell wrappers >>>';
const end = '# <<< AI Radio shell wrappers <<<';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function shellBlock(node, launcher) {
  return `${begin}\n# Native CLI escape hatch: command codex / command claude / command claude-alt\n` +
    ['claude','claude-alt'].map(name => `function ${name}() { ${quote(node)} ${quote(launcher)} ${quote(name)} "$@"; }`).join('\n') + `\n${end}`;
}
export function updateShell(text, block, remove = false) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if ((start < 0) !== (stop < 0) || (start >= 0 && stop < start) || text.indexOf(begin, start + begin.length) >= 0) throw new Error('Malformed or duplicated AI Radio wrapper markers. Review .zshrc before proceeding.');
  if (start >= 0) return text.slice(0,start) + (remove ? '' : block) + text.slice(stop + end.length);
  return remove ? text : text + (text && !text.endsWith('\n') ? '\n' : '') + '\n' + block + '\n';
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = process.argv.slice(2);
  if (flags.some(flag => !['--dry-run','--remove'].includes(flag))) throw new Error('Use --dry-run or --remove.');
  const path = join(homedir(),'.zshrc');
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('.zshrc is a symlink; install the printed wrapper functions manually.');
  const original = existsSync(path) ? readFileSync(path,'utf8') : '';
  const block = shellBlock(process.execPath,fileURLToPath(new URL('../bin/ai-radio-shell.js',import.meta.url)));
  const updated = updateShell(original,block,flags.includes('--remove'));
  if (!flags.includes('--dry-run') && updated !== original) {
    const backupDir = fileURLToPath(new URL('../.ai-radio/backups/',import.meta.url));
    mkdirSync(backupDir,{recursive:true,mode:0o700});
    if (existsSync(path)) copyFileSync(path,join(backupDir,`zshrc-${Date.now()}-${randomUUID()}.bak`));
    writeFileSync(path,updated,{mode:0o600});
  }
  console.log(JSON.stringify({path,changed:updated!==original,dry_run:flags.includes('--dry-run'),removed:flags.includes('--remove'),activate:flags.includes('--remove') ? 'Open a fresh terminal, or unfunction codex claude claude-alt in this one.' : 'source ~/.zshrc',block},null,2));
}
