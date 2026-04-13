/**
 * Claude Code hook: UserPromptSubmit
 *
 * ユーザーがプロンプトを送信した際に発火する。
 * Slack スレッドの返信を取得し、キャッシュ付きで開発者にフィードバックを届ける。
 * エラー時は静かに exit(0) — フック実行が開発者をブロックしてはならない。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadConfig,
  isProjectDisabled,
  createFetcher,
  readSessionForProject,
  resolveProjectName,
  getStateDir,
  atomicWriteJson,
  JsonFileStore,
} from "../core/index.js";

/** 返信チェックのキャッシュ TTL (5 分) */
const CACHE_TTL_MS = 300_000;

/** フェッチのタイムアウト (2 秒) */
const FETCH_TIMEOUT_MS = 2_000;

interface LastReplyCheck {
  checkedAt: number;
}

interface HookOutput {
  decision: string;
  reason: string;
}

function readLastCheckTimestamp(cacheFile: string): number | null {
  if (!existsSync(cacheFile)) return null;
  try {
    const data: LastReplyCheck = JSON.parse(readFileSync(cacheFile, "utf-8"));
    return data.checkedAt ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // stdin を読み取る（プロンプトデータは使わないが消費する必要がある）
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  // プロジェクト設定の読み込み
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);

  if (!config.notifications.enabled) return;
  if (isProjectDisabled(projectDir)) return;

  // 現在のプロジェクトのセッション確認 — threadId がなければ何もしない
  const project = resolveProjectName(projectDir);
  const userId = config.user.slackUserId || config.user.name || "unknown";
  const session = readSessionForProject(userId, project);
  if (!session?.threadId) return;

  const threadId = session.threadId;

  // キャッシュ確認: 前回チェックから CACHE_TTL_MS 以内なら API を叩かない
  const stateDir = getStateDir();
  const cacheFile = join(stateDir, "last-reply-check.json");
  const lastCheck = readLastCheckTimestamp(cacheFile);

  if (lastCheck !== null && Date.now() - lastCheck < CACHE_TTL_MS) {
    return;
  }

  // fetcher の生成
  const fetcher = createFetcher(config);
  if (!fetcher) return;

  // store からウォーターマーク（最後に確認した返信のタイムスタンプ）を取得
  const store = new JsonFileStore();
  const watermark = await store.getLastSeenReplyTimestamp(threadId);

  // タイムアウト付きで返信を取得
  const replies = await Promise.race([
    fetcher.fetchReplies(threadId, watermark ?? undefined),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), FETCH_TIMEOUT_MS),
    ),
  ]);

  // チェック時刻を更新
  const now = Date.now();
  atomicWriteJson(cacheFile, { checkedAt: now } satisfies LastReplyCheck);

  if (!replies || replies.length === 0) return;

  // ウォーターマーク更新: 最新の返信タイムスタンプを保存
  const latestTs = replies.reduce(
    (max, r) => (r.timestamp > max ? r.timestamp : max),
    replies[0].timestamp,
  );
  await store.setLastSeenReplyTimestamp(threadId, latestTs);

  // フィードバックを stdout に出力
  const lines = replies.map((r) => `[${r.author}]: ${r.text}`).join("\n");
  const output: HookOutput = {
    decision: "allow",
    reason: `Team feedback on your Slack status thread:\n${lines}\nAcknowledge this feedback in your work.`,
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch(() => {}).finally(() => process.exit(0));
