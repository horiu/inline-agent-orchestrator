// MCP tools for a "manager" conversation that supervises other conversations
// of the same coding agent (Codex or Claude Code, see src/backends/), plus one
// tool (`report`) for the worker conversations to report back.

import { freemem, totalmem } from 'node:os';
import { codexBackend } from './backends/codex.mjs';
import { ToolError } from './backends/common.mjs';
import { DEFAULT_CONFIG, TARGET_STATUSES, WATCH_INTERVAL_MAX_MIN } from './state.mjs';

export { ToolError };

const GB = 1024 ** 3;
const ACTIVE_TARGET = new Set(['running', 'waiting_user', 'paused', 'paused_usage', 'failed']);
const RULES_FILE = { codex: 'AGENTS.md', claude: 'CLAUDE.md' };

export function workerInstructions(name, agent = 'codex') {
  const idHint = agent === 'codex' ? '、threadId には最初の依頼に書かれた ID' : '';
  return [
    `あなたは監視役の会話（session-manager）から仕事を受けた作業の会話「${name}」です。`,
    `- 区切りごとに MCP の道具 report（kind: "progress"）で 1〜3 行の報告を書く。from には「${name}」${idHint}を入れる`,
    '- 利用者の判断が要るときは、利用者に直接聞かず report（kind: "question"）に質問・選択肢・おすすめを書き、返事が届くまでこのターンを終えて待つ',
    '- 重い処理（ビルド・全件テスト・開発サーバーの起動など）に入る前に report（kind: "progress"）で一言書く',
    '- 終わったら report（kind: "done"）で結果（ブランチ・PR・残っていること）を書く。進められなくなったら kind: "blocked"',
    '- session-manager の他の道具（start_session・send_message・stop_session など）は使わない。それは監視役の仕事',
    `- 共通の決まりは ${RULES_FILE[agent] ?? 'AGENTS.md'} に従う`,
  ].join('\n');
}

export function firstMessage(name, threadId, prompt) {
  const id = threadId ? `／ID: ${threadId}` : '';
  return `【監視役からの依頼】この会話の名前: ${name}${id}\n\n${prompt}`;
}

