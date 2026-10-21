import test from 'node:test';
import assert from 'node:assert/strict';
import { shellPlan } from '../src/shell.js';
import { shellBlock, updateShell } from '../scripts/install-shell.js';

test('Claude wrappers preserve arguments and alternate profile executable', () => {
  const args = ['--resume','session-id','--model','sonnet','a prompt with spaces'];
  const plan = shellPlan('claude-alt',args,'/tmp/project with spaces');
  assert.equal(plan.provider,'claude-alt');
  assert.deepEqual(plan.args,args);
  assert.equal(plan.project,'/tmp/project with spaces');
  assert.equal(plan.native,false);
  assert.equal(shellPlan('claude',['auth','status']).native,true);
  assert.equal(shellPlan('claude-alt',['--version']).native,true);
});
test('Codex shell routing supports model, profile, directory, config and initial prompt', () => {
  const plan = shellPlan('codex',['-m','test-model','-p','personal','-C','subdir','-c','model_reasoning_effort="high"','-s','workspace-write','do this'],'/tmp/project');
  assert.equal(plan.model,'test-model'); assert.equal(plan.profile,'personal');
  assert.equal(plan.project,'/tmp/project/subdir');
  assert.deepEqual(plan.configOverrides,['model_reasoning_effort="high"']);
  assert.equal(plan.prompt,'do this'); assert.equal(plan.sandbox,'workspace-write');
  assert.equal(shellPlan('codex',['mcp','list']).native,true);
  assert.equal(shellPlan('codex',['resume','some-thread']).native,true);
  assert.throws(() => shellPlan('codex',['--unsupported-option']));
});
test('shell installation preserves unrelated config, handles quoted paths and removes its block', () => {
  const original='export SOMETHING=1\n';
  const block=shellBlock('/path/node',"/path/it's a folder/launcher.js");
  assert.match(block,/function claude-alt\(\)/);
  assert.ok(block.includes("'\\''"));
  const installed=updateShell(original,block);
  assert.ok(installed.startsWith(original));
  assert.equal(updateShell(installed,block),installed);
  assert.equal(updateShell(installed,block,true).trim(),original.trim());
  assert.throws(() => updateShell('# >>> AI Radio shell wrappers >>>\n',block),/Malformed/);
});
