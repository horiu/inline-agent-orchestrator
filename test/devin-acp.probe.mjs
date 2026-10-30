// ACP probe for `devin acp` — verifies initialize / session/new / session/prompt /
// session(update) / request_permission / fs handling, single & multi session.
// Usage:
//   node test/devin-acp.probe.mjs single "prompt text"
//   node test/devin-acp.probe.mjs multi "prompt A" "prompt B"
// Env: DEVIN_PATH overrides binary path (DEVIN_EXE is accepted too).
//      WORK_DIR overrides session cwd. DEVIN_SESSION_ID for `load` mode.

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function defaultDevinExe() {
  if (process.platform === 'win32') {
    const app = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const bundled = path.join(app, 'Programs', 'Devin', 'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  return 'devin'; // rely on PATH
}

const DEVIN_EXE = process.env.DEVIN_PATH ?? process.env.DEVIN_EXE ?? defaultDevinExe();
const WORK_DIR = process.env.WORK_DIR ?? path.join(os.tmpdir(), 'devin-acp-probe-work');

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, method}
let child;

function send(msg) {
  const line = JSON.stringify(msg);
  log('>>', line.length > 400 ? line.slice(0, 400) + '…' : line);
  child.stdin.write(line + '\n');
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id=${id})`));
      }
    }, 300_000);
  });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---- agent -> client request handlers ----

async function handleAgentRequest(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'session/request_permission': {
        const opts = params?.options ?? [];
        const tool = params?.toolCall?.title ?? params?.toolCall?.kind ?? '(unknown tool)';
        log(`PERMISSION request for ${tool}; options:`,
          opts.map(o => `${o.optionId}:${o.kind}`).join(', '));
        const allow = opts.find(o => o.kind === 'allow_always')
          ?? opts.find(o => o.kind === 'allow_once')
          ?? opts[0];
        log(`PERMISSION -> ${allow?.optionId ?? 'cancel'} (${allow?.kind})`);
        if (allow) return respond(id, { outcome: { outcome: 'selected', optionId: allow.optionId } });
        return respond(id, { outcome: { outcome: 'cancelled' } });
      }
      case 'fs/read_text_file': {
        const content = fs.readFileSync(params.path, 'utf8');
        return respond(id, { content });
      }
      case 'fs/write_text_file': {
        fs.mkdirSync(path.dirname(params.path), { recursive: true });
        fs.writeFileSync(params.path, params.content, 'utf8');
        log(`fs/write_text_file -> ${params.path} (${params.content.length} bytes)`);
        return respond(id, null);
      }
      default:
        log(`UNHANDLED agent request ${method}`, JSON.stringify(params).slice(0, 300));
        return respondError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    return respondError(id, -32603, String(e));
  }
}

function handleMessage(msg) {
  if (msg.id !== undefined && msg.method) {
    return handleAgentRequest(msg);
  }
  if (msg.id !== undefined) {
    // response to our request
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      log('<<', p.method, 'result:', JSON.stringify(msg.result ?? msg.error).slice(0, 600));
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else {
      log('<< response for unknown id', msg.id);
    }
    return;
  }
  // notification
  const { method, params } = msg;
  if (method === 'session/update') {
    const u = params?.update ?? {};
    const kind = u.sessionUpdate;
    let brief = '';
    if (kind === 'agent_message_chunk' || kind === 'user_message_chunk' || kind === 'agent_thought_chunk') {
      brief = (u.content?.text ?? '').slice(0, 120).replace(/\n/g, '\\n');
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      brief = `${u.title ?? u.toolCallId ?? ''} status=${u.status ?? ''}`;
    } else {
      brief = JSON.stringify(u).slice(0, 200);
    }
    log(`UPDATE [${params.sessionId?.slice(0, 8)}] ${kind} ${brief}`);
  } else {
    log(`NOTIFY ${method}`, JSON.stringify(params).slice(0, 300));
  }
}

async function start() {
  child = spawn(DEVIN_EXE, ['acp'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  child.on('error', e => { console.error('spawn error:', e); process.exit(1); });
  child.on('exit', (code, sig) => { log(`devin acp exited code=${code} sig=${sig}`); });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { log('NONJSON:', line.slice(0, 200)); return; }
    handleMessage(msg);
  });

  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'acp-probe', version: '0.1.0' },
  });
  log('CAPABILITIES:', JSON.stringify(init, null, 2).slice(0, 2000));

  if (Array.isArray(init.authMethods) && init.authMethods.length > 0) {
    log('authMethods:', init.authMethods.map(m => m.id ?? m).join(', '));
    // try authenticate with the first method — devin may accept silently if creds on disk
    try {
      await request('authenticate', { methodId: init.authMethods[0].id ?? init.authMethods[0] });
      log('authenticate OK');
    } catch (e) {
      log('authenticate failed (continuing):', e.message);
    }
  }
  return init;
}

async function runSession(promptText, label) {
  const s = await request('session/new', { cwd: WORK_DIR, mcpServers: [] });
  log(`[${label}] sessionId =`, s.sessionId, 'modes=', JSON.stringify(s.modes ?? null), 'models=', JSON.stringify(s.models ?? null).slice(0, 400));
  const r = await request('session/prompt', {
    sessionId: s.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  log(`[${label}] prompt done stopReason=`, JSON.stringify(r));
  return s.sessionId;
}

const mode = process.argv[2] ?? 'single';
try {
  await start();
  if (mode === 'multi') {
    const ids = await Promise.all([runSession(process.argv[3] ?? 'Say only: A done', 'A'),
                                   runSession(process.argv[4] ?? 'Say only: B done', 'B')]);
    log('sessions:', ids.join(', '));
  } else if (mode === 'setmode') {
    // session/new -> set_mode bypass -> write file -> run exec command
    const s = await request('session/new', { cwd: WORK_DIR, mcpServers: [] });
    log('sessionId =', s.sessionId);
    const modeId = process.argv[3] ?? 'bypass';
    try {
      const m = await request('session/set_mode', { sessionId: s.sessionId, modeId });
      log('set_mode result:', JSON.stringify(m));
    } catch (e) { log('set_mode failed:', e.message); }
    for (const p of ['Create a file named probe-out.txt with the text "hello acp".',
                     'Run the shell command `dir` and tell me how many files are listed.']) {
      const r = await request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: p }] });
      log('prompt done:', JSON.stringify(r).slice(0, 300));
    }
  } else if (mode === 'cancel') {
    const s = await request('session/new', { cwd: WORK_DIR, mcpServers: [] });
    log('sessionId =', s.sessionId);
    const p = request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Count from 1 to 500, one number per line.' }] });
    await new Promise(r => setTimeout(r, 1500));
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: s.sessionId } });
    log('cancel sent');
    try { const r = await p; log('prompt result after cancel:', JSON.stringify(r).slice(0, 300)); }
    catch (e) { log('prompt rejected after cancel:', e.message); }
  } else if (mode === 'config') {
    const s = await request('session/new', { cwd: WORK_DIR, mcpServers: [] });
    log('sessionId =', s.sessionId);
    for (const [configId, value] of [['model', 'adaptive']]) {
      try {
        const r = await request('session/set_config_option', { sessionId: s.sessionId, configId, value });
        log(`set_config_option ${configId}=${value}:`, JSON.stringify(r).slice(0, 400));
      } catch (e) { log(`set_config_option ${configId}=${value} failed:`, e.message); }
    }
  } else if (mode === 'list') {
    try {
      const l = await request('session/list', {});
      log('session/list:', JSON.stringify(l).slice(0, 3000));
    } catch (e) { log('session/list failed:', e.message); }
  } else if (mode === 'load') {
    const sid = process.argv[3] ?? process.env.DEVIN_SESSION_ID;
    if (!sid) {
      log('load mode needs a session id: node test/devin-acp.probe.mjs load <sessionId> (or DEVIN_SESSION_ID=...)');
    } else {
      try {
        const l = await request('session/load', { sessionId: sid, cwd: WORK_DIR, mcpServers: [] });
        log('session/load:', JSON.stringify(l).slice(0, 1500));
        const r = await request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'What did I ask you to reply earlier? Answer in one word.' }] });
        log('follow-up:', JSON.stringify(r).slice(0, 300));
      } catch (e) { log('session/load failed:', e.message); }
    }
  } else {
    await runSession(process.argv[3] ?? 'Reply with exactly: PONG', 'S');
  }
} catch (e) {
  console.error('PROBE FAILED:', e);
} finally {
  child?.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
