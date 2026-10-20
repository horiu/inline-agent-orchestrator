# Inline Agent Orchestrator

**Claude Code・Codex のいつもの会話を、そのままオーケストレーターに。**

仕事をまとめて一つの会話に頼むと、その会話が「監視役」になります。監視役は作業ごとに別の会話を立ち上げ、進み具合を見回り、判断が必要なことだけをまとめて尋ねます。新しいアプリや画面を覚える必要はありません。

> [!NOTE]
> 試作版（v0.3.0）です。単体テストは通っていますが、実際の Claude Code・Codex での動作はまだ確かめていません。使い始める前に「[動作確認](#動作確認)」をお試しください。

## 特長

- **いつもの画面のまま** — Claude Code・Codex の標準の会話と CLI だけで動きます。専用のアプリ、常駐サービス、tmux は要りません
- **監視役が自分で会話を起こす** — 仕事ごとに名前・作業フォルダ・モデルを決めて、作業の会話を立ち上げます
- **判断は一度にまとめて** — 各会話からの質問を監視役が集め、選択肢とおすすめを添えて尋ねます
- **PC と利用枠を守る** — 同時に動かす数、空きメモリ、5時間・週の利用枠を見て、無理な並列を避けます。枠が尽きそうなら止め、戻れば再開します
- **止まっても立て直す** — 落ちた会話や途中で止まった会話を見つけて、続きを頼みます
- **軽い** — Node.js だけで動き、依存パッケージはありません

## 使うとこんな感じです

```text
あなた  : ログインの不具合を直して PR まで。あわせて、依存ライブラリを上げられるか調べて報告して。

監視役  : 2つの会話に分けて進めます。
          ・fix-login   … 不具合の修正 → テスト → PR
          ・deps-survey … 調べて報告まで
          見回りを始めます。

          （しばらくして）

監視役  : fix-login から確認です。期限切れのセッションは、再ログインを求めますか、自動で延長しますか。
          おすすめは「再ログインを求める」です（今の画面の動きと同じ）。
あなた  : おすすめで

監視役  : 全部終わりました。
          | 会話        | 結果                             |
          | fix-login   | PR #42 を作成（テスト追加済み）  |
          | deps-survey | 3件は更新可、1件は破壊的変更あり |
```

## クイックスタート

### Claude Code

必要なもの: Claude Code 2.1.292 以上、Node.js 20 以上

```bash
claude plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

Claude Code を起動し直せば準備完了です。初めて使うときに、監視役が「利用枠を読むために status line を設定してよいか」を尋ねます。了承すると設定され、今の status line の表示はそのまま残ります。

<details>
<summary>Claude Code 2.1.257〜2.1.291 の場合</summary>

```bash
claude plugin marketplace add horiu/inline-agent-orchestrator
claude plugin install inline-agent-orchestrator@inline-agent-orchestrator
```

</details>

### Codex

必要なもの: Codex CLI 0.162 以上（デスクトップアプリだけを使っている場合も必要です）、Node.js 20 以上、git

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/tools/inline-agent-orchestrator
node $HOME/tools/inline-agent-orchestrator/src/setup.mjs codex
```

Codex を起動し直せば準備完了です。設定のスクリプトは MCP サーバーを `~/.codex/config.toml` に登録し（元のファイルは `config.toml.bak-<日時>` として残します）、Skill を `~/.agents/skills/manage-sessions/` に入れます。

## 使い方

### 始める

新しい会話で次のように打ち、続けてやりたいことを並べて頼みます。

| | 呼び出し方 |
| --- | --- |
| Claude Code | `/inline-agent-orchestrator:manage-sessions` |
| Codex | `$manage-sessions` |

監視役が仕事を分け、作業の会話を立ち上げて見回りを始めます。依頼には「どこまで進めるか」（PR を作るまで、調べて報告するまで など）を添えると、途中で止まらずに進みます。

### 進めている間

- **思いついたことは監視役へ** — 同じ場所を触っている会話があればそこへ足し、無関係なら新しい会話を起こします
- **作業の会話を覗く** — Claude Code は `claude agents` で一覧、`claude attach <ID>` で開きます。Codex は `codex agents` と `codex resume <ID>` です。開いて直接話しかけることもできます
- **監視役に話しかける** — 見回りの最中は返事が遅れることがあります。急ぐときは止めるボタン（Claude Code は Esc）で見回りを止めてから話しかけてください。その間の出来事は失われず、次の見回りで受け取ります

### 終わったら

全部の作業が終わるか、判断を後回しにしたものだけが残ると、監視役が結果（ブランチ、PR、残っていること）を表にまとめて報告します。

## 設定

既定のままで使えます。変えたいときは、状態のフォルダに `config.json` を置きます（ひな形は [`config.example.json`](config.example.json)）。

| | 状態のフォルダ |
| --- | --- |
| Claude Code | `~/.claude/session-manager-mcp/` |
| Codex | `~/.codex/session-manager/` |

環境変数 `CSM_HOME` で別の場所にすることもできます。

| キー | 既定 | 内容 |
| --- | --- | --- |
| `maxRunning` | `3` | 同時に動かす作業の会話の上限 |
| `minFreeMemGb` | `2` | 空きメモリ（GB）がこれを下回る間は、新しい会話を起こさない |
| `pauseAtPct` | `95` | 利用枠がこの % に達したら、新しく起こさず、動いている会話を止める |
| `watchIntervalMin` | `30` | 何も起きないときに監視役が起きる間隔（分、上限 60） |
| `pollSec` | `5` | 会話の状態を確かめる間隔（秒） |
| `defaults.model` / `defaults.effort` | — | 作業の会話のモデルとエフォート（省略時はそれぞれの既定） |

<details>
<summary>Claude Code・Codex だけの設定</summary>

| キー | 既定 | 内容 |
| --- | --- | --- |
| `claude.permissionMode` | `"acceptEdits"` | Claude Code の作業の会話の確認のモード（`default`・`acceptEdits`・`plan`・`auto`・`dontAsk`・`bypassPermissions`）。`acceptEdits` はファイルの編集だけを確認なしで行い、コマンドの実行などは確認待ちになります |
| `claude.path` | `"claude"` | Claude Code の CLI。シェルを通さずに起動するため、`.cmd` ではなく `claude.exe` か配列で指定します |
| `defaults.sandbox` | `"workspace-write"` | Codex の作業の会話のサンドボックス |
| `defaults.approvalPolicy` | `"never"` | Codex の作業の会話の承認。`never` なら承認待ちで止まりません（サンドボックスの外の操作は失敗し、AI が別の手を考えます） |
| `codexPath` | `"codex"` | Codex CLI。絶対パス、または `["node", "C:/…/codex.js"]` のような配列 |
| `transport` | `"daemon"` | `daemon` は Codex の共有デーモンを使います（おすすめ）。`embedded` はこの MCP サーバーの中で app-server を動かします（会話は監視役と一緒に止まります。試すときだけ） |

</details>

### 自分の決まりを足す

モデルの使い分けや、同時に動かす重い処理の数などは、状態のフォルダの `local-rules.md` に書くと、監視役が最初に読みます。書き方は [`local-rules.example.md`](skills/manage-sessions/local-rules.example.md) を参考にしてください。

自分で開いた会話にも報告の決まりを伝えたいときは、[`AGENTS.snippet.md`](AGENTS.snippet.md) の中身を `~/.claude/CLAUDE.md`（Codex は `~/.codex/AGENTS.md`）の末尾に足します。

### 見回りの間隔と利用枠

見回りの間、会話の状態を確かめているのは MCP サーバーで、モデルは使いません。報告や状態の変化があればすぐに監視役が起きて対応します。

何も起きないときは `watchIntervalMin` ごとに監視役が起き、そのたびに会話の全体を読み直します。間隔を短くするほど、変化がなくても利用枠を使います（1分ごとなら1時間に60回、30分ごとなら2回）。上限を60分にしているのは、それより長いと読み直しのときに会話のキャッシュが切れ、かえって高くつくためです。一時的に短くしたいときは、監視役に「見回りは10分ごとに」と頼めます。

## 更新とアンインストール

| | 更新 | アンインストール |
| --- | --- | --- |
| Claude Code | `claude plugin update inline-agent-orchestrator@inline-agent-orchestrator` を実行して、起動し直す | 監視役に「status line を元に戻して」と頼んでから、`claude plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator` |
| Codex | 置いたフォルダで `git pull` と `node src/setup.mjs codex` を実行して、起動し直す | `~/.codex/config.toml` の `[mcp_servers.session-manager]` と、`~/.agents/skills/manage-sessions/` を消す |

## 仕組み

```text
あなた ── 依頼 ──▶ 監視役の会話（Skill: manage-sessions）
                         │  MCP の道具を呼ぶ
                         ▼
                session-manager（この MCP サーバー）
                │                              │
     Codex のとき                       Claude Code のとき
     codex app-server（共有デーモン）    claude --bg / agents / logs / stop
                │                              │
                ├── 作業の会話 A ── report ──▶ reports.jsonl ──▶ 監視役が受け取る
                └── 作業の会話 B
```

Claude Code にも Codex にも、AI が別の会話を操作するための道具は標準では用意されていません。この MCP サーバーは、それぞれの公式の仕組み（Codex は app-server の JSON-RPC、Claude Code は CLI）を道具の形にまとめたものです。

| | Codex | Claude Code |
| --- | --- | --- |
| 作業の会話が動く所 | Codex の共有 app-server デーモン | Claude Code のバックグラウンドセッション（agent view） |
| 監視役を閉じたとき | 作業の会話は動き続ける | 作業の会話は動き続ける |
| 動いている会話への連絡 | ターンの後に回る（割り込みも可） | MCP サーバーが預かり、ターンが終わってから届ける |
| 利用枠の読み方 | app-server から | status line が書く `usage.json` から |

- 作業の会話からの報告は、同じ MCP サーバーの `report` 道具がファイルに書き、監視役が読みます。Claude Code の作業の会話には `report` だけを見せ、監視役の道具は外しています
- Claude Code の利用枠は CLI からは読めず、status line に渡される値が唯一の公式の読み口です。そのため初回に status line を設定します。元の status line は控えておき、その表示を出し続けます
- Claude Code の作業の会話は、編集の前に `.claude/worktrees/` に worktree を作り、その中で作業します（agent view の既定の動き）

<details>
<summary>道具の一覧</summary>

| 道具 | 使う会話 | 内容 | Codex（app-server） | Claude Code（CLI） |
| --- | --- | --- | --- | --- |
| `list_sessions` | 監視役 | 管理中、または全部の会話の一覧と状態 | `thread/read`・`thread/list` | `claude agents --json` |
| `read_session` | 監視役 | 最近のやりとり | `thread/turns/list` | `claude logs` |
| `start_session` | 監視役 | 会話を起こし、名前を付けて最初の依頼を送る。上限を越えるときは起こさず理由を返す | `thread/start`・`turn/start` | `claude --bg` |
| `send_message` | 監視役 | 動いている会話にはターンの後に、止まっている会話には続きとして送る | `thread/queue/add`・`turn/start`・`turn/steer` | 預かってから `claude --resume --bg` |
| `stop_session` | 監視役 | 動いているターンを止める | `turn/interrupt` | `claude stop` |
| `set_session_name` | 監視役 | 名前を変える | `thread/name/set` | 記録のみ |
| `get_usage` | 監視役 | 利用枠・空きメモリ・動いている数と、新しく起こしてよいか | `account/rateLimits/read` | `usage.json` |
| `update_session` | 監視役 | 記録（状態・メモ・保留）を書き換える | `state.json` | `state.json` |
| `wait_events` | 監視役 | 状態の変化・報告・承認待ち・メモリ不足・利用枠の超過と回復を待つ | `thread/read` | `claude agents --json` |
| `read_reports` | 監視役 | 報告を読む | `reports.jsonl` | `reports.jsonl` |
| `report` | 作業の会話 | 監視役へ報告を書く | `reports.jsonl` | `reports.jsonl` |

呼び出し方は、公式の説明（Codex は `learn.chatgpt.com/docs/app-server` と openai/codex の型定義、Claude Code は `code.claude.com/docs` の CLI・agent view・status line・プラグインの項）に合わせています。

</details>

## 制約と注意

- **承認は代行しません** — 作業の会話が承認や入力を待つと、監視役は開き方を伝えるだけです。Claude Code の既定（`acceptEdits`）では、コマンドの実行で確認待ちになります
- **見回りは監視役のターンの中で行います** — 動いている会話がなくなると見回りを終え、次に話しかけたときに再開します
- **見張るのは会話の数とメモリまでです** — 開発サーバーの本数など、個々のプロセスは数えません。必要な決まりは `local-rules.md` に書いてください
- **Codex の作業の会話には全部の道具が見えます** — 利用者全体の設定から MCP サーバーを読み込むためです。最初の依頼で「`report` 以外は使わない」と伝えています
- **Claude Code で動いている会話への連絡は、ターンが終わってから届きます** — 止めた会話に預かっていた連絡は届けずに捨てます
- **報告の受け渡しは同じ PC の中だけです**
- **試験的な機能の上に成り立っています** — Codex の app-server の一部と Claude Code の agent view は試験的な機能で、版が上がると動きが変わることがあります
- **デスクトップアプリとの関係は未確認です** — 作業の会話がアプリの一覧に出るかは確かめていません。動いている間は、アプリから同じ会話を続けないでください

## 動作確認

実際の Claude Code・Codex ではまだ動かしていないため、最初に次の手順をお試しください。使う会話は1つ、利用枠は短い依頼1回分です。うまくいかない手順があれば、そこで止めて「[問題を報告するとき](#問題を報告するとき)」の情報を残してください。

<details>
<summary>Claude Code（C1〜C6）</summary>

| # | 確かめること | 手順 | うまくいかないとき |
| --- | --- | --- | --- |
| C1 | 入ったか | `claude plugin list` に出るか。会話で `/mcp` を開き、プラグインの `session-manager` がつながっているか | `node --version` が 20 以上か確かめる |
| C2 | 道具と利用枠 | `/inline-agent-orchestrator:manage-sessions` → status line の設定を了承 → 少し待ってから「`get_usage` を呼んで」→ 利用枠（5h・weekly）と空きメモリが出るか | `~/.claude/settings.json` の `statusLine` と `~/.claude/session-manager-mcp/usage.json` を見る |
| C3 | 会話を起こせるか | 試すフォルダで一度 `claude` を起動し、フォルダを信頼しておく。そのうえで「`start_session` で名前『試し』、作業フォルダはそのフォルダ、依頼は『ファイルを数えて report で報告して』」→ `claude agents` に「試し」が出るか | 道具が返したエラーの文を見る |
| C4 | 報告が届くか | `wait_events` で `report`（done）が届くか。`claude attach <ID>` → `/mcp` で、作業の会話に `session-report` が見え、監視役の道具が使えないか | `~/.claude/session-manager-mcp/worker-mcp.json` を見る |
| C5 | 動いている会話への連絡 | 長めの依頼の途中で `send_message` → `delivery: queued`、終わった後の `wait_events` で `queuedDelivered` になり、同じ会話で続くか | 別の ID で続いたら `copiedTo` が出る |
| C6 | 見回り中に話しかけられるか | `wait_events` の最中に Esc → 見回りが止まって返事をするか。次の `wait_events` で、止めていた間の出来事が返るか | `watchIntervalMin` を短くして使う |

後片付け: `claude stop <ID>`、`claude rm <ID>`、`update_session`（remove）

</details>

<details>
<summary>Codex（V1〜V5）</summary>

| # | 確かめること | 手順 | うまくいかないとき |
| --- | --- | --- | --- |
| V1 | Codex の版 | `codex --version` が 0.162 以上か。`codex app-server proxy --help` が出るか | CLI を新しくする |
| V2 | 共有デーモンが動くか | 管理者でない PowerShell（Windows）で `codex app-server daemon start` → `codex agents` が開くか | `config.json` に `"transport": "embedded"` を書いて試す |
| V3 | 道具がつながるか | 監視役の会話で「`get_usage` を呼んで」→ 利用枠と空きメモリが出るか | 道具が返したエラーの文を見る |
| V4 | 会話を起こせるか | 「`start_session` で名前『試し』、作業フォルダは空のフォルダ、依頼は『ファイルを数えて report で報告して』」→ `codex agents` に出るか、`wait_events` で報告が届くか | デスクトップアプリに出ない場合は `codex resume <ID>` で見る |
| V5 | 動いている会話への連絡 | 長めの依頼の途中で `send_message` → 割り込まずにターンの後で読まれるか。`wait_events` の最中に打った文がどう扱われるか | 割り込むなら、`local-rules.md` に「止まっているときだけ送る」と書く |

後片付け: `codex archive <ID>`、`update_session`（remove）、必要なら `codex app-server daemon stop`

</details>

### よくあるエラー

| 表示 | 対処 |
| --- | --- |
| `Workspace not trusted`（Claude Code） | 作業フォルダで一度 `claude` を起動し、フォルダを信頼する |
| `claude agents --json returned something that is not JSON`（Claude Code） | CLI を新しくする。agent view の状態は `claude daemon status` で確かめる |
| `daemon start failed`（Codex） | Windows では管理者の PowerShell から起動できません。`CODEX_HOME` のパスが長すぎる場合も起動できません |
| `thread/queue/add を使えません`（Codex） | Codex を新しくする |
| 見回りがタイムアウトする（Codex） | `node src/setup.mjs codex` をもう一度実行する（`tool_timeout_sec` を直します） |

### 問題を報告するとき

次の情報があると、原因を追いやすくなります。

- うまくいかなかった手順（C1〜C6、V1〜V5）と、`claude --version` または `codex --version`、`node --version` の出力
- エラーの文、またはコマンドの出力の全部
- 状態のフォルダの `state.json`・`reports.jsonl`・`config.json`。Claude Code は `worker-mcp.json`・`usage.json`・`statusline.json` も
- Claude Code は `claude plugin list` の出力、Codex は `config.toml` の `[mcp_servers.session-manager]` の部分

## 開発

```bash
npm test
```

| パス | 内容 |
| --- | --- |
| `src/server.mjs` | MCP サーバー（標準入出力、JSON-RPC 2.0） |
| `src/tools.mjs` | 道具、上限の判定、見回り |
| `src/backends/` | Codex（app-server）と Claude Code（CLI）それぞれの実装 |
| `src/setup.mjs` | 導入のスクリプト（Codex の登録と Skill、Claude Code の status line） |
| `src/claude-statusline.mjs` | Claude Code の利用枠を記録する status line |
| `src/appserver.mjs` / `src/ws.mjs` | Codex app-server のクライアント（Windows の Node は Unix ソケットを開けないため、`codex app-server proxy` 経由の WebSocket で通信） |
| `skills/manage-sessions/` | 監視役の手順（Skill） |
| `.claude-plugin/` | Claude Code のプラグインとマーケットプレイスの定義 |
| `test/` | Codex・Claude Code の CLI と app-server の代わりを使った単体テスト |

<details>
<summary>プラグインを使わずに Claude Code へ入れる</summary>

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/tools/inline-agent-orchestrator
claude mcp add session-manager --scope user -e CSM_AGENT=claude -- node $HOME/tools/inline-agent-orchestrator/src/server.mjs
node $HOME/tools/inline-agent-orchestrator/src/setup.mjs statusline
```

Skill は `skills/manage-sessions/` を `~/.claude/skills/` に写し、`/manage-sessions` で呼び出します。

</details>

## ライセンス

[MIT](LICENSE)
