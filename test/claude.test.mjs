import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBackend } from '../src/backends/claude.mjs';
import { recordUsage, line } from '../src/claude-statusline.mjs';
import { toolsForRole } from '../src/server.mjs';
import { Store } from '../src/state.mjs';
import { createTools, ToolError } from '../src/tools.mjs';

const GB = 1024 ** 3;
const idleCpus = () => [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
const SID = '11111111-2222-4333-8444-555555555555';

// Stand-in for the `claude` CLI, shaped after code.claude.com/docs/en/agent-view.
class FakeClaude {
  constructor() {
    this.calls = [];
    this.sessions = [];
    this.seq = 0;
    this.failNext = null;
  }

  run = async (path, args, opts = {}) => {
    this.calls.push({ args, cwd: opts.cwd });
    if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ loggedIn: this.loggedIn ?? true, authMethod: 'claude.ai' }), stderr: '' };
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return { code: 1, stdout: '', stderr: f };
    }
    if (args[0] === 'agents') {
      let list = this.sessions;
      if (!args.includes('--all')) list = list.filter((s) => !['done', 'stopped', 'failed'].includes(s.state));
      const cwdAt = args.indexOf('--cwd');
      if (cwdAt >= 0) list = list.filter((s) => s.cwd === args[cwdAt + 1]);
      return { code: 0, stdout: JSON.stringify(list), stderr: '' };
    }
    if (args[0] === '--bg') {
      const id = `7c5dcf5${++this.seq}`;
      const name = args[args.indexOf('--name') + 1];
      this.sessions.push({ id, sessionId: this.seq === 1 ? SID : `${SID.slice(0, -1)}${this.seq}`, name, kind: 'background', state: 'working', status: 'busy', pid: 1, cwd: opts.cwd, startedAt: 1_700_000_000_000 + this.seq });
      return { code: 0, stdout: `Started ${name}\n  claude attach ${id}\n  claude logs ${id}\n  claude stop ${id}\n`, stderr: '' };
    }
    if (args[0] === '--resume') {
      if (this.failResume) return { code: 1, stdout: '', stderr: this.failResume };
      const s = this.sessions.find((x) => x.sessionId === args[1]);
      if (s && this.copyOnResume) {
        const copy = { ...s, id: 'c0ffee01', sessionId: '99999999-8888-4777-8666-555555555555', state: 'working', status: 'busy' };
        this.sessions.push(copy);
        // The documented output shows only short ids; a UUID may be absent.
        const text = this.copyOnResume === 'short'
          ? `backgrounded · ${copy.id}\nnote: the session was already running, so this is a copy\n  claude attach ${copy.id}\n`
          : `Session ${s.sessionId} is already running; started a copy ${copy.sessionId}\n  claude attach ${copy.id}\n`;
        return { code: 0, stdout: text, stderr: '' };
      }
      if (!s) return { code: 1, stdout: '', stderr: 'No conversation found' };
      Object.assign(s, { state: 'working', status: 'busy', waitingFor: undefined });
      return { code: 0, stdout: `Resumed ${s.id}\n`, stderr: '' };
    }
    if (args[0] === 'logs') return { code: 0, stdout: this.log ?? 'x'.repeat(50) + 'END OF LOG', stderr: '' };
    if (args[0] === 'stop') {
      const s = this.sessions.find((x) => x.id === args[1]);
      Object.assign(s, { state: 'stopped', status: undefined });
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: `unknown: ${args.join(' ')}` };
  };

  set(id, patch) {
    Object.assign(this.sessions.find((s) => s.id === id || s.sessionId === id), patch);
  }
}

let fake, store, tools, clock, backend;
const calls = (first) => fake.calls.filter((c) => c.args[0] === first);

// env: what the manager's MCP server sees (the desktop app sets
// CLAUDE_CODE_ENTRYPOINT=claude-desktop; a terminal does not).
function setup(config = {}, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'csm-claude-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ pollSec: 1, watchIntervalMin: 5 / 60, ...config }));
  store = new Store(dir);
  fake = new FakeClaude();
  clock = 1_800_000_000_000;
  backend = claudeBackend({ store, claudePath: 'claude', permissionMode: store.config().claude.permissionMode, run: fake.run, now: () => clock });
  ({ tools } = createTools({
    backend,
    store,
    sys: { freemem: () => 8 * GB, totalmem: () => 16 * GB, now: () => clock, sleep: async (ms) => (clock += ms), env, cpus: idleCpus },
  }));
}

beforeEach(() => setup());