export function createTools({ backend, client, store, sys = {} }) {
  const be = backend ?? codexBackend({ client });
  const mem = { free: sys.freemem ?? freemem, total: sys.totalmem ?? totalmem };
  const sleep = sys.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = sys.now ?? (() => Date.now());
  let waitGen = 0;

  async function liveStatuses(ids, targets) {
    const out = {};
    for (const id of ids) {
      try {
        out[id] = await be.status(id, targets[id]);
      } catch (err) {
        out[id] = { status: 'unreadable', activeFlags: [], error: err.message };
      }
    }
    return out;
  }

  function watchedIds(state) {
    return Object.entries(state.targets)
      .filter(([, t]) => ACTIVE_TARGET.has(t.status))
      .map(([id]) => id);
  }

  // Model and effort for a run: explicit values win, then the profile. The
  // profile name is recorded only when the values are exactly the profile's.
  function resolveRun(cfg, { profile, model, effort }) {
    let p = null;
    if (profile) {
      const profiles = cfg.profiles ?? {};
      p = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
      if (!p) throw new ToolError(`profile「${profile}」はありません。使えるのは: ${Object.keys(profiles).join('、') || '（なし）'}`);
    }
    const forAgent = p?.[be.agent] ?? {};
    return {
      profile: profile && !model && !effort ? profile : null,
      model: model ?? forAgent.model ?? null,
      effort: effort ?? forAgent.effort ?? null,
    };
  }

  function profileList(cfg) {
    return Object.entries(cfg.profiles ?? {}).map(([name, p]) => ({
      name,
      description: p.description ?? '',
      model: p[be.agent]?.model ?? null,
      effort: p[be.agent]?.effort ?? null,
    }));
  }

  // Load guard: number of running conversations, free memory, usage limits.
  async function guard() {
    const cfg = store.config();
    const state = store.state();
    const live = await liveStatuses(watchedIds(state), state.targets);
    const running = Object.values(live).filter((s) => s.status === 'active').length;
    const freeGb = mem.free() / GB;
    const reasons = [];
    if (running >= cfg.maxRunning) reasons.push(`動いている会話が ${running} 本（上限 ${cfg.maxRunning}）`);
    if (freeGb < cfg.minFreeMemGb) reasons.push(`空きメモリ ${freeGb.toFixed(1)} GB（下限 ${cfg.minFreeMemGb} GB）`);
    let usage = null;
    try {
      usage = await be.usage();
      for (const w of usage.windows) {
        if (w.usedPercent >= cfg.pauseAtPct)
          reasons.push(`利用枠 ${w.limitId}/${w.window} が ${w.usedPercent}%（止める目安 ${cfg.pauseAtPct}%・戻る ${w.resetsAt}）`);
      }
      if (usage.ordinaryUsageAllowed === false) reasons.push('利用枠を使い切っています（ordinaryUsageAllowed=false）');
    } catch (err) {
      usage = { error: err.message };
    }
    return {
      canStartNew: reasons.length === 0,
      reasons,
      running,
      maxRunning: cfg.maxRunning,
      freeMemGb: Number(freeGb.toFixed(2)),
      totalMemGb: Number((mem.total() / GB).toFixed(2)),
      minFreeMemGb: cfg.minFreeMemGb,
      pauseAtPct: cfg.pauseAtPct,
      usage,
      live,
    };
  }

  const tools = {
    list_sessions: {
      description:
        '会話の一覧と状態を返す。scope="managed"（既定）は監視役が管理している会話（保留と終わったものは状態を読みに行かない）、scope="all" はこの PC の会話を新しい順に。status は notLoaded（読み込まれていない・一覧に無い）/ idle（止まっている）/ active（動いている。activeFlags に waitingOnApproval・waitingOnUserInput）/ systemError。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['managed', 'all'], default: 'managed' },
          cwd: { type: 'string', description: 'scope=all のとき、この作業フォルダの会話だけ' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          includeArchived: { type: 'boolean', default: false, description: '終わった・アーカイブした会話も含める' },
        },
      },
      async handler({ scope = 'managed', cwd, limit = 30, includeArchived = false }) {
        const state = store.state();
        if (scope === 'managed') {
          const sessions = [];
          for (const [id, target] of Object.entries(state.targets)) {
            if (target.status === 'pending' || target.status === 'done') {
              sessions.push({ threadId: id, name: target.name, status: 'notChecked', managed: target });
              continue;
            }
            try {
              sessions.push(await be.describe(id, target));
            } catch (err) {
              sessions.push({ threadId: id, name: target.name, status: 'unreadable', error: err.message, managed: target });
            }
          }
          return { sessions };
        }
        return { sessions: await be.listAll({ cwd, limit, includeArchived }, state.targets) };
      },
    },

    read_session: {
      description:
        '会話の最近のやりとりを読む（依頼の文・AI の返事・状態・エラー・利用者への質問）。落ちたのか、判断待ちなのか、終わったのかを見分けるのに使う。長い文は末尾を残して切る。Codex はターンごと、Claude Code は最近の出力（claude logs）。',
      readOnly: true,
      inputSchema: {
        type: 'object',
        required: ['threadId'],
        properties: {
          threadId: { type: 'string' },
          turns: { type: 'integer', minimum: 1, maximum: 10, default: 2, description: 'Codex だけ: 読むターンの数' },
          maxChars: { type: 'integer', minimum: 500, maximum: 20000, default: 6000 },
        },
      },
      async handler({ threadId, turns = 2, maxChars = 6000 }) {
        return be.read(threadId, { turns, maxChars }, store.state().targets[threadId]);
      },
    },

    start_session: {
      description:
        '新しい作業の会話を起こして、最初の依頼を送る（名前・作業フォルダ・モデル・エフォート）。モデルとエフォートは、仕事の種類に合う profile（get_usage の profiles）で選ぶのが基本。model・effort を書くと profile より優先する。会話はこの会話とは別に動き、この会話が終わっても動き続ける。動いている数・空きメモリ・利用枠の上限を超えるときは起こさずに理由を返す（force=true で無視）。名前は管理中の会話と重ねない。',
      inputSchema: {
        type: 'object',
        required: ['name', 'cwd', 'prompt'],
        properties: {
          name: { type: 'string', description: '会話の名前（仕事を一言で。管理中の会話と重ねない）' },
          cwd: { type: 'string', description: '作業フォルダ（絶対パス）' },
          prompt: { type: 'string', description: '最初の依頼（何を・どこまで・報告のしかた）' },
          profile: { type: 'string', description: '仕事の種類（get_usage の profiles の name。例 design / debug / implement / review / writing / routine）' },
          model: { type: 'string', description: 'profile より優先。どちらも無ければ config の defaults.model、それも無ければ既定のモデル' },
          effort: { type: 'string', description: 'reasoning effort（例 low / medium / high / xhigh）。profile より優先。省略時は既定' },
          sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Codex だけ' },
          approvalPolicy: { type: 'string', enum: ['untrusted', 'on-request', 'never'], description: 'Codex だけ' },
          permissionMode: {
            type: 'string',
            enum: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
            description: 'Claude Code だけ',
          },
          area: { type: 'string', description: '触る場所の一言（ファイル・画面・機能）。思いつきの振り分けに使う' },
          force: { type: 'boolean', default: false },
        },
      },
      async handler({ name, cwd, prompt, profile, model, effort, sandbox, approvalPolicy, permissionMode, area, force = false }) {
        const cfg = store.config();
        const run = resolveRun(cfg, { profile, model, effort });
        // pending records are work waiting to be started, often under this name.
        // Old names (aliases) count too: reports written under them must keep
        // pointing at one session.
        const clash = Object.entries(store.state().targets).find(
          ([, t]) => (t.name === name || (t.aliases ?? []).includes(name)) && t.status !== 'done' && t.status !== 'pending',
        );
        if (clash) throw new ToolError(`「${name}」は管理中の会話（${clash[0]}）と同じ名前です。別の名前にしてください`);
        if (!force) {
          const g = await guard();
          if (!g.canStartNew) return { started: false, reasons: g.reasons, guard: g };
        }
        const d = cfg.defaults;
        const useModel = run.model ?? d.model ?? null;
        const useEffort = run.effort ?? d.effort ?? null;
        let createdId = null;
        try {
          const res = await be.start(
            {
              name,
              cwd,
              model: useModel,
              effort: useEffort,
              sandbox: sandbox ?? d.sandbox,
              approvalPolicy: approvalPolicy ?? d.approvalPolicy,
              permissionMode: permissionMode ?? cfg.claude?.permissionMode,
              instructions: workerInstructions(name, be.agent),
              firstMessage: (id) => firstMessage(name, be.firstMessageHasId ? id : null, prompt),
            },
            {
              // Record the conversation at once so a failing first turn does
              // not leave an untracked conversation behind.
              onCreated: (id, extra = {}) => {
                createdId = id;
                store.updateTarget(id, {
                  name,
                  status: 'failed',
                  note: '最初の依頼を送る前に止まった',
                  cwd,
                  area: area ?? null,
                  startedAt: new Date(now()).toISOString(),
                  ...extra,
                });
              },
            },
          );
          store.updateTarget(res.threadId, {
            status: 'running',
            note: null,
            model: res.model ?? useModel,
            effort: useEffort,
            profile: run.profile,
            lastSeen: { status: 'active', activeFlags: [] },
          });
          const target = store.state().targets[res.threadId];
          return {
            started: true,
            threadId: res.threadId,
            turnId: res.turnId ?? null,
            profile: run.profile,
            model: res.model ?? useModel,
            effort: useEffort,
            nameError: res.nameError ?? null,
            open: be.openCommand(res.threadId, target),
          };
        } catch (err) {
          if (createdId) store.updateTarget(createdId, { note: `最初の依頼を送れなかった: ${err.message}` });
          throw err;
        }
      },
    },

    send_message: {
      description:
        '会話へ連絡・依頼を送る。mode="auto"（既定）: 動いている会話には今のターンの後に回す（queue）、止まっている会話は続きから新しいターンを始める。mode="steer" は動いているターンに割り込んで足す（Codex だけ）。profile・model・effort を付けると、この依頼からモデルとエフォートを変える（以後の続きにも効く。Codex は止まっている会話にだけ。Claude Code は動いていれば、預かって届けるときから）。',
      inputSchema: {
        type: 'object',
        required: ['threadId', 'message'],
        properties: {
          threadId: { type: 'string' },
          message: { type: 'string' },
          mode: { type: 'string', enum: ['auto', 'queue', 'steer', 'start'], default: 'auto' },
          profile: { type: 'string', description: 'モデルとエフォートをこの仕事の種類のものに変える（get_usage の profiles の name）' },
          model: { type: 'string', description: 'モデルを変える（profile より優先）' },
          effort: { type: 'string', description: 'エフォートを変える（profile より優先）' },
        },
      },
      async handler({ threadId, message, mode = 'auto', profile, model, effort }) {
        const asked = profile || model || effort;
        const run = asked ? resolveRun(store.config(), { profile, model, effort }) : null;
        const change = {};
        if (run?.model) change.model = run.model;
        if (run?.effort) change.effort = run.effort;
        if (asked && !Object.keys(change).length)
          throw new ToolError(`profile「${profile}」には ${be.agent === 'claude' ? 'Claude Code' : 'Codex'} 用のモデル・エフォートがありません`);
        const result = await be.send(threadId, message, mode, store.state().targets[threadId], change);
        // The watch compares with lastSeen; mark the thread active so a turn
        // that ends before the next wait_events is still reported.
        if (store.state().targets[threadId])
          store.updateTarget(threadId, {
            status: 'running',
            lastSeen: { status: 'active', activeFlags: [] },
            ...change,
            ...(asked ? { profile: run.profile } : {}),
          });
        return { threadId, ...result, ...(asked ? { changed: change } : {}) };
      },
    },

    stop_session: {
      description:
        '会話の動いているターンを止める。会話そのものは残り、send_message で続きを頼める。markAs で管理上の状態を記録する（既定 paused＝手で止めた。利用枠で止めるときは paused_usage にすると、枠が戻ったときに wait_events が usageRecovered を返す）。',
      inputSchema: {
        type: 'object',
        required: ['threadId'],
        properties: {
          threadId: { type: 'string' },
          markAs: { type: 'string', enum: TARGET_STATUSES, default: 'paused' },
        },
      },
      async handler({ threadId, markAs = 'paused' }) {
        const res = await be.stop(threadId, store.state().targets[threadId]);
        // Messages the manager was holding for this session (Claude Code) are
        // dropped: a stopped session must not be restarted by them.
        const held = store.state().targets[threadId]?.queue?.length ?? 0;
        if (store.state().targets[threadId]) store.updateTarget(threadId, { status: markAs, ...(held ? { queue: [] } : {}) });
        if (held) res.droppedQueued = held;
        return { threadId, ...res, markedAs: markAs };
      },
    },

    set_session_name: {
      description: '会話の名前を変える（Claude Code は外から変えられないため、監視役の記録だけ変える）。',
      inputSchema: {
        type: 'object',
        required: ['threadId', 'name'],
        properties: { threadId: { type: 'string' }, name: { type: 'string' } },
      },
      async handler({ threadId, name }) {
        const target = store.state().targets[threadId];
        const res = await be.rename(threadId, name, target);
        // Keep old names so reports written under them still match.
        if (target) store.updateTarget(threadId, { name, aliases: [...new Set([...(target.aliases ?? []), target.name])] });
        return { threadId, name, ...res };
      },
    },

    get_usage: {
      description:
        '利用枠（窓ごとの使用率とリセットの時刻）・空きメモリ・動いている会話の数と、いま新しく動かしてよいか（canStartNew と理由）を返す。profiles は仕事の種類ごとのおすすめのモデルとエフォート（null は、start_session ではそれぞれの既定、send_message では今の値のまま）。',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return { ...(await guard()), profiles: profileList(store.config()) };
      },
    },

    update_session: {
      description:
        '監視役の記録（state.json）を書き換える。管理に加える・状態（running / waiting_user / done / pending=保留 / paused=手で止めた / paused_usage=利用枠で止めた / failed）・一言のメモ・触る場所。会話そのものには何もしない。',
      inputSchema: {
        type: 'object',
        required: ['threadId'],
        properties: {
          threadId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string', enum: TARGET_STATUSES },
          note: { type: 'string' },
          area: { type: 'string' },
          remove: { type: 'boolean', default: false, description: 'true なら記録から外す' },
        },
      },
      async handler({ threadId, remove = false, ...patch }) {
        if (remove) {
          const s = store.state();
          const existed = Boolean(s.targets[threadId]);
          delete s.targets[threadId];
          store.saveState(s);
          return { threadId, removed: existed };
        }
        const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        return { threadId, target: store.updateTarget(threadId, clean) };
      },
    },

    wait_events: {
      description:
        '見回り。管理中の会話の状態の変化・作業の会話からの報告・承認や入力の待ち・空きメモリ不足・利用枠の超過と回復を、起きるまで待って返す。何も起きなければ最長 intervalMin 分（省略時は設定の watchIntervalMin。設定より長くはできない）で timedOut を返す。待つ間はモデルを使わない。動いている会話・枠で止めた会話・未読の報告がどれも無ければすぐ idle=true を返す（見回りを止めてよい合図）。同時に呼べるのは1つだけ（新しい呼び出しが前のものを打ち切る）。',
      // Marked read-only for approval prompts: it changes no conversation's
      // content, only the manager's own read mark and last-seen statuses (and,
      // for Claude Code, it delivers messages the manager already queued).
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          intervalMin: { type: 'number', exclusiveMinimum: 0, maximum: WATCH_INTERVAL_MAX_MIN, description: '今回だけ短くするとき（分）' },
        },
      },
      async handler({ intervalMin } = {}, { signal } = {}) {
        const myGen = ++waitGen;
        // A newer call or a cancelled request must not consume reports or
        // statuses: nobody would receive them.
        const stale = () => myGen !== waitGen || Boolean(signal?.aborted);
        const aborted = signal ? new Promise((r) => signal.addEventListener('abort', r, { once: true })) : null;
        const cfg = store.config();
        const maxMin = Math.min(Math.max(Number(cfg.watchIntervalMin) || DEFAULT_CONFIG.watchIntervalMin, 0), WATCH_INTERVAL_MAX_MIN);
        const limitMin = intervalMin > 0 ? Math.min(intervalMin, maxMin) : maxMin;
        const deadline = now() + limitMin * 60_000;
        const state = store.state();
        const ids = watchedIds(state);
        const paused = ids.filter((id) => state.targets[id].status === 'paused_usage');
        const storedSeen = Object.fromEntries(ids.map((id) => [id, JSON.stringify(state.targets[id].lastSeen ?? null)]));
        const events = [];
        let reportsOffset = null;
        const alerts = { memoryLow: false, usageHigh: [], ...(state.alerts ?? {}) };
        const byName = new Map(
          Object.entries(state.targets).flatMap(([id, t]) => [...(t.aliases ?? []), t.name].map((n) => [n, id])),
        );
        const unsubscribe = be.onEvent((msg) => {
          const p = msg.params ?? {};
          if (msg.id !== undefined && p.threadId && ids.includes(p.threadId)) {
            events.push({ type: 'needsAttention', threadId: p.threadId, name: state.targets[p.threadId]?.name, method: msg.method });
          } else if (msg.method === 'turn/completed' && ids.includes(p.threadId)) {
            events.push({ type: 'turnCompleted', threadId: p.threadId, name: state.targets[p.threadId]?.name, status: p.turn?.status, error: p.turn?.error ?? null });
          }
        });
        // Compare with the status seen by the previous call (kept in
        // state.json), so changes that happen between calls are not lost.
        // A running target that was never seen counts as active, so a turn
        // that already ended is still reported.
        const seen = Object.fromEntries(
          ids.map((id) => {
            const t = state.targets[id];
            return [id, t.lastSeen ?? (t.status === 'running' ? { status: 'active', activeFlags: [] } : null)];
          }),
        );
        const diff = (live) => {
          for (const id of ids) {
            const a = seen[id];
            const b = live[id];
            if (a && (a.status !== b.status || (a.activeFlags ?? []).join() !== (b.activeFlags ?? []).join())) {
              events.push({ type: 'status', threadId: id, name: state.targets[id]?.name, from: a.status, to: b.status, activeFlags: b.activeFlags ?? [] });
            }
            seen[id] = { status: b.status, activeFlags: b.activeFlags ?? [] };
          }
        };
        // Statuses, alerts and the report read mark are saved only when the
        // result is actually returned.
        const commit = () => {
          if (stale()) return false;
          const s = store.state();
          // Skip ids whose lastSeen was rewritten meanwhile (e.g. by
          // send_message marking the thread active again).
          for (const id of ids) {
            if (s.targets[id] && JSON.stringify(s.targets[id].lastSeen ?? null) === storedSeen[id]) s.targets[id].lastSeen = seen[id];
          }
          s.alerts = alerts;
          if (reportsOffset !== null) s.reportsOffset = reportsOffset;
          store.saveState(s);
          return true;
        };
        const cancelled = { cancelled: true, events: [], hint: '新しい見回りの呼び出しか取り消しで打ち切られた' };
        try {
          let live = await liveStatuses(ids, state.targets);
          diff(live);
          const anyActive = Object.values(live).some((s) => s.status === 'active');
          const anyQueued = Object.values(state.targets).some((t) => t.queue?.length && (t.status === 'running' || t.status === 'waiting_user'));
          // Threads paused for the usage limit keep the watch going until
          // usageRecovered has been reported for them.
          const waitForRecovery = paused.length > 0 && alerts.usageRecovered !== paused.slice().sort().join(',');
          if (!events.length && !anyActive && !anyQueued && !waitForRecovery && !store.hasUnreadReports()) {
            if (!commit()) return cancelled;
            return { idle: true, events: [], live, hint: '動いている会話も未読の報告もありません。見回りを止めてよい' };
          }
          // Memory and usage alerts fire on the transition only (remembered in
          // state.json), so a lasting condition does not wake the manager on
          // every call.
          let usageChecked = false;
          for (;;) {
            if (stale()) return cancelled;
            try {
              const delivered = await be.tick(store.state().targets);
              events.push(...delivered);
              // A delivery restarted these sessions; count them as active so
              // the commit does not write back an older idle status.
              for (const e of delivered) if (e.type === 'queuedDelivered' && e.threadId in seen) seen[e.threadId] = { status: 'active', activeFlags: [] };
            } catch (err) {
              events.push({ type: 'tickFailed', error: err.message });
            }
            const peek = store.peekReports();
            reportsOffset = peek.nextOffset;
            for (const r of peek.reports) {
              const threadId = r.threadId ?? (r.from ? byName.get(r.from) ?? null : null);
              events.push({ type: 'report', ...r, threadId });
            }
            const freeGb = mem.free() / GB;
            const low = freeGb < cfg.minFreeMemGb;
            if (low && !alerts.memoryLow)
              events.push({ type: 'memoryLow', freeMemGb: Number(freeGb.toFixed(2)), minFreeMemGb: cfg.minFreeMemGb });
            alerts.memoryLow = low;
            if (!usageChecked) {
              usageChecked = true;
              try {
                const u = await be.usage();
                const over = u.windows.filter((w) => w.usedPercent >= cfg.pauseAtPct);
                const keys = over.map((w) => `${w.limitId}/${w.window}/${w.resetsAt}`);
                const fresh = over.filter((_, i) => !alerts.usageHigh.includes(keys[i]));
                if (fresh.length) events.push({ type: 'usageHigh', windows: fresh, pauseAtPct: cfg.pauseAtPct });
                alerts.usageHigh = keys;
                // Once per set of paused threads, not on every call.
                const recoveredKey = paused.slice().sort().join(',');
                if (paused.length && !over.length && u.ordinaryUsageAllowed !== false && !u.stale) {
                  if (alerts.usageRecovered !== recoveredKey)
                    events.push({
                      type: 'usageRecovered',
                      threadIds: paused,
                      names: paused.map((id) => state.targets[id]?.name ?? null),
                    });
                  alerts.usageRecovered = recoveredKey;
                } else {
                  alerts.usageRecovered = null;
                }
              } catch {
                // usage is advisory here; get_usage reports the error
              }
            }
            if (events.length || now() >= deadline) break;
            const pause = sleep(Math.min(cfg.pollSec * 1000, Math.max(0, deadline - now())));
            await (aborted ? Promise.race([pause, aborted]) : pause);
            if (stale()) return cancelled;
            // Past the deadline, return instead of starting another round of
            // reads that could outlast the client's tool timeout.
            if (now() >= deadline) break;
            live = await liveStatuses(ids, store.state().targets);
            diff(live);
          }
          if (!commit()) return cancelled;
          return { idle: false, events, live, paused, timedOut: events.length === 0 };
        } finally {
          unsubscribe();
        }
      },
    },

    read_reports: {
      description: '作業の会話からの報告（report）を読む。既定は未読だけ（読んだ印を進める）。all=true で全部を新しい順に limit 件。',
      readOnly: true, // changes only the manager's read mark
      inputSchema: {
        type: 'object',
        properties: {
          all: { type: 'boolean', default: false },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        },
      },
      async handler({ all = false, limit = 50 }) {
        const reports = store.readReports({ all, advance: !all });
        return { reports: all ? reports.slice(-limit).reverse() : reports };
      },
    },

    report: {
      description:
        '【作業の会話が使う】監視役へ報告を書く。kind: progress（区切りの報告）/ question（利用者の判断が要る。質問・選択肢・おすすめを書いて待つ）/ done（終わった。結果と残り）/ blocked（進められない）。',
      inputSchema: {
        type: 'object',
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['progress', 'question', 'done', 'blocked'] },
          text: { type: 'string' },
          from: { type: 'string', description: 'この会話の名前' },
          threadId: { type: 'string', description: 'この会話の ID（最初の依頼に書いてあれば）' },
        },
      },
      async handler({ kind, text, from, threadId }) {
        store.appendReport({ kind, text, from: from ?? null, threadId: threadId ?? null });
        return { ok: true };
      },
    },
  };

  return { tools, guard };
}
