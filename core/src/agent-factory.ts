import { ClaudeAgent } from "./claude.js";
import type { ClaudeResult } from "./claude.js";
import { CodexAgent } from "./codex.js";
import type { CodexResult } from "./codex.js";

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
 * Create an AI agent based on the configured provider.
 *
 * - "claude" (default): Uses Claude CLI (claude login or ANTHROPIC_API_KEY)
 * - "codex": Uses Codex CLI (codex login or OPENAI_API_KEY)
 */
export function createAgent(provider: AIProvider, apiKey?: string): AIAgent {
  switch (provider) {
    case "codex":
      return new CodexAgent(apiKey);
    case "claude":
    default:
      return new ClaudeAgent(apiKey);
  }
}
