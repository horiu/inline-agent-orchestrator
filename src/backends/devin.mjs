// Devin backend: worker sessions live inside a `devin acp` child process
// (Agent Client Protocol over stdio, see src/acp.mjs). Sessions persist in
// Devin's own store, so they survive this process restarting and are picked
// up again with session/load.
//
// Lifecycle: session/new -> session/set_mode -> session/set_config_option
// (model/effort) -> session/prompt. A session/prompt request resolves when
// the turn ends, so it is fired without blocking and its settlement doubles
// as turn/completed for the watch loop.
//
// Session modes (session/set_mode): bypass | smart | accept-edits | ask | plan.
// defaults.approvalPolicy is mapped: never/on-failure -> smart,
// on-request -> accept-edits, untrusted -> ask. Config devin.mode overrides.
// Permission prompts that still arrive are answered with devin.permission
// (default allow_once); org-required denials stay denied.
//
// send_message: an idle or not-loaded session is loaded (session/load) then
// prompted. An active session queues the message on the record (delivered by
// tick), except mode="steer"/"start" which is sent mid-turn (Devin accepts
// mid-turn prompts).

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tail, ToolError } from './common.mjs';
import { RpcError } from '../acp.mjs';

const MSGS = {
  list: 'session/list',
  new: 'session/new',
  load: 'session/load',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  setMode: 'session/set_mode',
  setOption: 'session/set_config_option',
};

const SERVER_PATH = fileURLToPath(new URL('../server.mjs', import.meta.url));
const MODE_FOR_POLICY = { never: 'smart', 'on-failure': 'smart', 'on-request': 'accept-edits', untrusted: 'ask' };
// Records (state.json) a queued batch may be delivered to: the session's own
// record stays `running`/`waiting_user` while a live turn runs, so those are
// the ones tick looks at — the live status is checked separately inside.
const DELIVER_TO = new Set(['running', 'waiting_user']);
const textPrompt = (text) => [{ type: 'text', text }];
const nowIso = () => new Date().toISOString();

// The stdio MCP server that gives a worker the `report` tool (ACP stdio
// shape: name/command/args plus env as a list of {name, value}).
function reportServers(storeDir) {
  return [
    {
      name: 'session-report',
      command: process.execPath,
      args: [SERVER_PATH],
      env: [
        { name: 'CSM_ROLE', value: 'worker' },
        { name: 'CSM_AGENT', value: 'devin' },
        { name: 'CSM_HOME', value: storeDir },
      ],
    },
  ];
}

function pickOptionId(options, want) {
  const ids = (Array.isArray(options) ? options : []).map((o) => (typeof o === 'string' ? o : (o?.optionId ?? o?.id))).filter(Boolean);
  if (want && ids.includes(want)) return want;
  // A configured denial must not silently become an allow.
  if (/^reject|^deny/i.test(want ?? '')) return ids.find((id) => /^reject|^deny/i.test(id)) ?? 'cancel';
  const allow = ids.find((id) => /^allow/.test(id) && !/always|bypass|mode|switch/i.test(id)) ?? ids.find((id) => /^allow/.test(id));
  return allow ?? ids.find((id) => /^reject|deny/i.test(id)) ?? 'cancel';
}

// Session timestamps arrive as unix seconds, milliseconds, ISO strings or
// numeric strings depending on the agent; normalize them all to ISO.
const normTime = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() && Number.isFinite(n)) return normTime(n);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
};
const timeOf = (v) => {
  const t = normTime(v);
  return t ? Date.parse(t) : 0;
};

// Locate a set_config_option option by matching its id or category.
function findConfigOption(configOptions, re) {
  for (const o of configOptions ?? []) {
    const id = o?.id ?? o?.configId ?? '';
    if (re.test(id) || re.test(o?.category ?? '')) return id || null;
  }
  return null;
}

