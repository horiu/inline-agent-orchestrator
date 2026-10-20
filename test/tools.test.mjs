import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient } from '../src/appserver.mjs';
import { Store } from '../src/state.mjs';
import { createTools, ToolError } from '../src/tools.mjs';
import { FakeAppServer } from './fake-appserver.mjs';

const GB = 1024 ** 3;
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
    sys: { freemem: () => freeGb * GB, totalmem: () => 16 * GB, now: () => clock, sleep: async (ms) => (clock += ms) },
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

test('start_session refuses when the running limit is reached, unless force', async () => {
  setup({ maxRunning: 1 });
  fake.addThread('busy', { status: { type: 'active', activeFlags: [] } });
  store.updateTarget('busy', { name: 'busy', status: 'running' });
  const r = await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p' });
  assert.equal(r.started, false);
  assert.match(r.reasons[0], /動いている会話が 1 本（上限 1）/);
  assert.equal(calls('thread/start').length, 0);
  const forced = await tools.start_session.handler({ name: 'b', cwd: '/r', prompt: 'p', force: true });
  assert.equal(forced.started, true);
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
