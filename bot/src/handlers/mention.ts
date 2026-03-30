import type { App } from "@slack/bolt";
import type { ProjectConfig } from "@orbit/core";
import { LinearClient } from "@orbit/core";
import { createThread, getThread, saveThread } from "../threads.js";
import type { ThreadState } from "../threads.js";
import { analyzeProblem, generateAssumptions } from "../analyzer.js";
import type { AnalysisResult } from "../analyzer.js";
import { buildExecutionOrder, flattenToQueue } from "../deps.js";
import { runPipeline } from "../runner.js";
import { resolveProjectConfig } from "../projects.js";
import { mergeUserConfig } from "../users.js";
import { classifyMessage } from "../classifier.js";
import { respondToQuery } from "../responder.js";
import { detectPRReview, reviewPR } from "../reviewer.js";
import { answerCodeQuestion } from "../codeqa.js";
import type { BotConfig } from "../config.js";
import type { Poster } from "../post.js";
import { logInteraction } from "../interaction-log.js";
import { parseScheduleTime, scheduleTask } from "../scheduler.js";
import { generateMeetingPrep } from "../meeting-prep.js";
import { isOwnerAway } from "../presence-monitor.js";
import { resolveProjectFromMessage, listAvailableProjects } from "../project-resolver.js";

/**
 * Register handler that monitors ALL messages for @mentions of the owner.
 * When someone mentions the owner (not the bot), the bot classifies the message
 * as a query or task and responds accordingly.
 */
