import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_INFO } from '../src/server.mjs';
import { CHECK_FILE, PLUGIN_ID, compareVersions, versionInfo } from '../src/version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY = 24 * 60 * 60_000;

// A Claude Code config folder with this plugin installed at `installed`, and
// the server running from the cache folder of `running`.
function claudeHome({ installed = '0.8.0', running = '0.7.0', settings, known, records } = {}) {
  const config = mkdtempSync(join(tmpdir(), 'csm-ver-'));
  const plugins = join(config, 'plugins');
  const root = join(plugins, 'cache', 'inline-agent-orchestrator', 'inline-agent-orchestrator', running);
  mkdirSync(root, { recursive: true });
  const record = { scope: 'user', installPath: root.replace(running, installed), version: installed };
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [PLUGIN_ID]: records ?? [record] } }));
  if (settings) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings));
  if (known) writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify(known));
  const dir = mkdtempSync(join(tmpdir(), 'csm-state-'));
  return { config, plugins, root, dir };
}

const autoOn = { extraKnownMarketplaces: { 'inline-agent-orchestrator': { autoUpdate: true } } };
const noFetch = () => assert.fail('must not read GitHub');

function fakeFetch(version, log = []) {
  return async (url) => {
    log.push(url);
    if (version instanceof Error) throw version;
    return { ok: true, json: async () => ({ version }) };
  };
}

