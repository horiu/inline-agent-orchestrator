import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient, RpcError } from '../src/acp.mjs';
import { devinBackend } from '../src/backends/devin.mjs';
import { ToolError } from '../src/backends/common.mjs';
import { Store } from '../src/state.mjs';
import { FakeDevin } from './fake-devin.mjs';

const mkstore = () => new Store(mkdtempSync(join(tmpdir(), 'csm-devin-')));
const mkclient = (fake) => new AcpClient({ connector: fake.connector(), retryAfterMs: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('initialize asks ACP, then authenticate with the offered method', async () => {
  const fake = new FakeDevin();
  const client = mkclient(fake);
  await client.request('session/list', {});
  const methods = fake.calls.map((c) => c.method);
  assert.deepEqual(methods.slice(0, 2), ['initialize', 'authenticate']);
  assert.equal(fake.calls[0].params.protocolVersion, 1);
  assert.equal(fake.calls[0].params.clientCapabilities.fs.readTextFile, false);
  assert.equal(fake.calls[1].params.methodId, 'devin-browser');
});

test('initialize without authMethods skips authenticate', async () => {
  const fake = new FakeDevin();
  fake.authMethods = [];
  const client = mkclient(fake);
  await client.request('session/list', {});
  assert.equal(fake.calls.filter((c) => c.method === 'authenticate').length, 0);
});

test('start: session/new -> set_mode -> prompt, report MCP server attached', async () => {
  const fake = new FakeDevin();
  const store = mkstore();
  const be = devinBackend({ client: mkclient(fake), store });
  const created = [];
  const res = await be.start(
    { name: 'job', cwd: process.cwd(), approvalPolicy: 'never', instructions: 'RULES', firstMessage: (id) => `first ${id}` },
    { onCreated: (id, extra) => created.push([id, extra]) },
  );
  assert.equal(res.threadId, 'dev_1');
  assert.deepEqual(created, [['dev_1', { devinWorker: true }]]);
  const newCall = fake.calls.find((c) => c.method === 'session/new');
  assert.equal(newCall.params.cwd, process.cwd());
  const report = newCall.params.mcpServers.find((s) => s.name === 'session-report');
  assert.ok(report, 'session-report MCP server is attached');
  const env = Object.fromEntries((report.env ?? []).map((e) => [e.name, e.value]));
  assert.equal(env.CSM_ROLE, 'worker');
  assert.equal(env.CSM_AGENT, 'devin');
  assert.equal(env.CSM_HOME, store.dir);
  const modeCall = fake.calls.find((c) => c.method === 'session/set_mode');
  assert.equal(modeCall.params.modeId, 'smart'); // approvalPolicy never -> smart
  await sleep(10); // the prompt write lands a tick after start returns
  const prompt = fake.calls.find((c) => c.method === 'session/prompt');
  assert.ok(prompt.params.prompt[0].text.includes('RULES'));
  assert.ok(prompt.params.prompt[0].text.includes('first dev_1'));
});

test('config devin.mode and a model reach set_mode/set_config_option', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore(), mode: 'bypass' });
  await be.start({ name: 'job', cwd: process.cwd(), model: 'swe-2-high', instructions: '', firstMessage: () => 'go' }, {});
  assert.equal(fake.calls.find((c) => c.method === 'session/set_mode').params.modeId, 'bypass');
  const opt = fake.calls.find((c) => c.method === 'session/set_config_option');
  assert.deepEqual({ configId: opt.params.configId, value: opt.params.value }, { configId: 'model', value: 'swe-2-high' });
});

test('a finished prompt emits turn/completed and the session goes idle', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const events = [];
  be.onEvent((m) => events.push(m));
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  assert.equal((await be.status(threadId)).status, 'active');
  await sleep(20);
  assert.equal((await be.status(threadId)).status, 'idle');
  const done = events.find((m) => m.method === 'turn/completed' && m.params.threadId === threadId);
  assert.equal(done.params.turn.status, 'completed');
});

test('send queues while active and tick delivers once idle', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const store = mkstore();
  const be = devinBackend({ client: mkclient(fake), store });
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  store.updateTarget(threadId, { name: 'job', status: 'running' });
  assert.equal((await be.status(threadId)).status, 'active');
  const r = await be.send(threadId, 'second message', 'auto', store.state().targets[threadId], {});
  assert.equal(r.delivery, 'queued');
  assert.deepEqual(store.state().targets[threadId].queue, ['second message']);
  fake.complete(threadId);
  await sleep(20);
  const events = await be.tick(store.state().targets);
  assert.equal(events[0].type, 'queuedDelivered');
  await sleep(10);
  const prompts = fake.calls.filter((c) => c.method === 'session/prompt');
  assert.equal(prompts.at(-1).params.prompt[0].text, 'second message');
  assert.deepEqual(store.state().targets[threadId].queue, []);
});

