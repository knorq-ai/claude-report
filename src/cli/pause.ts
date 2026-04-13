import { updateSession, readCurrentSession } from "../core/index.js";

export async function pause(): Promise<void> {
  const session = readCurrentSession();
  if (!session) {
    console.log("  No active session.");
    return;
  }

  updateSession({ muted: true });
  console.log("  Status posting paused for this session.");
}

export async function resume(): Promise<void> {
  const session = readCurrentSession();
  if (!session) {
    console.log("  No active session.");
    return;
  }

  updateSession({ muted: false });
  console.log("  Status posting resumed.");
}
