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
 * Claude Code hook: PostToolUse
 *
 * Deterministic event detection — fires on Bash and TaskUpdate tool calls.
 * Detects: git push, git commit, gh pr create, test failures, task completion.
 */

interface HookInput {
    tool_name: string;
    tool_input: Record<string, any>;
    tool_output?: string;
    /** Claude Code passes tool_response as {stdout, stderr, interrupted, ...} for Bash */
    tool_response?: string | {
        stdout?: string;
        stderr?: string;
        [key: string]: unknown;
    };
    /** Current working directory of the Claude Code session */
    cwd?: string;
    session_id?: string;
}
/** Get tool output from hook input — handles both field names and structured responses. */
declare function getToolOutput(input: HookInput): string;
interface DetectedEvent {
    type: UpdateType;
    summary: string;
    details?: string;
    metadata?: UpdateMetadata;
}
declare function detectBashEvent(command: string, output: string): DetectedEvent | null;
declare function detectTaskEvent(input: Record<string, any>, output: string, rawResponse?: unknown, taskSubjectLookup?: (taskId: string) => string | undefined): DetectedEvent | null;
/** Extract task subject and description from tool_output text */
declare function parseTaskOutput(output: string): {
    subject?: string;
    description?: string;
};

export { type DetectedEvent, detectBashEvent, detectTaskEvent, getToolOutput, parseTaskOutput };
