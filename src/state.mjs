// Config, state and the report mailbox, kept as plain files:
//   Codex:       $CODEX_HOME/session-manager/ (default ~/.codex/session-manager/)
//   Claude Code: $CLAUDE_CONFIG_DIR/session-manager-mcp/ (default ~/.claude/session-manager-mcp/)
// CSM_HOME overrides both.

import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_CONFIG = {
  codexPath: 'codex',
  transport: 'daemon',
  claude: {
    path: 'claude',
    permissionMode: 'acceptEdits',
  },
  // No cap on the number of running sessions: a new one starts while the PC
  // has room (free memory, and CPU when maxCpuPct is a number; null turns the
  // CPU check off).
  minFreeMemGb: 2,
  maxCpuPct: 90,
  // Usage (%) at which the manager starts nothing new and stops the running
  // sessions, per agent; null never stops for usage. Off for Claude Code: it
  // continues a session by itself when the limit resets, and stopping is no
  // pause (the running turn is cut off and loses the same as a failed one).
  // On for Codex, where a manager stopped by the limit is not known to come
  // back by itself: stopping short of it leaves the manager some usage, and
  // the watch waits without the model and wakes it with usageRecovered.
  pauseAtPct: { claude: null, codex: 95 },
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
  // Recommended model and effort per kind of work. The manager picks one with
  // start_session's `profile`. Codex model names change between releases, so
  // Codex profiles set only the effort and keep the user's default model.
  profiles: {
    design: {
      description: '設計・方式の検討（API・データ構造・画面の構成を決める。1〜2ファイルで済む小さな修正は除く）',
      claude: { model: 'opus', effort: 'xhigh' },
      codex: { effort: 'xhigh' },
    },
    debug: {
      description: '原因の分からない不具合の調査（1回で原因が絞れなければ effort を xhigh に上げる）',
      claude: { model: 'opus', effort: 'high' },
      codex: { effort: 'high' },
    },
    implement: {
      description: 'ふつうの実装・修正',
      claude: { model: 'opus', effort: 'medium' },
      codex: { effort: 'medium' },
    },
    review: {
      description: 'コードレビュー',
      claude: { model: 'opus', effort: 'high' },
      codex: { effort: 'high' },
    },
    writing: {
      description: '人が読む文章の作成・修正（ドキュメント・画面の文言）',
      claude: { model: 'sonnet', effort: 'high' },
      codex: { effort: 'high' },
    },
    routine: {
      description: '手順の決まった作業・確認（画面の確認・定型の修正・調べものの要約）',
      claude: { model: 'sonnet', effort: 'medium' },
      codex: { effort: 'medium' },
    },
  },
};

// The watch never waits longer than this (prompt caches last about an hour).
export const WATCH_INTERVAL_MAX_MIN = 60;

// paused = stopped by hand; paused_usage = stopped for the usage limit (the
// watch keeps going and reports usageRecovered when the limit resets).
export const TARGET_STATUSES = ['running', 'waiting_user', 'done', 'pending', 'paused', 'paused_usage', 'failed'];

// pauseAtPct for one agent. config.json may give a number or null for every
// agent, or { claude, codex }.
export function pauseAtPctFor(cfg, agent) {
  const v = cfg.pauseAtPct;
  const raw = v && typeof v === 'object' ? v[agent] : v;
  // "90" written by hand still counts; anything else is off.
  const pct = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
}

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
    // Anchor relative CSM_HOME once, in the manager process, before passing
    // it to workers whose current directory may be entirely different.
    this.dir = resolve(dir);
    this.configPath = join(this.dir, 'config.json');
    this.statePath = join(this.dir, 'state.json');
    this.reportsPath = join(this.dir, 'reports.jsonl');
  }

  config() {
    const user = readJson(this.configPath, {});
    return {
      ...DEFAULT_CONFIG,
      ...user,
      defaults: { ...DEFAULT_CONFIG.defaults, ...(user.defaults ?? {}) },
      claude: { ...DEFAULT_CONFIG.claude, ...(user.claude ?? {}) },
      // { claude: 90 } keeps the built-in value for the other agent.
      ...(user.pauseAtPct && typeof user.pauseAtPct === 'object'
        ? { pauseAtPct: { ...DEFAULT_CONFIG.pauseAtPct, ...user.pauseAtPct } }
        : {}),
      // A profile the user writes replaces the built-in one of the same name;
      // `null` removes it.
      profiles: Object.fromEntries(
        Object.entries({ ...DEFAULT_CONFIG.profiles, ...(user.profiles ?? {}) }).filter(([, p]) => p && typeof p === 'object'),
      ),
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
