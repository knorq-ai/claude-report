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

/**
 * All secret patterns use the `i` flag. Historical wisdom says token prefixes
 * like `AKIA`, `ghp_`, `sk-` are "always uppercase/lowercase" — but attackers
 * can trivially lowercase them in a commit message to bypass detection. Since
 * our patterns are specific enough that case-insensitivity doesn't cause
 * false-positives, we default everything to `gi`.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // AWS access key id
  { source: "AKIA[0-9A-Z]{16}", flags: "gi" },
  // AWS secret (40-char base64). Require at least one non-hex character
  // to avoid matching 40-char git SHAs.
  { source: "(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*[G-Zg-z/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])", flags: "g" },
  // Slack
  { source: "xox[baprs]-[0-9A-Za-z-]{10,}", flags: "gi" },
  // GitHub
  { source: "ghp_[A-Za-z0-9]{36,}", flags: "gi" },
  { source: "github_pat_[A-Za-z0-9_]{20,}", flags: "gi" },
  { source: "gh[ousr]_[A-Za-z0-9]{20,}", flags: "gi" },
  // LLM providers
  { source: "sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}", flags: "gi" },
  { source: "AIza[0-9A-Za-z_-]{35}", flags: "gi" },
  // Stripe
  { source: "sk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "gi" },
  { source: "rk_(?:live|test)_[A-Za-z0-9]{20,}", flags: "gi" },
  // NPM
  { source: "npm_[A-Za-z0-9]{36,}", flags: "gi" },
  // JWT — 2-part or 3-part; bounded {10,2048} per segment prevents backtracking.
  { source: "eyJ[A-Za-z0-9_-]{10,2048}\\.[A-Za-z0-9_-]{10,2048}(?:\\.[A-Za-z0-9_-]{10,2048})?", flags: "gi" },
  // Private keys — three tiers to handle malformed/truncated PEMs.
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----", flags: "gi" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,8192}?-----END [A-Z0-9 ]+-----", flags: "gi" },
  { source: "-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:[ \\t]*\\n[A-Za-z0-9+/=\\s]{0,8192})?", flags: "gi" },
  // Azure / cloud connection strings
  { source: "DefaultEndpointsProtocol=[^\\s\"']+AccountKey=[^\\s\"';]+", flags: "gi" },
  // URL basic-auth — redact entire URL (host/path reveals internal infra)
  { source: "[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^:/?#\\s\"']+:[^@/?#\\s\"']+@[^\\s\"'<>]+", flags: "gi" },
  // Bearer tokens in Authorization headers
  { source: "bearer\\s+[A-Za-z0-9_\\-\\.=+/]{16,}", flags: "gi" },
  // Named key=value secrets. ALSO allows a surrounding wider separator match
  // (any whitespace, including no space) — and accepts Unicode = fullwidth
  // equivalents via NFKC normalization applied before matching (see filter()).
  { source: "(?:password|passwd|pwd|pw|secret|token|credentials|api[_-]?key|auth[_-]?token|access[_-]?token|access[_-]?key|refresh[_-]?token|client[_-]?secret|session[_-]?key|private[_-]?key)\\s*[=:]\\s*[\"']?[^\\s\"'{}<>,;]+", flags: "gi" },
  // Base64-wrapped secrets: 48+ chars of base64 alphabet that must include
  // at least one `+`/`/` (standard base64) OR end with `=` padding — these
  // are strong signals of binary base64, not incidental text like "yyyy...".
  // Still avoids eating plain long words/repeated chars.
  { source: "(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/]*[+/]|[A-Za-z0-9+/]{48,}=)[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/=])", flags: "g" },
  // Long hex strings last (avoids eating git SHAs which are ≤40 hex)
  { source: "(?<![a-f0-9])[a-f0-9]{64,}(?![a-f0-9])", flags: "gi" },
];

/**
 * Invisible / formatting Unicode characters often used to split secret
 * patterns (e.g., `AKIA\u200BIOSFO...`). Stripped before scanning.
 *
 * - U+200B ZERO WIDTH SPACE
 * - U+200C ZERO WIDTH NON-JOINER
 * - U+200D ZERO WIDTH JOINER
 * - U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
 * - U+2060 WORD JOINER
 * - U+00AD SOFT HYPHEN
 * - U+180E MONGOLIAN VOWEL SEPARATOR
 * - U+034F COMBINING GRAPHEME JOINER
 */
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\u2060\u00AD\uFEFF\u180E\u034F]/g;

/**
 * Normalize text before secret scanning:
 *   1. Unicode NFKC — collapses fullwidth `＝` → ASCII `=`, `Ｐ` → `P`, etc.
 *   2. Strip invisible/formatting chars that split regex matches.
 *
 * We run the filter on the NORMALIZED text but preserve the original for
 * the final output — the replacements happen on the original indices using
 * match positions from the normalized scan. Simpler approach: replace both
 * normalized and original; the normalized form is what the user sees in
 * Slack anyway (readable).
 */
function normalizeForScan(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CHARS_RE, "");
}

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

    // Normalize BEFORE scanning (collapses fullwidth chars, strips invisible
    // separators) AND before output — the user sees the normalized form in
    // Slack. Normalized text also means less room for obfuscation games.
    filtered.summary = stripSecrets(normalizeForScan(filtered.summary));
    if (filtered.details) {
      filtered.details = stripSecrets(normalizeForScan(filtered.details));
    }

    filtered.summary = sanitizePaths(filtered.summary);
    if (filtered.details) {
      filtered.details = sanitizePaths(filtered.details);
    }

    return filtered;
  }

  /**
   * Check if text appears to contain secrets. Normalizes before scanning so
   * obfuscated variants (fullwidth, ZWSP) are detected.
   */
  containsSecrets(text: string): boolean {
    const normalized = normalizeForScan(text);
    return compilePatterns().some((pattern) => pattern.test(normalized));
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
