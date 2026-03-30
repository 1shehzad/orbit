import { readdir, readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BotConfig } from "./config.js";
import { createAgent } from "@orbit/core";
import {
  appendObservation,
  resetDedup,
  isDuplicate,
  inferProject,
  cleanupOldActivityLogs,
} from "./activity-store.js";
import type { ObservationRecord, ObservationRepo } from "./activity-store.js";
import { regenerateActivityContext } from "./activity-context.js";

const exec = promisify(execFile);

interface RepoActivity {
  repo: string;
  path: string;
  branch: string;
  uncommittedChanges: number;
  recentCommits: string[];
  modifiedFiles: string[];
}

interface ActivitySnapshot {
  timestamp: string;
  repos: RepoActivity[];
  activeApp?: string;
  activeWindowTitle?: string;
  screenshotPath?: string;
  screenshotInsight?: string;
}

/**
 * Discover all git repos under the given workspace roots.
 * Scans one level deep (each subdirectory that has a .git folder).
 */
async function discoverAllRepos(workspaceRoots: string[]): Promise<string[]> {
  const repos: string[] = [];

  for (const root of workspaceRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const repoPath = join(root, entry.name);
        try {
          await exec("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
          repos.push(repoPath);
        } catch {
          // Not a git repo, skip
        }
      }
    } catch {
      // Root doesn't exist, skip
    }
  }

  return repos;
}

/**
 * Get activity snapshot for a single repo.
 */
async function getRepoActivity(repoPath: string): Promise<RepoActivity> {
  const repo = basename(repoPath);

  // Current branch
  let branch = "unknown";
  try {
    const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: repoPath });
    branch = stdout.trim() || "detached";
  } catch {}

  // Uncommitted changes count
  let uncommittedChanges = 0;
  const modifiedFiles: string[] = [];
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: repoPath });
    const lines = stdout.trim().split("\n").filter(Boolean);
    uncommittedChanges = lines.length;
    modifiedFiles.push(...lines.slice(0, 10).map((l) => l.slice(3)));
  } catch {}

  // Recent commits (last 2 hours)
  const recentCommits: string[] = [];
  try {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { stdout } = await exec("git", [
      "log", `--since=${since}`, "--oneline", "--no-merges", "-10",
    ], { cwd: repoPath });
    if (stdout.trim()) {
      recentCommits.push(...stdout.trim().split("\n"));
    }
  } catch {}

  return { repo, path: repoPath, branch, uncommittedChanges, recentCommits, modifiedFiles };
}

/**
 * Get the currently active application on macOS.
 */
