/** Status update types posted to Slack */
export type UpdateType = "status" | "blocker" | "completion" | "pivot" | "push";

/** Typed metadata for status updates */
export interface UpdateMetadata {
  branch?: string;
  commitSha?: string;
  prUrl?: string;
  filesChanged?: number;
  custom?: Record<string, string>;
}

/** A status update to be posted */
export interface StatusUpdate {
  type: UpdateType;
  summary: string;
  details?: string;
  metadata?: UpdateMetadata;
  timestamp: Date;
  userId: string;
  sessionId: string;
  project: string;
}

/** Result from posting a status update */
export interface PostResult {
  threadId: string;
  channel: string;
  permalink: string;
}

/** A reply from a Slack thread */
export interface Reply {
  author: string;
  text: string;
  timestamp: Date;
}

/** Session state persisted locally */
export interface Session {
  sessionId: string;
  userId: string;
  project: string;
  threadId: string | null;
  startedAt: string;
  lastPostAt: string | null;
  lastActiveAt: string;
  postCount: number;
  dailyPostCount: number;
  dailyPostDate: string;
  muted: boolean;
  /**
   * Last posted summary + time, for dedup across processes. Persisted so the
   * hook path (short-lived subprocess per invocation) can enforce the
   * deduplication window, not just the in-memory MCP server.
   */
  lastPostSummary?: string;
}

/** Interface for posting status updates */
export interface StatusPoster {
  postUpdate(
    update: StatusUpdate,
    threadId?: string | null,
  ): Promise<PostResult>;
}

/** Interface for fetching thread replies */
export interface ReplyFetcher {
  fetchReplies(threadId: string, since?: Date): Promise<Reply[]>;
}

/** Interface for local state storage */
export interface Store {
  saveSession(session: Session): Promise<void>;
  getActiveSession(
    userId: string,
    project: string,
  ): Promise<Session | null>;
  updateSession(
    sessionId: string,
    updates: Partial<Session>,
  ): Promise<void>;

  saveUpdate(update: StatusUpdate & { threadId: string }): Promise<void>;
  getRecentUpdates(
    sessionId: string,
    limit?: number,
  ): Promise<StatusUpdate[]>;

  getLastSeenReplyTimestamp(threadId: string): Promise<Date | null>;
  setLastSeenReplyTimestamp(threadId: string, ts: Date): Promise<void>;
}
