import type { StatusUpdate } from "./types.js";

const MAX_SUMMARY_LENGTH = 150;
const MAX_DETAILS_LENGTH = 500;

/**
 * Patterns that identify secrets. Each match is replaced with "[REDACTED]".
 *
 * Design notes:
 * - Patterns are stored as source strings (no /g flag) and compiled fresh
 *   per call. This avoids `lastIndex` mutation races when the filter is
 *   shared across concurrent callers (e.g., the MCP server).
 * - Ordering: most specific patterns first so they match before greedy
 *   fallbacks like the generic hex catch-all.
 */
/**
 * Each secret pattern tagged with its required flags.
 *
 * Case-sensitive patterns (`"g"`): token formats with specific casing
 * (`AKIA`, `ghp_`, `sk-`) where case is part of the literal identifier.
 *
 * Case-insensitive patterns (`"gi"`): named key-value forms where
 * `password=`, `Password=`, `PASSWORD=` are all the same threat.
 */
interface SecretPattern {
  source: string;
  flags: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // AWS
  { source: "AKIA[0-9A-Z]{16}", flags: "g" },
  // AWS secret (40-char base64). Require at least one non-hex character
  // ([G-Zg-z] or `/` `+`) to avoid matching 40-char git SHAs.
  { source: "(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[G-Zg-z/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])", flags: "g" },
  // Slack
  { source: "xox[baprs]-[0-9A-Za-z-]{10,}", flags: "g" },
  // GitHub
  { source: "ghp_[A-Za-z0-9]{36,}", flags: "g" },
  { source: "github_pat_[A-Za-z0-9_]{20,}", flags: "g" },
  { source: "gh[ousr]_[A-Za-z0-9]{20,}", flags: "g" },
  // LLM providers
  { source: "sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}", flags: "g" },
  { source: "AIza[0-9A-Za-z_-]{35}", flags: "g" },
  // Stripe
  { source: "sk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "g" },
  { source: "rk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "g" },
  // NPM
  { source: "npm_[A-Za-z0-9]{36,}", flags: "g" },
  // JWT — 2-part or 3-part; bounded {10,2048} per segment prevents backtracking.
  { source: "eyJ[A-Za-z0-9_-]{10,2048}\\.[A-Za-z0-9_-]{10,2048}(?:\\.[A-Za-z0-9_-]{10,2048})?", flags: "g" },
  // Private keys — three tiers to handle malformed/truncated PEMs.
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----", flags: "g" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END [A-Z0-9 ]+-----", flags: "g" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[ \\t]*\\n[A-Za-z0-9+/=\\s]{0,8192})?", flags: "g" },
  // Azure / cloud connection strings (keyword case-insensitive)
  { source: "DefaultEndpointsProtocol=[^\\s\"']+AccountKey=[^\\s\"';]+", flags: "gi" },
  // URL basic-auth — redact entire URL (host/path reveals internal infra)
  { source: "[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^:/?#\\s\"']+:[^@/?#\\s\"']+@[^\\s\"'<>]+", flags: "g" },
  // Bearer tokens in Authorization headers
  { source: "bearer\\s+[A-Za-z0-9_\\-\\.=+/]{16,}", flags: "gi" },
  // Named key=value secrets — CASE INSENSITIVE because `Password=`, `PW=`,
  // `ApiKey=` are all real in logs and must redact.
  { source: "(?:password|passwd|pwd|pw|secret|token|credentials|api[_-]?key|auth[_-]?token|access[_-]?token|access[_-]?key|refresh[_-]?token|client[_-]?secret|session[_-]?key|private[_-]?key)\\s*[=:]\\s*[\"']?[^\\s\"'{}<>,;]+", flags: "gi" },
  // Long hex strings last (avoids eating git SHAs which are ≤40 hex)
  { source: "(?<![a-f0-9])[a-f0-9]{64,}(?![a-f0-9])", flags: "g" },
];

/**
 * Compile fresh RegExp instances on every call. This is cheap for our
 * inputs (<1KB summaries) and eliminates `lastIndex` mutation races that
 * would otherwise plague a module-level `/g` regex shared across callers.
 */
function compilePatterns(): RegExp[] {
  return SECRET_PATTERNS.map((p) => new RegExp(p.source, p.flags));
}

/**
 * Paths that often reveal usernames or internal infra. Replaced with
 * last-two-segments to preserve context without leaking directory tree.
 * Supports POSIX and Windows (`C:\Users\...`).
 */
const PATH_PATTERNS: RegExp[] = [
  /(?:\/(?:Users|home|root|var|etc|tmp|opt|mnt|data|workspace|private\/var)\/\S+)/g,
  /(?:[A-Za-z]:\\(?:Users|Windows|ProgramData)\\[^\s"']+)/g,
];

/**
 * Content filter that enforces length limits, strips secrets, and sanitizes paths.
 * Stateless — safe to share across concurrent callers.
 */
export class ContentFilter {
  filter(update: StatusUpdate): StatusUpdate {
    const filtered = { ...update };

    filtered.summary = truncate(filtered.summary, MAX_SUMMARY_LENGTH);
    if (filtered.details) {
      filtered.details = truncate(filtered.details, MAX_DETAILS_LENGTH);
    }

    filtered.summary = stripSecrets(filtered.summary);
    if (filtered.details) {
      filtered.details = stripSecrets(filtered.details);
    }

    filtered.summary = sanitizePaths(filtered.summary);
    if (filtered.details) {
      filtered.details = sanitizePaths(filtered.details);
    }

    return filtered;
  }

  /** Check if text appears to contain secrets. */
  containsSecrets(text: string): boolean {
    return compilePatterns().some((pattern) => pattern.test(text));
  }
}

/**
 * Truncate at a grapheme cluster boundary (not a UTF-16 code unit) to
 * avoid corrupting surrogate pairs in emoji / Japanese / other non-BMP text.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const suffix = "...";
  const sliceLen = Math.max(0, maxLength - suffix.length);
  const chars = Array.from(text); // iterates by code point, not code unit
  if (chars.length <= maxLength) return text;
  return chars.slice(0, sliceLen).join("") + suffix;
}

function stripSecrets(text: string): string {
  let result = text;
  for (const pattern of compilePatterns()) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function sanitizePaths(text: string): string {
  let result = text;
  for (const pattern of PATH_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const sep = match.includes("\\") ? "\\" : "/";
      const parts = match.split(/[\\/]/).filter(Boolean);
      if (parts.length <= 2) return match;
      return "..." + sep + parts.slice(-2).join(sep);
    });
  }
  return result;
}
