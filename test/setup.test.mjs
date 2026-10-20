import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAINED_ENV, chainedCommand, gitBashPath, runChained } from '../src/claude-statusline.mjs';
import { codexBlock, refreshStatuslineCopy, removeCodex, removeCodexServer, setupCodex, setupStatusline, upsertCodexServer } from '../src/setup.mjs';

const now = new Date('2026-10-21T01:02:03Z');
const home = () => mkdtempSync(join(tmpdir(), 'csm-setup-'));

test('codex: the server table is appended once and replaced in place on the next run', () => {
  const block = codexBlock('node');
  const before = 'model = "x"\n\n[mcp_servers.other]\ncommand = "a"\n';
  const once = upsertCodexServer(before, block);
  assert.match(once, /\[mcp_servers\.other\]\ncommand = "a"\n\n\[mcp_servers\.session-manager\]/);
  assert.match(once, /tool_timeout_sec = 3720/);
  assert.equal(upsertCodexServer(once, block), once, 'running again changes nothing');

  const old = '[mcp_servers.session-manager]\ncommand = "node"\nargs = ["old"]\n\n[mcp_servers.session-manager.env]\nX = "1"\n\n# tools of mine\n[tools]\ny = 1\n';
  const replaced = upsertCodexServer(old, block);
  assert.doesNotMatch(replaced, /"old"/);
  assert.match(replaced, /tool_timeout_sec = 3720\n\n\[mcp_servers\.session-manager\.env\]\nX = "1"\n/, 'the env sub-table is kept');
  assert.match(replaced, /\n# tools of mine\n\[tools\]\ny = 1/, 'a comment for the next table stays');
  assert.equal(replaced.match(/\[mcp_servers\.session-manager\]/g).length, 1);
  assert.equal(upsertCodexServer(replaced, block), replaced);
});

test('codex: other spellings of the table are replaced, an env line is kept, unsafe forms are refused', () => {
  const block = codexBlock('node');
  for (const header of ["[mcp_servers.'session-manager']", '[mcp_servers."session-manager"]', '[ mcp_servers . session-manager ]']) {
    const out = upsertCodexServer(`${header}\ncommand = "x"\nenv = { CSM_HOME = "D:/s" }\n`, block);
    assert.equal(out.match(/session-manager/g).length, 1, header);
    assert.match(out, /env = \{ CSM_HOME = "D:\/s" \}/);
  }
  assert.throws(() => upsertCodexServer('[mcp_servers]\nsession-manager = { command = "x" }\n', block), /書き換えられない形/);
  assert.throws(() => upsertCodexServer('mcp_servers.session-manager.command = "x"\n', block), /書き換えられない形/);
  assert.match(upsertCodexServer('[mcp_servers]\nother = { command = "y" }\n', block), /other = \{ command = "y" \}\n\n\[mcp_servers\.session-manager\]/);
});

test('codex: a commented [mcp_servers] header, dotted env keys and comments in the env table', () => {
  const block = codexBlock('node');
  assert.throws(() => upsertCodexServer('[mcp_servers] # mine\nsession-manager = { command = "x" }\n', block), /書き換えられない形/);
  const out = upsertCodexServer('[mcp_servers.session-manager]\ncommand = "x"\nenv.CSM_HOME = "D:/s"\n\n[mcp_servers.session-manager.env]\n# why\nA = "1"\n', block);
  assert.match(out, /tool_timeout_sec = 3720\nenv\.CSM_HOME = "D:\/s"\n\n\[mcp_servers\.session-manager\.env\]\n# why\nA = "1"\n$/);
  // An array value that starts with '[' is not a table header.
  const arrays = '[mcp_servers.other]\nargs = [\n["a"]\n]\n';
  assert.match(upsertCodexServer(arrays, block), /\["a"\]\n\]\n\n\[mcp_servers\.session-manager\]/);
});

test('codex: paths are written as TOML basic strings (quotes and backslashes escaped)', () => {
  const b = codexBlock("C:\\Users\\O'Brien\\node.exe");
  assert.ok(b.includes(String.raw`command = "C:\\Users\\O'Brien\\node.exe"`));
});

test('codex: setup writes config.toml with a backup and copies the skill', () => {
  const h = home();
  mkdirSync(join(h, '.codex'));
  writeFileSync(join(h, '.codex', 'config.toml'), 'model = "x"\n');
  const r = setupCodex({ env: {}, home: h, now, node: 'node' });
  assert.equal(r.changed, true);
  assert.ok(existsSync(r.backedUp));
  assert.match(readFileSync(r.configPath, 'utf8'), /^model = "x"\n\n\[mcp_servers\.session-manager\]\ncommand = "node"\nargs = \[".*server\.mjs"\]/);
  assert.ok(existsSync(join(h, '.agents', 'skills', 'manage-sessions', 'SKILL.md')));
  const again = setupCodex({ env: {}, home: h, now, node: 'node' });
  assert.equal(again.changed, false);
  assert.equal(again.backedUp, null);
});

test('codex: removing drops the table and its env, keeps the rest and comments for the next table', () => {
  const toml = 'model = "x"\n\n[mcp_servers.session-manager]\ncommand = "node"\nargs = ["s"]\n\n[mcp_servers.session-manager.env]\nA = "1"\n\n# tools of mine\n[tools]\ny = 1\n';
  assert.equal(removeCodexServer(toml), 'model = "x"\n\n# tools of mine\n[tools]\ny = 1\n');
  assert.equal(removeCodexServer('[mcp_servers.session-manager]\ncommand = "node"\n'), '');
  assert.equal(removeCodexServer('model = "x"\n'), 'model = "x"\n', 'nothing to remove');
  assert.throws(() => removeCodexServer('[mcp_servers]\nsession-manager = { command = "x" }\n'), /書き換えられない形/);
});

test('codex: --remove undoes setup, and leaves a skill that is not ours', () => {
  const h = home();
  mkdirSync(join(h, '.codex'));
  writeFileSync(join(h, '.codex', 'config.toml'), 'model = "x"\n');
  setupCodex({ env: {}, home: h, now, node: 'node' });
  const r = removeCodex({ env: {}, home: h, now });
  assert.equal(r.changed, true);
  assert.ok(existsSync(r.backedUp));
  assert.equal(readFileSync(r.configPath, 'utf8'), 'model = "x"\n');
  assert.equal(r.skillRemoved, true);
  assert.ok(!existsSync(join(h, '.agents', 'skills', 'manage-sessions')));
  assert.equal(r.stateDir, join(h, '.codex', 'session-manager'));
  assert.equal(removeCodex({ env: {}, home: h, now }).changed, false, 'running again changes nothing');

  const other = join(h, '.agents', 'skills', 'manage-sessions');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'SKILL.md'), '---\nname: manage-sessions\ndescription: someone else\n---\n');
  const left = removeCodex({ env: {}, home: h, now });
  assert.equal(left.skillRemoved, false);
  assert.equal(left.skillLeft, true);
  assert.ok(existsSync(join(other, 'SKILL.md')));
});

