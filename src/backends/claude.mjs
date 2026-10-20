// Claude Code backend: uses the CLI's background sessions (agent view).
// Commands follow code.claude.com/docs/en/cli-reference and /agent-view:
//   claude --bg ... --name <name> "<prompt>"    start a background session
//   claude agents --json [--all] [--cwd <dir>] list sessions (state/status/waitingFor)
//   claude --resume <session-id> --bg ... "<msg>"  new prompt into an existing session (v2.1.257+)
//   claude logs <id>                            recent output
//   claude stop <id>                            stop a session
// Plan limits are not available from the CLI; the status line script
// (src/claude-statusline.mjs) records `rate_limits` into usage.json.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError, iso, tail } from './common.mjs';

const SERVER_PATH = fileURLToPath(new URL('../server.mjs', import.meta.url));
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHORT_ID = /claude (?:attach|logs|stop) (\S+)/;
const USAGE_STALE_MS = 30 * 60 * 1000;
// Queued messages are delivered only to sessions the manager still runs.
const DELIVER_TO = new Set(['running', 'waiting_user']);
export const WORKER_SERVER = 'session-report';
export const MANAGER_SERVER = 'session-manager';

const WAITING_FLAG = {
  'permission prompt': 'waitingOnApproval',
  'sandbox request': 'waitingOnApproval',
  'worker request': 'waitingOnApproval',
  'dialog open': 'waitingOnApproval',
  'input needed': 'waitingOnUserInput',
};

