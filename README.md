# Inline Agent Orchestrator

[English](README.en.md) | 日本語

**頼みたい作業が何件あっても、話しかけるのはひとつのチャットだけ。**

Claude Code や Codex で作業を並行して進めるとき、セッションをいくつも開いて、1つずつ様子を見て回っていませんか。Inline Agent Orchestrator を入れると、いつものチャットがまとめ役になります。作業ごとにセッションを立ち上げて進み具合を見守り、判断が必要なことだけをまとめて聞いてきます。画面も操作も、いつもの Claude Code・Codex のままです。

> [!NOTE]
> 試作版（v0.7.0）です。単体テストは通過していますが、実際の Claude Code・Codex での動作検証はまだ行っていません。ご利用の前に「[動作確認](#動作確認)」の手順をお試しください。

## 特長

- **いつもの画面のまま** — 専用のアプリや画面はありません。Claude Code・Codex をそのまま使います。tmux や常駐のサービスも要りません
- **作業ごとにセッションを用意** — 頼んだ内容を作業ごとに分け、それぞれに名前・作業フォルダ・モデルを決めて、別々のセッションで進めます
- **質問はまとめて、おすすめ付きで** — 各セッションからの「どうしますか？」を集め、選択肢とおすすめを添えて一度に聞きます。返事をすれば、それぞれの作業が続きから進みます
- **デスクトップアプリのサイドバーに並ぶ** — Claude Code のデスクトップアプリでは、作業セッションがアプリの会話として起動し、オーケストレーターの下に並びます。動いている間はピン留めされ、終わると外れます（[デスクトップアプリで使う](#デスクトップアプリで使う)）
- **PC と利用枠に無理をさせない** — 同時に動かす数は決めず、空きメモリと CPU に余裕があるかぎり起動します。利用枠の上限に達して止まった作業は、枠が戻ったあとに続きから再開させます（[利用枠の上限](#利用枠の上限)）
- **止まった作業も立て直す** — エラーで落ちたセッションや、途中で止まったセッションに気づき、続きから進めるよう頼み直します
- **入れるのは Node.js だけ** — ほかのパッケージを必要とせず、軽く動きます

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

動作環境: Claude Code 2.1.275 以降、Node.js 20 以降

ターミナルで起動した Claude Code のチャット欄に、次のコマンドを入力します。

```text
/plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

マーケットプレイスの追加を確認されたら承認し、続く画面で「Install for you」を選ぶと、そのまま使えるようになります。

デスクトップアプリと VS Code のチャット欄では、このコマンドは使えません。代わりにターミナルで次のコマンドを実行し、アプリを再起動してください（Claude Code 2.1.292 以降）。インストールしたプラグインは、ターミナル・デスクトップアプリ・VS Code のどれからでも使えます。

```bash
claude plugin install inline-agent-orchestrator --marketplace horiu/inline-agent-orchestrator
```

VS Code では、チャット欄に `/plugins` と入力して開く画面からもインストールできます。Marketplaces タブで `horiu/inline-agent-orchestrator` を追加し、Plugins タブでインストールします。

Claude Code では、既定で利用枠を読まずに動きます（[利用枠の上限](#利用枠の上限)）。`pauseAtPct` を設定してターミナルで使う場合だけ、使用量を読み取るための status line の設定を求められます。許可すると設定され、現在の status line の表示はそのまま残ります。デスクトップアプリでは status line が表示されないため、設定しても使用量は読み取れません。

<details>
<summary>Claude Code 2.1.257〜2.1.274 をお使いの場合</summary>

チャット欄に次のコマンドを順に入力します。

```text
/plugin marketplace add horiu/inline-agent-orchestrator
```

```text
/plugin install inline-agent-orchestrator@inline-agent-orchestrator
```

</details>

### Codex

動作環境: Codex CLI 0.162 以降（デスクトップアプリのみを使う場合も必要です）、Node.js 20 以降、git

ターミナルで次のコマンドを順に実行します。

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/.codex/inline-agent-orchestrator
```

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex
```

Codex を再起動すれば準備完了です。セットアップスクリプトは MCP サーバーを `~/.codex/config.toml` に登録し（変更前のファイルは `config.toml.bak-<日時>` として保存します）、スキルを `~/.agents/skills/manage-sessions/` にインストールします。

## 使い方

### 始め方

新しいセッションのチャット欄に次のコマンドを入力し、続けて依頼したい作業を伝えます。

| | コマンド |
| --- | --- |
| Claude Code | `/inline-agent-orchestrator:manage-sessions` |
| Codex | `$manage-sessions` |

オーケストレーターが作業を分割し、作業用のセッションを起動して監視を始めます。「PR を作成するまで」「調査して報告するまで」のように、どこまで進めるかを添えると、途中で止まらずに進みます。

オーケストレーターのセッションには `<リポジトリ名> Manager`（例: `wakarium Manager`）という名前が付きます。リポジトリ名は作業フォルダの git リポジトリの名前で、worktree の中でも元のリポジトリの名前になります（git の外では作業フォルダの名前）。Claude Code のデスクトップアプリでは自動で付きます。ターミナルの Claude Code では外から名前を変えられないため、案内に従ってチャット欄に `/rename <リポジトリ名> Manager` と入力してください。

### デスクトップアプリで使う

Claude Code のデスクトップアプリ（Code タブ）でオーケストレーターを動かすと、作業セッションはアプリの会話として起動します。

- **サイドバーに並ぶ** — 作業セッションはオーケストレーターの下に並び、クリックで開いて直接話しかけられます。アプリが作業セッションごとに worktree とブランチを作ります
- **動いている間はピン留め** — 管理中で動いている作業セッションはピン留めされ、終わる（done）と外れます。終わったセッションは、最後の報告のあとにアーカイブするか聞かれます（アーカイブすると worktree も片付きます）
- **リモートから頼んだとき** — Remote Control（スマートフォンや claude.ai）から頼んだときなど、アプリが作業セッションの起動を受け付けない場合は、起動の提案カードを出します。PC のアプリでカードを押すと始まります
- **利用枠は読みません** — デスクトップアプリでは status line が表示されないため、使用量を理由に止める設定（`pauseAtPct`）は効きません

ターミナルの Claude Code では、従来どおり `claude --bg` のバックグラウンドセッションで起動します。デスクトップアプリから `claude --bg` を使う場合（「`via: bg` で起動して」と依頼）は、ターミナルで `claude` を起動して `/login` しておく必要があります（アプリのログインは CLI には効きません）。バックグラウンドセッションはアプリのサイドバーに表示されず、ピン留めもできません。

### 実行中

- **追加の作業もオーケストレーターへ** — 同じ箇所を扱っているセッションがあればそこへ追加し、関係がなければ新しいセッションを起動します
- **作業中のセッションを確認する** — Claude Code では `claude agents` で一覧を表示し、`claude attach <ID>` で開きます。Codex では `codex agents` と `codex resume <ID>` を使います。開いたセッションに直接指示することもできます
- **モデルやエフォートを変える** — 「fix-login はもっと深く考えさせて」「設計が終わったら実装用の設定に切り替えて」のように依頼すると、次の指示から切り替わります
- **オーケストレーターに話しかける** — 監視中は応答が遅れることがあります。急ぐ場合は停止ボタン（Claude Code では Esc）で監視を止めてから入力してください。止めている間の出来事も失われず、次の監視で受け取ります
- **監視をやめる** — 停止ボタン（Claude Code では Esc）で監視を止めてから、「監視をやめて」と伝えます。作業用のセッションはそのまま動き続け、「見回って」と伝えると監視を再開します。作業用のセッションも止める場合は「全部止めて」と伝えます

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
| `minFreeMemGb` | `2` | 空きメモリ（GB）がこの値を下回っている間は、新しいセッションを起動しない |
| `maxCpuPct` | `90` | CPU の使用率（%、1秒間の平均）がこの値以上の間は、新しいセッションを起動しない。`null` で CPU を見ない |
| `pauseAtPct` | Claude Code: `null`<br>Codex: `95` | 使用量がこの割合（%）に達したら、新しいセッションを起動せず、実行中のセッションを止める。`null` では利用枠を理由に止めない。数値はどちらにも効き、`{ "claude": 90 }` のように書くと片方だけ変わる（[利用枠の上限](#利用枠の上限)） |
| `watchIntervalMin` | `30` | 変化がないときにオーケストレーターが応答する間隔（分、最大 60） |
| `pollSec` | `5` | セッションの状態を確認する間隔（秒）。報告はこの間隔を待たずにすぐ受け取る |
| `stopWhenStuckMin` | `120` | 進められる作業がない状態（どのセッションも判断・承認・入力か、メモリ・CPU の空きを待っている）がこの時間（分）続いたら、監視を終える。利用枠の回復待ちは数えない。`null` で終えない（[進められる作業がないとき](#進められる作業がないとき)） |
| `profiles` | 下記 | 作業の種類ごとのモデルとエフォート |
| `defaults.model` / `defaults.effort` | — | プロファイルを使わないときのモデルとエフォート（省略時は各ツールの既定値） |

同時に実行する数の上限（以前の `maxRunning`）はなくなりました。`config.json` に残っていても無視します。

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

報告は、書き込まれるとすぐに受け取ります（ファイルの変更通知を使います）。通知が届かない環境（ネットワークドライブなど）でも、`pollSec` ごとに読み直すので取りこぼしません。状態の確認（Claude Code では `claude agents --json`）は1回 0.25 秒ほどで、5秒ごとなら CPU の1コアの約5%を使います。リアルタイムで作業するため、既定では遅れの少なさを優先しています。

変化がない場合は `watchIntervalMin` ごとにオーケストレーターが応答し、そのたびに会話全体を読み直します。間隔を短くするほど、変化がなくても使用量を消費します（1分間隔なら1時間に60回、30分間隔なら2回）。最大を60分としているのは、それより長いと読み直しの際にプロンプトキャッシュが切れ、かえってコストが増えるためです。一時的に短くしたい場合は、「監視は10分ごとにして」のように依頼できます。

### 進められる作業がないとき

どのセッションも判断・承認・入力か、メモリ・CPU の空きを待っていて、進められる作業がない状態が `stopWhenStuckMin`（既定 2時間）続くと、オーケストレーターは監視を自分で終えます。待っていても何も起きないまま、使用量と CPU を使い続けないためです。判断待ちだけが残ったときも、すぐには終えずにこの時間まで待ちます。利用枠の回復を待っている間は、待てば再開できるので終えません。報告・状態の変化・オーケストレーターからの指示があると、数え直します。

監視を終えるとき、オーケストレーターは次のことをします。

- 止まった理由と、待っているもの（質問は選択肢とおすすめを付けてまとめ、承認待ちには開き方を付けます）、再開のしかたを伝えます
- データフォルダに引き継ぎメモ `handoff.md`（管理中のセッション・決めたこと・次にやること）を書きます
- 通知のツールが使える場合は、一言通知します

その後、何か入力すると、オーケストレーターは引き継ぎメモと最新の状態を読み、入力に答えてから監視に戻ります。「見回って」と言わなくても戻ります。ただし「監視をやめて」「全部止めて」で止めた場合は、「見回って」と言うか新しい作業を頼むまで戻りません。

オーケストレーターは自分で会話を圧縮できません（`/compact` は利用者が入力するコマンドです）。会話が長くなった場合は、圧縮の代わりに引き継ぎメモを使います。「引き継ぎメモを書いて」と頼んでから、新しいセッションで manage-sessions を始めると、メモを読んで続きから進めます。

### 利用枠の上限

実行中のセッションを途中で止めても、一時停止にはなりません。実行中のターンは打ち切られ、そのターンで読んだ内容や考えた途中経過は失われます。これは利用枠の上限に達して止まった場合と同じです。作業ツリーに書いたコードは、どちらの場合も残ります。

- **Claude Code（既定: 止めない）** — 上限に達すると作業セッションもオーケストレーターも止まります。オーケストレーターのセッションは、Claude Code の「制限リセット時に自動的に続行する」で再開します。再開後、オーケストレーターは利用制限で止まった作業セッションを見つけて、`git status`・`git diff` を確認して続きから進めるよう依頼します
- **Codex（既定: 95% で止める）** — 上限で止まった Codex のオーケストレーターがリセット時に自動で再開するかは確認していないため、従来どおり上限の手前で作業セッションを止めます。オーケストレーターには枠が残るので、監視はモデルを使わずに続き、枠が戻ると再開を依頼します

残りの枠を別の作業に使いたいなど、上限の手前で止めたい場合は、`config.json` の `pauseAtPct` に割合を書くか、オーケストレーターに「90% で止めて」のように伝えてください。Claude Code で使用量を読むには status line の設定が必要で、デスクトップアプリでは使えません。

以前の `config.example.json` を写した `config.json` には `"pauseAtPct": 95` が残っており、Claude Code でも 95% で止めます。止めない場合は、その行を消すか `{ "claude": null }` に書き換えてください。

## 更新とアンインストール

### Claude Code

**更新**: チャット欄に `/plugin` と入力し、Installed タブでこのプラグインを開いて「Update now」を選びます。新しい版は次のセッションから使われます。今のセッションで使うには、チャット欄に `/reload-plugins` と入力します。

このプラグインは、標準では自動で更新されません。自動で更新したい場合は、`/plugin` の Marketplaces タブで `inline-agent-orchestrator` を選び、「Enable auto-update」を選びます。

**アンインストール**: まずチャット欄でオーケストレーターに「status line を元に戻して」と依頼します。続けて、チャット欄に次のコマンドを入力し、開いた画面でアンインストールを確定します。

```text
/plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator
```

ターミナルでは、`claude plugin update inline-agent-orchestrator@inline-agent-orchestrator`（更新）と `claude plugin uninstall inline-agent-orchestrator@inline-agent-orchestrator`（アンインストール）を使います。

### Codex

**更新**: ターミナルで次のコマンドを順に実行し、Codex を再起動します。

```bash
git -C $HOME/.codex/inline-agent-orchestrator pull
```

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex
```

**アンインストール**: ターミナルで次のコマンドを実行し、Codex を再起動します。MCP サーバーの登録とスキルが外れます（変更前の `config.toml` は `config.toml.bak-<日時>` として保存します）。

```bash
node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex --remove
```

このツールのフォルダ（`~/.codex/inline-agent-orchestrator`）と監視の記録（`~/.codex/session-manager`）は残ります。不要であれば削除してください。

## 仕組み

```text
あなた ── 依頼 ──▶ オーケストレーター（スキル: manage-sessions）
                          │  MCP ツールを呼び出す
                          ▼
                 session-manager（この MCP サーバー）
                 │                              │
          Codex の場合                    Claude Code の場合
     codex app-server（共有デーモン）    claude --bg / agents / logs / stop
                 │                       （デスクトップアプリでは、起動・指示・ピン留めを
                 │                         オーケストレーターがアプリのツールで行い、
                 │                         状態は claude agents から読む）
                 │                              │
                 ├── 作業セッション A ── report ──▶ reports.jsonl ──▶ オーケストレーターが受信
                 └── 作業セッション B
```

Claude Code にも Codex にも、AI が別のセッションを操作するためのツールは標準では用意されていません。この MCP サーバーは、それぞれの公式の仕組み（Codex は app-server の JSON-RPC、Claude Code は CLI）をツールとして提供します。

| | Codex | Claude Code（デスクトップアプリ） | Claude Code（ターミナル） |
| --- | --- | --- | --- |
| 作業セッションの実行場所 | Codex の共有 app-server デーモン | アプリの会話（サイドバーに表示） | バックグラウンドセッション（agent view） |
| 起動・指示・停止 | MCP サーバー | オーケストレーターがアプリのツール（`mcp__ccd_*`）で行う | MCP サーバー |
| オーケストレーターを閉じた場合 | 作業セッションは動き続ける | 作業セッションは動き続ける | 作業セッションは動き続ける |
| 実行中のセッションへの指示 | 現在のターンの後に処理される（割り込みも可能） | アプリが保持し、ターンの終了後に届ける | MCP サーバーが保持し、ターンの終了後に届ける |
| 使用量の取得方法 | app-server から取得 | 取得しない | status line が書き出す `usage.json` から取得 |

- MCP サーバーはアプリのツールを呼べないため、デスクトップアプリでは `start_session` がアプリに渡す値を返し、オーケストレーターがアプリの `start_session` で起動して、`update_session` で記録します。状態は `claude agents --json` の会話の行（busy・idle）で見ます。アプリの会話の ID（`local_…`）と Claude Code のセッション ID は別のため、最初は題名で探し、作業セッションの `report` が送るセッション ID で結び付けます

- 作業セッションからの報告は、報告専用の `session-report` 接続の `report` ツールがファイルに書き込み、オーケストレーターが読み取ります。Claude Code・Codex ともに、この接続では `report` だけを公開し、作業セッションの `session-manager` は無効にしています。ただし、デスクトップアプリの作業セッションには起動時に接続を足せないため、プラグインの `session-manager` の `report` を使います（ほかのツールは使わないよう依頼に書きます）。アプリの会話には起動時に許可するツールを渡せないため、プラグインのフック（`hooks/hooks.json`、PreToolUse）がこの `report` だけを確認なしで許可します（報告用のファイルに追記するだけのツールです）
- 空きメモリ・CPU・利用枠が足りずに起動を待たせた作業があるあいだは、監視を続けて資源を見回り、余裕ができるとオーケストレーターに知らせて起動させます
- Claude Code の使用量は CLI からは取得できず、status line に渡される値が唯一の公式な取得手段です。そのため `pauseAtPct` を使う場合は status line を設定します。元の status line は保存しておき、その表示を引き続き出力します。デスクトップアプリは status line を表示しないため、使用量は記録されません
- Claude Code の作業セッションが利用制限で止まったかは、`claude logs` の末尾にある「Usage limit reached」などの文面から推定します（`read_session` の `usageLimit`）。文面は公開された仕様ではないため、変わると見分けられなくなります
- Claude Code の作業セッションは、編集の前に `.claude/worktrees/` に worktree を作成し、その中で作業します（agent view の既定の動作）

<details>
<summary>ツール一覧</summary>

| ツール | 使用するセッション | 説明 | Codex（app-server） | Claude Code（CLI） |
| --- | --- | --- | --- | --- |
| `list_sessions` | オーケストレーター | 管理中、またはすべてのセッションの一覧と状態 | `thread/read`・`thread/list` | `claude agents --json` |
| `read_session` | オーケストレーター | 最近のやり取り | `thread/turns/list` | `claude logs` |
| `start_session` | オーケストレーター | プロファイル（またはモデル・エフォート）を指定してセッションを起動し、名前を付けて最初の依頼を送る。メモリ・CPU・使用量に余裕がない場合は起動せず、理由を返す。デスクトップアプリでは起動せず、アプリに渡す値を返す | `thread/start`・`turn/start` | `claude --bg` |
| `send_message` | オーケストレーター | 実行中のセッションにはターンの後に、停止中のセッションには続きとして送る。モデルやエフォートの変更も可能 | `thread/queue/add`・`turn/start`・`turn/steer` | 保持した後に `claude --resume --bg` |
| `stop_session` | オーケストレーター | 実行中のターンを停止する | `turn/interrupt` | `claude stop` |
| `set_session_name` | オーケストレーター | 名前を変更する | `thread/name/set` | 記録のみ |
| `get_usage` | オーケストレーター | 使用量・空きメモリ・CPU・実行数、新しく起動できるかどうか（`pauseAtPct` があるときは使用量も見る）、起動のしかた（`launcher`）、プロファイルの一覧 | `account/rateLimits/read` | `usage.json` |
| `update_session` | オーケストレーター | 記録（状態・メモ・保留・資源待ち・アプリの会話の追加）を更新する | `state.json` | `state.json` |
| `wait_events` | オーケストレーター | 状態の変化・報告（書き込まれたらすぐ）・承認待ち・メモリ不足・使用量の超過（`pauseAtPct` があるとき）と回復・資源待ちの作業を起動できる余裕を待つ。進められる作業がない状態が続くと、待っているものの一覧を返して終える | `thread/read` | `claude agents --json` |
| `read_reports` | オーケストレーター | 報告を読む | `reports.jsonl` | `reports.jsonl` |
| `report` | 作業セッション | オーケストレーターへ報告する | `reports.jsonl` | `reports.jsonl` |

各呼び出しは公式ドキュメント（Codex は `learn.chatgpt.com/docs/app-server` と openai/codex の型定義、Claude Code は `code.claude.com/docs` の CLI・agent view・status line・プラグインの各ページ）に準拠しています。

</details>

## 制限事項

- **承認の代行はしません** — 作業セッションが承認や入力を待っている場合、オーケストレーターは開き方を案内するだけです。Claude Code の既定（`acceptEdits`）では、コマンドの実行時に確認待ちになります
- **監視はオーケストレーターのターン内で行います** — 実行中のセッションがなくなるか、進められる作業がない状態が続くと監視を終了し、次に話しかけたときに再開します
- **監視の対象は空きメモリと CPU のみです** — 開発サーバーの数など、個々のプロセスは数えません。必要なルールは `local-rules.md` に記述してください
- **Codex の作業セッションは報告専用の接続を使います** — このツールが起動したセッションでは、`session-report` の `report` だけを承認なしで使えます。`session-manager` はその作業セッション内で無効にし、他の MCP サーバーの承認設定とサンドボックスは変えません。監視役から再開するときも報告設定を適用し直します。旧版のセッションが別の端末や監視プロセスに接続中の場合は、その接続を閉じ、共有デーモンから解放されてから再開してください
- **Claude Code の実行中のセッションへの指示は、ターンの終了後に届きます** — 停止したセッション宛てに保持していた指示は破棄します
- **報告のやり取りは同じ PC 内に限られます**
- **実験的な機能を利用しています** — Codex の app-server の一部と Claude Code の agent view は実験的な機能のため、バージョンアップで動作が変わる可能性があります
- **`claude --bg` のセッションはデスクトップアプリに表示されません** — アプリの一覧に出ず、ピン留めもできません。デスクトップアプリではアプリの会話で起動します
- **デスクトップアプリでは、作業セッションを起動できるのは利用者が入力したターンの中だけです** — オーケストレーターはそのターンのまま監視を続け、次の作業もそこで起動します。監視を止めたあと、アプリの知らせで再開したときなどは、起動の提案カードを出します
- **Claude Code の作業セッションがリセット時に自動で続行するかは未確認です** — 続行しない場合も、オーケストレーターが再開後に続きを依頼します
- **新しい作業フォルダは、先に PC で信頼しておく必要があります（Claude Code）** — `claude --bg` は信頼の確認を表示できません。信頼はリポジトリごとに記録され、親フォルダを信頼しても下のリポジトリには効きません。リモート（Remote Control・スマートフォン）から使う場合は、信頼済みのリポジトリを作業フォルダにしてください

## 動作確認

実際の Claude Code・Codex での検証がまだのため、まず次の手順をお試しください。使用するセッションは1つ、使用量は短い依頼1回分です。うまくいかない手順があれば、その時点で止めて「[不具合の報告](#不具合の報告)」に挙げた情報を控えてください。

<details>
<summary>Claude Code（C1〜C6）</summary>

| # | 確認項目 | 手順 | うまくいかない場合 |
| --- | --- | --- | --- |
| C1 | インストール | チャット欄で `/plugin` を開き、Installed タブに表示されるか。`/mcp` を開き、プラグインの `session-manager` が接続されているか | `node --version` が 20 以上か確認する |
| C2 | ツールと使用量 | `/inline-agent-orchestrator:manage-sessions` を実行 → 「`get_usage` を呼んで」と依頼 → 空きメモリが表示され、`pauseAtPct` が `null` か。使用量も試す場合は、`config.json` に `"pauseAtPct": { "claude": 95 }` を書いてターミナルで実行し、status line の設定を許可 → しばらく待ってから同じ依頼 → 使用量（5h・weekly）が表示されるか | `~/.claude/settings.json` の `statusLine` と `~/.claude/session-manager-mcp/usage.json` を確認する |
| C3 | セッションの起動 | 試すフォルダで一度 `claude` を起動し、フォルダを信頼しておく。その後「`start_session` で、名前は『試し』、作業フォルダはそのフォルダ、依頼は『ファイル数を数えて report で報告して』」と依頼 → `claude agents` に「試し」が表示されるか | ツールが返したエラーメッセージを確認する |
| C4 | 報告の受信 | `wait_events` で `report`（done）を受信できるか。`claude attach <ID>` → `/mcp` で、作業セッションに `session-report` が表示され、オーケストレーター用のツールが使えないか | `~/.claude/session-manager-mcp/worker-mcp.json` を確認する |
| C5 | 実行中のセッションへの指示 | 長めの依頼の実行中に `send_message` → `delivery: queued` となり、終了後の `wait_events` で `queuedDelivered` となって、同じセッションで続くか | 別の ID で続いた場合は `copiedTo` が表示される |
| C6 | 監視中の割り込み | `wait_events` の実行中に Esc → 監視が止まって応答するか。次の `wait_events` で、停止中の出来事を受け取れるか | `watchIntervalMin` を短くして使う |

後片付け: `claude stop <ID>`、`claude rm <ID>`、`update_session`（remove）

</details>

<details>
<summary>Claude Code デスクトップアプリ（D1〜D3）</summary>

| # | 確認項目 | 手順 | うまくいかない場合 |
| --- | --- | --- | --- |
| D1 | 起動とピン留め | アプリの Code タブで `/inline-agent-orchestrator:manage-sessions` を実行 → 「名前は『試し』、依頼は『ファイル数を数えて report で報告して』で作業セッションを起こして」と依頼 → サイドバーのオーケストレーターの下に「試し」が表示され、ピン留めされるか | `get_usage` の `launcher` が `app` か確認する |
| D2 | 報告と状態 | `wait_events` で `report`（done）を受信し、ピン留めが外れるか。`list_sessions` で「試し」の状態が `idle` になるか | `claude agents --json` に「試し」の行（kind `interactive`）があるか確認する |
| D3 | 次の作業 | 続けて別の作業を頼む → 新しい作業セッションが起動するか | アプリが起動を断った場合は、提案カードが表示されるか確認する |

後片付け: アプリでセッションをアーカイブ、`update_session`（remove）

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
| `Workspace not trusted`・「信頼されていない」（Claude Code） | PC のターミナルで作業フォルダに移って一度 `claude` を起動し、信頼の確認で承認する。信頼はリポジトリごとで、親フォルダの信頼は効かない |
| 「CLI がログインしていない」（Claude Code） | `claude --bg` を使うには、ターミナルで `claude` を起動して `/login` する。デスクトップアプリでは、アプリの会話で起動すればログインは不要 |
| `claude agents --json returned something that is not JSON`（Claude Code） | CLI を更新する。agent view の状態は `claude daemon status` で確認できる |
| `daemon start failed`（Codex） | Windows では、管理者権限の PowerShell からは起動できません。`CODEX_HOME` のパスが長すぎる場合も起動できません |
| `thread/queue/add を使えません`（Codex） | Codex を更新する |
| 監視がタイムアウトする（Codex） | ターミナルで `node $HOME/.codex/inline-agent-orchestrator/src/setup.mjs codex` を再実行する（`tool_timeout_sec` が修正されます） |

### 不具合の報告

次の情報があると、原因の調査がスムーズです。

- うまくいかなかった手順（C1〜C6、D1〜D3、V1〜V5）と、`claude --version` または `codex --version`、`node --version` の出力
- エラーメッセージ、またはコマンドの出力全体
- データフォルダ内の `state.json`・`reports.jsonl`・`config.json`。Claude Code の場合は `worker-mcp.json`・`usage.json`・`statusline.json` も
- Claude Code の場合はターミナルで実行した `claude plugin list` の出力、Codex の場合は `config.toml` の `[mcp_servers.session-manager]` セクション

## 開発

```bash
npm test
```

版を上げるときは、`.claude-plugin/plugin.json` と `package.json` の `version` を同じ値にして main に入れます。タグ（`v<版>`）と GitHub のリリースは自動で作られます。

| パス | 説明 |
| --- | --- |
| `src/server.mjs` | MCP サーバー（標準入出力、JSON-RPC 2.0） |
| `src/tools.mjs` | ツール、上限の判定、監視 |
| `src/backends/` | Codex（app-server）と Claude Code（CLI）それぞれの実装 |
| `src/setup.mjs` | セットアップスクリプト（Codex への登録とスキルのインストール、Claude Code の status line の設定） |
| `src/allow-report.mjs` / `hooks/hooks.json` | デスクトップアプリの作業セッションの `report` を確認なしで許可するフック |
| `src/claude-statusline.mjs` | Claude Code の使用量を記録する status line |
| `src/appserver.mjs` / `src/ws.mjs` | Codex app-server のクライアント（Windows の Node.js は Unix ドメインソケットを扱えないため、`codex app-server proxy` 経由の WebSocket で通信） |
| `skills/manage-sessions/` | オーケストレーターの手順（スキル） |
| `.claude-plugin/` | Claude Code のプラグインとマーケットプレイスの定義 |
| `test/` | Codex・Claude Code の CLI と app-server を模したモックによる単体テスト |

<details>
<summary>プラグインを使わずに Claude Code にインストールする</summary>

ターミナルで次のコマンドを順に実行します。

```bash
git clone https://github.com/horiu/inline-agent-orchestrator.git $HOME/.claude/inline-agent-orchestrator
```

```bash
claude mcp add session-manager --scope user -e CSM_AGENT=claude -- node $HOME/.claude/inline-agent-orchestrator/src/server.mjs
```

```bash
node $HOME/.claude/inline-agent-orchestrator/src/setup.mjs statusline
```

スキルは `skills/manage-sessions/` を `~/.claude/skills/` にコピーし、`/manage-sessions` で呼び出します。

</details>

## ライセンス

[MIT](LICENSE)
