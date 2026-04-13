/**
 * claude-report relay サービスのエントリーポイント。
 *
 * 開発者マシンと Slack API の間に立つ薄いプロキシ。
 * Slack ボットトークンをサーバー側で保持し、
 * 開発者ごとの API キーで認証する。
 */

import { handleCreateTeam, handleResolveInvite } from "./routes/team.js";
import { handleAuthCallback, handleRevoke } from "./routes/auth.js";
import { handlePost } from "./routes/post.js";
import { handleReplies } from "./routes/replies.js";

export interface Env {
  STORE: KVNamespace;
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS プリフライトへの応答
    if (method === "OPTIONS") {
      return handleCors();
    }

    let response: Response;

    try {
      response = await route(request, env, method, pathname);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      response = jsonError(message, 500);
    }

    return withCorsHeaders(response);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

async function route(
  request: Request,
  env: Env,
  method: string,
  pathname: string,
): Promise<Response> {
  // POST /teams — チーム作成
  if (method === "POST" && pathname === "/teams") {
    return handleCreateTeam(request, env);
  }

  // GET /teams/:inviteCode — 招待コード解決
  const inviteMatch = pathname.match(/^\/teams\/([a-z0-9]+)$/);
  if (method === "GET" && inviteMatch) {
    return handleResolveInvite(inviteMatch[1], env, request.url);
  }

  // POST /auth/callback — 認証コールバック
  if (method === "POST" && pathname === "/auth/callback") {
    return handleAuthCallback(request, env);
  }

  // POST /post — ステータス更新投稿
  if (method === "POST" && pathname === "/post") {
    return handlePost(request, env);
  }

  // GET /replies — リプライ取得
  if (method === "GET" && pathname === "/replies") {
    return handleReplies(request, env);
  }

  // POST /revoke — API キー無効化
  if (method === "POST" && pathname === "/revoke") {
    return handleRevoke(request, env);
  }

  // ヘルスチェック
  if (method === "GET" && (pathname === "/" || pathname === "/health")) {
    return json({ status: "ok", service: "claude-report-relay" });
  }

  return jsonError("Not found", 404);
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

// CORS restricted — CLI client does not need CORS; only allow specific origins if a web UI is added
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://claude-report.dev",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function handleCors(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function withCorsHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return json({ error: message }, status);
}
