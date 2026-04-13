[English](./README.md) | [日本語](./README.ja.md)

# claude-report

Claude Code の開発状況を Slack に自動投稿する plugin。開発者の作業を中断せずに、エンジニアリングマネージャーがチームの進捗をリアルタイムで把握できる。

## 概要

チームメンバーが Claude Code で開発すると、claude-report が主要イベント（git push、commit、PR 作成、テスト失敗、タスク完了）を検出し、共有 Slack チャンネルに構造化された更新を投稿する。プロジェクトごとに1日1スレッドが作成され、チャンネルが見やすく整理される。マネージャーがスレッドに返信すると、そのフィードバックは開発者の次の Claude Code セッションに自動的に反映される。

hook による確実なイベント検出、MCP tool による詳細な LLM 駆動の更新、`/report` slash command による手動投稿の3つの仕組みを組み合わせている。

## Quick Start

### 1. Slack App の作成

[api.slack.com/apps](https://api.slack.com/apps) で新しいアプリを **manifest から** 作成する。[`slack-app-manifest.json`](./slack-app-manifest.json) の内容を貼り付ける。ワークスペースにインストールし、**Bot User OAuth Token**（`xoxb-...`）をコピーする。

対象チャンネルに bot を招待する:

```
/invite @Claude Report
```

### 2. Plugin のインストール

```bash
claude plugin add claude-report
```

Claude Code が3つの値を聞いてくる:

| 入力項目 | 値 |
|---------|-----|
| **Slack Bot Token** | step 1 の `xoxb-...`（system keychain に保存される） |
| **Slack Channel ID** | Slack チャンネル詳細画面の channel ID（例: `C0AS7LC0X9B`） |
| **Display Name** | Slack 投稿に表示される名前 |

### 3. プロジェクトの登録

登録されたディレクトリのみ更新を投稿する。追跡したいプロジェクトで以下を実行:

```bash
cd ~/Projects/company-api
claude-report register

cd ~/Projects/mobile-app
claude-report register
```

これで完了。登録済みディレクトリで Claude Code を使うと、自動的にステータス更新が投稿される。

## 仕組み

**Deterministic hook**（確実に発火）:

| イベント | 検出方法 | Slack 投稿 |
|---------|---------|-----------|
| Git push | `git push` コマンド + 成功出力 | `Pushed to feat/auth` |
| Git commit | `git commit` + commit メッセージ | `Committed: fix auth bug` |
| PR 作成 | `gh pr create` + PR URL | `PR created: .../pull/42` |
| テスト失敗 | テストランナー + 失敗インジケーター | `Tests failing: 3 failures` |
| タスク完了 | Claude がタスクを完了としてマーク | `Task completed: Implement JWT auth` |

**MCP tool**（LLM 駆動、ベストエフォート）:

Claude が CLAUDE.md の指示に従い、適切なマイルストーンで `report_status`、`report_blocker`、`report_done` を呼び出す。hook よりも豊富なコンテキストを提供するが、発火は保証されない。

**マネージャーフィードバック loop**:

マネージャーが Slack スレッドに返信すると、`UserPromptSubmit` hook が返信を取得（キャッシュ付き、5分 TTL）し、開発者の次の Claude Code プロンプトに挿入する。

### Slack での表示

開発者ごとに**プロジェクト単位で1日1スレッド**が作成される:

```
Claude Report  12:07 PM
  Yuya Morita — 2026-04-12 · company-api
    Committed: fix auth bug                    (feat/auth)
    Pushed to feat/auth                        (3 files changed)
    Tests failing: 3 failures
    PR created: github.com/.../pull/42

Claude Report  12:07 PM
  Yuya Morita — 2026-04-12 · mobile-app
    Task completed: Implement push notifications
```

## 設定

### プロジェクト単位のオーバーライド

プロジェクトルートに `.claude-report.json` を作成:

```json
{
  "notifications": {
    "onGitPush": true,
    "onBlocker": true,
    "onCompletion": true,
    "verbosity": "normal"
  },
  "rateLimit": {
    "minIntervalMs": 600000,
    "maxPerSession": 10,
    "maxPerDay": 30
  }
}
```

| Field | Type | Default | 説明 |
|-------|------|---------|------|
| `notifications.enabled` | `boolean` | `true` | 投稿のマスタースイッチ |
| `notifications.onGitPush` | `boolean` | `true` | git push 時に投稿 |
| `notifications.onBlocker` | `boolean` | `true` | テスト失敗時に投稿 |
| `notifications.onCompletion` | `boolean` | `true` | タスク/PR 完了時に投稿 |
| `notifications.verbosity` | `string` | `"normal"` | `"minimal"` \| `"normal"` \| `"verbose"` |
| `notifications.dryRun` | `boolean` | `false` | Slack 投稿の代わりにファイルにログ |
| `rateLimit.minIntervalMs` | `number` | `600000` | ステータス投稿間の最小 ms（10分） |
| `rateLimit.maxPerSession` | `number` | `10` | セッションあたりの最大投稿数 |
| `rateLimit.maxPerDay` | `number` | `30` | プロジェクトあたりの1日最大投稿数 |

### プロジェクトの無効化

プロジェクトルートに `.claude-report.ignore` ファイルを作成するか、`CLAUDE_REPORT_DISABLED=1` を設定する。

### 環境変数

| 変数 | 説明 |
|------|------|
| `CLAUDE_REPORT_SLACK_BOT_TOKEN` | Slack bot token（plugin 設定を上書き） |
| `CLAUDE_REPORT_SLACK_CHANNEL` | Slack channel ID |
| `CLAUDE_REPORT_USER_NAME` | 表示名 |
| `CLAUDE_REPORT_DRY_RUN=1` | dry-run mode を有効化 |
| `CLAUDE_REPORT_DISABLED=1` | 全投稿を無効化 |

## CLI

```bash
claude-report register [path]     # ディレクトリをステータスログ対象に登録
claude-report unregister [path]   # ディレクトリの登録を解除
claude-report list                # 登録済みディレクトリを一覧表示
claude-report post <message> -t <type>  # 手動でステータスを投稿
claude-report pause               # 現在のプロジェクトの投稿をミュート
claude-report resume              # ミュートを解除
claude-report status              # セッション状態と最近の投稿を表示
```

### Slash Command

Claude Code で `/report` と入力すると、手動でステータス更新をトリガーできる。Claude が現在のセッションを要約して Slack に投稿する。

### MCP Tool

plugin が有効な場合、Claude は以下の tool を使用できる:

| Tool | 説明 |
|------|------|
| `report_status` | 進捗更新を投稿（status, blocker, completion, pivot, push） |
| `report_blocker` | ブロッカー報告のショートカット |
| `report_done` | 完了報告のショートカット |
| `fetch_feedback` | Slack スレッドのマネージャー返信を取得 |
| `report_mute` | セッションの投稿を一時停止 |
| `report_unmute` | 投稿を再開 |

## 安全性とプライバシー

- **コンテンツフィルター**: シークレット（AWS key、JWT、Slack token、GitHub PAT）と絶対パスは投稿前に自動的にリダクトされる
- **レート制限**: 投稿間隔は最低10分、セッションあたり10件、1日あたり30件。ブロッカーと完了報告はインターバル制限を bypass
- **ミュート制御**: `claude-report pause`、`report_mute` MCP tool、`.claude-report.ignore` ファイル、`CLAUDE_REPORT_DISABLED=1` の4つの方法
- **プロジェクト登録制**: 登録済みディレクトリのみ更新を投稿。未登録ディレクトリは沈黙
- **認証情報の保管**: Slack bot token は system keychain に保存され、設定ファイルには含まれない

## 開発

```bash
git clone https://github.com/anthropics/claude-report
cd claude-report
npm install
npm run build
npm test

# plugin としてローカルテスト
claude --plugin-dir .
```

## License

MIT
