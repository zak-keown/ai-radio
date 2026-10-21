#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedBehavior, scoreBehavior } from '../eval/behavior.js';
import { RadioStore } from '../src/store.js';

try {
  const [command = 'seed', projectArg, scenarioId, tracePath] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`Usage:
  node scripts/eval-behavior.js seed [fresh-project]
  node scripts/eval-behavior.js score <project> <scenario-id> <trace.json>

Seed creates a fresh project directory if needed, or a temporary project when omitted.
It prints prompts, rubrics, and a bound MCP command/args for each scenario.
Connect a model to that MCP server and give it the scenario prompt. Record the complete
run separately; this CLI does not execute a model. Use a fresh seed for each scenario
and independent repetition to avoid outcome contamination.

Trace format (output is decoded structuredContent, not an MCP text wrapper):
{"events":[
  {"type":"tool","name":"radio_presence","input":{},"output":{"agent":"paused-worker","mode":"paused"}},
  {"type":"decision","code":"human_pause_preserved"}
]}

This is a valid human-pause trace only if it records what the run actually did.
For unavailable-reviewer record the real radio_agents output then decision code
reviewer_unavailable; for large-backlog record the real radio_message output then
evidence_retrieved. Other scenarios use tool evidence and database outcomes.
Record every external operation as {"type":"effect","operation_id":"artifact-build-1"};
that event correctly fails duplicate-work because its artifact already exists.
Scoring measures observed tool-output characters, tool calls, external effects, and
acknowledgment-only replies. It cannot independently verify trace completeness.`);
  } else if (command === 'seed') {
    const project = projectArg ? resolve(projectArg) : mkdtempSync(join(tmpdir(), 'ai-radio-behavior-'));
    mkdirSync(project, { recursive: true });
    const manifest = seedBehavior(project);
    const path = join(project, '.ai-radio', 'behavior-manifest.json');
    writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ manifest: path, ...manifest }, null, 2));
  } else if (command === 'score' && projectArg && scenarioId && tracePath) {
    const project = resolve(projectArg);
    const manifest = JSON.parse(readFileSync(join(project, '.ai-radio', 'behavior-manifest.json'), 'utf8'));
    const scenario = manifest.scenarios.find(s => s.id === scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const store = new RadioStore(project);
    try {
      const result = scoreBehavior(store, scenario, trace);
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
    } finally { store.close(); }
  } else throw new Error('Usage: node scripts/eval-behavior.js seed [fresh-project] | score <project> <scenario-id> <trace.json>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
