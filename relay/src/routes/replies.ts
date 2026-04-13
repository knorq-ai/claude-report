/**
 * リプライ取得ルート。
 *
 * GET /replies?threadId=X&since=ISO — Slack スレッドからリプライを取得する
 */

import type { Env } from "../index.js";
import { resolveAuth } from "../store.js";
import { SlackClient } from "../slack.js";

// ---------------------------------------------------------------------------
// GET /replies
// ---------------------------------------------------------------------------

export async function handleReplies(
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

  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  if (!threadId) {
    return jsonError("Missing required query parameter: threadId", 400);
  }

  const sinceParam = url.searchParams.get("since");
  let oldest: string | undefined;
  if (sinceParam) {
    try {
      // ISO 文字列を Slack のエポック秒に変換
      const sinceDate = new Date(sinceParam);
      oldest = String(sinceDate.getTime() / 1000);
    } catch {
      return jsonError("Invalid since parameter: expected ISO 8601 string", 400);
    }
  }

  const { team } = auth;
  const slack = new SlackClient(team.slackBotToken);

  const result = await slack.conversationsReplies(
    team.slackChannel,
    threadId,
    oldest,
  );

  if (!result.ok) {
    return jsonError(
      `Slack API error: ${result.error || "unknown"}`,
      502,
    );
  }

  // 親メッセージ（先頭）を除外し、リプライのみ返す
  const messages = result.messages || [];
  const replies = messages.slice(1).map((msg) => ({
    author: msg.user || "unknown",
    text: msg.text || "",
    timestamp: msg.ts
      ? new Date(Number(msg.ts) * 1000).toISOString()
      : new Date().toISOString(),
  }));

  return json(replies);
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
