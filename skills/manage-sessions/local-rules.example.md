# 利用者が足す決まり（例）

このファイルを `local-rules.md` という名前で状態のフォルダ（Codex は `~/.codex/session-manager/`、Claude Code は `~/.claude/session-manager-mcp/`）に写して、自分の環境に合わせて書き換える。監視役は始めるときに読む。

## モデルとエフォートの使い分け

仕事の種類ごとのモデルとエフォートは `config.json` の `profiles` で決める（既定のおすすめが入っている）。ここには例外だけを書く。

- 本番の不具合の調査は、debug でも effort を xhigh にして始める
- ドキュメントの修正でも、仕様の説明を書き換えるものは writing ではなく design にする

## 重い処理

- 開発サーバー・ビルド・全件テストは同時に◯本まで
- 開発サーバーの起動前に `report` で一言

## ブランチと PR

- ブランチ名: `codex/<名前>`
- PR を作ったら本文の末尾に `@codex review` を書く（使っているなら）
