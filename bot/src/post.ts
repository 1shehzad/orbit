import type { App } from "@slack/bolt";
import type { BotConfig } from "./config.js";

/**
 * Post a message as the user (using user token) or fall back to bot token.
 * When using user token, the message appears as if the user typed it.
 */
export function createPoster(app: App, botConfig: BotConfig) {
  const userToken = botConfig.slack.userToken;

  return {
    /**
     * Post a message in a channel/thread as the user.
     */
    async post(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
      const result = await app.client.chat.postMessage({
        token: userToken || undefined,
        channel,
        text,
        thread_ts: threadTs,
      });
      return result.ts;
    },

    /**
     * Update an existing message.
     */
    async update(channel: string, ts: string, text: string): Promise<void> {
      await app.client.chat.update({
        token: userToken || undefined,
        channel,
        ts,
        text,
      });
    },

    /** Whether we're posting as the user or the bot */
    isUserMode: !!userToken,
  };
}

export type Poster = ReturnType<typeof createPoster>;
