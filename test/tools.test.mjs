import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from '../src/appserver.mjs';
import { Store } from '../src/state.mjs';
import { createTools, ToolError } from '../src/tools.mjs';
import { FakeAppServer } from './fake-appserver.mjs';

const GB = 1024 ** 3;
// A CPU that is never busy, so the real load while tests run does not count.
const idleCpus = () => [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
let fake, store, tools, freeGb, clock;

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'csm-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ pollSec: 1, watchIntervalMin: 5 / 60, ...config }));
  store = new Store(dir);
  fake = new FakeAppServer();
  const client = new AppServerClient({ connector: fake.connector() });
  clock = 0;
  ({ tools } = createTools({
    client,
    store,
    sys: { freemem: () => freeGb * GB, totalmem: () => 16 * GB, now: () => clock, sleep: async (ms) => (clock += ms), cpus: idleCpus },
  }));
}

const calls = (method) => fake.calls.filter((c) => c.method === method);

beforeEach(() => {
  freeGb = 8;
  setup();
});

test('start_session: thread/start, name, first turn with id; recorded in state', async () => {
  const r = await tools.start_session.handler({ name: '画面の確認', cwd: '/repo', prompt: 'やること', model: 'gpt-x', effort: 'high', area: 'src/ui' });
  assert.equal(r.started, true);
  assert.equal(r.threadId, 'thr_1');
  assert.equal(r.open, 'codex resume thr_1');

  const start = calls('thread/start')[0].params;
  assert.equal(start.cwd, '/repo');
  assert.equal(start.model, 'gpt-x');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'never');
  assert.match(start.developerInstructions, /report/);
  assert.match(start.developerInstructions, /画面の確認/);

  assert.deepEqual(calls('thread/name/set')[0].params, { threadId: 'thr_1', name: '画面の確認' });
  const turn = calls('turn/start')[0].params;
  assert.equal(turn.effort, 'high');
  assert.equal(turn.input[0].type, 'text');
  assert.deepEqual(turn.input[0].text_elements, []);
  assert.match(turn.input[0].text, /ID: thr_1/);
  assert.match(turn.input[0].text, /やること$/);

  const target = store.state().targets.thr_1;
  assert.equal(target.codexWorker, true);
  assert.equal(target.codexReportHome, store.dir);
  assert.equal(target.status, 'running');
  assert.equal(target.area, 'src/ui');
  assert.equal(target.effort, 'high');
});

test('start_session uses config defaults and omits model/effort when unset', async () => {
  setup({ defaults: { sandbox: 'read-only' } });
  await tools.start_session.handler({ name: 'a', cwd: '/r', prompt: 'p' });
  const start = calls('thread/start')[0].params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.ok(!('model' in start));
  assert.ok(!('effort' in calls('turn/start')[0].params));
});

test('Codex workers can report with approvalPolicy=never without granting manager tools', async () => {
  await tools.start_session.handler({ name: 'reporter', cwd: '/repo', prompt: 'report', sandbox: 'read-only' });
  const start = calls('thread/start')[0].params;
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'read-only');
  assert.deepEqual(Object.keys(start.config).sort(), ['mcp_servers.session-manager.enabled', 'mcp_servers.session-report']);
  assert.equal(start.config['mcp_servers.session-manager.enabled'], false);
  const reporter = start.config['mcp_servers.session-report'];
  assert.equal(reporter.command, process.execPath);
  assert.deepEqual(reporter.args, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))]);
  assert.deepEqual(reporter.env, { CSM_AGENT: 'codex', CSM_ROLE: 'worker', CSM_HOME: store.dir });
  assert.deepEqual(reporter.enabled_tools, ['report']);
  assert.deepEqual(reporter.tools, { report: { approval_mode: 'approve' } });
  assert.equal(reporter.required, true);

  fake.threads.get('thr_1').status = { type: 'notLoaded' };
  await tools.send_message.handler({ threadId: 'thr_1', message: 'report again' });
  assert.deepEqual(calls('thread/resume')[0].params.config, start.config, 'reporting survives a resumed worker');

  fake.addThread('manual', { status: { type: 'notLoaded' } });
  store.updateTarget('manual', { name: 'manually tracked', status: 'running' });
  await tools.send_message.handler({ threadId: 'manual', message: 'continue' });
  assert.deepEqual(calls('thread/resume')[1].params, { threadId: 'manual', excludeTurns: true });
});

test('pre-upgrade Codex workers regain reporting on resume and keep their identity', async () => {
  const started = await tools.start_session.handler({ name: 'old worker', cwd: '/repo', prompt: 'work' });
  const state = store.state();
  delete state.targets[started.threadId].codexWorker;
  delete state.targets[started.threadId].codexReportHome;
  store.saveState(state);
  fake.reportServers.delete(started.threadId);
  fake.threads.get(started.threadId).status = { type: 'notLoaded' };

  const resumed = await tools.send_message.handler({ threadId: started.threadId, message: 'continue after upgrade' });
  assert.equal(resumed.threadId, started.threadId);
  assert.equal(resumed.delivery, 'started');
  const config = calls('thread/resume')[0].params.config;
  assert.deepEqual(config, calls('thread/start')[0].params.config);
  assert.equal(store.state().targets[started.threadId].codexWorker, true);
  assert.equal(store.state().targets[started.threadId].codexReportHome, store.dir);
  const input = calls('turn/start')[1].params.input[0].text;
  assert.match(input, /session-report/);
  assert.match(input, /continue after upgrade$/);
  fake.threads.get(started.threadId).status = { type: 'idle' };
  await tools.send_message.handler({ threadId: started.threadId, message: 'normal follow-up' });
  assert.equal(calls('turn/start')[2].params.input[0].text, 'normal follow-up');
});

test('loaded legacy workers are not falsely migrated or sent a new turn', async () => {
  fake.addThread('loaded', { status: { type: 'idle' } });
  store.updateTarget('loaded', { name: 'legacy', status: 'running', cwd: '/repo', startedAt: '2026-01-01T00:00:00Z' });
  await assert.rejects(tools.send_message.handler({ threadId: 'loaded', message: 'continue' }), /読み込まれている/);
  assert.equal(calls('thread/resume').length, 0);
  assert.equal(calls('turn/start').length, 0);
  assert.equal(store.state().targets.loaded.codexWorker, undefined);
});

test('ignored resume config does not mark migration complete or start work', async () => {
  fake.addThread('ignored', { status: { type: 'notLoaded' } });
  store.updateTarget('ignored', { name: 'legacy', status: 'running', cwd: '/repo', startedAt: '2026-01-01T00:00:00Z' });
  fake.ignoreResumeConfig = true;
  await assert.rejects(tools.send_message.handler({ threadId: 'ignored', message: 'continue' }), /適用を確認できません/);
  assert.equal(calls('turn/start').length, 0);
  assert.equal(store.state().targets.ignored.codexWorker, undefined);
});

test('loaded current workers continue only with the recorded report mailbox', async () => {
  const started = await tools.start_session.handler({ name: 'current', cwd: '/repo', prompt: 'work' });
  fake.threads.get(started.threadId).status = { type: 'idle' };
  await tools.send_message.handler({ threadId: started.threadId, message: 'continue' });
  assert.equal(calls('thread/resume')[0].params.config, undefined);
  fake.threads.get(started.threadId).status = { type: 'idle' };
  store.updateTarget(started.threadId, { codexReportHome: '/another-manager' });
  await assert.rejects(tools.send_message.handler({ threadId: started.threadId, message: 'continue' }), /読み込まれている/);
  assert.equal(calls('turn/start').length, 2);
});

test('loaded current workers cannot start or queue work after losing reporting overrides', async () => {
  for (const status of ['idle', 'active']) {
    fake.addThread(status, { status: { type: status } });
    store.updateTarget(status, { name: status, status: 'running', codexWorker: true, codexReportHome: store.dir });
    await assert.rejects(tools.send_message.handler({ threadId: status, message: 'must not proceed' }), /適用を確認できません/);
  }
  assert.equal(calls('turn/start').length, 0);
  assert.equal(calls('thread/queue/add').length, 0);
});

