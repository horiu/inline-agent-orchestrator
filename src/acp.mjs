// Client for `devin acp` — an ACP (Agent Client Protocol) server over stdio.
// Speaks newline-delimited JSON-RPC 2.0: the agent answers our requests
// (session/new, session/prompt, ...), pushes notifications (session/update,
// vendor notices), and sends requests it expects us to answer
// (session/request_permission, fs/*, terminal/*).
//
// The transport is pluggable: spawn `devin acp` via stdioConnector, or give
// any connector(onMessage, onClose) -> { send, close } (tests use this).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const PROTOCOL_VERSION = 1;
const INIT_TIMEOUT_MS = 60_000;
// Authentication may hand off to a browser sign-in; give it room.
const AUTH_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 120_000;
// A failed connect is not retried on every request.
const RETRY_AFTER_MS = 10_000;

// `devin` on PATH, else the location the Devin desktop app installs its
// bundled CLI to (Windows only). Override with config devin.path / DEVIN_PATH.
export function resolveDevinPath(env = process.env) {
  if (env.DEVIN_PATH) return env.DEVIN_PATH;
  if (process.platform === 'win32') {
    const app = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const bundled = join(app, 'Programs', 'Devin', 'resources', 'app', 'extensions', 'windsurf', 'devin', 'bin', 'devin.exe');
    if (existsSync(bundled)) return bundled;
  }
  return 'devin';
}

export function stdioConnector(devinPath, { env = process.env } = {}) {
  return (onMessage, onClose) =>
    new Promise((resolve, reject) => {
      const needShell = process.platform === 'win32' && !/\.exe$/i.test(devinPath);
      // With a shell the command line is joined unquoted, so quote a path with spaces.
      const command = needShell && /\s/.test(devinPath) && !/^".*"$/.test(devinPath) ? `"${devinPath}"` : devinPath;
      const child = spawn(command, ['acp'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: needShell,
        windowsHide: true,
      });
      // Writes after the child exits must not crash this server.
      child.stdin.on('error', () => {});
      let stderr = '';
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      let opened = false;
      let reported = false;
      const gone = (reason) => {
        if (!opened || reported) return;
        reported = true;
        const tail = stderr.trim();
        onClose(tail ? `${reason}: ${tail}` : reason);
      };
      child.on('error', (err) => {
        // After 'spawn' an 'error' (e.g. a failed kill) is not a death;
        // 'exit'/'close' report the real end.
        if (!opened) reject(new Error(`devin acp を起動できませんでした（${devinPath}）: ${err.message}`));
      });
      // A failed spawn reports 'close' without 'exit'.
      child.on('exit', (code, signal) => gone(`devin acp が終了しました（code ${code} signal ${signal ?? ''}）`));
      child.on('close', () => gone('devin acp が終了しました'));
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.trim()) onMessage(line);
      });
      // Resolving before 'spawn' would hand out a dead pipe on ENOENT.
      child.once('spawn', () => {
        opened = true;
        resolve({
          send: (text) => child.stdin.write(text + '\n'),
          close: () => {
            try {
              child.kill();
            } catch {
              // already gone
            }
          },
        });
      });
    });
}

// Client capabilities we advertise: the agent does its own file and terminal
// work, gated by the session mode (session/set_mode). We only answer
// permission requests.
const CLIENT_CAPS = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

export class AcpClient {
  // permissionHandler(params) -> optionId | 'cancel'
  constructor({ devinPath, connector, permissionHandler, authMethod = null, env = process.env, retryAfterMs = RETRY_AFTER_MS } = {}) {
    this.devinPath = devinPath ?? resolveDevinPath(env);
    this.connector = connector ?? stdioConnector(this.devinPath, { env });
    this.permissionHandler = permissionHandler ?? (() => 'allow_once');
    this.authMethod = authMethod;
    this.retryAfterMs = retryAfterMs;
    this.io = null;
    this.gen = 0; // connection generation; late events from old connections are ignored
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, method, timer}
    this.listeners = new Set();
    this.ready = null;
    this.lastError = null;
    this.lastErrorAt = 0;
    this.authenticated = false;
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(msg) {
    for (const fn of this.listeners) {
      try {
        fn(msg);
      } catch {
        // A listener must not break the read loop.
      }
    }
  }

