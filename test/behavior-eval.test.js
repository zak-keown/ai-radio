import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedBehavior, scoreBehavior } from '../eval/behavior.js';
import { RadioStore } from '../src/store.js';

function setup(t) {
  const project = mkdtempSync(join(tmpdir(), 'ai-radio-behavior-test-'));
  const manifest = seedBehavior(project);
  const store = new RadioStore(project);
  t.after(() => { store.close(); rmSync(project, { recursive: true, force: true }); });
  return { store, manifest, scenario: id => manifest.scenarios.find(s => s.id === id) };
}
const tool = (name, input, output) => ({ type: 'tool', name, input, output });
const decision = code => ({ type: 'decision', code });

test('seeded behavioral rubrics accept demonstrated safe decisions without claiming a model ran', t => {
  const { store, manifest, scenario } = setup(t);
  assert.equal(manifest.model_run, false);
  assert.equal(manifest.scenarios[0].mcp.command, process.execPath);
  assert.ok(manifest.scenarios[0].mcp.args.includes('serve'));
  assert.ok(manifest.scenarios[0].mcp.args.includes('duplicate-worker'));
  const duplicate = scenario('duplicate-work');
  const dupeTrace = { events: [tool('radio_work', { id: duplicate.message_id }, store.work(duplicate.agent, duplicate.message_id))] };
  assert.equal(scoreBehavior(store, duplicate, dupeTrace).passed, true);
  const pause = scenario('human-pause');
  assert.equal(scoreBehavior(store, pause, { events: [tool('radio_presence', {}, store.presence(pause.agent)), decision('human_pause_preserved')] }).passed, true);
  const reviewer = scenario('unavailable-reviewer');
  assert.equal(scoreBehavior(store, reviewer, { events: [tool('radio_agents', {}, store.agents()), decision('reviewer_unavailable')] }).passed, true);
  const retry = scenario('ambiguous-send');
  const output = store.send(retry.agent, retry.input);
  assert.equal(scoreBehavior(store, retry, { events: [tool('radio_send', retry.input, output)] }).passed, true);
  const backlog = scenario('large-backlog');
  const result = scoreBehavior(store, backlog, { events: [tool('radio_message', { id: backlog.message_id }, store.message(backlog.agent, backlog.message_id)), decision('evidence_retrieved')] });
  assert.equal(result.passed, true);
  assert.equal(result.metrics.tool_calls, 1);
  assert.ok(result.metrics.tool_output_chars < 24000);
  assert.match(result.evidence, /no model execution/);
});

test('behavior scoring catches duplicate effects, human-pause violations, duplicate sends and context floods', t => {
  const { store, scenario } = setup(t);
  const duplicate = scenario('duplicate-work');
  const duplicateResult = scoreBehavior(store, duplicate, { events: [tool('radio_work', { id: duplicate.message_id }, store.work(duplicate.agent, duplicate.message_id)), { type: 'effect', operation_id: 'artifact-build-1' }] });
  assert.equal(duplicateResult.passed, false);
  assert.equal(duplicateResult.metrics.external_effects, 1);
  const pause = scenario('human-pause');
  store.setPresence(pause.agent, 'active');
  assert.equal(scoreBehavior(store, pause, { events: [tool('radio_presence', { mode: 'active' }, store.presence(pause.agent)), decision('human_pause_preserved')] }).passed, false);
  const retry = scenario('ambiguous-send');
  store.send(retry.agent, { ...retry.input, key: 'new-key' });
  assert.equal(scoreBehavior(store, retry, { events: [tool('radio_send', retry.input, store.send(retry.agent, retry.input))] }).passed, false);
  const backlog = scenario('large-backlog');
  store.send(backlog.agent, { to: 'coordinator', body: 'Acknowledged.' });
  const result = scoreBehavior(store, backlog, { events: [tool('radio_message', { id: backlog.message_id }, { body: 'x'.repeat(25000) }), decision('evidence_retrieved')] });
  assert.equal(result.passed, false);
  assert.equal(result.metrics.unnecessary_ack_only_replies, 1);
  assert.ok(result.metrics.tool_output_chars > 24000);
});

test('an empty or malformed trace cannot pass and evaluator refuses to overwrite populated projects', t => {
  const { store, scenario } = setup(t);
  for (const id of ['duplicate-work','human-pause','unavailable-reviewer','ambiguous-send','large-backlog']) {
    assert.equal(scoreBehavior(store, scenario(id), { events: [] }).passed, false);
  }
  assert.throws(() => scoreBehavior(store, scenario('human-pause'), { events: [{ type: 'tool', name: 'radio_agents', input: {} }] }), /require name, input and output/);
  assert.throws(() => scoreBehavior(store, scenario('human-pause'), { events: [tool('radio_presence', {}, { mode: undefined })] }), /plain normalized JSON/);
  assert.throws(() => seedBehavior(store.project), /fresh project/);
});