test('a loaded reporter does not authorize work if manager tools are exposed', async () => {
  const started = await tools.start_session.handler({ name: 'current', cwd: '/repo', prompt: 'work' });
  fake.threads.get(started.threadId).status = { type: 'idle' };
  fake.managerServers.add(started.threadId);
  await assert.rejects(tools.send_message.handler({ threadId: started.threadId, message: 'must not proceed' }), /管理ツールが残っている/);
  assert.equal(calls('turn/start').length, 1);
});

test('legacy detection excludes manual, partial, Claude and explicitly opted-out records', async () => {
  const records = [
    { name: 'manual', status: 'running' },
    { name: 'partial', status: 'running', cwd: '/repo' },
    { name: 'Claude', status: 'running', cwd: '/repo', startedAt: '2026-01-01T00:00:00Z', jobId: 'job', sessionId: 'session' },
    { name: 'opted out', status: 'running', cwd: '/repo', startedAt: '2026-01-01T00:00:00Z', codexWorker: false },
  ];
  for (const [i, record] of records.entries()) {
    const id = `existing_${i}`;
    fake.addThread(id, { status: { type: 'notLoaded' } });
    store.updateTarget(id, record);
    await tools.send_message.handler({ threadId: id, message: 'continue' });
    assert.deepEqual(calls('thread/resume')[i].params, { threadId: id, excludeTurns: true });
    assert.notEqual(store.state().targets[id].codexWorker, true);
  }
});

test('relative manager data directories are absolute in the worker environment', async () => {
  const relativeStore = new Store(relative(process.cwd(), store.dir));
  const client = new AppServerClient({ connector: fake.connector() });
  const { tools: relativeTools } = createTools({ client, store: relativeStore, sys: { freemem: () => 8 * GB, cpus: idleCpus, sleep: async () => {} } });
  await relativeTools.start_session.handler({ name: 'relative mailbox', cwd: '/different-repo', prompt: 'report' });
  const home = calls('thread/start')[0].params.config['mcp_servers.session-report'].env.CSM_HOME;
  assert.equal(isAbsolute(home), true);
  assert.equal(home, store.dir);
});

test('the number of running sessions does not limit; a busy CPU does, unless force', async () => {
  // Two samples of one CPU: 95 of 100 ticks busy between them.
  let snap = 0;
  const cpus = () => [{ times: snap++ === 0 ? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } : { user: 95, nice: 0, sys: 0, idle: 5, irq: 0 } }];
  const client = new AppServerClient({ connector: fake.connector() });
  const busy = createTools({ client, store, sys: { freemem: () => 8 * GB, totalmem: () => 16 * GB, now: () => clock, sleep: async (ms) => (clock += ms), cpus } }).tools;
  for (const id of ['r1', 'r2', 'r3']) {
    fake.addThread(id, { status: { type: 'active', activeFlags: [] } });
    store.updateTarget(id, { name: id, status: 'running' });
  }
  const r = await busy.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p' });
  assert.equal(r.started, false);
  assert.deepEqual(r.reasons, ['CPU の使用率 95%（上限 90%）']);
  assert.equal(r.guard.running, 3);
  assert.equal(calls('thread/start').length, 0);
  const forced = await busy.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p', force: true });
  assert.equal(forced.started, true);
  // With the CPU calm, three running sessions do not stop a fourth.
  snap = 0;
  const calm = () => [{ times: snap++ === 0 ? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } : { user: 20, nice: 0, sys: 0, idle: 80, irq: 0 } }];
  const ok = createTools({ client, store, sys: { freemem: () => 8 * GB, now: () => clock, sleep: async (ms) => (clock += ms), cpus: calm } }).tools;
  const u = await ok.get_usage.handler({});
  assert.equal(u.canStartNew, true);
  assert.equal(u.cpuPct, 20);
  assert.equal(u.maxCpuPct, 90);
  assert.equal('maxRunning' in u, false);
});

test('maxCpuPct null turns the CPU check off', async () => {
  setup({ maxCpuPct: null });
  const u = await tools.get_usage.handler({});
  assert.equal(u.cpuPct, null);
  assert.equal(u.maxCpuPct, null);
  assert.equal(u.launcher, null, 'Codex has no app sessions');
  await assert.rejects(tools.start_session.handler({ name: 'x', cwd: '/r', prompt: 'p', via: 'app' }), (e) => e instanceof ToolError && /Claude Code だけ/.test(e.message));
});

test('start_session refuses on low memory and on usage above pauseAtPct', async () => {
  freeGb = 1;
  fake.rateLimits.rateLimits.primary.usedPercent = 96;
  const r = await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p' });
  assert.equal(r.started, false);
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons[0], /空きメモリ 1\.0 GB（下限 2 GB）/);
  assert.match(r.reasons[1], /codex\/5h が 96%/);
});

test('send_message auto: queue for an active thread, resume + turn/start for an idle one', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  fake.addThread('i', { status: { type: 'notLoaded' } });
  const q = await tools.send_message.handler({ threadId: 'a', message: '続きを' });
  assert.equal(q.delivery, 'queued');
  const qp = calls('thread/queue/add')[0].params;
  assert.equal(qp.threadId, 'a');
  assert.equal(qp.input[0].text, '続きを');
  assert.ok(qp.clientUserMessageId);

  const s = await tools.send_message.handler({ threadId: 'i', message: '再開して' });
  assert.equal(s.delivery, 'started');
  assert.deepEqual(calls('thread/resume')[0].params, { threadId: 'i', excludeTurns: true });
  assert.equal(calls('turn/start')[0].params.input[0].text, '再開して');
});

test('codex: a profile sets the effort and leaves the model to Codex; explicit values win', async () => {
  const r = await tools.start_session.handler({ name: 'p', cwd: '/r', prompt: 'x', profile: 'debug' });
  assert.equal(r.profile, 'debug');
  assert.equal(r.effort, 'high');
  assert.equal(calls('thread/start')[0].params.model, undefined);
  assert.equal(calls('turn/start')[0].params.effort, 'high');
  await tools.start_session.handler({ name: 'q', cwd: '/r', prompt: 'x', profile: 'debug', effort: 'xhigh', model: 'm-1' });
  assert.equal(calls('thread/start')[1].params.model, 'm-1');
  assert.equal(calls('turn/start')[1].params.effort, 'xhigh');
  await assert.rejects(tools.start_session.handler({ name: 'z', cwd: '/r', prompt: 'x', profile: 'nope' }), /profile「nope」はありません/);
  const u = await tools.get_usage.handler({});
  assert.deepEqual(u.profiles.find((p) => p.name === 'design'), { name: 'design', description: u.profiles[0].description, model: null, effort: 'xhigh' });
});

test('codex: model and effort change with the next turn of a stopped thread, not of a running one', async () => {
  fake.addThread('i', { status: { type: 'idle' } });
  store.updateTarget('i', { name: 'I', status: 'running', effort: 'medium' });
  const r = await tools.send_message.handler({ threadId: 'i', message: '続き', effort: 'xhigh' });
  assert.deepEqual(r.changed, { effort: 'xhigh' });
  assert.equal(calls('turn/start')[0].params.effort, 'xhigh');
  assert.equal(store.state().targets.i.effort, 'xhigh');
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  await assert.rejects(tools.send_message.handler({ threadId: 'a', message: 'x', profile: 'design' }), /動いている会話のモデル・エフォートは変えられません/);
  assert.equal(calls('thread/queue/add').length, 0, 'nothing was queued');
});

test('send_message explains a missing thread/queue/add', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  fake.unsupported.add('thread/queue/add');
  await assert.rejects(tools.send_message.handler({ threadId: 'a', message: 'x' }), (e) => e instanceof ToolError && /thread\/queue\/add を使えません/.test(e.message));
});

test('send_message steer needs a running turn', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] }, turns: [{ id: 'tu1', status: 'inProgress', items: [] }] });
  const r = await tools.send_message.handler({ threadId: 'a', message: '割り込み', mode: 'steer' });
  assert.equal(r.delivery, 'steered');
  assert.equal(calls('turn/steer')[0].params.expectedTurnId, 'tu1');
  fake.addThread('b', { turns: [{ id: 'tu2', status: 'completed', items: [] }] });
  await assert.rejects(tools.send_message.handler({ threadId: 'b', message: 'x', mode: 'steer' }), ToolError);
});

