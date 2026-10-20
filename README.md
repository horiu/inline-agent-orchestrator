# inline-agent-orchestrator

1つの会話を「監視役」にして、ほかの会話（作業の会話）を自分で起こし・仕事を渡し・見回り・止め・再開させるための MCP サーバーと Skill です。**Codex と Claude Code のどちらでも使えます**（同じ道具・同じ手順。中身だけそれぞれの公式の仕組みに合わせています）。

- 監視役は、作業の会話を自分で起こし、名前・作業フォルダ・モデル・エフォートを付けて仕事を渡します（控えの会話を人が立てる必要はありません）
- 作業の会話は区切りごとに監視役へ報告し、利用者の判断が要るときは監視役に書いて待ちます。監視役はそれをまとめて利用者に聞きます
- 動いている会話の数・空きメモリ・利用枠（5時間・週）を見て、上限を越えるときは新しく動かしません。利用枠が上限に近づいたら止め、戻ったら再開させます
- 落ちた・途中で止まった会話を見つけて続きを頼みます
- 何も動いていなければ見回りをやめます

> 状態: 試作（0.2.0）。単体テストは通っていますが、実際の Codex・Claude Code ではまだ動かしていません。使う前に「[確かめること](#確かめること)」を行ってください。

## 仕組み

```text
利用者 ──依頼──▶ 監視役の会話（Skill: manage-sessions）
                     │ MCP の道具を呼ぶ
                     ▼
              session-manager（この MCP サーバー・Node・依存なし）
          Codex のとき │                         │ Claude Code のとき
                     ▼                         ▼
   codex app-server proxy → app-server デーモン     claude --bg / claude agents --json / claude logs / claude stop
                     │                         │
                     ├─ 作業の会話 A ──report──▶ reports.jsonl ──▶ 監視役が wait_events で受け取る
                     └─ 作業の会話 B
```

| | Codex | Claude Code |
| --- | --- | --- |
| 作業の会話が動く所 | Codex の共有の app-server デーモン | Claude Code のバックグラウンドセッション（agent view の supervisor） |
| 監視役の会話を閉じたら | 作業の会話は動き続ける | 作業の会話は動き続ける |
| 利用者が開く | `codex resume <ID>`・`codex agents` | `claude attach <短いID>`・`claude agents` |
| 状態の読み方 | app-server（`thread/read`） | `claude agents --json --all` の `state`・`status`・`waitingFor` |
| 動いている会話へ送る | 今のターンの後に回る（`thread/queue/add`）。割り込みもできる | MCP サーバーが預かり、終わったら `claude --resume <ID> --bg` で届ける |
| 利用枠 | app-server（`account/rateLimits/read`） | 監視役の status line が書く `usage.json`（下の設定が要る） |
| 状態のフォルダ | `~/.codex/session-manager/` | `~/.claude/session-manager-mcp/` |

- どちらにも「AI が別の会話を操作する道具」は標準ではありません。この MCP サーバーが、それぞれの公式の仕組み（Codex は app-server の JSON-RPC、Claude Code は CLI）を道具の形にしたものです
- 作業の会話からの報告は、同じ MCP サーバーの `report` 道具がファイル（`reports.jsonl`）に書き、監視役が読みます。Claude Code の作業の会話には、`report` だけを見せる設定（`CSM_ROLE=worker`）でこの MCP サーバーを `session-report` という名前で渡し（`--allowedTools` で確認なしに呼べる）、監視役用の `session-manager` は `--disallowedTools` で外しています。続きを頼むとき（`--resume`）も同じ設定で起こします

## Codex で使う

### 必要なもの

| もの | 版 | 備考 |
| --- | --- | --- |
| Codex CLI | 0.162 以上を推奨 | `codex app-server proxy`・`codex app-server daemon` を使う。デスクトップアプリだけを使っている PC でも CLI が要る |
| Node.js | 20 以上 | 依存パッケージは無し |
| OS | Windows・macOS・Linux | Windows はデーモンの制御ソケット（AF_UNIX）のパスが 108 バイト以内である必要がある（`CODEX_HOME` が長いと共有できない） |

版の差（openai/codex のリリース・ソースで確認）:

| 版 | 関係する変更 |
| --- | --- |
| 0.149.0（2026-08） | `codex agents`（共有デーモン上の会話の一覧）・`codex queue`（会話へ送る。中身は app-server の `thread/queue/add`） |
| 2026-09-05 | `codex mcp-server`（道具 `codex`・`codex-reply`）が削除。古い記事の「Codex を MCP で束ねる」方法は使えない |
| 0.162.0（2026-10） | Windows のデーモンの修正。PowerShell の入れ方が署名付きに |

### 入れ方

1. **Codex CLI を確かめる**（PowerShell）

   ```powershell
   codex --version
   codex app-server proxy --help
   ```

   無い・古いときは公式の入れ方（`learn.chatgpt.com/docs` の Windows の項）で入れ直す。デスクトップアプリに同梱の `codex.exe` を使うなら、そのパスを 4. の `codexPath` に書く

2. **このフォルダを置く**（例: `%USERPROFILE%\tools\inline-agent-orchestrator`）

   ```powershell
   git clone https://github.com/horiu/inline-agent-orchestrator.git $env:USERPROFILE\tools\inline-agent-orchestrator
   ```

3. **MCP サーバーを登録する**: `%USERPROFILE%\.codex\config.toml` に足す（デスクトップアプリ・CLI・IDE 拡張で共通の設定）

   ```toml
   [mcp_servers.session-manager]
   command = "node"
   args = ['C:\Users\<名前>\tools\inline-agent-orchestrator\src\server.mjs']
   startup_timeout_sec = 20
   tool_timeout_sec = 3720
   ```

   - `tool_timeout_sec`（Codex の既定は60秒）は、見回りの間隔（`watchIntervalMin`、既定30分。上限60分）より長くする。上の 3720 秒は上限の60分＋2分なので、間隔を変えても書き直さなくてよい。短いままだと、見回りが何も起きずに待っている途中で Codex が道具を打ち切り、エラーになる
   - 道具ごとに確認を出すかは `default_tools_approval_mode`（`auto`／`prompt`／`writes`／`approve`）と `tools.<道具>.approval_mode` で決める。会話を変えない道具（`list_sessions`・`read_session`・`get_usage`・`wait_events`・`read_reports`）には read-only の印が付いているので、`writes` にすると、会話を起こす・送る・止める・名前を変える道具と、記録を書く `update_session`・`report` にだけ確認が出る。見回りを任せきりにしたいなら `auto`

4. **設定（任意）**: `config.example.json` を `%USERPROFILE%\.codex\session-manager\config.json` に写して書き換える（キーは下の「[設定](#設定)」）

5. **Skill を入れる**: `skills\manage-sessions\` を `%USERPROFILE%\.agents\skills\manage-sessions\` へ写す。自分の決まり（モデルの使い分けなど）は `local-rules.example.md` を `local-rules.md` に写して書く。人が開いた会話にも報告の決まりを知らせたいときは、`AGENTS.snippet.md` の中身を `%USERPROFILE%\.codex\AGENTS.md` の末尾に足す

6. Codex を起動し直す（MCP の設定を読み直すため）。監視役にする会話で `$manage-sessions` と打つ

## Claude Code で使う

### 必要なもの

| もの | 版 | 備考 |
| --- | --- | --- |
| Claude Code CLI | 2.1.257 以上（バックグラウンドセッションの再開が同じ ID で続く版）。2.1.304 で引数を確認 | `claude --bg`・`claude agents --json`・`claude logs`・`claude stop` を使う。agent view は「research preview」の扱いで、動きが変わることがある |
| Node.js | 20 以上 | 依存パッケージは無し |

### 入れ方

1. **Claude Code CLI を確かめる**

   ```bash
   claude --version
   claude agents --help
   ```

2. **このフォルダを置く**（Codex と同じ場所でよい）

3. **MCP サーバーを登録する**（ユーザー全体に。`CSM_AGENT=claude` で Claude Code 用になる）

   ```bash
   claude mcp add session-manager --scope user -e CSM_AGENT=claude -- node C:/Users/<名前>/tools/inline-agent-orchestrator/src/server.mjs
   ```

   Claude Code は標準入出力の MCP サーバーの道具を既定で約28時間まで待つ（`MCP_TOOL_TIMEOUT`）ので、見回りの間隔のための設定は要らない

4. **利用枠を記録する status line を設定する**（Claude Code の利用枠は CLI からは読めず、status line に渡る `rate_limits` だけが公式の読み口のため）。`~/.claude/settings.json` に:

   ```json
   "statusLine": { "type": "command", "command": "node C:/Users/<名前>/tools/inline-agent-orchestrator/src/claude-statusline.mjs" }
   ```

   - 今の status line を残したいときは、`-- "<今のコマンド>"` を後ろに付ける（1つの引数として引用符で囲む。同じ入力を渡し、その出力を表示する）。このコマンドは OS のシェル（Windows は cmd.exe）で動くので、bash のスクリプトなら `"bash ~/.claude/statusline.sh"` のように書く。Windows の cmd.exe は `~` を展開せず、`bash` が WSL の起動口（`C:\Windows\System32\bash.exe`）に当たることもあるので、Git Bash とスクリプトをどちらもフルパスで書く（例: Git Bash の `bash.exe` のパスと `C:/Users/<名前>/.claude/statusline.sh`。空白を含むパスは引用符で囲む）
   - MCP サーバーに `CSM_HOME` を設定したときは、status line にも同じ値を渡す（違うと別のフォルダに書く）
   - 監視役の会話が開いている間、表示のたびに `~/.claude/session-manager-mcp/usage.json` が新しくなる。30分以上古いと `stale: true` が付き、枠が戻ったかの判断（`usageRecovered`）には使わない
   - 設定しないと `get_usage` の利用枠は読めず、枠による上限は効かない（会話の数と空きメモリの上限は効く）

5. **設定（任意）**: `config.example.json` を `~/.claude/session-manager-mcp/config.json` に写して書き換える

6. **Skill を入れる**: `skills/manage-sessions/` を `~/.claude/skills/manage-sessions/` へ写す。決まりは `local-rules.md` に。人が開いた会話にも知らせたいときは `AGENTS.snippet.md` の中身を `~/.claude/CLAUDE.md` の末尾に足す

7. 監視役にする会話で `/manage-sessions` と打つ

作業の会話は、Claude Code が編集の前に `.claude/worktrees/` に worktree を作ってそこで動きます（agent view の既定。プロジェクトの設定 `"worktree": { "bgIsolation": "none" }` で変わる）。

## 新しくするとき

1. 置いたフォルダで `git pull`
2. Codex・Claude Code を起動し直す（MCP サーバーを読み直すため）
3. Skill は写したものなので、入れ方の Skill の手順でもう一度写す（上書き）

## 設定

`config.json`（状態のフォルダ。Codex は `~/.codex/session-manager/`、Claude Code は `~/.claude/session-manager-mcp/`。環境変数 `CSM_HOME` で変えられる）

| キー | 既定 | 意味 |
| --- | --- | --- |
| `codexPath` | `"codex"` | Codex だけ。Codex CLI。絶対パス、または `["node", "C:/…/codex.js"]` のような配列 |
| `transport` | `"daemon"` | Codex だけ。`daemon`＝共有デーモン（おすすめ）／`embedded`＝この MCP サーバーの子として app-server を動かす（会話はこの MCP サーバーと一緒に止まる。試すときだけ） |
| `claude.path` | `"claude"` | Claude Code だけ。CLI の実行ファイル（シェルを通さずに起動するので、`.cmd` ではなく `claude.exe` か配列で） |
| `claude.permissionMode` | `"acceptEdits"` | Claude Code だけ。作業の会話の確認のモード（`default`・`acceptEdits`・`plan`・`auto`・`dontAsk`・`bypassPermissions`）。`acceptEdits` はファイルの編集だけ確認なしで、コマンドの実行などは確認待ちになる（利用者が `claude attach` で答える） |
| `maxRunning` | 3 | 同時に動かす作業の会話の上限 |
| `minFreeMemGb` | 2 | 空きメモリがこれを下回る間は新しく動かさない |
| `pauseAtPct` | 95 | 利用枠のどれかの窓がこの % 以上なら新しく動かさず、監視役は止める |
| `defaults.sandbox` | `"workspace-write"` | Codex だけ。作業の会話のサンドボックス |
| `defaults.approvalPolicy` | `"never"` | Codex だけ。作業の会話の承認。`never` なら承認待ちで止まらない（サンドボックスの外の操作は失敗し、AI が別の手を考える） |
| `defaults.model`・`defaults.effort` | なし | 省略時はそれぞれの既定 |
| `watchIntervalMin` | 30 | 見回りの間隔（分）。何も起きないとき、監視役がこの間隔で起きる。上限60（下の「見回りの間隔と利用枠」） |
| `pollSec` | 5 | MCP サーバーが会話の状態を確かめる間隔（秒）。モデルは使わない |

### 見回りの間隔と利用枠

- 見回り（`wait_events`）の間、状態を確かめるのは MCP サーバーで、モデルは使いません。報告・状態の変化・承認待ちなどが起きればすぐ戻り、監視役がそれを処理します
- 何も起きないときは `watchIntervalMin` ごとに戻り、監視役がもう一度呼び直します。このとき監視役のモデルが1回動き、会話の全部を読み直します。間隔を短くするほど、変化が無くても利用枠を使います（例: 1分ごとなら1時間に60回、30分ごとなら2回）
- 上限を60分にしているのは、間隔が長すぎると読み直しのときに会話のキャッシュが切れて高くつくためです
- 今回だけ短くしたいときは、監視役に「見回りは10分ごとに」のように頼みます（`wait_events` の `intervalMin`。設定より長くはできません）。ずっと変えるときは `config.json` の `watchIntervalMin` を書き換えます（次の見回りから効きます）

## 使い方

1. 監視役にする会話で Skill を呼び（Codex は `$manage-sessions`、Claude Code は `/manage-sessions`）、やりたいことを並べて頼む（例: 「A の不具合を直して PR まで、B の調査をして報告まで」）
2. 監視役が仕事を分けて作業の会話を起こし、見回りを始める。作業の会話は開いて様子を見たり、直接話したりできる（開き方は上の表）
3. 判断待ちは監視役がまとめて聞く。答えると、それぞれの会話へ伝わる
4. 思いついた修正は監視役へ投げる。同じ場所を触っている会話があればそこへ足し、無ければ新しく起こす
5. 全部終わると、監視役が結果（ブランチ・PR・残り）を表で報告する

### 道具

| 道具 | 使う会話 | すること | Codex（app-server） | Claude Code（CLI） |
| --- | --- | --- | --- | --- |
| `list_sessions` | 監視役 | 管理中の会話（scope managed）か、全部の会話（scope all）の一覧と状態 | `thread/read`・`thread/list` | `claude agents --json [--all] [--cwd]` |
| `read_session` | 監視役 | 最近のやりとり（依頼・返事・エラー・質問） | `thread/turns/list` | `claude logs <ID>` |
| `start_session` | 監視役 | 会話を起こし、名前を付けて最初の依頼を送る。上限を越えるときは起こさず理由を返す | `thread/start`・`thread/name/set`・`turn/start` | `claude --bg --name … --model … --effort … --permission-mode … --append-system-prompt … --mcp-config …` |
| `send_message` | 監視役 | 動いている会話には今のターンの後に回す。止まっている会話は続きから | `thread/queue/add`・`thread/resume`・`turn/start`・`turn/steer` | 預かって、止まったら `claude --resume <ID> --bg` |
| `stop_session` | 監視役 | 動いているターンを止める | `turn/interrupt` | `claude stop <ID>` |
| `set_session_name` | 監視役 | 名前を変える | `thread/name/set` | 記録だけ |
| `get_usage` | 監視役 | 利用枠・空きメモリ・動いている数・新しく動かしてよいか | `account/rateLimits/read` | `usage.json`（status line） |
| `update_session` | 監視役 | 記録（状態・メモ・触る場所・保留）を書き換える | state.json | state.json |
| `wait_events` | 監視役 | 状態の変化・報告・承認待ち・メモリ不足・利用枠の超過と回復を待つ。何も動いていなければすぐ idle | `thread/read` | `claude agents --json --all`（預かった連絡もここで届ける） |
| `read_reports` | 監視役 | 報告を読む | reports.jsonl | reports.jsonl |
| `report` | 作業の会話 | 監視役へ報告を書く | reports.jsonl | reports.jsonl |

- Codex の呼び出しは、公式の説明（`learn.chatgpt.com/docs/app-server`）と openai/codex の `codex-rs/app-server-protocol/schema/typescript` の型に合わせています。`thread/queue/add` は試験的な API で、接続のときに `experimentalApi` を有効にしています（`codex queue` と同じ）
- Claude Code の呼び出しは、公式の説明（`code.claude.com/docs/en/cli-reference`・`/agent-view`・`/statusline`）と `claude --help`（2.1.304）に合わせています

## できないこと・気をつけること

- **承認の代行はしない**: 作業の会話が承認や入力を待つと、監視役は利用者に開き方を伝えるだけです。Codex は既定の `approvalPolicy: never` なら承認待ちになりません。Claude Code は既定の `acceptEdits` だとコマンドの実行で確認待ちになり、`claude agents` で「Needs input」になります
- **監視役は自分では起きない**: 見回り（`wait_events`）は監視役のターンの中で道具を呼び続けて行います。何も動いていなければ見回りをやめてターンを終えるので、次は利用者が話しかけたときに再開します
- **見回り中に監視役へ話しかけるときは、先に止める**: 見回りの間、監視役は道具の呼び出しの途中にいるので、打った文は見回りが戻るまで（最長で見回りの間隔ぶん）読まれないことがあります。急ぐときは止めるボタン（Claude Code は Esc）で見回りを止めてから話しかけてください。止めても出来事は失われず、次の見回りで返ります
- **会話をまたいだ上限だけを見る**: 開発サーバーの本数など、個別のプロセスは数えません。空きメモリで代わりに見ています。決まりは `local-rules.md` に書いて監視役に守らせてください
- **作業の会話の道具の制限**: Claude Code の作業の会話には `report` だけを見せています。Codex の作業の会話は、利用者全体の設定で MCP サーバーを読むため、ほかの道具も見えます（最初の依頼と AGENTS.md で「`report` 以外は使わない」と伝えています）
- **Claude Code の報告は名前で結び付ける**: 起こす前は会話の ID が分からないため、作業の会話は名前（`from`）で報告します。名前は管理中の会話と重ねられません（保留の記録は除く）。`set_session_name` で名前を変えても、前の名前での報告は同じ会話に結び付きます
- **止めた会話に預かった連絡は捨てる**: Claude Code の会話を `stop_session` で止めると、監視役が預かっていた連絡は届けずに捨てます（結果の `droppedQueued` に件数）。止めた会話を勝手に動かさないためです
- **Claude Code へ動いている最中に送った連絡は、終わってから届く**: CLI に予約の仕組みが無いため、MCP サーバーが預かり、見回りのときに届けます。見回りをしていない間は届きません。`claude --resume <ID> --bg` を動いている会話に使うと写しが起きるため（`claude --help` の説明）、動いている間は送りません。写しが起きたときは記録を写しへ付け替えます
- **報告は同じ PC の中だけ**: `reports.jsonl` はローカルのファイルです。別の PC の会話とはつながりません
- **状態は定期的に読みに行って見る**: 作業の会話の状態は数秒ごとに確かめます（Codex は `thread/read`、Claude Code は `claude agents --json`）
- **止めても連絡は残る（Codex）**: `stop_session` で止めても、それまでに回した連絡は Codex の queue に残り、次に再開したときに読まれます（Claude Code は上のとおり捨てる）
- **`wait_events` は1つずつ**: 同時に呼ぶと前の呼び出しは打ち切られ（`cancelled`）、その分の出来事は次の呼び出しで返ります。道具の呼び出しが取り消されたとき（`notifications/cancelled`）も同じです
- **試験的な仕組みの上に乗っている**: Codex の app-server の一部と Claude Code の agent view は試験的です。版が上がると呼び方が変わることがあります。動かなくなったら下の確かめ方で切り分けてください
- **デスクトップアプリとの関係は未確認**: 作業の会話が Codex・Claude のデスクトップアプリの一覧に出るか、アプリで同時に開いて続けてよいかは確かめていません（2か所から同じ会話に書くことになるので、動いている間はアプリで続けないでください）

## 確かめること

この MCP サーバーは、まだ実際の Codex・Claude Code で動かしていません。使う方について、最初に次を順に確かめてください。落ちたら先へ進まず、下の「[落ちたときに控えるもの](#落ちたときに控えるもの)」を残してください（作る会話は1本、使う利用枠は短い依頼1回分です）。

### Codex

| # | 確かめること | やり方 | 分かれ目 |
| --- | --- | --- | --- |
| V1 | Codex の版 | `codex --version` が 0.162 以上か。`codex app-server proxy --help` が出るか | 出なければ CLI を新しくする |
| V2 | Windows で共有デーモンが動くか | 管理者でない PowerShell で `codex app-server daemon start`（JSON が1行出る）→ `codex agents` が開くか | 動かなければ `transport: "embedded"` で試す（会話は監視役の MCP と一緒に止まる） |
| V3 | 道具がつながるか | 監視役の会話で「`get_usage` を呼んで」→ 利用枠と空きメモリが出るか | 失敗したら道具の返すエラーの文を見る（`daemon start failed`／`handshake` など） |
| V4 | 会話を起こして送れるか・デスクトップアプリとの関係 | 「`start_session` で名前『試し』、作業フォルダは空のフォルダ、依頼は『このフォルダのファイルを数えて report で報告して』」→ `codex agents` に出るか、デスクトップアプリの一覧に出るか、`wait_events` で報告が届くか | アプリに出ない場合は、作業の会話は `codex resume <ID>` で見る |
| V5 | 動いている会話へ送ったときの挙動・監視役が待てるか | 長めの依頼の途中で `send_message`（mode auto）→ 割り込まずに今のターンの後で読まれるか。`wait_events` の間に利用者が監視役へ打った文がどう扱われるか | 割り込むなら「止まっているときだけ送る」決まりを `local-rules.md` に書く |

後片付け: 試しに起こした会話は `codex agents` か `codex archive <ID>` で片付け、`update_session`（remove）で記録から外す。デーモンを止めるときは `codex app-server daemon stop`。

### Claude Code

| # | 確かめること | やり方 | 分かれ目 |
| --- | --- | --- | --- |
| C1 | CLI の版 | `claude --version` が 2.1.257 以上か。`claude agents --help` に `--json` があるか | 無ければ `claude update` |
| C2 | 道具と利用枠 | 監視役の会話（status line を設定済み）で「`get_usage` を呼んで」→ 利用枠（5h・weekly）と空きメモリが出るか | 利用枠が無ければ status line の設定と `~/.claude/session-manager-mcp/usage.json` を見る |
| C3 | 会話を起こせるか | 先に、試しに使うフォルダで一度 `claude` を起動してフォルダを信頼しておく（`claude --bg` は信頼していないフォルダでは「Workspace not trusted」で止まる）。そのうえで「`start_session` で名前『試し』、作業フォルダはそのフォルダ、依頼は『このフォルダのファイルを数えて report で報告して』」→ `started: true`、`claude agents` に「試し」が出るか | 失敗したら道具の返すエラーの文（`claude --bg … failed` に CLI の文が付く）を見る。`--append-system-prompt`・`--mcp-config` を `--bg` が受け付けないなら、ここで分かる |
| C4 | 報告が届くか | 同じ会話で `wait_events` → `report`（done）が届くか。届かなければ `claude attach <短いID>` で `/mcp` を開き、作業の会話に `session-report` が見えているかを見る | 見えていなければ `--mcp-config` が効いていない（`~/.claude/session-manager-mcp/worker-mcp.json` の中身も見る） |
| C5 | 動いている会話へ送ったときの挙動 | 「試し」に長めの依頼を送り、動いている途中でもう一度 `send_message` → `delivery: queued`、終わったあとの `wait_events` で `queuedDelivered` になり、同じ会話（`claude agents` の ID が同じ）で続くか | 写し（別の ID）で続いたら `copiedTo` が出る。続け方として困るなら利用者に伝える |
| C6 | 見回り中に話しかけられるか | 「試し」が動いている間に監視役が `wait_events` で待っているところで Esc → 見回りが止まり、話しかけた文に答えるか。次の `wait_events` で、止めている間の出来事が返るか | Esc で止まらない・出来事が消えるなら、`watchIntervalMin` を短くして使う |

後片付け: `claude stop <短いID>`、`claude rm <短いID>`、`update_session`（remove）。

### 困ったとき

- `daemon start failed`（Codex）: Windows では管理者の PowerShell からは起動できない（openai/codex の `codex-rs/app-server-daemon/README.md` の注意）。`CODEX_HOME` が長いとソケットのパスが 108 バイトを越えて共有できない
- `thread/queue/add を使えません`（Codex）: Codex が古い。新しくするか、ターンが終わってから送る
- `claude --bg failed … Workspace not trusted`（Claude Code）: その作業フォルダで一度 `claude` を起動して信頼する
- `claude agents --json returned something that is not JSON`（Claude Code）: CLI が古いか、agent view の supervisor が応答していない（`claude daemon status`）
- 道具がタイムアウトする: Codex は `config.toml` の `tool_timeout_sec` を見回りの間隔（`watchIntervalMin` の分×60）より長くする

### 落ちたときに控えるもの

原因を調べるとき・不具合を報告するときに要るものです。

- どの確かめ（V1〜V5・C1〜C6）で落ちたかと、版（`codex --version`／`claude --version`）と `node --version` の出力
- 落ちたコマンドの出力の全部、または道具が返したエラーの文
- 状態のフォルダ（Codex は `~/.codex/session-manager/`、Claude Code は `~/.claude/session-manager-mcp/`）の `state.json`・`reports.jsonl`・`config.json`（あれば）。Claude Code は `worker-mcp.json`・`usage.json` も
- MCP サーバーの登録: Codex は `config.toml` の `[mcp_servers.session-manager]` の部分、Claude Code は `claude mcp get session-manager` の出力
- 作業の会話がデスクトップアプリの一覧に出たか、出たならアプリで開いたときに何が見えたか
- 画面の様子が要るものはスクリーンショット

## 開発

```bash
npm test
```

- `src/server.mjs`: MCP サーバー（標準入出力・JSON-RPC 2.0）。`CSM_AGENT=claude|codex` で相手を選び、`CSM_ROLE=worker` なら `report` だけを見せる
- `src/tools.mjs`: 道具・上限の判定・見回り（相手によらない部分）
- `src/backends/codex.mjs`: Codex の app-server での実装
- `src/backends/claude.mjs`: Claude Code の CLI での実装
- `src/claude-statusline.mjs`: Claude Code の利用枠を記録する status line
- `src/appserver.mjs`・`src/ws.mjs`: app-server の JSON-RPC クライアントと WebSocket のフレーム（デーモンの制御ソケットは WebSocket で話すため。Windows の Node は AF_UNIX を開けないので `codex app-server proxy` の標準入出力の上で話す）
- `src/state.mjs`: 設定・記録・報告のファイル
- `test/`: app-server の代わり（`fake-appserver.mjs`）、Codex CLI の代わり（`fake-codex.mjs`）、Claude Code CLI の代わり（`claude.test.mjs` の中）で単体テスト

## ライセンス

MIT（[LICENSE](LICENSE)）。
