import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  loadConfig,
  createPoster,
  createFetcher,
  isProjectDisabled,
  getOrCreateSession,
  updateSessionForProject,
  readSessionForProject,
  resolveProjectName,
  resolveUserId,
  RateLimiter,
  ContentFilter,
  sendWelcomeIfNeeded,
} from "../core/index.js";
import type {
  StatusUpdate,
  UpdateType,
  StatusPoster,
  ReplyFetcher,
  Session,
} from "../core/index.js";

// ---------------------------------------------------------------------------
// 初期化 — try-catch でラップし、起動失敗時もサーバーは立ち上げる
// （ツール呼び出し時にエラーメッセージを返せるようにするため）
// ---------------------------------------------------------------------------

let config: ReturnType<typeof loadConfig>;
let poster: StatusPoster | null = null;
let fetcher: ReplyFetcher | null = null;
let rateLimiter: RateLimiter;
let contentFilter: ContentFilter;
let project: string;
let userId: string;
let projectDir: string;
let initError: string | null = null;

try {
  projectDir = process.cwd();
  config = loadConfig(projectDir);
  poster = createPoster(config, projectDir);
  fetcher = createFetcher(config);
  rateLimiter = new RateLimiter(config.rateLimit);
  contentFilter = new ContentFilter();
  project = resolveProjectName(projectDir);
  userId = resolveUserId(config);
} catch (err) {
  initError = `Initialization failed: ${err instanceof Error ? err.message : err}`;
  process.stderr.write(`[claude-report] ${initError}\n`);
  // Provide fallback values so tools can return the error message
  projectDir = process.cwd();
  config = loadConfig(); // defaults only
  rateLimiter = new RateLimiter(config.rateLimit);
  contentFilter = new ContentFilter();
  project = "unknown";
  userId = "unknown";
}

function currentSession(): Session {
  return getOrCreateSession(userId, project);
}

// ---------------------------------------------------------------------------
// ヘルパー: ステータス投稿の共通処理
// ---------------------------------------------------------------------------

async function postStatusUpdate(
  type: UpdateType,
  summary: string,
  details?: string,
): Promise<string> {
  if (initError) {
    return `claude-report is not configured: ${initError}`;
  }

  // プロジェクト無効チェック
  if (isProjectDisabled(projectDir)) {
    return "Status reporting is disabled for this project.";
  }

  // poster 未設定
  if (!poster) {
    return "Status reporting is not configured. Run `claude-report setup` to set up.";
  }

  await sendWelcomeIfNeeded(config);

  const session = currentSession();

  // StatusUpdate を組み立てる
  let update: StatusUpdate = {
    type,
    summary,
    details,
    timestamp: new Date(),
    userId: userId,
    sessionId: session.sessionId,
    project,
  };

  // コンテンツフィルタ
  update = contentFilter.filter(update);

  // レート制限チェック
  const rateResult = rateLimiter.shouldPost(update, session);
  if (!rateResult.allowed) {
    return `Rate limited: ${rateResult.reason}`;
  }

  // Slack 投稿
  try {
    const result = await poster.postUpdate(update, session.threadId);

    // レート制限の記録
    rateLimiter.recordPost(update);

    // セッション更新: threadId を保存し、カウンタをインクリメント
    const today = new Date().toISOString().slice(0, 10);
    const dailyPostCount =
      session.dailyPostDate === today ? session.dailyPostCount + 1 : 1;

    updateSessionForProject(userId, project, {
      threadId: result.threadId,
      postCount: session.postCount + 1,
      dailyPostCount,
      dailyPostDate: today,
      lastPostAt: new Date().toISOString(),
    });

    return `Posted ${type} update to Slack. (thread: ${result.threadId})`;
  } catch (_err) {
    // Slack エラーはクラッシュせず丁寧に返す
    const errMsg = _err instanceof Error ? _err.message : "Unknown error";
    return `Failed to post status update: ${errMsg}. Continue working normally.`;
  }
}