test('start_session runs claude --bg with name, model, effort, permission mode, worker rules and the report-only MCP server', async () => {
  const r = await tools.start_session.handler({ name: '画面の確認', cwd: '/repo', prompt: 'やること', model: 'opus', effort: 'high', area: 'ui' });
  assert.equal(r.started, true);
  assert.equal(r.threadId, SID);
  assert.equal(r.open, 'claude attach 7c5dcf51');

  const { args, cwd } = calls('--bg')[0];
  assert.equal(cwd, '/repo');
  const opt = (name) => args[args.indexOf(name) + 1];
  assert.equal(opt('--name'), '画面の確認');
  assert.equal(opt('--model'), 'opus');
  assert.equal(opt('--effort'), 'high');
  assert.equal(opt('--permission-mode'), 'acceptEdits');
  assert.match(opt('--append-system-prompt'), /report/);
  assert.match(opt('--append-system-prompt'), /CLAUDE\.md/);
  const mcp = JSON.parse(readFileSync(opt('--mcp-config'), 'utf8'));
  assert.equal(mcp.mcpServers['session-report'].env.CSM_ROLE, 'worker');
  assert.equal(mcp.mcpServers['session-report'].env.CSM_AGENT, 'claude');
  assert.equal(opt('--disallowedTools'), 'mcp__session-manager');
  assert.equal(args[args.indexOf('--disallowedTools') + 2], 'mcp__plugin_inline-agent-orchestrator_session-manager', 'the plugin form of the manager server is removed too');
  assert.equal(opt('--allowedTools'), 'mcp__session-report__report');
  // Multi-value options must not sit right before the prompt.
  assert.equal(args[args.length - 3], '--name');
  const prompt = args[args.length - 1];
  assert.match(prompt, /この会話の名前: 画面の確認\n/);
  assert.doesNotMatch(prompt, /ID:/);
  assert.match(prompt, /やること$/);

  const t = store.state().targets[SID];
  assert.equal(t.status, 'running');
  assert.equal(t.jobId, '7c5dcf51');
  assert.equal(t.sessionId, SID);
  assert.equal(t.area, 'ui');
});

test('start_session omits model and effort when unset and honours config permissionMode', async () => {
  setup({ claude: { permissionMode: 'auto' } });
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const { args } = calls('--bg')[0];
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--effort'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'auto');
});

test('start_session refuses a name already in use', async () => {
  await tools.start_session.handler({ name: 'dup', cwd: '/r', prompt: 'p' });
  await assert.rejects(tools.start_session.handler({ name: 'dup', cwd: '/r', prompt: 'p' }), (e) => e instanceof ToolError && /同じ名前/.test(e.message));
});

test('start_session surfaces a CLI failure', async () => {
  fake.failNext = 'error: unknown option --bg';
  await assert.rejects(tools.start_session.handler({ name: 'x', cwd: '/r', prompt: 'p' }), /claude --bg failed \(exit 1\): error: unknown option --bg/);
});

test('statuses map from agents --json state/status/waitingFor, with one CLI call per round', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p' });
  const [a, b] = fake.sessions;
  const st = (id) => backend.status(id, store.state().targets[id]);
  fake.set(a.id, { state: 'blocked', status: 'waiting', waitingFor: 'permission prompt' });
  fake.set(b.id, { state: 'working', status: 'waiting', waitingFor: 'input needed' });
  clock += 10_000;
  const before = calls('agents').length;
  assert.deepEqual((await st(a.sessionId)).activeFlags, ['waitingOnApproval']);
  assert.deepEqual((await st(b.sessionId)).activeFlags, ['waitingOnUserInput']);
  assert.equal(calls('agents').length, before + 1, 'cached within a round');
  clock += 10_000;
  fake.set(a.id, { state: 'done', status: 'idle' });
  fake.set(b.id, { state: 'failed' });
  assert.equal((await st(a.sessionId)).status, 'idle');
  assert.equal((await st(b.sessionId)).status, 'systemError');
  assert.equal((await backend.status('nope', undefined)).status, 'notLoaded');
});

test('send_message: busy session is queued and delivered by the watch once it is done', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const q = await tools.send_message.handler({ threadId: SID, message: '1つ目' });
  assert.equal(q.delivery, 'queued');
  await tools.send_message.handler({ threadId: SID, message: '2つ目' });
  assert.deepEqual(store.state().targets[SID].queue, ['1つ目', '2つ目']);
  assert.equal(calls('--resume').length, 0);

  fake.set(SID, { state: 'done', status: 'idle' });
  const r = await tools.wait_events.handler({});
  assert.ok(r.events.some((e) => e.type === 'queuedDelivered' && e.count === 2));
  const resume = calls('--resume')[0];
  assert.deepEqual(resume.args.slice(0, 3), ['--resume', SID, '--bg']);
  assert.equal(resume.args.at(-1), '1つ目\n\n2つ目');
  assert.ok(resume.args.includes('--mcp-config'), 'a resumed worker is launched with the same options');
  assert.equal(resume.args.at(-3), '--permission-mode');
  assert.equal(resume.cwd, '/r');
  assert.deepEqual(store.state().targets[SID].queue, []);
});

