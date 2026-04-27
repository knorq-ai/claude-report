/**
 * Pure detector for git push / commit / PR / test-failure events from a
 * shell command + its output. Shared between the Claude Code PostToolUse
 * hook and the Codex watcher daemon.
 *
 * No side effects on import — safe for the long-lived watcher to import.
 * Extracted from src/hooks/post-tool-use.ts unchanged.
 */

import type { UpdateType, UpdateMetadata } from "./types.js";

export interface DetectedEvent {
  type: UpdateType;
  summary: string;
  details?: string;
  metadata?: UpdateMetadata;
}

export function detectBashEvent(command: string, output: string): DetectedEvent | null {
  // 1. Git push — prefer the "->" line from output as the source of truth.
  //    Command-line parsing is fragile: `git push -u origin HEAD`,
  //    `--force-with-lease`, multi-refspec pushes all mis-extract.
  if (/\bgit\s+push\b/.test(command) && !/--dry-run/.test(command)) {
    if (/^To\s+/m.test(output)) {
      const branch = extractBranch(command, output);
      return {
        type: "push",
        summary: `Pushed to ${branch}`,
        metadata: { branch },
      };
    }
    return null; // Push failed
  }

  // 2. Git commit — anchor match to start-of-line to avoid matching ']' in
  //    the middle of prior output (e.g., `git commit --amend` showing old commit).
  if (/\bgit\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
    const commitMatches = [...output.matchAll(/^\[([^\s\]]+)[^\]]*\]\s+(.+)$/gm)];
    if (commitMatches.length > 0) {
      // Take the LAST match — for --amend, this is the new commit
      const last = commitMatches[commitMatches.length - 1];
      const branch = last[1];
      const commitMsg = last[2].trim().slice(0, 100);
      return {
        type: "status",
        summary: `Committed: ${commitMsg}`,
        metadata: { branch },
      };
    }
    return null;
  }

  // 3. gh pr create
  if (/\bgh\s+pr\s+create\b/.test(command)) {
    const urlMatch = output.match(/(https:\/\/github\.com\/\S+\/pull\/\d+)/);
    if (urlMatch) {
      return {
        type: "completion",
        summary: `PR created: ${urlMatch[1]}`,
        metadata: { prUrl: urlMatch[1] },
      };
    }
    return null;
  }

  // 4. Test failures — require a positive failure signal to avoid false positives
  //    from words like "error" or "0 failed" in passing output.
  if (isTestCommand(command)) {
    const hasExitError = /Exit code [1-9]|exit code [1-9]|exited with (?:code )?[1-9]/i.test(output);
    const failCountMatch = output.match(/(\d+)\s+(?:failed|failing)/i);
    const failCount = failCountMatch ? Number.parseInt(failCountMatch[1], 10) : 0;
    if (hasExitError || failCount > 0) {
      const summary = failCount > 0
        ? `Tests failing: ${failCount} failure${failCount === 1 ? "" : "s"}`
        : "Tests failing";
      return { type: "blocker", summary };
    }
  }

  return null;
}

function extractBranch(command: string, output: string): string {
  const outMatch = output.match(
    /(?:\[new branch\]|\w+\.\.\w+|\*)\s+\S+\s+->\s+(\S+)/m,
  );
  if (outMatch) return outMatch[1];

  const branchQuote = output.match(/branch\s+'([^']+)'/);
  if (branchQuote) return branchQuote[1];

  const tokens = command.split(/\s+/).filter((t) => !t.startsWith("-"));
  const pushIdx = tokens.indexOf("push");
  if (pushIdx >= 0 && tokens.length > pushIdx + 2) {
    const refspec = tokens[pushIdx + 2];
    if (refspec && refspec !== "HEAD") {
      return refspec.includes(":") ? refspec.split(":").pop()! : refspec;
    }
  }

  return "unknown";
}

function isTestCommand(command: string): boolean {
  return /\b(npm\s+test|npx\s+vitest|npx\s+jest|pytest|go\s+test|cargo\s+test|make\s+test|yarn\s+test|pnpm\s+test)\b/.test(command);
}