test('compareVersions: semver order, pre-releases before releases, null for anything else', () => {
  assert.equal(compareVersions('0.8.0', '0.7.0'), 1);
  assert.equal(compareVersions('0.7.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('abc123def456', '0.7.0'), null);
  assert.equal(compareVersions(null, '0.7.0'), null);
});

test('Claude Code: a newer installed version than the running one needs a reload', async () => {
  const h = claudeHome({ settings: autoOn });
  const v = await versionInfo({ agent: 'claude', running: '0.7.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: h.root, fetchFn: noFetch });
  assert.deepEqual(v, { running: '0.7.0', installed: '0.8.0', autoUpdate: true, latest: null, reloadNeeded: true, updateAvailable: false });
  const same = await versionInfo({ agent: 'claude', running: '0.8.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: h.root, fetchFn: noFetch });
  assert.equal(same.reloadNeeded, false);
});

test('Claude Code: not installed as a plugin (--plugin-dir, by hand) gives installed null', async () => {
  const h = claudeHome({ settings: autoOn });
  const v = await versionInfo({ agent: 'claude', running: '0.7.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: ROOT, fetchFn: noFetch });
  assert.equal(v.installed, null);
  assert.equal(v.autoUpdate, null);
  assert.equal(v.reloadNeeded, false);
});

test('Claude Code: CLAUDE_CODE_PLUGIN_CACHE_DIR moves the plugin records', async () => {
  const h = claudeHome({ known: { 'inline-agent-orchestrator': { autoUpdate: true } } });
  const config = mkdtempSync(join(tmpdir(), 'csm-ver-'));
  const v = await versionInfo({
    agent: 'claude',
    running: '0.7.0',
    dir: h.dir,
    env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: h.plugins },
    root: h.root,
    fetchFn: noFetch,
  });
  assert.equal(v.installed, '0.8.0');
  assert.equal(v.autoUpdate, true);
});

test('Claude Code: the user install counts, not one for another project', async () => {
  const h = claudeHome({
    settings: autoOn,
    records: [
      { scope: 'project', projectPath: '/other', version: '0.9.0' },
      { scope: 'user', version: '0.7.0' },
    ],
  });
  const v = await versionInfo({ agent: 'claude', running: '0.7.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: h.root, cwd: '/repo', fetchFn: noFetch });
  assert.equal(v.installed, '0.7.0');
  assert.equal(v.reloadNeeded, false);
});

test('Claude Code: autoUpdate in settings wins over known_marketplaces.json; env can turn it off', async () => {
  const h = claudeHome({
    settings: { extraKnownMarketplaces: { 'inline-agent-orchestrator': { autoUpdate: false } } },
    known: { 'inline-agent-orchestrator': { autoUpdate: true } },
  });
  const args = { agent: 'claude', running: '0.8.0', dir: h.dir, root: h.root, fetchFn: fakeFetch('0.8.0') };
  assert.equal((await versionInfo({ ...args, env: { CLAUDE_CONFIG_DIR: h.config } })).autoUpdate, false);
  const k = claudeHome({ known: { 'inline-agent-orchestrator': { autoUpdate: true } } });
  const kArgs = { ...args, dir: k.dir, root: k.root };
  assert.equal((await versionInfo({ ...kArgs, env: { CLAUDE_CONFIG_DIR: k.config } })).autoUpdate, true);
  assert.equal((await versionInfo({ ...kArgs, env: { CLAUDE_CONFIG_DIR: k.config, DISABLE_AUTOUPDATER: '1' } })).autoUpdate, false);
  assert.equal(
    (await versionInfo({ ...kArgs, env: { CLAUDE_CONFIG_DIR: k.config, DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: '1' } })).autoUpdate,
    true,
  );
  // Neither says anything: off, as for any marketplace that is not Anthropic's.
  const none = claudeHome();
  assert.equal((await versionInfo({ ...args, dir: none.dir, root: none.root, env: { CLAUDE_CONFIG_DIR: none.config } })).autoUpdate, false);
});

test('auto-update off: the latest version on GitHub is read at most once a day', async () => {
  const h = claudeHome({ installed: '0.8.0', running: '0.8.0' });
  const log = [];
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const args = { agent: 'claude', running: '0.8.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: h.root, now: () => clock };
  const v = await versionInfo({ ...args, fetchFn: fakeFetch('0.9.0', log) });
  assert.equal(v.autoUpdate, false);
  assert.equal(v.latest, '0.9.0');
  assert.equal(v.updateAvailable, true);
  assert.match(log[0], /raw\.githubusercontent\.com\/horiu\/inline-agent-orchestrator\/main\/\.claude-plugin\/plugin\.json$/);
  clock += DAY - 1;
  assert.equal((await versionInfo({ ...args, fetchFn: fakeFetch('1.0.0', log) })).latest, '0.9.0');
  assert.equal(log.length, 1);
  clock += 1;
  assert.equal((await versionInfo({ ...args, fetchFn: fakeFetch('1.0.0', log) })).latest, '1.0.0');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(readFileSync(join(h.dir, CHECK_FILE), 'utf8')).latest, '1.0.0');
});

test('auto-update off: a failed read gives latest null and waits a day', async () => {
  const h = claudeHome({ installed: '0.8.0', running: '0.8.0' });
  const log = [];
  const args = { agent: 'claude', running: '0.8.0', dir: h.dir, env: { CLAUDE_CONFIG_DIR: h.config }, root: h.root };
  const v = await versionInfo({ ...args, fetchFn: fakeFetch(new Error('offline'), log) });
  assert.equal(v.latest, null);
  assert.equal(v.updateAvailable, false);
  await versionInfo({ ...args, fetchFn: fakeFetch('0.9.0', log) });
  assert.equal(log.length, 1);
  // No traffic that is not needed when the user turned it off.
  const quiet = claudeHome({ installed: '0.8.0', running: '0.8.0' });
  const q = await versionInfo({ ...args, dir: quiet.dir, root: quiet.root, env: { CLAUDE_CONFIG_DIR: quiet.config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, fetchFn: noFetch });
  assert.equal(q.latest, null);
});

test('Codex: the clone on disk is the installed version; no auto-update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'csm-clone-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.8.0' }));
  const dir = mkdtempSync(join(tmpdir(), 'csm-state-'));
  const v = await versionInfo({ agent: 'codex', running: '0.7.0', dir, env: {}, root, fetchFn: fakeFetch('0.8.0') });
  assert.deepEqual(v, { running: '0.7.0', installed: '0.8.0', autoUpdate: false, latest: '0.8.0', reloadNeeded: true, updateAvailable: false });
});

test('the version is the same everywhere it is written', () => {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  const v = JSON.parse(read('package.json')).version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('.claude-plugin/plugin.json')).version, v, '.claude-plugin/plugin.json');
  assert.equal(SERVER_INFO.version, v, 'SERVER_INFO in src/server.mjs');
  assert.equal(/const CLIENT_INFO = \{[^}]*version: '([^']+)'/.exec(read('src/appserver.mjs'))?.[1], v, 'CLIENT_INFO in src/appserver.mjs');
  for (const readme of ['README.md', 'README.en.md']) {
    const head = read(readme).split('\n').slice(0, 15).join('\n');
    assert.equal(/[(（]v(\d+\.\d+\.\d+)[)）]/.exec(head)?.[1], v, readme);
  }
});