test('send_message to an idle session resumes it; steer is refused', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  const r = await tools.send_message.handler({ threadId: SID, message: '続き' });
  assert.equal(r.delivery, 'started');
  const args = calls('--resume')[0].args;
  assert.deepEqual(args.slice(0, 3), ['--resume', SID, '--bg']);
  assert.equal(args.at(-1), '続き');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__session-report__report');
  await assert.rejects(tools.send_message.handler({ threadId: SID, message: 'x', mode: 'steer' }), ToolError);
});

test('a failed delivery is reported once and retried later', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  store.updateTarget(SID, { queue: ['x'] });
  fake.set(SID, { state: 'done', status: 'idle' });
  fake.failResume = 'session is busy';
  const first = await tools.wait_events.handler({});
  assert.ok(first.events.some((e) => e.type === 'queuedFailed'));
  assert.match(first.events.find((e) => e.type === 'queuedFailed').error, /session is busy/);
  assert.deepEqual(await backend.tick(store.state().targets), [], 'not retried at once');
  fake.failResume = null;
  clock += 6 * 60 * 1000;
  assert.equal((await backend.tick(store.state().targets))[0].type, 'queuedDelivered');
});

test('when --resume starts a copy, the record follows the copy', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  fake.copyOnResume = true;
  const r = await tools.send_message.handler({ threadId: SID, message: '続き' });
  assert.equal(r.copiedTo, '99999999-8888-4777-8666-555555555555');
  const t = store.state().targets[SID];
  assert.equal(t.jobId, 'c0ffee01');
  assert.equal(t.sessionId, '99999999-8888-4777-8666-555555555555');
  clock += 10_000;
  fake.set('c0ffee01', { state: 'done', status: 'idle' });
  assert.equal((await backend.status(SID, t)).status, 'idle', 'status now comes from the copy');
  await tools.stop_session.handler({ threadId: SID });
  assert.equal(calls('stop').length, 0, 'the copy is idle, nothing to stop');
});

test('a copy announced only by its short id is followed too, and lists keep the record key', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  fake.copyOnResume = 'short';
  const r = await tools.send_message.handler({ threadId: SID, message: '続き' });
  assert.equal(r.copiedTo, '99999999-8888-4777-8666-555555555555');
  assert.equal(store.state().targets[SID].jobId, 'c0ffee01');
  clock += 10_000;
  const all = await tools.list_sessions.handler({ scope: 'all', includeArchived: true });
  const copyRow = all.sessions.find((s) => s.jobId === 'c0ffee01');
  assert.equal(copyRow.threadId, SID, 'the copy is shown under the record key');
  assert.equal(copyRow.sessionId, '99999999-8888-4777-8666-555555555555');
  const managed = await tools.list_sessions.handler({});
  assert.equal(managed.sessions[0].threadId, SID);
});

test('a stopped or paused session does not get queued messages', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  await tools.send_message.handler({ threadId: SID, message: '後で' });
  const stopped = await tools.stop_session.handler({ threadId: SID });
  assert.equal(stopped.droppedQueued, 1);
  assert.deepEqual(store.state().targets[SID].queue, []);
  // A queue left on a paused record (e.g. written by hand) is not delivered either.
  store.updateTarget(SID, { queue: ['x'] });
  const first = await tools.wait_events.handler({});
  assert.deepEqual(first.events.map((e) => [e.type, e.to]), [['status', 'idle']], 'the stop itself is reported once');
  const r = await tools.wait_events.handler({});
  assert.equal(r.idle, true);
  assert.equal(calls('--resume').length, 0);
});

test('a pending record does not block its name', async () => {
  await tools.update_session.handler({ threadId: 'pending-1', name: '後で起こす', status: 'pending' });
  const r = await tools.start_session.handler({ name: '後で起こす', cwd: '/r', prompt: 'p' });
  assert.equal(r.started, true);
});

test('stop_session stops only a running session', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const r = await tools.stop_session.handler({ threadId: SID });
  assert.equal(r.interrupted, true);
  assert.deepEqual(calls('stop')[0].args, ['stop', '7c5dcf51']);
  const again = await tools.stop_session.handler({ threadId: SID });
  assert.equal(again.interrupted, false);
  assert.equal(calls('stop').length, 1);
});