test('stop_session interrupts the running turn and marks the target', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] }, turns: [{ id: 'tu1', status: 'inProgress', items: [] }] });
  store.updateTarget('a', { name: 'a', status: 'running' });
  const r = await tools.stop_session.handler({ threadId: 'a' });
  assert.equal(r.interrupted, true);
  assert.deepEqual(calls('turn/interrupt')[0].params, { threadId: 'a', turnId: 'tu1' });
  assert.equal(store.state().targets.a.status, 'paused');
  const again = await tools.stop_session.handler({ threadId: 'a', markAs: 'done' });
  assert.equal(again.interrupted, false);
  assert.equal(store.state().targets.a.status, 'done');
});

test('read_session summarizes the latest turns oldest first', async () => {
  fake.addThread('a', {
    name: 'n',
    turns: [
      { id: 't1', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: '依頼1' }] }, { type: 'agentMessage', text: '返事1' }] },
      { id: 't2', status: 'failed', error: { message: 'boom' }, items: [{ type: 'agentMessage', text: 'どちらにしますか', questions: [{ id: 'q' }] }, { type: 'commandExecution' }] },
    ],
  });
  const r = await tools.read_session.handler({ threadId: 'a', turns: 2 });
  assert.deepEqual(r.turns.map((t) => t.turnId), ['t1', 't2']);
  assert.equal(r.turns[0].user, '依頼1');
  assert.equal(r.turns[1].status, 'failed');
  assert.deepEqual(r.turns[1].questions, [{ id: 'q' }]);
  assert.equal(r.turns[1].commands, 1);
  assert.equal(calls('thread/turns/list')[0].params.itemsView, 'full');
});

test('read_session falls back to thread/read includeTurns on older servers', async () => {
  fake.addThread('a', { turns: [{ id: 't1', status: 'completed', items: [] }] });
  fake.unsupported.add('thread/turns/list');
  const r = await tools.read_session.handler({ threadId: 'a' });
  assert.equal(r.turns[0].turnId, 't1');
});

test('get_usage labels windows and reports the guard', async () => {
  const u = await tools.get_usage.handler({});
  assert.equal(u.canStartNew, true);
  assert.deepEqual(u.usage.windows.map((w) => [w.window, w.usedPercent]), [['5h', 40], ['weekly', 10]]);
  assert.equal(u.usage.windows[0].resetsAt, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(u.freeMemGb, 8);
  assert.equal(u.version, null, 'no version check unless the server gives one');
});

test('get_usage returns the version check the server gives', async () => {
  const version = { running: '0.7.0', installed: '0.8.0', autoUpdate: true, latest: null, reloadNeeded: true, updateAvailable: false };
  const client = new AppServerClient({ connector: new FakeAppServer().connector() });
  const make = (sessionId, v = version) =>
    createTools({ client, store, sys: { freemem: () => 8 * GB, totalmem: () => 16 * GB, cpus: idleCpus, env: { CLAUDE_CODE_SESSION_ID: sessionId }, version: async () => v } }).tools;
  const t = make('s1');
  assert.deepEqual((await t.get_usage.handler({})).version, { ...version, notified: false });
  // Once per conversation and versions, kept in state.json (a resumed or
  // compacted conversation runs a new tools object).
  assert.equal((await make('s1').get_usage.handler({})).version.notified, true);
  assert.equal((await make('s2').get_usage.handler({})).version.notified, false, 'another conversation');
  assert.equal((await make('s1', { ...version, installed: '0.9.0' }).get_usage.handler({})).version.notified, false, 'other versions');
  // Nothing to tell: nothing recorded.
  const quiet = { ...version, installed: '0.7.0', reloadNeeded: false };
  const before = store.state().versionNotices.length;
  assert.equal((await make('s3', quiet).get_usage.handler({})).version.notified, false);
  assert.equal(store.state().versionNotices.length, before);
});

test('get_usage prefers rateLimitsByLimitId when present', async () => {
  fake.rateLimits.rateLimitsByLimitId = {
    codex: { limitId: 'codex', primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null }, secondary: null },
    other: { limitId: 'other', primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null }, secondary: null },
  };
  const u = await tools.get_usage.handler({});
  assert.deepEqual(u.usage.windows.map((w) => `${w.limitId}/${w.window}`), ['codex/5h', 'other/60min']);
});

test('list_sessions managed: pending and done are not read', async () => {
  fake.addThread('a', { status: { type: 'idle' }, name: 'A' });
  store.updateTarget('a', { name: 'A', status: 'running' });
  store.updateTarget('p', { name: 'P', status: 'pending' });
  const r = await tools.list_sessions.handler({});
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions.find((s) => s.threadId === 'p').status, 'notChecked');
  assert.equal(calls('thread/read').length, 1);
});

test('list_sessions all: merges interactive and app-server/exec threads', async () => {
  fake.addThread('a');
  const r = await tools.list_sessions.handler({ scope: 'all', cwd: '/w' });
  const lists = calls('thread/list');
  assert.equal(lists.length, 2);
  assert.ok(!('sourceKinds' in lists[0].params));
  assert.deepEqual(lists[1].params.sourceKinds, ['exec', 'appServer']);
  assert.equal(lists[0].params.cwd, '/w');
  assert.equal(r.sessions.length, 1);
});

test('wait_events returns idle at once when nothing runs', async () => {
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'idle', activeFlags: [] } });
  const r = await tools.wait_events.handler({});
  assert.equal(r.idle, true);
  assert.equal(clock, 0);
});

test('wait_events returns new reports and status changes', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running' });
  await tools.report.handler({ kind: 'question', text: 'AとBどちら？', from: 'A', threadId: 'a' });
  const r1 = await tools.wait_events.handler({});
  assert.equal(r1.idle, false);
  assert.equal(r1.events[0].type, 'report');
  assert.equal(r1.events[0].kind, 'question');
  // the report was consumed
  fake.threads.get('a').status = { type: 'active', activeFlags: ['waitingOnApproval'] };
  const r2 = await tools.wait_events.handler({});
  assert.deepEqual(r2.events.map((e) => e.type), ['status']);
  assert.deepEqual(r2.events[0].activeFlags, ['waitingOnApproval']);
});

test('wait_events times out quietly and warns about low memory once', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running' });
  const quiet = await tools.wait_events.handler({ intervalMin: 3 / 60 });
  assert.equal(quiet.timedOut, true);
  assert.ok(clock >= 3000);
  freeGb = 0.5;
  const low = await tools.wait_events.handler({});
  assert.equal(low.events[0].type, 'memoryLow');
  const still = await tools.wait_events.handler({ intervalMin: 2 / 60 });
  assert.equal(still.timedOut, true, 'a lasting low-memory state is reported once');
  freeGb = 8;
  await tools.wait_events.handler({ intervalMin: 1 / 60 });
  freeGb = 0.5;
  assert.equal((await tools.wait_events.handler({})).events[0].type, 'memoryLow', 'reported again after recovering');
});

test('the watch interval comes from config, defaults to 30 minutes, can be shortened per call and is capped at 60', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running' });
  const timed = async (args) => {
    const from = clock;
    assert.equal((await tools.wait_events.handler(args)).timedOut, true);
    return (clock - from) / 60_000;
  };
  // Polling every minute keeps the loop short; the model is not involved.
  writeFileSync(join(store.dir, 'config.json'), JSON.stringify({ pollSec: 60 }));
  assert.equal(await timed({}), 30);
  assert.equal(await timed({ intervalMin: 10 }), 10);
  assert.equal(await timed({ intervalMin: 45 }), 30, 'not longer than the setting');
  writeFileSync(join(store.dir, 'config.json'), JSON.stringify({ pollSec: 60, watchIntervalMin: 120 }));
  assert.equal(await timed({}), 60);
});

test('wait_events reports a change that happened between calls, even when nothing runs now', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running' });
  await tools.wait_events.handler({ intervalMin: 1 / 60 });
  fake.threads.get('a').status = { type: 'idle' };
  const r = await tools.wait_events.handler({});
  assert.equal(r.idle, false);
  assert.deepEqual(r.events.map((e) => [e.type, e.from, e.to]), [['status', 'active', 'idle']]);
  assert.equal((await tools.wait_events.handler({})).idle, true);
});

