import type { App } from "@slack/bolt";
import { TicketPipeline } from "@orbit/core";
import type { ProjectConfig, TicketStatus } from "@orbit/core";
import type { ThreadState } from "./threads.js";
import { saveThread } from "./threads.js";
import type { Poster } from "./post.js";
import { updateContextAfterTask } from "./context-updater.js";
import { logInteraction } from "./interaction-log.js";
import { watchDeployment } from "./deploy-monitor.js";

/**
 * Runs the full pipeline for a thread's tickets.
 * Posts minimal updates — just a short done message at the end.
 * Supports resuming — skips already-completed tickets.
 */
export async function runPipeline(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
  poster?: Poster,
  contextFolder?: string,
): Promise<void> {
  const pipeline = new TicketPipeline(config);
  const { channelId, threadTs } = thread;

  // Filter out already-completed tickets for resume
  const pendingTickets = thread.tickets.filter(
    (t) => !thread.completedTicketIds.has(t.id),
  );

  if (pendingTickets.length === 0) {
    thread.phase = "completed";
    return;
  }

  // Track PRs and statuses
  const latestStatuses = new Map<string, TicketStatus>();

  pipeline.on("status_update", (status) => {
    latestStatuses.set(status.ticketId, status);
  });

  pipeline.on("activity_log", () => {
    // Silent — no Slack spam
  });

  pipeline.on("ticket_complete", async (data) => {
    thread.completedTicketIds.add(data.ticketId);
    saveThread(thread).catch(() => {});
  });

  pipeline.on("qa_result", async () => {
    // Silent
  });

  pipeline.on("pr_created", async (data) => {
    const ticket = thread.tickets.find((t) => t.id === data.ticketId);
    if (ticket) {
      thread.prs.push(data.pr);

      // Watch deployment — polls status checks, notifies on success/failure
      watchDeployment(app, data.pr, channelId, threadTs, config.projectFolder, poster);
    }
  });

  pipeline.on("processing_started", async () => {
    thread.phase = "executing";
  });

  pipeline.on("all_complete", async () => {
    thread.phase = "completed";

    // Log interaction for catch-up
    const ticketIds = thread.tickets.map((t) => t.identifier);
    const prUrls = thread.prs.map((p) => `${p.repo}#${p.number}`);
    const doneSummary = thread.errors.length > 0
      ? `Completed with ${thread.errors.length} issue(s)`
      : `Done — ${thread.completedTicketIds.size} ticket(s), ${thread.prs.length} PR(s)`;
    logInteraction({
      timestamp: new Date().toISOString(),
      userId: thread.userId,
      channelId,
      type: "task",
      message: thread.problem,
      summary: doneSummary,
      tickets: ticketIds,
      prs: prUrls,
    }).catch(() => {});

    // Auto-update context files
    if (contextFolder) {
      updateContextAfterTask(contextFolder, config, {
        problem: thread.problem,
        tickets: thread.tickets.map((t) => ({ identifier: t.identifier, title: t.title, url: t.url })),
        prs: thread.prs,
        completedCount: thread.completedTicketIds.size,
        errors: thread.errors,
      }).catch((err) => console.error("Context update error:", err));
    }

    // Post short done summary in thread
    try {
      const done = thread.completedTicketIds.size;
      const total = thread.tickets.length;
      const failed = thread.errors.length;

      const parts: string[] = [];

      if (failed > 0) {
        parts.push(`Done \u2014 ${done}/${total} tickets, ${failed} had issues.`);
      } else if (total === 1) {
        parts.push("Done.");
      } else {
        parts.push(`Done \u2014 all ${total} tickets.`);
      }

      if (thread.prs.length > 0) {
        const prLinks = thread.prs.map((p) => `<${p.url}|${p.repo}#${p.number}>`);
        if (prLinks.length === 1) {
          parts.push(`PR: ${prLinks[0]}`);
        } else {
          parts.push(`PRs: ${prLinks.join(", ")}`);
        }
      }

      const ticketLinks = thread.tickets.map((t) => `<${t.url}|${t.identifier}>`);
      if (ticketLinks.length === 1) {
        parts.push(`Ticket: ${ticketLinks[0]} \u2014 moved to In Review.`);
      } else {
        parts.push(`Tickets: ${ticketLinks.join(", ")} \u2014 moved to In Review.`);
      }

      if (thread.stagingUrls.length > 0) {
        const unique = [...new Set(thread.stagingUrls)];
        parts.push(`Staging: ${unique.map((u) => `<${u}|preview>`).join(", ")}`);
      }

      const text = parts.join("\n");
      if (poster) {
        await poster.post(channelId, text, threadTs);
      } else {
        await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      }
    } catch {}

    saveThread(thread).catch(() => {});
  });

  // Run
  try {
    thread.phase = "executing";
    await pipeline.processAllTickets(pendingTickets);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    thread.phase = "error";
    thread.errors.push(errorMsg);
    saveThread(thread).catch(() => {});

    try {
      const errText = `Ran into an issue: ${errorMsg}`;
      if (poster) {
        await poster.post(channelId, errText, threadTs);
      } else {
        await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errText });
      }
    } catch {}
  }
}

