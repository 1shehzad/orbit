import { mkdir, readdir, readFile, appendFile, unlink, stat } from "node:fs/promises";
import { join, basename } from "node:path";

// ── Types ──

export interface ObservationRecord {
  timestamp: string;
  eventType: "window-snapshot" | "window-focus" | "afk-status";
  appName: string;
  windowTitle: string | null;
  screenshotPath: string | null;
  summaryText: string | null;
  repos: ObservationRepo[];
  project: string | null;
}

export interface ObservationRepo {
  repo: string;
  branch: string;
  uncommittedChanges: number;
  recentCommits: string[];
  modifiedFiles: string[];
}

export interface ParsedObservation extends ObservationRecord {
  parsedTs: Date;
}

// ── Constants ──

const ACTIVITY_LOGS_DIR = "activity-logs";

// ── Deduplication ──

const seen = new Set<string>();

export function resetDedup(): void {
  seen.clear();
}

export function isDuplicate(record: ObservationRecord): boolean {
  const key = `${record.timestamp}|${record.appName}|${record.windowTitle ?? ""}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

// ── Write ──

function dailyFileName(date?: Date): string {
  const d = date ?? new Date();
  return `activitywatch-${d.toISOString().split("T")[0]}.jsonl`;
}

function logsDir(dataDir: string): string {
  return join(dataDir, ACTIVITY_LOGS_DIR);
}

export async function appendObservation(
  dataDir: string,
  record: ObservationRecord,
): Promise<void> {
  const dir = logsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, dailyFileName());
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}

// ── Read ──

export async function readObservations(
  dataDir: string,
  date?: string,
): Promise<ParsedObservation[]> {
  const dir = logsDir(dataDir);
  const fileName = date
    ? `activitywatch-${date}.jsonl`
    : dailyFileName();
  const filePath = join(dir, fileName);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const records: ParsedObservation[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ObservationRecord;
      records.push({ ...record, parsedTs: new Date(record.timestamp) });
    } catch {
      // Skip malformed lines
    }
  }

  return records.sort((a, b) => a.parsedTs.getTime() - b.parsedTs.getTime());
}

export async function readRecentObservations(
  dataDir: string,
  days: number = 2,
): Promise<ParsedObservation[]> {
  const dir = logsDir(dataDir);

  let entries: { name: string }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((e) => e.name.endsWith(".jsonl"))
    .map((e) => e.name)
    .sort();

  // Take only the last N files
  const recentFiles = files.slice(-days);

  const all: ParsedObservation[] = [];
  for (const fileName of recentFiles) {
    const filePath = join(dir, fileName);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as ObservationRecord;
        all.push({ ...record, parsedTs: new Date(record.timestamp) });
      } catch {
        // Skip malformed lines
      }
    }
  }

  return all.sort((a, b) => a.parsedTs.getTime() - b.parsedTs.getTime());
}

// ── Project inference ──

export function inferProject(
  windowTitle: string | null,
  appName: string,
  repos: ObservationRepo[],
): string | null {
  // 1. From window title (VS Code pattern: "file.ts — project-name")
  if (windowTitle) {
    const repoMatch = /[—-]\s+([A-Za-z0-9._-]+)\s*$/.exec(windowTitle);
    if (repoMatch) return repoMatch[1];
  }

  // 2. From repos with activity (uncommitted changes or recent commits)
  const active = repos.filter(
    (r) => r.uncommittedChanges > 0 || r.recentCommits.length > 0,
  );
  if (active.length === 1) return active[0].repo;

  // 3. From browser tabs (GitHub, Linear patterns)
  if (windowTitle) {
    const ghMatch = /github\.com\/[^/]+\/([^/\s]+)/i.exec(windowTitle);
    if (ghMatch) return ghMatch[1];
  }

  return null;
}

// ── Cleanup ──

export async function cleanupOldActivityLogs(
  dataDir: string,
  retentionDays: number,
): Promise<void> {
  const dir = logsDir(dataDir);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dir, file);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {
    // Directory doesn't exist yet
  }
}
