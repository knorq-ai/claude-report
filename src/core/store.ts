import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getStateDir } from "./config.js";
import { atomicWriteJson } from "./fs-utils.js";
import type { Session, StatusUpdate, Store } from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_UPDATES_KEPT = 500;

interface StoreData<T> {
  schemaVersion: number;
  data: T;
}

/**
 * JSON file-based store. Sufficient for ~50 records/day/dev.
 * Uses atomic writes (write-to-temp-then-rename) for safety.
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
    const sessions = this.readFile<Record<string, Session>>(file, {});
    sessions[sessionKey(session.userId, session.project)] = session;
    this.writeFile(file, sessions);
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
    const sessions = this.readFile<Record<string, Session>>(file, {});
    for (const key of Object.keys(sessions)) {
      if (sessions[key].sessionId === sessionId) {
        Object.assign(sessions[key], updates);
        this.writeFile(file, sessions);
        return;
      }
    }
  }

  // --- Updates ---

  async saveUpdate(
    update: StatusUpdate & { threadId: string },
  ): Promise<void> {
    const file = this.path("updates.json");
    const updates = this.readFile<Array<StatusUpdate & { threadId: string }>>(
      file,
      [],
    );
    updates.push(update);
    // Rotate: keep last N
    if (updates.length > MAX_UPDATES_KEPT) {
      updates.splice(0, updates.length - MAX_UPDATES_KEPT);
    }
    this.writeFile(file, updates);
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
    const watermarks = this.readFile<Record<string, string>>(file, {});
    watermarks[threadId] = ts.toISOString();
    this.writeFile(file, watermarks);
  }

  // --- Helpers ---

  private path(filename: string): string {
    return join(this.stateDir, filename);
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
