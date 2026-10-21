import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Store, stateDir, DEFAULT_CONFIG, pauseAtPctFor } from '../src/state.mjs';

const fresh = () => new Store(mkdtempSync(join(tmpdir(), 'csm-state-')));

test('pauseAtPct is off for Claude Code and 95 for Codex unless config.json says otherwise', () => {
  const s = fresh();
  const at = (agent) => pauseAtPctFor(s.config(), agent);
  assert.deepEqual([at('claude'), at('codex')], [null, 95]);
  writeFileSync(s.configPath, JSON.stringify({ pauseAtPct: { claude: 90 } }));
  assert.deepEqual([at('claude'), at('codex')], [90, 95], 'the other agent keeps its default');
  writeFileSync(s.configPath, JSON.stringify({ pauseAtPct: 80 }));
  assert.deepEqual([at('claude'), at('codex')], [80, 80]);
  writeFileSync(s.configPath, JSON.stringify({ pauseAtPct: null }));
  assert.deepEqual([at('claude'), at('codex')], [null, null]);
  writeFileSync(s.configPath, JSON.stringify({ pauseAtPct: { claude: '90', codex: 'x' } }));
  assert.deepEqual([at('claude'), at('codex')], [90, null]);
});

test('Store anchors a relative directory and all file paths to the manager cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-relative-'));
  const store = new Store(relative(process.cwd(), dir));
  assert.equal(store.dir, dir);
  assert.equal(store.configPath, join(dir, 'config.json'));
  assert.equal(store.statePath, join(dir, 'state.json'));
  assert.equal(store.reportsPath, join(dir, 'reports.jsonl'));
});

test('config merges user values over defaults, including a BOM-prefixed file', () => {
  const s = fresh();
  writeFileSync(s.configPath, '﻿' + JSON.stringify({ maxRunning: 5, defaults: { model: 'm' } }));
  const c = s.config();
  assert.equal(c.maxRunning, 5);
  assert.equal(c.defaults.model, 'm');
  assert.equal(c.defaults.sandbox, DEFAULT_CONFIG.defaults.sandbox);
});

test('broken config names the file', () => {
  const s = fresh();
  writeFileSync(s.configPath, '{');
  assert.throws(() => s.config(), /config\.json is not valid JSON/);
});

test('stateDir follows CODEX_HOME and the override variable', () => {
  const home = mkdtempSync(join(tmpdir(), 'csm-home-'));
  assert.equal(stateDir({ CODEX_HOME: home }), join(home, 'session-manager'));
  const other = mkdtempSync(join(tmpdir(), 'csm-o-'));
  assert.equal(stateDir({ CODEX_HOME: home, CSM_HOME: other }), other);
});

test('readReports keeps a half-written last line for later', () => {
  const s = fresh();
  s.appendReport({ kind: 'progress', text: '一' });
  appendFileSync(s.reportsPath, '{"kind":"done","te');
  assert.deepEqual(s.readReports().map((r) => r.text), ['一']);
  assert.equal(s.hasUnreadReports(), true);
  appendFileSync(s.reportsPath, 'xt":"二"}\n');
  assert.deepEqual(s.readReports().map((r) => r.text), ['二']);
  assert.equal(s.hasUnreadReports(), false);
});

test('readReports starts over when the file was truncated', () => {
  const s = fresh();
  s.appendReport({ kind: 'progress', text: 'long long long' });
  s.readReports();
  writeFileSync(s.reportsPath, JSON.stringify({ text: 'new' }) + '\n');
  assert.equal(s.hasUnreadReports(), true);
  assert.deepEqual(s.readReports().map((r) => r.text), ['new']);
});

test('config.example.json shows exactly the built-in defaults', async () => {
  const { readFileSync } = await import('node:fs');
  const { DEFAULT_CONFIG } = await import('../src/state.mjs');
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example, DEFAULT_CONFIG);
});
