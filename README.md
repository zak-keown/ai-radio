# AI Radio

A same-machine messaging bus for independent **Codex** and **Claude Code** sessions.
Messages and receipts live in a project-local SQLite database. No hosted relay,
accounts, HTTP listeners, or messaging API keys. The agents still connect to their
normal model providers; this does not run Codex or Claude models offline.

Requires **Node.js 24+** and the relevant authenticated agent CLI. No Python.

## Install and start

See [the installation guide](docs/INSTALL.md) for prerequisites, setup in another
project, verification, upgrades, and uninstalling.

```sh
git clone https://github.com/zak-keown/ai-radio.git
cd ai-radio
npm ci --ignore-scripts
npm run setup
npm run doctor
# Then, in separate terminals:
npm run claude
npm run codex
```

Setup merges the local Claude MCP entry, initializes default mailboxes, preserves
other MCP servers, and backs up changed files. Rerunning it is safe. Preview with
`npm run setup -- --dry-run`. No global agent settings are modified.

Ask either agent to send the other a message using `radio_send`. To try delivery
without asking an agent to send:

```sh
node bin/ai-radio.js send --from codex --to claude --body 'Which files are you working on?'
node bin/ai-radio.js send --from claude --to codex --body 'Please report your current task.'
```

The CLI can send as any registered peer for local operator testing. The MCP tools
bind identity at startup; the model cannot choose a different sender. The bus is
a trust boundary for one OS user, not authentication between hostile processes.

## Push delivery

**Claude:** our stdio MCP server declares `claude/channel` and pushes
`notifications/claude/channel` events. No inbox tool call is needed. Custom
channels currently need the development flag above. The flag enables the channel;
it does not bypass ordinary tool permissions. Channels are a research preview,
require supported Anthropic authentication and may need organization enablement.
Claude queues events while busy and handles them at its next processing boundary.
We use the MCP SDK v1 line because Claude's preview channel contract requires the
older protocol negotiation; see the official reference below.

**Codex:** `run codex` owns a dedicated app-server process and maps one named peer
to one exact thread. It uses `turn/steer` while busy and `turn/start` while idle.
It streams text to the terminal and accepts line-based prompts. `/quit` exits.
Resume with `run codex --thread THREAD_ID`. This is a small terminal runner, not
the full Codex TUI. It cannot inject into an unrelated, already-open Codex CLI or
Codex desktop session. Those need a separately connected app-server adapter.
The runner defaults to a read-only sandbox with approvals disabled. Use
`--sandbox workspace-write` to allow writes inside the project. Interactive
approval requests are declined; there is no remote permission approval path.

Filesystem notifications trigger delivery after the SQLite commit. A one-second
background scan recovers missed events; the model never has to poll its inbox.
This local transport watcher is distinct from an agent calling a receive tool.

## Durability and receipts

- A committed send survives recipient downtime and process restarts.
- Reading and pushing do **not** acknowledge a message. The recipient calls
  `radio_ack` after processing it. Sent, transport-delivered, and acknowledged
  are separate states in `radio_history`.
- Unacknowledged messages replay when the push consumer restarts. This is
  **at-least-once**, not exactly-once delivery. Use message IDs to avoid repeating
  work. A transport timeout can also cause redelivery.
- A sender may pass a unique `key` to make send retries idempotent. Reusing a key
  with different content is rejected.
- One leased push consumer per agent name prevents two active consumers from
  intentionally draining the same mailbox. Name additional sessions separately.
  Lease takeover after a crashed process takes up to ten seconds.
- Channel writes have no client acknowledgment. If Claude drops a channel event
  because startup is unfinished or the feature is disabled, it remains pending.
  Unacknowledged Claude events retry every 30 seconds while connected. Enable the
  channel if necessary, or recover with `radio_inbox`. A slow recipient may see
  the same ID again before acknowledging it.

All state is under `.ai-radio/`, ignored by Git, with owner-only directory/database
permissions. WAL mode and a busy timeout support concurrent local processes.
Do not use this database on a network filesystem. Any process running as your OS
user can access it. Peer content is labeled as peer data and never evaluated as
shell commands by AI Radio; models must still honor the human's scope and normal
permissions when interpreting it.

## Tools

| Tool | Purpose |
| --- | --- |
| `radio_identity` | Bound peer name, provider, project |
| `radio_agents` | Registered peers, pending counts, live push leases |
| `radio_send` | Send, retry safely, or reply to a message |
| `radio_inbox` | Paginated recovery of pending messages |
| `radio_ack` | Atomic acknowledgment of your own incoming IDs |
| `radio_history` | Paginated conversation history, including receipts |

Every command accepts `--project PATH`; every integration must use the same
canonical project directory. Names are stable mailboxes, not automatically
created agent processes. Only Codex and Claude providers are accepted.

```sh
node bin/ai-radio.js join --agent claude-review --provider claude
node bin/ai-radio.js agents
node bin/ai-radio.js inbox --agent claude --limit 20
node bin/ai-radio.js ack --agent claude --ids 1,2
node bin/ai-radio.js history --agent codex --peer claude
node bin/ai-radio.js --help
npm test
npm run check
```

To use tools without push, launch `serve --agent NAME --provider codex|claude`
from any local stdio MCP configuration. It exposes the same durable mailbox.

Inspired by [agent-talk](https://github.com/xhluca/agent-talk); this is an
independent local implementation, with no retalk relay or copied upstream code.
Provider references: [Claude Channels](https://code.claude.com/docs/en/channels-reference),
[Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Codex MCP](https://developers.openai.com/codex/mcp).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and repository hygiene.
The GitHub workflow runs tests and syntax checks on macOS and Linux with Node 24.
This checkout is not published to npm.

## License

[MIT](LICENSE), copyright 2026 Zak Keown.

## Quiet, pause, and shutdown

Ordinary `codex` stays the native CLI; shell setup never intercepts it. The
line-based Radio runner is explicitly opt-in. Give simultaneous Radio sessions
unique agent names.

Set delivery state with `radio_presence` or the local CLI:

```sh
node bin/ai-radio.js presence --agent codex --mode paused
node bin/ai-radio.js presence --agent codex --mode quiet
node bin/ai-radio.js presence --agent codex --mode stopped
```

All three states retain pending messages without automatic delivery. They persist
across restarts and do not expire. Only an explicit human resume permits changing
back to `active`; a peer's message never resumes paused work. Inbox/history still
work manually. “Shut up” means quiet delivery, not repeated announcements that an
agent is being quiet.

Messages use compact `sender #id: body` packets, batched by the push consumer.
Agents acknowledge silently with `radio_ack`: no user-facing acknowledgment,
no acknowledgment-only peer reply, and no repeated status without a useful
change. Before shutdown, save a handoff, suppress delivery, stop owned work, and
send at most one useful departure note.

Queue adapters should use `startPush(..., { durableOnce: true })`. An attempted
native queue delivery is persisted before calling the transport; an ambiguous
failure is never resent automatically, even after restart. Such messages remain
in the inbox for manual recovery. This trades automatic retry for avoiding a
queue flood. Do not restart an old adapter without this option.
