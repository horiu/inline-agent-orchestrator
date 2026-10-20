import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServerClient, RpcError, daemonConnector, embeddedConnector } from '../src/appserver.mjs';
import { FakeAppServer } from './fake-appserver.mjs';

const fakeCodex = [process.execPath, fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))];

test('initialize asks for the experimental API, then sends initialized', async () => {
  const fake = new FakeAppServer();
  const client = new AppServerClient({ connector: fake.connector() });
  await client.ensure();
  assert.equal(fake.calls[0].method, 'initialize');
  assert.deepEqual(fake.calls[0].params.capabilities, { experimentalApi: true, requestAttestation: false });
  assert.equal(fake.calls[0].params.clientInfo.name, 'inline_agent_orchestrator');
  assert.deepEqual(fake.calls[1], { method: 'initialized', params: {}, notification: true });
});

test('requests resolve, errors become RpcError', async () => {
  const fake = new FakeAppServer();
  fake.addThread('t1');
  const client = new AppServerClient({ connector: fake.connector() });
  const r = await client.request('thread/read', { threadId: 't1' });
  assert.equal(r.thread.id, 't1');
  await assert.rejects(client.request('thread/read', { threadId: 'nope' }), (e) => e instanceof RpcError && /thread not found/.test(e.message));
});

test('server requests are surfaced, not answered', async () => {
  const fake = new FakeAppServer();
  const client = new AppServerClient({ connector: fake.connector() });
  await client.ensure();
  const seen = [];
  client.onEvent((m) => seen.push(m.method));
  fake.emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } });
  fake.emit({ method: 'turn/completed', params: { threadId: 't1' } });
  assert.deepEqual(seen, ['item/commandExecution/requestApproval', 'turn/completed']);
  assert.equal(fake.calls.filter((c) => c.method === undefined).length, 0);
});

test('concurrent first requests wait for initialize to finish', async () => {
  const fake = new FakeAppServer();
  fake.addThread('t1');
  const client = new AppServerClient({ connector: fake.connector() });
  await Promise.all([client.request('thread/read', { threadId: 't1' }), client.request('thread/list', {})]);
  const order = fake.calls.map((c) => c.method);
  assert.deepEqual(order.slice(0, 2), ['initialize', 'initialized']);
  assert.equal(order.filter((m) => m === 'initialize').length, 1);
});

test('a failed connect is reported again without relaunching until retryAfterMs', async () => {
  let attempts = 0;
  let clock = 0;
  const client = new AppServerClient({
    connector: async () => {
      attempts++;
      throw new Error('no daemon');
    },
    retryAfterMs: 1000,
    now: () => clock,
  });
  await assert.rejects(client.request('thread/list', {}), /no daemon/);
  await assert.rejects(client.request('thread/list', {}), /no daemon/);
  assert.equal(attempts, 1);
  clock = 1500;
  await assert.rejects(client.request('thread/list', {}), /no daemon/);
  assert.equal(attempts, 2);
});

test('a late close from an old connection does not break the new one', async () => {
  const fake = new FakeAppServer();
  fake.addThread('t1');
  const closers = [];
  const inner = fake.connector();
  const client = new AppServerClient({
    connector: async (onMessage, onClose) => {
      closers.push(onClose);
      return inner(onMessage, onClose);
    },
  });
  await client.ensure();
  client.close();
  await client.ensure();
  closers[0]('old child exited');
  const r = await client.request('thread/read', { threadId: 't1' });
  assert.equal(r.thread.id, 't1');
});

test('closing the connection rejects pending requests and reconnects later', async () => {
  const fake = new FakeAppServer();
  fake.addThread('t1');
  let connects = 0;
  const inner = fake.connector();
  const client = new AppServerClient({
    connector: async (onMessage, onClose) => {
      connects++;
      const c = await inner(onMessage, onClose);
      return { ...c, send: (t) => (JSON.parse(t).method === 'thread/list' ? onClose('gone') : c.send(t)) };
    },
  });
  await assert.rejects(client.request('thread/list', {}), /connection closed: gone/);
  await client.request('thread/read', { threadId: 't1' });
  assert.equal(connects, 2);
});

test('daemon connector: starts the daemon, speaks WebSocket through `app-server proxy`', async () => {
  const client = new AppServerClient({ connector: daemonConnector(fakeCodex), requestTimeoutMs: 10000 });
  try {
    const r = await client.request('thread/read', { threadId: 'abc' });
    assert.equal(r.thread.id, 'abc');
  } finally {
    client.close();
  }
});

test('daemon connector reports a failing `daemon start`', async () => {
  process.env.FAKE_CODEX_FAIL = '1';
  try {
    const client = new AppServerClient({ connector: daemonConnector(fakeCodex) });
    await assert.rejects(client.ensure(), /daemon start` failed \(exit 3\): daemon unsupported/);
  } finally {
    delete process.env.FAKE_CODEX_FAIL;
  }
});

test('embedded connector speaks JSONL over stdio', async () => {
  const client = new AppServerClient({ connector: embeddedConnector(fakeCodex), requestTimeoutMs: 10000 });
  try {
    const r = await client.request('thread/read', { threadId: 'xyz' });
    assert.equal(r.thread.id, 'xyz');
  } finally {
    client.close();
  }
});
