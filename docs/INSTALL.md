# Installation

## Prerequisites

- macOS or Linux with **Node.js 24 or later**, including npm. Check `node --version`.
- Authenticated **Codex CLI** for Codex sessions. Install and sign in using the
  [official Codex setup](https://developers.openai.com/codex/quickstart).
- Authenticated **Claude Code CLI** for Claude sessions. Follow
  [Claude Code setup](https://code.claude.com/docs/en/setup).
- Claude Channels must be available for your authentication method and permitted
  by your organization. See [channel availability](https://code.claude.com/docs/en/channels).

There is no Python dependency, relay account, separate messaging API key, or model
SDK credential. Your agent CLIs keep using their existing authentication. The
message bus is local; model inference still uses each agent's normal provider.

## Install from this checkout

```sh
git clone https://github.com/zak-keown/ai-radio.git
cd ai-radio
npm ci --ignore-scripts
npm test
npm run check
npm run setup
npm run doctor
```

The setup command:

1. Creates `.ai-radio/radio.sqlite3` and default `codex` and `claude` mailboxes.
2. Merges only `mcpServers.ai-radio` into the project's `.mcp.json`, preserving
   other servers and top-level settings.
3. Adds `.ai-radio/` to the project's `.gitignore` if needed.
4. Saves changed existing files under the private `.ai-radio/backups/` directory.
5. Prints exact launch commands with this checkout's absolute paths.

It is safe to rerun. Preview changes with `npm run setup -- --dry-run`.
Malformed config, symlinks, or an `ai-radio` entry owned by another checkout are
rejected instead of overwritten. Global Codex/Claude configuration is untouched.
The generated MCP configuration contains absolute local paths: regenerate it on
another machine and review it before committing it to a shared repository.

## Launch both agents

Open two terminals in this checkout:

```sh
# Terminal 1
npm run claude

# Terminal 2
npm run codex
```

The Claude launcher uses the native Claude CLI, passes our MCP entry explicitly,
and opts this session into `server:ai-radio` using
`--dangerously-load-development-channels`. Despite its name, that flag does not
bypass tool permissions. Accept the local MCP trust prompt if Claude displays it.
Organization policy can still block the channel; inspect Claude's startup notice
and `/mcp` if notifications do not arrive. Events queued during startup can
arrive before the listener is ready; pending events retry every 30 seconds until
Claude acknowledges them.

The Codex launcher starts a dedicated app-server thread with our MCP server
configured only for that process. It prints the exact thread ID, streams replies,
and accepts one-line prompts. `/quit` exits. Resume a saved thread with:

```sh
node bin/ai-radio.js run codex --thread THREAD_ID
```

The Codex runner defaults to `read-only` with no interactive approvals. For an
agent that should edit this project, explicitly launch:

```sh
npm run codex -- --sandbox workspace-write
```

The runner declines requests for elevated permissions. It does not replace the
full Codex TUI or attach to an unrelated desktop/terminal session.

## Verify delivery

With both sessions open, ask Claude:

> Use radio_send to ask codex what its current task is. Acknowledge incoming
> AI Radio messages with radio_ack after processing them.

Codex should receive the message without calling `radio_inbox`. Its reply should
arrive as a channel event in Claude. You can inspect connection state and receipts:

```sh
node bin/ai-radio.js agents
node bin/ai-radio.js history --agent claude --peer codex
```

A live `push_connected` value means a delivery consumer holds the mailbox lease;
it does not prove the model processed a message. `delivered_at` means transport
acceptance. `acknowledged_at` means the recipient called `radio_ack`.

For transport-only testing without model calls, `npm test` connects actual stdio
MCP clients and runs a fake Codex app-server to verify idle wake, active steering,
replay, acknowledgments, and storage. It does not prove your Claude account's
channel availability or the installed Codex version's end-to-end model behavior.

## Use another project

Keep this checkout and its dependencies installed, then point setup at the code
repository where both agents should work:

```sh
node /path/to/ai-radio/bin/ai-radio.js install --project /path/to/your-project
node /path/to/ai-radio/bin/ai-radio.js doctor --project /path/to/your-project
```

Use the exact launcher commands printed by setup. Both agents must use the same
project path. Each project has its own isolated message database.

Optionally run `npm link` in this checkout to make `ai-radio` available on PATH;
this changes npm's global link directory and is not required. You can then use
`ai-radio install`, `ai-radio run claude`, and `ai-radio run codex` from a project.

For multiple sessions of one provider, assign distinct names with `--agent`, and
register each peer before sending to it. For example:

```sh
node bin/ai-radio.js join --agent claude-review --provider claude
node bin/ai-radio.js run claude --agent claude-review
```

## Upgrade

Close the two sessions, update this checkout using your normal source workflow,
then run `npm ci --ignore-scripts`, `npm test`, and the setup command for each
project. History stays in place. If you move this checkout, remove its old
`mcpServers.ai-radio` entry from each project's `.mcp.json`, then rerun setup to
write the new absolute paths. Do not edit unrelated MCP entries.

## Uninstall

Exit the sessions, then:

```sh
node /path/to/ai-radio/bin/ai-radio.js uninstall --project /path/to/your-project
```

This removes only this checkout's MCP entry. History, backups, and the ignore rule
remain. If you used `npm link`, remove the optional global link with
`npm unlink --global ai-radio`. To erase history, separately delete that project's
`.ai-radio` directory after stopping every session using it. Back up the directory
first if you want to retain conversations.

## Repeatable evaluation fixture

`node scripts/seed-eval.js` creates a fresh temporary project with a deterministic
set of conversations and prints the stdio MCP command to connect as `codex`.
`eval/questions.xml` contains ten read-only evaluation questions for that fixture.
An evaluator can answer them using `radio_agents` and `radio_history`, including
pagination and receipt checks. Seeding does not invoke a model; the live manual
push check and the automated protocol tests are separate from model evaluations.

## Verified locally

On 2026-10-21, using Node 24.22.0, Codex CLI 0.163.0, and Claude Code 2.1.306:

- The installer completed, reruns made no changes, and `doctor` found both CLIs.
- Eleven automated tests passed, including actual stdio MCP calls and simulated
  Codex idle/active delivery, retry, acknowledgment, and install preservation.
- The installed Codex app-server accepted initialization and an empty thread.
- A live Codex-to-Claude message was acknowledged by Claude, which replied
  `AI-RADIO-ROUNDTRIP-OK`; the local Codex runner received and acknowledged that
  reply. Neither model needed an inbox read for this round trip.
- A message queued before Claude startup was initially transport-delivered but
  silently missed by the session. The implementation now retries unacknowledged
  Claude events every 30 seconds; an automated regression test covers that exact
  dropped-first-event scenario. Restart an already-running Claude session after
  updating AI Radio to pick up the retry fix.

## Enable AI Radio for your usual terminal commands

From the AI Radio checkout:

```sh
npm run setup:shell -- --dry-run
npm run setup:shell
source ~/.zshrc
```

This installs three managed zsh functions: `codex`, `claude`, and `claude-alt`.
It backs up `.zshrc` under this checkout's `.ai-radio/backups/`, preserves its
other contents, and is safe to rerun. New terminal tabs load the functions
automatically. The original executables are untouched.

Run the commands in the directory whose bus you want to use. All three default
mailboxes are registered automatically there. The local state directory ignores
its own contents in Git. You do not need to run project setup just to use the
wrappers. `claude-alt` still invokes your existing `claude-alt` executable, so its
alternate authentication profile is preserved; its mailbox is `claude-alt`.

Claude's ordinary flags and prompt arguments pass through, including `--resume`,
`--model`, and permission settings. Native administrative subcommands and help or
version requests go directly to the original executable.

The `codex` function uses AI Radio's **line-based app-server runner**, with push
reception. It supports an initial prompt, `--model`/`-m`, `--profile`/`-p`,
`--cd`/`-C`, `--config`/`-c`, `--sandbox`/`-s`, and `--thread`. It retains the
runner's read-only default; add `-s workspace-write` for project edits. It does
not provide the native Codex TUI, interactive approvals, image input, or every
native startup flag. Unsupported options fail explicitly. Native subcommands
such as `codex mcp`, `codex exec`, and `codex resume` bypass AI Radio. To resume a
push-enabled runner thread, use `codex --thread THREAD_ID` instead.

Bypass the functions whenever you want the original CLI:

```sh
command codex
command claude
command claude-alt
```

Bypassed commands do not receive AI Radio's injected configuration or push bridge.
You can set `AI_RADIO_PROJECT=/absolute/project/path` to share a bus across working
directories, or `AI_RADIO_AGENT=claude-review` to give a session a distinct mailbox.
Each concurrent session should have a different agent name.

Remove the functions with:

```sh
npm run setup:shell -- --remove
unfunction codex claude claude-alt
```

Removing the shell integration preserves the original binaries, alternate profile,
project configuration, and message history.

## Existing native Codex CLI sessions

The packaged `run codex` command currently uses the line-based app-server
runner described above. An existing native Codex CLI session can also receive
messages on versions exposing `codex queue --thread THREAD_UUID --message TEXT`.
A separate local adapter has been verified with this route, preserving the
native terminal UI. That adapter is not yet included in this checkout or shell
integration. Check `codex queue --help` on your installed version before relying
on it; support depends on the CLI build.

An adapter should own one AI Radio push lease for one named mailbox, forward
peer data through `queue`, and leave acknowledgment to the receiving agent's
`radio_ack` call. A successful queue operation is transport acceptance, not
proof that the model processed or acknowledged a message. Do not run it alongside
another push consumer for the same mailbox. The app-server runner remains the
packaged push path until native queue support is integrated and tested here.
