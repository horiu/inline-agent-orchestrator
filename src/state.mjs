// Config, state and the report mailbox, kept as plain files:
//   Codex:       $CODEX_HOME/session-manager/ (default ~/.codex/session-manager/)
//   Claude Code: $CLAUDE_CONFIG_DIR/session-manager-mcp/ (default ~/.claude/session-manager-mcp/)
// CSM_HOME overrides both.

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = {
  codexPath: 'codex',
  transport: 'daemon',
  claude: {
    path: 'claude',
    permissionMode: 'acceptEdits',
  },
  maxRunning: 3,
  minFreeMemGb: 2,
  pauseAtPct: 95,
  defaults: {
    sandbox: 'workspace-write',
    approvalPolicy: 'never',
    model: null,
    effort: null,
  },
  // Longest a watch waits when nothing happens. Each return wakes the manager
  // model once (it reads the whole conversation again), so keep it long; the
  // server itself checks every pollSec without using the model.
  watchIntervalMin: 30,
  pollSec: 5,
};

// The watch never waits longer than this (prompt caches last about an hour).
export const WATCH_INTERVAL_MAX_MIN = 60;

// paused = stopped by hand; paused_usage = stopped for the usage limit (the
// watch keeps going and reports usageRecovered when the limit resets).
export const TARGET_STATUSES = ['running', 'waiting_user', 'done', 'pending', 'paused', 'paused_usage', 'failed'];

// Which agent this server manages: CSM_AGENT=claude|codex (default codex).
export function agentOf(env = process.env) {
  return env.CSM_AGENT === 'claude' ? 'claude' : 'codex';
}

export function stateDir(env = process.env) {
  const override = env.CSM_HOME;
  const base =
    override ||
    (agentOf(env) === 'claude'
      ? join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'session-manager-mcp')
      : join(env.CODEX_HOME || join(homedir(), '.codex'), 'session-manager'));
  mkdirSync(base, { recursive: true });
  return base;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  // On Windows the rename can fail for a moment while another process (a
  // virus scanner, or another reader of the file) has it open.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt >= 10) throw err;
      sleepSync(20 * (attempt + 1));
    }
  }
}

export class Store {
  constructor(dir = stateDir()) {
    this.dir = dir;
    this.configPath = join(dir, 'config.json');
    this.statePath = join(dir, 'state.json');
    this.reportsPath = join(dir, 'reports.jsonl');
  }

  config() {
    const user = readJson(this.configPath, {});
    return {
      ...DEFAULT_CONFIG,
      ...user,
      defaults: { ...DEFAULT_CONFIG.defaults, ...(user.defaults ?? {}) },
      claude: { ...DEFAULT_CONFIG.claude, ...(user.claude ?? {}) },
    };
  }

  state() {
    const s = readJson(this.statePath, {});
    return { version: 1, targets: {}, reportsOffset: 0, ...s };
  }

  saveState(s) {
    writeJsonAtomic(this.statePath, s);
  }

  updateTarget(threadId, patch) {
    const s = this.state();
    const prev = s.targets[threadId] ?? {};
    s.targets[threadId] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    this.saveState(s);
    return s.targets[threadId];
  }

  appendReport(report) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...report });
    appendFileSync(this.reportsPath, line + '\n', 'utf8');
  }

  // Returns reports written after the saved offset. With advance=true the
  // offset moves past them so the next call returns only newer ones.
  readReports({ advance = true, all = false } = {}) {
    const { reports, nextOffset } = this.peekReports({ all });
    if (advance && !all) this.commitReportsOffset(nextOffset);
    return reports;
  }

  commitReportsOffset(offset) {
    const s = this.state();
    s.reportsOffset = offset;
    this.saveState(s);
  }

  peekReports({ all = false } = {}) {
    if (!existsSync(this.reportsPath)) return { reports: [], nextOffset: 0 };
    const s = this.state();
    const size = statSync(this.reportsPath).size;
    let start = all ? 0 : s.reportsOffset;
    if (start > size) start = 0; // file was truncated by hand
    const length = size - start;
    let text = '';
    if (length > 0) {
      const buf = Buffer.alloc(length);
      const fd = openSync(this.reportsPath, 'r');
      try {
        readSync(fd, buf, 0, length, start);
      } finally {
        closeSync(fd);
      }
      text = buf.toString('utf8');
    }
    // Only consume complete lines; a writer may be mid-append.
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
    const reports = complete
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { kind: 'unreadable', text: l };
        }
      });
    return { reports, nextOffset: start + Buffer.byteLength(complete, 'utf8') };
  }

  hasUnreadReports() {
    if (!existsSync(this.reportsPath)) return false;
    const size = statSync(this.reportsPath).size;
    const offset = this.state().reportsOffset;
    return size > offset || (size < offset && size > 0);
  }
}
