import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRecentObservations } from "./activity-store.js";
import type { ParsedObservation, ObservationRepo } from "./activity-store.js";

// ── Main entry point ──

/**
 * Regenerate all 4 activity context files from raw JSONL data.
 * Called after each monitor cycle. Files are fully overwritten each time.
 */
export async function regenerateActivityContext(
  dataDir: string,
  contextFolder: string,
  contextDays: number = 7,
): Promise<void> {
  // Load today + yesterday for activity log, more for role/skills
  const recentObs = await readRecentObservations(dataDir, 2);
  const extendedObs = contextDays > 2
    ? await readRecentObservations(dataDir, contextDays)
    : recentObs;

  if (recentObs.length === 0 && extendedObs.length === 0) return;

  const [activityLog, role, responsibilities, skills] = [
    generateActivityLog(recentObs),
    generateRole(extendedObs),
    generateResponsibilities(recentObs),
    generateSkills(extendedObs),
  ];

  await Promise.all([
    writeFile(join(contextFolder, "ACTIVITY_LOG.md"), activityLog),
    writeFile(join(contextFolder, "ROLE.md"), role),
    writeFile(join(contextFolder, "RESPONSIBILITIES.md"), responsibilities),
    writeFile(join(contextFolder, "SKILL.md"), skills),
  ]);
}

// ── ACTIVITY_LOG.md ──

interface ActivityGroup {
  startTime: string;
  endTime: string;
  appName: string;
  windowTitles: string[];
  count: number;
  screenshotPath: string | null;
  screenshotDescription: string | null;
  project: string | null;
  durationSeconds: number;
}