test('read_session returns the tail of claude logs', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const r = await tools.read_session.handler({ threadId: SID, maxChars: 500 });
  assert.match(r.log, /END OF LOG$/);
  assert.equal(r.session.jobId, '7c5dcf51');
  assert.deepEqual(calls('logs')[0].args, ['logs', '7c5dcf51']);
});

test('set_session_name changes only the record', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const r = await tools.set_session_name.handler({ threadId: SID, name: 'b' });
  assert.equal(r.renamed, false);
  assert.equal(store.state().targets[SID].name, 'b');
});

test('list_sessions all uses agents --json with --all and --cwd', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const r = await tools.list_sessions.handler({ scope: 'all', cwd: '/r', includeArchived: true });
  const last = calls('agents').at(-1).args;
  assert.deepEqual(last, ['agents', '--json', '--all', '--cwd', '/r']);
  assert.equal(r.sessions[0].threadId, SID);
  assert.equal(r.sessions[0].managed.status, 'running');
});

test('by default usage never stops Claude Code sessions, and no status line is asked for', async () => {
  let u = await tools.get_usage.handler({});
  assert.equal(u.pauseAtPct, null);
  assert.equal(u.usage.unavailable, true);
  assert.equal(u.usage.error, undefined);
  assert.doesNotMatch(u.usage.note, /statusline/);
  recordUsage({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 1_800_000_100 } } }, store.dir, new Date(clock));
  u = await tools.get_usage.handler({});
  assert.equal(u.usage.windows[0].usedPercent, 99, 'still shown when recorded');
  assert.equal(u.canStartNew, true);
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const r = await tools.wait_events.handler({ intervalMin: 1 / 60 });
  assert.equal(r.events.some((e) => e.type === 'usageHigh'), false);
});

test('usage comes from usage.json written by the status line; stale data is flagged', async () => {
  setup({ pauseAtPct: { claude: 95 } });
  let u = await tools.get_usage.handler({});
  assert.equal(u.pauseAtPct, 95);
  assert.match(u.usage.error, /status line/);
  assert.match(u.usage.error, /setup.mjs" statusline/);
  assert.match(u.usage.error, /デスクトップ app では描かれず/);
  assert.ok(recordUsage({ rate_limits: { five_hour: { used_percentage: 96.4, resets_at: 1_800_000_100 }, seven_day: { used_percentage: 41.2, resets_at: 1_800_500_000 } } }, store.dir, new Date(clock)));
  u = await tools.get_usage.handler({});
  assert.deepEqual(u.usage.windows.map((w) => [w.window, w.usedPercent]), [['5h', 96.4], ['weekly', 41.2]]);
  assert.equal(u.usage.stale, false);
  assert.equal(u.canStartNew, false);
  assert.match(u.reasons[0], /claude\/5h が 96.4%/);
  clock += 31 * 60 * 1000;
  const later = await tools.get_usage.handler({});
  assert.equal(later.usage.stale, true);
  assert.deepEqual(later.usage.windows.map((w) => w.window), ['weekly'], 'a window past its reset time is dropped');
  assert.equal(later.canStartNew, true);
});

test('read_session points at a usage limit near the end of the log', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.log = '作業中…\n⎿ 5-hour limit reached ∙ resets 5pm (Asia/Tokyo)\n';
  let r = await tools.read_session.handler({ threadId: SID });
  assert.equal(r.usageLimit, '⎿ 5-hour limit reached ∙ resets 5pm (Asia/Tokyo)');
  fake.log = 'Usage limit reached\n' + 'y'.repeat(3000) + '\n続きを進めました';
  r = await tools.read_session.handler({ threadId: SID });
  assert.equal(r.usageLimit, null, 'an old line far back does not count');
});

test('a session waiting for the usage limit is not reported as waiting for the user', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'blocked', waitingFor: 'usage limit' });
  clock += 10_000;
  const [s] = (await tools.list_sessions.handler({})).sessions;
  assert.deepEqual(s.activeFlags, ['waitingOnUsageLimit']);
  fake.set(SID, { state: 'blocked', waitingFor: 'something new' });
  clock += 10_000;
  assert.deepEqual((await tools.list_sessions.handler({})).sessions[0].activeFlags, ['waitingOnUserInput']);
});