export function registerMentionHandler(app: App, _defaultConfig: ProjectConfig, botConfig: BotConfig, poster?: Poster) {
  const ownerUserId = botConfig.ownerUserId;

  if (!ownerUserId) {
    console.warn("OWNER_USER_ID not set — mention handler disabled. Set it in .env to enable.");
    return;
  }

  // Listen to ALL messages in channels the bot is in
  app.message(async ({ message, say, client }) => {
    // Ignore bot messages
    if ("bot_id" in message && message.bot_id) return;
    // Ignore messages from the owner — unless TEST_MODE is on (so you can test yourself)
    if (!process.env.TEST_MODE && "user" in message && message.user === ownerUserId) return;
    // Only process top-level messages (not thread replies — those go to message handler)
    if ("thread_ts" in message && message.thread_ts) return;

    const text = "text" in message ? (message.text || "") : "";
    const channelId = message.channel;
    const messageTs = "ts" in message ? message.ts : "";

    // Detect DMs: channel type "im" means it's a direct message
    const channelType = "channel_type" in message ? (message as unknown as Record<string, unknown>).channel_type : undefined;
    const isDM = channelType === "im";

    // In channels: only respond if the owner is mentioned
    // In DMs: respond to everything (it's directed at you)
    if (!isDM && !text.includes(`<@${ownerUserId}>`)) return;

    // Strip the owner mention from the text (DMs won't have it)
    const cleanText = text.replace(new RegExp(`<@${ownerUserId}>`, "g"), "").trim();
    if (!cleanText) return;

    // Resolve config — detect project from message text and channel name
    const channelConfig = resolveProjectConfig(channelId);
    const baseConfig = mergeUserConfig(channelConfig, ownerUserId);

    // Get channel name for project matching
    let channelName: string | undefined;
    try {
      const info = await client.conversations.info({ channel: channelId });
      channelName = (info.channel as Record<string, string> | undefined)?.name;
    } catch {}

    // Fetch recent messages in the channel/DM for context-based project detection
    let threadMessages: string[] | undefined;
    try {
      const history = await client.conversations.history({
        channel: channelId,
        limit: 10,
        latest: messageTs,
      });
      threadMessages = (history.messages ?? [])
        .filter((m) => "text" in m && m.text && !("bot_id" in m && m.bot_id))
        .map((m) => (m as { text: string }).text)
        .filter(Boolean);
    } catch {}

    // Auto-detect project: message → channel → thread context → ask
    const resolved = await resolveProjectFromMessage(
      cleanText,
      botConfig.workspaceRoots,
      channelName,
      threadMessages,
    );

    // Helper: post as user or bot
    const reply = async (replyText: string) => {
      if (poster) {
        await poster.post(channelId, replyText, messageTs);
      } else {
        await say({ text: replyText, thread_ts: messageTs });
      }
    };

    if (resolved.matchType === "none") {
      // Can't figure out the project — ask the user
      const projects = await listAvailableProjects(botConfig.workspaceRoots);
      const projectList = projects.map((p) => `• *${p.name}* (${p.repoCount} repo${p.repoCount !== 1 ? "s" : ""})`).join("\n");
      await reply(`Which project is this for?\n\n${projectList}\n\nMention the project name and I'll get started.`);
      return;
    }

    const config = { ...baseConfig, projectFolder: resolved.projectFolder };

    if (resolved.matchType !== "single") {
      console.log(`Project detected: "${resolved.projectName}" (${resolved.matchType}) → ${resolved.projectFolder}`);
    }

    const msgUser = "user" in message ? (message as unknown as Record<string, string>).user : "unknown";

    // ─── Check if it's a PR review request ───
    const prRequest = detectPRReview(cleanText);
    if (prRequest) {
      await reply("Sure, I'll take a look.");
      try {
        const result = await reviewPR(config, prRequest.prNumber, prRequest.repo);
        await reply(result.slackResponse);
        logInteraction({ timestamp: new Date().toISOString(), userId: msgUser, channelId, type: "review", message: cleanText, summary: result.slackResponse.slice(0, 150) }).catch(() => {});
      } catch (err) {
        await reply("Couldn't review the PR right now, I'll check it later.");
        console.error("PR review error:", err);
      }
      return;
    }

    // ─── Away mode: auto-handle when owner is away ───
    const ownerIsAway = isOwnerAway();

    // Classify: query or task?
    let classification;
    try {
      classification = await classifyMessage(cleanText, config.anthropicApiKey, config.aiProvider);
    } catch {
      classification = { type: "task" as const, ack: "On it.", needsClarification: false };
    }

    // When owner is away, add a note that we're handling it autonomously
    if (ownerIsAway && classification.type === "task") {
      classification.ack = `I'm handling things while <@${ownerUserId}> is away. ${classification.ack || "On it."}`;
    }

    if (classification.type === "query") {
      // Check if it's a meeting prep / sprint question
      const isMeetingPrep = /sprint|standup|review|retro|meeting|status update|progress/i.test(cleanText)
        && /before|prep|know|summary|ready|update/i.test(cleanText);

      if (isMeetingPrep) {
        try {
          const prep = await generateMeetingPrep(config, botConfig.workspaceRoots);
          const prefixed = ownerIsAway ? `_Responding while <@${ownerUserId}> is away:_\n\n${prep}` : prep;
          await reply(prefixed);
          logInteraction({ timestamp: new Date().toISOString(), userId: msgUser, channelId, type: "query", message: cleanText, summary: "Meeting prep summary" }).catch(() => {});
        } catch {
          await reply("Let me check on that and get back to you.");
        }
        return;
      }

      try {
        const response = await respondToQuery(cleanText, botConfig.contextFolder, config.anthropicApiKey, config.aiProvider);
        const prefixed = ownerIsAway ? `_Responding while <@${ownerUserId}> is away:_\n\n${response}` : response;
        await reply(prefixed);
        logInteraction({ timestamp: new Date().toISOString(), userId: msgUser, channelId, type: "query", message: cleanText, summary: response.slice(0, 150) }).catch(() => {});
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await reply("Let me check on that and get back to you.");
        console.error("Query response error:", errorMsg);
      }
      return;
    }

    if (classification.type === "code_query") {
      try {
        const response = await answerCodeQuestion(cleanText, config, botConfig.contextFolder, botConfig.workspaceRoots);
        await reply(response);
        logInteraction({ timestamp: new Date().toISOString(), userId: msgUser, channelId, type: "code_query", message: cleanText, summary: response.slice(0, 150) }).catch(() => {});
      } catch (err) {
        await reply("Let me dig into the code and get back to you.");
        console.error("Code Q&A error:", err);
      }
      return;
    }

    // ─── TASK: check if it should be scheduled for later ───
    const scheduledTime = parseScheduleTime(cleanText);
    if (scheduledTime && scheduledTime.getTime() - Date.now() > 5 * 60 * 1000) {
      // More than 5 minutes away — schedule it
      const timeStr = scheduledTime.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
      await reply(`Got it, I'll start on this ${timeStr}.`);

      // The onExecute callback runs when the timer fires
      await scheduleTask(cleanText, msgUser, channelId, messageTs, scheduledTime, async (task) => {
        // Re-trigger as an immediate task
        const taskConfig = mergeUserConfig(resolveProjectConfig(task.channelId), ownerUserId);
        const taskThread = createThread(task.channelId, task.threadTs, ownerUserId, task.message);
        try {
          taskThread.phase = "analyzing";
          saveThread(taskThread).catch(() => {});
          const analysis = await analyzeProblemSilent(taskConfig, task.message);
          taskThread.analysisResult = analysis;
          taskThread.spec = analysis.spec;
          saveThread(taskThread).catch(() => {});
          await createAndProcessTickets(app, taskThread, taskConfig, analysis, poster, botConfig.contextFolder);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          if (poster) await poster.post(task.channelId, `Ran into an issue with the scheduled task: ${errorMsg}`, task.threadTs);
        }
      });

      logInteraction({ timestamp: new Date().toISOString(), userId: msgUser, channelId, type: "task", message: cleanText, summary: `Scheduled for ${timeStr}` }).catch(() => {});
      return;
    }

    // ─── TASK: execute now ───
    const existing = getThread(channelId, messageTs);
    if (existing && existing.phase !== "completed" && existing.phase !== "error") {
      return;
    }

    await reply(classification.ack || "On it.");

    // When owner is away, skip clarification and proceed with assumptions
    if (classification.needsClarification && classification.clarifyQuestion && !ownerIsAway) {
      await reply(classification.clarifyQuestion);
      const thread = createThread(channelId, messageTs, ownerUserId, cleanText);
      thread.phase = "clarifying";
      thread.pendingQuestions = [classification.clarifyQuestion];
      thread.clarifyRound = 1;
      saveThread(thread).catch(() => {});
      return;
    }

    const thread = createThread(channelId, messageTs, ownerUserId, cleanText);

    try {
      thread.phase = "analyzing";
      saveThread(thread).catch(() => {});

      await reply(`:mag: Scanning the codebase in *${resolved.projectName}*...`);
      const analysis = await analyzeProblemSilent(config, cleanText);
      thread.analysisResult = analysis;
      thread.spec = analysis.spec;
      saveThread(thread).catch(() => {});

      const ticketCount = analysis.classification.tickets.length;
      await reply(`:clipboard: Breaking this into ${ticketCount} ticket${ticketCount !== 1 ? "s" : ""}...`);

      await createAndProcessTickets(app, thread, config, analysis, poster, botConfig.contextFolder);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      thread.phase = "error";
      thread.errors.push(errorMsg);
      saveThread(thread).catch(() => {});
      await reply(`Ran into an issue: ${errorMsg}`);
    }
  });

  // Also keep the app_mention handler for backward compat (@orbit mentions)
  app.event("app_mention", async ({ event, say }) => {
    // Guard: only respond to allowed users
    if (botConfig.allowedUserIds.length > 0 && !botConfig.allowedUserIds.includes(event.user || "")) {
      return;
    }

    const channelConfig = resolveProjectConfig(event.channel);
    const baseAppConfig = mergeUserConfig(channelConfig, event.user || "unknown");
    const problem = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!problem) {
      if (poster) await poster.post(event.channel, "What do you need?", event.ts);
      else await say({ text: "What do you need?", thread_ts: event.ts });
      return;
    }

    const threadTs = event.thread_ts || event.ts;
    const existing = getThread(event.channel, threadTs);
    if (existing && existing.phase !== "completed" && existing.phase !== "error") {
      return;
    }

    // Auto-detect project: message → channel → recent messages → ask
    let appChannelName: string | undefined;
    try {
      const info = await app.client.conversations.info({ channel: event.channel });
      appChannelName = (info.channel as Record<string, string> | undefined)?.name;
    } catch {}

    let appThreadMessages: string[] | undefined;
    try {
      const history = await app.client.conversations.history({
        channel: event.channel,
        limit: 10,
        latest: event.ts,
      });
      appThreadMessages = (history.messages ?? [])
        .filter((m) => "text" in m && m.text && !("bot_id" in m && m.bot_id))
        .map((m) => (m as { text: string }).text)
        .filter(Boolean);
    } catch {}

    const resolvedApp = await resolveProjectFromMessage(problem, botConfig.workspaceRoots, appChannelName, appThreadMessages);
    const config = { ...baseAppConfig, projectFolder: resolvedApp.projectFolder };

    const replyBot = async (text: string) => {
      if (poster) await poster.post(event.channel, text, threadTs);
      else await say({ text, thread_ts: threadTs });
    };

    if (resolvedApp.matchType === "none") {
      const projects = await listAvailableProjects(botConfig.workspaceRoots);
      const projectList = projects.map((p) => `• *${p.name}* (${p.repoCount} repo${p.repoCount !== 1 ? "s" : ""})`).join("\n");
      await replyBot(`Which project is this for?\n\n${projectList}\n\nMention the project name and I'll get started.`);
      return;
    }

    if (resolvedApp.matchType !== "single") {
      console.log(`Project detected: "${resolvedApp.projectName}" (${resolvedApp.matchType}) → ${resolvedApp.projectFolder}`);
    }

    // Check PR review request
    const prReq = detectPRReview(problem);
    if (prReq) {
      await replyBot("Sure, I'll take a look.");
      try {
        const result = await reviewPR(config, prReq.prNumber, prReq.repo);
        await replyBot(result.slackResponse);
      } catch {
        await replyBot("Couldn't review the PR right now.");
      }
      return;
    }

    // Classify
    let classification;
    try {
      classification = await classifyMessage(problem, config.anthropicApiKey, config.aiProvider);
    } catch {
      classification = { type: "task" as const, ack: "On it.", needsClarification: false };
    }

    if (classification.type === "query") {
      try {
        const response = await respondToQuery(problem, botConfig.contextFolder, config.anthropicApiKey, config.aiProvider);
        await replyBot(response);
      } catch {
        await replyBot("Let me check on that and get back to you.");
      }
      return;
    }

    if (classification.type === "code_query") {
      try {
        const response = await answerCodeQuestion(problem, config, botConfig.contextFolder, botConfig.workspaceRoots);
        await replyBot(response);
      } catch {
        await replyBot("Let me dig into the code and get back to you.");
      }
      return;
    }

    await replyBot(classification.ack || "On it.");

    const thread = createThread(event.channel, threadTs, event.user || "unknown", problem);

    try {
      thread.phase = "analyzing";
      saveThread(thread).catch(() => {});

      const analysis = await analyzeProblemSilent(config, problem);
      thread.analysisResult = analysis;
      thread.spec = analysis.spec;
      saveThread(thread).catch(() => {});

      await createAndProcessTickets(app, thread, config, analysis, poster, botConfig.contextFolder);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      thread.phase = "error";
      thread.errors.push(errorMsg);
      saveThread(thread).catch(() => {});
      await replyBot(`Ran into an issue: ${errorMsg}`);
    }
  });
}