test('wait_events reports usage above pauseAtPct', async () => {
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running' });
  fake.rateLimits.rateLimits.secondary.usedPercent = 97;
  const r = await tools.wait_events.handler({});
  assert.equal(r.events[0].type, 'usageHigh');
  assert.equal(r.events[0].windows[0].window, 'weekly');
  assert.equal((await tools.wait_events.handler({ intervalMin: 1 / 60 })).timedOut, true, 'not repeated for the same window');
});

test('a session that ends before the first wait_events is still reported', async () => {
  await tools.start_session.handler({ name: 'quick', cwd: '/r', prompt: 'p' });
  fake.threads.get('thr_1').status = { type: 'idle' };
  const r = await tools.wait_events.handler({});
  assert.equal(r.idle, false);
  assert.deepEqual(r.events.map((e) => [e.type, e.from, e.to]), [['status', 'active', 'idle']]);
});

test('a resumed session that ends before the next wait_events is still reported', async () => {
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'idle', activeFlags: [] } });
  await tools.send_message.handler({ threadId: 'a', message: '続き' });
  fake.threads.get('a').status = { type: 'idle' };
  const r = await tools.wait_events.handler({});
  assert.deepEqual(r.events.map((e) => e.type), ['status']);
});

for (const how of ['cancelled', 'superseded']) {
  test(`a ${how} wait_events does not consume reports`, async () => {
    // A sleep that only ends when released, so the first call is parked mid-wait.
    let release = () => {};
    const parked = createTools({
      client: new AppServerClient({ connector: fake.connector() }),
      store,
      sys: { freemem: () => 8 * GB, totalmem: () => 16 * GB, now: () => 0, sleep: () => new Promise((r) => (release = r)) },
    }).tools;
    fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
    store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
    const controller = new AbortController();
    const first = parked.wait_events.handler({ intervalMin: 5 / 60 }, { signal: controller.signal });
    while (!fake.calls.some((c) => c.method === 'account/rateLimits/read')) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await parked.report.handler({ kind: 'done', text: '済み' });
    if (how === 'cancelled') {
      controller.abort();
    } else {
      // The newer call takes the report; the parked one must not save anything.
      const second = await parked.wait_events.handler({ intervalMin: 5 / 60 });
      assert.deepEqual(second.events.map((e) => e.text), ['済み']);
      release();
    }
    const r1 = await first;
    assert.equal(r1.cancelled, true);
    if (how === 'cancelled') {
      const r2 = await tools.wait_events.handler({});
      assert.deepEqual(r2.events.map((e) => [e.type, e.text]), [['report', '済み']]);
    } else {
      assert.equal(store.hasUnreadReports(), false);
    }
  });
}

test('a session paused by hand does not keep the watch alive', async () => {
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'paused', lastSeen: { status: 'idle', activeFlags: [] } });
  const r = await tools.wait_events.handler({});
  assert.equal(r.idle, true);
});

test('a running wait_events does not overwrite lastSeen written by send_message meanwhile', async () => {
  let release = () => {};
  const parked = createTools({
    client: new AppServerClient({ connector: fake.connector() }),
    store,
    sys: { freemem: () => 8 * GB, totalmem: () => 16 * GB, now: () => 0, sleep: () => new Promise((r) => (release = r)) },
  }).tools;
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  fake.addThread('b', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  store.updateTarget('b', { name: 'B', status: 'running', lastSeen: { status: 'idle', activeFlags: [] } });
  const watching = parked.wait_events.handler({ intervalMin: 5 / 60 });
  while (!fake.calls.some((c) => c.method === 'account/rateLimits/read')) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await parked.send_message.handler({ threadId: 'b', message: '続き' });
  fake.threads.get('a').status = { type: 'idle' };
  release();
  await watching;
  assert.deepEqual(store.state().targets.b.lastSeen, { status: 'active', activeFlags: [] });
});

test('usage-paused sessions keep the watch alive and usageRecovered fires once when usage drops', async () => {
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'paused_usage', lastSeen: { status: 'idle', activeFlags: [] } });
  fake.rateLimits.rateLimits.primary.usedPercent = 99;
  const waiting = await tools.wait_events.handler({ intervalMin: 2 / 60 });
  assert.equal(waiting.idle, false);
  assert.deepEqual(waiting.events.map((e) => e.type), ['usageHigh']);
  const still = await tools.wait_events.handler({ intervalMin: 2 / 60 });
  assert.equal(still.timedOut, true);
  fake.rateLimits.rateLimits.primary.usedPercent = 3;
  const back = await tools.wait_events.handler({});
  assert.deepEqual(back.events.map((e) => [e.type, e.threadIds]), [['usageRecovered', ['a']]]);
  assert.equal((await tools.wait_events.handler({})).idle, true, 'not repeated; the watch may stop');
});

test('start_session records the thread even when the first turn fails', async () => {
  fake.unsupported.add('turn/start');
  await assert.rejects(tools.start_session.handler({ name: 'x', cwd: '/r', prompt: 'p', effort: 'max' }));
  const t = store.state().targets.thr_1;
  assert.equal(t.status, 'failed');
  assert.match(t.note, /最初の依頼を送れなかった/);
});

test('update_session records and removes targets', async () => {
  await tools.update_session.handler({ threadId: 'x', name: 'X', status: 'pending', note: '後で' });
  assert.equal(store.state().targets.x.note, '後で');
  const r = await tools.update_session.handler({ threadId: 'x', remove: true });
  assert.equal(r.removed, true);
  assert.equal(store.state().targets.x, undefined);
});

test('read_reports: unread once, then all newest first', async () => {
  await tools.report.handler({ kind: 'progress', text: '1' });
  await tools.report.handler({ kind: 'done', text: '2' });
  assert.deepEqual((await tools.read_reports.handler({})).reports.map((r) => r.text), ['1', '2']);
  assert.deepEqual((await tools.read_reports.handler({})).reports, []);
  assert.deepEqual((await tools.read_reports.handler({ all: true, limit: 1 })).reports.map((r) => r.text), ['2']);
});

test('work waiting for memory or CPU keeps the watch going and is reported once there is room', async () => {
  // Each pair of samples gives `busy` % of one CPU.
  let busy = 95;
  let n = 0;
  const cpus = () => [{ times: n++ % 2 === 0 ? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } : { user: busy, nice: 0, sys: 0, idle: 100 - busy, irq: 0 } }];
  const client = new AppServerClient({ connector: fake.connector() });
  const t = createTools({ client, store, sys: { freemem: () => 8 * GB, now: () => clock, sleep: async (ms) => (clock += ms), cpus } }).tools;
  store.updateTarget('wait:後で', { name: '後で', status: 'pending' });
  assert.equal((await t.wait_events.handler({})).idle, true, 'work put off by the user does not keep the watch going');
  // Refused for the busy CPU: kept as a TODO that waits for room.
  const refused = await t.start_session.handler({ name: '次', cwd: '/r', prompt: '依頼の要点', profile: 'implement' });
  assert.equal(refused.started, false);
  const todo = store.state().todos.find((td) => td.id === refused.todo);
  assert.deepEqual([todo.when, todo.auto, todo.status, todo.start.name, todo.start.prompt, todo.start.profile], [{ type: 'room' }, true, 'open', '次', '依頼の要点', 'implement']);
  const busyRound = await t.wait_events.handler({});
  assert.equal(busyRound.idle, false);
  assert.equal(busyRound.timedOut, true);
  busy = 20;
  const r = await t.wait_events.handler({});
  assert.deepEqual(r.events.map((e) => [e.type, e.todos, e.names, e.cpuPct, e.starts[0].prompt]), [['roomAvailable', [refused.todo], ['次'], 20, '依頼の要点']]);
  assert.equal((await t.wait_events.handler({})).timedOut, true, 'reported once');
  // Refused again when starting it: the same TODO waits anew and is reported again.
  busy = 95;
  clock += 1000;
  const again = await t.start_session.handler({ name: '次', cwd: '/r', prompt: '依頼の要点', todo: refused.todo });
  assert.equal(again.todo, refused.todo);
  // The same work asked again without its number waits in the same TODO.
  assert.equal((await t.start_session.handler({ name: '次', cwd: '/r', prompt: '依頼の要点' })).todo, refused.todo);
  assert.equal(store.state().todos.length, 1);
  busy = 20;
  assert.equal((await t.wait_events.handler({})).events[0]?.type, 'roomAvailable');
  // Started: linked to the session, and done with it.
  const started = await t.start_session.handler({ name: '次', cwd: '/r', prompt: '依頼の要点', todo: refused.todo });
  assert.equal(started.started, true);
  assert.deepEqual([store.state().todos[0].status, store.state().todos[0].threadId], ['started', started.threadId]);
  assert.equal((await t.wait_events.handler({})).events.some((e) => e.type === 'roomAvailable'), false);
  const done = await t.update_session.handler({ threadId: started.threadId, status: 'done' });
  assert.deepEqual(done.todosDone, [refused.todo]);
  assert.equal(store.state().todos[0].status, 'done');
});