// ---------------------------------------------------------------------------
// MCP サーバー定義
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "claude-report", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---- report_status --------------------------------------------------------

server.tool(
  "report_status",
  "Post a progress update to Slack.",
  {
    summary: z.string().describe("Short summary of the progress update"),
    details: z.string().optional().describe("Optional longer details"),
    type: z
      .enum(["status", "blocker", "completion", "pivot", "push"])
      .describe("Type of status update"),
  },
  async ({ summary, details, type }) => {
    const message = await postStatusUpdate(type, summary, details);
    return { content: [{ type: "text", text: message }] };
  },
);

// ---- report_blocker -------------------------------------------------------

server.tool(
  "report_blocker",
  "Shorthand to report a blocker.",
  {
    summary: z.string().describe("Short summary of the blocker"),
    details: z.string().optional().describe("Optional longer details"),
  },
  async ({ summary, details }) => {
    // mentionOnBlocker: 設定があれば details に含める
    let enrichedDetails = details;
    if (config.slack?.mentionOnBlocker) {
      const mention = config.slack.mentionOnBlocker;
      enrichedDetails = enrichedDetails
        ? `${enrichedDetails}\ncc: ${mention}`
        : `cc: ${mention}`;
    }
    const message = await postStatusUpdate("blocker", summary, enrichedDetails);
    return { content: [{ type: "text", text: message }] };
  },
);

// ---- report_done ----------------------------------------------------------

server.tool(
  "report_done",
  "Shorthand to report task completion.",
  {
    summary: z.string().describe("Short summary of what was completed"),
    details: z.string().optional().describe("Optional longer details"),
  },
  async ({ summary, details }) => {
    const message = await postStatusUpdate("completion", summary, details);
    return { content: [{ type: "text", text: message }] };
  },
);

// ---- fetch_feedback -------------------------------------------------------

server.tool(
  "fetch_feedback",
  "Fetch manager replies from the current Slack thread.",
  {},
  async () => {
    if (!fetcher) {
      return {
        content: [
          {
            type: "text",
            text: "Feedback fetching is not configured. Run `claude-report setup` to set up.",
          },
        ],
      };
    }

    const session = readSessionForProject(userId, project);
    if (!session?.threadId) {
      return {
        content: [
          {
            type: "text",
            text: "No active thread found. Post a status update first.",
          },
        ],
      };
    }

    try {
      const replies = await fetcher.fetchReplies(session.threadId);

      if (replies.length === 0) {
        return {
          content: [{ type: "text", text: "No feedback yet." }],
        };
      }

      const MAX_AUTHOR = 50;
      const MAX_TEXT = 300;
      const sanitize = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
      const formatted = replies
        .map(
          (r) =>
            `[${r.timestamp.toISOString()}] ${sanitize(r.author).slice(0, MAX_AUTHOR)}: ${sanitize(r.text).slice(0, MAX_TEXT)}`,
        )
        .join("\n");

      return {
        content: [
          { type: "text", text: `Feedback (${replies.length} replies):\n${formatted}` },
        ],
      };
    } catch (_err) {
      return {
        content: [
          { type: "text", text: "Failed to fetch feedback. Will retry later." },
        ],
      };
    }
  },
);

// ---- report_mute ----------------------------------------------------------

server.tool(
  "report_mute",
  "Pause status posting for this session.",
  async () => {
    const session = currentSession();
    updateSessionForProject(userId, project, { muted: true });
    return {
      content: [
        {
          type: "text",
          text: `Session ${session.sessionId} is now muted. Use report_unmute to resume.`,
        },
      ],
    };
  },
);

// ---- report_unmute --------------------------------------------------------

server.tool(
  "report_unmute",
  "Resume status posting for this session.",
  async () => {
    const session = currentSession();
    updateSessionForProject(userId, project, { muted: false });
    return {
      content: [
        {
          type: "text",
          text: `Session ${session.sessionId} is now unmuted. Status updates will be posted.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// サーバー起動
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`claude-report MCP server fatal error: ${err}\n`);
  process.exit(1);
});