/**
 * Silent analysis — same as analyzeProblem but doesn't post intermediate Slack messages.
 * Returns the AnalysisResult without flooding the thread.
 */
async function analyzeProblemSilent(
  config: ProjectConfig,
  problem: string,
): Promise<AnalysisResult> {
  // Reuse the full analyzer but with a no-op app
  // For simplicity, call analyzeProblem with a mock thread and forward result
  const { GitManager, createAgent } = await import("@orbit/core");
  const git = new GitManager(config.projectFolder);
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  const baseBranch = config.baseBranch || "staging";
  const { basename } = await import("node:path");

  // Step 1: Pull
  const repos = await git.discoverRepos();
  const syncedRepos: string[] = [];
  for (const repo of repos) {
    try {
      await git.pullFromBase(repo, baseBranch);
      syncedRepos.push(basename(repo));
    } catch {}
  }
  if (syncedRepos.length === 0) {
    throw new Error(`No repos found with "${baseBranch}" branch in ${config.projectFolder}`);
  }

  // Step 2: Scan codebase
  const scanResult = await claude.run(
    `Scan this workspace. For each repo: tech stack, key directories, patterns, recent commits.

Output concisely:
===CODEBASE_CONTEXT===
<summary>
===END_CONTEXT===`,
    config.projectFolder,
  );
  const codebaseContext = extractBetween(scanResult.output, "===CODEBASE_CONTEXT===", "===END_CONTEXT===")
    || scanResult.output.slice(0, 3000);

  // Step 3: Prepare spec
  const specResult = await claude.run(
    `You are a senior architect. Create an implementation spec for this problem.

PROBLEM: ${problem}
CODEBASE CONTEXT: ${codebaseContext}
WORKSPACE: ${config.projectFolder}
REPOS: ${syncedRepos.join(", ")}

Analyze the codebase, find exact files that need changes. Read files before referencing.

===SPEC===
## Problem Summary
## Affected Files
## Implementation Plan
===END_SPEC===`,
    config.projectFolder,
  );
  const spec = extractBetween(specResult.output, "===SPEC===", "===END_SPEC===")
    || specResult.output.slice(0, 4000);

  // Step 4: Classify
  const classifyResult = await claude.run(
    `Break this task into minimum Linear tickets.

PROBLEM: ${problem}
SPEC: ${spec}
CODEBASE: ${codebaseContext}

===CLASSIFICATION===
{
  "type": "bug_fix|new_feature|refactor|config_change|multi_service",
  "complexity": "small|medium|large",
  "ticketCount": N,
  "sequential": bool,
  "tickets": [
    {"key":"T1","title":"...","description":"...","priority":2,"labels":[],"dependsOn":[]}
  ]
}
===END_CLASSIFICATION===`,
    config.projectFolder,
  );

  const classifyJson = extractBetween(classifyResult.output, "===CLASSIFICATION===", "===END_CLASSIFICATION===");
  const fallbackTicket = { key: "T1", title: problem.slice(0, 80), description: problem, priority: 2, labels: [] as string[], dependsOn: [] as string[] };
  let classification: AnalysisResult["classification"] = {
    type: "new_feature", complexity: "small", ticketCount: 1, sequential: false, tickets: [fallbackTicket],
  };

  try {
    const parsed = JSON.parse(classifyJson || "{}");
    const tickets = Array.isArray(parsed.tickets)
      ? parsed.tickets.map((t: Record<string, unknown>, i: number) => ({
          key: (t.key as string) || `T${i + 1}`,
          title: (t.title as string) || "",
          description: (t.description as string) || "",
          priority: (t.priority as number) || 2,
          labels: Array.isArray(t.labels) ? t.labels as string[] : [],
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn as string[] : [],
        }))
      : [fallbackTicket];

    classification = {
      type: parsed.type || "new_feature",
      complexity: parsed.complexity || "small",
      ticketCount: parsed.ticketCount || tickets.length,
      sequential: parsed.sequential ?? false,
      tickets,
    };
  } catch {}

  return {
    syncedRepos,
    codebaseContext,
    spec,
    analysis: { approved: true, questions: [] },
    classification,
  };
}

