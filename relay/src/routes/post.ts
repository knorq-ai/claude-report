/**
 * ステータス更新投稿ルート。
 *
 * POST /post — Slack へステータス更新をプロキシする
 */

import type { Env } from "../index.js";
import { resolveAuth } from "../store.js";
import { SlackClient } from "../slack.js";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** クライアントから送信されるステータス更新 */
interface StatusUpdate {
  type: string;
  summary: string;
  details?: string;
  metadata?: {
    branch?: string;
    commitSha?: string;
    prUrl?: string;
    filesChanged?: number;
    custom?: Record<string, string>;
  };
  timestamp: string;
  userId: string;
  sessionId: string;
  project: string;
}

interface PostBody {
  update: StatusUpdate;
  threadId?: string;
  userName: string;
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const TYPE_INDICATORS: Record<string, string> = {
  status: "\u{1f535}",
  blocker: "\u{1f534}",
  completion: "\u{1f7e2}",
  pivot: "\u{1f7e1}",
  push: "\u{1f7e2}",
};

const TYPE_LABELS: Record<string, string> = {
  status: "Status",
  blocker: "Blocker",
  completion: "Completed",
  pivot: "Pivot",
  push: "Pushed",
};

// ---------------------------------------------------------------------------
// POST /post
// ---------------------------------------------------------------------------

export async function handlePost(
  request: Request,
  env: Env,
): Promise<Response> {
  const apiKey = extractBearerToken(request);
  if (!apiKey) {
    return jsonError("Missing Authorization header", 401);
  }

  const auth = await resolveAuth(env.STORE, apiKey);
  if (!auth) {
    return jsonError("Invalid API key", 401);
  }

  let body: PostBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.update?.summary || !body.userName) {
    return jsonError("Missing required fields: update.summary, userName", 400);
  }

  const { team } = auth;
  const slack = new SlackClient(team.slackBotToken);

  let threadId = body.threadId || null;

  // スレッドが未作成の場合、日次親メッセージを作成する
  if (!threadId) {
    const date = new Date().toISOString().slice(0, 10);
    const parentBlocks = formatDailyParentBlocks(
      body.userName,
      body.update.project,
      date,
    );
    const parentText = `\u{1f4cb} ${body.userName} \u2014 ${date}\n${body.update.project}`;

    const parentResult = await slack.postMessage({
      channel: team.slackChannel,
      text: parentText,
      blocks: parentBlocks,
    });

    if (!parentResult.ok || !parentResult.ts) {
      return jsonError(
        `Slack API error: ${parentResult.error || "unknown"}`,
        502,
      );
    }

    threadId = parentResult.ts;
  }

  // ステータス更新をスレッド返信として投稿
  const blocks = formatStatusBlocks(body.update, body.userName);
  const result = await slack.postMessage({
    channel: team.slackChannel,
    text: body.update.summary,
    blocks,
    thread_ts: threadId,
  });

  if (!result.ok) {
    return jsonError(
      `Slack API error: ${result.error || "unknown"}`,
      502,
    );
  }

  // パーマリンクの取得（失敗してもエラーにはしない）
  let permalink = "";
  if (result.ts) {
    try {
      const plResult = await slack.getPermalink(
        team.slackChannel,
        result.ts,
      );
      if (plResult.ok && plResult.permalink) {
        permalink = plResult.permalink;
      }
    } catch {
      // パーマリンク取得失敗は無視する
    }
  }

  return json({
    threadId,
    channel: team.slackChannel,
    permalink,
  });
}

// ---------------------------------------------------------------------------
// Block Kit フォーマッタ（Worker 向け簡易版）
// ---------------------------------------------------------------------------

function formatStatusBlocks(update: StatusUpdate, userName: string): object[] {
  const indicator = TYPE_INDICATORS[update.type] || "\u{1f535}";
  const label = TYPE_LABELS[update.type] || "Update";
  const time = formatTime(update.timestamp);

  const blocks: object[] = [];

  let text = `${indicator} *${label}:* ${update.summary}`;
  if (update.details) {
    text += `\n${update.details}`;
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text },
  });

  const contextParts: string[] = [];
  if (update.metadata?.branch) {
    contextParts.push(`\u{1f33f} \`${update.metadata.branch}\``);
  }
  if (update.metadata?.filesChanged !== undefined) {
    const suffix = update.metadata.filesChanged === 1 ? "" : "s";
    contextParts.push(`${update.metadata.filesChanged} file${suffix} changed`);
  }
  contextParts.push(`\u{1f553} ${time}`);

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextParts.join("  \u00b7  ") }],
  });

  return blocks;
}

function formatDailyParentBlocks(
  userName: string,
  project: string,
  date: string,
): object[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1f4cb} *${userName}* \u2014 ${date}\n\`${project}\``,
      },
    },
  ];
}

function formatTime(isoTimestamp: string): string {
  try {
    const d = new Date(isoTimestamp);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "--:--";
  }
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
