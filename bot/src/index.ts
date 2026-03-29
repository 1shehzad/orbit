import "dotenv/config";
import { App } from "@slack/bolt";
import { loadConfig } from "./config.js";
import { registerMentionHandler } from "./handlers/mention.js";
import { registerMessageHandler } from "./handlers/message.js";
import { registerCommands } from "./handlers/commands.js";
import { initPersistence, loadPersistedThreads } from "./threads.js";
import { initProjectStore, resolveProjectConfig } from "./projects.js";
import { initUserStore, mergeUserConfig } from "./users.js";
import { runPipeline } from "./runner.js";
import { startStandupScheduler } from "./standup.js";
import { createPoster } from "./post.js";
import { startActivityMonitor } from "./monitor.js";
import { initInteractionLog } from "./interaction-log.js";
import { initScheduler, startScheduledTimers } from "./scheduler.js";
import { startPresenceMonitor } from "./presence-monitor.js";

async function main() {
  const config = loadConfig();

  // Initialize persistence, project store, and user store
  await initPersistence(config.dataDir);
  await initProjectStore(config.dataDir, config.project);
  await initUserStore(config.dataDir);
  await initInteractionLog(config.dataDir);
  await initScheduler(config.dataDir);

  const app = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    appToken: config.slack.appToken,
  });

  // Create poster (posts as user when user token is set)
  const poster = createPoster(app, config);
  if (poster.isUserMode) {
    console.log("User token set — responses will appear as you");
  } else {
    console.log("No user token — responses will appear as the bot");
  }

  // Register handlers
  registerMentionHandler(app, config.project, config, poster);
  registerMessageHandler(app, config.project, config, poster);
  registerCommands(app, config.project, config);

  await app.start(config.port);
  console.log(`Orbit bot running on port ${config.port} (socket mode)`);

  // Start auto-standup scheduler
  startStandupScheduler(app, config);

  // Start activity monitor (tracks git activity across all workspaces)
  startActivityMonitor(config);

  // Start presence monitor (detects when owner goes away → bot takes over)
  startPresenceMonitor(app, config);

  // Resume scheduled tasks from disk
  const scheduledCount = startScheduledTimers(async (task) => {
    try {
      const taskConfig = mergeUserConfig(resolveProjectConfig(task.channelId), task.userId);
      await app.client.chat.postMessage({
        token: config.slack.userToken || undefined,
        channel: task.channelId,
        thread_ts: task.threadTs,
        text: "Starting on the scheduled task now.",
      });
      // The actual execution is handled by the scheduler callback set during scheduleTask
    } catch (err) {
      console.error("Scheduled task resume error:", err);
    }
  });
  if (scheduledCount > 0) {
    console.log(`Resumed ${scheduledCount} scheduled task(s)`);
  }

  // Auto-resume interrupted sessions
  const interrupted = await loadPersistedThreads();
  const resumable = interrupted.filter(
    (t) => t.phase === "executing" && t.tickets.length > 0,
  );

  if (resumable.length > 0) {
    console.log(`Found ${resumable.length} interrupted session(s), resuming...`);
    for (const thread of resumable) {
      try {
        const projectConfig = resolveProjectConfig(thread.channelId);
        const userConfig = mergeUserConfig(projectConfig, thread.userId);
        await app.client.chat.postMessage({
          channel: thread.channelId,
          thread_ts: thread.threadTs,
          text: `:arrows_counterclockwise: Bot restarted — resuming session (${thread.completedTicketIds.size}/${thread.tickets.length} tickets done).`,
        });

        runPipeline(app, thread, userConfig).catch((err) => {
          console.error("Auto-resume pipeline error:", err);
        });
      } catch (err) {
        console.error("Failed to auto-resume thread:", err);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
