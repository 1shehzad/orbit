import type { App } from "@slack/bolt";
import type { ProjectConfig } from "@orbit/core";
import { LinearClient } from "@orbit/core";
import { getThread, saveThread } from "../threads.js";
import { refineSpec } from "../analyzer.js";
import { createAndProcessTickets, enterClarifyPhase } from "./mention.js";
import { runPipeline } from "../runner.js";
import { resolveProjectConfig } from "../projects.js";
import { mergeUserConfig } from "../users.js";
import { classifyMessage } from "../classifier.js";
import { respondToQuery } from "../responder.js";
import { answerCodeQuestion } from "../codeqa.js";
import { isOwnerAway } from "../presence-monitor.js";
import { logInteraction } from "../interaction-log.js";
import type { BotConfig } from "../config.js";
import type { Poster } from "../post.js";

/**
 * Register the message handler for threaded replies.
 * - During "clarifying" phase: replies are treated as answers.
 * - During "completed" phase: replies are treated as feedback → creates fix ticket.
 */
export function registerMessageHandler(app: App, _defaultConfig: ProjectConfig, botConfig: BotConfig, poster?: Poster) {
  app.message(async ({ message, say }) => {
    // Only handle threaded messages
    if (!("thread_ts" in message) || !message.thread_ts) return;
    // Ignore bot messages
    if ("bot_id" in message && message.bot_id) return;
    const channelId = message.channel;
    const threadTs = message.thread_ts;
    const thread = getThread(channelId, threadTs);

    const text = "text" in message ? (message.text || "") : "";
    if (!text.trim()) return;

    const msgUser = "user" in message ? (message as { user?: string }).user : undefined;

    // Guard: only respond to allowed users
    if (botConfig.allowedUserIds.length > 0 && !botConfig.allowedUserIds.includes(msgUser || "")) return;

    const replyFn = async (msg: { text: string; thread_ts: string }) => {
      if (poster) {
        await poster.post(channelId, msg.text, msg.thread_ts);
      } else {
        await say(msg);
      }
    };

    // If there's an active thread state, handle clarification or feedback
    if (thread) {
      const channelConfig = resolveProjectConfig(channelId);
      const config = mergeUserConfig(channelConfig, msgUser || thread.userId);

      if (thread.phase === "clarifying") {
        await handleClarifyReply(app, thread, text, config, botConfig, replyFn, threadTs, poster);
        return;
      } else if (thread.phase === "completed") {
        await handleFeedbackReply(app, thread, text, config, replyFn, threadTs, poster);
        return;
      }
      // For other phases (analyzing, executing), fall through to handle as conversation
    }

    // No thread state OR thread is in a non-interactive phase —
    // Treat as a follow-up conversation (e.g., replying to a query response)
    // Only respond when owner is away (or TEST_MODE)
    if (!isOwnerAway() && !process.env.TEST_MODE) return;

    // Only handle if the bot previously posted in this thread
    // (check by fetching thread replies and looking for bot messages)
    const ownerUserId = botConfig.ownerUserId;
    if (!ownerUserId) return;

    const channelConfig = resolveProjectConfig(channelId);
    const config = mergeUserConfig(channelConfig, ownerUserId);

    try {
      const classification = await classifyMessage(text, config.anthropicApiKey, config.aiProvider);

      if (classification.type === "query" || classification.type === "code_query") {
        let response: string;
        if (classification.type === "code_query") {
          response = await answerCodeQuestion(text, config, botConfig.contextFolder, botConfig.workspaceRoots);
        } else {
          response = await respondToQuery(text, botConfig.contextFolder, config.anthropicApiKey, config.aiProvider);
        }
        await replyFn({ text: response, thread_ts: threadTs });
        logInteraction({
          timestamp: new Date().toISOString(),
          userId: msgUser || "unknown",
          channelId,
          type: classification.type,
          message: text,
          summary: response.slice(0, 150),
        }).catch(() => {});
      } else {
        // Task — acknowledge and handle
        await replyFn({ text: classification.ack || "On it.", thread_ts: threadTs });
      }
    } catch (err) {
      console.error("Thread reply handling error:", err);
    }
  });
}

/**
 * Handle replies during the clarification phase.
 */
