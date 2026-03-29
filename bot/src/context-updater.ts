import { readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { LinearClient, GitManager } from "@orbit/core";
import type { ProjectConfig, PRInfo } from "@orbit/core";

/**
 * Update context files after a task completes.
 * Called from the runner when a pipeline finishes.
 */
export async function updateContextAfterTask(
  contextFolder: string,
  config: ProjectConfig,
  taskSummary: {
    problem: string;
    tickets: { identifier: string; title: string; url: string }[];
    prs: PRInfo[];
    completedCount: number;
    errors: string[];
  },
): Promise<void> {
  try {
    await updateDailyContext(contextFolder, taskSummary);
    await updateRecentContext(contextFolder, config, taskSummary);
  } catch (err) {
    console.error("Context update failed:", err);
  }
}

/**
 * Update daily.md — what happened today.
 * Appends the latest task to today's log.
 */
async function updateDailyContext(
  contextFolder: string,
  taskSummary: {
    problem: string;
    tickets: { identifier: string; title: string; url: string }[];
    prs: PRInfo[];
    completedCount: number;
    errors: string[];
  },
): Promise<void> {
  const filePath = join(contextFolder, "daily.md");
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });

  // Read existing content
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {}

  // Check if today's header already exists
  const todayHeader = `# ${today}`;
  let content: string;

  if (existing.includes(todayHeader)) {
    // Append to today's section
    const entry = formatTaskEntry(taskSummary);
    content = existing.replace(todayHeader, `${todayHeader}\n${entry}`);
  } else {
    // New day — start fresh with today's header, keep yesterday for reference
    const entry = formatTaskEntry(taskSummary);
    const lines = existing.split("\n");
    // Keep only the last day's content (trim old days)
    const previousDayStart = lines.findIndex((l, i) => i > 0 && l.startsWith("# "));
    const previousContent = previousDayStart > 0
      ? "\n---\n## Yesterday\n" + lines.slice(previousDayStart + 1, previousDayStart + 15).join("\n")
      : "";

    content = `${todayHeader}\n${entry}${previousContent}\n`;
  }

  await writeFile(filePath, content);
}

/**
 * Update recent.md — rolling 7-day summary.
 * Pulls from git log and Linear for a complete picture.
 */
async function updateRecentContext(
  contextFolder: string,
  config: ProjectConfig,
  taskSummary: {
    problem: string;
    tickets: { identifier: string; title: string; url: string }[];
    prs: PRInfo[];
  },
): Promise<void> {
  const filePath = join(contextFolder, "recent.md");
  const linear = new LinearClient(config.linearApiKey);

  // Discover repos across all workspace roots (fall back to projectFolder)
  const { GitManager } = await import("@orbit/core");
  const workspaceRoots = process.env.WORKSPACE_ROOTS
    ? process.env.WORKSPACE_ROOTS.split(",").map((p) => p.trim()).filter(Boolean)
    : [config.projectFolder];

  // Gather data for the last 7 days
  const assigneeId = config.assigneeId || (await linear.getMyId().catch(() => ""));

  const [completedTickets, inProgressTickets] = await Promise.all([
    assigneeId ? linear.getCompletedTickets(assigneeId, 168).catch(() => []) : [],
    assigneeId ? linear.getInProgressTickets(assigneeId).catch(() => []) : [],
  ]);

  // Discover all repos across workspaces
  const allRepos: string[] = [];
  for (const root of workspaceRoots) {
    const git = new GitManager(root);
    const repos = await git.discoverRepos().catch(() => []);
    allRepos.push(...repos);
  }

  // Get recent PRs across all repos
  const recentPRs: { repo: string; number: number; title: string; url: string }[] = [];
  const git = new GitManager(config.projectFolder);
  for (const repo of allRepos) {
    const prs = await git.getRecentPRs(repo, 168).catch(() => []);
    for (const pr of prs) {
      recentPRs.push({ repo: basename(repo), ...pr });
    }
  }

  // Build the recent.md content
  const lines: string[] = [
    `# Recent Work (last 7 days)`,
    `_Auto-updated: ${new Date().toISOString().split("T")[0]}_`,
    ``,
  ];

  // Completed
  if (completedTickets.length > 0) {
    lines.push(`## Completed`);
    for (const t of completedTickets.slice(0, 15)) {
      lines.push(`- ${t.identifier}: ${t.title}`);
    }
    lines.push(``);
  }

  // In Progress
  if (inProgressTickets.length > 0) {
    lines.push(`## In Progress`);
    for (const t of inProgressTickets.slice(0, 10)) {
      lines.push(`- ${t.identifier}: ${t.title}`);
    }
    lines.push(``);
  }

  // PRs
  if (recentPRs.length > 0) {
    lines.push(`## Pull Requests`);
    for (const pr of recentPRs.slice(0, 15)) {
      lines.push(`- ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    lines.push(``);
  }

  // Latest task just completed
  if (taskSummary.tickets.length > 0) {
    lines.push(`## Latest Task`);
    lines.push(`Problem: ${taskSummary.problem.slice(0, 200)}`);
    for (const t of taskSummary.tickets) {
      lines.push(`- ${t.identifier}: ${t.title}`);
    }
    if (taskSummary.prs.length > 0) {
      for (const pr of taskSummary.prs) {
        lines.push(`- PR: ${pr.repo}#${pr.number}`);
      }
    }
    lines.push(``);
  }

  await writeFile(filePath, lines.join("\n"));
}

/**
 * Update blockers.md — known issues and WIP.
 * Called when tasks fail or have errors.
 */
export async function updateBlockers(
  contextFolder: string,
  config: ProjectConfig,
): Promise<void> {
  const filePath = join(contextFolder, "blockers.md");
  const linear = new LinearClient(config.linearApiKey);

  try {
    const assigneeId = config.assigneeId || (await linear.getMyId());
    const inProgress = await linear.getInProgressTickets(assigneeId);

    const lines: string[] = [
      `# Current Work & Blockers`,
      `_Auto-updated: ${new Date().toISOString().split("T")[0]}_`,
      ``,
    ];

    if (inProgress.length > 0) {
      lines.push(`## Currently Working On`);
      for (const t of inProgress) {
        lines.push(`- ${t.identifier}: ${t.title}`);
      }
      lines.push(``);
    }

    lines.push(`## Blockers`);
    lines.push(`None currently tracked.`);
    lines.push(``);

    await writeFile(filePath, lines.join("\n"));
  } catch (err) {
    console.error("Blockers update failed:", err);
  }
}

function formatTaskEntry(taskSummary: {
  problem: string;
  tickets: { identifier: string; title: string }[];
  prs: PRInfo[];
  completedCount: number;
  errors: string[];
}): string {
  const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const lines: string[] = [];

  lines.push(`\n### ${time}`);

  // Tickets
  for (const t of taskSummary.tickets) {
    const status = taskSummary.completedCount > 0 ? "done" : "in progress";
    lines.push(`- ${t.identifier}: ${t.title} (${status})`);
  }

  // PRs
  for (const pr of taskSummary.prs) {
    lines.push(`- PR: ${pr.repo}#${pr.number} — ${pr.title}`);
  }

  // Errors
  if (taskSummary.errors.length > 0) {
    lines.push(`- Issues: ${taskSummary.errors.length} error(s)`);
  }

  return lines.join("\n");
}
