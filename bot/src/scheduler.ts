import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface ScheduledTask {
  id: string;
  /** Original message text */
  message: string;
  /** Who sent it */
  userId: string;
  /** Channel to respond in */
  channelId: string;
  /** Thread to respond in */
  threadTs: string;
  /** When to execute (ISO string) */
  executeAt: string;
  /** Has it been executed? */
  executed: boolean;
  /** Created at */
  createdAt: string;
}

let dataDir: string | null = null;
const tasks: ScheduledTask[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Initialize the scheduler — load pending tasks from disk.
 */
export async function initScheduler(dir: string): Promise<void> {
  dataDir = join(dir, "scheduled");
  await mkdir(dataDir, { recursive: true });

  try {
    const files = await readdir(dataDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dataDir, file), "utf-8");
        const task: ScheduledTask = JSON.parse(raw);
        if (!task.executed) {
          tasks.push(task);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Schedule a task for later execution.
 * Returns the scheduled time for confirmation.
 */
export async function scheduleTask(
  message: string,
  userId: string,
  channelId: string,
  threadTs: string,
  executeAt: Date,
  onExecute: (task: ScheduledTask) => Promise<void>,
): Promise<ScheduledTask> {
  const task: ScheduledTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    message,
    userId,
    channelId,
    threadTs,
    executeAt: executeAt.toISOString(),
    executed: false,
    createdAt: new Date().toISOString(),
  };

  tasks.push(task);
  await persistTask(task);
  setTimer(task, onExecute);

  return task;
}

/**
 * Start timers for all pending tasks.
 * Call after initScheduler and after the bot is ready.
 */
export function startScheduledTimers(
  onExecute: (task: ScheduledTask) => Promise<void>,
): number {
  let count = 0;
  for (const task of tasks) {
    if (!task.executed) {
      setTimer(task, onExecute);
      count++;
    }
  }
  return count;
}

/**
 * Get all pending (not yet executed) tasks.
 */
export function getPendingTasks(): ScheduledTask[] {
  return tasks.filter((t) => !t.executed);
}

/**
 * Cancel a scheduled task by ID.
 */
export async function cancelTask(taskId: string): Promise<boolean> {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.executed) return false;

  task.executed = true;
  const timer = timers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(taskId);
  }

  await persistTask(task);
  return true;
}

function setTimer(
  task: ScheduledTask,
  onExecute: (task: ScheduledTask) => Promise<void>,
): void {
  const delay = new Date(task.executeAt).getTime() - Date.now();

  if (delay <= 0) {
    // Already past — execute immediately
    markExecuted(task);
    onExecute(task).catch((err) => console.error("Scheduled task error:", err));
    return;
  }

  const timer = setTimeout(async () => {
    timers.delete(task.id);
    markExecuted(task);
    try {
      await onExecute(task);
    } catch (err) {
      console.error("Scheduled task error:", err);
    }
  }, delay);

  timers.set(task.id, timer);
}

async function markExecuted(task: ScheduledTask): Promise<void> {
  task.executed = true;
  await persistTask(task);
}

async function persistTask(task: ScheduledTask): Promise<void> {
  if (!dataDir) return;
  const filePath = join(dataDir, `${task.id}.json`);
  try {
    if (task.executed) {
      // Clean up executed tasks from disk
      await unlink(filePath).catch(() => {});
    } else {
      await writeFile(filePath, JSON.stringify(task, null, 2));
    }
  } catch {}
}

/**
 * Parse a time reference from natural language.
 * Returns a Date or null if not parseable.
 *
 * Supports:
 * - "tomorrow morning" → next day 9:00
 * - "tomorrow at 2pm" → next day 14:00
 * - "in 2 hours" → now + 2h
 * - "in 30 minutes" → now + 30m
 * - "at 3pm" → today/tomorrow 15:00
 * - "monday morning" → next Monday 9:00
 */
export function parseScheduleTime(text: string): Date | null {
  const now = new Date();
  const lower = text.toLowerCase();

  // "in X hours/minutes"
  const inMatch = lower.match(/in\s+(\d+)\s*(hours?|h|minutes?|mins?|m)\b/);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const unit = inMatch[2].startsWith("h") ? "hours" : "minutes";
    const ms = unit === "hours" ? amount * 60 * 60 * 1000 : amount * 60 * 1000;
    return new Date(now.getTime() + ms);
  }

  // "at Xpm/am"
  const atMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  let hours: number | null = null;
  let minutes = 0;

  if (atMatch) {
    hours = parseInt(atMatch[1], 10);
    minutes = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    if (atMatch[3] === "pm" && hours < 12) hours += 12;
    if (atMatch[3] === "am" && hours === 12) hours = 0;
  }

  // Day detection
  const isTomorrow = /tomorrow/.test(lower);
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayMatch = dayNames.findIndex((d) => lower.includes(d));

  // "morning" / "afternoon" / "evening"
  if (hours === null) {
    if (/morning/.test(lower)) hours = 9;
    else if (/afternoon/.test(lower)) hours = 14;
    else if (/evening/.test(lower)) hours = 18;
    else if (/night/.test(lower)) hours = 21;
  }

  if (hours === null) return null;

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  if (isTomorrow) {
    target.setDate(target.getDate() + 1);
  } else if (dayMatch >= 0) {
    const currentDay = now.getDay();
    let daysUntil = dayMatch - currentDay;
    if (daysUntil <= 0) daysUntil += 7;
    target.setDate(target.getDate() + daysUntil);
  } else if (target.getTime() <= now.getTime()) {
    // "at 3pm" but 3pm already passed today → tomorrow
    target.setDate(target.getDate() + 1);
  }

  return target;
}
