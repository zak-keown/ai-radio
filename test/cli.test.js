import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.js';

const cli = fileURLToPath(new URL('../bin/ai-radio.js', import.meta.url));
test('CLI advertises peers and supports a durable work and retrieval round trip', t => {
  const { project } = fixture(t);
  const run = (...args) => {
    const result=spawnSync(process.execPath,[cli,...args,'--project',project],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  };
  run('profile','--agent','claude','--role','reviewer','--capabilities','parser,test','--sandbox','read-only');
  run('presence','--agent','claude','--mode','paused');
  const sent=run('send','--from','codex','--to','claude','--body','Review parser limit','--key','cli-review');
  assert.equal(sent.recipient.delivery_mode,'paused');
  assert.equal(sent.recipient.advertised.role,'reviewer');
  const id=String(sent.message.id);
  assert.equal(run('message','--agent','claude','--id',id).message.body,'Review parser limit');
  assert.equal(run('history','--agent','codex','--query','parser','--order','desc').messages[0].id,Number(id));
  assert.equal(run('threads','--agent','codex').threads[0].last_message_id,Number(id));
  run('work','--agent','claude','--id',id,'--state','accepted','--key','cli-claim');
  assert.equal(run('inbox','--agent','claude').messages.length,0);
  assert.equal(run('work-list','--agent','claude','--state','accepted').work.length,1);
  run('work','--agent','claude','--id',id,'--state','completed','--key','cli-claim','--result-ref','test/parser.js');
  assert.equal(run('work','--agent','codex','--id',id).work.state,'completed');
  assert.ok(run('delivery','--agent','codex','--id',id).acknowledged_at);
  const bad=spawnSync(process.execPath,[cli,'send','--project',project,'--from','codex','--to','missing','--body','x'],{encoding:'utf8'});
  assert.equal(bad.status,1);
  assert.equal(JSON.parse(bad.stderr).error.code,'UNKNOWN_AGENT');
});