test('an untrusted folder is explained instead of the raw CLI error', async () => {
  fake.failNext = 'Workspace not trusted. Run `claude` in /new once and accept the trust prompt, then retry.';
  await assert.rejects(tools.start_session.handler({ name: 'a', cwd: '/new', prompt: 'p' }), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /\/new が Claude Code に信頼されていない/);
    assert.match(err.message, /リポジトリごと/);
    assert.match(err.message, /リモート/);
    return true;
  });
  assert.deepEqual(store.state().targets, {}, 'nothing recorded');
  // Resuming in a folder that is not trusted is explained the same way.
  await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  clock += 10_000;
  fake.failResume = 'Workspace not trusted. Run `claude` in /r once and accept the trust prompt, then retry.';
  await assert.rejects(tools.send_message.handler({ threadId: SID, message: '続き' }), (err) => {
    assert.match(err.message, /\/r が Claude Code に信頼されていない/);
    assert.match(err.message, /send_message/, 'a resume is retried with send_message, not start_session');
    return true;
  });
});

test('the home directory is never trusted, so the manager is told to use a repository', async () => {
  fake.failNext = 'Error: Workspace not trusted: ~ is the home directory, whose trust is never saved.';
  await assert.rejects(tools.start_session.handler({ name: 'a', cwd: homedir(), prompt: 'p' }), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /ホームディレクトリ/);
    assert.doesNotMatch(err.message, /承認してから終了/);
    return true;
  });
});

test('threads paused for usage are released when pauseAtPct is off, even if usage cannot be read', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  store.updateTarget(SID, { status: 'paused_usage' });
  fake.set(SID, { state: 'stopped', status: undefined });
  clock += 10_000;
  const r = await tools.wait_events.handler({});
  assert.deepEqual(r.events.filter((e) => e.type === 'usageRecovered').map((e) => e.threadIds), [[SID]]);
});

test('status line: nothing recorded without rate_limits; short text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'csm-sl-'));
  assert.equal(recordUsage({ model: {} }, dir), false);
  assert.equal(existsSync(join(dir, 'usage.json')), false);
  assert.equal(line({ rate_limits: { five_hour: { used_percentage: 23.5 }, seven_day: { used_percentage: 41 } } }), '5h 24% · 週 41%');
  assert.equal(line({}), '');
});

test('a report written by name is linked to the session in wait_events', async () => {
  await tools.start_session.handler({ name: '試し', cwd: '/r', prompt: 'p' });
  await tools.report.handler({ kind: 'done', text: '済み', from: '試し' });
  const r = await tools.wait_events.handler({});
  const rep = r.events.find((e) => e.type === 'report');
  assert.equal(rep.threadId, SID);
  // After a rename, reports under the old name still match.
  await tools.set_session_name.handler({ threadId: SID, name: '新しい名前' });
  await tools.report.handler({ kind: 'progress', text: '途中', from: '試し' });
  const r2 = await tools.wait_events.handler({});
  assert.equal(r2.events.find((e) => e.type === 'report').threadId, SID);
});

test('an old name (alias) still blocks a new session of that name', async () => {
  await tools.start_session.handler({ name: '旧', cwd: '/r', prompt: 'p' });
  await tools.set_session_name.handler({ threadId: SID, name: '新' });
  await assert.rejects(tools.start_session.handler({ name: '旧', cwd: '/r', prompt: 'p' }), /同じ名前/);
});

test('list_sessions shows how many messages are held for a session', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  await tools.send_message.handler({ threadId: SID, message: '1' });
  await tools.send_message.handler({ threadId: SID, message: '2' });
  const r = await tools.list_sessions.handler({});
  assert.equal(r.sessions[0].managed.queued, 2);
  assert.equal(r.sessions[0].managed.queueFailedAt, null);
});

