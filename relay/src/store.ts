/**
 * KV ベースのデータストア。
 * チーム・メンバー・招待コードの CRUD を提供する。
 */

/** チーム情報 */
export interface Team {
  teamId: string;
  inviteCode: string;
  slackBotToken: string;
  slackChannel: string;
  threadStrategy: "daily" | "session" | "project";
  mentionOnBlocker?: string;
  createdAt: string;
  createdBy: string;
}

/** メンバー情報（API キーのハッシュをキーとして格納） */
export interface Member {
  teamId: string;
  slackUserId: string;
  displayName: string;
  createdAt: string;
}

/** 招待コードからチーム ID へのマッピング */
export interface InviteMapping {
  teamId: string;
}

/**
 * API キーを SHA-256 でハッシュする。
 * KV 上では生の API キーではなくハッシュのみを保存する。
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** ランダムな招待コードを生成する（10 文字、base36） */
export function generateInviteCode(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => chars[b % chars.length])
    .join("");
}

/** API キーを生成する（"cr_" プレフィックス + 32 バイトの hex） */
export function generateApiKey(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  const hex = Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `cr_${hex}`;
}

// ---------------------------------------------------------------------------
// KV 操作
// ---------------------------------------------------------------------------

export async function getTeam(
  kv: KVNamespace,
  teamId: string,
): Promise<Team | null> {
  return kv.get<Team>(`team:${teamId}`, "json");
}

export async function putTeam(kv: KVNamespace, team: Team): Promise<void> {
  await kv.put(`team:${team.teamId}`, JSON.stringify(team));
}

export async function getMember(
  kv: KVNamespace,
  apiKeyHash: string,
): Promise<Member | null> {
  return kv.get<Member>(`member:${apiKeyHash}`, "json");
}

export async function putMember(
  kv: KVNamespace,
  apiKeyHash: string,
  member: Member,
): Promise<void> {
  await kv.put(`member:${apiKeyHash}`, JSON.stringify(member));
}

export async function deleteMember(
  kv: KVNamespace,
  apiKeyHash: string,
): Promise<void> {
  await kv.delete(`member:${apiKeyHash}`);
}

export async function getInvite(
  kv: KVNamespace,
  code: string,
): Promise<InviteMapping | null> {
  return kv.get<InviteMapping>(`invite:${code}`, "json");
}

export async function putInvite(
  kv: KVNamespace,
  code: string,
  mapping: InviteMapping,
): Promise<void> {
  await kv.put(`invite:${code}`, JSON.stringify(mapping));
}

/**
 * API キーからメンバーとチームを解決する。
 * 認証済みリクエストの共通処理。
 */
export async function resolveAuth(
  kv: KVNamespace,
  apiKey: string,
): Promise<{ member: Member; team: Team } | null> {
  const keyHash = await hashApiKey(apiKey);
  const member = await getMember(kv, keyHash);
  if (!member) return null;

  const team = await getTeam(kv, member.teamId);
  if (!team) return null;

  return { member, team };
}

/**
 * slackUserId に紐づくメンバーの API キーハッシュを KV から検索する。
 * KV には list API があるが prefix 指定で絞り込み、各値を順次チェックする。
 */
export async function findMemberHashBySlackUserId(
  kv: KVNamespace,
  teamId: string,
  slackUserId: string,
): Promise<string | null> {
  let cursor: string | undefined;

  // member: プレフィックスで一覧し、対象を見つけるまで走査する
  do {
    const list = await kv.list({ prefix: "member:", cursor });
    for (const key of list.keys) {
      const member = await kv.get<Member>(key.name, "json");
      if (
        member &&
        member.teamId === teamId &&
        member.slackUserId === slackUserId
      ) {
        // "member:{hash}" からハッシュ部分を抽出
        return key.name.slice("member:".length);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return null;
}