function generateActivityLog(observations: ParsedObservation[]): string {
  const lines: string[] = ["# Activity Log", ""];
  lines.push(`_Generated: ${formatUtcStamp(new Date())}_  `);
  lines.push(`_Records: ${observations.length}_`);
  lines.push("");

  // Session summary
  const summary = buildSessionSummary(observations);
  if (summary) {
    lines.push("## Session Summary");
    lines.push("");
    lines.push(summary);
    lines.push("");
  }

  // Active projects
  const projects = summarizeProjects(observations);
  if (projects.length > 0) {
    lines.push("## Active Projects");
    lines.push("");
    for (const p of projects) {
      lines.push(`- **${p.label}** (${p.count} interactions) — ${p.details.slice(0, 2).join(", ")}`);
    }
    lines.push("");
  }

  // Timeline (newest first, grouped by app)
  const newestFirst = [...observations].reverse();
  const groups = groupEvents(newestFirst);

  if (groups.length > 0) {
    lines.push("## Activity Timeline");
    lines.push("");

    // Limit to last 50 groups to keep file manageable
    for (const group of groups.slice(0, 50)) {
      lines.push(`### ${group.startTime}`);
      lines.push("");
      lines.push(`- **App:** ${group.appName}`);

      if (group.windowTitles.length === 1) {
        lines.push(`- **Window:** ${group.windowTitles[0]}`);
      } else if (group.windowTitles.length > 1) {
        lines.push(`- **Windows:** ${group.windowTitles.slice(0, 5).join(", ")}`);
      }

      if (group.durationSeconds > 0) {
        lines.push(`- **Duration:** ${formatDuration(group.durationSeconds)}`);
      }

      if (group.project) {
        lines.push(`- **Project:** ${group.project}`);
      }

      if (group.count > 1) {
        lines.push(`- **Events:** ${group.count}`);
      }

      if (group.screenshotPath) {
        lines.push(`- **Screenshot:** \`${group.screenshotPath}\``);
      }

      if (group.screenshotDescription) {
        lines.push(`- **Screen:** ${group.screenshotDescription}`);
      }

      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

// ── ROLE.md ──

function generateRole(observations: ParsedObservation[]): string {
  const lines: string[] = ["# ROLE", ""];

  // Infer role from usage
  const roleObs = buildRoleObservations(observations);
  if (roleObs.length > 0) {
    lines.push("## About Me");
    lines.push("");
    for (const obs of roleObs) {
      lines.push(`- ${obs}`);
    }
    lines.push("");
  }

  // App usage profile
  lines.push("## Application Profile");
  lines.push("");

  const appCounts = new Map<string, number>();
  for (const obs of observations) {
    if (isNoiseApp(obs.appName)) continue;
    appCounts.set(obs.appName, (appCounts.get(obs.appName) ?? 0) + 1);
  }

  const ranked = [...appCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (ranked.length === 0) {
    lines.push("- No observation data yet.");
  } else {
    const total = ranked.reduce((sum, [, c]) => sum + c, 0);
    for (const [app, count] of ranked) {
      const pct = Math.round((count / total) * 100);
      lines.push(`- **${app}**: ${count} events (${pct}%)`);
    }
  }
  lines.push("");

  // Working hours
  if (observations.length > 0) {
    const hours = observations.map((o) => o.parsedTs.getHours());
    const earliest = Math.min(...hours);
    const latest = Math.max(...hours);
    lines.push("## Working Hours");
    lines.push("");
    lines.push(`- Earliest activity: ${earliest}:00`);
    lines.push(`- Latest activity: ${latest}:00`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

// ── RESPONSIBILITIES.md ──

function generateResponsibilities(observations: ParsedObservation[]): string {
  const lines: string[] = ["# RESPONSIBILITIES", ""];

  // Current focus (from most recent observations)
  const summary = buildSessionSummary(observations);
  if (summary) {
    lines.push("## Current Focus");
    lines.push("");
    lines.push(summary);
    lines.push("");
  }

  // Active work (repos with activity)
  const activeRepos = new Map<string, { branch: string; uncommitted: number }>();
  for (const obs of observations.slice(-10)) {
    for (const repo of obs.repos) {
      if (repo.uncommittedChanges > 0 || repo.recentCommits.length > 0) {
        activeRepos.set(repo.repo, {
          branch: repo.branch,
          uncommitted: repo.uncommittedChanges,
        });
      }
    }
  }

  if (activeRepos.size > 0) {
    lines.push("## Active Work");
    lines.push("");
    for (const [repo, info] of activeRepos) {
      const detail = info.uncommitted > 0
        ? `${info.uncommitted} uncommitted changes on ${info.branch}`
        : `on ${info.branch}`;
      lines.push(`- **${repo}**: ${detail}`);
    }
    lines.push("");
  }

  // Recent tasks (from window titles and summaries)
  lines.push("## Recent Tasks");
  lines.push("");

  const seen = new Set<string>();
  let added = 0;
  const newestFirst = [...observations].reverse();

  for (const obs of newestFirst.slice(0, 40)) {
    const text = obs.summaryText?.trim() || localSummary(obs) || obs.windowTitle?.trim();
    if (!text) continue;
    const normalized = text.toLowerCase().slice(0, 120);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(`- ${text}`);
    added += 1;
    if (added >= 15) break;
  }

  if (added === 0) {
    lines.push("- No inferred responsibilities yet.");
  }
  lines.push("");

  return lines.join("\n") + "\n";
}

// ── SKILL.md ──

function generateSkills(observations: ParsedObservation[]): string {
  const lines: string[] = ["# SKILL", "", "## Observed Skills", ""];

  const appNames = new Set(observations.map((o) => o.appName));
  const windowTitles = observations
    .map((o) => o.windowTitle ?? "")
    .filter(Boolean)
    .join(" ");

  // Infer skills from tool usage
  if (appNames.has("Code") || appNames.has("Cursor") || appNames.has("Zed")) {
    lines.push("- Hands-on coding and debugging in local workspaces");
  }
  if (appNames.has("Slack")) {
    lines.push("- Thread-based coordination and testing through Slack");
  }
  if (appNames.has("Google Chrome") || appNames.has("Arc") || appNames.has("Safari")) {
    lines.push("- Browser research and validation while working");
  }
  if (/terminal|bash|zsh|shell|iterm|warp/i.test(windowTitles)) {
    lines.push("- Running local commands, service restarts, and verification loops");
  }
  if (/docker|container|kubernetes|k8s/i.test(windowTitles)) {
    lines.push("- Container and infrastructure management");
  }
  if (/github|gitlab|bitbucket/i.test(windowTitles)) {
    lines.push("- Version control and code review workflows");
  }
  if (/linear|jira|asana/i.test(windowTitles)) {
    lines.push("- Project management and issue tracking");
  }
  if (/figma|sketch/i.test(windowTitles)) {
    lines.push("- Design review and implementation");
  }

  // Infer languages from file extensions in window titles
  const langPatterns: [RegExp, string][] = [
    [/\.(ts|tsx)\b/, "TypeScript"],
    [/\.(js|jsx)\b/, "JavaScript"],
    [/\.py\b/, "Python"],
    [/\.go\b/, "Go"],
    [/\.rs\b/, "Rust"],
    [/\.java\b/, "Java"],
    [/\.rb\b/, "Ruby"],
    [/\.swift\b/, "Swift"],
  ];

  const detectedLangs = new Set<string>();
  for (const [pattern, lang] of langPatterns) {
    if (pattern.test(windowTitles)) detectedLangs.add(lang);
  }

  if (detectedLangs.size > 0) {
    lines.push(`- Programming languages: ${[...detectedLangs].join(", ")}`);
  }

  // Work pattern
  const uniqueHours = new Set(observations.slice(0, 30).map((o) => o.parsedTs.getHours()));
  if (uniqueHours.size > 1) {
    lines.push("- Sustained multi-step work sessions across several checkpoints");
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

// ── Shared helpers ──

function groupEvents(observations: ParsedObservation[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let current: ActivityGroup | null = null;

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];

    if (current && current.appName === obs.appName) {
      current.count += 1;
      current.endTime = obs.timestamp;

      const title = obs.windowTitle;
      if (title && !current.windowTitles.includes(title)) {
        current.windowTitles.push(title);
      }
      if (obs.screenshotPath && !current.screenshotPath) {
        current.screenshotPath = obs.screenshotPath;
      }
      if (obs.summaryText && !current.screenshotDescription) {
        current.screenshotDescription = obs.summaryText;
      }
      if (obs.project && !current.project) {
        current.project = obs.project;
      }
      continue;
    }

    // Compute duration for previous group
    if (current && i > 0) {
      const gap = Math.abs(obs.parsedTs.getTime() - new Date(current.endTime).getTime()) / 1000;
      current.durationSeconds = Math.min(gap, 300); // cap at 5 minutes
    }

    current = {
      startTime: obs.timestamp,
      endTime: obs.timestamp,
      appName: obs.appName,
      windowTitles: obs.windowTitle ? [obs.windowTitle] : [],
      count: 1,
      screenshotPath: obs.screenshotPath ?? null,
      screenshotDescription: obs.summaryText ?? null,
      project: obs.project,
      durationSeconds: 0,
    };
    groups.push(current);
  }

  return groups;
}

function buildSessionSummary(observations: ParsedObservation[]): string {
  const apps = [...new Set(observations.map((o) => o.appName))].filter((a) => !isNoiseApp(a));
  const topProjects = summarizeProjects(observations).map((p) => p.label).slice(0, 2);

  const workStyle: string[] = [];
  if (apps.includes("Code") || apps.includes("Cursor")) workStyle.push("working in VS Code");
  if (apps.includes("Slack")) workStyle.push("checking Slack conversations");
  if (apps.includes("Google Chrome") || apps.includes("Arc")) workStyle.push("researching in the browser");
  if (apps.some((a) => /terminal|iterm|warp/i.test(a))) workStyle.push("running commands in terminal");

  const base = workStyle.length > 0
    ? `The user spent this session ${joinNatural(workStyle)}`
    : "The user spent this session moving between development and collaboration tools";

  const projectPart = topProjects.length > 0 ? ` around ${joinNatural(topProjects)}` : "";
  return `${base}${projectPart}.`;
}

function buildRoleObservations(observations: ParsedObservation[]): string[] {
  const results: string[] = [];
  const appNames = new Set(observations.map((o) => o.appName));
  const projects = summarizeProjects(observations).map((p) => p.label);

  if (appNames.has("Code") || appNames.has("Cursor") || appNames.has("Zed")) {
    results.push("Software engineer or developer working on code, tooling, or local automation workflows");
  }
  if (appNames.has("Slack")) {
    results.push("Coordinates work through Slack alongside hands-on implementation");
  }
  if (projects.length > 0) {
    results.push(`Currently active in ${joinNatural(projects.slice(0, 3))}`);
  }

  return results.slice(0, 5);
}

interface ProjectSummary {
  key: string;
  label: string;
  count: number;
  details: string[];
}

function summarizeProjects(observations: ParsedObservation[]): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();

  for (const obs of observations.slice(-300)) {
    const project = obs.project;
    if (!project) continue;

    const key = project.toLowerCase();
    const existing = map.get(key) ?? { key, label: project, count: 0, details: [] };
    existing.count += 1;

    const detail = localSummary(obs);
    if (detail && !existing.details.includes(detail)) {
      existing.details.push(detail);
    }

    map.set(key, existing);
  }

  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map((p) => ({ ...p, details: p.details.slice(0, 3) }))
    .slice(0, 5);
}

function localSummary(obs: ParsedObservation): string | null {
  const title = obs.windowTitle?.trim();
  if (!title) return null;

  if (["Code", "Cursor", "Zed"].includes(obs.appName)) {
    const parts = title.split(/\s+[—-]\s+/).map((p) => p.trim()).filter(Boolean);
    const filePart = parts[0] ?? title;
    const project = parts.at(-1);
    if (project && project !== filePart) return `Editing ${filePart} in ${project}`;
    return `Editing ${filePart}`;
  }

  if (["Google Chrome", "Arc", "Safari", "Firefox"].includes(obs.appName)) {
    const cleaned = title
      .replace(/\s+[—-]\s+(Google Chrome|Arc|Safari|Firefox).*$/, "")
      .replace(/^\(\d+\)\s*/, "")
      .trim();
    if (/github/i.test(cleaned)) return `Browsing GitHub: ${cleaned}`;
    if (/linear/i.test(cleaned)) return `Reviewing Linear: ${cleaned}`;
    return `Browsing: ${cleaned}`;
  }

  if (["Terminal", "iTerm2", "Warp", "Alacritty"].includes(obs.appName)) {
    return `Working in terminal: ${title}`;
  }

  return `Using ${obs.appName}: ${title}`;
}

function isNoiseApp(name: string): boolean {
  return ["system", "loginwindow", "UserNotificationCenter", "unknown"].includes(name);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatUtcStamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function joinNatural(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
