import type { App } from "@slack/bolt";
import type { BotConfig } from "./config.js";
import { isOwnerAway } from "./presence-monitor.js";
import { classifyMessage } from "./classifier.js";
import { respondToQuery } from "./responder.js";
import { answerCodeQuestion } from "./codeqa.js";
import { resolveProjectConfig } from "./projects.js";
import { mergeUserConfig } from "./users.js";
import { logInteraction } from "./interaction-log.js";

/**
 * DM Monitor — polls the owner's personal DMs using the user token.
 * When the owner is away, automatically responds to incoming DMs
 * using context files, making it look like the owner replied.
 *
 * Efficient polling strategy:
 * - Only polls conversations.list once per cycle (1 API call)
 * - Only calls conversations.history on channels with NEW messages (checks updated timestamp)
 * - Typically 1-3 API calls per cycle instead of 50+
 */

let pollTimer: NodeJS.Timeout | null = null;
let lastPollTime = Date.now();

// Track which DM channels we last checked and their latest message ts
const channelLastSeen = new Map<string, number>();

// Track processed message ts to avoid double-responding
const processedMessages = new Set<string>();
const MAX_PROCESSED = 2000;

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

  lastPollTime = Date.now();

  const intervalMs = (botConfig.dmPollSeconds ?? 30) * 1000;

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
 * Efficient: only fetches history for channels with new activity.
 */
async function pollDMs(app: App, botConfig: BotConfig): Promise<void> {
  // Only respond when owner is away
  if (!isOwnerAway() && !process.env.TEST_MODE) return;

  const userToken = botConfig.slack.userToken;
  if (!userToken) return;

  try {
    // Single API call: get all DM conversations with updated timestamps
    const convos = await app.client.conversations.list({
      token: userToken,
      types: "im",
      limit: 100,
      exclude_archived: true,
    });

    const dmChannels = convos.channels ?? [];
    const pollStartTime = lastPollTime;
    lastPollTime = Date.now();

    for (const channel of dmChannels) {
      if (!channel.id) continue;
      // Skip DMs with yourself
      if (channel.user === botConfig.ownerUserId) continue;

      // Check if this channel has new activity since we last checked
      // conversations.list returns `updated` timestamp (epoch seconds)
      const updatedTs = (channel as Record<string, unknown>).updated as number | undefined;
      const lastSeen = channelLastSeen.get(channel.id) || 0;

      if (updatedTs && updatedTs * 1000 <= lastSeen) {
        // No new activity in this channel — skip
        continue;
      }

      // This channel has new activity — fetch recent messages
      try {
        const oldest = (pollStartTime / 1000).toFixed(6);
        const history = await app.client.conversations.history({
          token: userToken,
          channel: channel.id,
          oldest,
          limit: 5,
        });

        const messages = history.messages ?? [];

        for (const msg of messages) {
          // Skip messages from the owner
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
      } catch {
        // conversations.history can fail for closed DMs — skip silently
      }

      // Mark this channel as checked
      channelLastSeen.set(channel.id, Date.now());
    }

    // Trim processed messages set
    if (processedMessages.size > MAX_PROCESSED) {
      const entries = [...processedMessages];
      for (const ts of entries.slice(0, processedMessages.size - MAX_PROCESSED)) {
        processedMessages.delete(ts);
      }
    }
  } catch (err) {
    // Log but don't spam — rate limit errors are handled by Bolt's retry
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes("rate_limited") && !errMsg.includes("ratelimited")) {
      console.error("DM poll error:", errMsg);
    }
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
  _messageTs: string,
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

    // For tasks in DMs, respond as a query since we can't run full pipeline in a DM thread
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
