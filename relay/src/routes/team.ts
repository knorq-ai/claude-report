/**
 * チーム管理ルート。
 *
 * POST /teams      — チーム作成
 * GET  /teams/:inviteCode — 招待コード解決
 */

import type { Env } from "../index.js";
import {
  type Team,
  putTeam,
  putInvite,
  getInvite,
  getTeam,
  generateInviteCode,
} from "../store.js";

// ---------------------------------------------------------------------------
// POST /teams
// ---------------------------------------------------------------------------

interface CreateTeamBody {
  slackBotToken: string;
  slackChannel: string;
  threadStrategy?: "daily" | "session" | "project";
  mentionOnBlocker?: string;
  createdBy: string;
}

export async function handleCreateTeam(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: CreateTeamBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.slackBotToken || !body.slackChannel || !body.createdBy) {
    return jsonError(
      "Missing required fields: slackBotToken, slackChannel, createdBy",
      400,
    );
  }

  const teamId = crypto.randomUUID();
  const inviteCode = generateInviteCode();

  const team: Team = {
    teamId,
    inviteCode,
    slackBotToken: body.slackBotToken,
    slackChannel: body.slackChannel,
    threadStrategy: body.threadStrategy || "daily",
    mentionOnBlocker: body.mentionOnBlocker,
    createdAt: new Date().toISOString(),
    createdBy: body.createdBy,
  };

  await putTeam(env.STORE, team);
  await putInvite(env.STORE, inviteCode, { teamId });

  return json({ teamId, inviteCode }, 201);
}

// ---------------------------------------------------------------------------
// GET /teams/:inviteCode
// ---------------------------------------------------------------------------

export async function handleResolveInvite(
  inviteCode: string,
  env: Env,
  requestUrl: string,
): Promise<Response> {
  const mapping = await getInvite(env.STORE, inviteCode);
  if (!mapping) {
    return jsonError("Invalid invite code", 404);
  }

  const team = await getTeam(env.STORE, mapping.teamId);
  if (!team) {
    return jsonError("Team not found", 404);
  }

  // relayUrl はリクエストの origin から導出する
  const url = new URL(requestUrl);
  const relayUrl = url.origin;

  return json({
    teamId: team.teamId,
    relayUrl,
    slackChannel: team.slackChannel,
    threadStrategy: team.threadStrategy,
  });
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