test('a record without job or session id does not claim unrelated rows', async () => {
  await tools.update_session.handler({ threadId: 'pending-1', name: '後で', status: 'pending' });
  // An interactive session: no short id, only a session id.
  fake.sessions.push({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', name: 'ふつうの会話', kind: 'interactive', state: 'working', status: 'busy', cwd: '/r' });
  const r = await tools.list_sessions.handler({ scope: 'all', includeArchived: true });
  const row = r.sessions.find((s) => s.name === 'ふつうの会話');
  assert.equal(row.threadId, 'aaaaaaaa-0000-4000-8000-000000000000');
  assert.equal(row.managed, null);
});

test('a session the manager did not start is resumed without the worker options', async () => {
  const other = 'bbbbbbbb-0000-4000-8000-000000000000';
  fake.sessions.push({ id: 'b0b0b0b0', sessionId: other, name: '人の会話', kind: 'background', state: 'done', status: 'idle', cwd: '/r' });
  const r = await tools.send_message.handler({ threadId: other, message: 'こんにちは' });
  assert.equal(r.delivery, 'started');
  assert.deepEqual(calls('--resume')[0].args, ['--resume', other, '--bg', 'こんにちは']);
});

test('a session paused while its queue is being delivered stays paused', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  store.updateTarget(SID, { queue: ['x'] });
  fake.set(SID, { state: 'done', status: 'idle' });
  const run = fake.run;
  fake.run = async (path, args, opts) => {
    if (args[0] === '--resume') store.updateTarget(SID, { status: 'paused_usage' });
    return run(path, args, opts);
  };
  backend = claudeBackend({ store, claudePath: 'claude', permissionMode: 'acceptEdits', run: fake.run, now: () => clock });
  const events = await backend.tick(store.state().targets);
  assert.equal(events[0].type, 'queuedDelivered');
  assert.equal(store.state().targets[SID].status, 'paused_usage');
});

test('a profile picks model and effort; explicit values win; the record keeps the profile', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p', profile: 'design' });
  const args = calls('--bg')[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
  assert.equal(store.state().targets[SID].profile, 'design');
  await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p', profile: 'writing', effort: 'max' });
  const b = calls('--bg')[1].args;
  assert.equal(b[b.indexOf('--model') + 1], 'sonnet');
  assert.equal(b[b.indexOf('--effort') + 1], 'max');
  const u = await tools.get_usage.handler({});
  assert.deepEqual(
    u.profiles.map((p) => [p.name, p.model, p.effort]),
    [['design', 'opus', 'xhigh'], ['debug', 'opus', 'high'], ['implement', 'opus', 'medium'], ['review', 'opus', 'high'], ['writing', 'sonnet', 'high'], ['routine', 'sonnet', 'medium']],
  );
});

test('send_message changes model and effort: at once for an idle session, at delivery for a busy one', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p', profile: 'implement' });
  fake.set(SID, { state: 'done', status: 'idle' });
  const r = await tools.send_message.handler({ threadId: SID, message: '原因を探して', profile: 'debug' });
  assert.deepEqual(r.changed, { model: 'opus', effort: 'high' });
  const resume = calls('--resume')[0].args;
  assert.equal(resume[resume.indexOf('--effort') + 1], 'high');
  assert.equal(store.state().targets[SID].profile, 'debug');

  // Busy: held, and delivered with the new values.
  clock += 10_000;
  await tools.send_message.handler({ threadId: SID, message: 'もっと深く', effort: 'xhigh' });
  assert.equal(store.state().targets[SID].effort, 'xhigh');
  assert.equal(store.state().targets[SID].profile, null, 'no longer exactly the profile');
  fake.set(SID, { state: 'done', status: 'idle' });
  clock += 10_000;
  await tools.wait_events.handler({});
  const delivered = calls('--resume')[1].args;
  assert.equal(delivered[delivered.indexOf('--effort') + 1], 'xhigh');
  assert.equal(delivered[delivered.indexOf('--model') + 1], 'opus');
});

test('a session the manager did not start gets only the requested model and effort', async () => {
  const other = 'cccccccc-0000-4000-8000-000000000000';
  fake.sessions.push({ id: 'c0c0c0c0', sessionId: other, name: '人の会話', kind: 'background', state: 'done', status: 'idle', cwd: '/r' });
  await tools.send_message.handler({ threadId: other, message: 'やあ', model: 'sonnet' });
  assert.deepEqual(calls('--resume')[0].args, ['--resume', other, '--bg', '--model', 'sonnet', 'やあ']);
});

test('a change sent while another delivery is running reaches the next delivery', async () => {
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p', profile: 'implement' });
  await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p', profile: 'implement' });
  const [a, b] = fake.sessions;
  store.updateTarget(a.sessionId, { queue: ['A1'] });
  store.updateTarget(b.sessionId, { queue: ['B1'] });
  fake.set(a.id, { state: 'done', status: 'idle' });
  fake.set(b.id, { state: 'done', status: 'idle' });
  const run = fake.run;
  let sent = false;
  fake.run = async (path, args, opts) => {
    // While A is being delivered, the manager raises B's effort.
    if (args[0] === '--resume' && args[1] === a.sessionId && !sent) {
      sent = true;
      fake.set(b.id, { state: 'working', status: 'busy' });
      await tools.send_message.handler({ threadId: b.sessionId, message: 'B2', effort: 'xhigh' });
      fake.set(b.id, { state: 'done', status: 'idle' });
    }
    return run(path, args, opts);
  };
  backend = claudeBackend({ store, claudePath: 'claude', permissionMode: 'acceptEdits', run: fake.run, now: () => clock });
  await backend.tick(store.state().targets);
  const toB = fake.calls.find((c) => c.args[0] === '--resume' && c.args[1] === b.sessionId).args;
  assert.equal(toB[toB.indexOf('--effort') + 1], 'xhigh');
  assert.equal(toB.at(-1), 'B1\n\nB2');
});

