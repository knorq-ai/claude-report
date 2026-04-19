[English](./README.md) | [日本語](./README.ja.md)

# claude-report

Claude Code の開発アクティビティを Slack にリアルタイム共有する plugin。開発者の作業を中断せずに、エンジニアリングマネージャーがチームの進捗を把握できる。

## 概要

claude-report は Claude Code と連携し、2層の可視性を提供する:

1. **リアルタイムアクティビティログ** — hook が git commit、push、PR 作成、テスト失敗、タスク完了を自動検出し、1日1スレッドにコンパクトなログエントリを投稿
2. **終業時サマリー** — Claude Code のトランスクリプトファイルを解析し、プロジェクトごとの使用量統計と AI による作業要約を生成

マネージャーが Slack スレッドに返信すると、そのフィードバックは開発者の次の Claude Code セッションに自動的に反映される。

## Quick Start

### 1. Slack App の作成

[api.slack.com/apps](https://api.slack.com/apps) で新しいアプリを **manifest から** 作成する。[`slack-app-manifest.json`](./slack-app-manifest.json) の内容を貼り付ける。ワークスペースにインストールし、**Bot User OAuth Token**（`xoxb-...`）をコピーする。

対象チャンネルに bot を招待する:

```
/invite @Claude Report
```

### 2. Plugin のインストール

```bash
claude plugin install claude-report
```

Claude Code が3つの値を聞いてくる:

| 入力項目 | 値 |
|---------|-----|
| **Slack Bot Token** | step 1 の `xoxb-...` |
| **Slack Channel ID** | Slack チャンネル詳細画面の channel ID（例: `C0AS7LC0X9B`） |
| **Display Name** | Slack 投稿に表示される名前 |

### 3. Claude Code を再起動

Plugin の hook と MCP サーバーはセッション起動時に有効化される。

## 仕組み

### リアルタイムアクティビティログ

Bash と TaskUpdate の tool 呼び出しごとに hook が発火する。検出されたイベントは**ユーザーごとに1日1スレッド**にコンパクトなログエントリとして投稿される:

```
📋 Alex — Activity Log (2026-04-15)
  ├─ `acme/web-app`      🚀 Pushed to main
  ├─ `acme/api-gateway`  📝 Committed: fix auth middleware redirect loop
  ├─ `acme/data-pipeline` ✅ Task completed: Add anomaly detection processor
  └─ `acme/web-app`      🛑 Tests failing: 3 failures
```

| イベント | アイコン | 例 |
|---------|---------|-----|
| Git push | 🚀 | `Pushed to main` |
| Git commit | 📝 | `Committed: fix auth bug` |
| PR 作成 | 📝 | `PR created: .../pull/42` |
| タスク完了 | ✅ | `Task completed: Implement JWT auth` |
| テスト失敗 | 🛑 | `Tests failing: 3 failures` |

### 終業時 Usage レポート

`/usage` slash command（または `report_usage` MCP tool）がローカルの Claude Code トランスクリプト JSONL ファイルを解析し、日次サマリーを生成する:

- **トークン使用量統計** — セッション数、プロンプト数（内部 tool 呼び出しを除外）、入出力トークン数、推定コスト
- **プロジェクト別内訳** — プロジェクトごとのプロンプト数・トークン数
- **AI による要約** — commit メッセージ、編集ファイル、ユーザープロンプトを読み取り、プロジェクトごとに日本語1行サマリーを生成

自動日次投稿は `/schedule-usage` または launchd で設定可能。

### マネージャーフィードバック loop

マネージャーが Slack スレッドに返信すると、`UserPromptSubmit` hook が返信を取得（キャッシュ付き、5分 TTL）し、開発者の次の Claude Code プロンプトに挿入する。

## 設定

### プロジェクト単位のオーバーライド

プロジェクトルートに `.claude-report.json` を作成:

```json
{
  "notifications": {
    "enabled": true,
    "onGitPush": true,
    "onBlocker": true,
    "onCompletion": true,
    "dryRun": false
  }
}
```

| Field | Type | Default | 説明 |
|-------|------|---------|------|
| `notifications.enabled` | `boolean` | `true` | 投稿のマスタースイッチ |
| `notifications.onGitPush` | `boolean` | `true` | git push をアクティビティログに含める |
| `notifications.onBlocker` | `boolean` | `true` | テスト失敗を含める |
| `notifications.onCompletion` | `boolean` | `true` | タスク/PR 完了を含める |
| `notifications.dryRun` | `boolean` | `false` | Slack 投稿の代わりにファイルにログ |

### プロジェクトの無効化

プロジェクトルートに `.claude-report.ignore` ファイルを作成するか、`CLAUDE_REPORT_DISABLED=1` を設定する。

### 環境変数

| 変数 | 説明 |
|------|------|
| `CLAUDE_REPORT_SLACK_BOT_TOKEN` | Slack bot token（plugin 設定を上書き） |
| `CLAUDE_REPORT_SLACK_CHANNEL` | Slack channel ID |
| `CLAUDE_REPORT_USER_NAME` | 表示名 |
| `CLAUDE_REPORT_DATA_DIR` | データディレクトリパス（デフォルトを上書き） |
| `CLAUDE_REPORT_DRY_RUN=1` | dry-run mode を有効化 |
| `CLAUDE_REPORT_DISABLED=1` | 全投稿を無効化 |

## CLI

```bash
claude-report enable [user]              # git user のレポートを有効化
claude-report disable [user]             # git user のレポートを無効化
claude-report users                      # 有効なユーザーを一覧表示
claude-report post <message> -t <type>   # 手動でステータスを投稿
claude-report pause                      # 現在のプロジェクトの投稿をミュート
claude-report resume                     # ミュートを解除
claude-report status                     # セッション状態を表示
```

### Slash Command

| コマンド | 説明 |
|---------|------|
| `/report` | 手動ステータス更新 — Claude がセッションを要約して投稿 |
| `/usage` | 日次トークン使用量サマリーを Slack に投稿 |
| `/schedule-usage` | 自動日次 usage レポートを設定 |

### MCP Tool

| Tool | 説明 |
|------|------|
| `report_status` | 進捗更新を投稿（status, blocker, completion, pivot, push） |
| `report_blocker` | ブロッカー報告のショートカット |
| `report_done` | 完了報告のショートカット |
| `fetch_feedback` | Slack スレッドのマネージャー返信を取得 |
| `report_usage` | 日次使用量統計とプロジェクト別アクティビティスニペットを取得 |
| `post_usage_to_slack` | AI 生成のプロジェクトサマリー付き usage レポートを投稿 |
| `report_mute` / `report_unmute` | 投稿の一時停止/再開 |

## 日次レポートのスケジューリング

### Option A: セッション内（セッション限定）

```
/schedule-usage
```

ローカル時間 19:00 に cron ジョブを作成する。Claude Code セッション終了時に消える。

### Option B: macOS launchd（永続化）

`~/Library/LaunchAgents/com.claude-report.daily-usage.plist` を作成:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-report.daily-usage</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/claude</string>
        <string>-p</string>
        <string>Call report_usage for today's date. Write 1-line Japanese summaries per project, then call post_usage_to_slack.</string>
        <string>--plugin-dir</string>
        <string>/path/to/claude-report</string>
        <string>--permission-mode</string>
        <string>bypassPermissions</string>
        <string>--model</string>
        <string>sonnet</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-report</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>19</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/yourname</string>
        <key>CLAUDE_REPORT_DATA_DIR</key>
        <string>/Users/yourname/.claude/plugins/data/claude-report-claude-report-marketplace</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude-report.daily-usage.plist
```

## 安全性とプライバシー

- **コンテンツフィルター**: シークレット（AWS key、JWT、Slack token、GitHub PAT、Stripe key）、`key=value` パターン、絶対パスは投稿前に自動リダクト
- **Slack mrkdwn エスケープ**: ユーザー制御テキストをサニタイズしてフォーマットインジェクションを防止
- **プロンプトインジェクション対策**: Slack 返信テキストはサニタイズとバウンダリマーキング後に Claude のコンテキストに挿入
- **ミュート制御**: `claude-report pause`、`report_mute` MCP tool、`.claude-report.ignore` ファイル、`CLAUDE_REPORT_DISABLED=1`
- **ユーザーベースのアクセス制御**: git user 単位でレポートの有効/無効を切り替え。全リポジトリで動作
- **ファイルロック**: advisory lock により並行 hook プロセスのセッション状態破損を防止

## 開発

```bash
git clone https://github.com/knorq-ai/claude-report
cd claude-report
npm install
npm run build
npm test

# plugin としてローカルテスト
claude --plugin-dir .
```

## License

MIT
