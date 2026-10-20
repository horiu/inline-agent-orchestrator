#!/usr/bin/env node
// Claude Code status line command that records plan usage for the manager.
//
// Claude Code passes session data as JSON on stdin; `rate_limits.five_hour` and
// `rate_limits.seven_day` carry `used_percentage` and `resets_at`
// (code.claude.com/docs/en/statusline). The CLI has no other documented way to
// read them, so this script saves them to usage.json in the state folder, where
// the MCP server's get_usage reads them.
//
// Usage in ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node /path/to/src/claude-statusline.mjs" }
// To keep an existing status line, pass it after `--` as ONE quoted argument;
// it gets the same stdin and its output is shown instead of ours:
//   "command": "node /path/to/src/claude-statusline.mjs -- \"<your command>\""
// The chained command runs in the OS shell (cmd.exe on Windows, /bin/sh
// elsewhere), not necessarily the shell Claude Code uses for status lines;
// for a bash script on Windows write e.g. "bash ~/.claude/statusline.sh".
// The state folder follows CSM_HOME / CLAUDE_CONFIG_DIR like the MCP server;
// if you set CSM_HOME for the server, set it for the status line too.

import { spawnSync } from 'node:child_process';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDir } from './state.mjs';

export function recordUsage(input, dir, now = new Date()) {
  const limits = input?.rate_limits;
  if (!limits || (!limits.five_hour && !limits.seven_day)) return false;
  const path = join(dir, 'usage.json');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updatedAt: now.toISOString(), rate_limits: limits }, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    // Another refresh or a reader holds the file at this moment (Windows);
    // drop this snapshot, the next refresh writes again.
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    return false;
  }
  return true;
}

export function line(input) {
  const pct = (w) => (typeof w?.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '-');
  const l = input?.rate_limits;
  return l ? `5h ${pct(l.five_hour)} · 週 ${pct(l.seven_day)}` : '';
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let input = null;
  try {
    input = JSON.parse(raw);
  } catch {
    // Not JSON: print nothing rather than break the status line.
  }
  try {
    recordUsage(input, stateDir({ ...process.env, CSM_AGENT: 'claude' }));
  } catch {
    // Recording is best effort.
  }
  const sep = process.argv.indexOf('--');
  if (sep >= 0 && process.argv.length > sep + 1) {
    const rest = process.argv.slice(sep + 1);
    const command = rest.length === 1 ? rest[0] : rest.join(' ');
    const res = spawnSync(command, { input: raw, shell: true, encoding: 'utf8', windowsHide: true });
    process.stdout.write(res.stdout ?? '');
    return;
  }
  process.stdout.write(line(input) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
