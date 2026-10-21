# Inline Agent Orchestrator

English | [日本語](README.md)

**However many tasks you hand off, you only ever talk to one chat.**

When you run several tasks in parallel with Claude Code or Codex, do you end up opening session after session and checking on each one in turn? Inline Agent Orchestrator turns the chat you already use into the coordinator. It starts a session for each task, keeps an eye on their progress, and comes back to you only with the decisions that need you, all at once. The screens and controls stay the same Claude Code and Codex you know.

> [!NOTE]
> This is a prototype (v0.9.1). The unit tests pass, but it has not yet been verified against real Claude Code or Codex sessions. Please run through [Verification](#verification) before relying on it.
>
> Messages from the tools and the skill's instructions are currently written in Japanese. The model still understands and answers in your language.

## Features

- **The UI you already use** — There is no separate app or screen. You keep using Claude Code and Codex as they are, with no tmux or background service to run
- **A session for each task** — Splits your request into tasks, picks a name, working folder and model for each, and runs them in separate sessions
- **Questions batched, with a recommendation** — Gathers every session's "how should I proceed?" and asks them in one go, with options and a recommendation. Once you answer, each task picks up where it left off
- **Listed in the Claude desktop app's sidebar** — In the Claude desktop app, worker sessions start as desktop app sessions and are listed under the orchestrator. They are pinned while they run and unpinned when they finish. The orchestrator itself is pinned too ([Using the Claude desktop app](#using-the-claude-desktop-app))
- **Easy on your machine and your plan limits** — There is no fixed number of sessions; new ones start while there is free memory and CPU to spare. Work stopped by a usage limit is picked up where it left off once the limit resets ([Usage limits](#usage-limits))
- **Stalled work gets back on track** — Notices sessions that crashed or stopped midway and asks them to carry on from where they stopped
- **Notes for later (TODOs)** — Just say something like "continue PR #7 once my usage limit resets". When the condition is met, the orchestrator asks whether to start it, and starts a worker session from it ([Things to do later (TODOs)](#things-to-do-later-todos))
- **A list from any chat** — `/inline-agent-orchestrator:status` shows the worker sessions, the TODOs and the handoff note as tables ([Seeing the list](#seeing-the-list))
- **Only Node.js required** — No other packages, so it stays light

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

Type this command into the chat box of Claude Code running in a terminal:

```text
/plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

When asked to confirm adding the marketplace, approve it, then choose "Install for you" on the next screen. The plugin is ready to use right away.

This command does not work in the chat box of the Claude desktop app or VS Code. Instead, run this command in a terminal and restart the Claude desktop app or VS Code (requires Claude Code 2.1.292 or later). The installed plugin works in the terminal, the Claude desktop app and VS Code alike.

```bash
claude plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

In VS Code, you can also install it from the screen that opens when you type `/plugins` in the chat box: add `horiu/inline-agent-orchestrator` on the Marketplaces tab, then install it from the Plugins tab.

With Claude Code, the orchestrator does not read your usage by default ([Usage limits](#usage-limits)). Only if you set `pauseAtPct` and use the terminal does it ask for permission to set up a status line so it can read your usage. Once you allow it, the status line is configured, and your current status line keeps showing as before. The Claude desktop app does not show a status line, so usage cannot be read there even with it set up.

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

Requirements: Codex CLI 0.162 or later (required even if you only use the Codex desktop app), Node.js 20 or later, git

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

The orchestrator session is named `<repository name> Manager` (for example, `wakarium Manager`). The repository name is that of the working folder's git repository; inside a worktree it is the original repository's name (outside git, the working folder's name). In the Claude desktop app this happens automatically. Claude Code in the terminal does not let a tool rename a session, so when prompted, type `/rename <repository name> Manager` into the chat box.

### Using the Claude desktop app

When the orchestrator runs in the Claude desktop app (Code tab), worker sessions start as desktop app sessions.

- **Listed in the sidebar** — Worker sessions are listed under the orchestrator; click one to open it and talk to it directly. The desktop app creates a worktree and a branch for each worker session
- **The orchestrator is pinned too** — The orchestrator session pins itself when it starts. It is not unpinned automatically when all the work is done, so unpin it when you no longer need it (or ask the orchestrator to "unpin yourself"). When you start the orchestrator again in a new session, it unpins the previous orchestrator for the same repository recorded in the handoff note (`handoff.md`). Orchestrators for other repositories stay pinned
- **Pinned while running** — Managed worker sessions are pinned while they run and unpinned when they are done. After the final report, the orchestrator asks whether to archive the finished sessions (archiving also cleans up their worktrees)
- **What you type is read right away** — The orchestrator does not sit waiting to monitor; it ends its turn once it has done what it can. When a worker session ends its turn, the Claude desktop app notifies the orchestrator, which then handles the reports and statuses. So whatever you type into the chat box is read at once
- **When you ask remotely, or when a notice wakes it** — When you ask through Remote Control (a phone or claude.ai), or when a notice woke the orchestrator, the Claude desktop app does not accept a start. The orchestrator then shows a suggestion card and also keeps a TODO. Click the card in the desktop app on your PC to start the session; if you type again without clicking it, the orchestrator starts it then
- **The tools do not read usage** — The Claude desktop app shows no status line, so stopping for usage (`pauseAtPct`) has no effect there. For "once the usage limit resets" TODOs, the orchestrator reads the plan limits through the Claude desktop app

Because of how the notices work, some things arrive late:

| What | When it reaches the orchestrator |
| --- | --- |
| A worker session's question, completion or "cannot proceed" report | Right away (the worker ends its turn there) |
| A worker session's progress report | When that worker session ends its turn |
| Reports while several worker sessions run | When no worker session is running any more (or when you type) |
| Waiting for an approval or input | The Claude desktop app notifies you itself |
| TODO conditions such as a date or a merged PR | When the orchestrator runs (when you type, or on a notice) |

The pattern of the orchestrator ending its turn and running on worker sessions' notices was tried by running a 0.8.0 orchestrator that way in the Claude desktop app for a day. What 0.9.0 adds — `wait: false` on `wait_events`, TODOs and the list command — is covered by unit tests only and has not yet been tried in the real Claude desktop app ([Verification](#verification), D2–D5).

A late progress report does not hold up the work; the worker session keeps going. To check on things sooner, talk to the orchestrator or open the worker session. `claude --bg` sessions and sessions started by an earlier orchestrator send no notices, so they are checked only when you type.

Claude Code in the terminal keeps starting `claude --bg` background sessions. To use `claude --bg` from the Claude desktop app (ask "start it with `via: bg`"), first start `claude` in a terminal and `/login` (the desktop app's sign-in does not apply to the CLI). Background sessions do not appear in the desktop app's sidebar and cannot be pinned.

### While it runs

- **Send new requests to the orchestrator** — If a session is already working on the same area, the request goes there; otherwise a new session is started
- **Check on worker sessions** — In Claude Code, list them with `claude agents` and open one with `claude attach <ID>`. In Codex, use `codex agents` and `codex resume <ID>`. You can also talk to an opened session directly
- **Change the model or effort** — Ask something like "have fix-login think harder" or "switch to the implementation settings once the design is done"; the change takes effect from the next instruction
- **Talk to the orchestrator** — In the Claude desktop app, what you type is always read right away. In Claude Code in the terminal and in Codex, what you type while it is monitoring is not read until the monitoring next returns (up to `watchIntervalMin`, 30 minutes by default). If it's urgent, stop the monitoring first with the stop button (■; Esc in Claude Code in the terminal), then type. Nothing that happens in the meantime is lost; it is picked up on the next round of monitoring. The orchestrator mentions this when it starts monitoring
- **Stop monitoring** — Say "stop monitoring" (in Claude Code in the terminal and in Codex, stop the monitoring with the stop button first). The worker sessions keep running, and saying "check on them" resumes monitoring. To stop the worker sessions too, say "stop everything"
- **See the list** — From any chat, type `/inline-agent-orchestrator:status` to see the worker sessions, the TODOs and the handoff note as tables ([Seeing the list](#seeing-the-list))

### Things to do later (TODOs)

You can have the orchestrator note down work that stopped at a usage limit, or work you want to run later. No numbers or fixed wording are needed.

```text
👤 Let's do this later. Once my usage limit resets, continue PR #7.
🤖 Saved as TODO 3 (condition: once the usage limit resets).

   (after the limit resets, when you type or a worker session's notice arrives)

🤖 The condition is met. Start "continue PR #7" (TODO 3)?
👤 Start number 3
```

- **Conditions** — Any time, once the usage limit resets, once PR #N is merged, once a new version is running (loaded) or after a restart, or at a date and time. The orchestrator checks them whenever it runs (when you type, on a notice, while monitoring). A merged PR is checked with `gh` (GitHub CLI)
- **The orchestrator adds its own** — When a worker session stops at a usage limit, when a start is held back for lack of room on the PC, when it shows a suggestion card, or when something needs your check (for example, what to verify after restarting the Claude desktop app), it adds a TODO. Work you already asked for (continuing after a usage limit, waiting for room, a card) goes ahead without asking once the condition is met
- **Starting one** — "Start number 2" or "do that" turns the TODO into a request and starts a worker session (or, for a session you put on hold, asks that session to continue). When the worker session is done, the TODO is marked done too
- **Where it is kept** — In `state.json` in the data folder, so it carries over when you start the orchestrator in a new chat. The handoff note `handoff.md` lists them too

### Seeing the list

From any chat, this command shows the list. It doesn't have to be the orchestrator's chat (in Claude Code in the terminal, an orchestrator that is monitoring would not read it). It only shows; it changes nothing.

```text
/inline-agent-orchestrator:status
```

- **Worker sessions** — Name, state (working, waiting for a decision, waiting for approval, done, …), branch, PR, what it waits for, and how to open it. In the Claude desktop app, the name links to the session
- **TODOs** — What to do, the condition, and whether it is met
- **Handoff note** — When `handoff.md` was updated, and its gist

Finished worker sessions and done TODOs are hidden by default; type `/inline-agent-orchestrator:status all` to show them. Codex has no such command; in another chat, ask "show the list with session-manager's list_sessions".

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
| `minFreeMemGb` | `2` | No new sessions are started while free memory (GB) is below this value |
| `maxCpuPct` | `90` | No new sessions are started while CPU usage (%, averaged over one second) is at or above this value. `null` ignores the CPU |
| `pauseAtPct` | Claude Code: `null`<br>Codex: `95` | When usage reaches this percentage, no new sessions are started and running sessions are stopped. `null` never stops for usage. A number applies to both; write `{ "claude": 90 }` to change one only ([Usage limits](#usage-limits)) |
| `watchIntervalMin` | `30` | How often the orchestrator checks in when nothing happens (minutes, max 60). Claude Code in the terminal and Codex only (in the Claude desktop app it does not wait) |
| `pollSec` | `5` | How often session status is checked while monitoring (seconds). Reports are picked up right away, without waiting for this interval |
| `stopWhenStuckMin` | `120` | End the monitoring when nothing can move forward (every session waits for a decision, an approval or input, or for free memory or CPU) for this many minutes. Waiting for the usage limit to reset does not count. `null` never ends it. Claude Code in the terminal and Codex only ([When nothing can move forward](#when-nothing-can-move-forward)) |
| `profiles` | See below | Model and effort for each kind of task |
| `defaults.model` / `defaults.effort` | — | Model and effort when no profile is used (each tool's default when omitted) |

The cap on the number of running sessions (the former `maxRunning`) is gone. It is ignored if it is still in `config.json`.

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

The monitoring described here is that of Claude Code in the terminal and Codex. In the Claude desktop app, the orchestrator does not sit waiting; it reads the state once each time a worker session's notice or your message wakes it ([Using the Claude desktop app](#using-the-claude-desktop-app)).

While monitoring, it is the MCP server — not the model — that checks session status. Whenever a report arrives or a status changes, the orchestrator responds right away.

Reports are picked up as soon as they are written (through file change notifications). Where notifications don't arrive (network drives, for example), reports are still read again every `pollSec`, so nothing is missed. A status check (`claude agents --json` in Claude Code) takes about 0.25 seconds, which at every 5 seconds is about 5% of one CPU core. Since the work happens in real time, the default favors low delay.

When nothing happens, the orchestrator checks in every `watchIntervalMin` minutes and rereads the whole conversation each time. The shorter the interval, the more usage it consumes even when nothing changes (60 times an hour at 1-minute intervals, twice an hour at 30 minutes). The maximum is 60 minutes because beyond that the prompt cache expires before the reread, which ends up costing more. To shorten it temporarily, just ask, for example "check every 10 minutes".

### When nothing can move forward

In Claude Code in the terminal and in Codex, when every session is waiting for a decision, an approval or input, or for free memory or CPU, and nothing can move forward for `stopWhenStuckMin` (2 hours by default), the orchestrator ends the monitoring by itself, so that it doesn't keep using usage and CPU while waiting for nothing. When only sessions waiting for your decision are left, it also waits this long before ending. Waiting for the usage limit to reset does not count, since the work resumes once it does. A report, a status change or an instruction from the orchestrator starts the count over.

When it ends the monitoring, the orchestrator:

- Tells you why it stopped, what is waiting (questions are gathered with options and a recommendation; approval requests come with how to open the session), and how to resume
- Writes a handoff note, `handoff.md`, to the data folder (the managed sessions, decisions made, and next steps)
- Sends a short notification, if a notification tool is available

After that, type anything and the orchestrator reads the handoff note and the latest state, answers you, and goes back to monitoring, even if you don't say "check on them". If you stopped it with "stop monitoring" or "stop everything", it doesn't go back until you say "check on them" or ask for new work.

In the Claude desktop app this does not apply, since the orchestrator does not hold its turn. It asks waiting questions together as soon as it learns of them, and rewrites the handoff note at the end of any turn in which the managed sessions, decisions or TODOs changed.

The orchestrator can't compact its own conversation (`/compact` is a command you type). When the conversation gets long, use the handoff note instead: ask it to "write a handoff note", then start manage-sessions in a new session, and it picks up from the note.

### Usage limits

Stopping a running session part-way is not a pause. The running turn is cut off, and what it had read and worked out in that turn is lost — exactly as when a usage limit stops it. Code already written to the working tree stays in either case.

- **Claude Code (default: never stop)** — When the limit is reached, worker sessions and the orchestrator stop. The orchestrator session comes back through Claude Code's "continue automatically when the limit resets". It then finds the worker sessions stopped by the limit and asks each to check `git status` and `git diff` and carry on from where it stopped
- **Codex (default: stop at 95%)** — Whether a Codex orchestrator stopped by the limit comes back by itself has not been checked, so worker sessions are still stopped just short of the limit. The orchestrator keeps some usage, the watch continues without the model, and once the limit resets the orchestrator asks the sessions to resume

To stop short of the limit anyway — for example, to keep the rest of your usage for other work — set `pauseAtPct` in `config.json`, or tell the orchestrator something like "stop at 90%". Reading Claude Code usage needs the status line, which does not work in the Claude desktop app.

A `config.json` copied from an older `config.example.json` still has `"pauseAtPct": 95`, which stops Claude Code sessions at 95% too. To stop never, remove that line or change it to `{ "claude": null }`.

## Updating and uninstalling

### Claude Code

**Update**: in the chat box of Claude Code started in a terminal, type `/plugin`, open this plugin on the Installed tab, and choose "Update now". In a terminal, `claude plugin update inline-agent-orchestrator@inline-agent-orchestrator` updates it too. The new version is used by sessions you start afterwards.

A running session keeps using the old version after an update. To switch it to the new one:

- **Claude Code in the terminal** — type `/reload-plugins` into the chat box, or start Claude Code again
- **The Claude desktop app** — quit the Claude desktop app and start it again. Whether `/reload-plugins` in the desktop app's prompt box switches the orchestrator's MCP server to the new version has not been verified (in Claude Code 2.1.304, when run the way the desktop app runs it (the SDK), `/reload-plugins` is treated as a terminal command and reports no count of reloaded MCP servers)

Quitting the desktop app also stops the worker sessions running in it. Switch while no worker session is running.

**Notice of a new version**: the orchestrator checks the version when it starts and when it resumes after stopping. When a new version is on disk but this conversation still uses the old one, it tells you how to switch, as above. When a new version is out on GitHub but not installed, it asks whether to update, and on your yes runs `claude plugin marketplace update` and `claude plugin update`. GitHub is checked when auto-update is off and in the Claude desktop app (see "Auto-update" below), at most once a day (an hour later when the read failed). Each notice appears only once per conversation for the same versions. It is recorded in `state.json` in the data folder, so compacting or resuming the conversation does not repeat it.

**Auto-update**: this plugin does not update automatically by default. To turn on automatic updates, go to the Marketplaces tab in `/plugin` in Claude Code started in a terminal, select `inline-agent-orchestrator`, and choose "Enable auto-update". Auto-update puts the new version on disk within ten minutes after you send the first message in a session.

The Claude desktop app runs Claude Code with `DISABLE_AUTOUPDATER=1`. The Claude Code documentation says this also stops plugin auto-update (adding `FORCE_AUTOUPDATE_PLUGINS=1` turns it back on).

Even so, on a PC that turned auto-update on and uses only the desktop app, the following happened. This was seen only once, and which process installed the new version is not known.

- 2026-10-21T21:51:43Z: 0.7.0 was merged into main
- 21:53:45Z: a new conversation started in the desktop app
- 21:54:51Z (about a minute later): the version in `installed_plugins.json` became 0.7.0. No conversation ran `claude plugin update` by hand

So in the desktop app the orchestrator ignores this setting and returns `autoUpdate` as set in `/plugin`. In case auto-update does not run there after all, the desktop app still checks GitHub once a day and asks whether to update when a newer version is not installed. In Claude Code in the terminal, as documented, it treats auto-update as off when this setting (or `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) is set without `FORCE_AUTOUPDATE_PLUGINS=1`.

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

When the version you pulled with `git pull` is newer than the running one, the orchestrator suggests restarting Codex. When a new version is out on GitHub (checked at most once a day), it asks whether to update.

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
                 │                       (in the Claude desktop app, the orchestrator
                 │                        starts, messages and pins sessions with
                 │                        the desktop app's tools; status comes from
                 │                        claude agents)
                 │                              │
                 ├── worker session A ── report ──▶ reports.jsonl ──▶ read by the orchestrator
                 └── worker session B
```

Neither Claude Code nor Codex ships a tool that lets the AI operate other sessions. This MCP server exposes each product's official interface — the app-server JSON-RPC API for Codex and the CLI for Claude Code — as tools.

| | Codex | Claude Code (Claude desktop app) | Claude Code (terminal) |
| --- | --- | --- | --- |
| Where worker sessions run | The shared Codex app-server daemon | App sessions (listed in the sidebar) | Background sessions (agent view) |
| Starting, messaging, stopping | The MCP server | The orchestrator, with the desktop app's tools (`mcp__ccd_*`) | The MCP server |
| If you close the orchestrator | Worker sessions keep running | Worker sessions keep running | Worker sessions keep running |
| Messages to a running session | Processed after the current turn (interrupting is also possible) | Held by the desktop app and delivered after the turn ends | Held by the MCP server and delivered after the turn ends |
| Monitoring | Waits within the orchestrator's turn (`wait_events`) | Does not wait. Reads once whenever a Claude desktop app notice or your message wakes it (`wait_events` with `wait: false`) | Waits within the orchestrator's turn (`wait_events`) |
| How usage is read | From app-server | Not read | From `usage.json`, written by the status line |

- The MCP server cannot call the desktop app's tools, so in the Claude desktop app `start_session` returns the values to pass to the desktop app; the orchestrator starts the session with the desktop app's `start_session` and records it with `update_session`. Status comes from the session's row in `claude agents --json` (busy, idle). The app's session ID (`local_…`) differs from the Claude Code session ID, so the row is first found by title and then linked by the session ID that the worker's `report` carries
- Reports are written to a file by the `report` tool on the dedicated `session-report` connection and read by the orchestrator. In both Claude Code and Codex, this connection exposes only `report`, and the worker's `session-manager` is disabled. Worker sessions in the Claude desktop app cannot be given a connection at start, so they use `report` from the plugin's `session-manager` (their request tells them not to use its other tools). App sessions cannot be given allowed tools at start, so a plugin hook (`hooks/hooks.json`, PreToolUse) allows this `report` alone without a prompt (it only appends to the report file)
- A task held back for lack of free memory, CPU or usage is kept as a "once the PC has room" TODO. While there is one, the watch keeps going and checks them, then tells the orchestrator to start it once there is room
- TODOs are kept under `todos` in `state.json`. The MCP server checks the conditions it can (a date, the version, a restart, room on the PC, a merged PR through `gh pr view`, and the usage when it can read it); the usage in the Claude desktop app is checked by the orchestrator with the desktop app's tool (`mcp__ccd_session_mgmt__get_usage`). Records from 0.8.0 and earlier for work waiting for resources (`wait:<name>`) and suggestion cards (`card:<name>`) move into TODOs when first read
- Claude Code usage cannot be read from the CLI; the values passed to the status line are the only official source. That is why a status line is set up when you use `pauseAtPct`. Your previous status line is saved and its output keeps being shown. The Claude desktop app shows no status line, so no usage is recorded there
- Whether a Claude Code worker session was stopped by a usage limit is inferred from wording such as "Usage limit reached" near the end of `claude logs` (`usageLimit` in `read_session`). The wording is not a published interface, so a change to it would go unnoticed
- Claude Code worker sessions create a worktree under `.claude/worktrees/` before editing and work inside it (the default behavior of agent view)

<details>
<summary>Tool reference</summary>

| Tool | Used by | Description | Codex (app-server) | Claude Code (CLI) |
| --- | --- | --- | --- | --- |
| `list_sessions` | Orchestrator (any session, for the list command) | List managed sessions, or all sessions, with their status. For managed sessions it also returns the TODOs (whether each condition is met) and the start of the handoff note | `thread/read`, `thread/list` | `claude agents --json` |
| `read_session` | Orchestrator | Recent exchanges | `thread/turns/list` | `claude logs` |
| `start_session` | Orchestrator | Start a session with a profile (or a model and effort), name it, and send the first request. Without enough memory, CPU or usage to spare, it does not start and returns the reason. In the Claude desktop app it does not start, and returns the values to pass to the desktop app | `thread/start`, `turn/start` | `claude --bg` |
| `send_message` | Orchestrator | Send after the current turn to a running session, or as a continuation to a stopped one. Can also change the model or effort | `thread/queue/add`, `turn/start`, `turn/steer` | Held, then `claude --resume --bg` |
| `stop_session` | Orchestrator | Stop the running turn | `turn/interrupt` | `claude stop` |
| `set_session_name` | Orchestrator | Rename a session | `thread/name/set` | Record only |
| `get_usage` | Orchestrator | Usage, free memory, CPU, number of running sessions, whether a new one may start (usage counts only with `pauseAtPct`), how sessions are started (`launcher`), the list of profiles, and this tool's versions (running, installed and newest) | `account/rateLimits/read` | `usage.json` |
| `update_session` | Orchestrator | Update the record (status, notes, on hold, adding a Claude desktop app session, the TODO it works on). Marking it done marks its TODOs done too | `state.json` | `state.json` |
| `todo` | Orchestrator | Add, change, complete or remove a TODO | `state.json` | `state.json` |
| `wait_events` | Orchestrator | Wait for status changes, reports (as soon as they are written), approval requests, low memory, usage limits being hit (with `pauseAtPct`) or reset, room to start a task held back for resources, and TODOs whose condition is met. Ends with a list of what is waiting when nothing can move forward for long. With `wait: false` it returns at once with what is known | `thread/read` | `claude agents --json` |
| `read_reports` | Orchestrator | Read reports | `reports.jsonl` | `reports.jsonl` |
| `report` | Worker session | Report to the orchestrator | `reports.jsonl` | `reports.jsonl` |

Every call follows the official documentation (for Codex, `learn.chatgpt.com/docs/app-server` and the type definitions in openai/codex; for Claude Code, the CLI, agent view, status line, and plugin pages at `code.claude.com/docs`).

</details>

## Limitations

- **It does not approve on your behalf** — When a worker session is waiting for approval or input, the orchestrator only tells you how to open it. With Claude Code's default (`acceptEdits`), running commands waits for confirmation
- **In Claude Code in the terminal and in Codex, monitoring happens within the orchestrator's turn** — What you type while it monitors is not read for up to `watchIntervalMin` minutes (stop it with the stop button and it is read at once). When no sessions are running, or nothing can move forward for long, monitoring ends and resumes the next time you talk to the orchestrator
- **In the Claude desktop app, progress reports arrive late** — A progress report arrives when the worker session ends its turn, and while several worker sessions run, when none is running any more ([Using the Claude desktop app](#using-the-claude-desktop-app))
- **Nothing runs on a timer** — TODOs that wait for a date or a merged PR are checked when the orchestrator runs (when you type, on a notice, while monitoring)
- **Only free memory and CPU are watched** — Individual processes, such as how many dev servers are running, are not counted. Put any rules you need in `local-rules.md`
- **Codex workers use a dedicated reporting connection** — For sessions started by this tool, only `session-report`'s `report` is pre-approved. `session-manager` is disabled within that worker; other MCP servers' approval settings and the sandbox are unchanged. Reporting settings are reapplied when the orchestrator resumes the worker. If an older session is still connected to another terminal or manager, close that connection and let the shared daemon unload it before resuming
- **Messages to a running Claude Code session arrive after its turn ends** — Messages held for a session that is then stopped are discarded
- **Reports are exchanged only within the same machine**
- **Built on experimental features** — Parts of the Codex app-server and Claude Code's agent view are experimental, and their behavior may change between versions
- **`claude --bg` sessions do not appear in the Claude desktop app** — They are not listed and cannot be pinned. In the Claude desktop app, worker sessions start as desktop app sessions
- **In the Claude desktop app, worker sessions can start only within a turn you typed** — Work to start when a notice woke the orchestrator (waiting for room, a TODO whose condition is met) gets a suggestion card and a TODO, and starts the next time you type
- **Whether Claude Code worker sessions continue by themselves when the limit resets is unverified** — If they don't, the orchestrator asks them to carry on once it is back
- **A new working folder must first be trusted on the PC (Claude Code)** — `claude --bg` cannot show the trust prompt. Trust is recorded per repository; trusting a parent folder does not cover the repositories under it. When you use the orchestrator remotely (Remote Control, a phone), use an already trusted repository as the working folder

## Verification

Because it has not yet been verified against real Claude Code or Codex, please start with the steps below. They use one session and about one short request's worth of usage. If a step fails, stop there and collect the information listed in [Reporting issues](#reporting-issues).

<details>
<summary>Claude Code (C1–C6)</summary>

| # | Check | Steps | If it fails |
| --- | --- | --- | --- |
| C1 | Installation | In the chat box, open `/plugin` — does it appear on the Installed tab? Open `/mcp` — is the plugin's `session-manager` connected? | Check that `node --version` is 20 or later |
| C2 | Tools and usage | Run `/inline-agent-orchestrator:manage-sessions` → ask "call `get_usage`" → is free memory shown, with `pauseAtPct` `null`? To try usage too, write `"pauseAtPct": { "claude": 95 }` in `config.json`, run it in a terminal and allow the status line setup → wait a moment and ask again → is usage (5h, weekly) shown? | Check `statusLine` in `~/.claude/settings.json` and `~/.claude/session-manager-mcp/usage.json` |
| C3 | Starting a session | Start `claude` once in a test folder and trust it. Then ask: "`start_session` with the name 'trial', that folder as the working folder, and the request 'count the files and send the result with report'" → does 'trial' appear in `claude agents`? | Read the error message returned by the tool |
| C4 | Receiving reports | Does `wait_events` receive the `report` (done)? With `claude attach <ID>` → `/mcp`, does the worker session show `session-report` while the orchestrator's tools are unavailable? | Check `~/.claude/session-manager-mcp/worker-mcp.json` |
| C5 | Messaging a running session | While a longer request is running, `send_message` → `delivery: queued`; after it finishes, `wait_events` shows `queuedDelivered` and the work continues in the same session? | If it continues under a different ID, `copiedTo` is shown |
| C6 | Interrupting the monitoring | Press Esc during `wait_events` → does monitoring stop and the orchestrator respond? Does the next `wait_events` return what happened in the meantime? | Use a shorter `watchIntervalMin` |

Cleanup: `claude stop <ID>`, `claude rm <ID>`, `update_session` (remove)

</details>

<details>
<summary>Claude desktop app (D1–D5)</summary>

| # | Check | Steps | If it fails |
| --- | --- | --- | --- |
| D1 | Starting and pinning | In the Claude desktop app's Code tab, run `/inline-agent-orchestrator:manage-sessions` → is the orchestrator session pinned? Ask "start a worker session named 'trial' with the request 'count the files and send the result with report'" → does 'trial' appear under the orchestrator in the sidebar, pinned? | Check that `launcher` in `get_usage` is `app` |
| D2 | Not holding the turn | After the start, does the orchestrator end its turn at once (the chat box is free)? Type something while 'trial' works → is it answered at once? | Check in the transcript that the orchestrator does not call `wait_events` without `wait: false` |
| D3 | Notice and report | When 'trial' finishes, does a notice wake the orchestrator, does `wait_events` (`wait: false`) receive the `report` (done), and is the pin removed? Does `list_sessions` show 'trial' as `idle`? | Check that `claude agents --json` has a row for 'trial' (kind `interactive`) |
| D4 | The next task | Ask for another task → does a new worker session start? | If the desktop app refuses the start, check that a suggestion card appears and a TODO is kept |
| D5 | TODOs and the list | Say "fix the README typo later, any time is fine" → is it kept as a TODO? In another chat, `/inline-agent-orchestrator:status` → do the tables of worker sessions and TODOs appear? "Start number 1" → does a worker session start, and is the TODO done when it finishes? | Check `todos` in `~/.claude/session-manager-mcp/state.json` |

Cleanup: archive the session in the desktop app, `update_session` (remove)

</details>

<details>
<summary>Codex (V1–V5)</summary>

| # | Check | Steps | If it fails |
| --- | --- | --- | --- |
| V1 | Codex version | Is `codex --version` 0.162 or later? Does `codex app-server proxy --help` print help? | Update the CLI |
| V2 | Starting the shared daemon | In a non-administrator PowerShell (Windows), run `codex app-server daemon start` → does `codex agents` open? | Try again with `"transport": "embedded"` in `config.json` |
| V3 | Tool connection | In the orchestrator session, ask "call `get_usage`" → are usage and free memory shown? | Read the error message returned by the tool |
| V4 | Starting a session | Ask: "`start_session` with the name 'trial', an empty folder as the working folder, and the request 'count the files and send the result with report'" → does it appear in `codex agents`, and does `wait_events` receive the report? | If it does not appear in the Codex desktop app, check it with `codex resume <ID>` |
| V5 | Messaging a running session | While a longer request is running, `send_message` → is it processed after the turn, without interrupting? How is text you type during `wait_events` handled? | If it interrupts, add "send only while stopped" to `local-rules.md` |

Cleanup: `codex archive <ID>`, `update_session` (remove), and `codex app-server daemon stop` if needed

</details>

### Common errors

| Message | Fix |
| --- | --- |
| `Workspace not trusted` / "not trusted" (Claude Code) | In a terminal on the PC, start `claude` once in the working folder and accept the trust prompt. Trust is per repository; trusting a parent folder does not help |
| "The CLI is not logged in" (Claude Code) | To use `claude --bg`, start `claude` in a terminal and `/login`. In the Claude desktop app, starting desktop app sessions needs no CLI login |
| `claude agents --json returned something that is not JSON` (Claude Code) | Update the CLI. Check agent view's status with `claude daemon status` |
| `daemon start failed` (Codex) | On Windows, it cannot be started from an administrator PowerShell. It also fails if the `CODEX_HOME` path is too long |
| `thread/queue/add を使えません` (Codex) | Update Codex |
| Monitoring times out (Codex) | In a terminal, run `node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex` again (it fixes `tool_timeout_sec`) |

### Reporting issues

The following information helps track down the cause.

- The step that failed (C1–C6, D1–D5, V1–V5) and the output of `claude --version` or `codex --version`, and `node --version`
- The error message, or the full output of the command
- `state.json`, `reports.jsonl`, and `config.json` from the data folder; for Claude Code, also `worker-mcp.json`, `usage.json`, and `statusline.json`
- For Claude Code, the output of `claude plugin list` run in a terminal; for Codex, the `[mcp_servers.session-manager]` section of `config.toml`

## Development

```bash
npm test
```

To release a new version, set the same version in `package.json` and `.claude-plugin/plugin.json` (`version`), `SERVER_INFO` in `src/server.mjs`, `CLIENT_INFO` in `src/appserver.mjs` and the top of both READMEs, and push it to main (`npm test` fails when they differ). Without a new version number, users do not get the update. The tag (`v<version>`) and the GitHub release are created automatically.

| Path | Description |
| --- | --- |
| `src/server.mjs` | MCP server (stdio, JSON-RPC 2.0) |
| `src/tools.mjs` | Tools, limit checks, monitoring |
| `src/version.mjs` | Compares the running version, the one on disk and the newest one on GitHub |
| `src/todos.mjs` | Checks TODO conditions and moves records from 0.8.0 and earlier |
| `src/backends/` | Implementations for Codex (app-server) and Claude Code (CLI) |
| `src/setup.mjs` | Setup script (Codex registration and skill installation, Claude Code status line) |
| `src/allow-report.mjs` / `hooks/hooks.json` | Hook that lets Claude desktop app worker sessions call `report` without a prompt |
| `src/claude-statusline.mjs` | Status line that records Claude Code usage |
| `src/appserver.mjs` / `src/ws.mjs` | Codex app-server client (Node.js on Windows cannot use Unix domain sockets, so it talks WebSocket through `codex app-server proxy`) |
| `skills/manage-sessions/` | The orchestrator's instructions (skill) |
| `skills/status/` | The list command (`/inline-agent-orchestrator:status`) |
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
