import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Interaction {
  timestamp: string;
  /** Slack user ID who triggered this */
  userId: string;
  /** Slack display name (if resolved) */
  userName?: string;
  /** Channel ID */
  channelId: string;
  /** What type of interaction */
  type: "query" | "code_query" | "task" | "review" | "feedback";
  /** The original message */
  message: string;
  /** Short summary of what the bot did */
  summary: string;
  /** Ticket identifiers created (if any) */
  tickets?: string[];
  /** PR URLs created (if any) */
  prs?: string[];
}

let dataDir: string | null = null;
const todayLog: Interaction[] = [];

/**
 * Initialize the interaction log.
 */
export async function initInteractionLog(dir: string): Promise<void> {
  dataDir = dir;
  await mkdir(dir, { recursive: true });

  // Load today's log from disk
  try {
    const today = new Date().toISOString().split("T")[0];
    const filePath = join(dir, `interactions-${today}.json`);
    const raw = await readFile(filePath, "utf-8");
    const loaded = JSON.parse(raw);
    if (Array.isArray(loaded)) {
      todayLog.push(...loaded);
    }
  } catch {
    // No log for today yet
  }
}

/**
 * Log an interaction.
 */
export async function logInteraction(interaction: Interaction): Promise<void> {
  todayLog.push(interaction);

  // Persist to disk (fire-and-forget)
  if (dataDir) {
    const today = new Date().toISOString().split("T")[0];
    const filePath = join(dataDir, `interactions-${today}.json`);
    try {
      await writeFile(filePath, JSON.stringify(todayLog, null, 2));
    } catch {}
  }
}

/**
 * Get interactions since a given time.
 * If no time given, returns today's interactions.
 */
export async function getInteractionsSince(since?: Date): Promise<Interaction[]> {
  if (!since) {
    return [...todayLog];
  }

  const sinceMs = since.getTime();

  // Today's interactions that are after `since`
  const filtered = todayLog.filter((i) => new Date(i.timestamp).getTime() > sinceMs);

  // If `since` is before today, also load yesterday's log
  const today = new Date().toISOString().split("T")[0];
  const sinceDate = since.toISOString().split("T")[0];

  if (sinceDate < today && dataDir) {
    try {
      const filePath = join(dataDir, `interactions-${sinceDate}.json`);
      const raw = await readFile(filePath, "utf-8");
      const loaded: Interaction[] = JSON.parse(raw);
      const older = loaded.filter((i) => new Date(i.timestamp).getTime() > sinceMs);
      return [...older, ...filtered];
    } catch {}
  }

  return filtered;
}

/**
 * Generate a catch-up summary of interactions since the given time.
 */
export function formatCatchUp(interactions: Interaction[]): string {
  if (interactions.length === 0) {
    return "Nothing happened while you were away. All quiet.";
  }

  const lines: string[] = ["While you were away:"];

  for (const i of interactions) {
    const who = i.userName || `<@${i.userId}>`;
    const time = new Date(i.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    switch (i.type) {
      case "query":
        lines.push(`• ${who} asked: "${i.message.slice(0, 80)}" — ${i.summary} _(${time})_`);
        break;
      case "code_query":
        lines.push(`• ${who} asked about the codebase: "${i.message.slice(0, 80)}" — ${i.summary} _(${time})_`);
        break;
      case "task": {
        const extras: string[] = [];
        if (i.tickets?.length) extras.push(`tickets: ${i.tickets.join(", ")}`);
        if (i.prs?.length) extras.push(`PRs: ${i.prs.join(", ")}`);
        const detail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
        lines.push(`• ${who} requested: "${i.message.slice(0, 80)}" — ${i.summary}${detail} _(${time})_`);
        break;
      }
      case "review":
        lines.push(`• ${who} asked for a PR review — ${i.summary} _(${time})_`);
        break;
      case "feedback":
        lines.push(`• ${who} left feedback: "${i.message.slice(0, 80)}" — ${i.summary} _(${time})_`);
        break;
    }
  }

  return lines.join("\n");
}
