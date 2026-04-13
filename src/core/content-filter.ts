import type { StatusUpdate } from "./types.js";

const MAX_SUMMARY_LENGTH = 150;
const MAX_DETAILS_LENGTH = 500;

/** Patterns that look like secrets */
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g, // AWS access key
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, // JWT
  /xoxb-[0-9A-Za-z-]+/g, // Slack bot token
  /xoxp-[0-9A-Za-z-]+/g, // Slack user token
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub PAT
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic key
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/g, // Stripe key
  /[0-9a-f]{64,}/g, // Very long hex strings (potential secrets, avoids git SHA false positives)
  /(?:password|secret|token|api_key|apikey|auth)\s*[=:]\s*\S+/gi, // key=value secrets
];

/** Absolute path pattern */
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|root|var|etc|tmp)\/\S+)/g;

/**
 * Content filter that enforces length limits, strips secrets, and sanitizes paths.
 */
export class ContentFilter {
  filter(update: StatusUpdate): StatusUpdate {
    const filtered = { ...update };

    // Enforce length limits
    filtered.summary = truncate(filtered.summary, MAX_SUMMARY_LENGTH);
    if (filtered.details) {
      filtered.details = truncate(filtered.details, MAX_DETAILS_LENGTH);
    }

    // Strip secrets
    filtered.summary = stripSecrets(filtered.summary);
    if (filtered.details) {
      filtered.details = stripSecrets(filtered.details);
    }

    // Sanitize absolute paths
    filtered.summary = sanitizePaths(filtered.summary);
    if (filtered.details) {
      filtered.details = sanitizePaths(filtered.details);
    }

    return filtered;
  }

  /** Check if text appears to contain secrets */
  containsSecrets(text: string): boolean {
    return SECRET_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function stripSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function sanitizePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_PATTERN, (match) => {
    // Keep just the last 2 path segments
    const parts = match.split("/").filter(Boolean);
    if (parts.length <= 2) return match;
    return ".../" + parts.slice(-2).join("/");
  });
}
