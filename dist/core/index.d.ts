/** Status update types posted to Slack */
type UpdateType = "status" | "blocker" | "completion" | "pivot" | "push";
/** Typed metadata for status updates */
interface UpdateMetadata {
    branch?: string;
    commitSha?: string;
    prUrl?: string;
    filesChanged?: number;
    custom?: Record<string, string>;
}
/** A status update to be posted */
interface StatusUpdate {
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
interface PostResult {
    threadId: string;
    channel: string;
    permalink: string;
}
/** A reply from a Slack thread */
interface Reply {
    author: string;
    text: string;
    timestamp: Date;
}
/** Session state persisted locally */
interface Session {
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
interface StatusPoster {
    postUpdate(update: StatusUpdate, threadId?: string | null): Promise<PostResult>;
}
/** Interface for fetching thread replies */
interface ReplyFetcher {
    fetchReplies(threadId: string, since?: Date): Promise<Reply[]>;
}
/** Interface for local state storage */
interface Store {
    saveSession(session: Session): Promise<void>;
    getActiveSession(userId: string, project: string): Promise<Session | null>;
    updateSession(sessionId: string, updates: Partial<Session>): Promise<void>;
    saveUpdate(update: StatusUpdate & {
        threadId: string;
    }): Promise<void>;
    getRecentUpdates(sessionId: string, limit?: number): Promise<StatusUpdate[]>;
    getLastSeenReplyTimestamp(threadId: string): Promise<Date | null>;
    setLastSeenReplyTimestamp(threadId: string, ts: Date): Promise<void>;
}

interface RateLimitConfig {
    minIntervalMs: number;
    maxPerSession: number;
    maxPerDay: number;
    deduplicationWindowMs: number;
    bypassTypes: string[];
}
interface Config {
    slack: {
        botToken: string;
        channel: string;
        mentionOnBlocker?: string;
    };
    relay?: {
        url: string;
        teamId: string;
    };
    notifications: {
        enabled: boolean;
        onGitPush: boolean;
        onBlocker: boolean;
        onCompletion: boolean;
        verbosity: "minimal" | "normal" | "verbose";
        dryRun: boolean;
    };
    rateLimit: RateLimitConfig;
    user: {
        name: string;
        slackUserId: string;
    };
}
/**
 * State directory (sessions, watermarks).
 * Always uses ~/.claude-report/state/ regardless of CLAUDE_PLUGIN_DATA,
 * because sessions map to Slack threads which are user-scoped shared state.
 * Using the plugin data dir would create duplicate daily threads when the
 * hook runs from different contexts (plugin vs settings.json vs CLI).
 */
declare function getStateDir(): string;
/** Log directory */
declare function getLogDir(): string;
/** Config directory (same as data dir — separate function for future divergence) */
declare function getConfigDir(): string;
/** Check if reporting is disabled for a project */
declare function isProjectDisabled(projectDir: string): boolean;
/**
 * Load config. Resolution order:
 * 1. Plugin env vars (CLAUDE_PLUGIN_OPTION_* / CLAUDE_REPORT_*)
 * 2. Project-level .claude-report.json
 * 3. User-level config.json in data dir
 * 4. Defaults
 */
declare function loadConfig(projectDir?: string): Config;
/** Resolve userId from config with consistent fallback chain */
declare function resolveUserId(config: Config): string;

/**
 * Resolve project name from the working directory.
 * Order: package.json name → git remote origin → directory basename
 * Works with GitHub, GitLab, Bitbucket, and any git remote.
 */
declare function resolveProjectName(projectDir: string): string;
/** Get or create a session for a specific user + project */
declare function getOrCreateSession(userId: string, project: string): Session;
/** Update a project-specific session and persist atomically */
declare function updateSessionForProject(userId: string, project: string, updates: Partial<Session>): Session | null;
/**
 * Update session — finds the session file by scanning state dir.
 * Used when caller doesn't know the project (backward compat).
 */
declare function updateSession(updates: Partial<Session>): Session | null;
/** Read current session for a specific project */
declare function readSessionForProject(userId: string, project: string): Session | null;
/** Read the most recently active session (any project) */
declare function readCurrentSession(): Session | null;

interface RateLimitResult {
    allowed: boolean;
    reason?: string;
}
/**
 * Rate limiter. All state either:
 *   - comes from the persisted `Session` (cross-process: threadId, postCount,
 *     dailyPostCount, lastPostAt, muted, lastPostSummary)
 *   - or is held in-memory on this instance (only meaningful in long-lived
 *     processes like the MCP server)
 *
 * This means the short-lived hook subprocess gets dedup too, because dedup
 * reads `session.lastPostSummary` + `session.lastPostAt` (both persisted).
 *
 * Mute always wins — even bypassTypes honor the mute. `bypassTypes` only
 * exempts from interval/session/daily caps, not from mute or dedup.
 */
declare class RateLimiter {
    private config;
    /** userId → last summary + timestamp. In-memory, bounded. Only useful in MCP server. */
    private lastPostByUser;
    constructor(config: RateLimitConfig);
    shouldPost(update: StatusUpdate, session: Session): RateLimitResult;
    /** Record that a post was made (call after successful post). */
    recordPost(update: StatusUpdate): void;
}
/** Token-based Jaccard similarity. Normalizes whitespace and punctuation. */
declare function tokenSimilarity(a: string, b: string): number;

/**
 * Content filter that enforces length limits, strips secrets, and sanitizes paths.
 * Stateless — safe to share across concurrent callers.
 */
declare class ContentFilter {
    filter(update: StatusUpdate): StatusUpdate;
    /**
     * Check if text appears to contain secrets. Normalizes before scanning so
     * obfuscated variants (fullwidth, ZWSP) are detected.
     */
    containsSecrets(text: string): boolean;
}

/**
 * Posts status updates via the hosted relay service.
 * Bot token never touches the developer's machine.
 *
 * Retries transient failures (network errors, 429, 5xx) with exponential
 * backoff + jitter, honoring Retry-After when present.
 */
declare class RelayPoster implements StatusPoster {
    private relayUrl;
    private apiKey;
    private userName;
    constructor(relayUrl: string, apiKey: string, userName: string);
    postUpdate(update: StatusUpdate, threadId?: string | null): Promise<PostResult>;
}
/**
 * Posts directly to Slack API. @slack/web-api's WebClient has built-in
 * retries via retryConfig.
 */
declare class DirectSlackPoster implements StatusPoster {
    private botToken;
    private channel;
    private userName;
    private client;
    constructor(botToken: string, channel: string, userName: string);
    postUpdate(update: StatusUpdate, threadId?: string | null): Promise<PostResult>;
}
/**
 * Logs updates to a file instead of posting to Slack.
 * Used for dry-run mode and testing.
 */
declare class DryRunPoster implements StatusPoster {
    private logPath;
    private userName;
    private logDirReady;
    constructor(userName: string, logDir?: string);
    postUpdate(update: StatusUpdate, threadId?: string | null): Promise<PostResult>;
}

/**
 * Fetches thread replies via the hosted relay service.
 *
 * Distinguishes auth failures (401/403) from transient failures (429/5xx).
 * Returns [] only on 404 (thread not found). Other errors throw so the
 * caller can decide whether to alert the user.
 */
declare class RelayFetcher implements ReplyFetcher {
    private relayUrl;
    private apiKey;
    constructor(relayUrl: string, apiKey: string);
    fetchReplies(threadId: string, since?: Date): Promise<Reply[]>;
}
/**
 * Fetches thread replies directly from Slack API (fallback for --direct mode).
 */
declare class DirectSlackFetcher implements ReplyFetcher {
    private client;
    private channel;
    constructor(botToken: string, channel: string);
    fetchReplies(threadId: string, since?: Date): Promise<Reply[]>;
}

/**
 * JSON file-based store. Sufficient for ~50 records/day/dev.
 * All mutations go through `withFileLock` to prevent lost updates
 * under concurrent hook processes.
 */
declare class JsonFileStore implements Store {
    private stateDir;
    constructor(stateDir?: string);
    saveSession(session: Session): Promise<void>;
    getActiveSession(userId: string, project: string): Promise<Session | null>;
    updateSession(sessionId: string, updates: Partial<Session>): Promise<void>;
    saveUpdate(update: StatusUpdate & {
        threadId: string;
    }): Promise<void>;
    getRecentUpdates(sessionId: string, limit?: number): Promise<StatusUpdate[]>;
    getLastSeenReplyTimestamp(threadId: string): Promise<Date | null>;
    setLastSeenReplyTimestamp(threadId: string, ts: Date): Promise<void>;
    private path;
    /** Read-modify-write under a file lock. */
    private mutate;
    private readFile;
    private writeFile;
}

/**
 * Escape Slack mrkdwn special characters to prevent injection.
 *
 * Defends against:
 * - `<url|label>` / `<!channel>` / `<!here>` / `<!everyone>` broadcast control sequences
 *   (escaped via &lt; / &gt; — Slack does not parse entity-escaped angle brackets)
 * - `@channel` / `@here` / `@everyone` raw mentions (Slack auto-links in some contexts;
 *   we insert a zero-width space to neutralize)
 * - `*bold*`, `_italic_`, `~strike~`, `` `code` `` formatting injection
 */
declare function escapeSlackMrkdwn(text: string): string;
/**
 * Format a status update as Slack Block Kit blocks.
 */
declare function formatSlackBlocks(update: StatusUpdate, userName: string): object[];
/**
 * Format the daily parent message for a developer.
 */
declare function formatDailyParent(userName: string, project: string, date: string): {
    text: string;
    blocks: object[];
};
/**
 * Format a plain text fallback (for DryRunPoster / logs).
 */
declare function formatPlainText(update: StatusUpdate, userName: string): string;

/**
 * OS-native keychain access using execFileSync (no shell interpolation).
 * macOS: `security` CLI
 * Linux: `secret-tool` CLI
 * Fallback: environment variable
 */
declare function getSecret(account: string): string | null;
/**
 * Store a secret in the OS keychain.
 *
 * SECURITY NOTE: On macOS, `security add-generic-password -w <value>` passes
 * the secret as an argv which is briefly visible via `ps -A` to processes
 * owned by the same user. We pass it via a child-process env var and `-w ""`
 * cannot be used (security CLI doesn't read from stdin). For this reason, we
 * strongly recommend users set CLAUDE_REPORT_SLACK_BOT_TOKEN as an env var
 * rather than calling setSecret. setSecret is a one-time setup path; the
 * exposure window is ~100ms during `claude-report register`.
 */
declare function setSecret(account: string, value: string): boolean;
declare function deleteSecret(account: string): boolean;

/**
 * Atomic JSON write: write to temp file then rename.
 * Prevents corruption from concurrent hook processes.
 * Cleans up temp file on failure.
 */
declare function atomicWriteJson(filePath: string, data: unknown): void;
/**
 * Advisory file lock using mkdir (atomic on all OSes).
 * Protects read-modify-write cycles from concurrent hook processes.
 *
 * Throws LockTimeoutError on contention timeout — callers must decide whether
 * to surface or swallow. NEVER falls through unlocked (that would defeat the point).
 *
 * Stale-lock detection: only steals when the owner PID is demonstrably dead,
 * OR when the lock is older than LOCK_MAX_AGE_MS (absolute fallback).
 */
declare function withFileLock<T>(filePath: string, fn: () => T): T;

/**
 * Send a one-time welcome message when a user first starts using claude-report.
 * Idempotent and concurrent-safe — uses the marker file as a lock so two
 * simultaneous hook invocations don't each send a welcome.
 *
 * Contention handling: if another process holds the lock (actively sending a
 * welcome), we skip silently — the marker will be present on the next check.
 */
declare function sendWelcomeIfNeeded(config: Config): Promise<void>;

/**
 * Parse Claude Code transcript JSONL files to aggregate token usage.
 * Transcripts live at ~/.claude/projects/{project-slug}/{session-id}.jsonl
 */
interface Activity {
    type: "prompt" | "commit" | "push" | "pr" | "test" | "edit";
    text: string;
    time: string;
}
interface SessionUsage {
    sessionId: string;
    project: string;
    /** Absolute cwd at session start, when recoverable from the transcript. */
    cwd?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Number of user prompts sent */
    userMessages: number;
    /** Number of assistant responses (includes tool calls) */
    assistantTurns: number;
    startedAt: string;
    lastActiveAt: string;
    /** Key activities extracted from the session */
    activities: Activity[];
}
interface DailyUsage {
    date: string;
    sessions: SessionUsage[];
    totals: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        userMessages: number;
        assistantTurns: number;
        sessionCount: number;
    };
    estimatedCostUsd: number;
    /** Aggregated key activities across all sessions */
    activities: Activity[];
}
/**
 * Scan all transcript files and aggregate usage for a given date.
 */
declare function getDailyUsage(date: string): DailyUsage;
/**
 * Recompute `totals` AND `estimatedCostUsd` from `usage.sessions`.
 * Call after mutating `usage.sessions` (e.g. filtering out opted-out projects)
 * so the header stats and cost stay in sync with the per-project breakdown.
 */
declare function recomputeUsageTotals(usage: DailyUsage): void;
/**
 * Format daily usage as Slack blocks.
 */
declare function formatUsageSlackBlocks(usage: DailyUsage, userName: string): {
    text: string;
    blocks: object[];
};
/**
 * Render per-project bullet blocks for Slack.
 * Emits one `section` block per project so no single section can exceed
 * Slack's 3000-char limit even if a caller sends maxed-out bullets across
 * many projects. Sanitizes the project name to keep the code span intact
 * (strips backticks / newlines / tabs, entity-escapes `<` `>` `&`) and
 * caps each bullet at 200 chars with an ellipsis tail.
 */
declare function buildProjectBlocks(byProject: Map<string, {
    tokens: number;
    prompts: number;
}>, summaries: Record<string, string[]>): object[];
/**
 * Get per-project context snippets for LLM summarization.
 * Returns a compact text block per project with sampled user prompts + commit messages.
 * Designed to be passed to Claude for summary generation.
 */
declare function getProjectSnippets(usage: DailyUsage): string;

/** Get the git user name for the current directory */
declare function getGitUser(): string | null;
/** Get the git user email for the current directory */
declare function getGitEmail(): string | null;
/**
 * Check if reporting is enabled for the current git user.
 * If no users are enabled, returns true (feature not active — report everywhere).
 * Once at least one user is enabled, only enabled users emit logs.
 * Matches against both git user.name and user.email.
 */
declare function isUserEnabled(projectDir?: string): boolean;
/** Enable a git user for reporting. */
declare function enableUser(identifier: string): {
    added: boolean;
    user: string;
};
/** Disable a git user from reporting. */
declare function disableUser(identifier: string): {
    removed: boolean;
    user: string;
};
/** List all enabled users. */
declare function listEnabledUsers(): string[];

/**
 * Create the appropriate poster based on config.
 * Returns null if posting is disabled.
 */
declare function createPoster(config: Config, projectDir?: string): StatusPoster | null;
/**
 * Create the appropriate reply fetcher based on config.
 */
declare function createFetcher(config: Config): ReplyFetcher | null;

export { type Config, ContentFilter, type DailyUsage, DirectSlackFetcher, DirectSlackPoster, DryRunPoster, JsonFileStore, type PostResult, type RateLimitConfig, type RateLimitResult, RateLimiter, RelayFetcher, RelayPoster, type Reply, type ReplyFetcher, type Session, type SessionUsage, type StatusPoster, type StatusUpdate, type Store, type UpdateMetadata, type UpdateType, atomicWriteJson, buildProjectBlocks, createFetcher, createPoster, deleteSecret, disableUser, enableUser, escapeSlackMrkdwn, formatDailyParent, formatPlainText, formatSlackBlocks, formatUsageSlackBlocks, getConfigDir, getDailyUsage, getGitEmail, getGitUser, getLogDir, getOrCreateSession, getProjectSnippets, getSecret, getStateDir, isProjectDisabled, isUserEnabled, listEnabledUsers, loadConfig, readCurrentSession, readSessionForProject, recomputeUsageTotals, resolveProjectName, resolveUserId, sendWelcomeIfNeeded, setSecret, tokenSimilarity, updateSession, updateSessionForProject, withFileLock };
