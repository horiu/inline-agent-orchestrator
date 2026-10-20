# Inline Agent Orchestrator

[English](README.en.md) | 日本語

**Claude Code・Codex の普段のセッションを、そのままオーケストレーターに。**

複数の作業をまとめて1つのセッションに依頼すると、そのセッションがオーケストレーターとして動きます。作業ごとに別のセッションを起動して進捗を監視し、判断が必要な点だけをまとめて確認します。新しいアプリや画面を覚える必要はありません。

> [!NOTE]
> 試作版（v0.4.0）です。単体テストは通過していますが、実際の Claude Code・Codex での動作検証はまだ行っていません。ご利用の前に「[動作確認](#動作確認)」の手順をお試しください。

## 特長

- **普段の画面のまま使える** — Claude Code・Codex 標準のセッションと CLI だけで動作します。専用アプリや常駐サービス、tmux は不要です
- **セッションを自動で起動** — 作業ごとに名前・作業フォルダ・モデルを決め、作業用のセッションを起動して依頼します
- **確認事項は一度にまとめて** — 各セッションからの質問を集約し、選択肢とおすすめを添えて確認します
- **PC と使用量の上限を守る** — 同時実行数、空きメモリ、5時間・週ごとの使用量を見ながら、無理のない範囲で並行して進めます。上限が近づいたら一時停止し、回復したら再開します
- **止まったセッションを立て直す** — 異常終了したセッションや途中で止まったセッションを検知し、続きを依頼します
- **軽量** — Node.js だけで動作し、依存パッケージはありません

## 使用例

```text
👤 ログインの不具合を修正して、PR まで作成してください。
   あわせて、依存ライブラリを更新できるか調べて報告してください。

🤖 2つのセッションに分けて進めます。
   ・fix-login   … 不具合の修正 → テスト → PR の作成
   ・deps-survey … 調査して報告
   監視を開始します。

   （しばらくして）

🤖 fix-login から確認があります。有効期限が切れたセッションでは、再ログインを求めますか？
   それとも自動で延長しますか？
   おすすめは「再ログインを求める」です（現在の画面と同じ動作です）。

👤 おすすめでお願いします。

🤖 すべての作業が完了しました。
   | セッション  | 結果                               |
   | fix-login   | PR #42 を作成（テストを追加）      |
   | deps-survey | 3件は更新可能、1件は破壊的変更あり |
```

## クイックスタート

### Claude Code

動作環境: Claude Code 2.1.292 以降、Node.js 20 以降

```bash
claude plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

Claude Code を再起動すれば準備完了です。初めて使うときに、使用量を読み取るための status line の設定を求められます。許可すると設定され、現在の status line の表示はそのまま残ります。

<details>
<summary>Claude Code 2.1.257〜2.1.291 をお使いの場合</summary>

```bash
claude plugin marketplace add horiu/inline-agent-orchestrator
claude plugin install inline-agent-orchestrator@inline-agent-orchestrator
```

</details>

### Codex

動作環境: Codex CLI 0.162 以降（デスクトップアプリのみを使う場合も必要です）、Node.js 20 以降、git

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/tools/inline-agent-orchestrator
node $HOME/tools/inline-agent-orchestrator/src/setup.mjs codex
```

Codex を再起動すれば準備完了です。セットアップスクリプトは MCP サーバーを `~/.codex/config.toml` に登録し（変更前のファイルは `config.toml.bak-<日時>` として保存します）、スキルを `~/.agents/skills/manage-sessions/` にインストールします。

## 使い方

### 始め方

新しいセッションで次のコマンドを入力し、続けて依頼したい作業を伝えます。

| | コマンド |
| --- | --- |
| Claude Code | `/inline-agent-orchestrator:manage-sessions` |
| Codex | `$manage-sessions` |

オーケストレーターが作業を分割し、作業用のセッションを起動して監視を始めます。「PR を作成するまで」「調査して報告するまで」のように、どこまで進めるかを添えると、途中で止まらずに進みます。

### 実行中

- **追加の作業もオーケストレーターへ** — 同じ箇所を扱っているセッションがあればそこへ追加し、関係がなければ新しいセッションを起動します
- **作業中のセッションを確認する** — Claude Code では `claude agents` で一覧を表示し、`claude attach <ID>` で開きます。Codex では `codex agents` と `codex resume <ID>` を使います。開いたセッションに直接指示することもできます
- **モデルやエフォートを変える** — 「fix-login はもっと深く考えさせて」「設計が終わったら実装用の設定に切り替えて」のように依頼すると、次の指示から切り替わります
- **オーケストレーターに話しかける** — 監視中は応答が遅れることがあります。急ぐ場合は停止ボタン（Claude Code では Esc）で監視を止めてから入力してください。止めている間の出来事も失われず、次の監視で受け取ります

### 完了後

すべての作業が終わるか、判断を保留した項目だけが残ると、オーケストレーターが結果（ブランチ、PR、残作業）を表にまとめて報告します。

## 設定

既定値のままで使えます。変更したい場合は、データフォルダに `config.json` を置きます（テンプレート: [`config.example.json`](config.example.json)）。

| | データフォルダ |
| --- | --- |
| Claude Code | `~/.claude/session-manager-mcp/` |
| Codex | `~/.codex/session-manager/` |

環境変数 `CSM_HOME` で場所を変更することもできます。

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `maxRunning` | `3` | 同時に実行する作業セッションの上限 |
| `minFreeMemGb` | `2` | 空きメモリ（GB）がこの値を下回っている間は、新しいセッションを起動しない |
| `pauseAtPct` | `95` | 使用量がこの割合（%）に達したら、新しいセッションを起動せず、実行中のセッションを一時停止する |
| `watchIntervalMin` | `30` | 変化がないときにオーケストレーターが応答する間隔（分、最大 60） |
| `pollSec` | `5` | セッションの状態を確認する間隔（秒） |
| `profiles` | 下記 | 作業の種類ごとのモデルとエフォート |
| `defaults.model` / `defaults.effort` | — | プロファイルを使わないときのモデルとエフォート（省略時は各ツールの既定値） |

<details>
<summary>Claude Code・Codex 固有の設定</summary>

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `claude.permissionMode` | `"acceptEdits"` | Claude Code の作業セッションの権限モード（`default`・`acceptEdits`・`plan`・`auto`・`dontAsk`・`bypassPermissions`）。`acceptEdits` ではファイルの編集のみ確認なしで実行し、コマンドの実行などは確認待ちになります |
| `claude.path` | `"claude"` | Claude Code CLI のパス。シェルを経由せずに起動するため、`.cmd` ではなく `claude.exe` または配列で指定します |
| `defaults.sandbox` | `"workspace-write"` | Codex の作業セッションのサンドボックス |
| `defaults.approvalPolicy` | `"never"` | Codex の作業セッションの承認ポリシー。`never` では承認待ちで止まりません（サンドボックス外の操作は失敗し、AI が別の方法を探します） |
| `codexPath` | `"codex"` | Codex CLI のパス。絶対パス、または `["node", "C:/…/codex.js"]` のような配列 |
| `transport` | `"daemon"` | `daemon` は Codex の共有デーモンを使用します（推奨）。`embedded` はこの MCP サーバー内で app-server を起動します（作業セッションはオーケストレーターと一緒に停止します。検証用） |

</details>

### モデルとエフォートの使い分け

オーケストレーターは、作業の種類に合ったプロファイルを選んでセッションを起動します。既定では次のおすすめの設定が入っています。

| プロファイル | 用途 | Claude Code | Codex |
| --- | --- | --- | --- |
| `design` | 設計・方式の検討 | Opus・xhigh | xhigh |
| `debug` | 原因の分からない不具合の調査 | Opus・high | high |
| `implement` | 通常の実装・修正 | Opus・medium | medium |
| `review` | コードレビュー | Opus・high | high |
| `writing` | ドキュメントや画面の文言の作成・修正 | Sonnet・high | high |
| `routine` | 手順の決まった作業・確認 | Sonnet・medium | medium |

- 判断に迷う作業では、強い方のプロファイルを選びます。性能が足りずにやり直すほうが、結果的に高くつくためです
- 原因の調査が1回で絞り込めない場合は、途中でエフォートを xhigh に上げます
- Codex のモデル名はリリースごとに変わるため、Codex ではエフォートだけを指定し、モデルは Codex の既定値を使います

設定を変えたい場合は、`config.json` の `profiles` に同じ名前で書くと置き換わり、`null` にすると削除できます。新しい名前のプロファイルを追加することもできます。

```json
{
  "profiles": {
    "design": {
      "description": "設計・方式の検討",
      "claude": { "model": "opus", "effort": "max" },
      "codex": { "model": "<モデル名>", "effort": "xhigh" }
    },
    "routine": null
  }
}
```

### 独自のルールを追加する

プロファイルの例外や、重い処理の同時実行数などのルールは、データフォルダの `local-rules.md` に書いておくと、オーケストレーターが最初に読み込みます。書き方は [`local-rules.example.md`](skills/manage-sessions/local-rules.example.md) を参考にしてください。

自分で開いたセッションにも報告のルールを伝えたい場合は、[`AGENTS.snippet.md`](AGENTS.snippet.md) の内容を `~/.claude/CLAUDE.md`（Codex では `~/.codex/AGENTS.md`）の末尾に追記します。

### 監視間隔と使用量

監視中にセッションの状態を確認しているのは MCP サーバーで、モデルは使用しません。報告や状態の変化があれば、すぐにオーケストレーターが応答します。

変化がない場合は `watchIntervalMin` ごとにオーケストレーターが応答し、そのたびに会話全体を読み直します。間隔を短くするほど、変化がなくても使用量を消費します（1分間隔なら1時間に60回、30分間隔なら2回）。最大を60分としているのは、それより長いと読み直しの際にプロンプトキャッシュが切れ、かえってコストが増えるためです。一時的に短くしたい場合は、「監視は10分ごとにして」のように依頼できます。

## 更新とアンインストール

| | 更新 | アンインストール |
| --- | --- | --- |
| Claude Code | `claude plugin update inline-agent-orchestrator@inline-agent-orchestrator` を実行して再起動 | オーケストレーターに「status line を元に戻して」と依頼してから、`claude plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator` を実行 |
| Codex | インストール先で `git pull` と `node src/setup.mjs codex` を実行して再起動 | `~/.codex/config.toml` の `[mcp_servers.session-manager]` と、`~/.agents/skills/manage-sessions/` を削除 |

## 仕組み

```text
あなた ── 依頼 ──▶ オーケストレーター（スキル: manage-sessions）
                          │  MCP ツールを呼び出す
                          ▼
                 session-manager（この MCP サーバー）
                 │                              │
          Codex の場合                    Claude Code の場合
     codex app-server（共有デーモン）    claude --bg / agents / logs / stop
                 │                              │
                 ├── 作業セッション A ── report ──▶ reports.jsonl ──▶ オーケストレーターが受信
                 └── 作業セッション B
```

Claude Code にも Codex にも、AI が別のセッションを操作するためのツールは標準では用意されていません。この MCP サーバーは、それぞれの公式の仕組み（Codex は app-server の JSON-RPC、Claude Code は CLI）をツールとして提供します。

| | Codex | Claude Code |
| --- | --- | --- |
| 作業セッションの実行場所 | Codex の共有 app-server デーモン | Claude Code のバックグラウンドセッション（agent view） |
| オーケストレーターを閉じた場合 | 作業セッションは動き続ける | 作業セッションは動き続ける |
| 実行中のセッションへの指示 | 現在のターンの後に処理される（割り込みも可能） | MCP サーバーが保持し、ターンの終了後に届ける |
| 使用量の取得方法 | app-server から取得 | status line が書き出す `usage.json` から取得 |

- 作業セッションからの報告は、同じ MCP サーバーの `report` ツールがファイルに書き込み、オーケストレーターが読み取ります。Claude Code の作業セッションには `report` ツールだけを公開し、オーケストレーター用のツールは無効にしています
- Claude Code の使用量は CLI からは取得できず、status line に渡される値が唯一の公式な取得手段です。そのため初回に status line を設定します。元の status line は保存しておき、その表示を引き続き出力します
- Claude Code の作業セッションは、編集の前に `.claude/worktrees/` に worktree を作成し、その中で作業します（agent view の既定の動作）

<details>
<summary>ツール一覧</summary>

| ツール | 使用するセッション | 説明 | Codex（app-server） | Claude Code（CLI） |
| --- | --- | --- | --- | --- |
| `list_sessions` | オーケストレーター | 管理中、またはすべてのセッションの一覧と状態 | `thread/read`・`thread/list` | `claude agents --json` |
| `read_session` | オーケストレーター | 最近のやり取り | `thread/turns/list` | `claude logs` |
| `start_session` | オーケストレーター | プロファイル（またはモデル・エフォート）を指定してセッションを起動し、名前を付けて最初の依頼を送る。上限を超える場合は起動せず、理由を返す | `thread/start`・`turn/start` | `claude --bg` |
| `send_message` | オーケストレーター | 実行中のセッションにはターンの後に、停止中のセッションには続きとして送る。モデルやエフォートの変更も可能 | `thread/queue/add`・`turn/start`・`turn/steer` | 保持した後に `claude --resume --bg` |
| `stop_session` | オーケストレーター | 実行中のターンを停止する | `turn/interrupt` | `claude stop` |
| `set_session_name` | オーケストレーター | 名前を変更する | `thread/name/set` | 記録のみ |
| `get_usage` | オーケストレーター | 使用量・空きメモリ・実行数、新しく起動できるかどうか、プロファイルの一覧 | `account/rateLimits/read` | `usage.json` |
| `update_session` | オーケストレーター | 記録（状態・メモ・保留）を更新する | `state.json` | `state.json` |
| `wait_events` | オーケストレーター | 状態の変化・報告・承認待ち・メモリ不足・使用量の超過と回復を待つ | `thread/read` | `claude agents --json` |
| `read_reports` | オーケストレーター | 報告を読む | `reports.jsonl` | `reports.jsonl` |
| `report` | 作業セッション | オーケストレーターへ報告する | `reports.jsonl` | `reports.jsonl` |

各呼び出しは公式ドキュメント（Codex は `learn.chatgpt.com/docs/app-server` と openai/codex の型定義、Claude Code は `code.claude.com/docs` の CLI・agent view・status line・プラグインの各ページ）に準拠しています。

</details>

## 制限事項

- **承認の代行はしません** — 作業セッションが承認や入力を待っている場合、オーケストレーターは開き方を案内するだけです。Claude Code の既定（`acceptEdits`）では、コマンドの実行時に確認待ちになります
- **監視はオーケストレーターのターン内で行います** — 実行中のセッションがなくなると監視を終了し、次に話しかけたときに再開します
- **監視の対象はセッション数とメモリのみです** — 開発サーバーの数など、個々のプロセスは数えません。必要なルールは `local-rules.md` に記述してください
- **Codex の作業セッションからはすべてのツールが見えます** — ユーザー全体の設定から MCP サーバーを読み込むためです。最初の依頼で「`report` 以外は使わない」よう指示しています
- **Claude Code の実行中のセッションへの指示は、ターンの終了後に届きます** — 停止したセッション宛てに保持していた指示は破棄します
- **報告のやり取りは同じ PC 内に限られます**
- **実験的な機能を利用しています** — Codex の app-server の一部と Claude Code の agent view は実験的な機能のため、バージョンアップで動作が変わる可能性があります
- **デスクトップアプリとの連携は未検証です** — 作業セッションがアプリの一覧に表示されるかは確認していません。実行中は、アプリから同じセッションを続けないでください

## 動作確認

実際の Claude Code・Codex での検証がまだのため、まず次の手順をお試しください。使用するセッションは1つ、使用量は短い依頼1回分です。うまくいかない手順があれば、その時点で止めて「[不具合の報告](#不具合の報告)」に挙げた情報を控えてください。

<details>
<summary>Claude Code（C1〜C6）</summary>

| # | 確認項目 | 手順 | うまくいかない場合 |
| --- | --- | --- | --- |
| C1 | インストール | `claude plugin list` に表示されるか。セッションで `/mcp` を開き、プラグインの `session-manager` が接続されているか | `node --version` が 20 以上か確認する |
| C2 | ツールと使用量 | `/inline-agent-orchestrator:manage-sessions` を実行 → status line の設定を許可 → しばらく待ってから「`get_usage` を呼んで」と依頼 → 使用量（5h・weekly）と空きメモリが表示されるか | `~/.claude/settings.json` の `statusLine` と `~/.claude/session-manager-mcp/usage.json` を確認する |
| C3 | セッションの起動 | 試すフォルダで一度 `claude` を起動し、フォルダを信頼しておく。その後「`start_session` で、名前は『試し』、作業フォルダはそのフォルダ、依頼は『ファイル数を数えて report で報告して』」と依頼 → `claude agents` に「試し」が表示されるか | ツールが返したエラーメッセージを確認する |
| C4 | 報告の受信 | `wait_events` で `report`（done）を受信できるか。`claude attach <ID>` → `/mcp` で、作業セッションに `session-report` が表示され、オーケストレーター用のツールが使えないか | `~/.claude/session-manager-mcp/worker-mcp.json` を確認する |
| C5 | 実行中のセッションへの指示 | 長めの依頼の実行中に `send_message` → `delivery: queued` となり、終了後の `wait_events` で `queuedDelivered` となって、同じセッションで続くか | 別の ID で続いた場合は `copiedTo` が表示される |
| C6 | 監視中の割り込み | `wait_events` の実行中に Esc → 監視が止まって応答するか。次の `wait_events` で、停止中の出来事を受け取れるか | `watchIntervalMin` を短くして使う |

後片付け: `claude stop <ID>`、`claude rm <ID>`、`update_session`（remove）

</details>

<details>
<summary>Codex（V1〜V5）</summary>

| # | 確認項目 | 手順 | うまくいかない場合 |
| --- | --- | --- | --- |
| V1 | Codex のバージョン | `codex --version` が 0.162 以上か。`codex app-server proxy --help` が表示されるか | CLI を更新する |
| V2 | 共有デーモンの起動 | 管理者権限のない PowerShell（Windows）で `codex app-server daemon start` を実行 → `codex agents` が開くか | `config.json` に `"transport": "embedded"` を設定して試す |
| V3 | ツールの接続 | オーケストレーターのセッションで「`get_usage` を呼んで」と依頼 → 使用量と空きメモリが表示されるか | ツールが返したエラーメッセージを確認する |
| V4 | セッションの起動 | 「`start_session` で、名前は『試し』、作業フォルダは空のフォルダ、依頼は『ファイル数を数えて report で報告して』」と依頼 → `codex agents` に表示されるか、`wait_events` で報告を受信できるか | デスクトップアプリに表示されない場合は `codex resume <ID>` で確認する |
| V5 | 実行中のセッションへの指示 | 長めの依頼の実行中に `send_message` → 割り込まずに、ターンの後で処理されるか。`wait_events` の実行中に入力した内容がどう扱われるか | 割り込む場合は、`local-rules.md` に「停止中のときだけ送る」と記述する |

後片付け: `codex archive <ID>`、`update_session`（remove）、必要に応じて `codex app-server daemon stop`

</details>

### よくあるエラー

| メッセージ | 対処 |
| --- | --- |
| `Workspace not trusted`（Claude Code） | 作業フォルダで一度 `claude` を起動し、フォルダを信頼する |
| `claude agents --json returned something that is not JSON`（Claude Code） | CLI を更新する。agent view の状態は `claude daemon status` で確認できる |
| `daemon start failed`（Codex） | Windows では、管理者権限の PowerShell からは起動できません。`CODEX_HOME` のパスが長すぎる場合も起動できません |
| `thread/queue/add を使えません`（Codex） | Codex を更新する |
| 監視がタイムアウトする（Codex） | `node src/setup.mjs codex` を再実行する（`tool_timeout_sec` が修正されます） |

### 不具合の報告

次の情報があると、原因の調査がスムーズです。

- うまくいかなかった手順（C1〜C6、V1〜V5）と、`claude --version` または `codex --version`、`node --version` の出力
- エラーメッセージ、またはコマンドの出力全体
- データフォルダ内の `state.json`・`reports.jsonl`・`config.json`。Claude Code の場合は `worker-mcp.json`・`usage.json`・`statusline.json` も
- Claude Code の場合は `claude plugin list` の出力、Codex の場合は `config.toml` の `[mcp_servers.session-manager]` セクション

## 開発

```bash
npm test
```

| パス | 説明 |
| --- | --- |
| `src/server.mjs` | MCP サーバー（標準入出力、JSON-RPC 2.0） |
| `src/tools.mjs` | ツール、上限の判定、監視 |
| `src/backends/` | Codex（app-server）と Claude Code（CLI）それぞれの実装 |
| `src/setup.mjs` | セットアップスクリプト（Codex への登録とスキルのインストール、Claude Code の status line の設定） |
| `src/claude-statusline.mjs` | Claude Code の使用量を記録する status line |
| `src/appserver.mjs` / `src/ws.mjs` | Codex app-server のクライアント（Windows の Node.js は Unix ドメインソケットを扱えないため、`codex app-server proxy` 経由の WebSocket で通信） |
| `skills/manage-sessions/` | オーケストレーターの手順（スキル） |
| `.claude-plugin/` | Claude Code のプラグインとマーケットプレイスの定義 |
| `test/` | Codex・Claude Code の CLI と app-server を模したモックによる単体テスト |

<details>
<summary>プラグインを使わずに Claude Code にインストールする</summary>

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/tools/inline-agent-orchestrator
claude mcp add session-manager --scope user -e CSM_AGENT=claude -- node $HOME/tools/inline-agent-orchestrator/src/server.mjs
node $HOME/tools/inline-agent-orchestrator/src/setup.mjs statusline
```

スキルは `skills/manage-sessions/` を `~/.claude/skills/` にコピーし、`/manage-sessions` で呼び出します。

</details>

## ライセンス

[MIT](LICENSE)
