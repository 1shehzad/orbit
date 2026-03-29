import { basename } from "node:path";
import { LinearClient, GitManager } from "@orbit/core";
import type { ProjectConfig } from "@orbit/core";

/**
 * Generate a sprint/meeting summary from Linear tickets and git data.
 * Answers questions like "what should I know before the sprint review?"
 */
export async function generateMeetingPrep(
  config: ProjectConfig,
  workspaceRoots: string[],
): Promise<string> {
  const linear = new LinearClient(config.linearApiKey);
  const assigneeId = config.assigneeId || (await linear.getMyId().catch(() => ""));

  if (!assigneeId) {
    return "Couldn't fetch Linear data — check your API key.";
  }

  // Gather data in parallel
  const [completed, inProgress, backlog] = await Promise.all([
    linear.getCompletedTickets(assigneeId, 14 * 24).catch(() => []),  // 2 weeks
    linear.getInProgressTickets(assigneeId).catch(() => []),
    linear.getAssignedTickets(assigneeId).catch(() => []),
  ]);

  // Get recent PRs across all repos
  const allPRs: { repo: string; number: number; title: string; url: string }[] = [];
  for (const root of workspaceRoots) {
    const git = new GitManager(root);
    const repos = await git.discoverRepos().catch(() => []);
    for (const repo of repos) {
      const prs = await git.getRecentPRs(repo, 14 * 24).catch(() => []);
      for (const pr of prs) {
        allPRs.push({ repo: basename(repo), ...pr });
      }
    }
  }

  // Get PRs waiting for review
  const pendingReviews: { repo: string; number: number; title: string; url: string; author: string }[] = [];
  for (const root of workspaceRoots) {
    const git = new GitManager(root);
    const repos = await git.discoverRepos().catch(() => []);
    for (const repo of repos) {
      const prs = await git.getPRsToReview(repo).catch(() => []);
      for (const pr of prs) {
        pendingReviews.push({ repo: basename(repo), ...pr });
      }
    }
  }

  // Build summary
  const total = completed.length + inProgress.length + backlog.length;
  const doneCount = completed.length;
  const parts: string[] = [];

  // Overview
  parts.push(`*Sprint Overview*`);
  parts.push(`${doneCount}/${total} tickets completed this sprint.`);

  // Completed
  if (completed.length > 0) {
    parts.push(`\n*Completed (${completed.length}):*`);
    for (const t of completed.slice(0, 10)) {
      parts.push(`• <${t.url}|${t.identifier}> ${t.title}`);
    }
    if (completed.length > 10) parts.push(`  _...and ${completed.length - 10} more_`);
  }

  // In progress
  if (inProgress.length > 0) {
    parts.push(`\n*In Progress (${inProgress.length}):*`);
    for (const t of inProgress) {
      parts.push(`• <${t.url}|${t.identifier}> ${t.title}`);
    }
  }

  // Still in backlog
  if (backlog.length > 0) {
    parts.push(`\n*Backlog/Not Started (${backlog.length}):*`);
    for (const t of backlog.slice(0, 5)) {
      parts.push(`• <${t.url}|${t.identifier}> ${t.title}`);
    }
    if (backlog.length > 5) parts.push(`  _...and ${backlog.length - 5} more_`);
  }

  // PRs
  if (allPRs.length > 0) {
    parts.push(`\n*PRs Merged (${allPRs.length}):*`);
    for (const pr of allPRs.slice(0, 8)) {
      parts.push(`• <${pr.url}|${pr.repo}#${pr.number}> ${pr.title}`);
    }
  }

  // Pending reviews
  if (pendingReviews.length > 0) {
    parts.push(`\n*Waiting For Your Review (${pendingReviews.length}):*`);
    for (const pr of pendingReviews) {
      parts.push(`• <${pr.url}|${pr.repo}#${pr.number}> ${pr.title} (by ${pr.author})`);
    }
  }

  // Risks / blockers
  const risks: string[] = [];
  if (inProgress.length > 3) risks.push(`${inProgress.length} tickets in progress simultaneously — risk of context switching`);
  if (backlog.length > 0) risks.push(`${backlog.length} ticket(s) haven't been started yet`);
  if (pendingReviews.length > 0) risks.push(`${pendingReviews.length} PR(s) blocking on your review`);

  if (risks.length > 0) {
    parts.push(`\n*Risks/Attention:*`);
    for (const r of risks) {
      parts.push(`• ${r}`);
    }
  }

  return parts.join("\n");
}