/**
 * Create Linear tickets and start pipeline.
 * Posts minimal updates — just the done summary at the end.
 */
export async function createAndProcessTickets(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
  analysis: AnalysisResult,
  poster?: Poster,
  contextFolder?: string,
) {
  if (thread.clarifyTimer) {
    clearTimeout(thread.clarifyTimer);
    thread.clarifyTimer = undefined;
  }

  const { channelId, threadTs } = thread;
  thread.phase = "planning";
  saveThread(thread).catch(() => {});

  const ticketDefs = analysis.classification.tickets;
  const linear = new LinearClient(config.linearApiKey);

  // Resolve team
  let resolvedTeamId: string | undefined;
  if (config.linearTeamId) {
    const teams = await linear.getTeams();
    const team = teams.find((t) => t.id === config.linearTeamId || t.key === config.linearTeamId);
    resolvedTeamId = team?.id;
  }
  if (!resolvedTeamId) {
    const teams = await linear.getTeams();
    if (teams.length > 0) resolvedTeamId = teams[0].id;
  }
  if (!resolvedTeamId) throw new Error("No Linear team found.");

  // Resolve labels
  const existingLabels = await linear.getLabels(resolvedTeamId);
  const labelCache = new Map<string, string>();
  for (const l of existingLabels) labelCache.set(l.name.toLowerCase(), l.id);

  async function resolveLabelIds(labelNames: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of labelNames) {
      const key = name.toLowerCase();
      if (labelCache.has(key)) {
        ids.push(labelCache.get(key)!);
      } else {
        try {
          const created = await linear.createLabel(resolvedTeamId!, name);
          labelCache.set(key, created.id);
          ids.push(created.id);
        } catch {}
      }
    }
    return ids;
  }

  // Create tickets
  const assigneeId = config.assigneeId || (await linear.getMyId());
  const createdTickets: typeof thread.tickets = [];
  const keyToId = new Map<string, string>();

  for (const ticketDef of ticketDefs) {
    try {
      const labelIds = await resolveLabelIds(ticketDef.labels);
      const created = await linear.createIssue({
        teamId: resolvedTeamId,
        title: ticketDef.title,
        description: ticketDef.description,
        priority: ticketDef.priority,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        assigneeId,
      });

      keyToId.set(ticketDef.key, created.id);
      createdTickets.push({
        id: created.id,
        identifier: created.identifier,
        title: ticketDef.title,
        description: ticketDef.description,
        url: created.url,
        state: { id: "", name: "Backlog", type: "backlog" },
        priority: ticketDef.priority,
        labels: ticketDef.labels.map((n) => ({ id: labelCache.get(n.toLowerCase()) || "", name: n })),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      thread.errors.push(`Failed to create ticket "${ticketDef.title}": ${errorMsg}`);
    }
  }

  if (createdTickets.length === 0) {
    thread.phase = "error";
    thread.errors.push("Failed to create any Linear tickets");
    saveThread(thread).catch(() => {});
    return;
  }

  // Create dependency relations
  for (const ticketDef of ticketDefs) {
    const issueId = keyToId.get(ticketDef.key);
    if (!issueId) continue;
    for (const depKey of ticketDef.dependsOn) {
      const depId = keyToId.get(depKey);
      if (depId) {
        try { await linear.addIssueRelation(depId, issueId, "blocks"); } catch {}
      }
    }
  }

  // Build execution order
  const batches = buildExecutionOrder(ticketDefs);
  const orderedQueue = flattenToQueue(batches);
  const orderedTickets = orderedQueue
    .map((def) => createdTickets.find((t) => keyToId.get(def.key) === t.id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  thread.tickets = orderedTickets;
  saveThread(thread).catch(() => {});

  // Execute silently — runner posts the done summary
  runPipeline(app, thread, config, poster, contextFolder).catch((err) => {
    console.error("Pipeline runner error:", err);
  });
}

/** Reusable clarify phase entry */
export async function enterClarifyPhase(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
  botConfig: BotConfig,
) {
  const analysis = thread.analysisResult!;
  const { channelId, threadTs } = thread;

  thread.phase = "clarifying";
  thread.clarifyRound++;
  thread.pendingQuestions = analysis.analysis.questions;
  thread.answers = [];

  const questionList = analysis.analysis.questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `Quick question before I start:\n\n${questionList}`,
  });

  // Timeout — proceed with assumptions
  thread.clarifyTimer = setTimeout(async () => {
    if (thread.phase !== "clarifying") return;
    const unanswered = (thread.pendingQuestions || []).slice(thread.answers?.length || 0);
    if (unanswered.length > 0) {
      await generateAssumptions(app, thread, config, unanswered);
    }
    try {
      await createAndProcessTickets(app, thread, config, thread.analysisResult!, undefined, botConfig.contextFolder);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      thread.phase = "error";
      thread.errors.push(errorMsg);
    }
  }, botConfig.clarifyTimeoutMinutes * 60 * 1000);
}

function extractBetween(text: string, start: string, end: string): string {
  const startIdx = text.indexOf(start);
  if (startIdx === -1) return "";
  const afterStart = text.slice(startIdx + start.length);
  const endIdx = afterStart.indexOf(end);
  if (endIdx === -1) return afterStart.trim();
  return afterStart.slice(0, endIdx).trim();
}
