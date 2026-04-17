import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./config.js";
import { atomicWriteJson, withFileLock, LockTimeoutError } from "./fs-utils.js";
import type { Session, StatusUpdate, Store } from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_UPDATES_KEPT = 500;

interface StoreData<T> {
  schemaVersion: number;
  data: T;
}

/**
 * JSON file-based store. Sufficient for ~50 records/day/dev.
 * All mutations go through `withFileLock` to prevent lost updates
 * under concurrent hook processes.
 */
export class JsonFileStore implements Store {
  private stateDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || getStateDir();
    mkdirSync(this.stateDir, { recursive: true });
  }

  // --- Sessions ---

  async saveSession(session: Session): Promise<void> {
    const file = this.path("sessions.json");
    this.mutate<Record<string, Session>>(file, {}, (sessions) => {
      sessions[sessionKey(session.userId, session.project)] = session;
      return sessions;
    });
  }

  async getActiveSession(
    userId: string,
    project: string,
  ): Promise<Session | null> {
    const file = this.path("sessions.json");
    const sessions = this.readFile<Record<string, Session>>(file, {});
    return sessions[sessionKey(userId, project)] || null;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Session>,
  ): Promise<void> {
    const file = this.path("sessions.json");
    this.mutate<Record<string, Session>>(file, {}, (sessions) => {
      for (const key of Object.keys(sessions)) {
        if (sessions[key].sessionId === sessionId) {
          Object.assign(sessions[key], updates);
          break;
        }
      }
      return sessions;
    });
  }

  // --- Updates ---

  async saveUpdate(
    update: StatusUpdate & { threadId: string },
  ): Promise<void> {
    const file = this.path("updates.json");
    this.mutate<Array<StatusUpdate & { threadId: string }>>(file, [], (updates) => {
      updates.push(update);
      if (updates.length > MAX_UPDATES_KEPT) {
        updates.splice(0, updates.length - MAX_UPDATES_KEPT);
      }
      return updates;
    });
  }

  async getRecentUpdates(
    sessionId: string,
    limit = 10,
  ): Promise<StatusUpdate[]> {
    const file = this.path("updates.json");
    const updates = this.readFile<StatusUpdate[]>(file, []);
    return updates
      .filter((u) => u.sessionId === sessionId)
      .slice(-limit);
  }

  // --- Reply watermarks ---

  async getLastSeenReplyTimestamp(threadId: string): Promise<Date | null> {
    const file = this.path("reply-watermarks.json");
    const watermarks = this.readFile<Record<string, string>>(file, {});
    const ts = watermarks[threadId];
    return ts ? new Date(ts) : null;
  }

  async setLastSeenReplyTimestamp(threadId: string, ts: Date): Promise<void> {
    const file = this.path("reply-watermarks.json");
    this.mutate<Record<string, string>>(file, {}, (watermarks) => {
      watermarks[threadId] = ts.toISOString();
      return watermarks;
    });
  }

  // --- Helpers ---

  private path(filename: string): string {
    return join(this.stateDir, filename);
  }

  /** Read-modify-write under a file lock. */
  private mutate<T>(
    filePath: string,
    defaultValue: T,
    fn: (current: T) => T,
  ): void {
    try {
      withFileLock(filePath, () => {
        const current = this.readFile<T>(filePath, defaultValue);
        const next = fn(current);
        this.writeFile(filePath, next);
      });
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        // Lock contention — log and skip rather than silently lose data
        process.stderr.write(`[claude-report] ${err.message}; skipping write\n`);
        return;
      }
      throw err;
    }
  }

  private readFile<T>(filePath: string, defaultValue: T): T {
    if (!existsSync(filePath)) return defaultValue;
    try {
      const raw: StoreData<T> = JSON.parse(readFileSync(filePath, "utf-8"));
      if (raw.schemaVersion !== SCHEMA_VERSION) return defaultValue;
      return raw.data;
    } catch {
      return defaultValue;
    }
  }

  private writeFile<T>(filePath: string, data: T): void {
    const wrapped: StoreData<T> = { schemaVersion: SCHEMA_VERSION, data };
    atomicWriteJson(filePath, wrapped);
  }
}

function sessionKey(userId: string, project: string): string {
  return `${userId}:${project}`;
}
