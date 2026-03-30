import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { ClaudeAgent } from "./claude.js";
import { CodexAgent } from "./codex.js";

export type AIProvider = "claude" | "codex";

/**
 * Unified agent interface — both ClaudeAgent and CodexAgent conform to this.
 */
export interface AIAgent {
  readonly aborted: boolean;
  killAll(): void;
  run(
    prompt: string,
    cwd: string,
    onProgress?: (line: string) => void,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<{ success: boolean; output: string; error?: string }>;
}

/**
 * Check if a CLI tool is available on the system.
 */
function isCliAvailable(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an AI agent based on the configured provider.
 * Falls back to the other provider if the preferred one is not installed.
 *
 * - "claude" (default): Uses Claude CLI (claude login or ANTHROPIC_API_KEY)
 * - "codex": Uses Codex CLI (codex login or OPENAI_API_KEY)
 */
export function createAgent(provider: AIProvider, apiKey?: string): AIAgent {
  if (provider === "codex") {
    if (isCliAvailable("codex")) {
      return new CodexAgent(apiKey);
    }
    // Codex not installed — fall back to Claude
    console.warn("AI_PROVIDER=codex but Codex CLI not found. Falling back to Claude.");
    if (isCliAvailable("claude")) {
      return new ClaudeAgent(apiKey);
    }
    throw new Error(
      "Neither Codex nor Claude CLI is installed. Install one:\n" +
      "  npm install -g @openai/codex && codex login\n" +
      "  npm install -g @anthropic-ai/claude-code && claude login"
    );
  }

  // Default: Claude
  if (isCliAvailable("claude")) {
    return new ClaudeAgent(apiKey);
  }
  // Claude not installed — fall back to Codex
  console.warn("AI_PROVIDER=claude but Claude CLI not found. Falling back to Codex.");
  if (isCliAvailable("codex")) {
    return new CodexAgent(apiKey);
  }
  throw new Error(
    "Neither Claude nor Codex CLI is installed. Install one:\n" +
    "  npm install -g @anthropic-ai/claude-code && claude login\n" +
    "  npm install -g @openai/codex && codex login"
  );
}