async function handleClarifyReply(
  app: App,
  thread: ReturnType<typeof getThread> & {},
  text: string,
  config: ProjectConfig,
  botConfig: BotConfig,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>,
  threadTs: string,
  poster?: Poster,
) {
  if (thread.clarifyTimer) {
    clearTimeout(thread.clarifyTimer);
    thread.clarifyTimer = undefined;
  }

  if (!thread.answers) thread.answers = [];
  thread.answers.push(text);

  const answeredCount = thread.answers.length;
  const totalQuestions = thread.pendingQuestions?.length || 0;

  if (answeredCount < totalQuestions) {
    await say({
      text: `Got it (${answeredCount}/${totalQuestions}). Waiting for the rest...`,
      thread_ts: threadTs,
    });

    thread.clarifyTimer = setTimeout(async () => {
      if (thread.phase !== "clarifying") return;
      await handleAllAnswersReceived(app, thread, config, botConfig, poster);
    }, botConfig.clarifyTimeoutMinutes * 60 * 1000);

    return;
  }

  await say({
    text: `Got it, updating the plan...`,
    thread_ts: threadTs,
  });

  await handleAllAnswersReceived(app, thread, config, botConfig, poster);
}

async function handleAllAnswersReceived(
  app: App,
  thread: ReturnType<typeof getThread> & {},
  config: ProjectConfig,
  botConfig: BotConfig,
  poster?: Poster,
) {
  if (!thread.analysisResult || !thread.pendingQuestions) return;

  const answers = (thread.answers || []).map((a, i) => ({
    question: thread.pendingQuestions![i] || "",
    answer: a,
  }));

  try {
    const result = await refineSpec(app, thread, config, answers);

    if (!result.approved && result.questions.length > 0) {
      if (thread.clarifyRound >= botConfig.maxClarifyRounds) {
        thread.assumptions.push(
          ...result.questions.map((q) => `Unanswered (max rounds): ${q}`),
        );
        await createAndProcessTickets(app, thread, config, thread.analysisResult!, poster, botConfig.contextFolder);
        return;
      }

      thread.analysisResult!.analysis = result;
      await enterClarifyPhase(app, thread, config, botConfig);
      return;
    }

    const { reclassify } = await import("../analyzer.js");
    await reclassify(app, thread, config);
    await createAndProcessTickets(app, thread, config, thread.analysisResult!, poster, botConfig.contextFolder);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    thread.phase = "error";
    thread.errors.push(errorMsg);
  }
}

/**
 * Handle feedback replies in completed threads.
 * Creates a fix ticket in Linear and runs it through the pipeline.
 */
async function handleFeedbackReply(
  app: App,
  thread: ReturnType<typeof getThread> & {},
  feedback: string,
  config: ProjectConfig,
  say: (msg: { text: string; thread_ts: string }) => Promise<unknown>,
  threadTs: string,
  poster?: Poster,
) {
  await say({
    text: `Got it, I'll fix that.`,
    thread_ts: threadTs,
  });

  try {
    const linear = new LinearClient(config.linearApiKey);

    let teamId: string | undefined;
    if (config.linearTeamId) {
      const teams = await linear.getTeams();
      const team = teams.find((t) => t.id === config.linearTeamId || t.key === config.linearTeamId);
      teamId = team?.id;
    }
    if (!teamId) {
      const teams = await linear.getTeams();
      if (teams.length > 0) teamId = teams[0].id;
    }
    if (!teamId) {
      await say({ text: `No Linear team found.`, thread_ts: threadTs });
      return;
    }

    const ticketContext = thread.tickets
      .map((t) => `[${t.identifier}] ${t.title}`)
      .join("\n");

    const assigneeId = config.assigneeId || (await linear.getMyId());

    const created = await linear.createIssue({
      teamId,
      title: `Fix: ${feedback.slice(0, 80)}`,
      description: [
        `## Feedback`,
        feedback,
        ``,
        `## Context`,
        `**Original problem:** ${thread.problem}`,
        `**Related tickets:** ${ticketContext}`,
      ].join("\n"),
      priority: 2,
      assigneeId,
    });

    thread.tickets.push({
      id: created.id,
      identifier: created.identifier,
      title: `Fix: ${feedback.slice(0, 80)}`,
      description: feedback,
      url: created.url,
      state: { id: "", name: "Backlog", type: "backlog" },
      priority: 2,
      labels: [],
    });

    thread.phase = "executing";
    saveThread(thread).catch(() => {});

    const allTickets = thread.tickets;
    const allCompleted = thread.completedTicketIds;
    const fixTicket = allTickets[allTickets.length - 1];

    thread.tickets = [fixTicket];
    thread.completedTicketIds = new Set();

    runPipeline(app, thread, config, poster)
      .then(() => {
        thread.tickets = allTickets;
        thread.completedTicketIds = allCompleted;
        thread.completedTicketIds.add(fixTicket.id);
        thread.phase = "completed";
        saveThread(thread).catch(() => {});
      })
      .catch((err) => {
        console.error("Feedback fix pipeline error:", err);
        thread.tickets = allTickets;
        thread.completedTicketIds = allCompleted;
        thread.phase = "completed";
        thread.errors.push(`Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        saveThread(thread).catch(() => {});
      });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await say({
      text: `Couldn't create the fix ticket: ${errorMsg}`,
      thread_ts: threadTs,
    });
  }
}