test('profile names are checked as own keys, and a mixed request is not labelled with the profile', async () => {
  await assert.rejects(tools.start_session.handler({ name: 'x', cwd: '/r', prompt: 'p', profile: 'constructor' }), /profile「constructor」はありません/);
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p', profile: 'writing', effort: 'max' });
  assert.equal(store.state().targets[SID].profile, null);
  setup({ profiles: { codexOnly: { description: 'x', codex: { effort: 'low' } } } });
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  await assert.rejects(tools.send_message.handler({ threadId: SID, message: 'x', profile: 'codexOnly' }), /Claude Code 用のモデル・エフォートがありません/);
});

test('profiles in config.json replace or remove the built-in ones', async () => {
  setup({ profiles: { design: { description: '設計', claude: { model: 'fable', effort: 'max' } }, routine: null, docs: { description: '文書', claude: { model: 'haiku' } } } });
  const u = await tools.get_usage.handler({});
  const by = Object.fromEntries(u.profiles.map((p) => [p.name, p]));
  assert.equal(by.design.model, 'fable');
  assert.equal(by.routine, undefined);
  assert.equal(by.docs.effort, null);
  assert.equal(by.implement.model, 'opus', 'others stay');
});

test('worker role exposes only report', () => {
  const only = toolsForRole(tools, 'worker');
  assert.deepEqual(Object.keys(only), ['report']);
  assert.ok(Object.keys(toolsForRole(tools, undefined)).length > 5);
});

const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
const APP_ID = 'local_0b5e1d2c-3f4a-4b5c-8d6e-7f8091a2b3c4';
const APP_SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// What the manager does with start_session's answer in the desktop app.
async function startInApp(name, extra = {}) {
  const r = await tools.start_session.handler({ name, cwd: '/repo', prompt: 'やること', ...extra });
  await tools.update_session.handler({ threadId: APP_ID, ...r.record });
  return r;
}

test('in the desktop app, start_session returns what to pass to the app instead of running claude --bg', async () => {
  setup({}, DESKTOP);
  const u = await tools.get_usage.handler({});
  assert.equal(u.launcher, 'app');
  const r = await tools.start_session.handler({ name: '画面の確認', cwd: '/repo', prompt: 'やること', profile: 'implement', area: 'ui' });
  assert.equal(r.started, false);
  assert.equal(r.startInApp, true);
  assert.equal(calls('--bg').length, 0);
  const a = r.appStart;
  assert.equal(a.initiation, 'user_asked');
  assert.equal(a.context, 'fresh');
  assert.equal(a.title, '画面の確認');
  assert.equal(a.use_worktree, true);
  assert.equal(a.cwd, '/repo');
  assert.equal(a.model, 'opus');
  assert.equal(a.effort, 'medium');
  assert.equal(a.permission_mode, 'acceptEdits');
  assert.match(a.prompt, /この会話の名前: 画面の確認\n/);
  assert.match(a.prompt, /やること$/);
  assert.match(a.background, /report/);
  assert.match(a.background, /400 字/);
  assert.ok(a.background.length >= 80, 'the app needs at least 80 characters of background');
  assert.deepEqual(r.record, { name: '画面の確認', status: 'running', via: 'app', cwd: '/repo', area: 'ui', profile: 'implement', model: 'opus', effort: 'medium' });
  assert.match(r.next, /set_pinned/);
  // The guard still applies, and via="bg" keeps the old way.
  const bg = await tools.start_session.handler({ name: '別', cwd: '/repo', prompt: 'p', via: 'bg' });
  assert.equal(bg.started, true);
  assert.equal(calls('--bg').length, 1);
});