test('records of older versions waiting for room or proposed as a card move into TODOs', async () => {
  store.updateTarget('wait:次', { name: '次', status: 'pending', waitForRoom: true, waitSince: '2026-10-01T00:00:00.000Z', via: 'bg', cwd: '/r', note: '依頼の要点' });
  store.updateTarget('card:カード', { name: 'カード', status: 'pending', cwd: '/r', note: 'デスクトップアプリのカードで提案' });
  store.updateTarget('p', { name: '保留', status: 'pending', note: '後で' });
  const r = await tools.list_sessions.handler({});
  assert.deepEqual(r.sessions.map((x) => x.name), ['保留']);
  assert.deepEqual(
    r.todos.map((td) => [td.id, td.text, td.when.type, td.start.name, td.start.via ?? null, Boolean(td.cardAt)]),
    [
      [1, '「次」を起こす（依頼の要点）', 'room', '次', 'bg', false],
      [2, '「カード」を起こす（デスクトップアプリのカードで提案）', 'anytime', 'カード', null, true],
    ],
  );
  // list_sessions may run in another conversation: it does not write.
  assert.deepEqual(Object.keys(store.state().targets).sort(), ['card:カード', 'p', 'wait:次']);
  await tools.wait_events.handler({ wait: false });
  assert.deepEqual(Object.keys(store.state().targets), ['p']);
  assert.equal(store.state().nextTodoId, 3);
});

test('work waiting for the usage limit is reported only once usage is back under pauseAtPct', async () => {
  fake.rateLimits.rateLimits.primary.usedPercent = 96;
  assert.equal((await tools.start_session.handler({ name: '枠', cwd: '/r', prompt: 'p' })).started, false);
  const blocked = await tools.wait_events.handler({});
  assert.equal(blocked.idle, false);
  assert.deepEqual(blocked.events.map((e) => e.type), ['usageHigh']);
  fake.rateLimits.rateLimits.primary.usedPercent = 10;
  const r = await tools.wait_events.handler({});
  assert.deepEqual(r.events.map((e) => [e.type, e.names]), [['roomAvailable', ['枠']]]);
});

// Tools whose sleep is parked until released and whose report watcher is a
// stand-in: notify() plays a change of reports.jsonl.
function watchedTools() {
  const w = { opened: 0, closed: 0, notify: () => {}, release: () => {} };
  const t = createTools({
    client: new AppServerClient({ connector: fake.connector() }),
    store,
    sys: {
      freemem: () => 8 * GB,
      totalmem: () => 16 * GB,
      now: () => 0,
      sleep: () => new Promise((r) => (w.release = r)),
      watchReports: (onChange) => {
        w.opened++;
        w.notify = onChange;
        return () => w.closed++;
      },
    },
  }).tools;
  return { t, w };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('a written report wakes the watch at once, without waiting for the poll', async () => {
  const { t, w } = watchedTools();
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  const watching = t.wait_events.handler({ intervalMin: 5 / 60 });
  await settle();
  const polls = calls('thread/read').length;
  await t.report.handler({ kind: 'done', text: '済み', from: 'A' });
  w.notify();
  w.notify(); // the same change can come twice
  const r = await watching;
  assert.deepEqual(r.events.map((e) => [e.type, e.text]), [['report', '済み']]);
  assert.equal(calls('thread/read').length, polls, 'statuses are not read again for a report');
  assert.deepEqual([w.opened, w.closed], [1, 1]);
});

test('a notice with no complete line goes back to waiting; the line is read once it is whole', async () => {
  const { t, w } = watchedTools();
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  const watching = t.wait_events.handler({ intervalMin: 5 / 60 });
  await settle();
  appendFileSync(store.reportsPath, '{"kind":"done","te');
  w.notify();
  await settle();
  appendFileSync(store.reportsPath, 'xt":"後半"}\n');
  w.notify();
  const r = await watching;
  assert.deepEqual(r.events.map((e) => [e.type, e.text]), [['report', '後半']]);
});

test('without a notice the poll still picks the report up', async () => {
  const { t, w } = watchedTools();
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  const watching = t.wait_events.handler({ intervalMin: 5 / 60 });
  await settle();
  await t.report.handler({ kind: 'progress', text: '途中' });
  w.release(); // the poll's sleep ends; no notice came
  const r = await watching;
  assert.deepEqual(r.events.map((e) => e.text), ['途中']);
  assert.deepEqual([w.opened, w.closed], [1, 1]);
});

test('the report watcher is closed on timeout, cancel and a newer call, and not opened when idle', async () => {
  let opened = 0;
  let closed = 0;
  const watchReports = () => (opened++, () => closed++);
  const client = new AppServerClient({ connector: fake.connector() });
  const t = createTools({ client, store, sys: { freemem: () => 8 * GB, now: () => clock, sleep: async (ms) => (clock += ms), watchReports } }).tools;
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'idle', activeFlags: [] } });
  assert.equal((await t.wait_events.handler({})).idle, true);
  assert.equal(opened, 0);
  fake.threads.get('a').status = { type: 'active', activeFlags: [] };
  store.updateTarget('a', { lastSeen: { status: 'active', activeFlags: [] } });
  assert.equal((await t.wait_events.handler({ intervalMin: 2 / 60 })).timedOut, true);
  assert.deepEqual([opened, closed], [1, 1]);

  const { t: parked, w } = watchedTools();
  const controller = new AbortController();
  const first = parked.wait_events.handler({ intervalMin: 5 / 60 }, { signal: controller.signal });
  await settle();
  controller.abort();
  assert.equal((await first).cancelled, true);
  assert.equal(w.closed, 1);
  const second = parked.wait_events.handler({ intervalMin: 5 / 60 });
  await settle();
  const releaseSecond = w.release;
  parked.wait_events.handler({ intervalMin: 5 / 60 }); // a newer call, left waiting
  await settle();
  releaseSecond();
  assert.equal((await second).cancelled, true);
  assert.deepEqual([w.opened, w.closed], [3, 2]);
});

