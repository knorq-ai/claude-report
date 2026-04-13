import {
  registerProject,
  unregisterProject,
  listRegisteredProjects,
} from "../core/registry.js";

export async function register(path?: string): Promise<void> {
  const dir = path || process.cwd();
  const result = registerProject(dir);
  if (result.added) {
    console.log(`  Registered: ${result.path}`);
    console.log("  Status updates will be posted when working in this directory.");
  } else {
    console.log(`  Already registered: ${result.path}`);
  }
}

export async function unregister(path?: string): Promise<void> {
  const dir = path || process.cwd();
  const result = unregisterProject(dir);
  if (result.removed) {
    console.log(`  Unregistered: ${result.path}`);
  } else {
    console.log(`  Not registered: ${result.path}`);
  }
}

export async function list(): Promise<void> {
  const projects = listRegisteredProjects();
  if (projects.length === 0) {
    console.log("  No projects registered. All directories will emit logs.");
    console.log("  Run `claude-report register` in a project directory to start.");
  } else {
    console.log(`  Registered projects (${projects.length}):\n`);
    for (const p of projects) {
      console.log(`    ${p}`);
    }
    console.log("\n  Only these directories will emit status updates.");
  }
}
