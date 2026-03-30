import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ResolvedProject {
  /** The matched project folder (e.g., /Users/you/work/creator-fun) */
  projectFolder: string;
  /** The matched project name (e.g., creator-fun) */
  projectName: string;
  /** How it was matched */
  matchType: "exact" | "partial" | "channel" | "context" | "single" | "none";
}

/**
 * Scan workspace roots and build a map of project names → paths.
 * A "project" is either:
 * - A git repo directly under a workspace root
 * - A directory containing git repos (multi-repo project)
 */
async function discoverProjects(workspaceRoots: string[]): Promise<Map<string, string>> {
  const projects = new Map<string, string>();

  for (const root of workspaceRoots) {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    // Check if the workspace root itself is a single git repo
    try {
      await exec("git", ["rev-parse", "--git-dir"], { cwd: root });
      projects.set(basename(root).toLowerCase(), root);
      continue;
    } catch {}

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const projectPath = join(root, entry.name);

      // Check if this directory itself is a git repo
      try {
        await exec("git", ["rev-parse", "--git-dir"], { cwd: projectPath });
        projects.set(entry.name.toLowerCase(), projectPath);
        continue;
      } catch {}

      // Check if it contains git repos (project with multiple repos)
      try {
        const subEntries = await readdir(projectPath, { withFileTypes: true });
        const hasGitRepo = await Promise.all(
          subEntries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map(async (e) => {
              try {
                await exec("git", ["rev-parse", "--git-dir"], { cwd: join(projectPath, e.name) });
                return true;
              } catch {
                return false;
              }
            }),
        );
        if (hasGitRepo.some(Boolean)) {
          projects.set(entry.name.toLowerCase(), projectPath);
        }
      } catch {}
    }
  }

  return projects;
}

// Cache to avoid re-scanning filesystem every message
let cachedProjects: Map<string, string> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getProjects(workspaceRoots: string[]): Promise<Map<string, string>> {
  if (cachedProjects && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedProjects;
  }
  cachedProjects = await discoverProjects(workspaceRoots);
  cacheTime = Date.now();
  return cachedProjects;
}

/**
 * Try to match text against known project names.
 * Returns the best match or null.
 */
function matchTextToProject(
  text: string,
  projects: Map<string, string>,
): { name: string; path: string; score: number } | null {
  const textLower = text.toLowerCase();
  const words = textLower
    .replace(/[^a-z0-9\s\-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Exact match — text contains the full project name
  for (const [name, path] of projects) {
    if (textLower.includes(name)) {
      return { name, path, score: 100 };
    }
  }

  // Partial match — a word matches part of a project name
  const matches: { name: string; path: string; score: number }[] = [];

  for (const [name, path] of projects) {
    const nameParts = name.split(/[-_]/).filter((p) => p.length >= 3);

    for (const word of words) {
      for (const part of nameParts) {
        if (part === word) {
          matches.push({ name, path, score: 10 });
        } else if (part.startsWith(word) && word.length >= 4) {
          matches.push({ name, path, score: 5 });
        } else if (word.startsWith(part) && part.length >= 4) {
          matches.push({ name, path, score: 5 });
        }
      }
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => b.score - a.score);
  // Only return if there's a clear winner
  if (matches.length === 1 || matches[0].score > (matches[1]?.score ?? 0)) {
    return matches[0];
  }

  return null;
}

/**
 * Resolve which project folder to use.
 *
 * Priority:
 * 1. Message text — explicit project reference always wins
 *    (e.g., "implement this feature of scale in creator" → creator)
 * 2. Channel name — if message has no project hint
 *    (e.g., #creator-dev → creator-fun)
 * 3. Thread/conversation context — look at previous messages for project hints
 * 4. Only one project exists → use it automatically
 * 5. No match → return matchType "none" so the caller can ask
 */
export async function resolveProjectFromMessage(
  message: string,
  workspaceRoots: string[],
  channelName?: string,
  threadMessages?: string[],
): Promise<ResolvedProject> {
  const projects = await getProjects(workspaceRoots);

  // If only one project exists, always use it (single-project user)
  if (projects.size === 1) {
    const [name, path] = [...projects.entries()][0];
    return { projectFolder: path, projectName: name, matchType: "single" };
  }

  if (projects.size === 0) {
    return { projectFolder: workspaceRoots[0] || ".", projectName: "unknown", matchType: "none" };
  }

  // 1. Message text — check the current message first
  const messageMatch = matchTextToProject(message, projects);
  if (messageMatch) {
    return {
      projectFolder: messageMatch.path,
      projectName: messageMatch.name,
      matchType: messageMatch.score >= 100 ? "exact" : "partial",
    };
  }

  // 2. Channel name — only if message didn't have a project hint
  if (channelName) {
    const channelMatch = matchTextToProject(channelName, projects);
    if (channelMatch) {
      return {
        projectFolder: channelMatch.path,
        projectName: channelMatch.name,
        matchType: "channel",
      };
    }
  }

  // 3. Thread context — scan previous messages in the conversation
  if (threadMessages && threadMessages.length > 0) {
    // Check most recent messages first
    for (const prevMessage of [...threadMessages].reverse()) {
      const contextMatch = matchTextToProject(prevMessage, projects);
      if (contextMatch) {
        return {
          projectFolder: contextMatch.path,
          projectName: contextMatch.name,
          matchType: "context",
        };
      }
    }
  }

  // 4. No match — caller should ask the user
  return { projectFolder: "", projectName: "", matchType: "none" };
}

/**
 * Get list of available projects for display in "which project?" prompt.
 */
export async function listAvailableProjects(
  workspaceRoots: string[],
): Promise<{ name: string; path: string; repoCount: number }[]> {
  const projects = await getProjects(workspaceRoots);
  const result: { name: string; path: string; repoCount: number }[] = [];

  for (const [name, path] of projects) {
    let repoCount = 0;
    try {
      await exec("git", ["rev-parse", "--git-dir"], { cwd: path });
      repoCount = 1;
    } catch {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          try {
            await exec("git", ["rev-parse", "--git-dir"], { cwd: join(path, e.name) });
            repoCount++;
          } catch {}
        }
      } catch {}
    }

    result.push({ name, path, repoCount });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}
