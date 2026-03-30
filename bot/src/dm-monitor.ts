import type { App } from "@slack/bolt";
import type { BotConfig } from "./config.js";
import { isOwnerAway } from "./presence-monitor.js";
import { classifyMessage } from "./classifier.js";
import { respondToQuery } from "./responder.js";
import { answerCodeQuestion } from "./codeqa.js";
import { resolveProjectConfig } from "./projects.js";
import { mergeUserConfig } from "./users.js";
import { logInteraction } from "./interaction-log.js";
import { resolveProjectFromMessage } from "./project-resolver.js";

/**
 * DM Monitor — polls the owner's personal DMs using the user token.
 * When the owner is away, automatically responds to incoming DMs
 * using context files, making it look like the owner replied.
 *
 * This uses conversations.list (types=im) + conversations.history
 * with the user token (xoxp-...) to read the owner's actual DMs.
 */

let pollTimer: NodeJS.Timeout | null = null;
let lastCheckedTs: string = (Date.now() / 1000).toFixed(6);

// Track DM channels we've already seen to avoid re-processing
const processedMessages = new Set<string>();
// Cap the set size to prevent memory leaks
const MAX_PROCESSED = 5000;

/**
 * Start polling the owner's DMs.
 */
export function startDMMonitor(app: App, botConfig: BotConfig): void {
  if (!botConfig.slack.userToken) {
    console.log("DM monitor disabled — no SLACK_USER_TOKEN configured");
    return;
  }

  if (!botConfig.awayModeEnabled) {
    console.log("DM monitor disabled — AWAY_MODE_ENABLED is not true");
    return;
  }

  if (!botConfig.ownerUserId) {
    console.log("DM monitor disabled — no OWNER_USER_ID configured");
    return;
  }

  // Set initial timestamp to now (don't process old messages)
  lastCheckedTs = (Date.now() / 1000).toFixed(6);

  const intervalMs = (botConfig.dmPollSeconds ?? 30) * 1000;

  // Poll on interval
  pollTimer = setInterval(() => {
    pollDMs(app, botConfig).catch((err) => {
      console.error("DM poll error:", err);
    });
  }, intervalMs);

  console.log(`DM monitor started — polling every ${botConfig.dmPollSeconds ?? 30}s for incoming DMs`);
}

/**
 * Stop the DM monitor.
 */
export function stopDMMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Poll for new DMs sent to the owner.
 */
async function pollDMs(app: App, botConfig: BotConfig): Promise<void> {
  // Only respond when owner is away
  if (!isOwnerAway() && !process.env.TEST_MODE) return;

  const userToken = botConfig.slack.userToken;
  if (!userToken) return;

  try {
    // Get all DM conversations for the owner
    const convos = await app.client.conversations.list({
      token: userToken,
      types: "im",
      limit: 50,
    });

    const dmChannels = convos.channels ?? [];

    for (const channel of dmChannels) {
      if (!channel.id) continue;

      // Skip DMs with the bot itself
      if (channel.user === botConfig.ownerUserId) continue;

      // Fetch new messages since last check
      try {
        const history = await app.client.conversations.history({
          token: userToken,
          channel: channel.id,
          oldest: lastCheckedTs,
          limit: 10,
        });

        const messages = history.messages ?? [];

        for (const msg of messages) {
          // Skip messages from the owner (we only want incoming messages from others)
          if (msg.user === botConfig.ownerUserId) continue;
          // Skip bot messages
          if (msg.bot_id) continue;
          // Skip already processed
          if (!msg.ts || processedMessages.has(msg.ts)) continue;
          // Skip messages without text
          if (!msg.text?.trim()) continue;

          processedMessages.add(msg.ts);

          // Handle this DM
          await handleIncomingDM(app, botConfig, channel.id, msg.user || "unknown", msg.text.trim(), msg.ts);
        }
      } catch (err) {
        // conversations.history can fail for archived/closed DMs — skip
      }
    }

    // Update timestamp for next poll
    lastCheckedTs = (Date.now() / 1000).toFixed(6);

    // Trim processed messages set
    if (processedMessages.size > MAX_PROCESSED) {
      const toDelete = [...processedMessages].slice(0, processedMessages.size - MAX_PROCESSED);
      for (const ts of toDelete) processedMessages.delete(ts);
    }
  } catch (err) {
    console.error("DM poll conversations.list error:", err);
  }
}

/**
 * Handle an incoming DM — classify and respond.
 */
async function handleIncomingDM(
  app: App,
  botConfig: BotConfig,
  channelId: string,
  senderId: string,
  text: string,
  messageTs: string,
): Promise<void> {
  const userToken = botConfig.slack.userToken;

  // Get sender info for logging
  let senderName = senderId;
  try {
    const userInfo = await app.client.users.info({ user: senderId });
    senderName = userInfo.user?.real_name || userInfo.user?.name || senderId;
  } catch {}

  console.log(`DM from ${senderName}: "${text.slice(0, 80)}"`);

  // Resolve config
  const channelConfig = resolveProjectConfig(channelId);
  const config = mergeUserConfig(channelConfig, botConfig.ownerUserId);

  // Reply function — posts as the owner using user token
  const reply = async (responseText: string) => {
    await app.client.chat.postMessage({
      token: userToken,
      channel: channelId,
      text: responseText,
    });
  };

  try {
    // Classify the message
    const classification = await classifyMessage(text, config.anthropicApiKey, config.aiProvider);

    if (classification.type === "query") {
      const response = await respondToQuery(text, botConfig.contextFolder, config.anthropicApiKey, config.aiProvider);
      await reply(response);
      logInteraction({
        timestamp: new Date().toISOString(),
        userId: senderId,
        userName: senderName,
        channelId,
        type: "query",
        message: text,
        summary: `[DM] ${response.slice(0, 150)}`,
      }).catch(() => {});
      return;
    }

    if (classification.type === "code_query") {
      const response = await answerCodeQuestion(text, config, botConfig.contextFolder, botConfig.workspaceRoots);
      await reply(response);
      logInteraction({
        timestamp: new Date().toISOString(),
        userId: senderId,
        userName: senderName,
        channelId,
        type: "code_query",
        message: text,
        summary: `[DM] ${response.slice(0, 150)}`,
      }).catch(() => {});
      return;
    }

    // For tasks in DMs, acknowledge and explain the limitation
    await reply(
      `Got it, I'll look into this. Since this is a DM, I'll handle it as a query for now. ` +
      `For full task execution (tickets, PRs), mention me in a channel.`
    );

    // Still try to answer as a query
    const response = await respondToQuery(text, botConfig.contextFolder, config.anthropicApiKey, config.aiProvider);
    await reply(response);

    logInteraction({
      timestamp: new Date().toISOString(),
      userId: senderId,
      userName: senderName,
      channelId,
      type: "query",
      message: text,
      summary: `[DM] ${response.slice(0, 150)}`,
    }).catch(() => {});
  } catch (err) {
    console.error(`DM response error for ${senderName}:`, err);
    await reply("Let me check on that and get back to you.").catch(() => {});
  }
}
