# Inline Agent Orchestrator

English | [日本語](README.md)

**Turn your everyday Claude Code or Codex session into an orchestrator.**

Hand a batch of tasks to a single session, and it becomes the orchestrator: it starts a separate session for each task, monitors their progress, and brings back only the decisions that need you, all at once. There is no new app or UI to learn.

> [!NOTE]
> This is a prototype (v0.5.0). The unit tests pass, but it has not yet been verified against real Claude Code or Codex sessions. Please run through [Verification](#verification) before relying on it.
>
> Messages from the tools and the skill's instructions are currently written in Japanese. The model still understands and answers in your language.

## Features

- **Works in the UI you already use** — Runs on standard Claude Code and Codex sessions and their CLIs. No dedicated app, background service, or tmux required
- **Starts sessions on its own** — Picks a name, working folder, and model for each task, then launches a worker session and hands it the task
- **Batches your decisions** — Collects questions from every session and asks them together, with options and a recommendation
- **Protects your machine and your plan limits** — Watches concurrent sessions, free memory, and the 5-hour and weekly usage limits, and keeps parallel work within safe bounds. Pauses as a limit approaches and resumes once it resets
- **Recovers stalled work** — Detects sessions that crashed or stopped midway and asks them to continue
- **Lightweight** — Needs only Node.js, with zero dependencies

## Example

```text
👤 Fix the login bug and open a PR.
   Also check whether we can upgrade our dependencies and report back.

🤖 I'll split this into two sessions:
   • fix-login   — fix the bug → test → open a PR
   • deps-survey — investigate and report
   Monitoring has started.

   (a while later)

🤖 fix-login has a question: when a session expires, should users be asked to sign in again,
   or should it be extended automatically?
   I recommend asking them to sign in again (matches the current behavior).

👤 Go with your recommendation.

🤖 All tasks are complete.
   | Session     | Result                                    |
   | fix-login   | Opened PR #42 (tests added)               |
   | deps-survey | 3 upgrades are safe, 1 has breaking changes |
```

## Quick start

### Claude Code

Requirements: Claude Code 2.1.275 or later, Node.js 20 or later

Type this command into the Claude Code chat box:

```text
/plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

When asked to confirm adding the marketplace, approve it, then choose "Install for you" on the next screen. The plugin is ready to use right away. The first time you use it, the orchestrator asks for permission to set up a status line so it can read your usage. Once you allow it, the status line is configured, and your current status line keeps showing as before.

<details>
<summary>Installing from a terminal (for example, if you use the desktop app or VS Code)</summary>

Run this command in a terminal, then restart Claude Code (requires Claude Code 2.1.292 or later). The installed plugin works in the terminal, the desktop app and VS Code alike.

```bash
claude plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

In VS Code, you can also install it from the screen that opens when you type `/plugins` in the chat box: add `horiu/inline-agent-orchestrator` on the Marketplaces tab, then install it from the Plugins tab.

</details>

<details>
<summary>Using Claude Code 2.1.257–2.1.274</summary>

Type these commands into the chat box, one at a time:

```text
/plugin marketplace add horiu/inline-agent-orchestrator
```

```text
/plugin install inline-agent-orchestrator@inline-agent-orchestrator
```

</details>

### Codex

Requirements: Codex CLI 0.162 or later (required even if you only use the desktop app), Node.js 20 or later, git

Run these commands in a terminal, in order:

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/.codex/inline-agent-orchestrator
```

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex
```

Restart Codex and you're ready. The setup script registers the MCP server in `~/.codex/config.toml` (saving the previous file as `config.toml.bak-<timestamp>`) and installs the skill into `~/.agents/skills/manage-sessions/`.

## Usage

### Getting started

In a new session, type the command below into the chat box, then describe the tasks you want done.

| | Command |
| --- | --- |
| Claude Code | `/inline-agent-orchestrator:manage-sessions` |
| Codex | `$manage-sessions` |

The orchestrator splits the work, starts worker sessions, and begins monitoring. Saying how far each task should go — "up to opening a PR", "investigate and report" — keeps the work moving without stopping midway.

The orchestrator session is named `Manager`. Claude Code does not let a tool rename a session, so when prompted, type `/rename Manager` into the chat box.

### While it runs

- **Send new requests to the orchestrator** — If a session is already working on the same area, the request goes there; otherwise a new session is started
- **Check on worker sessions** — In Claude Code, list them with `claude agents` and open one with `claude attach <ID>`. In Codex, use `codex agents` and `codex resume <ID>`. You can also talk to an opened session directly
- **Change the model or effort** — Ask something like "have fix-login think harder" or "switch to the implementation settings once the design is done"; the change takes effect from the next instruction
- **Talk to the orchestrator** — Replies may be delayed while it is monitoring. If it's urgent, stop the monitoring first with the stop button (Esc in Claude Code), then type. Nothing that happens in the meantime is lost; it is picked up on the next round of monitoring
- **Stop monitoring** — Stop the monitoring with the stop button (Esc in Claude Code), then say "stop monitoring". The worker sessions keep running, and saying "check on them" resumes monitoring. To stop the worker sessions too, say "stop everything"

### When it's done

Once every task is finished, or only items you chose to decide later remain, the orchestrator reports the results (branches, PRs, remaining work) in a table.

## Configuration

The defaults work out of the box. To change them, place a `config.json` in the data folder (template: [`config.example.json`](config.example.json)).

| | Data folder |
| --- | --- |
| Claude Code | `~/.claude/session-manager-mcp/` |
| Codex | `~/.codex/session-manager/` |

You can also point to another location with the `CSM_HOME` environment variable.

| Key | Default | Description |
| --- | --- | --- |
| `maxRunning` | `3` | Maximum number of worker sessions running at once |
| `minFreeMemGb` | `2` | No new sessions are started while free memory (GB) is below this value |
| `pauseAtPct` | `95` | When usage reaches this percentage, no new sessions are started and running sessions are paused |
| `watchIntervalMin` | `30` | How often the orchestrator checks in when nothing happens (minutes, max 60) |
| `pollSec` | `5` | How often session status is checked (seconds) |
| `profiles` | See below | Model and effort for each kind of task |
| `defaults.model` / `defaults.effort` | — | Model and effort when no profile is used (each tool's default when omitted) |

<details>
<summary>Claude Code and Codex specific settings</summary>

| Key | Default | Description |
| --- | --- | --- |
| `claude.permissionMode` | `"acceptEdits"` | Permission mode for Claude Code worker sessions (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). With `acceptEdits`, file edits run without confirmation, while commands and similar actions wait for approval |
| `claude.path` | `"claude"` | Path to the Claude Code CLI. It is launched without a shell, so specify `claude.exe` or an array rather than a `.cmd` file |
| `defaults.sandbox` | `"workspace-write"` | Sandbox for Codex worker sessions |
| `defaults.approvalPolicy` | `"never"` | Approval policy for Codex worker sessions. With `never`, sessions never stop to wait for approval (actions outside the sandbox fail, and the AI looks for another way) |
| `codexPath` | `"codex"` | Path to the Codex CLI: an absolute path, or an array such as `["node", "C:/…/codex.js"]` |
| `transport` | `"daemon"` | `daemon` uses the shared Codex daemon (recommended). `embedded` runs app-server inside this MCP server (worker sessions stop together with the orchestrator; for testing only) |

</details>

### Choosing models and effort

The orchestrator starts each session with a profile that matches the kind of task. These recommended profiles are built in:

| Profile | Use for | Claude Code | Codex |
| --- | --- | --- | --- |
| `design` | Design and architecture decisions | Opus, xhigh | xhigh |
| `debug` | Investigating bugs with an unknown cause | Opus, high | high |
| `implement` | Everyday implementation and fixes | Opus, medium | medium |
| `review` | Code review | Opus, high | high |
| `writing` | Writing and editing documentation or UI text | Sonnet, high | high |
| `routine` | Well-defined tasks and checks | Sonnet, medium | medium |

- When in doubt, the orchestrator picks the stronger profile — redoing work that was underpowered ends up costing more
- If an investigation doesn't narrow down the cause on the first pass, it raises the effort to xhigh
- Codex model names change between releases, so the Codex profiles set only the effort and use Codex's default model

To customize, add a profile with the same name under `profiles` in `config.json` to replace it, or set it to `null` to remove it. You can also add profiles with new names.

```json
{
  "profiles": {
    "design": {
      "description": "Design and architecture decisions",
      "claude": { "model": "opus", "effort": "max" },
      "codex": { "model": "<model name>", "effort": "xhigh" }
    },
    "routine": null
  }
}
```

### Adding your own rules

Write rules such as exceptions to the profiles, or how many heavy jobs may run at once, in `local-rules.md` in the data folder. The orchestrator reads it first. See [`local-rules.example.md`](skills/manage-sessions/local-rules.example.md) for an example.

To share the reporting rules with sessions you open yourself, append the contents of [`AGENTS.snippet.md`](AGENTS.snippet.md) to `~/.claude/CLAUDE.md` (for Codex, `~/.codex/AGENTS.md`).

### Monitoring interval and usage

While monitoring, it is the MCP server — not the model — that checks session status. Whenever a report arrives or a status changes, the orchestrator responds right away.

When nothing happens, the orchestrator checks in every `watchIntervalMin` minutes and rereads the whole conversation each time. The shorter the interval, the more usage it consumes even when nothing changes (60 times an hour at 1-minute intervals, twice an hour at 30 minutes). The maximum is 60 minutes because beyond that the prompt cache expires before the reread, which ends up costing more. To shorten it temporarily, just ask, for example "check every 10 minutes".

## Updating and uninstalling

### Claude Code

**Update**: type `/plugin` into the chat box, open this plugin on the Installed tab, and choose "Update now". The new version is used from your next session. To use it in the current session, type `/reload-plugins` into the chat box.

This plugin does not update automatically by default. To turn on automatic updates, go to the Marketplaces tab in `/plugin`, select `inline-agent-orchestrator`, and choose "Enable auto-update".

**Uninstall**: first, ask the orchestrator in the chat box to "restore the status line". Then type this command into the chat box and confirm the uninstall on the screen that opens:

```text
/plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator
```

From a terminal, use `claude plugin update inline-agent-orchestrator@inline-agent-orchestrator` (update) and `claude plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator` (uninstall).

### Codex

**Update**: run these commands in a terminal, in order, then restart Codex:

```bash
git -C $HOME/.codex/inline-agent-orchestrator pull
```

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex
```

**Uninstall**: run this command in a terminal, then restart Codex. It removes the MCP server registration and the skill (saving the previous `config.toml` as `config.toml.bak-<timestamp>`).

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex --remove
```

The tool's folder (`~/.codex/inline-agent-orchestrator`) and the monitoring records (`~/.codex/session-manager`) are left in place. Delete them if you no longer need them.

## How it works

```text
You ── request ──▶ Orchestrator (skill: manage-sessions)
                          │  calls MCP tools
                          ▼
                 session-manager (this MCP server)
                 │                              │
             with Codex                   with Claude Code
     codex app-server (shared daemon)   claude --bg / agents / logs / stop
                 │                              │
                 ├── worker session A ── report ──▶ reports.jsonl ──▶ read by the orchestrator
                 └── worker session B
```

Neither Claude Code nor Codex ships a tool that lets the AI operate other sessions. This MCP server exposes each product's official interface — the app-server JSON-RPC API for Codex and the CLI for Claude Code — as tools.

| | Codex | Claude Code |
| --- | --- | --- |
| Where worker sessions run | The shared Codex app-server daemon | Claude Code background sessions (agent view) |
| If you close the orchestrator | Worker sessions keep running | Worker sessions keep running |
| Messages to a running session | Processed after the current turn (interrupting is also possible) | Held by the MCP server and delivered after the turn ends |
| How usage is read | From app-server | From `usage.json`, written by the status line |

- Reports from worker sessions are written to a file by the `report` tool of the same MCP server and read by the orchestrator. Claude Code worker sessions see only the `report` tool; the orchestrator's tools are disabled for them
- Claude Code usage cannot be read from the CLI; the values passed to the status line are the only official source. That is why a status line is set up on first use. Your previous status line is saved and its output keeps being shown
- Claude Code worker sessions create a worktree under `.claude/worktrees/` before editing and work inside it (the default behavior of agent view)

<details>
<summary>Tool reference</summary>

| Tool | Used by | Description | Codex (app-server) | Claude Code (CLI) |
| --- | --- | --- | --- | --- |
| `list_sessions` | Orchestrator | List managed sessions, or all sessions, with their status | `thread/read`, `thread/list` | `claude agents --json` |
| `read_session` | Orchestrator | Recent exchanges | `thread/turns/list` | `claude logs` |
| `start_session` | Orchestrator | Start a session with a profile (or a model and effort), name it, and send the first request. If a limit would be exceeded, it does not start and returns the reason | `thread/start`, `turn/start` | `claude --bg` |
| `send_message` | Orchestrator | Send after the current turn to a running session, or as a continuation to a stopped one. Can also change the model or effort | `thread/queue/add`, `turn/start`, `turn/steer` | Held, then `claude --resume --bg` |
| `stop_session` | Orchestrator | Stop the running turn | `turn/interrupt` | `claude stop` |
| `set_session_name` | Orchestrator | Rename a session | `thread/name/set` | Record only |
| `get_usage` | Orchestrator | Usage, free memory, number of running sessions, whether a new one may start, and the list of profiles | `account/rateLimits/read` | `usage.json` |
| `update_session` | Orchestrator | Update the record (status, notes, on hold) | `state.json` | `state.json` |
| `wait_events` | Orchestrator | Wait for status changes, reports, approval requests, low memory, and usage limits being hit or reset | `thread/read` | `claude agents --json` |
| `read_reports` | Orchestrator | Read reports | `reports.jsonl` | `reports.jsonl` |
| `report` | Worker session | Report to the orchestrator | `reports.jsonl` | `reports.jsonl` |

Every call follows the official documentation (for Codex, `learn.chatgpt.com/docs/app-server` and the type definitions in openai/codex; for Claude Code, the CLI, agent view, status line, and plugin pages at `code.claude.com/docs`).

</details>

## Limitations

- **It does not approve on your behalf** — When a worker session is waiting for approval or input, the orchestrator only tells you how to open it. With Claude Code's default (`acceptEdits`), running commands waits for confirmation
- **Monitoring happens within the orchestrator's turn** — When no sessions are running, monitoring ends and resumes the next time you talk to the orchestrator
- **Only the number of sessions and memory are watched** — Individual processes, such as how many dev servers are running, are not counted. Put any rules you need in `local-rules.md`
- **Codex worker sessions can see every tool** — They load MCP servers from your user-wide configuration. The first request tells them not to use anything other than `report`
- **Messages to a running Claude Code session arrive after its turn ends** — Messages held for a session that is then stopped are discarded
- **Reports are exchanged only within the same machine**
- **Built on experimental features** — Parts of the Codex app-server and Claude Code's agent view are experimental, and their behavior may change between versions
- **Desktop app integration is unverified** — Whether worker sessions appear in the desktop apps' session lists has not been checked. While a session is running, don't continue it from a desktop app

## Verification

Because it has not yet been verified against real Claude Code or Codex, please start with the steps below. They use one session and about one short request's worth of usage. If a step fails, stop there and collect the information listed in [Reporting issues](#reporting-issues).

<details>
<summary>Claude Code (C1–C6)</summary>

| # | Check | Steps | If it fails |
| --- | --- | --- | --- |
| C1 | Installation | In the chat box, open `/plugin` — does it appear on the Installed tab? Open `/mcp` — is the plugin's `session-manager` connected? | Check that `node --version` is 20 or later |
| C2 | Tools and usage | Run `/inline-agent-orchestrator:manage-sessions` → allow the status line setup → wait a moment, then ask "call `get_usage`" → are usage (5h, weekly) and free memory shown? | Check `statusLine` in `~/.claude/settings.json` and `~/.claude/session-manager-mcp/usage.json` |
| C3 | Starting a session | Start `claude` once in a test folder and trust it. Then ask: "`start_session` with the name 'trial', that folder as the working folder, and the request 'count the files and send the result with report'" → does 'trial' appear in `claude agents`? | Read the error message returned by the tool |
| C4 | Receiving reports | Does `wait_events` receive the `report` (done)? With `claude attach <ID>` → `/mcp`, does the worker session show `session-report` while the orchestrator's tools are unavailable? | Check `~/.claude/session-manager-mcp/worker-mcp.json` |
| C5 | Messaging a running session | While a longer request is running, `send_message` → `delivery: queued`; after it finishes, `wait_events` shows `queuedDelivered` and the work continues in the same session? | If it continues under a different ID, `copiedTo` is shown |
| C6 | Interrupting the monitoring | Press Esc during `wait_events` → does monitoring stop and the orchestrator respond? Does the next `wait_events` return what happened in the meantime? | Use a shorter `watchIntervalMin` |

Cleanup: `claude stop <ID>`, `claude rm <ID>`, `update_session` (remove)

</details>

<details>
<summary>Codex (V1–V5)</summary>

| # | Check | Steps | If it fails |
| --- | --- | --- | --- |
| V1 | Codex version | Is `codex --version` 0.162 or later? Does `codex app-server proxy --help` print help? | Update the CLI |
| V2 | Starting the shared daemon | In a non-administrator PowerShell (Windows), run `codex app-server daemon start` → does `codex agents` open? | Try again with `"transport": "embedded"` in `config.json` |
| V3 | Tool connection | In the orchestrator session, ask "call `get_usage`" → are usage and free memory shown? | Read the error message returned by the tool |
| V4 | Starting a session | Ask: "`start_session` with the name 'trial', an empty folder as the working folder, and the request 'count the files and send the result with report'" → does it appear in `codex agents`, and does `wait_events` receive the report? | If it does not appear in the desktop app, check it with `codex resume <ID>` |
| V5 | Messaging a running session | While a longer request is running, `send_message` → is it processed after the turn, without interrupting? How is text you type during `wait_events` handled? | If it interrupts, add "send only while stopped" to `local-rules.md` |

Cleanup: `codex archive <ID>`, `update_session` (remove), and `codex app-server daemon stop` if needed

</details>

### Common errors

| Message | Fix |
| --- | --- |
| `Workspace not trusted` (Claude Code) | Start `claude` once in the working folder and trust it |
| `claude agents --json returned something that is not JSON` (Claude Code) | Update the CLI. Check agent view's status with `claude daemon status` |
| `daemon start failed` (Codex) | On Windows, it cannot be started from an administrator PowerShell. It also fails if the `CODEX_HOME` path is too long |
| `thread/queue/add を使えません` (Codex) | Update Codex |
| Monitoring times out (Codex) | In a terminal, run `node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex` again (it fixes `tool_timeout_sec`) |

### Reporting issues

The following information helps track down the cause.

- The step that failed (C1–C6, V1–V5) and the output of `claude --version` or `codex --version`, and `node --version`
- The error message, or the full output of the command
- `state.json`, `reports.jsonl`, and `config.json` from the data folder; for Claude Code, also `worker-mcp.json`, `usage.json`, and `statusline.json`
- For Claude Code, the output of `claude plugin list` run in a terminal; for Codex, the `[mcp_servers.session-manager]` section of `config.toml`

## Development

```bash
npm test
```

To release a new version, set the same `version` in `.claude-plugin/plugin.json` and `package.json` and push it to main. The tag (`v<version>`) and the GitHub release are created automatically.

| Path | Description |
| --- | --- |
| `src/server.mjs` | MCP server (stdio, JSON-RPC 2.0) |
| `src/tools.mjs` | Tools, limit checks, monitoring |
| `src/backends/` | Implementations for Codex (app-server) and Claude Code (CLI) |
| `src/setup.mjs` | Setup script (Codex registration and skill installation, Claude Code status line) |
| `src/claude-statusline.mjs` | Status line that records Claude Code usage |
| `src/appserver.mjs` / `src/ws.mjs` | Codex app-server client (Node.js on Windows cannot use Unix domain sockets, so it talks WebSocket through `codex app-server proxy`) |
| `skills/manage-sessions/` | The orchestrator's instructions (skill) |
| `.claude-plugin/` | Claude Code plugin and marketplace definitions |
| `test/` | Unit tests with mocks of the Codex and Claude Code CLIs and app-server |

<details>
<summary>Installing into Claude Code without the plugin</summary>

Run these commands in a terminal, in order:

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/.claude/inline-agent-orchestrator
```

```bash
claude mcp add session-manager --scope user -e CSM_AGENT=claude -- node $HOME/.claude/inline-agent-orchestrator/src/server.mjs
```

```bash
node $HOME/.claude/inline-agent-orchestrator/src/setup.mjs statusline
```

Copy `skills/manage-sessions/` into `~/.claude/skills/` and invoke it with `/manage-sessions`.

</details>

## License

[MIT](LICENSE)
