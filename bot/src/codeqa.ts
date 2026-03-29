import { createAgent } from "@orbit/core";
import type { ProjectConfig } from "@orbit/core";

/**
 * Answer a question about the codebase by running Claude CLI in the project folder.
 * Claude can read files, grep, trace flows — giving accurate code-aware answers.
 */
export async function answerCodeQuestion(
  question: string,
  config: ProjectConfig,
  contextFolder?: string,
  workspaceRoots?: string[],
): Promise<string> {
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);

  // Load context files for additional background (optional)
  let contextBlock = "";
  if (contextFolder) {
    try {
      const { readdir, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const files = await readdir(contextFolder);
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
      const parts: string[] = [];
      for (const file of mdFiles) {
        try {
          const content = await readFile(join(contextFolder, file), "utf-8");
          parts.push(content.trim());
        } catch {}
      }
      if (parts.length > 0) {
        contextBlock = `\nBACKGROUND CONTEXT:\n${parts.join("\n\n").slice(0, 2000)}\n`;
      }
    } catch {}
  }

  const result = await claude.run(
    `You are a developer answering a teammate's question about the codebase. Search the codebase to find the answer.
${contextBlock}${workspaceRoots && workspaceRoots.length > 0 ? `\nWORKSPACE ROOTS (search ALL subdirectories under these paths):\n${workspaceRoots.join("\n")}\n` : ""}
QUESTION:
${question}

Instructions:
1. Search the codebase using grep, file reading, etc. to find the relevant code (check all workspace roots if multiple are listed)
2. Trace the flow if asked about how something works
3. Reference specific files and line numbers
4. Then write a SHORT, CASUAL response as if you're the developer replying in Slack

Your response should be:
- 2-5 sentences max, like a real Slack reply
- In first person ("we use...", "it starts in...", "the handler is in...")
- Reference specific files naturally (e.g., "starts in checkout.ts where we...")
- No bullet points unless truly needed
- No formal language, no "Based on my analysis..."
- Sound like a developer who knows the codebase

Output ONLY the Slack response text between these markers:

===RESPONSE===
<your casual response here>
===END_RESPONSE===`,
    // Run from the first workspace root (covers all repos), fall back to projectFolder
    workspaceRoots?.[0] || config.projectFolder,
  );

  // Extract response
  const startIdx = result.output.indexOf("===RESPONSE===");
  const endIdx = result.output.indexOf("===END_RESPONSE===");

  if (startIdx !== -1) {
    const response = result.output.slice(
      startIdx + "===RESPONSE===".length,
      endIdx === -1 ? undefined : endIdx,
    ).trim();
    if (response) return response;
  }

  // Fallback: take the last meaningful chunk of output
  const lines = result.output.trim().split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    // Take last few lines as the response
    return lines.slice(-5).join("\n").slice(0, 500);
  }

  return "I'd need to dig into that a bit more, let me check and get back to you.";
}
