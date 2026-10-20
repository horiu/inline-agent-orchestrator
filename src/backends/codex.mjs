// Codex backend: talks to `codex app-server` (JSON-RPC) through AppServerClient.
// Method names and params follow learn.chatgpt.com/docs/app-server and the
// generated types in openai/codex codex-rs/app-server-protocol/schema/typescript.

import { randomUUID } from 'node:crypto';
import { RpcError } from '../appserver.mjs';
import { ToolError, iso, tail, windowLabel } from './common.mjs';

const textInput = (text) => [{ type: 'text', text, text_elements: [] }];

function summarize(t, target) {
  return {
    threadId: t.id,
    name: t.name ?? target?.name ?? null,
    status: t.status?.type ?? 'unknown',
    activeFlags: t.status?.activeFlags ?? [],
    cwd: t.cwd ?? null,
    model: t.model ?? null,
    effort: t.reasoningEffort ?? null,
    updatedAt: iso(t.updatedAt),
    preview: typeof t.preview === 'string' ? t.preview.slice(0, 120) : null,
    source: t.source ?? null,
    managed: target ? { status: target.status, note: target.note ?? null, area: target.area ?? null } : null,
  };
}

function itemText(item) {
  if (item.type === 'userMessage')
    return (item.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (item.type === 'agentMessage') return item.text ?? '';
  return '';
}

export function codexBackend({ client }) {
  async function readThread(threadId) {
    const res = await client.request('thread/read', { threadId });
    return res.thread;
  }

  async function latestTurn(threadId) {
    try {
      const res = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'summary' });
      return res.data?.[0] ?? null;
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
      const res = await client.request('thread/read', { threadId, includeTurns: true });
      const turns = res.thread?.turns ?? [];
      return turns[turns.length - 1] ?? null;
    }
  }

  return {
    agent: 'codex',
    // Codex lets the first message carry the thread id (known after thread/start).
    firstMessageHasId: true,
    openCommand: (id) => `codex resume ${id}`,

    onEvent: (fn) => client.onEvent(fn),

    async status(id) {
      const t = await readThread(id);
      return { status: t.status?.type ?? 'unknown', activeFlags: t.status?.activeFlags ?? [], name: t.name };
    },

    async describe(id, target) {
      return summarize(await readThread(id), target);
    },

    async listAll({ cwd, limit, includeArchived }, targets) {
      const base = { limit, sortKey: 'updated_at', sortDirection: 'desc', archived: includeArchived };
      if (cwd) base.cwd = cwd;
      // Omitted sourceKinds = interactive sources (docs). Threads started by
      // app-server clients or `codex exec` are listed with a second call.
      const seen = new Map();
      for (const extra of [{}, { sourceKinds: ['exec', 'appServer'] }]) {
        const res = await client.request('thread/list', { ...base, ...extra });
        for (const t of res.data ?? []) if (!seen.has(t.id)) seen.set(t.id, t);
      }
      return [...seen.values()]
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, limit)
        .map((t) => summarize(t, targets[t.id]));
    },

    async read(id, { turns, maxChars }, target) {
      const thread = await readThread(id);
      let list;
      try {
        const res = await client.request('thread/turns/list', { threadId: id, limit: turns, sortDirection: 'desc', itemsView: 'full' });
        list = (res.data ?? []).slice().reverse();
      } catch (err) {
        if (!(err instanceof RpcError)) throw err;
        const res = await client.request('thread/read', { threadId: id, includeTurns: true });
        list = (res.thread?.turns ?? []).slice(-turns);
      }
      const per = Math.max(200, Math.floor(maxChars / Math.max(1, list.length) / 2));
      const out = list.map((turn) => {
        const items = turn.items ?? [];
        return {
          turnId: turn.id,
          status: turn.status,
          startedAt: iso(turn.startedAt),
          completedAt: iso(turn.completedAt),
          error: turn.error ?? null,
          user: tail(items.filter((i) => i.type === 'userMessage').map(itemText).join('\n'), per),
          agent: tail(items.filter((i) => i.type === 'agentMessage').map(itemText).join('\n'), per),
          questions: items.flatMap((i) => (i.type === 'agentMessage' && i.questions) || []),
          commands: items.filter((i) => i.type === 'commandExecution').length,
          fileChanges: items.filter((i) => i.type === 'fileChange').length,
        };
      });
      return { session: summarize(thread, target), turns: out };
    },

    // onCreated(threadId) is called as soon as the thread exists, so a failing
    // first turn still leaves the thread on record.
    async start({ name, cwd, model, effort, sandbox, approvalPolicy, instructions, firstMessage }, { onCreated }) {
      const params = { cwd, sandbox, approvalPolicy, developerInstructions: instructions };
      if (model) params.model = model;
      const started = await client.request('thread/start', params);
      const threadId = started.thread.id;
      onCreated(threadId);
      let nameError = null;
      try {
        await client.request('thread/name/set', { threadId, name });
      } catch (err) {
        nameError = err.message;
      }
      const turnParams = { threadId, input: textInput(firstMessage(threadId)) };
      if (effort) turnParams.effort = effort;
      const turn = await client.request('turn/start', turnParams);
      return { threadId, turnId: turn.turn?.id ?? null, model: started.model ?? model ?? null, nameError };
    },

    // change: { model?, effort? } for this turn and the turns after it
    // (turn/start overrides "for this turn and subsequent turns").
    async send(id, message, mode, _target, change = {}) {
      const status = (await readThread(id)).status?.type;
      const how = mode === 'auto' ? (status === 'active' ? 'queue' : 'start') : mode;
      if (how !== 'start' && (change.model || change.effort))
        throw new ToolError(
          '動いている会話のモデル・エフォートは変えられません。今のターンが終わってから送るか、stop_session で止めてから送ってください',
        );
      if (how === 'queue') {
        try {
          const res = await client.request('thread/queue/add', { threadId: id, input: textInput(message), clientUserMessageId: randomUUID() });
          return { previousStatus: status, delivery: 'queued', queuedSubmission: res.queuedSubmission ?? null };
        } catch (err) {
          if (err instanceof RpcError)
            throw new ToolError(
              `thread/queue/add を使えません（${err.message}）。Codex を新しくするか、ターンが終わってから送ってください（mode="steer" で割り込むこともできます）`,
            );
          throw err;
        }
      }
      if (how === 'steer') {
        const turn = await latestTurn(id);
        if (!turn || turn.status !== 'inProgress') throw new ToolError('動いているターンがありません（mode="start" で送ってください）');
        await client.request('turn/steer', { threadId: id, input: textInput(message), expectedTurnId: turn.id });
        return { previousStatus: status, delivery: 'steered', turnId: turn.id };
      }
      if (status !== 'active') await client.request('thread/resume', { threadId: id, excludeTurns: true });
      const params = { threadId: id, input: textInput(message) };
      if (change.model) params.model = change.model;
      if (change.effort) params.effort = change.effort;
      const res = await client.request('turn/start', params);
      return { previousStatus: status, delivery: 'started', turnId: res.turn?.id ?? null };
    },

    async stop(id) {
      const turn = await latestTurn(id);
      if (turn && turn.status === 'inProgress') {
        await client.request('turn/interrupt', { threadId: id, turnId: turn.id });
        return { interrupted: true, turnId: turn.id };
      }
      return { interrupted: false, turnId: turn?.id ?? null };
    },

    async rename(id, name) {
      await client.request('thread/name/set', { threadId: id, name });
      return { renamed: true };
    },

    async usage() {
      const res = await client.request('account/rateLimits/read', undefined);
      const snapshots = res.rateLimitsByLimitId
        ? Object.entries(res.rateLimitsByLimitId)
        : [[res.rateLimits?.limitId ?? 'default', res.rateLimits]];
      const windows = [];
      for (const [limitId, snap] of snapshots) {
        if (!snap) continue;
        for (const key of ['primary', 'secondary']) {
          const w = snap[key];
          if (!w) continue;
          windows.push({
            limitId,
            limitName: snap.limitName ?? null,
            window: windowLabel(w.windowDurationMins),
            windowDurationMins: w.windowDurationMins,
            usedPercent: w.usedPercent,
            resetsAt: iso(w.resetsAt),
          });
        }
      }
      return { windows, ordinaryUsageAllowed: res.ordinaryUsageAllowed ?? null };
    },

    async tick() {
      return [];
    },
  };
}
