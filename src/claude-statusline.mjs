#!/usr/bin/env node
// Claude Code status line command that records plan usage for the manager.
//
// Claude Code passes session data as JSON on stdin; `rate_limits.five_hour` and
// `rate_limits.seven_day` carry `used_percentage` and `resets_at`
// (code.claude.com/docs/en/statusline). The CLI has no other documented way to
// read them, so this script saves them to usage.json in the state folder, where
// the MCP server's get_usage reads them.
//
// `node src/setup.mjs statusline` copies this file into the state folder (a
// path that does not move when the plugin updates) and points the status line
// at the copy. The file therefore imports nothing from this repository.
//
// A status line that was there before is kept: setup saves it to
// statusline.json in the state folder, and this script runs it with the same
// stdin and shows its output instead of ours. Passing a command after `--` as
// one quoted argument does the same:
//   "command": "node /path/to/claude-statusline.mjs -- \"<your command>\""
// The chained command runs the way Claude Code runs status lines: on Windows
// through Git Bash when it is installed, otherwise PowerShell
// (code.claude.com/docs/en/statusline); elsewhere through /bin/sh. If it fails
// or prints nothing, our own short text is shown instead.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Same folder as the MCP server for Claude Code (src/state.mjs stateDir).
export function claudeStateDir(env = process.env) {
  const dir = env.CSM_HOME || join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'session-manager-mcp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

// Set for the chained command, so a chain that points back at this script
// (an old setting, a copied command) cannot start itself again.
export const CHAINED_ENV = 'CSM_STATUSLINE_CHAINED';

// The status line that was set before setup, if any.
export function chainedCommand(argv, dir, env = process.env) {
  if (env[CHAINED_ENV]) return null;
  const sep = argv.indexOf('--');
  if (sep >= 0 && argv.length > sep + 1) {
    const rest = argv.slice(sep + 1);
    return rest.length === 1 ? rest[0] : rest.join(' ');
  }
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'statusline.json'), 'utf8'));
    return typeof saved?.previous?.command === 'string' && saved.previous.command ? saved.previous.command : null;
  } catch {
    return null;
  }
}

export function gitBashPath(env = process.env, exists = existsSync) {
  // git.exe on PATH usually sits in <Git>\cmd, next to <Git>\bin\bash.exe.
  const fromPath = (env.PATH ?? env.Path ?? '')
    .split(';')
    .filter((dir) => dir && exists(join(dir, 'git.exe')))
    .map((dir) => join(dir, '..', 'bin', 'bash.exe'));
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    ...fromPath,
  ];
  return candidates.find((p) => p && exists(p)) ?? null;
}

// Returns the chained command's output, or null when it failed or printed nothing.
export function runChained(command, input, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  // A status line that hangs must not hang ours.
  const opts = { input, encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...env, [CHAINED_ENV]: '1' } };
  let res;
  if (platform === 'win32') {
    const bash = gitBashPath(env);
    // Windows PowerShell writes to a pipe in the OEM code page unless told otherwise.
    const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`;
    res = bash ? run(bash, ['-c', command], opts) : run('powershell.exe', ['-NoProfile', '-Command', ps], opts);
  } else {
    res = run(command, { ...opts, shell: true });
  }
  return res?.status === 0 && res.stdout?.trim() ? res.stdout : null;
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
  let dir = null;
  try {
    dir = claudeStateDir();
    recordUsage(input, dir);
  } catch {
    // Recording is best effort.
  }
  const command = dir ? chainedCommand(process.argv, dir) : null;
  const chained = command ? runChained(command, raw) : null;
  process.stdout.write(chained ?? line(input) + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
