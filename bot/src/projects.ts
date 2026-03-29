import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig } from "@orbit/core";

/**
 * A named project configuration with optional channel mapping.
 */
export interface ProjectEntry {
  /** Unique name for this project (e.g., "frontend", "backend") */
  name: string;
  /** The project config used by the pipeline */
  config: ProjectConfig;
  /** Slack channel IDs mapped to this project */
  channels: string[];
}

interface ProjectStore {
  /** Default project name (used when no channel mapping matches) */
  defaultProject: string;
  /** All registered projects */
  projects: ProjectEntry[];
}

let store: ProjectStore = { defaultProject: "default", projects: [] };
let dataDir: string | null = null;
const STORE_FILE = "projects.json";

/**
 * Initialize the project store. Loads from disk or seeds from the env-based config.
 */
export async function initProjectStore(dir: string, envConfig: ProjectConfig): Promise<void> {
  dataDir = dir;
  await mkdir(dir, { recursive: true });

  try {
    const raw = await readFile(join(dir, STORE_FILE), "utf-8");
    store = JSON.parse(raw);
    // Ensure the env-based default exists
    if (!store.projects.find((p) => p.name === "default")) {
      store.projects.unshift({ name: "default", config: envConfig, channels: [] });
    }
  } catch {
    // No existing store — seed with the env-based config
    store = {
      defaultProject: "default",
      projects: [{ name: "default", config: envConfig, channels: [] }],
    };
    await saveStore();
  }
}

async function saveStore(): Promise<void> {
  if (!dataDir) return;
  await writeFile(join(dataDir, STORE_FILE), JSON.stringify(store, null, 2));
}

/**
 * Resolve which project config to use for a given channel.
 * Priority: channel mapping → default project.
 */
export function resolveProjectConfig(channelId: string): ProjectConfig {
  // Check channel mappings first
  for (const entry of store.projects) {
    if (entry.channels.includes(channelId)) {
      return { ...entry.config };
    }
  }
  // Fall back to default
  const def = store.projects.find((p) => p.name === store.defaultProject);
  const config = def?.config || store.projects[0]?.config || { linearApiKey: "", projectFolder: "" };
  return { ...config };
}

/**
 * Get all projects.
 */
export function getAllProjects(): ProjectEntry[] {
  return store.projects;
}

/**
 * Get a project by name.
 */
export function getProject(name: string): ProjectEntry | undefined {
  return store.projects.find((p) => p.name === name);
}

/**
 * Add or update a project.
 */
export async function upsertProject(name: string, config: Partial<ProjectConfig>, channels?: string[]): Promise<ProjectEntry> {
  const existing = store.projects.find((p) => p.name === name);

  if (existing) {
    // Merge config fields
    if (config.linearApiKey !== undefined) existing.config.linearApiKey = config.linearApiKey;
    if (config.linearTeamId !== undefined) existing.config.linearTeamId = config.linearTeamId;
    if (config.projectFolder !== undefined) existing.config.projectFolder = config.projectFolder;
    if (config.baseBranch !== undefined) existing.config.baseBranch = config.baseBranch;
    if (config.anthropicApiKey !== undefined) existing.config.anthropicApiKey = config.anthropicApiKey;
    if (config.assigneeId !== undefined) existing.config.assigneeId = config.assigneeId;
    if (config.repos !== undefined) existing.config.repos = config.repos;
    if (channels !== undefined) existing.channels = channels;
    await saveStore();
    return existing;
  }

  // Need a full config for new project
  const defaultProject = store.projects.find((p) => p.name === store.defaultProject);
  const baseConfig = defaultProject?.config || { linearApiKey: "", projectFolder: "" };

  const entry: ProjectEntry = {
    name,
    config: { ...baseConfig, ...config } as ProjectConfig,
    channels: channels || [],
  };
  store.projects.push(entry);
  await saveStore();
  return entry;
}

/**
 * Map a channel to a project.
 */
export async function mapChannel(channelId: string, projectName: string): Promise<boolean> {
  const project = store.projects.find((p) => p.name === projectName);
  if (!project) return false;

  // Remove from any existing mapping
  for (const p of store.projects) {
    p.channels = p.channels.filter((c) => c !== channelId);
  }

  project.channels.push(channelId);
  await saveStore();
  return true;
}

/**
 * Unmap a channel.
 */
export async function unmapChannel(channelId: string): Promise<void> {
  for (const p of store.projects) {
    p.channels = p.channels.filter((c) => c !== channelId);
  }
  await saveStore();
}

/**
 * Set the default project.
 */
export async function setDefaultProject(name: string): Promise<boolean> {
  if (!store.projects.find((p) => p.name === name)) return false;
  store.defaultProject = name;
  await saveStore();
  return true;
}

/**
 * Remove a project (cannot remove the last one).
 */
export async function removeProject(name: string): Promise<boolean> {
  if (store.projects.length <= 1) return false;
  store.projects = store.projects.filter((p) => p.name !== name);
  if (store.defaultProject === name) {
    store.defaultProject = store.projects[0].name;
  }
  await saveStore();
  return true;
}

/**
 * Update a single config field on a project.
 */
export async function setProjectField(projectName: string, field: string, value: string): Promise<string | null> {
  const project = store.projects.find((p) => p.name === projectName);
  if (!project) return `Project "${projectName}" not found.`;

  switch (field) {
    case "linear_api_key":
    case "linear_key":
      project.config.linearApiKey = value;
      break;
    case "linear_team":
    case "linear_team_id":
      project.config.linearTeamId = value;
      break;
    case "project_folder":
    case "folder":
      project.config.projectFolder = value;
      break;
    case "base_branch":
    case "branch":
      project.config.baseBranch = value;
      break;
    case "anthropic_key":
    case "anthropic_api_key":
      project.config.anthropicApiKey = value;
      break;
    case "assignee":
    case "assignee_id":
      project.config.assigneeId = value;
      break;
    default:
      return `Unknown field "${field}". Valid: linear_key, linear_team, folder, branch, anthropic_key, assignee`;
  }

  await saveStore();
  return null; // success
}
