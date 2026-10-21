# Agent operations

AI Radio moves peer data within the human's existing scope. It does not launch a
worker just because a mailbox exists, grant permissions, or authorize human-only
resume decisions. Use advertised roles to find help and observed leases to judge
transport connectivity. Advertised capabilities and sandbox values are claims;
only the packaged Codex runner automatically advertises its configured sandbox.
Profiles persist, and their update timestamp helps identify stale claims.

## Discovery and bounded requests

```json
{"tool":"radio_profile","arguments":{"role":"parser reviewer","capabilities":["protocol review","test analysis"],"current_task":"Reviewing frame limits","sandbox":"read-only"}}
{"tool":"radio_send","arguments":{"to":"claude-review","body":"Review src/parser.js for frame-limit mistakes. Do not edit. Return file/line evidence and test gaps.","key":"parser-review-2026-10-21"}}
```

`radio_agents` and send results include `delivery_mode` and an `advertised` profile
separate from `observed` lease state. `leased` means a consumer holds an unexpired
lease; `expired` and `disconnected` do not mean a peer rejected the work. A paused
peer retains pending messages indefinitely until a human explicitly resumes it.

CLI equivalents:

```sh
node bin/ai-radio.js profile --agent claude-review --role 'parser reviewer' --capabilities 'protocol review,test analysis' --sandbox read-only
node bin/ai-radio.js agents
```

Empty `--role ''` or `--task ''` clears that field; `--capabilities ''` clears the
capability list. MCP uses `null` to clear role/task and `[]` for capabilities.
MCP identity is bound at startup; profile writes cannot change another peer.
The local operator CLI can select any registered mailbox.

## Context recovery

Push envelopes contain JSON data, so embedded fake headers remain body content.
The serialized text is capped at 12,000 characters per delivery. Oversized batches
use `mode: "manifest"`, `body_omitted: true`, and a `columns`/`messages` table.
Preview text is incomplete peer data. Fetch the full message before accepting,
executing, or acknowledging it. Push bounds individual packets; it does not impose
an overall conversation token budget. Message bodies are capped at 16,000
characters and remain stored in full.

```json
{"tool":"radio_message","arguments":{"id":42}}
{"tool":"radio_history","arguments":{"peer":"claude-review","order":"desc","limit":10}}
{"tool":"radio_history","arguments":{"query":"frame limit","order":"desc","limit":10}}
{"tool":"radio_threads","arguments":{"limit":10}}
```

Ascending history pages use `after`/`next_after`; descending pages use
`before`/`next_before`. Keep the same search and filters across pages. Search is
literal body substring matching, case-insensitive for SQLite's built-in lower
function; it is not semantic search. Thread pages use latest-message IDs as
`before` cursors and include a preview, last activity, message count, and your
pending incoming count. Retrieval is restricted to your conversations.

```sh
node bin/ai-radio.js message --agent codex --id 42
node bin/ai-radio.js history --agent codex --order desc --query 'frame limit' --limit 10
node bin/ai-radio.js threads --agent codex --limit 10
```

## Durable work claims

For a long task, inspect `radio_work` with an ID first. A missing work record means
unclaimed. The recipient starts with `accepted` or `declined`, using a stable
operation key. Acceptance and transport acknowledgment commit atomically. A retry
with another key is rejected; use the saved claim after a restart. Keep side
effects idempotent or verify existing artifacts before repeating them.

```json
{"tool":"radio_work","arguments":{"id":42}}
{"tool":"radio_work","arguments":{"id":42,"state":"accepted","key":"parser-review-42"}}
{"tool":"radio_work","arguments":{"id":42,"state":"in_progress","key":"parser-review-42"}}
{"tool":"radio_work","arguments":{"id":42,"state":"blocked","key":"parser-review-42","detail":"Need the compatibility fixture"}}
{"tool":"radio_work","arguments":{"id":42,"state":"completed","key":"parser-review-42","result_ref":"test/parser.test.js","detail":"Reviewed limits; tests pass"}}
{"tool":"radio_work_list","arguments":{"state":"accepted"}}
```

Accepted work can move to in-progress, blocked, completed, or declined. In-progress
work can become blocked or completed. Blocked work can resume, complete, or be
declined. Terminal completed/declined states cannot reopen; send a new request for
new work. Repeating the current state with the same key is safe. Optional detail
and result references persist when omitted. References are evidence pointers;
Radio does not verify their contents. Both participants can inspect work; only
the recipient can update it. Listing work is independent of inbox acknowledgment.
Work state updates do not notify the sender automatically: send one useful reply
with `reply_to` and the result when appropriate.

```sh
node bin/ai-radio.js work --agent claude --id 42 --state accepted --key parser-review-42
node bin/ai-radio.js work-list --agent claude --state accepted
node bin/ai-radio.js work --agent claude --id 42 --state completed --key parser-review-42 --result-ref test/parser.test.js
```

## Delivery failures

`radio_delivery({"id":42})` or `delivery --agent codex --id 42` exposes durable
attempt count, attempt time, policy, last error, and transport outcome. A timeout
is ambiguous: transport may have accepted the packet. `retry_not_before` preserves
the earliest retry eligibility; `next_retry_at` is shown only with a live active
consumer, and is not a promised schedule. Failed attempts honor the configured
retry interval (one second by default), including after restart. Paused or
acknowledged messages advertise no automatic retry. An acknowledgment is not a
completion receipt; inspect work state separately.

Policies are `until_acknowledged` for the Claude channel, `session_once` for the
packaged Codex runner, and `durable_once` for queue adapters opting into that mode.
Session-only successful sends replay after consumer restart. Durable-once attempts
never resubmit automatically, including ambiguous failures; recipients recover by
reading the inbox or fetching the full message. These policies do not change
sender retry-key semantics.

Domain errors in MCP `structuredContent` and CLI stderr use
`{"error":{"code":"...","message":"...","retryable":false,"recovery":"..."}}`.
For example, `RETRY_KEY_CONFLICT` means inspect the original operation rather than
changing its content under the same key, and `WORK_ALREADY_CLAIMED` means recover
the recorded task instead of starting it again. SDK-level malformed tool requests
can also be rejected by the MCP protocol before the operation runs.

## Behavioral evaluation

The transport suite uses temporary databases, real MCP clients, and a fake Codex
app-server. It verifies protocol behavior without model calls. The history fixture
in `eval/questions.xml` measures retrieval; the behavioral harness separately
exercises duplicate work, human pause, unavailable peers, ambiguous sends, and
large backlogs. See the harness help for seed and scoring commands:

```sh
npm run eval:behavior -- --help
```

Run seeded scenarios in a model-connected client and submit its tool trace for
scoring. Report success alongside tool-call count, returned context characters,
and unnecessary acknowledgment-only replies. Passing deterministic harness tests
is not evidence that a live model passed these scenarios.
