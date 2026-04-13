/**
 * 認証ルート。
 *
 * POST /auth/callback — Slack OAuth コールバック（MVP: 簡易版）
 * POST /revoke        — メンバーの API キー無効化
 */

import type { Env } from "../index.js";
import {
  getTeam,
  generateApiKey,
  hashApiKey,
  putMember,
  resolveAuth,
  findMemberHashBySlackUserId,
  deleteMember,
} from "../store.js";

// ---------------------------------------------------------------------------
// POST /auth/callback
// ---------------------------------------------------------------------------

interface AuthCallbackBody {
  slackUserId: string;
  displayName: string;
  teamId: string;
  inviteCode: string;
}

/**
 * MVP 簡易認証: クライアント側で Slack OAuth を完了し、
 * ユーザー情報を直接送信する。API キーを生成して返す。
 */
export async function handleAuthCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: AuthCallbackBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.slackUserId || !body.displayName || !body.teamId || !body.inviteCode) {
    return jsonError(
      "Missing required fields: slackUserId, displayName, teamId, inviteCode",
      400,
    );
  }

  // Verify invite code matches team (prevents unauthorized registration)
  const inviteData = await env.STORE.get(`invite:${body.inviteCode}`);
  if (!inviteData) {
    return jsonError("Invalid invite code", 403);
  }
  const invite = JSON.parse(inviteData) as { teamId: string };
  if (invite.teamId !== body.teamId) {
    return jsonError("Invite code does not match team", 403);
  }

  // チームの存在確認
  const team = await getTeam(env.STORE, body.teamId);
  if (!team) {
    return jsonError("Team not found", 404);
  }

  // API キーを生成し、ハッシュを KV に保存
  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);

  await putMember(env.STORE, keyHash, {
    teamId: body.teamId,
    slackUserId: body.slackUserId,
    displayName: body.displayName,
    createdAt: new Date().toISOString(),
  });

  return json({
    apiKey,
    displayName: body.displayName,
    slackUserId: body.slackUserId,
  });
}

// ---------------------------------------------------------------------------
// POST /revoke
// ---------------------------------------------------------------------------

interface RevokeBody {
  slackUserId: string;
}

/**
 * メンバーの API キーを無効化する。
 * チーム作成者のみ実行可能。
 */
export async function handleRevoke(
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

  // チーム作成者のみ revoke 可能
  if (auth.team.createdBy !== auth.member.slackUserId) {
    return jsonError("Only the team creator can revoke members", 403);
  }

  let body: RevokeBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.slackUserId) {
    return jsonError("Missing required field: slackUserId", 400);
  }

  // 対象メンバーの API キーハッシュを検索
  const targetHash = await findMemberHashBySlackUserId(
    env.STORE,
    auth.team.teamId,
    body.slackUserId,
  );

  if (!targetHash) {
    return jsonError("Member not found", 404);
  }

  await deleteMember(env.STORE, targetHash);

  return json({ revoked: true, slackUserId: body.slackUserId });
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
