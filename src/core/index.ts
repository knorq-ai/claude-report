export type {
  StatusUpdate,
  PostResult,
  Reply,
  Session,
  UpdateMetadata,
  UpdateType,
  StatusPoster,
  ReplyFetcher,
  Store,
} from "./types.js";

export { loadConfig, getConfigDir, getStateDir, getLogDir, isProjectDisabled, resolveUserId } from "./config.js";
export type { Config, RateLimitConfig } from "./config.js";

export {
  getOrCreateSession,
  updateSession,
  updateSessionForProject,
  readCurrentSession,
  readSessionForProject,
  resolveProjectName,
} from "./session.js";

export { RateLimiter, tokenSimilarity } from "./rate-limiter.js";
export type { RateLimitResult } from "./rate-limiter.js";

export { ContentFilter } from "./content-filter.js";

export { RelayPoster, DirectSlackPoster, DryRunPoster } from "./poster.js";
export { RelayFetcher, DirectSlackFetcher } from "./fetcher.js";
export { JsonFileStore } from "./store.js";

export {
  formatSlackBlocks,
  formatDailyParent,
  formatPlainText,
  escapeSlackMrkdwn,
} from "./formatter.js";

export { getSecret, setSecret, deleteSecret } from "./keychain.js";
export { atomicWriteJson, withFileLock } from "./fs-utils.js";
export { sendWelcomeIfNeeded } from "./welcome.js";
export { getDailyUsage, formatUsageSlackBlocks, getProjectSnippets } from "./usage-stats.js";
export type { DailyUsage, SessionUsage } from "./usage-stats.js";
export {
  isUserEnabled,
  enableUser,
  disableUser,
  listEnabledUsers,
  getGitUser,
  getGitEmail,
} from "./registry.js";

import { loadConfig, isProjectDisabled } from "./config.js";
import { getSecret } from "./keychain.js";
import { isUserEnabled } from "./registry.js";
import {
  RelayPoster,
  DirectSlackPoster,
  DryRunPoster,
} from "./poster.js";
import { RelayFetcher, DirectSlackFetcher } from "./fetcher.js";
import type { StatusPoster, ReplyFetcher } from "./types.js";
import type { Config } from "./config.js";

/**
 * Create the appropriate poster based on config.
 * Returns null if posting is disabled.
 */
export function createPoster(
  config: Config,
  projectDir?: string,
): StatusPoster | null {
  if (!config.notifications.enabled) return null;
  if (projectDir && isProjectDisabled(projectDir)) return null;
  if (!isUserEnabled(projectDir)) return null;

  if (config.notifications.dryRun) {
    return new DryRunPoster(config.user.name);
  }

  // Relay mode
  if (config.relay?.url) {
    const apiKey = getSecret("api-key");
    if (!apiKey) return null;
    return new RelayPoster(config.relay.url, apiKey, config.user.name);
  }

  // Direct mode — bot token from config (injected by plugin env vars or config file)
  if (config.slack.botToken && config.slack.channel) {
    return new DirectSlackPoster(
      config.slack.botToken,
      config.slack.channel,
      config.user.name,
    );
  }

  return null;
}

/**
 * Create the appropriate reply fetcher based on config.
 */
export function createFetcher(config: Config): ReplyFetcher | null {
  if (!config.notifications.enabled) return null;

  // Relay mode
  if (config.relay?.url) {
    const apiKey = getSecret("api-key");
    if (!apiKey) return null;
    return new RelayFetcher(config.relay.url, apiKey);
  }

  // Direct mode
  if (config.slack.botToken && config.slack.channel) {
    return new DirectSlackFetcher(config.slack.botToken, config.slack.channel);
  }

  return null;
}
