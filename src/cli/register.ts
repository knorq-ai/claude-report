import {
  enableUser,
  disableUser,
  listEnabledUsers,
  getGitUser,
  getGitEmail,
} from "../core/registry.js";

export async function enable(identifier?: string): Promise<void> {
  const user = identifier || getGitUser();
  if (!user) {
    console.log("  Could not detect git user. Specify a name or email:");
    console.log("  claude-report enable <name-or-email>");
    return;
  }

  const result = enableUser(user);
  if (result.added) {
    console.log(`  Enabled: ${result.user}`);
    console.log("  Status updates will be posted when this git user is active.");
  } else {
    console.log(`  Already enabled: ${result.user}`);
  }
}

export async function disable(identifier?: string): Promise<void> {
  const user = identifier || getGitUser();
  if (!user) {
    console.log("  Could not detect git user. Specify a name or email:");
    console.log("  claude-report disable <name-or-email>");
    return;
  }

  const result = disableUser(user);
  if (result.removed) {
    console.log(`  Disabled: ${result.user}`);
  } else {
    console.log(`  Not enabled: ${result.user}`);
  }
}

export async function users(): Promise<void> {
  const enabled = listEnabledUsers();
  const currentUser = getGitUser();
  const currentEmail = getGitEmail();

  console.log("\n  claude-report users\n");

  if (currentUser || currentEmail) {
    console.log(`  Current git user: ${currentUser || "(none)"}  <${currentEmail || "(none)"}>`);
    console.log();
  }

  if (enabled.length === 0) {
    console.log("  No users enabled. Reporting is active for everyone.");
    console.log("  Run 'claude-report enable' to restrict to specific users.\n");
  } else {
    console.log("  Enabled users:\n");
    for (const u of enabled) {
      const isCurrent =
        (currentUser && u.toLowerCase() === currentUser.toLowerCase()) ||
        (currentEmail && u.toLowerCase() === currentEmail.toLowerCase());
      console.log(`    ${isCurrent ? "* " : "  "}${u}`);
    }
    console.log("\n  Only these users will emit status updates.\n");
  }
}
