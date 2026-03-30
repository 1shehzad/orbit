import { join } from "node:path";
import type { ProjectConfig } from "@orbit/core";

export interface BotConfig {
  slack: {
    botToken: string;
    signingSecret: string;
    appToken: string;
    /** User OAuth token (xoxp-...) — posts as the user, not the bot */
    userToken: string;
  };
  project: ProjectConfig;
  port: number;
  /** Minutes to wait for clarification answers before auto-proceeding (default: 10) */
  clarifyTimeoutMinutes: number;
  /** Max clarification rounds before forcing proceed (default: 3) */
  maxClarifyRounds: number;
  /** Directory to persist thread state for resume (default: .orbit-data) */
  dataDir: string;
  /** Max QA auto-fix retries (default: 3) */
  maxQARetries: number;
  /** Allowed Slack user IDs (empty = allow all) */
  allowedUserIds: string[];
  /** The Slack user ID whose mentions the bot monitors (owner mode) */
  ownerUserId: string;
  /** Folder containing .md context files for query responses */
  contextFolder: string;
  /** Slack channel ID for standup posts */
  standupChannelId: string;
  /** Time to post standup (HH:MM, 24hr format, default 09:00) */
  standupTime: string;
  /** Workspace roots — scans all git repos under these paths (comma-separated) */
  workspaceRoots: string[];
  /** Activity monitor interval in minutes (default: 5) */
  monitorIntervalMinutes: number;
  /** Enable screenshot capture in activity monitor */
  screenshotsEnabled: boolean;
  /** Days to keep screenshots before cleanup (default: 7) */
  screenshotRetentionDays: number;
  /** Days of JSONL data to use for ROLE.md and SKILL.md generation (default: 7) */
  activityContextDays: number;
  /** Enable away mode — bot auto-handles when owner goes away on Slack */
  awayModeEnabled: boolean;
  /** Seconds between Slack presence polls (default: 60) */
  presencePollSeconds: number;
  /** Seconds between DM polls when owner is away (default: 30) */
  dmPollSeconds: number;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadConfig(): BotConfig {
  return {
    slack: {
      botToken: requireEnv("SLACK_BOT_TOKEN"),
      signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
      appToken: requireEnv("SLACK_APP_TOKEN"),
      userToken: process.env.SLACK_USER_TOKEN || "",
    },
    project: {
      linearApiKey: requireEnv("LINEAR_API_KEY"),
      linearTeamId: process.env.LINEAR_TEAM_ID || undefined,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
      projectFolder: process.env.PROJECT_FOLDER || process.env.WORKSPACE_ROOTS?.split(",")[0]?.trim() || process.cwd(),
      baseBranch: process.env.BASE_BRANCH || "staging",
      aiProvider: (process.env.AI_PROVIDER as "claude" | "codex" | undefined) || "claude",
    },
    port: parseInt(process.env.PORT || "3000", 10),
    clarifyTimeoutMinutes: parseInt(process.env.CLARIFY_TIMEOUT_MINUTES || "10", 10),
    maxClarifyRounds: parseInt(process.env.MAX_CLARIFY_ROUNDS || "3", 10),
    dataDir: process.env.ORBIT_DATA_DIR || ".orbit-data",
    maxQARetries: parseInt(process.env.MAX_QA_RETRIES || "3", 10),
    allowedUserIds: process.env.ALLOWED_USER_IDS
      ? process.env.ALLOWED_USER_IDS.split(",").map((id) => id.trim())
      : [],
    ownerUserId: process.env.OWNER_USER_ID || "",
    contextFolder: process.env.CONTEXT_FOLDER || join(process.env.HOME || "~", ".orbit-context"),
    standupChannelId: process.env.STANDUP_CHANNEL_ID || "",
    standupTime: process.env.STANDUP_TIME || "09:00",
    workspaceRoots: (process.env.WORKSPACE_ROOTS || process.env.PROJECT_FOLDER || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
    monitorIntervalMinutes: parseInt(process.env.MONITOR_INTERVAL_MINUTES || "5", 10),
    screenshotsEnabled: process.env.SCREENSHOTS_ENABLED === "true",
    screenshotRetentionDays: parseInt(process.env.SCREENSHOT_RETENTION_DAYS || "7", 10),
    activityContextDays: parseInt(process.env.ACTIVITY_CONTEXT_DAYS || "7", 10),
    awayModeEnabled: process.env.AWAY_MODE_ENABLED === "true",
    presencePollSeconds: parseInt(process.env.PRESENCE_POLL_SECONDS || "60", 10),
    dmPollSeconds: parseInt(process.env.DM_POLL_SECONDS || "30", 10),
  };
}
