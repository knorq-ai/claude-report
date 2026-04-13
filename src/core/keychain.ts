import { execFileSync } from "node:child_process";
import { platform } from "node:os";

const SERVICE = "claude-report";

/**
 * OS-native keychain access using execFileSync (no shell interpolation).
 * macOS: `security` CLI
 * Linux: `secret-tool` CLI
 * Fallback: environment variable
 */
export function getSecret(account: string): string | null {
  const envKey = `CLAUDE_REPORT_${account.toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey]) {
    return process.env[envKey]!;
  }

  const os = platform();

  try {
    if (os === "darwin") {
      const result = execFileSync(
        "security",
        ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return result.trim() || null;
    }

    if (os === "linux") {
      const result = execFileSync(
        "secret-tool",
        ["lookup", "service", SERVICE, "account", account],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return result.trim() || null;
    }
  } catch {
    // Keychain not available or entry not found
  }

  return null;
}

export function setSecret(account: string, value: string): boolean {
  const os = platform();

  try {
    if (os === "darwin") {
      // Delete existing entry first (ignore error if not found)
      try {
        execFileSync(
          "security",
          ["delete-generic-password", "-s", SERVICE, "-a", account],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch {
        // Not found — fine
      }
      execFileSync(
        "security",
        ["add-generic-password", "-s", SERVICE, "-a", account, "-w", value],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    }

    if (os === "linux") {
      execFileSync(
        "secret-tool",
        [
          "store",
          `--label=claude-report ${account}`,
          "service", SERVICE,
          "account", account,
        ],
        { input: value, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    }
  } catch {
    // Keychain not available
  }

  return false;
}

export function deleteSecret(account: string): boolean {
  const os = platform();

  try {
    if (os === "darwin") {
      execFileSync(
        "security",
        ["delete-generic-password", "-s", SERVICE, "-a", account],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    }

    if (os === "linux") {
      execFileSync(
        "secret-tool",
        ["clear", "service", SERVICE, "account", account],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    }
  } catch {
    // Not found or not available
  }

  return false;
}
