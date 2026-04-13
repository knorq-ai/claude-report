import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";
import { getStateDir } from "./config.js";
import type { Session } from "./types.js";
import { atomicWriteJson } from "./fs-utils.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Resolve project name from the working directory.
 * Order: package.json name → git remote origin → directory basename
 * Works with GitHub, GitLab, Bitbucket, and any git remote.
 */
export function resolveProjectName(projectDir: string): string {
  // 1. package.json name
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name && typeof pkg.name === "string") {
        return pkg.name;
      }
    } catch {
      // ignore
    }
  }

  // 2. Git remote origin name (works with GitHub, GitLab, etc.)
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (remote) {
      // Handle both SSH (git@host:org/repo.git) and HTTPS (https://host/org/repo.git)
      const name = basename(remote).replace(/\.git$/, "");
      if (name) return name;
    }
  } catch {
    // Not a git repo or no remote
  }

  // 3. Directory basename
  return basename(projectDir);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stable short hash for a project name — used as filename key */
function projectKey(userId: string, project: string): string {
  const hash = createHash("sha256")
    .update(`${userId}:${project}`)
    .digest("hex")
    .slice(0, 12);
  return hash;
}

/** Path to a project-specific session file */
function sessionFilePath(userId: string, project: string): string {
  return join(getStateDir(), `session-${projectKey(userId, project)}.json`);
}

/** Get or create a session for a specific user + project */
export function getOrCreateSession(
  userId: string,
  project: string,
): Session {
  const stateDir = getStateDir();
  mkdirSync(stateDir, { recursive: true });

  const sessionFile = sessionFilePath(userId, project);
  const now = new Date().toISOString();
  const today = todayStr();

  if (existsSync(sessionFile)) {
    try {
      const existing: Session = JSON.parse(
        readFileSync(sessionFile, "utf-8"),
      );

      // Reuse if not stale
      const lastActive = new Date(existing.lastActiveAt).getTime();
      if (Date.now() - lastActive < STALE_THRESHOLD_MS) {
        // Reset daily count if new day
        if (existing.dailyPostDate !== today) {
          existing.dailyPostCount = 0;
          existing.dailyPostDate = today;
          existing.threadId = null; // New day = new thread
        }
        existing.lastActiveAt = now;
        atomicWriteJson(sessionFile, existing);
        return existing;
      }

      // Stale but same day — preserve threadId for daily threading
      if (existing.dailyPostDate === today) {
        const refreshed = createSession(userId, project);
        refreshed.threadId = existing.threadId;
        refreshed.dailyPostCount = existing.dailyPostCount;
        atomicWriteJson(sessionFile, refreshed);
        return refreshed;
      }
    } catch {
      // Corrupted — create new
    }
  }

  const session = createSession(userId, project);
  atomicWriteJson(sessionFile, session);
  return session;
}

function createSession(userId: string, project: string): Session {
  const now = new Date().toISOString();
  return {
    sessionId: randomUUID(),
    userId,
    project,
    threadId: null,
    startedAt: now,
    lastPostAt: null,
    lastActiveAt: now,
    postCount: 0,
    dailyPostCount: 0,
    dailyPostDate: todayStr(),
    muted: false,
  };
}

/** Update a project-specific session and persist atomically */
export function updateSessionForProject(
  userId: string,
  project: string,
  updates: Partial<Session>,
): Session | null {
  const sessionFile = sessionFilePath(userId, project);
  if (!existsSync(sessionFile)) return null;

  try {
    const session: Session = JSON.parse(
      readFileSync(sessionFile, "utf-8"),
    );
    Object.assign(session, updates, {
      lastActiveAt: new Date().toISOString(),
    });
    atomicWriteJson(sessionFile, session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Update session — finds the session file by scanning state dir.
 * Used when caller doesn't know the project (backward compat).
 */
export function updateSession(updates: Partial<Session>): Session | null {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) return null;

  // Find the most recently modified session file
  try {
    const files = readdirSync(stateDir)
      .filter((f) => f.startsWith("session-") && f.endsWith(".json"));

    let latest: Session | null = null;
    let latestFile: string | null = null;

    for (const file of files) {
      try {
        const s: Session = JSON.parse(
          readFileSync(join(stateDir, file), "utf-8"),
        );
        if (!latest || s.lastActiveAt > latest.lastActiveAt) {
          latest = s;
          latestFile = file;
        }
      } catch {
        continue;
      }
    }

    if (latest && latestFile) {
      Object.assign(latest, updates, {
        lastActiveAt: new Date().toISOString(),
      });
      atomicWriteJson(join(stateDir, latestFile), latest);
      return latest;
    }
  } catch {
    // ignore
  }

  return null;
}

/** Read current session for a specific project */
export function readSessionForProject(
  userId: string,
  project: string,
): Session | null {
  const sessionFile = sessionFilePath(userId, project);
  if (!existsSync(sessionFile)) return null;
  try {
    return JSON.parse(readFileSync(sessionFile, "utf-8"));
  } catch {
    return null;
  }
}

/** Read the most recently active session (any project) */
export function readCurrentSession(): Session | null {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) return null;

  try {
    const files = readdirSync(stateDir)
      .filter((f) => f.startsWith("session-") && f.endsWith(".json"));

    let latest: Session | null = null;
    for (const file of files) {
      try {
        const s: Session = JSON.parse(
          readFileSync(join(stateDir, file), "utf-8"),
        );
        if (!latest || s.lastActiveAt > latest.lastActiveAt) {
          latest = s;
        }
      } catch {
        continue;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