test('steer sends a mid-turn prompt without queueing', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const store = mkstore();
  const be = devinBackend({ client: mkclient(fake), store });
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  const r = await be.send(threadId, 'steer it', 'steer', {}, {});
  assert.equal(r.delivery, 'steered');
  await sleep(10);
  assert.equal(fake.calls.filter((c) => c.method === 'session/prompt').length, 2);
});

test('permission requests are answered with the configured option and surfaced', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore(), permission: 'reject_once' });
  const events = [];
  be.onEvent((m) => events.push(m));
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  fake.askPermission(threadId, [{ optionId: 'allow_once' }, { optionId: 'reject_once' }, { optionId: 'switch_bypass' }]);
  await sleep(10);
  const answer = fake.permissionReplies.at(-1);
  assert.deepEqual(answer.result.outcome, { outcome: 'selected', optionId: 'reject_once' });
  assert.ok(events.some((m) => m.method === 'session/request_permission' && m.params.threadId === threadId));
});

test('permission without the configured option falls back to a safe choice', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore(), permission: 'allow_always_global' });
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  // The configured option is not offered; mode-switch options must not be picked.
  fake.askPermission(threadId, [{ optionId: 'switch_bypass' }, { optionId: 'allow_once' }, { optionId: 'reject_once' }]);
  await sleep(10);
  assert.deepEqual(fake.permissionReplies.at(-1).result.outcome, { outcome: 'selected', optionId: 'allow_once' });
  // Nothing safe to pick: the request is cancelled.
  fake.askPermission(threadId, [{ optionId: 'switch_bypass' }]);
  await sleep(10);
  assert.deepEqual(fake.permissionReplies.at(-1).result.outcome, { outcome: 'cancelled' });
});

test('read replays the transcript captured during session/load', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_9', { title: 'old work', cwd: '/somewhere' });
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const out = await be.read('dev_9', { turns: 2, maxChars: 4000 });
  assert.equal(out.turns.length, 1);
  assert.equal(out.turns[0].user, 'earlier ask');
  assert.equal(out.turns[0].agent, 'earlier answer');
  assert.equal(out.session.name, 'old work');
  assert.equal((await be.status('dev_9')).status, 'idle');
});

test('listAll maps session/list rows and marks locked sessions', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_1', { title: 'one' });
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const rows = await be.listAll({ limit: 10 }, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].threadId, 'dev_1');
  assert.equal(rows[0].status, 'notLoaded'); // known to the agent, not loaded here
});

test('stop cancels the in-flight turn', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const events = [];
  be.onEvent((m) => events.push(m));
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  const r = await be.stop(threadId);
  assert.equal(r.interrupted, true);
  assert.deepEqual(fake.calls.find((c) => c.method === 'session/cancel').params, { sessionId: threadId });
  await sleep(10);
  const done = events.find((m) => m.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'interrupted');
});

test('rename tries the rename methods and reports when the agent lacks one', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const r = await be.rename('dev_1', 'new name');
  assert.equal(r.renamed, false);
  assert.ok(r.note);
});

test('usage has no plan windows', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  assert.deepEqual(await be.usage(), { windows: [], ordinaryUsageAllowed: null });
});

test('a dead connection fails pending prompts and marks sessions reloadable', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const events = [];
  be.onEvent((m) => events.push(m));
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  assert.equal((await be.status(threadId)).status, 'active');
  fake.close('process exited');
  await sleep(10);
  assert.equal((await be.status(threadId)).status, 'notLoaded');
  // _client/closed reports the failure once; the prompt's rejection is silent.
  assert.equal(events.filter((m) => m.method === 'turn/completed' && m.params.turn.status === 'failed').length, 1);
});

test('a dropped connection reconnects; a late close from the old one is ignored', async () => {
  const fake = new FakeDevin();
  const closers = [];
  let connects = 0;
  const inner = fake.connector();
  const client = new AcpClient({
    connector: async (onMessage, onClose) => {
      connects++;
      closers.push(onClose);
      return inner(onMessage, onClose);
    },
    retryAfterMs: 0,
  });
  await client.request('session/list', {});
  fake.close('process exited'); // connection #1 dies
  await client.request('session/list', {}); // fresh connector, fresh initialize/authenticate
  assert.equal(connects, 2);
  assert.equal(fake.calls.filter((c) => c.method === 'initialize').length, 2);
  assert.equal(fake.calls.filter((c) => c.method === 'authenticate').length, 2);
  closers[0]('old child exited'); // a stale death notice must not kill connection #2
  await client.request('session/list', {});
  assert.equal(connects, 2);
});

test('a steered prompt settles silently while the tracked turn runs', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const events = [];
  be.onEvent((m) => events.push(m));
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  const r = await be.send(threadId, 'steer it', 'steer', {}, {});
  assert.equal(r.delivery, 'steered');
  await sleep(10);
  assert.equal(fake.calls.filter((c) => c.method === 'session/prompt').length, 2);
  // The steered prompt resolves while the tracked one is still in flight:
  // no idle flip, no turn/completed.
  fake.completeLast(threadId, 'end_turn');
  await sleep(10);
  assert.equal((await be.status(threadId)).status, 'active');
  assert.equal(events.filter((m) => m.method === 'turn/completed').length, 0);
  fake.complete(threadId);
  await sleep(10);
  const done = events.filter((m) => m.method === 'turn/completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].params.turn.status, 'completed');
});

