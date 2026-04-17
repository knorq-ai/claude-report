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
      // macOS limitation: secret must be in argv. Keep exposure window short
      // by omitting labels / comments that would extend argv serialization.
      execFileSync(
        "security",
        ["add-generic-password", "-s", SERVICE, "-a", account, "-U", "-w", value],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      return true;
    }

    if (os === "linux") {
      // Linux: secret-tool reads password from stdin (safe from ps -A).
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