test('the watch ends as stuck when every session waits for the user for stopWhenStuckMin, counted across calls', async () => {
  setup({ stopWhenStuckMin: 12 / 60 });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  fake.addThread('q', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  await tools.report.handler({ kind: 'question', text: '前の質問（答え済み）', from: 'Q' });
  await tools.report.handler({ kind: 'progress', text: '続けます', from: 'Q' });
  await tools.report.handler({ kind: 'question', text: 'AとBどちらにしますか？', from: 'Q' });
  await tools.report.handler({ kind: 'question', text: '名前は？', from: 'Q' });
  await tools.read_reports.handler({});
  const first = await tools.wait_events.handler({});
  assert.equal(first.timedOut, true);
  assert.equal(store.state().stuckSince, new Date(0).toISOString(), 'kept for the next call');
  assert.equal((await tools.wait_events.handler({})).timedOut, true);
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
  assert.equal(r.timedOut, false);
  assert.ok(clock >= 12_000 && clock < 15_000, `ended at ${clock}`);
  assert.deepEqual(
    r.waiting.map((x) => [x.name, x.waitingFor, x.questions, x.open]),
    [
      ['A', 'approval', [], 'codex resume a'],
      ['Q', 'question', ['AとBどちらにしますか？', '名前は？'], 'codex resume q'],
    ],
  );
  assert.equal(store.state().stuckSince, null, 'the next watch counts again');
  assert.equal((await tools.wait_events.handler({})).timedOut, true);
});

test('work waiting for memory or CPU counts as stuck; a working session does not', async () => {
  setup({ stopWhenStuckMin: 3 / 60, minFreeMemGb: 4 });
  freeGb = 1;
  store.updateTarget('wait:次', { name: '次', status: 'pending', waitForRoom: true, waitSince: 'x', note: '依頼の要点' });
  const r = await tools.wait_events.handler({});
  // memoryLow comes first and restarts the count
  assert.deepEqual(r.events.map((e) => e.type), ['memoryLow']);
  const stuck = await tools.wait_events.handler({});
  assert.equal(stuck.stuck, true);
  assert.deepEqual(stuck.waiting.map((x) => [x.name, x.waitingFor, x.note, x.open]), [['次', 'room', '依頼の要点', null]]);

  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  assert.equal((await tools.wait_events.handler({})).timedOut, true);
  assert.equal(store.state().stuckSince, null);
});

test('waiting for the usage limit never counts as stuck', async () => {
  setup({ stopWhenStuckMin: 2 / 60 });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  fake.addThread('u', { status: { type: 'active', activeFlags: ['waitingOnUsageLimit'] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('u', { name: 'U', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnUsageLimit'] } });
  assert.equal((await tools.wait_events.handler({})).timedOut, true, 'a session waiting for the limit to reset');
  store.updateTarget('u', { status: 'paused_usage', lastSeen: { status: 'idle', activeFlags: [] } });
  fake.threads.get('u').status = { type: 'idle' };
  fake.rateLimits.rateLimits.primary.usedPercent = 99;
  assert.deepEqual((await tools.wait_events.handler({})).events.map((e) => e.type), ['usageHigh']);
  assert.equal((await tools.wait_events.handler({})).timedOut, true, 'a session paused for the usage limit');
});

test('send_message, start_session and update_session restart the stuck count; null turns it off', async () => {
  setup({ stopWhenStuckMin: 8 / 60 });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnUserInput'] } });
  assert.equal((await tools.wait_events.handler({})).timedOut, true);
  await tools.update_session.handler({ threadId: 'a', note: '入力待ち' });
  assert.equal((await tools.wait_events.handler({})).timedOut, true, 'counted from the update');
  assert.equal(store.state().stuckSince, new Date(5000).toISOString());
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
  assert.equal(r.waiting[0].waitingFor, 'input');

  for (const act of [
    () => tools.send_message.handler({ threadId: 'a', message: '続き', mode: 'queue' }),
    () => tools.start_session.handler({ name: 'B', cwd: '/r', prompt: 'p', force: true }),
  ]) {
    const s = store.state();
    s.activityAt = null;
    store.saveState(s);
    await act();
    assert.equal(store.state().activityAt, new Date(clock).toISOString());
  }

  writeFileSync(join(store.dir, 'config.json'), JSON.stringify({ pollSec: 1, watchIntervalMin: 5 / 60, stopWhenStuckMin: null }));
  await tools.update_session.handler({ threadId: 'thr_1', remove: true });
  await tools.wait_events.handler({}); // the status change of the message to A
  for (let i = 0; i < 4; i++) assert.equal((await tools.wait_events.handler({})).timedOut, true);
  assert.equal(store.state().stuckSince, null);
});

test('a watch cancelled by the user restarts the stuck count', async () => {
  const { t } = watchedTools();
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  const controller = new AbortController();
  const first = t.wait_events.handler({ intervalMin: 5 / 60 }, { signal: controller.signal });
  await settle();
  controller.abort();
  assert.equal((await first).cancelled, true);
  assert.equal(store.state().activityAt, new Date(0).toISOString());
});

test('a stuck count left by a watch that stopped long ago starts over; a string setting counts', async () => {
  setup({ stopWhenStuckMin: '0.05' });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  const s = store.state();
  clock = 3 * 3600_000;
  s.stuckSince = new Date(0).toISOString();
  s.stuckCheckedAt = new Date(60_000).toISOString();
  store.saveState(s);
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true, '"0.05" is 3 seconds');
  assert.equal(r.stuckMin, 0, 'counted from this call, not from the old watch');
});

test('a message waiting to be delivered or a session added meanwhile is not stuck', async () => {
  setup({ stopWhenStuckMin: 2 / 60 });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('a', { name: 'A', status: 'running', queue: ['続き'], lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  assert.equal((await tools.wait_events.handler({})).timedOut, true, 'a queued message');
  store.updateTarget('a', { queue: [] });
  let added = false;
  const client = new AppServerClient({ connector: fake.connector() });
  const t = createTools({
    client,
    store,
    sys: {
      freemem: () => 8 * GB,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (!added) {
          added = true;
          store.updateTarget('local_new', { name: 'N', status: 'running', via: 'app' });
        }
      },
    },
  }).tools;
  assert.equal((await t.wait_events.handler({})).timedOut, true, 'a session added while the watch waits');
});

test('a report written during the round that reaches the stuck limit is returned instead of stuck', async () => {
  setup({ stopWhenStuckMin: 2 / 60 });
  // A CPU always 95% busy, so the work waiting for room never starts.
  let n = 0;
  const cpus = () => [{ times: n++ % 2 === 0 ? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } : { user: 95, nice: 0, sys: 0, idle: 5, irq: 0 } }];
  let written = false;
  const sleep = async (ms) => {
    clock += ms;
    // Written during the CPU sample, after the round read the reports.
    if (clock >= 3000 && !written) {
      written = true;
      store.appendReport({ kind: 'progress', text: '間に合った' });
    }
  };
  const client = new AppServerClient({ connector: fake.connector() });
  const t = createTools({ client, store, sys: { freemem: () => 8 * GB, now: () => clock, sleep, cpus, watchReports: () => () => {} } }).tools;
  store.updateTarget('wait:次', { name: '次', status: 'pending', waitForRoom: true, waitSince: 'x' });
  const r = await t.wait_events.handler({});
  assert.equal(r.stuck, undefined);
  assert.deepEqual(r.events.map((e) => [e.type, e.text]), [['report', '間に合った']]);
});

test('sessions waiting only for a decision keep the watch going until stuck; with stopWhenStuckMin null they are idle', async () => {
  setup({ stopWhenStuckMin: 3 / 60 });
  fake.addThread('q', { status: { type: 'idle' } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
  assert.deepEqual(r.waiting.map((x) => [x.name, x.waitingFor]), [['Q', 'question']]);
  writeFileSync(join(store.dir, 'config.json'), JSON.stringify({ pollSec: 1, watchIntervalMin: 5 / 60, stopWhenStuckMin: null }));
  assert.equal((await tools.wait_events.handler({})).idle, true);
});

test('questions answered with send_message or marked running again are not listed as waiting', async () => {
  setup({ stopWhenStuckMin: 3 / 60 });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  fake.addThread('q', { status: { type: 'idle' } });
  fake.addThread('p', { status: { type: 'idle' } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  store.updateTarget('p', { name: 'P', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  await tools.report.handler({ kind: 'question', text: '最初の質問', from: 'Q' });
  await tools.report.handler({ kind: 'question', text: 'Pの質問', from: 'P' });
  await tick();
  await tools.send_message.handler({ threadId: 'q', message: 'Aで' });
  await tools.update_session.handler({ threadId: 'p', status: 'running' });
  await tick();
  await tools.report.handler({ kind: 'question', text: '続きの質問', from: 'Q' });
  await tools.update_session.handler({ threadId: 'q', status: 'waiting_user' });
  await tools.update_session.handler({ threadId: 'p', status: 'waiting_user' });
  await tools.read_reports.handler({});
  fake.threads.get('q').status = { type: 'idle' };
  await tools.wait_events.handler({}); // the status change of the message to Q
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
  assert.deepEqual(r.waiting.map((x) => [x.name, x.questions]), [['Q', ['続きの質問']], ['P', []]]);
});

test('the stuck limit is kept even when pollSec is longer', async () => {
  setup({ stopWhenStuckMin: 3 / 60, pollSec: 60, watchIntervalMin: 2 });
  fake.addThread('a', { status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: ['waitingOnApproval'] } });
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
  assert.equal(clock, 3000);
});

test('a usage-paused session whose recovery was reported no longer holds off the stuck stop', async () => {
  setup({ stopWhenStuckMin: 3 / 60 });
  fake.addThread('q', { status: { type: 'idle' } });
  fake.addThread('u', { status: { type: 'idle' } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  store.updateTarget('u', { name: 'U', status: 'paused_usage', lastSeen: { status: 'idle', activeFlags: [] } });
  fake.rateLimits.rateLimits.primary.usedPercent = 99;
  assert.deepEqual((await tools.wait_events.handler({})).events.map((e) => e.type), ['usageHigh']);
  assert.equal((await tools.wait_events.handler({})).timedOut, true, 'still waiting for the limit');
  fake.rateLimits.rateLimits.primary.usedPercent = 3;
  assert.deepEqual((await tools.wait_events.handler({})).events.map((e) => e.type), ['usageRecovered']);
  const r = await tools.wait_events.handler({});
  assert.equal(r.stuck, true);
});

// Tools with what the TODO conditions read: the version of this tool, when
// this server started, and gh (prs: PR number -> state).
function todoTools({ running = '0.9.0', startedAt = 0, prs = {}, ghCalls = [], pid = 1, alive = () => true } = {}) {
  return createTools({
    client: new AppServerClient({ connector: fake.connector() }),
    store,
    sys: {
      freemem: () => freeGb * GB,
      totalmem: () => 16 * GB,
      now: () => clock,
      sleep: async (ms) => (clock += ms),
      cpus: idleCpus,
      running,
      startedAt,
      pid,
      alive,
      gh: async (args, opts) => {
        ghCalls.push({ args, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
        const state = prs[args[2]];
        return state ? { code: 0, stdout: JSON.stringify({ state }), stderr: '' } : { code: 1, stdout: '', stderr: 'no pull requests found' };
      },
    },
  }).tools;
}

test('todo: add, update, done and remove; numbers are not used again', async () => {
  const t = todoTools();
  const a = await t.todo.handler({ action: 'add', text: 'README を直す' });
  assert.deepEqual([a.todo.id, a.todo.when, a.todo.by, a.todo.auto, a.todo.status, a.todo.whenText, a.due], [1, { type: 'anytime' }, 'user', false, 'open', 'いつでも', true]);
  const b = await t.todo.handler({ action: 'add', text: 'PR #7 の続き', when: { type: 'pr', pr: 7 }, cwd: '/repo', by: 'manager' });
  assert.equal(b.todo.id, 2);
  assert.equal(b.todo.whenText, 'PR #7 がマージされたら');
  await t.todo.handler({ action: 'remove', id: 2 });
  assert.equal((await t.todo.handler({ action: 'add', text: '次' })).todo.id, 3);
  const u = await t.todo.handler({ action: 'update', id: 1, text: 'README（英語も）を直す', when: { type: 'at', at: '2026-10-23T09:00:00+09:00' } });
  assert.equal(u.todo.text, 'README（英語も）を直す');
  assert.equal(u.todo.when.type, 'at');
  await t.todo.handler({ action: 'done', id: 1, note: '済んだ' });
  assert.deepEqual([store.state().todos[0].status, store.state().todos[0].note], ['done', '済んだ']);
  await assert.rejects(t.todo.handler({ action: 'done', id: 9 }), /TODO 9 はありません/);
  await assert.rejects(t.todo.handler({ action: 'add', text: 'x', when: { type: 'pr' } }), /pr（PR の番号）/);
  await assert.rejects(t.todo.handler({ action: 'add', text: 'x', when: { type: 'at', at: 'あした' } }), /at（日時）/);
  await assert.rejects(t.todo.handler({ action: 'add', when: { type: 'anytime' } }), /text/);
  await assert.rejects(t.todo.handler({ action: 'add', text: 'x', when: { type: 'pr', pr: 7 } }), /cwd（リポジトリのフォルダ）か when.repo/);
  assert.equal((await t.todo.handler({ action: 'add', text: 'x', when: { type: 'pr', pr: 7, repo: 'horiu/x' } })).todo.when.repo, 'horiu/x');
  await assert.rejects(t.todo.handler({ action: 'update', id: 3, when: { type: 'pr', pr: 7 } }), /cwd（リポジトリのフォルダ）か when.repo/);
  await assert.rejects(t.todo.handler({ action: 'add', text: 'x', when: { type: 'usage', at: '5pm' } }), /日時として読めない/);
});

test('wait_events reports a TODO whose condition is met once, and "anytime" never', async () => {
  const ghCalls = [];
  const prs = { 7: 'OPEN' };
  const t = todoTools({ running: '0.9.0', startedAt: 0, prs, ghCalls });
  await t.todo.handler({ action: 'add', text: 'いつでも' });
  await t.todo.handler({ action: 'add', text: '朝に', when: { type: 'at', at: new Date(60_000).toISOString() } });
  await t.todo.handler({ action: 'add', text: 'マージ後', when: { type: 'pr', pr: 7 }, cwd: '/repo' });
  await t.todo.handler({ action: 'add', text: '新しい版で', when: { type: 'version', version: '0.10.0' } });
  assert.equal((await t.wait_events.handler({})).idle, true, 'nothing is due yet, and TODOs do not keep the watch going');
  assert.deepEqual(ghCalls.at(-1), { args: ['pr', 'view', '7', '--json', 'state'], cwd: '/repo', timeoutMs: 20000 });
  clock = 60_000;
  prs[7] = 'MERGED';
  const r = await t.wait_events.handler({});
  assert.deepEqual(r.events.map((e) => [e.type, e.todos.map((x) => [x.id, x.text, x.when])]), [
    ['todoDue', [[2, '朝に', `${new Date(60_000).toISOString()} になったら`], [3, 'マージ後', 'PR #7 がマージされたら']]],
  ]);
  assert.ok(store.state().todos[1].dueNotifiedAt);
  assert.equal((await t.wait_events.handler({})).idle, true, 'reported once');
  // A new condition is asked about again.
  await t.todo.handler({ action: 'update', id: 2, when: { type: 'at', at: new Date(0).toISOString() } });
  assert.deepEqual((await t.wait_events.handler({})).events.map((e) => e.todos.map((x) => x.id)), [[2]]);
});

test('TODOs waiting for a new version or a restart', async () => {
  clock = 1000;
  const running = new Set([11]);
  const alive = (pid) => running.has(pid);
  const before = todoTools({ running: '0.9.0', startedAt: 0, pid: 11, alive });
  await before.todo.handler({ action: 'add', text: '版が変わったら確かめる', when: { type: 'version' } });
  await before.todo.handler({ action: 'add', text: '再起動したら確かめる', when: { type: 'restart' } });
  assert.equal(store.state().todos[1].addedPid, 11);
  assert.deepEqual((await before.list_sessions.handler({})).todos.map((td) => td.due), [false, false]);
  // A new chat opened while the one that added it still runs is no restart.
  const newChat = todoTools({ running: '0.9.0', startedAt: 2000, pid: 12, alive });
  assert.deepEqual((await newChat.list_sessions.handler({})).todos.map((td) => td.due), [false, false]);
  // Restarted: the server that added it has gone, and any later conversation sees it.
  running.delete(11);
  const after = todoTools({ running: '0.9.1', startedAt: 2000, pid: 13, alive });
  assert.deepEqual((await after.list_sessions.handler({})).todos.map((td) => [td.due, td.whenText]), [
    [true, '新しい版で動いたら（読み込んだら）'],
    [true, '起動し直したら'],
  ]);
  // A server running since before the TODO was added has not restarted.
  const old = todoTools({ running: '0.9.0', startedAt: 500, pid: 14, alive });
  assert.equal((await old.list_sessions.handler({})).todos[1].due, false);
});

test('todo takes only the fields it is meant to change; a session is linked by threadId', async () => {
  const t = todoTools();
  await t.todo.handler({ action: 'add', text: 'A', status: 'done', createdAt: 'x', dueNotifiedAt: 'x', fromVersion: '9' });
  assert.deepEqual([store.state().todos[0].status, store.state().todos[0].createdAt, store.state().todos[0].dueNotifiedAt, store.state().todos[0].fromVersion], [
    'open',
    new Date(clock).toISOString(),
    undefined,
    '0.9.0',
  ]);
  await t.todo.handler({ action: 'update', id: 1, text: 'B', status: 'done', addedPid: 99, auto: true });
  assert.deepEqual([store.state().todos[0].text, store.state().todos[0].status, store.state().todos[0].addedPid, store.state().todos[0].auto], ['B', 'open', 1, true]);
  // Linking the session started from it starts it, and the session's end finishes it.
  store.updateTarget('s', { name: 'S', status: 'running' });
  await t.todo.handler({ action: 'update', id: 1, threadId: 's' });
  assert.deepEqual([store.state().todos[0].status, store.state().todos[0].threadId], ['started', 's']);
  await t.update_session.handler({ threadId: 's', status: 'done' });
  assert.equal(store.state().todos[0].status, 'done');
  await assert.rejects(t.todo.handler({ action: 'update', id: 1, threadId: 't' }), /済んでいます/);
});

test('a due TODO still open is returned again after an hour, without restarting the stuck count', async () => {
  setup({ stopWhenStuckMin: 3 * 60, watchIntervalMin: 9, pollSec: 60 });
  fake.addThread('q', { status: { type: 'idle' } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  const t = todoTools();
  await t.todo.handler({ action: 'add', text: '続き', when: { type: 'at', at: new Date(0).toISOString() }, auto: true });
  const first = await t.wait_events.handler({ wait: false });
  assert.deepEqual(first.events.map((e) => e.todos.map((x) => [x.id, x.repeat])), [[[1, false]]]);
  assert.deepEqual((await t.wait_events.handler({ wait: false })).events, [], 'not again at once');
  // The turn that got it ended before it acted (e.g. the usage limit): an
  // hour later the watch returns it again.
  let since = null;
  let again;
  for (;;) {
    again = await t.wait_events.handler({});
    if (again.events.length || clock > 2 * 60 * 60_000) break;
    assert.equal(again.timedOut, true);
    since = store.state().stuckSince;
  }
  assert.ok(clock >= 60 * 60_000 && clock < 75 * 60_000);
  assert.deepEqual(again.events.map((e) => e.todos.map((x) => [x.id, x.repeat])), [[[1, true]]]);
  assert.ok(since);
  assert.equal(store.state().stuckSince, since, 'a repeat is no news for the stuck count');
  // Started: no longer returned.
  await t.todo.handler({ action: 'update', id: 1, threadId: 'q' });
  clock += 61 * 60_000;
  assert.equal((await t.wait_events.handler({ wait: false })).events.length, 0);
});

test('list_sessions checks PR TODOs together, with a short gh timeout, and reuses a recent state', async () => {
  const ghCalls = [];
  const prs = { 7: 'OPEN', 8: 'MERGED' };
  const t = todoTools({ prs, ghCalls });
  await t.todo.handler({ action: 'add', text: 'A', when: { type: 'pr', pr: 7 }, cwd: '/repo' });
  await t.todo.handler({ action: 'add', text: 'B', when: { type: 'pr', pr: 8 }, cwd: '/repo' });
  ghCalls.length = 0;
  prs[7] = 'MERGED';
  const r = await t.list_sessions.handler({});
  assert.deepEqual(r.todos.map((td) => td.due), [false, true], 'the state read a moment ago is used again');
  assert.equal(ghCalls.length, 0);
  clock += 61_000;
  assert.deepEqual((await t.list_sessions.handler({})).todos.map((td) => td.due), [true, true]);
  assert.deepEqual(ghCalls.map((c) => c.timeoutMs), [5000, 5000]);
});

test('a TODO waiting for the usage limit is due when the reset time passes or the usage is back', async () => {
  const t = todoTools();
  fake.rateLimits.rateLimits.primary.usedPercent = 100;
  await t.todo.handler({ action: 'add', text: '続き', when: { type: 'usage' }, auto: true });
  await t.todo.handler({ action: 'add', text: '戻ったら', when: { type: 'usage', at: new Date(5000).toISOString() } });
  const before = (await t.list_sessions.handler({})).todos;
  assert.deepEqual(before.map((td) => td.due), [false, false]);
  assert.match(before[0].dueDetail, /使い切っている枠: 5h/);
  clock = 5000;
  assert.deepEqual((await t.list_sessions.handler({})).todos.map((td) => td.due), [false, true]);
  fake.rateLimits.rateLimits.primary.usedPercent = 10;
  assert.deepEqual((await t.list_sessions.handler({})).todos.map((td) => td.due), [true, true]);
  const r = await t.wait_events.handler({});
  assert.deepEqual(r.events[0].todos.map((x) => [x.id, x.auto]), [[1, true], [2, false]]);
});

test('list_sessions: TODOs with whether they are due, done ones only with includeArchived, and the handoff gist', async () => {
  const t = todoTools();
  await t.todo.handler({ action: 'add', text: 'A' });
  await t.todo.handler({ action: 'add', text: 'B' });
  await t.todo.handler({ action: 'done', id: 2 });
  let r = await t.list_sessions.handler({});
  assert.deepEqual(r.todos.map((td) => td.text), ['A']);
  assert.equal(r.handoff.exists, false);
  writeFileSync(join(store.dir, 'handoff.md'), '# 引き継ぎ\n- 次: PR #8 のレビュー\n');
  r = await t.list_sessions.handler({ includeArchived: true });
  assert.deepEqual(r.todos.map((td) => [td.text, td.status, td.due]), [['A', 'open', true], ['B', 'done', null]]);
  assert.match(r.handoff.text, /PR #8 のレビュー/);
});

test('a TODO to continue a session starts with a message to it and is done with the session', async () => {
  fake.addThread('a', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'pending' });
  const t = todoTools();
  await t.todo.handler({ action: 'add', text: '「A」の続き', threadId: 'a' });
  assert.equal(store.state().todos[0].status, 'open');
  await t.send_message.handler({ threadId: 'a', message: '続きをお願いします' });
  assert.equal(store.state().todos[0].status, 'started');
  await t.update_session.handler({ threadId: 'a', status: 'done' });
  assert.equal(store.state().todos[0].status, 'done');
  await assert.rejects(t.update_session.handler({ threadId: 'a', todo: 5 }), /TODO 5 はありません/);
  // A session that leaves the records before it is done gives its TODO back.
  await t.todo.handler({ action: 'add', text: '別の仕事' });
  store.updateTarget('b', { name: 'B', status: 'running' });
  await t.update_session.handler({ threadId: 'b', todo: 2 });
  assert.equal(store.state().todos[1].status, 'started');
  const removed = await t.update_session.handler({ threadId: 'b', remove: true });
  assert.deepEqual(removed.todosReopened, [2]);
  assert.deepEqual([store.state().todos[1].status, store.state().todos[1].threadId], ['open', null]);
});

test('wait_events with wait false returns at once with what is known, never as a timeout or stuck', async () => {
  setup({ stopWhenStuckMin: 1 / 60 });
  fake.addThread('a', { status: { type: 'active', activeFlags: [] } });
  fake.addThread('q', { status: { type: 'idle' } });
  store.updateTarget('a', { name: 'A', status: 'running', lastSeen: { status: 'active', activeFlags: [] } });
  store.updateTarget('q', { name: 'Q', status: 'waiting_user', lastSeen: { status: 'idle', activeFlags: [] } });
  let opened = 0;
  const t = createTools({
    client: new AppServerClient({ connector: fake.connector() }),
    store,
    sys: { freemem: () => 8 * GB, now: () => clock, sleep: async (ms) => (clock += ms), cpus: idleCpus, watchReports: () => (opened++, () => {}) },
  }).tools;
  const quiet = await t.wait_events.handler({ wait: false });
  assert.deepEqual([quiet.idle, quiet.timedOut, quiet.stuck, quiet.events, clock, opened], [false, false, undefined, [], 0, 0]);
  await t.report.handler({ kind: 'progress', text: '半分', from: 'A', threadId: 'a' });
  fake.threads.get('a').status = { type: 'idle' };
  const r = await t.wait_events.handler({ wait: false });
  assert.deepEqual(r.events.map((e) => e.type).sort(), ['report', 'status']);
  assert.equal(clock, 0);
  assert.equal(store.state().stuckSince, null);
});
