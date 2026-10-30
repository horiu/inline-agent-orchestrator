// In-memory stand-in for `devin acp`, shaped after the ACP protocol observed
// on the wire (initialize -> authenticate -> session/*). It records every
// request so tests can check exactly what was sent, and can hold a
// session/prompt response until the test says so.

export class FakeDevin {
  constructor() {
    this.calls = [];
    this.sessions = new Map(); // id -> {title, cwd, mode, model, effort, mcpServers}
    this.seq = 0;
    this.emit = () => {};
    this.close = () => {};
    this.holdPrompts = false;
    this.held = new Map(); // sessionId -> resolve[] for every in-flight prompt
    this.nextServerId = 900;
    this.permissionReplies = [];
    this.authMethods = [{ id: 'devin-browser', name: 'Devin browser' }];
  }

  addSession(id, { title = 'session', cwd = '/work', locked = false } = {}) {
    this.sessions.set(id, { title, cwd, mode: null, model: null, effort: null, mcpServers: [], locked });
  }

  connector() {
    return async (onMessage, onClose) => {
      this.emit = (msg) => onMessage(JSON.stringify(msg));
      this.close = onClose;
      return {
        send: (text) => {
          const msg = JSON.parse(text);
          // Client's answer to a server-initiated request.
          if (msg.id !== undefined && msg.method === undefined) {
            this.permissionReplies.push(msg);
            return;
          }
          if (msg.id === undefined) {
            this.calls.push({ method: msg.method, params: msg.params, notification: true });
            if (msg.method === 'session/cancel') this.#cancel(msg.params?.sessionId);
            return;
          }
          queueMicrotask(() => this.#handle(msg));
        },
        close: () => onClose('closed'),
      };
    };
  }

  // Every held session/prompt for this session resolves with this stopReason.
  complete(sessionId, stopReason = 'end_turn') {
    for (const r of this.held.get(sessionId) ?? []) r(stopReason);
    this.held.delete(sessionId);
  }

  // Only the most recently sent held prompt resolves (the rest stay held).
  completeLast(sessionId, stopReason = 'end_turn') {
    const arr = this.held.get(sessionId) ?? [];
    arr.pop()?.(stopReason);
    if (!arr.length) this.held.delete(sessionId);
  }

  // Ask the client for a permission decision (a server-initiated request).
  askPermission(sessionId, options) {
    this.emit({
      jsonrpc: '2.0',
      id: this.nextServerId++,
      method: 'session/request_permission',
      params: { sessionId, toolCall: { title: 'run command' }, options },
    });
  }

  update(sessionId, update) {
    this.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }

  #cancel(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.complete(sessionId, 'cancelled');
  }

  #reply(id, result) {
    this.emit({ jsonrpc: '2.0', id, result });
  }

  #fail(id, code, message) {
    this.emit({ jsonrpc: '2.0', id, error: { code, message } });
  }

  #handle({ id, method, params }) {
    this.calls.push({ method, params });
    const sid = params?.sessionId;
    const s = sid ? this.sessions.get(sid) : null;
    switch (method) {
      case 'initialize':
        return this.#reply(id, {
          protocolVersion: 1,
          authMethods: this.authMethods,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, embeddedContext: false } },
        });
      case 'authenticate':
        return this.#reply(id, {});
      case 'session/new': {
        const newId = `dev_${++this.seq}`;
        this.sessions.set(newId, { title: null, cwd: params.cwd, mode: null, model: null, effort: null, mcpServers: params.mcpServers ?? [] });
        return this.#reply(id, {
          sessionId: newId,
          cwd: params.cwd,
          configOptions: [
            { id: 'mode', category: 'mode', currentValue: 'smart' },
            { id: 'model', category: 'model', currentValue: 'adaptive' },
          ],
        });
      }
      case 'session/load':
        if (!s) return this.#fail(id, -32000, 'session not found');
        queueMicrotask(() => {
          this.update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier ask' } });
          this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } });
        });
        return this.#reply(id, { sessionId: sid, title: s.title, cwd: s.cwd, configOptions: [{ id: 'model', category: 'model' }] });
      case 'session/list':
        return this.#reply(id, {
          sessions: [...this.sessions.entries()].map(([sessionId, t]) => ({
            sessionId,
            title: t.title,
            cwd: t.cwd,
            updatedAt: '2026-01-01T00:00:00Z',
            _meta: { 'cognition.ai/isLocked': t.locked ?? false },
          })),
          nextCursor: null,
        });
      case 'session/prompt': {
        if (!s) return this.#fail(id, -32000, 'session not found');
        if (this.holdPrompts) {
          const arr = this.held.get(sid) ?? [];
          new Promise((resolve) => arr.push(resolve)).then((stopReason) => this.#reply(id, { stopReason }));
          this.held.set(sid, arr);
          return;
        }
        queueMicrotask(() => {
          this.update(sid, { sessionUpdate: 'session_info_update', statusEnum: 'working' });
          this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'doing it' } });
          this.update(sid, { sessionUpdate: 'session_info_update', statusEnum: 'blocked' });
          this.#reply(id, { stopReason: 'end_turn' });
        });
        return;
      }
      case 'session/set_mode':
        if (!s) return this.#fail(id, -32000, 'session not found');
        s.mode = params.modeId;
        return this.#reply(id, {});
      case 'session/set_config_option':
        if (!s) return this.#fail(id, -32000, 'session not found');
        if (params.configId === 'model') s.model = params.value;
        if (/effort|reasoning/i.test(params.configId)) s.effort = params.value;
        return this.#reply(id, {});
      default:
        return this.#fail(id, -32601, `Method not found: ${method}`);
    }
  }
}