async function getActiveApp(): Promise<string> {
  try {
    const { stdout } = await exec("osascript", [
      "-e", 'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

/**
 * Get the window title of the currently active application on macOS.
 */
async function getActiveWindowTitle(): Promise<string> {
  try {
    const { stdout } = await exec("osascript", [
      "-e", 'tell application "System Events" to get name of first window of (first application process whose frontmost is true)',
    ]);
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

// ── Screenshot capture & analysis ──

const SCREENSHOT_DIR = "screenshots";

/**
 * Take a screenshot using macOS screencapture.
 * Returns the file path of the saved screenshot.
 */
async function captureScreenshot(dataDir: string): Promise<string | null> {
  const screenshotDir = join(dataDir, SCREENSHOT_DIR);
  await mkdir(screenshotDir, { recursive: true });

  const now = new Date();
  const filename = `${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 5).replace(":", "-")}.png`;
  const filePath = join(screenshotDir, filename);

  try {
    // -x = no sound, -C = capture cursor
    await exec("screencapture", ["-x", "-C", filePath]);
    return filePath;
  } catch (err) {
    console.error("Screenshot capture failed:", err);
    return null;
  }
}

/**
 * Analyze a screenshot using the configured AI agent with vision.
 * Passes the screenshot path so the agent can read it.
 * Returns a short insight string, or null if nothing relevant.
 */
async function analyzeScreenshot(screenshotPath: string, botConfig: BotConfig): Promise<string | null> {
  try {
    const prompt = `Look at this screenshot: ${screenshotPath}

You are a work activity tracker. Determine what the user is doing.

Respond with a SHORT one-line description. Focus on:
- What application is open (VS Code, browser, terminal, Slack, etc.)
- What file or page they are viewing
- What they appear to be working on

If NOT work-related (social media, entertainment), respond with exactly: SKIP

Respond with ONLY the one-line description or SKIP. Nothing else.`;

    const agent = createAgent(
      botConfig.project.aiProvider ?? "claude",
      botConfig.project.anthropicApiKey,
    );
    const result = await agent.run(prompt, process.cwd());

    const insight = result.output.trim();
    if (!insight || insight === "SKIP") return null;

    // Take just the first line in case the agent adds extra
    return insight.split("\n")[0].trim();
  } catch (err) {
    console.error("Screenshot analysis failed:", err);
    return null;
  }
}

/**
 * Delete screenshots older than the retention period.
 */
async function cleanupOldScreenshots(dataDir: string, retentionDays: number): Promise<void> {
  const screenshotDir = join(dataDir, SCREENSHOT_DIR);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const files = await readdir(screenshotDir);
    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const filePath = join(screenshotDir, file);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {
    // Directory doesn't exist yet, nothing to clean
  }
}

// ── Snapshot & context update ──

/**
 * Take a snapshot of current activity across all workspaces.
 */
async function takeSnapshot(
  workspaceRoots: string[],
  botConfig: BotConfig,
): Promise<ActivitySnapshot> {
  const repos = await discoverAllRepos(workspaceRoots);

  const repoActivities = await Promise.all(
    repos.map((r) => getRepoActivity(r).catch(() => null)),
  );

  // Only include repos with activity (uncommitted changes or recent commits)
  const activeRepos = repoActivities.filter(
    (r): r is RepoActivity => r !== null && (r.uncommittedChanges > 0 || r.recentCommits.length > 0),
  );

  const activeApp = await getActiveApp();
  const activeWindowTitle = await getActiveWindowTitle();

  // Screenshot capture + analysis (if enabled)
  let screenshotInsight: string | undefined;
  let screenshotFilePath: string | undefined;
  if (botConfig.screenshotsEnabled) {
    const ssPath = await captureScreenshot(botConfig.dataDir);
    if (ssPath) {
      screenshotFilePath = ssPath;
      const insight = await analyzeScreenshot(ssPath, botConfig);
      if (insight) {
        screenshotInsight = insight;
      }
    }
    // Cleanup old screenshots periodically (run on every snapshot, lightweight)
    await cleanupOldScreenshots(botConfig.dataDir, botConfig.screenshotRetentionDays);
  }

  return {
    timestamp: new Date().toISOString(),
    repos: activeRepos,
    activeApp,
    activeWindowTitle,
    screenshotPath: screenshotFilePath,
    screenshotInsight,
  };
}

/**
 * Update the activity.md context file with the latest snapshot.
 */
async function updateActivityContext(
  contextFolder: string,
  snapshot: ActivitySnapshot,
): Promise<void> {
  const filePath = join(contextFolder, "activity.md");
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  // Read existing
  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {}

  // Keep only today's entries (trim old days)
  const todayHeader = `# Activity — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`;
  let content: string;

  if (existing.includes(todayHeader)) {
    // Append to today
    content = existing;
  } else {
    // New day
    content = `${todayHeader}\n_Auto-tracked by Orbit_\n`;
  }

  // Build entry
  const hasActivity = snapshot.repos.length > 0 || snapshot.screenshotInsight;
  if (hasActivity) {
    const lines: string[] = [`\n## ${timeStr}`];

    if (snapshot.screenshotInsight) {
      lines.push(`Screen: ${snapshot.screenshotInsight}`);
    } else if (snapshot.activeApp && snapshot.activeApp !== "unknown") {
      lines.push(`Using: ${snapshot.activeApp}`);
    }

    for (const repo of snapshot.repos) {
      lines.push(`\n**${repo.repo}** (${repo.branch})`);

      if (repo.recentCommits.length > 0) {
        lines.push(`Commits:`);
        for (const c of repo.recentCommits.slice(0, 5)) {
          lines.push(`- ${c}`);
        }
      }

      if (repo.uncommittedChanges > 0) {
        lines.push(`${repo.uncommittedChanges} uncommitted file(s): ${repo.modifiedFiles.slice(0, 5).join(", ")}`);
      }
    }

    content += lines.join("\n") + "\n";
  }

  // Trim to keep file manageable (last 100 lines max)
  const allLines = content.split("\n");
  if (allLines.length > 100) {
    content = allLines.slice(0, 2).join("\n") + "\n...\n" + allLines.slice(-80).join("\n");
  }

  await writeFile(filePath, content);
}

/**
 * Start the activity monitor.
 * Runs every N minutes, scans all workspace repos, updates context.
 */
export function startActivityMonitor(botConfig: BotConfig): void {
  const { workspaceRoots, monitorIntervalMinutes, contextFolder } = botConfig;

  if (workspaceRoots.length === 0) {
    console.log("Activity monitor disabled — no WORKSPACE_ROOTS configured");
    return;
  }

  const intervalMs = monitorIntervalMinutes * 60 * 1000;

  // Run immediately on start
  runMonitor(workspaceRoots, contextFolder, botConfig);

  // Then run on interval
  setInterval(() => {
    runMonitor(workspaceRoots, contextFolder, botConfig);
  }, intervalMs);

  const screenshotStatus = botConfig.screenshotsEnabled ? " + screenshots" : "";
  console.log(`Activity monitor started — scanning ${workspaceRoots.length} workspace(s) every ${monitorIntervalMinutes}m${screenshotStatus}`);
}

async function runMonitor(workspaceRoots: string[], contextFolder: string, botConfig: BotConfig): Promise<void> {
  try {
    resetDedup();
    const snapshot = await takeSnapshot(workspaceRoots, botConfig);

    // Write structured observation record to JSONL
    const obsRepos: ObservationRepo[] = snapshot.repos.map((r) => ({
      repo: r.repo,
      branch: r.branch,
      uncommittedChanges: r.uncommittedChanges,
      recentCommits: r.recentCommits,
      modifiedFiles: r.modifiedFiles,
    }));

    const record: ObservationRecord = {
      timestamp: snapshot.timestamp,
      eventType: snapshot.screenshotPath ? "window-snapshot" : "window-focus",
      appName: snapshot.activeApp ?? "unknown",
      windowTitle: snapshot.activeWindowTitle ?? null,
      screenshotPath: snapshot.screenshotPath ?? null,
      summaryText: snapshot.screenshotInsight ?? null,
      repos: obsRepos,
      project: inferProject(
        snapshot.activeWindowTitle ?? null,
        snapshot.activeApp ?? "unknown",
        obsRepos,
      ),
    };

    if (!isDuplicate(record)) {
      await appendObservation(botConfig.dataDir, record);
    }

    // Existing: update activity.md (backward compat)
    if (snapshot.repos.length > 0 || snapshot.screenshotInsight) {
      await updateActivityContext(contextFolder, snapshot);
    }

    // Regenerate 4 context files from JSONL data
    await regenerateActivityContext(
      botConfig.dataDir,
      contextFolder,
      botConfig.activityContextDays,
    );

    // Cleanup old JSONL files
    await cleanupOldActivityLogs(botConfig.dataDir, botConfig.screenshotRetentionDays);
  } catch (err) {
    console.error("Activity monitor error:", err);
  }
}

/**
 * Get a summary of all repos across all workspaces.
 * Used by /orbit projects and for codebase Q&A.
 */
export async function getAllReposSummary(workspaceRoots: string[]): Promise<{
  repos: { name: string; path: string; branch: string; uncommitted: number }[];
  total: number;
}> {
  const allRepos = await discoverAllRepos(workspaceRoots);
  const repos: { name: string; path: string; branch: string; uncommitted: number }[] = [];

  for (const repoPath of allRepos) {
    try {
      const activity = await getRepoActivity(repoPath);
      repos.push({
        name: activity.repo,
        path: repoPath,
        branch: activity.branch,
        uncommitted: activity.uncommittedChanges,
      });
    } catch {}
  }

  return { repos, total: repos.length };
}
