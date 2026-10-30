#!/usr/bin/env node
// One-command setup.
//
//   node src/setup.mjs codex                 register the MCP server in Codex and install the skill
//   node src/setup.mjs codex --remove        undo it (the clone and the records stay)
//   node src/setup.mjs devin                 register the MCP server in Devin and install the skill
//   node src/setup.mjs devin --remove        undo it
//   node src/setup.mjs statusline            let Claude Code record plan usage (status line)
//   node src/setup.mjs statusline --remove   put the previous status line back
//
// Every file this changes is backed up next to itself first (<name>.bak-<time>).

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeStateDir } from './claude-statusline.mjs';
import { devinConfigHome } from './state.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_PATH = join(ROOT, 'src', 'server.mjs');
const STATUSLINE_SOURCE = join(ROOT, 'src', 'claude-statusline.mjs');
const SKILL_SOURCE = join(ROOT, 'skills', 'manage-sessions');
export const STATUSLINE_COPY = 'statusline.mjs';
const SERVER_KEY = 'session-manager';
// Longer than the longest watch (60 minutes) so Codex does not cut it off.
const TOOL_TIMEOUT_SEC = 3720;

const slash = (p) => p.replaceAll('\\', '/');
const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

function backup(path, now) {
  if (!existsSync(path)) return null;
  const to = `${path}.bak-${stamp(now)}`;
  copyFileSync(path, to);
  return to;
}

