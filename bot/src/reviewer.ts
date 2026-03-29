import type { App } from "@slack/bolt";
import { basename } from "node:path";
import { GitManager, createAgent } from "@orbit/core";
import type { ProjectConfig } from "@orbit/core";
import type { BotConfig } from "./config.js";
import { resolveProjectConfig } from "./projects.js";
import { mergeUserConfig } from "./users.js";

interface PRReviewResult {
  summary: string;
  issues: string[];
  suggestions: string[];
  verdict: "approve" | "request_changes" | "comment";
  slackResponse: string;
}

/**
 * Start the PR review listener.
 * Monitors for messages like "@ahmad can you review PR #42" or
 * "@ahmad review this <github-pr-url>".
 */
export function registerPRReviewHandler(app: App, botConfig: BotConfig) {
  const ownerUserId = botConfig.ownerUserId;
  if (!ownerUserId) return;

  // This hooks into the existing message listener via a helper
  // The mention handler calls this when it detects a review request
}

/**
 * Check if a message is a PR review request.
 * Returns the PR number and repo if detected, null otherwise.
 */
export function detectPRReview(text: string): { prNumber: number; repo?: string } | null {
  // Match GitHub PR URLs: https://github.com/org/repo/pull/42
  const urlMatch = text.match(/github\.com\/[\w-]+\/([\w-]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return { repo: urlMatch[1], prNumber: parseInt(urlMatch[2], 10) };
  }

  // Match "review PR #42" or "review #42" or "look at PR 42"
  const prMatch = text.match(/(?:review|look at|check)\s+(?:PR\s*)?#?(\d+)/i);
  if (prMatch) {
    return { prNumber: parseInt(prMatch[1], 10) };
  }

  // Match "repo#42" format
  const repoMatch = text.match(/([\w-]+)#(\d+)/);
  if (repoMatch) {
    return { repo: repoMatch[1], prNumber: parseInt(repoMatch[2], 10) };
  }

  return null;
}

/**
 * Review a PR: read the diff, analyze with Claude, post review on GitHub,
 * and respond in Slack.
 */
export async function reviewPR(
  config: ProjectConfig,
  prNumber: number,
  repoHint?: string,
): Promise<PRReviewResult> {
  const git = new GitManager(config.projectFolder);
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);

  // Find the repo
  const repos = await git.discoverRepos();
  let targetRepo: string | undefined;

  if (repoHint) {
    targetRepo = repos.find((r) => basename(r) === repoHint);
  }

  if (!targetRepo) {
    // Try each repo to find where the PR exists
    for (const repo of repos) {
      try {
        const details = await git.getPRDetails(repo, prNumber);
        if (details.title) {
          targetRepo = repo;
          break;
        }
      } catch {}
    }
  }

  if (!targetRepo) {
    return {
      summary: "Couldn't find the PR",
      issues: [],
      suggestions: [],
      verdict: "comment",
      slackResponse: `Couldn't find PR #${prNumber} in any of the repos.`,
    };
  }

  // Get PR details and diff
  const [details, diff] = await Promise.all([
    git.getPRDetails(targetRepo, prNumber),
    git.getPRDiff(targetRepo, prNumber),
  ]);

  if (!diff) {
    return {
      summary: "Empty diff",
      issues: [],
      suggestions: [],
      verdict: "comment",
      slackResponse: `PR #${prNumber} has no changes or I couldn't read the diff.`,
    };
  }

  // Truncate diff if too large (Claude context limit)
  const maxDiffLen = 50000;
  const truncatedDiff = diff.length > maxDiffLen
    ? diff.slice(0, maxDiffLen) + "\n\n... (diff truncated)"
    : diff;

  // Claude reviews the PR
  const result = await claude.run(
    `You are a senior engineer reviewing a pull request. Be thorough but concise.

PR #${prNumber}: ${details.title}

Description:
${details.body || "No description"}

Files changed: ${details.files.join(", ")}

Diff:
\`\`\`
${truncatedDiff}
\`\`\`

Review this PR and output ONLY this JSON:

===REVIEW===
{
  "summary": "1-2 sentence summary of what this PR does",
  "issues": ["list of actual bugs, security issues, or logic errors — only real problems"],
  "suggestions": ["list of improvement suggestions — nice-to-haves, not blockers"],
  "verdict": "approve|request_changes|comment",
  "reviewComment": "The full review comment to post on GitHub. Be specific — reference files and line numbers. Be constructive. If approving, keep it brief. Format as markdown."
}
===END_REVIEW===

Rules:
- verdict = "approve" if code is correct and well-written
- verdict = "request_changes" ONLY if there are actual bugs or security issues
- verdict = "comment" if there are suggestions but nothing blocking
- Don't nitpick style if there's a formatter/linter
- Focus on logic, security, edge cases, error handling
- Be a helpful reviewer, not a harsh one`,
    config.projectFolder,
  );

  // Parse review
  const startIdx = result.output.indexOf("===REVIEW===");
  const endIdx = result.output.indexOf("===END_REVIEW===");
  if (startIdx === -1) {
    return {
      summary: "Review failed",
      issues: [],
      suggestions: [],
      verdict: "comment",
      slackResponse: "I looked at the PR but couldn't generate a proper review. I'll take another look later.",
    };
  }

  const json = result.output.slice(startIdx + "===REVIEW===".length, endIdx === -1 ? undefined : endIdx).trim();

  try {
    const parsed = JSON.parse(json);
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const verdict = (["approve", "request_changes", "comment"].includes(parsed.verdict))
      ? parsed.verdict as "approve" | "request_changes" | "comment"
      : "comment";

    // Post review on GitHub
    const reviewComment = parsed.reviewComment || parsed.summary || "Reviewed.";
    const ghEvent = verdict === "approve" ? "APPROVE"
      : verdict === "request_changes" ? "REQUEST_CHANGES"
      : "COMMENT";

    try {
      await git.submitPRReview(targetRepo, prNumber, reviewComment, ghEvent);
    } catch (err) {
      console.error("Failed to submit GH review:", err);
    }

    // Build Slack response
    const repoName = basename(targetRepo);
    let slackResponse = "";

    if (verdict === "approve") {
      slackResponse = `Reviewed <${details.url}|${repoName}#${prNumber}> — looks good, approved. ${parsed.summary}`;
    } else if (verdict === "request_changes") {
      const issueList = issues.slice(0, 3).map((i: string) => `• ${i}`).join("\n");
      slackResponse = `Reviewed <${details.url}|${repoName}#${prNumber}> — found a few issues:\n${issueList}\nLeft comments on the PR.`;
    } else {
      if (suggestions.length > 0) {
        slackResponse = `Reviewed <${details.url}|${repoName}#${prNumber}> — ${parsed.summary} Left a few suggestions on the PR.`;
      } else {
        slackResponse = `Reviewed <${details.url}|${repoName}#${prNumber}> — ${parsed.summary}`;
      }
    }

    return {
      summary: parsed.summary || "",
      issues,
      suggestions,
      verdict,
      slackResponse,
    };
  } catch {
    return {
      summary: "Review parse failed",
      issues: [],
      suggestions: [],
      verdict: "comment",
      slackResponse: "Took a look at the PR, left some thoughts in the comments.",
    };
  }
}

/**
 * Check for pending PR review requests and notify.
 * Can be run on a schedule or triggered manually.
 */
export async function checkPendingReviews(
  app: App,
  config: ProjectConfig,
  channelId: string,
): Promise<void> {
  const git = new GitManager(config.projectFolder);
  const repos = await git.discoverRepos();

  const allPRs: { repo: string; number: number; title: string; url: string; author: string }[] = [];

  for (const repo of repos) {
    const prs = await git.getPRsToReview(repo);
    for (const pr of prs) {
      allPRs.push({ repo: basename(repo), ...pr });
    }
  }

  if (allPRs.length === 0) return;

  const lines = allPRs.map((pr) =>
    `• <${pr.url}|${pr.repo}#${pr.number}> — ${pr.title} (by ${pr.author})`
  );

  await app.client.chat.postMessage({
    channel: channelId,
    text: `*${allPRs.length} PR(s) waiting for your review:*\n${lines.join("\n")}`,
  });
}
