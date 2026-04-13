import {
  loadConfig,
  createPoster,
  getOrCreateSession,
  updateSessionForProject,
  resolveProjectName,
  RateLimiter,
  ContentFilter,
} from "../core/index.js";
import type { StatusUpdate, UpdateType } from "../core/index.js";

export async function post(
  message: string,
  options: { type: string },
): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);
  const poster = createPoster(config, projectDir);

  if (!poster) {
    console.error("Status reporting is not configured. Run: claude-report setup");
    process.exit(1);
  }

  const project = resolveProjectName(projectDir);
  const userId = config.user.slackUserId;
  const session = getOrCreateSession(userId, project);
  const rateLimiter = new RateLimiter(config.rateLimit);
  const contentFilter = new ContentFilter();

  const VALID_TYPES = new Set(["status", "blocker", "completion", "pivot", "push"]);
  if (!VALID_TYPES.has(options.type)) {
    console.error(`  Invalid type: ${options.type}. Valid: ${[...VALID_TYPES].join(", ")}`);
    process.exit(1);
  }

  const update: StatusUpdate = {
    type: options.type as UpdateType,
    summary: message,
    timestamp: new Date(),
    userId,
    sessionId: session.sessionId,
    project,
  };

  const filtered = contentFilter.filter(update);
  const rateCheck = rateLimiter.shouldPost(filtered, session);

  if (!rateCheck.allowed) {
    console.log(`  Rate limited: ${rateCheck.reason}`);
    return;
  }

  try {
    const result = await poster.postUpdate(filtered, session.threadId);
    rateLimiter.recordPost(filtered);

    const today = new Date().toISOString().slice(0, 10);
    const dailyPostCount =
      session.dailyPostDate === today ? session.dailyPostCount + 1 : 1;

    updateSessionForProject(userId, project, {
      threadId: result.threadId,
      lastPostAt: new Date().toISOString(),
      postCount: session.postCount + 1,
      dailyPostCount,
      dailyPostDate: today,
    });
    console.log(`  Posted: ${filtered.summary}`);
  } catch (error) {
    console.error(`  Failed to post: ${error instanceof Error ? error.message : error}`);
  }
}