// Runs the CLI without a shell (arguments contain prompts and JSON).
// claudePath: "claude" / an absolute path to claude(.exe), or an argv prefix.
export function runClaude(claudePath, args, { cwd, timeoutMs = 60000 } = {}) {
  const [cmd, ...prefix] = Array.isArray(claudePath) ? claudePath : [claudePath];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude ${args[0]}: timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function mapEntry(e) {
  if (!e) return { status: 'notLoaded', activeFlags: [] };
  if (e.state === 'failed') return { status: 'systemError', activeFlags: [] };
  const flag = e.waitingFor ? WAITING_FLAG[e.waitingFor] ?? 'waitingOnUserInput' : null;
  if (e.state === 'blocked') return { status: 'active', activeFlags: [flag ?? 'waitingOnUserInput'] };
  if (e.state === 'working') return { status: 'active', activeFlags: e.status === 'waiting' && flag ? [flag] : [] };
  return { status: 'idle', activeFlags: [] }; // done / stopped
}

export function claudeBackend({ store, claudePath = 'claude', permissionMode = 'acceptEdits', run = runClaude, now = () => Date.now() }) {
  let cache = null;
  let ticking = false;

  async function cli(args, opts) {
    const res = await run(claudePath, args, opts);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().slice(0, 500);
      const label = args[0].startsWith('--') ? args[0] : args.slice(0, 2).join(' ');
      throw new Error(`claude ${label} failed (exit ${res.code})${detail ? `: ${detail}` : ''}`);
    }
    return res.stdout;
  }

  // One `claude agents --json --all` call serves every lookup in a short burst
  // (a watch round reads several sessions at once).
  async function agents({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < 1500) return cache.list;
    const out = await cli(['agents', '--json', '--all']);
    let list;
    try {
      list = JSON.parse(out);
    } catch {
      throw new Error(`claude agents --json returned something that is not JSON: ${out.trim().slice(0, 200)}`);
    }
    cache = { at: now(), list: Array.isArray(list) ? list : [] };
    return cache.list;
  }

  // A record keeps its key (the first session ID) but follows a copy made by
  // --resume through its jobId/sessionId fields, so those win.
  function find(list, id, target) {
    if (target?.jobId) {
      const byJob = list.find((e) => e.id === target.jobId);
      if (byJob) return byJob;
    }
    if (target?.sessionId) {
      const bySid = list.find((e) => e.sessionId === target.sessionId);
      if (bySid) return bySid;
    }
    return list.find((e) => e.sessionId === id || e.id === id) ?? null;
  }

  // threadId is the record key when the manager tracks the session, so every
  // tool keeps addressing the same record after a copy.
  function summarize(e, key, target) {
    const m = mapEntry(e);
    return {
      threadId: key ?? e?.sessionId ?? e?.id,
      sessionId: e?.sessionId ?? target?.sessionId ?? null,
      jobId: e?.id ?? target?.jobId ?? null,
      name: target?.name ?? e?.name ?? null,
      status: m.status,
      activeFlags: m.activeFlags,
      state: e?.state ?? null,
      waitingFor: e?.waitingFor ?? null,
      kind: e?.kind ?? null,
      cwd: e?.cwd ?? target?.cwd ?? null,
      startedAt: typeof e?.startedAt === 'number' ? new Date(e.startedAt).toISOString() : null,
      managed: target
        ? {
            status: target.status,
            note: target.note ?? null,
            area: target.area ?? null,
            // Messages held for delivery after the current turn.
            queued: target.queue?.length ?? 0,
            queueFailedAt: target.queueFailedAt ?? null,
          }
        : null,
    };
  }

  function sessionIdOf(id, target, entry) {
    const sid = entry?.sessionId ?? target?.sessionId ?? (UUID.test(id) ? id : null);
    if (!sid) throw new ToolError(`会話 ${id} の session ID（UUID）が分かりません。claude agents --json --all に出ているか確かめてください`);
    return sid;
  }

  // Workers get this server under its own name with only `report` visible
  // (CSM_ROLE=worker) and allowed without a prompt; the manager's
  // `session-manager` server, if the user registered it for every session, is
  // removed from the worker with --disallowedTools.
  function workerMcpConfig() {
    const path = join(store.dir, 'worker-mcp.json');
    const config = {
      mcpServers: {
        [WORKER_SERVER]: {
          command: process.execPath,
          args: [SERVER_PATH],
          env: { CSM_ROLE: 'worker', CSM_AGENT: 'claude', CSM_HOME: store.dir },
        },
      },
    };
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return path;
  }

  // Options every worker launch carries, on start and on resume (a resumed or
  // copied session starts with only the flags it is given). Multi-value
  // options come first and a single-value option ends the list, so the prompt
  // that follows is not read as one more value.
  function workerOptions({ instructions, model, effort, permissionMode: mode }) {
    // Rule syntax: `mcp__<server>` matches every tool of that server,
    // `mcp__<server>__<tool>` one tool (code.claude.com/docs/en/permissions).
    const args = ['--mcp-config', workerMcpConfig()];
    args.push('--disallowedTools', `mcp__${MANAGER_SERVER}`);
    args.push('--allowedTools', `mcp__${WORKER_SERVER}__report`);
    if (instructions) args.push('--append-system-prompt', instructions);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push('--permission-mode', mode ?? permissionMode);
    return args;
  }

  // `--resume <id> --bg` continues the session under the same ID, but "starts
  // a copy and says so when the session is already running" (claude --help).
  // A different short id or session ID in the output means a copy: follow it.
  async function resume(id, target, sessionId, message, cwd) {
    // Only sessions this manager started (their record keeps the worker
    // instructions) are relaunched as workers; any other session keeps its own
    // permission mode and tools.
    const options = target?.instructions ? workerOptions(target) : [];
    const out = await cli(['--resume', sessionId, '--bg', ...options, message], { cwd });
    const jobId = SHORT_ID.exec(out)?.[1] ?? null;
    let copySid = (out.match(new RegExp(UUID.source, 'gi')) ?? []).find((u) => u.toLowerCase() !== sessionId.toLowerCase()) ?? null;
    const newJob = jobId && target?.jobId && jobId !== target.jobId;
    if (!copySid && newJob) {
      const entry = (await agents({ fresh: true })).find((e) => e.id === jobId);
      if (entry?.sessionId && entry.sessionId !== sessionId) copySid = entry.sessionId;
    }
    cache = null;
    if (copySid) {
      store.updateTarget(id, { sessionId: copySid, ...(jobId ? { jobId } : {}), note: `実行中だったため写し ${copySid} で続けた` });
      return { copiedTo: copySid };
    }
    if (jobId) store.updateTarget(id, { jobId });
    return {};
  }

  return {
    agent: 'claude',
    // The session id is only known after `claude --bg` returns.
    firstMessageHasId: false,
    openCommand: (id, target) => `claude attach ${target?.jobId ?? id}`,

    onEvent: () => () => {},

    async status(id, target) {
      const m = mapEntry(find(await agents(), id, target));
      return { ...m, name: target?.name };
    },

    async describe(id, target) {
      return summarize(find(await agents(), id, target), id, target);
    },

    async listAll({ cwd, limit, includeArchived }, targets) {
      const args = ['agents', '--json'];
      if (includeArchived) args.push('--all');
      if (cwd) args.push('--cwd', cwd);
      const list = JSON.parse(await cli(args));
      // Interactive rows have no `id` and `sessionId` is only there when set,
      // so compare a field only when both sides have it.
      const same = (a, b) => a != null && b != null && a === b;
      const keyOf = (e) =>
        Object.entries(targets).find(
          ([key, t]) => same(key, e.sessionId) || same(key, e.id) || same(t.jobId, e.id) || same(t.sessionId, e.sessionId),
        )?.[0];
      return list
        .slice()
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, limit)
        .map((e) => {
          const key = keyOf(e);
          return summarize(e, key ?? e.sessionId ?? e.id, key ? targets[key] : undefined);
        });
    },

    async read(id, { maxChars }, target) {
      const entry = find(await agents(), id, target);
      const jobId = entry?.id ?? target?.jobId;
      if (!jobId) throw new ToolError(`会話 ${id} はバックグラウンドの一覧にありません（claude --resume ${id} で開けます）`);
      const log = await cli(['logs', jobId]);
      return { session: summarize(entry, id, target), log: tail(log, maxChars) };
    },

    async start({ name, cwd, model, effort, permissionMode: mode, instructions, firstMessage }, { onCreated }) {
      const options = { instructions, model, effort, permissionMode: mode ?? permissionMode };
      const args = ['--bg', ...workerOptions(options), '--name', name, firstMessage(null)];
      const out = await cli(args, { cwd });
      const jobId = SHORT_ID.exec(out)?.[1] ?? null;
      let sessionId = UUID.exec(out)?.[0] ?? null;
      // Look the new session up to learn both ids.
      const list = await agents({ fresh: true });
      const entry =
        list.find((e) => (sessionId && e.sessionId === sessionId) || (jobId && e.id === jobId)) ??
        list
          .filter((e) => e.kind === 'background' && e.name === name)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ??
        null;
      sessionId = entry?.sessionId ?? sessionId;
      const threadId = sessionId ?? entry?.id ?? jobId;
      if (!threadId) throw new Error(`claude --bg の出力から会話を見分けられません: ${out.trim().slice(0, 300)}`);
      // Kept on the record so a resume launches the worker the same way.
      onCreated(threadId, { jobId: entry?.id ?? jobId, sessionId, ...options });
      return { threadId, jobId: entry?.id ?? jobId, sessionId, model: model ?? null, nameError: null };
    },

    async send(id, message, mode, target) {
      const entry = find(await agents({ fresh: true }), id, target);
      const status = mapEntry(entry).status;
      const how = mode === 'auto' ? (status === 'active' ? 'queue' : 'start') : mode;
      if (how === 'steer') throw new ToolError('Claude Code の会話には割り込めません（mode="auto" か "queue" で送ってください）');
      if (how === 'queue') {
        // The CLI has no queue for background sessions; keep it here and
        // deliver it when the session is idle (tick).
        const queue = [...(store.state().targets[id]?.queue ?? []), message];
        store.updateTarget(id, { queue });
        return { previousStatus: status, delivery: 'queued', queued: queue.length };
      }
      const res = await resume(id, target, sessionIdOf(id, target, entry), message, entry?.cwd ?? target?.cwd);
      return { previousStatus: status, delivery: 'started', ...res };
    },

    async stop(id, target) {
      const entry = find(await agents({ fresh: true }), id, target);
      const jobId = entry?.id ?? target?.jobId;
      const active = mapEntry(entry).status === 'active';
      if (active && jobId) {
        await cli(['stop', jobId]);
        cache = null;
      }
      return { interrupted: Boolean(active && jobId), turnId: null };
    },

    async rename() {
      // The CLI has no command that renames a background session (a person
      // can, with /rename in agent view).
      return { renamed: false, note: 'CLI からは名前を変えられないため、監視役の記録だけを変えた（作業の会話は前の名前で報告することがある）' };
    },

    async usage() {
      const path = join(store.dir, 'usage.json');
      if (!existsSync(path))
        throw new Error('利用枠がまだ記録されていません。README の「Claude Code で使う」の status line を設定してください');
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const windows = [];
      for (const [key, label, mins] of [['five_hour', '5h', 300], ['seven_day', 'weekly', 10080]]) {
        const w = data.rate_limits?.[key];
        if (!w || typeof w.used_percentage !== 'number') continue;
        // A window whose reset time has passed has started over; old figures
        // must not keep blocking.
        if (typeof w.resets_at === 'number' && w.resets_at * 1000 <= now()) continue;
        windows.push({ limitId: 'claude', limitName: null, window: label, windowDurationMins: mins, usedPercent: w.used_percentage, resetsAt: iso(w.resets_at) });
      }
      const updatedAt = data.updatedAt ?? null;
      const stale = !updatedAt || now() - Date.parse(updatedAt) > USAGE_STALE_MS;
      return { windows, ordinaryUsageAllowed: null, updatedAt, stale };
    },

    // Delivers messages queued while a session was busy, once it is idle.
    // One delivery round at a time; the queue is taken off the record before
    // the CLI runs, so a second round or a new send cannot deliver it twice.
    async tick(targets) {
      if (ticking) return [];
      const waiting = Object.entries(targets).filter(([, t]) => t.queue?.length && DELIVER_TO.has(t.status));
      if (!waiting.length) return [];
      ticking = true;
      try {
        const list = await agents({ fresh: true });
        const events = [];
        for (const [id, target] of waiting) {
          const entry = find(list, id, target);
          if (mapEntry(entry).status === 'active') continue;
          // After a failed delivery, wait before trying again (and report once).
          if (target.queueFailedAt && now() - Date.parse(target.queueFailedAt) < 5 * 60 * 1000) continue;
          const batch = store.state().targets[id]?.queue ?? [];
          if (!batch.length) continue;
          store.updateTarget(id, { queue: [] });
          try {
            const res = await resume(id, target, sessionIdOf(id, target, entry), batch.join('\n\n'), entry?.cwd ?? target.cwd);
            // The manager may have stopped or paused it while the CLI ran;
            // keep that mark instead of writing `running` over it.
            const still = DELIVER_TO.has(store.state().targets[id]?.status);
            store.updateTarget(id, { queueFailedAt: null, ...(still ? { status: 'running' } : {}), lastSeen: { status: 'active', activeFlags: [] } });
            events.push({ type: 'queuedDelivered', threadId: id, name: target.name, count: batch.length, ...res });
          } catch (err) {
            // Put the batch back in front of anything queued meanwhile, unless
            // the session was stopped in the meantime (then it is dropped).
            const now_ = store.state().targets[id];
            const restore = DELIVER_TO.has(now_?.status) ? [...batch, ...(now_?.queue ?? [])] : now_?.queue ?? [];
            store.updateTarget(id, { queue: restore, queueFailedAt: new Date(now()).toISOString() });
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