export function devinBackend({ client, store, mode = null, permission = 'allow_once' }) {
  const listeners = new Set();
  const live = new Map(); // sessionId -> {loaded, status, activeFlags, preview, title, cwd, locked, configOptions, promptError}
  const pendingPrompts = new Map(); // sessionId -> token of the in-flight tracked session/prompt
  const replay = new Map(); // sessionId -> Set<update[]> capturing the session/load replay
  const loading = new Map(); // sessionId -> in-flight session/load promise
  let ticking = false;

  const entry = (sid) => {
    if (!live.has(sid))
      live.set(sid, { loaded: false, status: 'idle', activeFlags: [], preview: '', title: null, cwd: null, locked: false, configOptions: [], promptError: null });
    return live.get(sid);
  };
  const emit = (msg) => {
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch {
        // A listener must not break the update loop.
      }
    }
  };
  const emitTurnCompleted = (sid, status, error = null) =>
    emit({ method: 'turn/completed', params: { threadId: sid, turn: { status, ...(error ? { error } : {}) } } });
  const addCapture = (sid, arr) => {
    let set = replay.get(sid);
    if (!set) replay.set(sid, (set = new Set()));
    set.add(arr);
  };
  const dropCapture = (sid, arr) => {
    const set = replay.get(sid);
    if (!set) return;
    set.delete(arr);
    if (!set.size) replay.delete(sid);
  };

  // Reduce ACP session/update notifications into the live map.
  function onUpdate(sid, update = {}) {
    const e = entry(sid);
    const kind = update.sessionUpdate;
    if (update.title) e.title = update.title;
    if (update._meta?.['cognition.ai/title']) e.title = update._meta['cognition.ai/title'];
    switch (kind) {
      case 'user_message_chunk':
        break;
      case 'agent_message_chunk': {
        const text = update.content?.text ?? '';
        if (text) e.preview = tail(`${e.preview}${text}`, 240);
        break;
      }
      case 'session_info_update': {
        const se = update.statusEnum ?? update._meta?.['cognition.ai/statusEnum'];
        if (se === 'working') e.status = 'active';
        else if (se === 'blocked' || se === 'idle') e.status = 'idle';
        if (update.userActionRequired ?? update._meta?.['cognition.ai/userActionRequired'])
          e.activeFlags = [...new Set([...e.activeFlags, 'waitingOnUserInput'])];
        else e.activeFlags = e.activeFlags.filter((f) => f !== 'waitingOnUserInput');
        break;
      }
      case 'tool_call': {
        const title = update.title ?? update.kind ?? 'tool';
        e.preview = `⚙ ${tail(title, 200)}`;
        break;
      }
      case 'usage_update':
        e.usage = update;
        break;
      case 'agent_stopped':
        // Only a turn seen running reports its end (a stopped or finished
        // turn already did); a tracked prompt's settlement reports instead.
        if (e.status === 'active' && !pendingPrompts.has(sid)) emitTurnCompleted(sid, 'completed');
        e.status = 'idle';
        break;
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) e.configOptions = update.configOptions;
        break;
      default:
        break;
    }
  }

  client.onEvent((msg) => {
    if (msg.method === 'session/update') {
      const sid = msg.params?.sessionId;
      if (!sid) return;
      const update = msg.params.update ?? msg.params;
      for (const b of replay.get(sid) ?? []) b.push(update);
      const e = entry(sid);
      (e.transcript ??= []).push(update);
      if (e.transcript.length > 2000) e.transcript.splice(0, e.transcript.length - 2000);
      onUpdate(sid, update);
      return;
    }
    if (msg.method === 'session/request_permission') {
      // Surface as an attention request in wait_events; the client answers it.
      emit({ id: msg.id, method: msg.method, params: { ...(msg.params ?? {}), threadId: msg.params?.sessionId } });
      return;
    }
    const m = msg.method ?? '';
    if (/agent_?stopped/i.test(m)) {
      const sid = msg.params?.sessionId ?? msg.params?.session_id;
      const e = sid ? live.get(sid) : null;
      if (e && e.status === 'active' && !pendingPrompts.has(sid)) {
        e.status = 'idle';
        emitTurnCompleted(sid, 'completed');
      }
      return;
    }
    if (m === '_client/closed') {
      const reason = msg.params?.reason ?? 'devin acp stopped';
      for (const [sid, e] of live) {
        // A prompt may still be in flight while an update marked the session
        // idle (e.g. "blocked"); it counts as active here.
        if (e.status === 'active' || pendingPrompts.has(sid)) {
          e.status = 'idle';
          emitTurnCompleted(sid, 'failed', reason);
        }
        e.loaded = false;
        // State gathered from the dead process is stale: the next
        // session/load replays the transcript again, and a leftover
        // promptError/waiting flag would misreport the session.
        e.transcript = [];
        e.promptError = null;
        e.activeFlags = [];
      }
      // Clearing after the emit also detaches the in-flight prompts: their
      // rejection lands a tick later and must not emit "failed" a second time.
      pendingPrompts.clear();
    }
  });

  client.permissionHandler = (params = {}) => pickOptionId(params.options, permission);

  // One session/load per session at a time: a racing caller awaits the same
  // request instead of replaying the transcript twice. `worker` attaches the
  // report MCP server — only for sessions this orchestrator started.
  async function loadSession(sid, cwd, capture, worker = false) {
    const e = entry(sid);
    if (e.loaded) return;
    if (capture) addCapture(sid, capture);
    if (!loading.has(sid)) {
      const run = client
        .request(MSGS.load, {
          sessionId: sid,
          cwd: cwd ?? e.cwd ?? process.cwd(),
          mcpServers: worker ? reportServers(store.dir) : [],
        })
        .then((res) => {
          e.loaded = true;
          if (res?.title) e.title = res.title;
          if (res?.cwd) e.cwd = res.cwd;
          if (res?.configOptions) e.configOptions = res.configOptions;
        })
        .finally(() => loading.delete(sid));
      loading.set(sid, run);
    }
    await loading.get(sid);
  }

  // `e.locked` mirrors the `isLocked` of session/list. A lock seen once must
  // not pin a session forever after the holding process went away, so callers
  // that act on the flag re-verify it here (throttled, one list at a time).
  let lastLockCheck = 0;
  async function refreshLocks({ force = false } = {}) {
    if (!force && Date.now() - lastLockCheck < 30_000) return;
    const res = await client.request(MSGS.list, {});
    lastLockCheck = Date.now();
    for (const s of res?.sessions ?? res?.data ?? []) {
      const sid = s.sessionId ?? s.id;
      if (sid) entry(sid).locked = !!(s._meta?.['cognition.ai/isLocked'] ?? s.isLocked);
    }
  }

  // Fire session/prompt without waiting for the turn to finish; settling of
  // the request is the turn's completion signal. `force` sends even while a
  // prompt is in flight (mid-turn message); such a steered prompt (track:false)
  // settles silently — the tracked prompt still reports the turn's end.
  function firePrompt(sid, text, { force = false, track = true } = {}) {
    if (!force && pendingPrompts.has(sid)) return false;
    const token = track ? {} : null;
    if (track) pendingPrompts.set(sid, token);
    const e = entry(sid);
    e.status = 'active';
    e.promptError = null;
    client
      .request(MSGS.prompt, { sessionId: sid, prompt: textPrompt(text) }, { timeoutMs: 24 * 60 * 60 * 1000 })
      .then((res) => {
        // A prompt detached by stop()/_client/closed or replaced by a newer
        // one must not flip the status or emit a second turn/completed.
        if (!track || pendingPrompts.get(sid) !== token) return;
        pendingPrompts.delete(sid);
        e.status = 'idle';
        const reason = res?.stopReason ?? 'end_turn';
        const ok = reason === 'end_turn' || reason === 'cancelled';
        emitTurnCompleted(sid, reason === 'end_turn' ? 'completed' : reason === 'cancelled' ? 'interrupted' : 'failed', ok ? null : reason);
      })
      .catch((err) => {
        if (!track || pendingPrompts.get(sid) !== token) return;
        pendingPrompts.delete(sid);
        e.status = 'idle';
        e.promptError = err.message;
        emitTurnCompleted(sid, 'failed', err.message);
      });
    return true;
  }

  function liveStatus(sid) {
    const e = live.get(sid);
    if (!e) return { status: 'notLoaded', activeFlags: [] };
    if (e.locked) return { status: 'active', activeFlags: ['lockedElsewhere'] };
    if (pendingPrompts.has(sid) || e.status === 'active') return { status: 'active', activeFlags: e.activeFlags };
    if (!e.loaded) return { status: 'notLoaded', activeFlags: [] };
    if (e.promptError) return { status: 'systemError', activeFlags: e.activeFlags };
    return { status: 'idle', activeFlags: e.activeFlags };
  }

  const summarize = (sid, target, { name = null, cwd = null, updatedAt = null } = {}) => {
    const e = live.get(sid);
    const st = liveStatus(sid);
    return {
      threadId: sid,
      name: target?.name ?? e?.title ?? name,
      status: st.status,
      activeFlags: st.activeFlags,
      cwd: e?.cwd ?? cwd ?? target?.cwd ?? null,
      model: target?.model ?? null,
      effort: target?.effort ?? null,
      updatedAt: normTime(updatedAt),
      preview: e?.preview ? e.preview.slice(0, 120) : null,
      source: 'acp',
      managed: target ? { status: target.status, note: target.note ?? null, area: target.area ?? null } : null,
    };
  };

  async function setModelAndEffort(sid, model, effort, configOptions) {
    if (!model && !effort) return;
    const options = configOptions ?? entry(sid).configOptions;
    if (model) {
      const id = findConfigOption(options, /model/i) ?? 'model';
      await client.request(MSGS.setOption, { sessionId: sid, configId: id, value: model });
    }
    if (effort) {
      const id = findConfigOption(options, /effort|reasoning/i);
      if (id) await client.request(MSGS.setOption, { sessionId: sid, configId: id, value: effort });
    }
  }

  // ACP has no standardized rename; try the names agents have used.
  async function renameSession(sid, name) {
    for (const method of ['session/rename', 'session/set_name', '_cognition.ai/session/rename']) {
      try {
        await client.request(method, { sessionId: sid, title: name, name });
        entry(sid).title = name;
        return true;
      } catch (err) {
        if (!(err instanceof RpcError) || err.code !== -32601) throw err;
      }
    }
    return false;
  }

  return {
    agent: 'devin',
    // Devin lets the first message carry the session id (known after session/new).
    firstMessageHasId: true,
    openCommand: (id) => `devin -r ${id}`,

    onEvent: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async status(id) {
      return liveStatus(id);
    },

    async describe(id, target) {
      return summarize(id, target);
    },

    async listAll({ cwd, limit }, targets) {
      const rows = [];
      let cursor = null;
      // Follow nextCursor so a long session list is not cut at the first page.
      for (let pages = 0; pages < 25; pages++) {
        const res = await client.request(MSGS.list, cursor ? { cursor } : {});
        for (const s of res?.sessions ?? res?.data ?? []) {
          const sid = s.sessionId ?? s.id;
          if (!sid) continue;
          const e = entry(sid);
          e.locked = !!(s._meta?.['cognition.ai/isLocked'] ?? s.isLocked);
          if (s.title) e.title = s.title;
          if (s.cwd) e.cwd = s.cwd;
          if (cwd && s.cwd && s.cwd !== cwd) continue;
          rows.push({ s, sid });
        }
        cursor = res?.nextCursor ?? null;
        if (!cursor) break;
      }
      return rows
        .sort((a, b) => timeOf(b.s.updatedAt) - timeOf(a.s.updatedAt))
        .slice(0, limit)
        .map(({ s, sid }) => summarize(sid, targets[sid], { name: s.title, cwd: s.cwd, updatedAt: s.updatedAt }));
    },

    // session/load replays the transcript as session/update notifications,
    // streamed after the response. Every update is also appended to the
    // session's transcript buffer, so read() covers sessions created by
    // session/new too (those are already loaded and produce no replay).
    async read(id, { turns = 6, maxChars = 4000 }, target) {
      const captured = [];
      const needsLoad = !live.get(id)?.loaded;
      addCapture(id, captured);
      try {
        if (needsLoad) await loadSession(id, target?.cwd, captured, target?.devinWorker === true);
        // Wait until the replay quiets down (or a cap, for huge transcripts).
        // Only after our own load: an already-loaded session returns its
        // transcript at once instead of watching live traffic go quiet.
        if (needsLoad) {
          let last = -1;
          let quiet = 0;
          for (let i = 0; i < 100 && quiet < 3; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (captured.length === last) quiet++;
            else {
              last = captured.length;
              quiet = 0;
            }
          }
        }
      } finally {
        dropCapture(id, captured);
      }
      const out = [];
      let current = null;
      for (const u of live.get(id)?.transcript ?? captured) {
        const kind = u?.sessionUpdate;
        const text = u?.content?.text ?? '';
        if (kind === 'user_message_chunk') {
          if (!current || current.agent) {
            current = { user: '', agent: '' };
            out.push(current);
          }
          current.user += text;
        } else if (kind === 'agent_message_chunk') {
          if (!current) {
            current = { user: '', agent: '' };
            out.push(current);
          }
          current.agent += text;
        }
      }
      const per = Math.max(200, Math.floor(maxChars / Math.max(1, out.length) / 2));
      return {
        session: summarize(id, target),
        turns: out.slice(-turns).map((t) => ({ status: 'completed', error: null, user: tail(t.user, per), agent: tail(t.agent, per), questions: [], commands: 0, fileChanges: 0 })),
      };
    },

    async start({ name, cwd, model, effort, approvalPolicy, instructions, firstMessage }, { onCreated }) {
      if (!existsSync(cwd)) throw new ToolError(`作業フォルダがありません: ${cwd}`);
      const res = await client.request(MSGS.new, { cwd, mcpServers: reportServers(store.dir) });
      const sid = res?.sessionId;
      if (!sid) throw new ToolError('session/new が sessionId を返しませんでした');
      const e = entry(sid);
      e.loaded = true;
      e.cwd = res?.cwd ?? cwd;
      e.configOptions = res?.configOptions ?? [];
      onCreated?.(sid, { devinWorker: true });
      const wanted = mode ?? MODE_FOR_POLICY[approvalPolicy ?? 'never'] ?? 'smart';
      // A failed set_mode / set_config_option / rename must not kill the
      // start, but each is reported on its own field.
      let modeError = null;
      await client.request(MSGS.setMode, { sessionId: sid, modeId: wanted }).catch((err) => (modeError = err.message));
      let configError = null;
      await setModelAndEffort(sid, model, effort, e.configOptions).catch((err) => (configError = err.message));
      let nameError = null;
      if (name) {
        try {
          await renameSession(sid, name);
        } catch (err) {
          nameError = err.message;
        }
      }
      const prompt = `${instructions}\n\n${firstMessage(sid)}`;
      if (!firePrompt(sid, prompt)) throw new ToolError('最初の依頼を送れませんでした');
      return { threadId: sid, turnId: null, model: model ?? null, nameError, modeError, configError };
    },

    // change: { model?, effort? } for this turn and the turns after it.
    async send(id, message, mode, target, change = {}) {
      const e = entry(id);
      // A lock reported earlier may be stale (the holder has since exited);
      // verify against a fresh session/list before refusing.
      if (e.locked) await refreshLocks({ force: true }).catch(() => {});
      if (e.locked)
        throw new ToolError('Devin のほかのプロセス（TUI・別の監視プロセス）がこの会話を開いています。そちらを閉じてから再試行してください');
      const status = liveStatus(id).status;
      const how = mode === 'auto' ? (status === 'active' ? 'queue' : 'start') : mode;
      if (how === 'queue') {
        const queue = [...(store.state().targets[id]?.queue ?? []), message];
        store.updateTarget(id, { queue, ...change });
        return { previousStatus: status, delivery: 'queued', queued: queue.length };
      }
      if (!e.loaded) await loadSession(id, target?.cwd, undefined, target?.devinWorker === true);
      await setModelAndEffort(id, change.model ?? null, change.effort ?? null, e.configOptions);
      if (how === 'steer' && status === 'active') {
        // A mid-turn message; the main prompt's settlement still marks the end.
        firePrompt(id, message, { force: true, track: false });
        return { previousStatus: status, delivery: 'steered' };
      }
      if (!firePrompt(id, message)) {
        const queue = [...(store.state().targets[id]?.queue ?? []), message];
        store.updateTarget(id, { queue });
        return { previousStatus: status, delivery: 'queued', queued: queue.length };
      }
      return { previousStatus: status, delivery: 'started' };
    },

    async stop(id) {
      const e = entry(id);
      const wasActive = liveStatus(id).status === 'active';
      // Only an active turn needs the cancel — asking an idle session would
      // spawn `devin acp` just to tell it to stop.
      if (wasActive) await client.notify(MSGS.cancel, { sessionId: id }).catch(() => {});
      // Best-effort: if the agent never settles the prompt, the session must
      // not stay "active" forever. The detached prompt settles silently.
      const detached = pendingPrompts.delete(id);
      e.status = 'idle';
      if (detached) emitTurnCompleted(id, 'interrupted');
      return { interrupted: wasActive, turnId: null };
    },

    async rename(id, name) {
      if (await renameSession(id, name)) return { renamed: true };
      return { renamed: false, note: 'devin には会話名を変える API が無いため、監視役の記録だけ変えました' };
    },

    // ACP exposes per-turn token usage, not account plan windows.
    async usage() {
      return { windows: [], ordinaryUsageAllowed: null };
    },

    // Delivers messages queued while a session was busy, once it is idle.
    // The queue is taken off the record before prompting, so a second round
    // or a new send cannot deliver it twice.
    async tick(targets) {
      if (ticking) return [];
      const waiting = Object.entries(targets).filter(([, t]) => t.queue?.length && DELIVER_TO.has(t.status));
      if (!waiting.length) return [];
      ticking = true;
      try {
        // Pick up locks taken and released by other processes since the
        // last session/list (throttled inside refreshLocks).
        await refreshLocks().catch(() => {});
        const events = [];
        for (const [id, target] of waiting) {
          // Another process (TUI, a second manager) owns this session; send()
          // refuses those, so a queued batch must not go out either.
          if (entry(id).locked) continue;
          if (liveStatus(id).status === 'active') continue;
          if (target.queueFailedAt && Date.now() - Date.parse(target.queueFailedAt) < 5 * 60 * 1000) continue;
          const current = store.state().targets[id] ?? target;
          const batch = current.queue ?? [];
          if (!batch.length || !DELIVER_TO.has(current.status)) continue;
          store.updateTarget(id, { queue: [] });
          try {
            if (!entry(id).loaded) await loadSession(id, current.cwd, undefined, current.devinWorker === true);
            // A model/effort change recorded with the queued message applies at delivery.
            await setModelAndEffort(id, current.model ?? null, current.effort ?? null, entry(id).configOptions);
            if (!firePrompt(id, batch.join('\n\n'))) throw new ToolError('プロンプトを送れませんでした');
            const still = DELIVER_TO.has(store.state().targets[id]?.status);
            store.updateTarget(id, { queueFailedAt: null, ...(still ? { status: 'running' } : {}), lastSeen: { status: 'active', activeFlags: [] } });
            events.push({ type: 'queuedDelivered', threadId: id, name: target.name, count: batch.length });
          } catch (err) {
            const now_ = store.state().targets[id];
            const restore = DELIVER_TO.has(now_?.status) ? [...batch, ...(now_?.queue ?? [])] : (now_?.queue ?? []);
            store.updateTarget(id, { queue: restore, queueFailedAt: nowIso() });
            events.push({ type: 'queuedFailed', threadId: id, name: target.name, error: err.message });
          }
        }
        return events;
      } finally {
        ticking = false;
      }
    },
  };
}
