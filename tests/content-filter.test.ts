import { describe, it, expect } from "vitest";
import { ContentFilter } from "../src/core/content-filter.js";
import type { StatusUpdate } from "../src/core/types.js";

function makeUpdate(overrides: Partial<StatusUpdate> = {}): StatusUpdate {
  return {
    type: "status",
    summary: "Working on feature",
    timestamp: new Date(),
    userId: "U123",
    sessionId: "sess-1",
    project: "my-project",
    ...overrides,
  };
}

describe("ContentFilter", () => {
  const filter = new ContentFilter();

  describe("length enforcement", () => {
    it("truncates summary longer than 150 chars", () => {
      const longSummary = "x".repeat(200);
      const result = filter.filter(makeUpdate({ summary: longSummary }));
      expect(result.summary.length).toBe(150);
      expect(result.summary.endsWith("...")).toBe(true);
    });

    it("truncates details longer than 500 chars", () => {
      const longDetails = "y".repeat(600);
      const result = filter.filter(makeUpdate({ details: longDetails }));
      expect(result.details!.length).toBe(500);
      expect(result.details!.endsWith("...")).toBe(true);
    });

    it("preserves short text as-is", () => {
      const result = filter.filter(makeUpdate({ summary: "short" }));
      expect(result.summary).toBe("short");
    });
  });

  describe("secret stripping", () => {
    it("redacts AWS access keys", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Found key AKIAIOSFODNN7EXAMPLE" }),
      );
      expect(result.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts JWT tokens", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
      const result = filter.filter(
        makeUpdate({ summary: `Token: ${jwt}` }),
      );
      expect(result.summary).not.toContain("eyJ");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts Slack bot tokens", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Token is xoxb-1234-5678-abcdef" }),
      );
      expect(result.summary).not.toContain("xoxb-");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts GitHub PATs", () => {
      const result = filter.filter(
        makeUpdate({
          summary: "Using ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        }),
      );
      expect(result.summary).not.toContain("ghp_");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts key=value secrets", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Set password=mysecretpass123" }),
      );
      expect(result.summary).not.toContain("mysecretpass123");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("preserves clean text", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Implemented user auth" }),
      );
      expect(result.summary).toBe("Implemented user auth");
    });
  });

  describe("path sanitization", () => {
    it("sanitizes absolute paths", () => {
      const result = filter.filter(
        makeUpdate({
          summary: "Editing /Users/yuya/Projects/secret-project/src/index.ts",
        }),
      );
      expect(result.summary).not.toContain("/Users/yuya/Projects");
      expect(result.summary).toContain(".../src/index.ts");
    });

    it("preserves relative paths", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Editing src/index.ts" }),
      );
      expect(result.summary).toBe("Editing src/index.ts");
    });
  });

  describe("containsSecrets", () => {
    it("detects AWS keys", () => {
      expect(filter.containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    });

    it("returns false for clean text", () => {
      expect(filter.containsSecrets("normal text")).toBe(false);
    });

    it("is safe under concurrent calls (no lastIndex mutation race)", () => {
      // Run 100 overlapping containsSecrets calls — if /g-flag state were
      // shared, results would alternate true/false. They must be consistent.
      const results = Array.from({ length: 100 }, (_, i) =>
        filter.containsSecrets(
          i % 2 === 0 ? "AKIAIOSFODNN7EXAMPLE" : "plain text",
        ),
      );
      for (let i = 0; i < 100; i++) {
        expect(results[i]).toBe(i % 2 === 0);
      }
    });
  });

  describe("extended secret patterns", () => {
    it("redacts GitHub fine-grained PAT (github_pat_*)", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Using github_pat_11ABCDEFGHIJKLMNOPQRST_abcdef123456" }),
      );
      expect(result.summary).not.toContain("github_pat_");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts GitHub app tokens (ghs_, ghu_, gho_, ghr_)", () => {
      for (const prefix of ["ghs_", "ghu_", "gho_", "ghr_"]) {
        const result = filter.filter(
          makeUpdate({ summary: `Token: ${prefix}ABCDEFGHIJKLMNOPQRSTUV` }),
        );
        expect(result.summary, `prefix=${prefix}`).toContain("[REDACTED]");
      }
    });

    it("redacts Google API keys (AIza...)", () => {
      const key = "AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI";
      const result = filter.filter(makeUpdate({ summary: `key=${key}` }));
      expect(result.summary).not.toContain(key);
    });

    it("redacts npm tokens", () => {
      const result = filter.filter(
        makeUpdate({ summary: "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789" }),
      );
      expect(result.summary).not.toContain("npm_abcdefghij");
    });

    it("redacts Bearer tokens in Authorization headers", () => {
      const result = filter.filter(
        makeUpdate({ summary: "curl -H 'Authorization: Bearer abc123DEF456ghi789JKL' api.com" }),
      );
      expect(result.summary).toContain("[REDACTED]");
      expect(result.summary).not.toContain("abc123DEF456ghi789JKL");
    });

    it("redacts private key headers", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Key: -----BEGIN RSA PRIVATE KEY-----" }),
      );
      expect(result.summary).toContain("[REDACTED]");
    });

    it("does NOT false-positive on git SHAs (40 hex)", () => {
      // 40-char hex = git SHA; should NOT be redacted (only 64+ hex is)
      const result = filter.filter(
        makeUpdate({ summary: "commit a1b2c3d4e5f60718293a4b5c6d7e8f901234abcd applied" }),
      );
      expect(result.summary).toContain("a1b2c3d4e5f60718293a4b5c6d7e8f901234abcd");
    });

    it("does NOT false-positive on benign words containing 'password'", () => {
      const result = filter.filter(
        makeUpdate({ summary: "Working on password reset flow" }),
      );
      // "password reset" doesn't match "password = value" pattern
      expect(result.summary).toContain("password reset");
    });
  });

  describe("obfuscation bypass defenses", () => {
    it("redacts lowercase AWS access keys (akia...)", () => {
      const result = filter.filter(
        makeUpdate({ summary: "key = akiaIOSFODNN7example" }),
      );
      expect(result.summary).not.toContain("akiaIOSFODNN7example");
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts AKIA split by zero-width space", () => {
      const result = filter.filter(
        makeUpdate({ summary: "key=AKIA\u200BIOSFODNN7EXAMPLE" }),
      );
      expect(result.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts fullwidth = separator: password＝hunter2", () => {
      // Fullwidth = (U+FF1D) should normalize to ASCII = before scanning
      const result = filter.filter(
        makeUpdate({ summary: "password＝hunter2supersecret" }),
      );
      expect(result.summary).not.toContain("hunter2supersecret");
    });

    it("redacts base64-wrapped secrets (48+ chars with +/= signals)", () => {
      // Realistic 56-char base64 with `+` and `=` — signature of binary data
      const b64 = "ZGVhZGJlZWZkZWFkYmVlZmRlYWRiZWVmZGVhZGJlZWZkZWFk+YmVlZg==";
      const result = filter.filter(makeUpdate({ summary: `creds: ${b64}` }));
      expect(result.summary).toContain("[REDACTED]");
      expect(result.summary).not.toContain(b64);
    });

    it("does NOT redact repeated letters (not real base64)", () => {
      const result = filter.filter(makeUpdate({ summary: "y".repeat(100) }));
      // 100 `y`s — no +/= → should not trigger base64 pattern
      expect(result.summary).not.toContain("[REDACTED]");
    });

    it("case-insensitive matching for named secrets (Password= / PW= / SECRET=)", () => {
      for (const variant of ["Password=hunter2abc", "PW=hunter2abcdef", "SECRET=myproductkey"]) {
        const result = filter.filter(makeUpdate({ summary: variant }));
        expect(result.summary, variant).toContain("[REDACTED]");
      }
    });

    it("redacts Cyrillic homoglyph AKIA (АKIA)", () => {
      // Cyrillic А (U+0410) looks identical to Latin A
      const result = filter.filter(
        makeUpdate({ summary: "key=АKIAIOSFODNN7EXAMPLE" }),
      );
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts Greek homoglyph (Ρassword)", () => {
      // Greek Ρ (U+03A1) looks like Latin P
      const result = filter.filter(
        makeUpdate({ summary: "Ρassword=hunter2abcdefg" }),
      );
      expect(result.summary).toContain("[REDACTED]");
    });

    it("redacts JSON-quoted secrets", () => {
      const result = filter.filter(
        makeUpdate({ summary: 'config: {"password":"hunter2abcdef","env":"prod"}' }),
      );
      expect(result.summary).toContain("[REDACTED]");
      expect(result.summary).not.toContain("hunter2abcdef");
    });

    it("redacts YAML-quoted secrets", () => {
      const result = filter.filter(
        makeUpdate({ summary: "api_key: hunter2abcdef" }),
      );
      expect(result.summary).toContain("[REDACTED]");
    });
  });

  describe("grapheme-safe truncation", () => {
    it("does not corrupt emoji across truncation boundary", () => {
      // 50 grinning-face emoji = 100 UTF-16 code units, 50 code points
      const emoji = "\u{1F600}".repeat(50);
      const padding = "x".repeat(200);
      const result = filter.filter(makeUpdate({ summary: padding + emoji }));
      // The result should not contain lone surrogates (which render as "?" or "")
      for (const ch of result.summary) {
        const code = ch.codePointAt(0)!;
        expect(code < 0xd800 || code > 0xdfff).toBe(true);
      }
    });
  });
});