test('an app session is watched through its interactive row, found by title until a report gives its ID', async () => {
  setup({}, DESKTOP);
  await startInApp('試し');
  const t = store.state().targets[APP_ID];
  assert.equal(t.via, 'app');
  assert.deepEqual(t.lastSeen, { status: 'active', activeFlags: [] });
  // Not listed yet: still starting.
  assert.equal((await backend.status(APP_ID, t)).status, 'active');
  fake.sessions.push({ pid: 9, cwd: '/repo/.claude/worktrees/x', kind: 'interactive', startedAt: clock + 1000, sessionId: APP_SID, name: '試し', status: 'busy' });
  clock += 10_000;
  assert.equal((await backend.status(APP_ID, store.state().targets[APP_ID])).status, 'active');
  assert.equal(store.state().targets[APP_ID].sessionId, APP_SID, 'bound by title');
  // Renamed in the app: the bound ID still finds it.
  fake.set(APP_SID, { name: '別の題名', status: 'idle' });
  const r = await tools.wait_events.handler({});
  assert.deepEqual(r.events.map((e) => [e.type, e.from, e.to]), [['status', 'active', 'idle']]);
  const listed = (await tools.list_sessions.handler({})).sessions[0];
  assert.equal(listed.via, 'app');
  assert.equal(listed.status, 'idle');
});

test('an app session that never shows up is notLoaded once the start grace is over', async () => {
  setup({}, DESKTOP);
  await startInApp('消えた');
  clock += 4 * 60 * 1000;
  assert.equal((await backend.status(APP_ID, store.state().targets[APP_ID])).status, 'notLoaded');
});

test("an app worker's report carries its session ID, which links the record", async () => {
  setup({}, DESKTOP);
  await startInApp('報告する');
  // The worker's own server (the plugin's) runs with its session's ID.
  const worker = createTools({ backend, store, sys: { env: { CLAUDE_CODE_SESSION_ID: APP_SID } } }).tools;
  await worker.report.handler({ kind: 'progress', text: '途中', from: '報告する' });
  const r = await tools.wait_events.handler({});
  const rep = r.events.find((e) => e.type === 'report');
  assert.equal(rep.threadId, APP_ID);
  assert.equal(rep.sessionId, APP_SID);
  assert.equal(store.state().targets[APP_ID].sessionId, APP_SID);
});

test('app sessions are read, messaged and stopped with the app tools; renaming keeps the old name', async () => {
  setup({}, DESKTOP);
  await startInApp('app の会話');
  await assert.rejects(tools.read_session.handler({ threadId: APP_ID }), (e) => e instanceof ToolError && /list_events/.test(e.message));
  await assert.rejects(tools.send_message.handler({ threadId: APP_ID, message: 'x' }), (e) => e instanceof ToolError && /SendMessage/.test(e.message));
  await assert.rejects(tools.stop_session.handler({ threadId: APP_ID }), (e) => e instanceof ToolError && /stop_session/.test(e.message));
  assert.equal(calls('--resume').length + calls('stop').length + calls('logs').length, 0);
  const n = await tools.set_session_name.handler({ threadId: APP_ID, name: '新' });
  assert.match(n.note, /set_session_title/);
  assert.deepEqual(store.state().targets[APP_ID].aliases, ['app の会話']);
});

test('claude --bg is refused with a clear reason when the CLI is not logged in', async () => {
  fake.loggedIn = false;
  await assert.rejects(tools.start_session.handler({ name: 'x', cwd: '/r', prompt: 'p' }), (e) => e instanceof ToolError && /ログインしていない/.test(e.message) && /via="app"/.test(e.message));
  assert.equal(calls('--bg').length, 0);
});

test('two sessions with the title: the newest is watched, but neither is bound until a report says which', async () => {
  setup({}, DESKTOP);
  await startInApp('同名');
  for (const [sid, at] of [[APP_SID, 1000], ['bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', 2000]])
    fake.sessions.push({ pid: 9, cwd: '/x', kind: 'interactive', startedAt: clock + at, sessionId: sid, name: '同名', status: 'busy' });
  clock += 10_000;
  assert.equal((await backend.status(APP_ID, store.state().targets[APP_ID])).status, 'active');
  assert.equal(store.state().targets[APP_ID].sessionId, undefined);
  // read_reports binds too.
  const worker = createTools({ backend, store, sys: { env: { CLAUDE_CODE_SESSION_ID: APP_SID } } }).tools;
  await worker.report.handler({ kind: 'done', text: '済み', from: '同名' });
  await tools.read_reports.handler({});
  assert.equal(store.state().targets[APP_ID].sessionId, APP_SID);
});

test('a resume is refused with a clear reason when the CLI is not logged in', async () => {
  await tools.start_session.handler({ name: 'r', cwd: '/r', prompt: 'p' });
  fake.set(SID, { state: 'done', status: 'idle' });
  fake.loggedIn = false;
  clock += 10_000;
  await assert.rejects(tools.send_message.handler({ threadId: SID, message: '続き' }), (e) => e instanceof ToolError && /ログインしていない/.test(e.message));
  assert.equal(calls('--resume').length, 0);
});