test('codex: CODEX_HOME is honoured', () => {
  const h = home();
  const codexHome = join(h, 'elsewhere');
  const r = setupCodex({ env: { CODEX_HOME: codexHome }, home: h, now, node: 'node' });
  assert.equal(r.configPath, join(codexHome, 'config.toml'));
});

test('statusline: keeps the previous status line, runs it, and --remove puts it back', () => {
  const h = home();
  const claudeDir = join(h, '.claude');
  mkdirSync(claudeDir);
  const previous = { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 1 };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', statusLine: previous }));

  const r = setupStatusline({ env: {}, home: h, now, node: 'node' });
  assert.equal(r.changed, true);
  assert.equal(r.kept, previous.command);
  const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus', 'other settings stay');
  assert.match(settings.statusLine.command, /^node ".*\/\.claude\/session-manager-mcp\/statusline\.mjs"$/);
  assert.equal(settings.statusLine.padding, 1);
  const dir = join(claudeDir, 'session-manager-mcp');
  assert.ok(existsSync(join(dir, 'statusline.mjs')));
  assert.equal(chainedCommand(['node', 'statusline.mjs'], dir), previous.command, 'the old status line is shown');
  assert.equal(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.bak-')).length, 1);

  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node' }).changed, false, 'running again changes nothing');
  assert.equal(chainedCommand(['node', 'statusline.mjs'], dir), previous.command, 'and keeps the saved one');

  const back = setupStatusline({ env: {}, home: h, now, node: 'node', remove: true });
  assert.equal(back.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).statusLine, previous);
});

