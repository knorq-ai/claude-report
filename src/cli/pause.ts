import { readCurrentSession, updateSessionForProject } from "../core/index.js";

export async function pause(): Promise<void> {
  const session = readCurrentSession();
  if (!session) {
    console.log("  No active session.");
    return;
  }

  updateSessionForProject(session.userId, session.project, { muted: true });
  console.log(`  Status posting paused for ${session.project}.`);
}

export async function resume(): Promise<void> {
  const session = readCurrentSession();
  if (!session) {
    console.log("  No active session.");
    return;
  }

  updateSessionForProject(session.userId, session.project, { muted: false });
  console.log(`  Status posting resumed for ${session.project}.`);
}
