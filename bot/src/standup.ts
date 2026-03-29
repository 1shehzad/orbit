import type { App } from "@slack/bolt";
import { basename } from "node:path";
import { LinearClient, GitManager } from "@orbit/core";
import type { ProjectConfig } from "@orbit/core";
import type { BotConfig } from "./config.js";
import { resolveProjectConfig } from "./projects.js";
import { mergeUserConfig } from "./users.js";

/**
 * Start the auto-standup scheduler.
 * Posts standup to the configured channel at the configured time.
 */
export function startStandupScheduler(app: App, botConfig: BotConfig) {
  const channelId = botConfig.standupChannelId;
  const ownerUserId = botConfig.ownerUserId;
  const userToken = botConfig.slack.userToken;

  if (!channelId || !ownerUserId) {
    console.log("Standup disabled — set STANDUP_CHANNEL_ID and OWNER_USER_ID in .env");
    return;
  }

  const [hours, minutes] = (botConfig.standupTime || "09:00").split(":").map(Number);

  // Schedule daily standup
  scheduleDaily(hours, minutes, async () => {
    try {
      const config = mergeUserConfig(resolveProjectConfig(channelId), ownerUserId);
      const standup = await generateStandup(config, ownerUserId);

      await app.client.chat.postMessage({
        token: userToken || undefined,
        channel: channelId,
        text: standup,
      });

      console.log("Standup posted");
    } catch (err) {
      console.error("Standup failed:", err);
    }
  });

  console.log(`Standup scheduled for ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} in channel ${channelId}`);
}

/**
 * Generate standup content from git log + Linear tickets.
 */
export async function generateStandup(
  config: ProjectConfig,
  ownerUserId: string,
): Promise<string> {
  const linear = new LinearClient(config.linearApiKey);
  const git = new GitManager(config.projectFolder);
  const assigneeId = config.assigneeId || (await linear.getMyId());

  // Gather data in parallel
  const [completedTickets, inProgressTickets, upcomingTickets, repos] = await Promise.all([
    linear.getCompletedTickets(assigneeId, 24).catch(() => []),
    linear.getInProgressTickets(assigneeId).catch(() => []),
    linear.getAssignedTickets(assigneeId).catch(() => []),
    git.discoverRepos().catch(() => []),
  ]);

  // Get recent commits across repos
  const recentCommits: { repo: string; commits: string[] }[] = [];
  const recentPRs: { repo: string; prs: { number: number; title: string; url: string }[] }[] = [];

  for (const repo of repos) {
    const [commits, prs] = await Promise.all([
      git.getRecentCommits(repo, 24).catch(() => []),
      git.getRecentPRs(repo, 24).catch(() => []),
    ]);
    if (commits.length > 0) recentCommits.push({ repo: basename(repo), commits });
    if (prs.length > 0) recentPRs.push({ repo: basename(repo), prs });
  }

  // Build standup
  const parts: string[] = [];
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  parts.push(`*Standup — ${dateStr}*`);

  // Yesterday
  const yesterdayItems: string[] = [];
  if (completedTickets.length > 0) {
    for (const t of completedTickets) {
      yesterdayItems.push(`<${t.url}|${t.identifier}> ${t.title}`);
    }
  }
  if (recentPRs.length > 0) {
    for (const { repo, prs } of recentPRs) {
      for (const pr of prs) {
        yesterdayItems.push(`<${pr.url}|${repo}#${pr.number}> ${pr.title}`);
      }
    }
  }
  if (recentCommits.length > 0 && yesterdayItems.length === 0) {
    // Fall back to commits if no tickets/PRs
    for (const { repo, commits } of recentCommits) {
      for (const c of commits.slice(0, 3)) {
        yesterdayItems.push(`\`${repo}\` ${c}`);
      }
    }
  }

  if (yesterdayItems.length > 0) {
    parts.push(`\n*Yesterday:*`);
    for (const item of yesterdayItems.slice(0, 5)) {
      parts.push(`• ${item}`);
    }
  } else {
    parts.push(`\n*Yesterday:* No tracked activity`);
  }

  // Today
  const todayItems: string[] = [];
  if (inProgressTickets.length > 0) {
    for (const t of inProgressTickets) {
      todayItems.push(`<${t.url}|${t.identifier}> ${t.title}`);
    }
  }
  if (todayItems.length === 0 && upcomingTickets.length > 0) {
    // Next up from backlog
    for (const t of upcomingTickets.slice(0, 3)) {
      todayItems.push(`<${t.url}|${t.identifier}> ${t.title}`);
    }
  }

  if (todayItems.length > 0) {
    parts.push(`\n*Today:*`);
    for (const item of todayItems.slice(0, 5)) {
      parts.push(`• ${item}`);
    }
  } else {
    parts.push(`\n*Today:* Checking backlog`);
  }

  // Blockers — for now just "None" (could read from a blockers.md file later)
  parts.push(`\n*Blockers:* None`);

  return parts.join("\n");
}

/**
 * Schedule a function to run daily at a specific time.
 */
function scheduleDaily(hours: number, minutes: number, fn: () => Promise<void>) {
  const scheduleNext = () => {
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);

    // If the time already passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    const delay = target.getTime() - now.getTime();
    setTimeout(async () => {
      await fn();
      scheduleNext(); // Reschedule for next day
    }, delay);
  };

  scheduleNext();
}