  #failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  #dead(reason) {
    this.lastError = reason instanceof Error ? reason : new Error(String(reason));
    this.lastErrorAt = Date.now();
    this.authenticated = false;
    this.#failAll(this.lastError);
    this.#emit({ method: '_client/closed', params: { reason: this.lastError.message } });
  }

  #write(msg) {
    if (!this.io) throw new Error('devin acp は動いていません');
    this.io.send(JSON.stringify(msg));
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // A response to one of our requests. Some agents answer with the id as
    // a string, so fall back to a numeric key.
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const key = this.pending.has(msg.id) ? msg.id : Number(msg.id);
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(`${p.method}: ${msg.error.message ?? 'RPC error'}`, msg.error.code));
      else p.resolve(msg.result);
      return;
    }
    // A request from the agent (has both id and method): must be answered.
    if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) {
      this.#emit(msg);
      this.#answerServerRequest(msg).catch(() => {});
      return;
    }
    this.#emit(msg); // a notification
  }

  async #answerServerRequest(msg) {
    const reply = (result) => this.#write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => this.#write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    try {
      if (msg.method === 'session/request_permission') {
        const choice = await this.permissionHandler(msg.params ?? {});
        if (choice === 'cancel' || choice == null) reply({ outcome: { outcome: 'cancelled' } });
        else reply({ outcome: { outcome: 'selected', optionId: choice } });
        return;
      }
      fail(-32601, `unsupported client request: ${msg.method}`);
    } catch (err) {
      try {
        fail(-32603, err.message ?? 'internal error');
      } catch {
        // The connection is gone; there is nothing left to answer on.
      }
    }
  }

  #call(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: 応答がありません（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return this.#ready().then(() => this.#call(method, params, timeoutMs));
  }

  notify(method, params = {}) {
    return this.#ready().then(() => this.#write({ jsonrpc: '2.0', method, params }));
  }

  #ready() {
    if (this.io && this.authenticated) return Promise.resolve();
    if (this.lastError && Date.now() - this.lastErrorAt < this.retryAfterMs) return Promise.reject(this.lastError);
    if (!this.ready) this.ready = this.#connect();
    return this.ready;
  }

  async #connect() {
    const gen = ++this.gen;
    let io;
    try {
      io = await this.connector(
        (line) => {
          if (gen === this.gen && this.io === io) this.#onLine(line);
        },
        (reason) => {
          // A stale connection's close must not null out the current one.
          if (gen !== this.gen || this.io !== io) return;
          this.io = null;
          this.#dead(reason);
        },
      );
    } catch (err) {
      this.#dead(err);
      throw this.lastError;
    }
    if (gen !== this.gen) {
      // close() ran while the connector was still resolving.
      try {
        io.close();
      } catch {
        // already gone
      }
      throw this.lastError ?? new Error('devin acp を閉じました');
    }
    this.io = io;
    try {
      const init = await this.#call(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPS,
          clientInfo: { name: 'inline_agent_orchestrator', version: '0' },
        },
        INIT_TIMEOUT_MS,
      );
      this.serverCaps = init;
      const methods = init?.authMethods ?? [];
      if (methods.length && !this.authenticated) {
        const offered = methods[0];
        const methodId =
          this.authMethod ?? (typeof offered === 'string' ? offered : (offered?.id ?? offered?.methodId)) ?? 'devin-browser';
        await this.#call('authenticate', { methodId }, AUTH_TIMEOUT_MS).catch((err) => {
          // Already-authenticated agents may reject the call; anything else is fatal.
          if (err instanceof RpcError && /already|logged/i.test(err.message)) return;
          throw err;
        });
      }
      this.authenticated = true;
    } catch (err) {
      // A failure that came in through onClose already nulled this.io and
      // reported #dead; only tear down what is still ours. Either way the
      // transport must not leak (a retry would spawn a second `devin acp`).
      if (this.io === io) {
        this.io = null;
        if (gen === this.gen) this.gen++;
        try {
          io.close();
        } catch {
          // already gone
        }
        this.#dead(err);
      }
      throw this.lastError;
    } finally {
      this.ready = null;
    }
  }

  close() {
    const io = this.io;
    this.io = null;
    // Invalidate the io's callbacks before closing, so a synchronous onClose
    // does not report the death a second time.
    this.gen++;
    try {
      io?.close();
    } catch {
      // already gone
    }
    this.#dead(new Error('devin acp を閉じました'));
  }
}
