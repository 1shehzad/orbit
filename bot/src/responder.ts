import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeAgent } from "@orbit/core";

/**
 * Load all .md files from the context folder.
 * These files contain info about the user: role, daily tasks, platform, etc.
 */
async function loadContext(contextFolder: string): Promise<string> {
  const parts: string[] = [];

  try {
    const files = await readdir(contextFolder);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

    for (const file of mdFiles) {
      try {
        const content = await readFile(join(contextFolder, file), "utf-8");
        const name = file.replace(/\.md$/, "").toUpperCase();
        parts.push(`=== ${name} ===\n${content.trim()}`);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Context folder doesn't exist or isn't readable
  }

  return parts.length > 0
    ? parts.join("\n\n")
    : "No context files found. Respond based on general knowledge.";
}

/**
 * Generate a response to a query using the user's context files.
 * Returns a short, natural response as if the user themselves is replying.
 */
export async function respondToQuery(
  question: string,
  contextFolder: string,
  anthropicApiKey?: string,
): Promise<string> {
  const context = await loadContext(contextFolder);
  const claude = new ClaudeAgent(anthropicApiKey);

  const result = await claude.run(
    `You are responding to a Slack message on behalf of a developer. Use the context below to answer accurately and concisely — as if the developer themselves is typing the reply.

CONTEXT ABOUT YOU:
${context}

MESSAGE TO RESPOND TO:
${question}

Rules:
- Respond in first person ("I", "we", "my team")
- Keep it short — 1-3 sentences, like a real Slack reply
- Be direct and casual (no formal language, no bullet points unless needed)
- If the context doesn't have the answer, say something like "I'd need to check on that, let me get back to you"
- Do NOT say "based on my context files" or anything that reveals you're an AI
- Match the tone of the question (casual question → casual answer)

Output ONLY the response text — nothing else. No markers, no JSON.`,
    process.cwd(),
  );

  // Clean up the output — remove any markers or extra formatting
  let response = result.output.trim();

  // Remove common Claude wrapper patterns
  if (response.startsWith('"') && response.endsWith('"')) {
    response = response.slice(1, -1);
  }

  return response || "Let me check on that and get back to you.";
}