test('concurrent sends to an unloaded session share one session/load', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_9', {});
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  await Promise.all([be.send('dev_9', 'one', 'start', null, {}), be.send('dev_9', 'two', 'start', null, {})]);
  assert.equal(fake.calls.filter((c) => c.method === 'session/load').length, 1);
});

test('a model change recorded with a queued message applies at delivery', async () => {
  const fake = new FakeDevin();
  fake.holdPrompts = true;
  const store = mkstore();
  const be = devinBackend({ client: mkclient(fake), store });
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  store.updateTarget(threadId, { name: 'job', status: 'running' });
  const r = await be.send(threadId, 'second', 'queue', store.state().targets[threadId], { model: 'x-model' });
  assert.equal(r.delivery, 'queued');
  fake.complete(threadId);
  await sleep(20);
  const events = await be.tick(store.state().targets);
  assert.equal(events[0].type, 'queuedDelivered');
  await sleep(10); // the delivered prompt lands a tick after tick() returns
  const opt = fake.calls.filter((c) => c.method === 'session/set_config_option').at(-1);
  assert.ok(opt, 'session/set_config_option was sent before the prompt');
  assert.equal(opt.params.value, 'x-model');
  const optIdx = fake.calls.indexOf(opt);
  assert.ok(fake.calls.findIndex((c, i) => i > optIdx && c.method === 'session/prompt') > 0);
});

test('stop on an idle session does not connect at all', async () => {
  const fake = new FakeDevin();
  let connects = 0;
  const inner = fake.connector();
  const client = new AcpClient({
    connector: async (onMessage, onClose) => (connects++, inner(onMessage, onClose)),
    retryAfterMs: 0,
  });
  const be = devinBackend({ client, store: mkstore() });
  const r = await be.stop('dev_1');
  assert.equal(r.interrupted, false);
  assert.equal(connects, 0);
});

test('send refuses a session locked by another process', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_l', { locked: true });
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  await be.listAll({ limit: 10 }, {}); // picks up the lock flag
  await assert.rejects(be.send('dev_l', 'work', 'start', null, {}), ToolError);
});

test('a permission answer after the connection died does not blow up', async () => {
  const fake = new FakeDevin();
  let release;
  const client = new AcpClient({
    connector: fake.connector(),
    permissionHandler: () => new Promise((r) => (release = r)),
    retryAfterMs: 0,
  });
  await client.request('session/list', {});
  fake.askPermission('dev_1', [{ optionId: 'allow_once' }]);
  await sleep(10); // the request reached the handler
  fake.close('gone');
  release('allow_once');
  await sleep(10);
  // Nothing could be written on the dead pipe — and nothing rejected.
  assert.equal(fake.permissionReplies.length, 0);
});

test('a disconnect clears the transcript so a reload does not duplicate turns', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_9', { title: 'old work' });
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const first = await be.read('dev_9', { turns: 6, maxChars: 4000 });
  assert.equal(first.turns.length, 1);
  fake.close('process exited');
  await sleep(10);
  assert.equal((await be.status('dev_9')).status, 'notLoaded');
  // The next read reconnects and replays the transcript exactly once.
  const second = await be.read('dev_9', { turns: 6, maxChars: 4000 });
  assert.equal(second.turns.length, 1);
  assert.equal(second.turns[0].user, 'earlier ask');
  assert.equal(second.turns[0].agent, 'earlier answer');
});

test('read on an already-loaded session answers from the transcript without reloading', async () => {
  const fake = new FakeDevin();
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  const { threadId } = await be.start({ name: 'job', cwd: process.cwd(), instructions: '', firstMessage: () => 'go' }, {});
  await sleep(20); // the prompt settles; its live chunks sit in the transcript
  const loads = fake.calls.filter((c) => c.method === 'session/load').length;
  const out = await be.read(threadId, { turns: 6, maxChars: 4000 });
  assert.equal(fake.calls.filter((c) => c.method === 'session/load').length, loads);
  assert.ok(out.turns.length >= 1);
  assert.ok(out.turns.at(-1).agent.includes('doing it'));
});

test('a lock seen earlier is re-checked before send and clears when released', async () => {
  const fake = new FakeDevin();
  fake.addSession('dev_l', { locked: true });
  const be = devinBackend({ client: mkclient(fake), store: mkstore() });
  await be.listAll({ limit: 10 }, {});
  await assert.rejects(be.send('dev_l', 'work', 'start', null, {}), ToolError);
  // The holder released the session; the next send re-lists and goes through.
  fake.sessions.get('dev_l').locked = false;
  const r = await be.send('dev_l', 'work', 'start', null, {});
  assert.equal(r.delivery, 'started');
});