test('statusline: works without settings.json and refuses a broken one', () => {
  const h = home();
  const r = setupStatusline({ env: {}, home: h, now, node: 'node' });
  assert.equal(r.changed, true);
  assert.equal(r.kept, null);
  assert.equal(chainedCommand(['node', 's'], join(h, '.claude', 'session-manager-mcp')), null);
  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node', remove: true }).changed, true);
  assert.equal(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).statusLine, undefined);

  writeFileSync(join(h, '.claude', 'settings.json'), '{ broken');
  assert.throws(() => setupStatusline({ env: {}, home: h, now, node: 'node' }), /JSON として読めません/);
  assert.equal(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'), '{ broken', 'left untouched');
});

test('statusline: the copy is refreshed only when it exists and differs', () => {
  const dir = home();
  assert.equal(refreshStatuslineCopy(dir), false, 'not set up: nothing written');
  writeFileSync(join(dir, 'statusline.mjs'), 'old');
  assert.equal(refreshStatuslineCopy(dir), true);
  assert.equal(refreshStatuslineCopy(dir), false);
});

test('statusline: a command after -- still wins over the saved one', () => {
  const dir = home();
  writeFileSync(join(dir, 'statusline.json'), JSON.stringify({ previous: { command: 'saved' } }));
  assert.equal(chainedCommand(['node', 's', '--', 'given'], dir), 'given');
});

test('statusline: a node path with spaces is quoted', () => {
  const h = home();
  setupStatusline({ env: {}, home: h, now, node: 'C:/Program Files/nodejs/node.exe' });
  const { statusLine } = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  assert.match(statusLine.command, /^"C:\/Program Files\/nodejs\/node\.exe" ".*statusline\.mjs"$/);
});

test('statusline: an older hand-made setting is replaced without chaining itself', () => {
  const h = home();
  const claudeDir = join(h, '.claude');
  const dir = join(claudeDir, 'session-manager-mcp');
  mkdirSync(claudeDir);
  const write = (statusLine) => writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine }));

  write({ type: 'command', command: 'node C:/tools/iao/src/claude-statusline.mjs' });
  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node' }).kept, null);
  assert.equal(chainedCommand(['node', 's'], dir, {}), null, 'the old script is not chained');

  write({ type: 'command', command: 'node C:/tools/iao/src/claude-statusline.mjs -- "bash \\"my line\\""' });
  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node' }).kept, 'bash "my line"');
  assert.equal(chainedCommand(['node', 's'], dir, {}), 'bash "my line"', 'only what it chained is kept');
});

test('statusline: with CSM_HOME the copy is recognised on the next run and by --remove', () => {
  const h = home();
  const state = join(h, 'state');
  const env = { CSM_HOME: state };
  mkdirSync(join(h, '.claude'));
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'A' } }));
  setupStatusline({ env, home: h, now, node: 'node' });
  assert.equal(setupStatusline({ env, home: h, now, node: 'node' }).changed, false);
  assert.equal(chainedCommand(['node', 's'], state, {}), 'A', 'not replaced by our own command');
  assert.equal(setupStatusline({ env, home: h, now, node: 'node', remove: true }).changed, true);
  assert.equal(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8')).statusLine.command, 'A');
});

test('statusline: --remove forgets the saved status line', () => {
  const h = home();
  const claudeDir = join(h, '.claude');
  const dir = join(claudeDir, 'session-manager-mcp');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'A' } }));
  setupStatusline({ env: {}, home: h, now, node: 'node' });
  setupStatusline({ env: {}, home: h, now, node: 'node', remove: true });
  assert.equal(existsSync(join(dir, 'statusline.json')), false);
  writeFileSync(join(claudeDir, 'settings.json'), '{}');
  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node' }).kept, null);
  assert.equal(chainedCommand(['node', 's'], dir, {}), null, 'A does not come back');
});

test('statusline: the chained command cannot start the script again, and a failed one falls back', () => {
  const dir = home();
  writeFileSync(join(dir, 'statusline.json'), JSON.stringify({ previous: { command: 'saved' } }));
  assert.equal(chainedCommand(['node', 's'], dir, { [CHAINED_ENV]: '1' }), null);

  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'shown\n' };
  };
  const bash = process.execPath; // any file that exists
  assert.equal(runChained('x', '{}', { platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: bash }, run }), 'shown\n');
  assert.deepEqual([calls[0].cmd, calls[0].args], [bash, ['-c', 'x']]);
  assert.equal(calls[0].opts.env[CHAINED_ENV], '1');
  runChained('x', '{}', { platform: 'win32', env: {}, run });
  assert.equal(calls[1].cmd, 'powershell.exe', 'without Git Bash, PowerShell like Claude Code');
  assert.equal(runChained('x', '{}', { platform: 'linux', env: {}, run: () => ({ status: 1, stdout: 'err' }) }), null);
  assert.equal(runChained('x', '{}', { platform: 'linux', env: {}, run: () => ({ status: 0, stdout: '  \n' }) }), null);
});

test('statusline: other keys of the previous status line stay, a broken statusline.json is ignored', () => {
  const h = home();
  const claudeDir = join(h, '.claude');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'A', padding: 2, refreshInterval: 10 } }));
  setupStatusline({ env: {}, home: h, now, node: 'node' });
  const { statusLine } = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(statusLine.padding, 2);
  assert.equal(statusLine.refreshInterval, 10);
  writeFileSync(join(claudeDir, 'session-manager-mcp', 'statusline.json'), '{ broken');
  assert.equal(setupStatusline({ env: {}, home: h, now, node: 'node', remove: true }).changed, true);
});

test('statusline: Git Bash is also found next to git on PATH', () => {
  const files = new Set(['D:/scoop/git/cmd/git.exe', join('D:/scoop/git/cmd', '..', 'bin', 'bash.exe')].map((p) => join(p)));
  const exists = (p) => files.has(join(p));
  assert.equal(join(gitBashPath({ PATH: 'C:/x;D:/scoop/git/cmd' }, exists)), join('D:/scoop/git/bin/bash.exe'));
  assert.equal(gitBashPath({ PATH: 'C:/x' }, exists), null);
});
