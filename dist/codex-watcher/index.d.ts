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

/**
 * Codex watcher daemon — long-lived process that tails Codex CLI session
 * JSONL files and posts real-time activity-log events (git push / commit /
 * PR / test failure) to the same Slack daily thread that the Claude Code
 * PostToolUse hook already writes to. Run via launchd with KeepAlive=true.
 *
 * Why a daemon and not a hook: Codex doesn't expose Claude-Code-style
 * external hooks, and the active session file isn't named — sessions can
 * span midnight, resumed sessions append to their original file (potentially
 * in an older date directory), and multiple sessions can run concurrently.
 * Per the Codex agent's own scoping review, the only robust read-only
 * approach is to recursively walk ~/.codex/sessions/** and tail every file
 * that has grown since we last looked.
 */

interface DetectedEvent {
    type: UpdateType;
    summary: string;
    details?: string;
    metadata?: UpdateMetadata;
}
interface EventContext {
    cwd: string | undefined;
    ts: string | undefined;
    /** Codex session UUID — useful for de-duping if the same line is re-read. */
    sessionId: string;
}
/**
 * Translate one parsed JSONL entry into a DetectedEvent (or null). Pure
 * function — no I/O, easy to unit-test.
 */
declare function eventFromCodexLine(entry: any): {
    event: DetectedEvent;
    ctx: EventContext;
} | null;
declare function run(): Promise<void>;

export { eventFromCodexLine, run };
