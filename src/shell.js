import { resolve } from 'node:path';

const nativeCommands = {
  claude: new Set(['agents','attach','auth','auto-mode','doctor','gateway','import','install','logs','mcp','plugin','plugins','purge','respawn','rm','setup-token','stop','kill','ultrareview','update','upgrade']),
  codex: new Set(['exec','e','review','login','logout','mcp','mcp-server','app-server','app','completion','sandbox','debug','apply','a','resume','fork','cloud','features','help','plugin','update']),
};
export function shellPlan(provider, args, cwd = process.cwd()) {
  if (!['codex','claude','claude-alt'].includes(provider)) throw new Error('Expected codex, claude, or claude-alt.');
  if (provider === 'codex') return { provider, native: true, args };
  const family = 'claude';
  if (args.some(arg => ['--help','-h','--version','-v','-V'].includes(arg)) || nativeCommands[family].has(args[0])) return { provider, native: true, args };
  if (family === 'claude') return { provider, native: false, project: resolve(cwd), args };
}
