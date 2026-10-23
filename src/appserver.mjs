// JSON-RPC client for `codex app-server`.
//
// Wire format (official docs, learn.chatgpt.com/docs/app-server): JSON-RPC 2.0
// messages with the "jsonrpc" field omitted. stdio uses one JSON object per
// line; the daemon's control socket uses one message per WebSocket text frame.
//
// Two ways to reach an app-server:
//   daemon   — `codex app-server daemon start`, then `codex app-server proxy`
//              (stdio <-> control socket) with WebSocket framing. Threads live
//              in the shared daemon, so they keep running when this process
//              exits, and `codex agents` / `codex resume` (TUI) see them.
//   embedded — `codex app-server` over stdio. Threads live in that child
//              process and stop when this MCP server stops. For testing only.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocketOverStream } from './ws.mjs';

const CLIENT_INFO = { name: 'inline_agent_orchestrator', title: 'Inline Agent Orchestrator', version: '0.9.2' };

// codexPath: "codex", an absolute path, or an argv prefix such as
// ["node", "/path/to/codex.js"].
function spawnCodex(codexPath, args) {
  const [cmd, ...prefix] = Array.isArray(codexPath) ? codexPath : [codexPath];
  // A bare `codex` on Windows may be codex.cmd (npm shim), which needs a shell.
  const needsShell = process.platform === 'win32' && !Array.isArray(codexPath) && !/\.exe$/i.test(cmd);
  // With a shell the command line is joined unquoted, so quote a path with spaces.
  const command = needsShell && /\s/.test(cmd) && !/^".*"$/.test(cmd) ? `"${cmd}"` : cmd;
  const child = spawn(command, [...prefix, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: needsShell,
    windowsHide: true,
  });
  // Writes after the child exits must not crash this server.
  child.stdin.on('error', () => {});
  return child;
}

const showCmd = (codexPath) => (Array.isArray(codexPath) ? codexPath.join(' ') : codexPath);

function collect(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Runs `codex app-server daemon start`. On success it writes exactly one JSON
// object to stdout (codex-rs/app-server-daemon/README.md).
export async function ensureDaemon(codexPath) {
  const child = spawnCodex(codexPath, ['app-server', 'daemon', 'start']);
  child.stdin.end();
  const { code, out, err } = await collect(child);
  if (code !== 0) {
    throw new Error(
      `\`${showCmd(codexPath)} app-server daemon start\` failed (exit ${code}): ${(err || out).trim().slice(0, 500)}`,
    );
  }
  try {
    return JSON.parse(out.trim().split('\n').pop());
  } catch {
    return { raw: out.trim() };
  }
}

// Connector contract: connect(onMessage, onClose) -> { send(text), close() }.
export function daemonConnector(codexPath) {
  return async (onMessage, onClose) => {
    await ensureDaemon(codexPath);
    const child = spawnCodex(codexPath, ['app-server', 'proxy']);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    const ws = new WebSocketOverStream({
      readable: child.stdout,
      writable: child.stdin,
      onMessage,
      onClose: () => {
        child.kill();
        onClose(stderr.trim());
      },
    });
    await new Promise((resolve, reject) => {
      const onExit = (code) => reject(new Error(`app-server proxy exited (${code}): ${stderr.trim()}`));
      child.once('exit', onExit);
      child.once('error', reject);
      ws.connect().then(
        () => {
          child.off('exit', onExit);
          child.off('error', reject);
          resolve();
        },
        (err) => {
          child.kill();
          reject(err);
        },
      );
    });
    child.on('exit', () => ws.close());
    return { send: (text) => ws.send(text), close: () => ws.close() };
  };
}

export function embeddedConnector(codexPath) {
  return async (onMessage, onClose) => {
    const child = spawnCodex(codexPath, ['app-server']);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => line.trim() && onMessage(line));
    child.on('exit', () => onClose(stderr.trim()));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.on('error', () => {});
    return {
      send: (text) => child.stdin.write(text + '\n'),
      close: () => child.kill(),
    };
  };
}

export class RpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? JSON.stringify(error)}`);
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class AppServerClient {
  constructor({ connector, requestTimeoutMs = 60000, retryAfterMs = 10000, now = () => Date.now() }) {
    this.connector = connector;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryAfterMs = retryAfterMs;
    this.now = now;
    this.conn = null; // set once initialize has completed
    this.gen = 0; // connection generation; late events from old connections are ignored
    this.connecting = null;
    this.lastFailure = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  // Notification and server-request listener: fn({ method, params, id? }).
  // Server-initiated requests (approvals, user input) carry an id. They are
  // not answered here: the app-server sends them to every client on the
  // thread, so a person who opens it with `codex resume` can answer.
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async ensure() {
    if (this.conn) return;
    if (!this.connecting) {
      // After a failed connect, do not relaunch the daemon/proxy on every
      // request; report the same error until retryAfterMs has passed.
      if (this.lastFailure && this.now() - this.lastFailure.at < this.retryAfterMs) throw this.lastFailure.error;
      this.connecting = this.#open()
        .then(
          () => (this.lastFailure = null),
          (error) => {
            this.lastFailure = { error, at: this.now() };
            throw error;
          },
        )
        .finally(() => (this.connecting = null));
    }
    await this.connecting;
  }

  async #open() {
    const gen = ++this.gen;
    const conn = await this.connector(
      (text) => gen === this.gen && this.#onMessage(text),
      (detail) => gen === this.gen && this.#onClose(detail),
    );
    try {
      // experimentalApi is needed for thread/queue/add (the call `codex queue` uses).
      await this.#send(conn, 'initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      conn.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch (err) {
      if (gen === this.gen) this.gen++;
      conn.close();
      throw err;
    }
    if (gen !== this.gen) {
      conn.close();
      throw new Error('app-server connection closed during initialize');
    }
    this.conn = conn;
  }

  #onClose(detail) {
    const err = new Error(`app-server connection closed${detail ? `: ${detail}` : ''}`);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.conn = null;
    this.gen++;
  }

  #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of this.listeners) {
        try {
          fn(msg);
        } catch {
          // listener errors must not break the connection
        }
      }
    }
  }

  #send(conn, method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        conn.send(JSON.stringify({ method, id, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async request(method, params) {
    await this.ensure();
    return this.#send(this.conn, method, params);
  }

  close() {
    const conn = this.conn;
    this.conn = null;
    this.gen++;
    conn?.close();
  }
}
