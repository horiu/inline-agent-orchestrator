// In-memory stand-in for `codex app-server`, shaped after the published
// protocol (codex-rs/app-server-protocol/schema/typescript). It records every
// request so tests can check exactly what was sent.

export class FakeAppServer {
  constructor() {
    this.calls = [];
    this.threads = new Map();
    this.turns = new Map(); // threadId -> Turn[]
    this.reportServers = new Map();
    this.managerServers = new Set();
    this.ignoreResumeConfig = false;
    this.rateLimits = {
      ordinaryUsageAllowed: true,
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
      rateLimitsByLimitId: null,
    };
    this.unsupported = new Set();
    this.seq = 0;
    this.emit = () => {};
  }

  addThread(id, { status = { type: 'idle' }, name = null, turns = [] } = {}) {
    this.managerServers.add(id);
    this.threads.set(id, { id, name, status, cwd: '/work', model: 'm', reasoningEffort: null, updatedAt: 100, preview: 'hello', source: 'cli' });
    this.turns.set(id, turns);
  }

  connector() {
    return async (onMessage, onClose) => {
      this.emit = (msg) => onMessage(JSON.stringify(msg));
      this.close = onClose;
      return {
        send: (text) => {
          const msg = JSON.parse(text);
          if (msg.id === undefined) {
            this.calls.push({ method: msg.method, params: msg.params, notification: true });
            return;
          }
          queueMicrotask(() => this.#handle(msg));
        },
        close: () => onClose(''),
      };
    };
  }

  #reply(id, result) {
    this.emit({ id, result });
  }

  #fail(id, code, message) {
    this.emit({ id, error: { code, message } });
  }

  #handle({ id, method, params }) {
    this.calls.push({ method, params });
    if (this.unsupported.has(method)) return this.#fail(id, -32601, `unknown variant \`${method}\``);
    const t = params?.threadId ? this.threads.get(params.threadId) : null;
    switch (method) {
      case 'initialize':
        return this.#reply(id, { userAgent: 'fake' });
      case 'thread/read':
        if (!t) return this.#fail(id, -32600, 'thread not found');
        return this.#reply(id, { thread: { ...t, turns: params.includeTurns ? this.turns.get(t.id) : [] } });
      case 'thread/list':
        return this.#reply(id, { data: [...this.threads.values()], nextCursor: null, backwardsCursor: null });
      case 'thread/start': {
        const newId = `thr_${++this.seq}`;
        this.addThread(newId, { status: { type: 'idle' } });
        if (params.config?.['mcp_servers.session-report']) this.reportServers.set(newId, params.config['mcp_servers.session-report']);
        if (params.config?.['mcp_servers.session-manager.enabled'] === false) this.managerServers.delete(newId);
        return this.#reply(id, { thread: this.threads.get(newId), model: params.model ?? 'default-model' });
      }
      case 'thread/name/set':
        t.name = params.name;
        return this.#reply(id, {});
      case 'thread/resume':
        // Real Codex rejoins loaded threads without applying config overrides.
        if (t.status.type === 'notLoaded' && !this.ignoreResumeConfig && params.config?.['mcp_servers.session-report']) {
          this.reportServers.set(t.id, params.config['mcp_servers.session-report']);
          if (params.config['mcp_servers.session-manager.enabled'] === false) this.managerServers.delete(t.id);
        }
        t.status = { type: 'idle', activeFlags: [] };
        return this.#reply(id, { thread: t });
      case 'mcpServerStatus/list': {
        const data = [];
        if (this.reportServers.has(params.threadId)) data.push({ name: 'session-report', tools: { report: {} } });
        if (this.managerServers.has(params.threadId)) data.push({ name: 'session-manager', tools: { start_session: {} } });
        return this.#reply(id, { data: data.filter(s => !params.serverName || s.name === params.serverName), nextCursor: null });
      }
      case 'turn/start': {
        const turn = { id: `turn_${++this.seq}`, status: 'inProgress', items: [], error: null };
        this.turns.get(t.id).push(turn);
        t.status = { type: 'active', activeFlags: [] };
        return this.#reply(id, { turn });
      }
      case 'thread/turns/list': {
        const list = (this.turns.get(t.id) ?? []).slice().reverse().slice(0, params.limit ?? 10);
        return this.#reply(id, { data: list, nextCursor: null, backwardsCursor: null });
      }
      case 'thread/queue/add':
        return this.#reply(id, { queuedSubmission: { id: 'q_1' } });
      case 'turn/steer':
        return this.#reply(id, { turnId: params.expectedTurnId });
      case 'turn/interrupt': {
        const turn = this.turns.get(t.id).find((x) => x.id === params.turnId);
        if (turn) turn.status = 'interrupted';
        t.status = { type: 'idle' };
        return this.#reply(id, {});
      }
      case 'account/rateLimits/read':
        return this.#reply(id, this.rateLimits);
      default:
        return this.#fail(id, -32601, `Method not found: ${method}`);
    }
  }
}
