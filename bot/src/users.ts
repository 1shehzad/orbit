import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "@orbit/core";

/**
 * Per-user configuration overrides.
 * Any field set here takes priority over the channel/project config.
 */
export interface UserConfig {
  /** Slack user ID */
  slackUserId: string;
  /** User's own Linear API key (optional — falls back to project config) */
  linearApiKey?: string;
  /** User's Linear team ID override */
  linearTeamId?: string;
  /** User's Linear assignee ID (auto-resolved from their key if not set) */
  assigneeId?: string;
  /** User's project folder override */
  projectFolder?: string;
  /** User's base branch override */
  baseBranch?: string;
  /** User's Anthropic API key override */
  anthropicApiKey?: string;
}

interface UserStore {
  users: Record<string, UserConfig>; // keyed by Slack user ID
}

let store: UserStore = { users: {} };
let dataDir: string | null = null;
const STORE_FILE = "users.json";

/**
 * Initialize user config store. Call once at startup.
 */
export async function initUserStore(dir: string): Promise<void> {
  dataDir = dir;
  await mkdir(dir, { recursive: true });

  try {
    const raw = await readFile(join(dir, STORE_FILE), "utf-8");
    store = JSON.parse(raw);
  } catch {
    store = { users: {} };
  }
}

async function saveStore(): Promise<void> {
  if (!dataDir) return;
  await writeFile(join(dataDir, STORE_FILE), JSON.stringify(store, null, 2));
}

/**
 * Get a user's config (or undefined if not set).
 */
export function getUserConfig(slackUserId: string): UserConfig | undefined {
  return store.users[slackUserId];
}

/**
 * Merge user overrides onto a project config.
 * Returns a new config with user values taking priority.
 */
export function mergeUserConfig(projectConfig: ProjectConfig, slackUserId: string): ProjectConfig {
  const user = store.users[slackUserId];
  if (!user) return { ...projectConfig };

  return {
    linearApiKey: user.linearApiKey || projectConfig.linearApiKey,
    linearTeamId: user.linearTeamId || projectConfig.linearTeamId,
    assigneeId: user.assigneeId || projectConfig.assigneeId,
    projectFolder: user.projectFolder || projectConfig.projectFolder,
    baseBranch: user.baseBranch || projectConfig.baseBranch,
    anthropicApiKey: user.anthropicApiKey || projectConfig.anthropicApiKey,
    repos: projectConfig.repos, // repos always come from project config
  };
}

/**
 * Set a single field on a user's config.
 */
export async function setUserField(slackUserId: string, field: string, value: string): Promise<string | null> {
  if (!store.users[slackUserId]) {
    store.users[slackUserId] = { slackUserId };
  }
  const user = store.users[slackUserId];

  switch (field) {
    case "linear_key":
    case "linear_api_key":
      user.linearApiKey = value;
      break;
    case "linear_team":
    case "linear_team_id":
      user.linearTeamId = value;
      break;
    case "assignee":
    case "assignee_id":
      user.assigneeId = value;
      break;
    case "folder":
    case "project_folder":
      user.projectFolder = value;
      break;
    case "branch":
    case "base_branch":
      user.baseBranch = value;
      break;
    case "anthropic_key":
    case "anthropic_api_key":
      user.anthropicApiKey = value;
      break;
    default:
      return `Unknown field "${field}". Valid: linear_key, linear_team, assignee, folder, branch, anthropic_key`;
  }

  await saveStore();
  return null;
}

/**
 * Clear a single field (revert to project default).
 */
export async function clearUserField(slackUserId: string, field: string): Promise<string | null> {
  const user = store.users[slackUserId];
  if (!user) return null;

  switch (field) {
    case "linear_key":
    case "linear_api_key":
      user.linearApiKey = undefined;
      break;
    case "linear_team":
    case "linear_team_id":
      user.linearTeamId = undefined;
      break;
    case "assignee":
    case "assignee_id":
      user.assigneeId = undefined;
      break;
    case "folder":
    case "project_folder":
      user.projectFolder = undefined;
      break;
    case "branch":
    case "base_branch":
      user.baseBranch = undefined;
      break;
    case "anthropic_key":
    case "anthropic_api_key":
      user.anthropicApiKey = undefined;
      break;
    default:
      return `Unknown field "${field}".`;
  }

  await saveStore();
  return null;
}

/**
 * Clear all user config (full reset).
 */
export async function clearUserConfig(slackUserId: string): Promise<void> {
  delete store.users[slackUserId];
  await saveStore();
}

/**
 * Get all users with config.
 */
export function getAllUserConfigs(): UserConfig[] {
  return Object.values(store.users);
}
