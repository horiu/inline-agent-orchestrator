---
name: status
description: Show a table of the sessions the inline-agent-orchestrator manager manages, its TODOs and the handoff note. Works from any conversation, not only the manager's.
---

# status — 管理中の会話と TODO の一覧

監視役（manage-sessions）が管理している会話・TODO・引き継ぎメモを、表にしてすぐ見せる。この会話が監視役でなくてよい（見回り中の監視役には打っても読まれないので、ほかの会話から見るためのコマンド）。

読むだけにする。見回り（`wait_events`）・作業の会話を起こす・送る・止める・記録を書き換える（`update_session`・`todo`）・TODO を始めることはしない。引数に「all」「全部」があれば、済んだものも出す。

## 読む

1. `session-manager` の `list_sessions`（scope `managed`。済んだものも出すときは includeArchived true）を呼ぶ。遅延ツールなら ToolSearch（`select:mcp__plugin_inline-agent-orchestrator_session-manager__list_sessions`。無ければ `+session-manager list_sessions`）で読み込む。利用者には言わない
2. Claude のデスクトップアプリの道具 `mcp__ccd_session_mgmt__list_sessions` があれば（遅延ツールにあれば ToolSearch で読み込む）、limit 50 で呼ぶ。1. の `threadId` が `local_…` の会話は、この結果の同じ `sessionId` の行から、ブランチ（`branch`）・PR（`prNumber`・`prState`）・動いているか（`isRunning`）を取る。無ければ（ターミナルの Claude Code・Codex）飛ばす
3. ほかの道具は呼ばない（会話の中身は読まない）

## 表にする

### 管理中の会話

| 名前 | 状態 | ブランチ | PR | 待っていること | 開く |
| --- | --- | --- | --- | --- | --- |

- 名前: Claude のデスクトップアプリの会話はリンク `[名前](#local_…)`（そのまま開ける）。ほかは名前だけ
- 状態: 上から順に、最初に当てはまるもの
  - `managed.status` が `done` → 終わった（ふだんは出さない）
  - `activeFlags` に `waitingOnApproval` → 承認待ち、`waitingOnUserInput` → 入力待ち、`waitingOnUsageLimit` → 利用枠の回復待ち
  - `managed.status` が `waiting_user` → 判断待ち、`pending` → 保留、`paused` → 止めた、`paused_usage` → 利用枠で止めた、`failed` → 落ちた
  - `status` が `active`（デスクトップアプリの会話は `isRunning` が true でも）→ 作業中
  - それ以外（`running` なのに止まっている）→ 止まっている（報告なし）
- ブランチ・PR: 2. で取れたもの（PR は `#番号（状態）`。MERGED はマージ済み、OPEN は開いている）。取れなければ `managed.note` に書いてあるもの、無ければ「—」
- 待っていること: 判断待ち・承認待ち・入力待ちなら何を待っているか（`managed.note` から一言）。ほかは空
- 開く: Claude のデスクトップアプリの会話はサイドバー（名前のリンク）。ターミナルの Claude Code は `claude attach <jobId か threadId>`、Codex は `codex resume <threadId>`

### TODO

| 番号 | やること | いつ | そろったか | つないだ会話 |
| --- | --- | --- | --- | --- |

- いつ: `whenText`
- そろったか: `due` が true → そろった、false → まだ、null → 分からない（`dueDetail` を一言）。`started` の TODO は「進行中」、`done` は「済み」（ふだんは出さない）
- つないだ会話: `threadId` があれば、上の表の名前

### 引き継ぎメモ

`handoff.exists` が true なら、更新日時（`handoff.updatedAt` を利用者の時刻で）と、`handoff.text` の要点を3行まで。無ければ「引き継ぎメモはありません」。

## 返事

- 表だけを返す。管理中の会話も TODO も無ければ「管理中の会話も TODO もありません」
- そろった TODO があれば、最後に一行「監視役の会話で『◯番を始めて』と打つと始まります」
- ことば: 「app」とだけ書かず、「Claude のデスクトップアプリ」「ターミナルの Claude Code」と書く
