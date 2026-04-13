import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfigDir } from "./config.js";
import { atomicWriteJson } from "./fs-utils.js";

interface Registry {
  projects: string[]; // Absolute paths of registered directories
}

function registryPath(): string {
  return join(getConfigDir(), "registered.json");
}

function loadRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return { projects: [] };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { projects: [] };
  }
}

function saveRegistry(registry: Registry): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteJson(registryPath(), registry);
}

/**
 * Check if a directory (or any of its parents) is registered.
 * If no projects are registered at all, returns true (feature not active).
 * Once at least one project is registered, only registered directories emit logs.
 */
export function isProjectRegistered(projectDir: string): boolean {
  const registry = loadRegistry();
  if (registry.projects.length === 0) return true; // No registrations = post everywhere
  const absDir = resolve(projectDir);
  return registry.projects.some((registered) => {
    const absRegistered = resolve(registered);
    return absDir === absRegistered || absDir.startsWith(absRegistered + "/");
  });
}

/** Register a directory for logging. */
export function registerProject(projectDir: string): { added: boolean; path: string } {
  const absDir = resolve(projectDir);
  const registry = loadRegistry();
  if (registry.projects.includes(absDir)) {
    return { added: false, path: absDir };
  }
  registry.projects.push(absDir);
  saveRegistry(registry);
  return { added: true, path: absDir };
}

/** Unregister a directory. */
export function unregisterProject(projectDir: string): { removed: boolean; path: string } {
  const absDir = resolve(projectDir);
  const registry = loadRegistry();
  const idx = registry.projects.indexOf(absDir);
  if (idx === -1) {
    return { removed: false, path: absDir };
  }
  registry.projects.splice(idx, 1);
  saveRegistry(registry);
  return { removed: true, path: absDir };
}

/** List all registered directories. */
export function listRegisteredProjects(): string[] {
  return loadRegistry().projects;
}
