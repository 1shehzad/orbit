import type { App } from "@slack/bolt";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PRInfo } from "@orbit/core";
import type { Poster } from "./post.js";

const exec = promisify(execFile);

interface DeployCheck {
  pr: PRInfo;
  channelId: string;
  threadTs: string;
  projectFolder: string;
  startedAt: number;
}

const activeChecks: DeployCheck[] = [];

/**
 * Start monitoring a PR's deployment after it's created.
 * Polls the PR's status checks for deploy URLs and errors.
 */
export function watchDeployment(
  app: App,
  pr: PRInfo,
  channelId: string,
  threadTs: string,
  projectFolder: string,
  poster?: Poster,
  userToken?: string,
): void {
  const check: DeployCheck = {
    pr,
    channelId,
    threadTs,
    projectFolder,
    startedAt: Date.now(),
  };

  activeChecks.push(check);

  // Check after 2 minutes (let deploy start), then every 2 minutes for 30 minutes
  const maxDurationMs = 30 * 60 * 1000;
  const intervalMs = 2 * 60 * 1000;
  let elapsed = 0;

  // First check after 2 minutes
  setTimeout(async () => {
    await runDeployCheck(app, check, poster, userToken);

    // Then every 2 minutes
    const timer = setInterval(async () => {
      elapsed += intervalMs;
      if (elapsed >= maxDurationMs) {
        clearInterval(timer);
        removeCheck(check);
        return;
      }

      const done = await runDeployCheck(app, check, poster, userToken);
      if (done) {
        clearInterval(timer);
        removeCheck(check);
      }
    }, intervalMs);
  }, intervalMs);
}

async function runDeployCheck(
  app: App,
  check: DeployCheck,
  poster?: Poster,
  userToken?: string,
): Promise<boolean> {
  const { pr, channelId, threadTs, projectFolder } = check;
  const repoDir = join(projectFolder, pr.repo);

  try {
    // Check PR status checks for deploy info
    const { stdout } = await exec("gh", [
      "pr", "view", String(pr.number),
      "--json", "statusCheckRollup",
    ], { cwd: repoDir });

    const data = JSON.parse(stdout);
    const checks: { context: string; state: string; targetUrl?: string; description?: string }[] =
      data.statusCheckRollup || [];

    // Look for Vercel/deploy checks
    const deployChecks = checks.filter((c) =>
      /deploy|vercel|preview|netlify/i.test(c.context)
    );

    if (deployChecks.length === 0) return false;

    // Check for failures
    const failed = deployChecks.filter((c) => c.state === "FAILURE" || c.state === "ERROR");
    const succeeded = deployChecks.filter((c) => c.state === "SUCCESS");
    const pending = deployChecks.filter((c) => c.state === "PENDING" || c.state === "EXPECTED");

    if (failed.length > 0) {
      // Deploy failed — notify
      const failDetails = failed.map((c) => c.description || c.context).join(", ");
      const msg = `Heads up — deploy failed for ${pr.repo}#${pr.number}: ${failDetails}. Might need to check this.`;

      if (poster) {
        await poster.post(channelId, msg, threadTs);
      } else {
        await app.client.chat.postMessage({
          channel: channelId, thread_ts: threadTs, text: msg,
        });
      }
      return true; // Stop watching
    }

    if (succeeded.length > 0 && pending.length === 0) {
      // All done — check for deploy URL
      const deployUrl = succeeded
        .map((c) => c.targetUrl)
        .find((u) => u && /https?:\/\//.test(u));

      if (deployUrl) {
        const msg = `Deployed: <${deployUrl}|preview> for ${pr.repo}#${pr.number}`;
        if (poster) {
          await poster.post(channelId, msg, threadTs);
        } else {
          await app.client.chat.postMessage({
            channel: channelId, thread_ts: threadTs, text: msg,
          });
        }
      }
      return true; // Stop watching
    }

    // Still pending
    return false;
  } catch {
    // gh CLI failed or repo not found — stop silently
    return false;
  }
}

/**
 * After deployment succeeds, monitor for runtime errors.
 * Checks the Vercel deployment logs for 500 errors.
 * (Requires `vercel` CLI logged in, or uses gh checks.)
 */
export async function checkDeployHealth(
  app: App,
  pr: PRInfo,
  deployUrl: string,
  channelId: string,
  threadTs: string,
  poster?: Poster,
): Promise<void> {
  // Simple health check — hit the URL and check status
  try {
    const res = await fetch(deployUrl, { method: "HEAD", redirect: "follow" });
    if (res.status >= 500) {
      const msg = `Heads up — ${deployUrl} is returning ${res.status} after deploying ${pr.repo}#${pr.number}. Might be related to the recent changes.`;
      if (poster) {
        await poster.post(channelId, msg, threadTs);
      } else {
        await app.client.chat.postMessage({
          channel: channelId, thread_ts: threadTs, text: msg,
        });
      }
    }
  } catch {
    // URL unreachable — might be expected for non-web deploys
  }
}

function removeCheck(check: DeployCheck): void {
  const idx = activeChecks.indexOf(check);
  if (idx >= 0) activeChecks.splice(idx, 1);
}

/**
 * Get count of active deploy monitors.
 */
export function getActiveDeployChecks(): number {
  return activeChecks.length;
}
