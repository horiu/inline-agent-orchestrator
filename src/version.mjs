// Which version of this server runs and which is on disk, so the manager can
// tell the user when a new version waits for a restart.
//   Claude Code: the plugin's install record (installed_plugins.json) and the
//     marketplace's auto-update setting. A running session keeps the version
//     it loaded, while auto-update puts the new one on disk.
//   Codex: the clone the server runs from (setup.mjs registers that folder),
//     which `git pull` changes under the running server.
// With auto-update off, the latest version on GitHub is read at most once a
// day (kept in the state folder); a failed read is skipped quietly.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ID = 'inline-agent-orchestrator@inline-agent-orchestrator';
const MARKETPLACE = 'inline-agent-orchestrator';
const LATEST_URL = 'https://raw.githubusercontent.com/horiu/inline-agent-orchestrator/main/.claude-plugin/plugin.json';
export const CHECK_FILE = 'version-check.json';
const CHECK_EVERY_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 5000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Each of these turns Claude Code's plugin auto-update off, unless
// FORCE_AUTOUPDATE_PLUGINS is set too.
const NO_AUTOUPDATE_ENV = ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// 1 when a is newer, -1 when older, 0 when the same; null when either is not
// a version like 1.2.3 (or 1.2.3-beta.1).
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a ?? '').trim());
  const y = SEMVER.exec(String(b ?? '').trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  // A pre-release comes before its release.
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const px = x[4].split('.');
  const py = y[4].split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    if (px[i] === undefined) return -1;
    if (py[i] === undefined) return 1;
    const nx = /^\d+$/.test(px[i]);
    const ny = /^\d+$/.test(py[i]);
    if (nx && ny && Number(px[i]) !== Number(py[i])) return Math.sign(Number(px[i]) - Number(py[i]));
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && px[i] !== py[i]) return px[i] < py[i] ? -1 : 1;
  }
  return 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const isInside = (child, parent) => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const envOn = (v) => Boolean(v) && v !== '0' && String(v).toLowerCase() !== 'false';
const newest = (versions) => versions.reduce((a, v) => (a === null || compareVersions(v, a) === 1 ? v : a), null);

// Installed version and auto-update of the Claude Code plugin. Both are null
// when this server is not the installed plugin (--plugin-dir, or a copy
// placed by hand): such a copy has no install record of its own.
function claudeInstall({ env, root, cwd }) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const pluginsDir = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(configDir, 'plugins');
  if (!isInside(root, join(pluginsDir, 'cache'))) return { installed: null, autoUpdate: null };
  const records = readJson(join(pluginsDir, 'installed_plugins.json'))?.plugins?.[PLUGIN_ID];
  const list = Array.isArray(records) ? records.filter((r) => SEMVER.test(String(r?.version ?? ''))) : [];
  // The user's install, or one for this project; any other project's install
  // does not load here.
  const here = list.filter((r) => r.scope === 'user' || (r.projectPath && resolve(r.projectPath) === resolve(cwd)));
  const installed = newest((here.length ? here : list).map((r) => r.version));
  let autoUpdate = false; // the default for a marketplace that is not Anthropic's
  const fromSettings = readJson(join(configDir, 'settings.json'))?.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate;
  const fromKnown = readJson(join(pluginsDir, 'known_marketplaces.json'))?.[MARKETPLACE]?.autoUpdate;
  if (typeof fromSettings === 'boolean') autoUpdate = fromSettings;
  else if (typeof fromKnown === 'boolean') autoUpdate = fromKnown;
  if (NO_AUTOUPDATE_ENV.some((k) => envOn(env[k])) && !envOn(env.FORCE_AUTOUPDATE_PLUGINS)) autoUpdate = false;
  return { installed, autoUpdate };
}

// Codex runs the server from the clone that setup.mjs registered; nothing
// updates it but `git pull`.
function codexInstall({ root }) {
  const v = readJson(join(root, 'package.json'))?.version;
  return { installed: SEMVER.test(String(v ?? '')) ? v : null, autoUpdate: false };
}

async function latestVersion({ dir, now, fetchFn }) {
  const path = join(dir, CHECK_FILE);
  const saved = readJson(path);
  const at = Date.parse(saved?.checkedAt ?? '');
  if (Number.isFinite(at) && now() >= at && now() - at < CHECK_EVERY_MS) return typeof saved.latest === 'string' ? saved.latest : null;
  let latest = null;
  try {
    const res = await fetchFn(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const v = res.ok ? (await res.json())?.version : null;
    if (SEMVER.test(String(v ?? ''))) latest = v;
  } catch {
    // offline or blocked: try again tomorrow
  }
  try {
    writeFileSync(path, JSON.stringify({ checkedAt: new Date(now()).toISOString(), latest }, null, 2) + '\n', 'utf8');
  } catch {
    // read again next time
  }
  return latest;
}

export async function versionInfo({ agent, running, dir, env = process.env, root = ROOT, cwd = process.cwd(), now = Date.now, fetchFn = globalThis.fetch }) {
  let installed = null;
  let autoUpdate = null;
  let latest = null;
  try {
    ({ installed, autoUpdate } = agent === 'claude' ? claudeInstall({ env, root, cwd }) : codexInstall({ root }));
    if (installed && autoUpdate === false && !envOn(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) && fetchFn) latest = await latestVersion({ dir, now, fetchFn });
  } catch {
    // the version check never fails get_usage
  }
  return {
    running,
    installed,
    autoUpdate,
    latest,
    reloadNeeded: compareVersions(installed, running) === 1,
    updateAvailable: compareVersions(latest, installed) === 1,
  };
}
