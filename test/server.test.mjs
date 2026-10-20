import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createMcpServer } from '../src/server.mjs';
import { ToolError } from '../src/tools.mjs';
import { Store } from '../src/state.mjs';

function harness(tools) {
  const out = [];
  const server = createMcpServer({ tools, write: (s) => out.push(JSON.parse(s)) });
  const call = async (msg) => {
    server.receive(JSON.stringify(msg));
    await new Promise((r) => setTimeout(r, 5));
    return out.shift();
  };
  return { call, out };
}

const tools = {
  echo: { description: 'e', readOnly: true, inputSchema: { type: 'object' }, handler: async (a) => ({ got: a }) },
  boom: { description: 'b', inputSchema: { type: 'object' }, handler: async () => { throw new ToolError('説明つきの失敗'); } },
  crash: { description: 'c', inputSchema: { type: 'object' }, handler: async () => { throw new TypeError('x is undefined'); } },
};

test('initialize negotiates the protocol version', async () => {
  const { call } = harness(tools);
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  const unknown = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, '2025-11-25');
});

test('notifications get no answer; unknown requests get -32601', async () => {
  const { call } = harness(tools);
  assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  const r = await call({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
});

test('tools/list carries the read-only hint', async () => {
  const { call } = harness(tools);
  const r = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(r.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]), [['echo', true], ['boom', false], ['crash', false]]);
});

test('tools/call returns text + structured content, and errors as isError', async () => {
  const { call } = harness(tools);
  const ok = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  assert.deepEqual(ok.result.structuredContent, { got: { a: 1 } });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: { a: 1 } });
  const boom = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(boom.result.isError, true);
  assert.equal(boom.result.content[0].text, '説明つきの失敗');
  const crash = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'crash' } });
  assert.equal(crash.result.content[0].text, 'TypeError: x is undefined');
  const missing = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(missing.result.isError, true);
});

test('parse errors answer with -32700', async () => {
  const out = [];
  const server = createMcpServer({ tools, write: (s) => out.push(JSON.parse(s)) });
  server.receive('{not json');
  assert.equal(out[0].error.code, -32700);
});

test('the real entry point lists all tools over stdio without touching Codex', async () => {
  const home = mkdtempSync(join(tmpdir(), 'csm-srv-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, CSM_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const next = () => new Promise((r) => lines.once('line', (l) => r(JSON.parse(l))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  await next();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  const list = await next();
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report', arguments: { kind: 'done', text: 'ok' } } }) + '\n');
  const rep = await next();
  child.stdin.end();
  await new Promise((r) => child.on('exit', r));
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ['get_usage', 'list_sessions', 'read_reports', 'read_session', 'report', 'send_message', 'set_session_name', 'start_session', 'stop_session', 'update_session', 'wait_events'],
  );
  assert.equal(rep.result.structuredContent.ok, true);
});

test('a report-only worker advertises a writing tool and writes to the selected mailbox', async () => {
  const home = mkdtempSync(join(tmpdir(), 'csm-worker-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, CSM_AGENT: 'codex', CSM_ROLE: 'worker', CSM_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const call = (id, method, params) => new Promise((resolve) => {
    lines.once('line', line => resolve(JSON.parse(line)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await call(1, 'initialize', { protocolVersion: '2025-11-25' });
    const list = await call(2, 'tools/list');
    assert.deepEqual(list.result.tools.map(t => t.name), ['report']);
    assert.equal(list.result.tools[0].annotations.readOnlyHint, false);
    const denied = await call(3, 'tools/call', { name: 'start_session', arguments: {} });
    assert.equal(denied.result.isError, true);
    const done = await call(4, 'tools/call', { name: 'report', arguments: { kind: 'done', text: 'worker done' } });
    assert.equal(done.result.structuredContent.ok, true);
    assert.deepEqual(new Store(home).peekReports().reports.map(r => [r.kind, r.text]), [['done', 'worker done']]);
  } finally {
    const closed = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    await closed;
  }
});
