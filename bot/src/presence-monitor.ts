import type { App } from "@slack/bolt";
import type { BotConfig } from "./config.js";
import { getInteractionsSince, formatCatchUp } from "./interaction-log.js";


/**
 * Owner presence state — tracks whether the owner user is active or away.
 * When the owner goes away, the bot automatically takes over and handles
 * all @mentions autonomously. When the owner comes back, the bot posts
 * a catch-up summary and steps back.
 */

type PresenceStatus = "active" | "away";

interface PresenceState {
  status: PresenceStatus;
  /** When the current status was first detected */
  since: Date;
  /** Whether we've already posted a catch-up summary for this return */
  catchUpPosted: boolean;
}

let currentState: PresenceState = {
  status: "active",
  since: new Date(),
  catchUpPosted: false,
};

let pollTimer: NodeJS.Timeout | null = null;

/**
 * Check if the owner is currently away.
 * Used by the mention handler to decide whether to auto-handle messages.
 */
export function isOwnerAway(): boolean {
  return currentState.status === "away";
}

/**
 * Get the timestamp when the owner went away (for catch-up summaries).
 */
export function getAwaySince(): Date | null {
  return currentState.status === "away" ? currentState.since : null;
}

/**
 * Get current presence state (for debugging / status commands).
 */
export function getPresenceState(): { status: PresenceStatus; since: string } {
  return {
    status: currentState.status,
    since: currentState.since.toISOString(),
  };
}

/**
 * Poll Slack for the owner's presence status.
 * Uses users.getPresence API.
 */
async function checkPresence(
  app: App,
  botConfig: BotConfig,
): Promise<PresenceStatus> {
  try {
    const result = await app.client.users.getPresence({
      user: botConfig.ownerUserId,
    });

    // Slack returns "active" or "away"
    return result.presence === "active" ? "active" : "away";
  } catch (err) {
    console.error("Presence check failed:", err);
    // On error, assume no change
    return currentState.status;
  }
}

/**
 * Handle a status transition.
 */
async function handleTransition(
  app: App,
  botConfig: BotConfig,
  oldStatus: PresenceStatus,
  newStatus: PresenceStatus,
): Promise<void> {
  if (oldStatus === "active" && newStatus === "away") {
    // Owner just went away — bot takes over
    console.log("Owner went away — autonomous mode activated");

    currentState = {
      status: "away",
      since: new Date(),
      catchUpPosted: false,
    };

  } else if (oldStatus === "away" && newStatus === "active") {
    // Owner came back — post catch-up and step back
    console.log("Owner came back — autonomous mode deactivated");

    const awaySince = currentState.since;
    currentState = {
      status: "active",
      since: new Date(),
      catchUpPosted: false,
    };

    // Post catch-up summary via DM
    await postCatchUp(app, botConfig, awaySince);
  }
}



/**
 * Post a catch-up summary of what happened while the owner was away.
 */
async function postCatchUp(
  app: App,
  botConfig: BotConfig,
  awaySince: Date,
): Promise<void> {
  if (currentState.catchUpPosted) return;
  currentState.catchUpPosted = true;

  try {
    const interactions = await getInteractionsSince(awaySince);
    if (interactions.length === 0) return; // Nothing happened

    const summary = formatCatchUp(interactions);
    const header = `:wave: Welcome back! Here's what I handled while you were away:\n\n${summary}`;

    // Post to DM with the owner
    try {
      // Open a DM channel with the owner
      const dm = await app.client.conversations.open({
        users: botConfig.ownerUserId,
      });

      if (dm.channel?.id) {
        await app.client.chat.postMessage({
          token: botConfig.slack.userToken || undefined,
          channel: dm.channel.id,
          text: header,
        });
      }
    } catch (dmErr) {
      // Fallback: post to standup channel if DM fails
      if (botConfig.standupChannelId) {
        await app.client.chat.postMessage({
          channel: botConfig.standupChannelId,
          text: header,
        });
      }
      console.error("DM catch-up failed, used channel fallback:", dmErr);
    }
  } catch (err) {
    console.error("Catch-up summary failed:", err);
  }
}

/**
 * Start polling Slack for the owner's presence status.
 * Runs every N seconds (default: 60s).
 */
export function startPresenceMonitor(
  app: App,
  botConfig: BotConfig,
): void {
  if (!botConfig.ownerUserId) {
    console.log("Presence monitor disabled — no OWNER_USER_ID configured");
    return;
  }

  if (!botConfig.awayModeEnabled) {
    console.log("Away mode disabled — set AWAY_MODE_ENABLED=true to enable");
    return;
  }

  const intervalMs = botConfig.presencePollSeconds * 1000;

  // Initial check
  pollOnce(app, botConfig);

  // Poll on interval
  pollTimer = setInterval(() => {
    pollOnce(app, botConfig);
  }, intervalMs);

  console.log(
    `Presence monitor started — polling every ${botConfig.presencePollSeconds}s for <@${botConfig.ownerUserId}> status`,
  );
}

async function pollOnce(app: App, botConfig: BotConfig): Promise<void> {
  try {
    const newStatus = await checkPresence(app, botConfig);
    const oldStatus = currentState.status;

    if (oldStatus !== newStatus) {
      await handleTransition(app, botConfig, oldStatus, newStatus);
    }
  } catch (err) {
    console.error("Presence poll error:", err);
  }
}

/**
 * Stop the presence monitor.
 */
export function stopPresenceMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
