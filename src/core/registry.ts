import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import { atomicWriteJson } from "./fs-utils.js";

interface Registry {
  /** Git user names/emails that are enabled for reporting */
  enabledUsers: string[];
}

function registryPath(): string {
  return join(getConfigDir(), "registry.json");
}

function loadRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return { enabledUsers: [] };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { enabledUsers: [] };
  }
}

function saveRegistry(registry: Registry): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(registryPath(), registry);
}

/** Get the git user name for the current directory */
export function getGitUser(): string | null {
  try {
    return execFileSync("git", ["config", "user.name"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Get the git user email for the current directory */
export function getGitEmail(): string | null {
  try {
    return execFileSync("git", ["config", "user.email"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if reporting is enabled for the current git user.
 * If no users are enabled, returns true (feature not active — report everywhere).
 * Once at least one user is enabled, only enabled users emit logs.
 * Matches against both git user.name and user.email.
 */
export function isUserEnabled(projectDir?: string): boolean {
  const registry = loadRegistry();
  if (registry.enabledUsers.length === 0) return true;

  const name = getGitUser();
  const email = getGitEmail();

  return registry.enabledUsers.some((entry) => {
    const lower = entry.toLowerCase();
    return (
      (name && name.toLowerCase() === lower) ||
      (email && email.toLowerCase() === lower)
    );
  });
}

/** Enable a git user for reporting. */
export function enableUser(identifier: string): { added: boolean; user: string } {
  const registry = loadRegistry();
  const lower = identifier.toLowerCase();
  const exists = registry.enabledUsers.some((u) => u.toLowerCase() === lower);
  if (exists) {
    return { added: false, user: identifier };
  }
  registry.enabledUsers.push(identifier);
  saveRegistry(registry);
  return { added: true, user: identifier };
}

/** Disable a git user from reporting. */
export function disableUser(identifier: string): { removed: boolean; user: string } {
  const registry = loadRegistry();
  const lower = identifier.toLowerCase();
  const idx = registry.enabledUsers.findIndex((u) => u.toLowerCase() === lower);
  if (idx === -1) {
    return { removed: false, user: identifier };
  }
  registry.enabledUsers.splice(idx, 1);
  saveRegistry(registry);
  return { removed: true, user: identifier };
}

/** List all enabled users. */
export function listEnabledUsers(): string[] {
  return loadRegistry().enabledUsers;
}