// "node" when it is on PATH (survives Node updates), else this Node's path.
export function nodeCommand(run = spawnSync) {
  const res = run('node', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  return res.status === 0 ? 'node' : slash(process.execPath);
}

// ---- Codex ----

const KEY = `(?:"${SERVER_KEY}"|'${SERVER_KEY}'|${SERVER_KEY})`;
// [mcp_servers.session-manager] and its sub-tables such as [mcp_servers.session-manager.env]
const OUR_TABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${KEY}\\s*(\\]|\\.\\s*([A-Za-z0-9_"'-]+)\\s*\\])`);
// A table header line ([table] or [[array]]), not an array value that starts with '['.
const ANY_TABLE = /^\s*\[\[?[^[\]=]+\]\]?\s*(#.*)?$/;
// Definitions this script cannot rewrite safely: an inline table under
// [mcp_servers], or dotted keys at the top level.
const INLINE_DEF = new RegExp(`^\\s*${KEY}\\s*(=|\\.)`);
const DOTTED_DEF = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${KEY}\\s*(=|\\.)`);
const isNote = (l) => !l.trim() || /^\s*#/.test(l);
// The server's env, as `env = {...}` or dotted `env.KEY = ...`.
const ENV_LINE = /^\s*env\s*(=|\.)/;
// A table header without its trailing comment.
const headerOf = (l) => l.replace(/#.*$/, '').trim();

// Throws when the server is defined in a form this script cannot rewrite.
function assertRewritable(lines) {
  let table = null; // name of the current table header
  for (const l of lines) {
    if (ANY_TABLE.test(l)) table = headerOf(l);
    else if (DOTTED_DEF.test(l) && table === null) throw new Error(dottedMessage());
    else if (INLINE_DEF.test(l) && /^\[\s*mcp_servers\s*\]$/.test(table ?? '')) throw new Error(dottedMessage());
  }
}

// Replaces the [mcp_servers.session-manager] table or appends it. Keeps the
// server's `env` (line or sub-table) and comments that belong to the next
// table. Throws when the server is defined in a form it cannot rewrite.
export function upsertCodexServer(toml, block) {
  const lines = toml.split(/\r?\n/);
  assertRewritable(lines);

  const out = [];
  // env from the old table, re-added after the new block
  const keepMain = [];
  const keepEnv = [];
  let skipping = false;
  let inEnv = false;
  let skipped = [];
  let replaced = false;
  const flushNotes = () => {
    // Trailing comments and blank lines belong to whatever comes next.
    let i = skipped.length;
    while (i > 0 && isNote(skipped[i - 1])) i--;
    out.push(...skipped.slice(i));
    skipped = [];
  };
  for (const l of lines) {
    const ours = OUR_TABLE.exec(l);
    if (ours) {
      if (!replaced) out.push(...block.split('\n'));
      replaced = true;
      skipping = true;
      inEnv = ours[2]?.replace(/["']/g, '') === 'env';
      if (inEnv && !keepEnv.length) keepEnv.push(`[mcp_servers.${SERVER_KEY}.env]`);
      skipped = [];
      continue;
    }
    if (ANY_TABLE.test(l)) {
      if (skipping) flushNotes();
      skipping = false;
      inEnv = false;
    }
    if (!skipping) {
      out.push(l);
    } else if (inEnv) {
      // Comments inside the env table stay with it; trailing ones go to the next table.
      if (isNote(l)) {
        skipped.push(l);
      } else {
        keepEnv.push(...skipped.filter((n) => n.trim()), l);
        skipped = [];
      }
    } else {
      if (ENV_LINE.test(l)) keepMain.push(l);
      skipped.push(l);
    }
  }
  if (skipping) flushNotes();
  let text = out.join('\n').trimEnd();
  if (!replaced) text = `${text}${text ? '\n\n' : ''}${block}`;
  if (keepMain.length || keepEnv.length) {
    // Put the kept env right after our block.
    const at = text.indexOf(block) + block.length;
    const extra = [...keepMain, ...(keepEnv.length ? ['', ...keepEnv] : [])].join('\n');
    text = `${text.slice(0, at)}\n${extra}${text.slice(at)}`;
  }
  return `${text.trimEnd()}\n`;
}

// Drops the [mcp_servers.session-manager] table and its sub-tables (env
// included). Comments that belong to the next table stay.
export function removeCodexServer(toml) {
  const lines = toml.split(/\r?\n/);
  assertRewritable(lines);
  const out = [];
  let skipping = false;
  let skipped = [];
  const flushNotes = () => {
    let i = skipped.length;
    while (i > 0 && isNote(skipped[i - 1])) i--;
    const notes = skipped.slice(i);
    // One blank line where the table was, not two.
    while (notes.length && !notes[0].trim() && (!out.length || !out[out.length - 1].trim())) notes.shift();
    out.push(...notes);
    skipped = [];
  };
  for (const l of lines) {
    if (OUR_TABLE.test(l)) {
      skipping = true;
      skipped = [];
      continue;
    }
    if (ANY_TABLE.test(l) && skipping) {
      flushNotes();
      skipping = false;
    }
    if (skipping) skipped.push(l);
    else out.push(l);
  }
  if (skipping) flushNotes();
  const text = out.join('\n').trimEnd();
  return text ? `${text}\n` : '';
}

function dottedMessage() {
  return `config.toml の ${SERVER_KEY} が、この道具では書き換えられない形（インラインの表・点で区切ったキー）で書かれています。その定義を消してから、もう一度実行してください（config.toml は変えていません）`;
}

export function codexBlock(node) {
  // JSON strings are valid TOML basic strings (quotes and backslashes escaped).
  return [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(SERVER_PATH)}]`,
    'startup_timeout_sec = 20',
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
  ].join('\n');
}

export function setupCodex({ env = process.env, home = homedir(), now = new Date(), node = nodeCommand() } = {}) {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const configPath = join(codexHome, 'config.toml');
  mkdirSync(codexHome, { recursive: true });
  const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const after = upsertCodexServer(before, codexBlock(node));
  let backedUp = null;
  if (after !== before) {
    backedUp = backup(configPath, now);
    writeFileSync(configPath, after, 'utf8');
  }
  const skillPath = join(home, '.agents', 'skills', 'manage-sessions');
  mkdirSync(dirname(skillPath), { recursive: true });
  cpSync(SKILL_SOURCE, skillPath, { recursive: true, force: true });
  return { configPath, changed: after !== before, backedUp, skillPath };
}

// Undoes setupCodex: the server table (with a backup) and the skill, when the
// skill folder is the one this tool installed. The records in the state
// folder and this folder itself are left for the person to delete.
export function removeCodex({ env = process.env, home = homedir(), now = new Date() } = {}) {
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const configPath = join(codexHome, 'config.toml');
  const before = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const after = removeCodexServer(before);
  let backedUp = null;
  if (after !== before) {
    backedUp = backup(configPath, now);
    writeFileSync(configPath, after, 'utf8');
  }
  const skillPath = join(home, '.agents', 'skills', 'manage-sessions');
  const skillFile = join(skillPath, 'SKILL.md');
  const ours = existsSync(skillFile) && /^name:\s*manage-sessions\s*$/m.test(readFileSync(skillFile, 'utf8')) && /session-manager/.test(readFileSync(skillFile, 'utf8'));
  if (ours) rmSync(skillPath, { recursive: true, force: true });
  return {
    configPath,
    changed: after !== before,
    backedUp,
    skillPath,
    skillRemoved: ours,
    skillLeft: !ours && existsSync(skillPath),
    stateDir: env.CSM_HOME || join(codexHome, 'session-manager'),
    root: ROOT,
  };
}

// ---- Devin ----

// Devin reads global MCP servers from ~/.claude.json (shown as the "Source"
// by `devin mcp list`; shared with Claude Code's MCP config) and from
// ~/.config/devin/mcp_config.json (%APPDATA%\devin\mcp_config.json on
// Windows). Both use the same `mcpServers` map of { command, args, env }.
// User-scope skills live in ~/.agents/skills/<name>/SKILL.md.
export function upsertDevinServer(json, block) {
  let cfg = {};
  const text = json.trim();
  if (text) {
    try {
      cfg = JSON.parse(text);
    } catch {
      throw new Error(`mcp_config.json を JSON として読めません。手で直してから、もう一度実行してください（このファイルは変えていません）`);
    }
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {};
  const servers = typeof cfg.mcpServers === 'object' && cfg.mcpServers !== null ? cfg.mcpServers : {};
  return JSON.stringify({ ...cfg, mcpServers: { ...servers, [SERVER_KEY]: block } }, null, 2) + '\n';
}

export function removeDevinServer(json) {
  const cfg = JSON.parse(json);
  if (typeof cfg !== 'object' || cfg === null || typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null) return json;
  if (!Object.hasOwn(cfg.mcpServers, SERVER_KEY)) return json;
  delete cfg.mcpServers[SERVER_KEY];
  return JSON.stringify(cfg, null, 2) + '\n';
}

function devinPaths(env, home) {
  return {
    claudeJsonPath: join(home, '.claude.json'),
    mcpPath: join(devinConfigHome(env), 'mcp_config.json'),
    skillPath: join(home, '.agents', 'skills', 'manage-sessions'),
  };
}

// MCP config files Devin is known to read; the server block is upserted
// into every one of them so both CLI/ACP sessions and the desktop app see it.
function devinMcpPaths(env, home) {
  const { claudeJsonPath, mcpPath } = devinPaths(env, home);
  return [claudeJsonPath, mcpPath];
}

export function devinServerBlock(node) {
  return { command: node, args: [SERVER_PATH], env: { CSM_AGENT: 'devin' } };
}

export function setupDevin({ env = process.env, home = homedir(), now = new Date(), node = nodeCommand() } = {}) {
  const { skillPath } = devinPaths(env, home);
  const block = devinServerBlock(node);
  const touched = [];
  for (const p of devinMcpPaths(env, home)) {
    mkdirSync(dirname(p), { recursive: true });
    const before = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const after = upsertDevinServer(before, block);
    if (after !== before) {
      const backedUp = backup(p, now);
      writeFileSync(p, after, 'utf8');
      touched.push({ path: p, backedUp });
    }
  }
  mkdirSync(dirname(skillPath), { recursive: true });
  cpSync(SKILL_SOURCE, skillPath, { recursive: true, force: true });
  return { touched, skillPath };
}

export function removeDevin({ env = process.env, home = homedir(), now = new Date() } = {}) {
  const { skillPath } = devinPaths(env, home);
  const touched = [];
  for (const p of devinMcpPaths(env, home)) {
    const before = existsSync(p) ? readFileSync(p, 'utf8') : '';
    let after = before;
    try {
      after = removeDevinServer(before);
    } catch {
      // An unreadable file is left alone.
    }
    if (after !== before) {
      const backedUp = backup(p, now);
      writeFileSync(p, after, 'utf8');
      touched.push({ path: p, backedUp });
    }
  }
  const skillFile = join(skillPath, 'SKILL.md');
  const ours =
    existsSync(skillFile) && /^name:\s*manage-sessions\s*$/m.test(readFileSync(skillFile, 'utf8')) && /session-manager/.test(readFileSync(skillFile, 'utf8'));
  if (ours) rmSync(skillPath, { recursive: true, force: true });
  return {
    touched,
    skillPath,
    skillRemoved: ours,
    skillLeft: !ours && existsSync(skillPath),
    stateDir: env.CSM_HOME || join(devinConfigHome(env), 'session-manager'),
    root: ROOT,
  };
}

// ---- Claude Code status line ----

function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} を JSON として読めません。手で直してから、もう一度実行してください（このファイルは変えていません）`);
  }
}

// Which kind of status line is set now.
export function statuslineKind(statusLine, copyPath) {
  const command = typeof statusLine?.command === 'string' ? slash(statusLine.command) : '';
  if (!command) return 'none';
  if (command.includes(slash(copyPath)) || command.includes(`session-manager-mcp/${STATUSLINE_COPY}`)) return 'copy';
  // Set by hand from an older version (pointing into the repository).
  if (command.includes('claude-statusline.mjs')) return 'legacy';
  return 'other';
}

// The command an older setting chained with `-- "<command>"`, if any.
export function legacyChain(command) {
  const m = /\s--\s+(.+)$/s.exec(command ?? '');
  if (!m) return null;
  let inner = m[1].trim();
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1).replaceAll('\\"', '"');
  return inner || null;
}

function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Keeps the copy in the state folder in step with this version (called when
// the MCP server starts, so a plugin update reaches the status line too).
export function refreshStatuslineCopy(dir) {
  const copy = join(dir, STATUSLINE_COPY);
  if (!existsSync(copy)) return false;
  const source = readFileSync(STATUSLINE_SOURCE);
  if (source.equals(readFileSync(copy))) return false;
  writeAtomic(copy, source);
  return true;
}

export function setupStatusline({ env = process.env, home = homedir(), now = new Date(), node = nodeCommand(), remove = false } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  const dir = claudeStateDir({ ...env, CLAUDE_CONFIG_DIR: claudeDir });
  const copy = join(dir, STATUSLINE_COPY);
  const savedPath = join(dir, 'statusline.json');
  const settings = readSettings(settingsPath);
  const current = settings.statusLine;
  const kind = statuslineKind(current, copy);
  let saved = null;
  try {
    saved = existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, 'utf8')) : null;
  } catch {
    // A broken file counts as nothing saved.
  }
  const write = () => {
    mkdirSync(claudeDir, { recursive: true });
    const backedUp = backup(settingsPath, now);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return backedUp;
  };

  if (remove) {
    if (kind !== 'copy' && kind !== 'legacy') return { settingsPath, changed: false, note: 'この道具の status line は設定されていません' };
    const legacy = kind === 'legacy' ? legacyChain(current.command) : null;
    const previous = kind === 'copy' ? saved?.previous ?? null : legacy ? { type: 'command', command: legacy } : null;
    if (previous) settings.statusLine = previous;
    else delete settings.statusLine;
    const backedUp = write();
    rmSync(savedPath, { force: true });
    return { settingsPath, changed: true, backedUp, restored: previous };
  }

  // What to show besides ours: kept as it is when we are already set up.
  let previous;
  if (kind === 'copy') previous = saved?.previous ?? null;
  else if (kind === 'legacy') previous = legacyChain(current.command) ? { type: 'command', command: legacyChain(current.command) } : null;
  else if (kind === 'other') previous = current;
  else previous = null;
  if (previous) writeFileSync(savedPath, JSON.stringify({ previous }, null, 2) + '\n', 'utf8');
  else if (existsSync(savedPath)) unlinkSync(savedPath);

  writeAtomic(copy, readFileSync(STATUSLINE_SOURCE));
  const exe = node === 'node' ? node : `"${node}"`;
  // Other keys of the status line (padding and the like) stay as they were.
  const next = { ...(current ?? {}), type: 'command', command: `${exe} "${slash(copy)}"` };
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  let backedUp = null;
  if (changed) {
    settings.statusLine = next;
    backedUp = write();
  }
  return { settingsPath, changed, backedUp, kept: previous?.command ?? null };
}

// ---- CLI ----

function main(argv) {
  const [what, ...flags] = argv;
  if (what === 'codex' && flags.includes('--remove')) {
    const r = removeCodex();
    console.log(r.changed ? `MCP サーバーの登録を外しました: ${r.configPath}` : `MCP サーバーは登録されていませんでした: ${r.configPath}`);
    if (r.backedUp) console.log(`  元のファイル: ${r.backedUp}`);
    if (r.skillRemoved) console.log(`スキルを削除しました: ${r.skillPath}`);
    else if (r.skillLeft) console.log(`${r.skillPath} はこの道具のスキルではないため、残しました。`);
    console.log('Codex を起動し直すと、反映されます。');
    console.log('次のフォルダは残しています。不要なら削除してください。');
    console.log(`  監視の記録: ${r.stateDir}`);
    console.log(`  この道具: ${r.root}`);
    return;
  }
  if (what === 'codex') {
    const r = setupCodex();
    console.log(`MCP サーバーを登録しました: ${r.configPath}${r.changed ? '' : '（もう登録済みでした）'}`);
    if (r.backedUp) console.log(`  元のファイル: ${r.backedUp}`);
    console.log(`Skill を入れました: ${r.skillPath}`);
    console.log('Codex を起動し直し、監視役にする会話で $manage-sessions と打ってください。');
    return;
  }
  if (what === 'devin' && flags.includes('--remove')) {
    const r = removeDevin();
    if (r.touched.length) {
      for (const t of r.touched) console.log(`MCP サーバーの登録を外しました: ${t.path}${t.backedUp ? `（元: ${t.backedUp}）` : ''}`);
    } else {
      console.log('MCP サーバーは登録されていませんでした。');
    }
    if (r.skillRemoved) console.log(`スキルを削除しました: ${r.skillPath}`);
    else if (r.skillLeft) console.log(`${r.skillPath} はこの道具のスキルではないため、残しました。`);
    console.log('Devin を起動し直すと、反映されます。');
    console.log('次のフォルダは残しています。不要なら削除してください。');
    console.log(`  監視の記録: ${r.stateDir}`);
    console.log(`  この道具: ${r.root}`);
    return;
  }
  if (what === 'devin') {
    const r = setupDevin();
    if (r.touched.length) {
      for (const t of r.touched) console.log(`MCP サーバーを登録しました: ${t.path}${t.backedUp ? `（元: ${t.backedUp}）` : ''}`);
    } else {
      console.log('MCP サーバーはもう登録済みでした。');
    }
    console.log(`Skill を入れました: ${r.skillPath}`);
    console.log('Devin を起動し直し、監視役にする会話で /manage-sessions と打ってください。');
    console.log('注意: ~/.claude.json は Claude Code と共有の MCP 設定です。Claude 側にも session-manager を登録していると名前がぶつかります。');
    return;
  }
  if (what === 'statusline') {
    const r = setupStatusline({ remove: flags.includes('--remove') });
    if (flags.includes('--remove')) {
      console.log(r.changed ? `status line を元に戻しました: ${r.settingsPath}` : r.note);
    } else {
      console.log(`status line を設定しました: ${r.settingsPath}${r.changed ? '' : '（もう設定済みでした）'}`);
      if (r.kept) console.log(`  前の status line（${r.kept}）は残して、その表示を出します。`);
      console.log('次に Claude Code の画面が表示を更新したときから、利用枠が記録されます。');
    }
    if (r.backedUp) console.log(`  元のファイル: ${r.backedUp}`);
    return;
  }
  console.log('使い方: node src/setup.mjs codex [--remove] | devin [--remove] | statusline [--remove]');
  process.exitCode = what ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
