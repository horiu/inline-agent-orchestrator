// TODOs: work to do later (state.json `todos`), each with a condition for
// when. The user adds them by talking to the manager, and the manager adds its
// own (work stopped by the usage limit, things to check after a restart, work
// waiting for room on the PC). When a condition is met the manager asks the
// user whether to start it, or starts it at once when `auto` is set (work the
// user already asked for). A TODO started as a session is linked to it and is
// done when the session is done.

import { compareVersions } from './version.mjs';

// anytime: no condition. usage: the usage limit is back (after `at`, the
// reset time, when known). pr: PR `pr` is merged. version: this tool runs
// `version` or newer (without it: a version other than the one it was added
// under). restart: this tool was started again after the TODO was added (the
// Claude desktop app, the terminal or Codex restarted, or a new conversation).
// at: date and time. room: free memory and CPU (and the usage limit, when
// pauseAtPct is set) allow a new session.
export const TODO_WHEN = ['anytime', 'usage', 'pr', 'version', 'restart', 'at', 'room'];

// Records from before 0.9.0 that were TODOs: work waiting for room
// (`wait:<name>`, pending with waitForRoom) and app sessions proposed as a
// card (`card:<name>`). Moved into `todos`; returns whether anything moved.
export function migrateLegacy(s, nowIso) {
  if (!Array.isArray(s.todos)) s.todos = [];
  let moved = false;
  for (const [id, t] of Object.entries(s.targets ?? {})) {
    const card = id.startsWith('card:');
    if (t.status !== 'pending' || !(t.waitForRoom || card)) continue;
    const start = Object.fromEntries(
      Object.entries({ name: t.name, cwd: t.cwd, via: t.via, area: t.area, profile: t.profile, model: t.model, effort: t.effort }).filter(([, v]) => v != null),
    );
    const todoId = nextTodoId(s);
    s.nextTodoId = todoId + 1;
    s.todos.push({
      id: todoId,
      text: t.note ? `「${t.name}」を起こす（${t.note}）` : `「${t.name}」を起こす`,
      when: { type: t.waitForRoom ? 'room' : 'anytime' },
      by: 'manager',
      auto: true,
      status: 'open',
      ...(t.cwd ? { cwd: t.cwd } : {}),
      start,
      note: t.note ?? null,
      createdAt: Number.isFinite(Date.parse(t.waitSince ?? '')) ? t.waitSince : t.updatedAt ?? nowIso,
      ...(t.waitSince ? { waitSince: t.waitSince } : {}),
      ...(card ? { cardAt: t.updatedAt ?? nowIso } : {}),
    });
    delete s.targets[id];
    moved = true;
  }
  return moved;
}

// Numbers are not used again after a TODO is removed ("2番" stays one TODO).
export function nextTodoId(s) {
  const top = Math.max(0, ...(s.todos ?? []).map((t) => Number(t.id) || 0));
  return Math.max(top + 1, Number(s.nextTodoId) || 1);
}

export function whenText(when) {
  switch (when?.type) {
    case 'usage':
      return when.at ? `利用枠が戻ったら（${when.at}）` : '利用枠が戻ったら';
    case 'pr':
      return `PR #${when.pr}${when.repo ? `（${when.repo}）` : ''} がマージされたら`;
    case 'version':
      return when.version ? `版 ${when.version} が入ったら` : '新しい版が入ったら';
    case 'restart':
      return '起動し直したら';
    case 'at':
      return `${when.at} になったら`;
    case 'room':
      return 'PC に余裕ができたら';
    default:
      return 'いつでも';
  }
}

// Checks a TODO's condition: { due: true | false | null (unknown), detail }.
// ctx: now(), running (this tool's version), startedAt (ms, when this server
// started), usage() (the usage as be.usage gives it, or null when it cannot be
// read), prState(pr, repo, cwd) ('OPEN' / 'MERGED' / 'CLOSED' or null) and
// room(todo) (a boolean).
export async function checkTodo(todo, ctx) {
  const w = todo.when ?? { type: 'anytime' };
  switch (w.type) {
    case 'anytime':
      return { due: true, detail: null };
    case 'at': {
      const at = Date.parse(w.at ?? '');
      if (!Number.isFinite(at)) return { due: null, detail: `日時 ${w.at} を読めない` };
      return { due: ctx.now() >= at, detail: null };
    }
    case 'restart': {
      // Every conversation starts its own server, so only the conversation
      // that added the TODO can tell that it was started again.
      if (todo.addedIn && ctx.conversation !== todo.addedIn)
        return { due: null, detail: '足した会話とは別の会話からは分からない（足した会話で確かめるか、利用者に聞く）' };
      const added = Date.parse(todo.createdAt ?? '');
      return { due: Number.isFinite(added) && ctx.startedAt > added, detail: null };
    }
    case 'version': {
      if (!ctx.running) return { due: null, detail: 'この道具の版が分からない' };
      if (w.version) {
        const c = compareVersions(ctx.running, w.version);
        return c === null ? { due: null, detail: `版 ${w.version} を読めない` } : { due: c >= 0, detail: `いまの版 ${ctx.running}` };
      }
      return { due: Boolean(todo.fromVersion) && ctx.running !== todo.fromVersion, detail: `いまの版 ${ctx.running}` };
    }
    case 'usage': {
      const at = Date.parse(w.at ?? '');
      if (Number.isFinite(at) && ctx.now() >= at) return { due: true, detail: null };
      const u = await ctx.usage();
      if (!u || u.stale)
        return {
          due: null,
          detail: '利用枠を読めない（Claude のデスクトップアプリでは mcp__ccd_session_mgmt__get_usage で、ほかでは get_usage で確かめる）',
        };
      const full = u.windows.filter((x) => x.usedPercent >= 100);
      return {
        due: !full.length && u.ordinaryUsageAllowed !== false,
        detail: full.length ? `使い切っている枠: ${full.map((x) => `${x.window}（戻る ${x.resetsAt}）`).join('、')}` : null,
      };
    }
    case 'pr': {
      const state = await ctx.prState(w.pr, w.repo ?? null, todo.cwd ?? null);
      if (!state) return { due: null, detail: `PR #${w.pr} の状態を読めない（gh が無いか、リポジトリが分からない）` };
      return { due: state === 'MERGED', detail: state === 'CLOSED' ? 'マージされずに閉じられた' : null };
    }
    case 'room':
      return { due: await ctx.room(todo), detail: null };
    default:
      return { due: null, detail: `条件 ${w.type} を知らない` };
  }
}
