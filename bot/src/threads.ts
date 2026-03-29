import { mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LinearTicket, PRInfo } from "@orbit/core";
import type { AnalysisResult } from "./analyzer.js";

export type ThreadPhase =
  | "received"       // Problem just received
  | "analyzing"      // Scanning codebase, preparing specs
  | "clarifying"     // Waiting for user answers
  | "planning"       // Breaking into tickets
  | "executing"      // Processing tickets
  | "completed"      // All done
  | "error";

export interface ThreadState {
  /** Slack thread timestamp (used as thread ID) */
  threadTs: string;
  /** Channel where the thread lives */
  channelId: string;
  /** User who initiated the request */
  userId: string;
  /** Original problem description */
  problem: string;
  /** Current phase */
  phase: ThreadPhase;
  /** Timestamp of the bot's pinned status message (updated in-place) */
  statusMessageTs?: string;
  /** Generated spec (after analysis) */
  spec?: string;
  /** Full analysis result */
  analysisResult?: AnalysisResult;
  /** Clarifying questions pending answers */
  pendingQuestions?: string[];
  /** Answers received for clarifying questions */
  answers?: string[];
  /** Clarification round (for multi-round Q&A) */
  clarifyRound: number;
  /** Timeout handle for auto-proceeding */
  clarifyTimer?: ReturnType<typeof setTimeout>;
  /** Assumptions made when proceeding without full answers */
  assumptions: string[];
  /** Linear tickets created for this problem */
  tickets: LinearTicket[];
  /** Which tickets are done */
  completedTicketIds: Set<string>;
  /** PRs created for tickets */
  prs: PRInfo[];
  /** Staging URLs detected after deploy */
  stagingUrls: string[];
  /** Errors encountered */
  errors: string[];
  /** Created at */
  createdAt: Date;
}

/**
 * Serializable version of ThreadState for disk persistence.
 * Strips non-serializable fields (timer, Set → array).
 */
interface SerializedThread {
  threadTs: string;
  channelId: string;
  userId: string;
  problem: string;
  phase: ThreadPhase;
  statusMessageTs?: string;
  spec?: string;
  analysisResult?: AnalysisResult;
  pendingQuestions?: string[];
  answers?: string[];
  clarifyRound: number;
  assumptions: string[];
  tickets: LinearTicket[];
  completedTicketIds: string[];
  prs: PRInfo[];
  stagingUrls: string[];
  errors: string[];
  createdAt: string;
}

/**
 * In-memory thread state store.
 * Key: `${channelId}:${threadTs}`
 */
const threads = new Map<string, ThreadState>();

/** Data directory for persistence (set via initPersistence) */
let dataDir: string | null = null;

function key(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function threadFileName(channelId: string, threadTs: string): string {
  // Replace dots/colons with underscores for safe filenames
  return `thread_${channelId}_${threadTs.replace(/\./g, "_")}.json`;
}

/**
 * Initialize persistence — call once at startup.
 */
export async function initPersistence(dir: string): Promise<void> {
  dataDir = dir;
  await mkdir(dir, { recursive: true });
}

/**
 * Save a thread to disk (non-blocking, fire-and-forget).
 */
export async function saveThread(thread: ThreadState): Promise<void> {
  if (!dataDir) return;

  const serialized: SerializedThread = {
    threadTs: thread.threadTs,
    channelId: thread.channelId,
    userId: thread.userId,
    problem: thread.problem,
    phase: thread.phase,
    statusMessageTs: thread.statusMessageTs,
    spec: thread.spec,
    analysisResult: thread.analysisResult,
    pendingQuestions: thread.pendingQuestions,
    answers: thread.answers,
    clarifyRound: thread.clarifyRound,
    assumptions: thread.assumptions,
    tickets: thread.tickets,
    completedTicketIds: Array.from(thread.completedTicketIds),
    prs: thread.prs,
    stagingUrls: thread.stagingUrls,
    errors: thread.errors,
    createdAt: thread.createdAt.toISOString(),
  };

  const filePath = join(dataDir, threadFileName(thread.channelId, thread.threadTs));
  await writeFile(filePath, JSON.stringify(serialized, null, 2));
}

/**
 * Load all persisted threads from disk. Call at startup to restore state.
 * Only loads threads that were interrupted (not completed/error).
 */
export async function loadPersistedThreads(): Promise<ThreadState[]> {
  if (!dataDir) return [];

  const restored: ThreadState[] = [];
  try {
    const files = await readdir(dataDir);
    for (const file of files) {
      if (!file.startsWith("thread_") || !file.endsWith(".json")) continue;

      try {
        const raw = await readFile(join(dataDir, file), "utf-8");
        const data: SerializedThread = JSON.parse(raw);

        const thread: ThreadState = {
          ...data,
          completedTicketIds: new Set(data.completedTicketIds),
          prs: data.prs || [],
          stagingUrls: data.stagingUrls || [],
          createdAt: new Date(data.createdAt),
          clarifyTimer: undefined,
        };

        // Only restore threads that were actively processing
        if (thread.phase !== "completed" && thread.phase !== "error") {
          threads.set(key(thread.channelId, thread.threadTs), thread);
          restored.push(thread);
        }
      } catch {
        // Corrupted file, skip
      }
    }
  } catch {
    // Directory doesn't exist yet
  }

  return restored;
}

/**
 * Remove persisted thread file from disk.
 */
export async function removePersistedThread(channelId: string, threadTs: string): Promise<void> {
  if (!dataDir) return;
  try {
    await unlink(join(dataDir, threadFileName(channelId, threadTs)));
  } catch {
    // File doesn't exist, that's fine
  }
}

export function createThread(
  channelId: string,
  threadTs: string,
  userId: string,
  problem: string,
): ThreadState {
  const state: ThreadState = {
    threadTs,
    channelId,
    userId,
    problem,
    phase: "received",
    clarifyRound: 0,
    assumptions: [],
    tickets: [],
    completedTicketIds: new Set(),
    prs: [],
    stagingUrls: [],
    errors: [],
    createdAt: new Date(),
  };
  threads.set(key(channelId, threadTs), state);
  // Fire-and-forget save
  saveThread(state).catch(() => {});
  return state;
}

export function getThread(channelId: string, threadTs: string): ThreadState | undefined {
  return threads.get(key(channelId, threadTs));
}

export function getAllActiveThreads(): ThreadState[] {
  return Array.from(threads.values()).filter(
    (t) => t.phase !== "completed" && t.phase !== "error",
  );
}

export function getAllThreads(): ThreadState[] {
  return Array.from(threads.values());
}

export function deleteThread(channelId: string, threadTs: string): void {
  threads.delete(key(channelId, threadTs));
  removePersistedThread(channelId, threadTs).catch(() => {});
}
