import { ClaudeAgent } from "@orbit/core";

export type MessageType = "query" | "task" | "code_query";

export interface ClassificationResult {
  type: MessageType;
  /** Short casual acknowledgement for tasks (e.g., "On it, I'll look into the SSO issue.") */
  ack: string;
  /** Whether this needs a clarifying question before starting (rare — only for very ambiguous tasks) */
  needsClarification: boolean;
  /** Clarifying question if needed */
  clarifyQuestion?: string;
}

/**
 * Classify a Slack message as a query (needs info response) or task (needs code work).
 * Uses Claude to determine intent and generate a natural acknowledgement.
 */
export async function classifyMessage(
  text: string,
  anthropicApiKey?: string,
): Promise<ClassificationResult> {
  const claude = new ClaudeAgent(anthropicApiKey);

  const result = await claude.run(
    `You are classifying a Slack message directed at a developer. Determine if it's:
- QUERY: asking for general information, status, opinion (answerable from memory/context)
- CODE_QUERY: asking about how code works, where something is implemented, how a flow works (needs codebase search)
- TASK: requesting code changes, bug fixes, feature work

MESSAGE:
${text}

Output ONLY this JSON — no other text:

===CLASSIFY===
{
  "type": "query" or "code_query" or "task",
  "ack": "A short, casual, human-sounding acknowledgement (1 sentence). For queries/code_queries, leave empty. For tasks, something like 'On it, I'll take a look at the auth issue.'",
  "needsClarification": false,
  "clarifyQuestion": ""
}
===END_CLASSIFY===

Rules:
- "what's the status of..." → query
- "what are you working on..." → query
- "when will X be done..." → query
- "how does the payment flow work..." → code_query
- "where is the auth middleware..." → code_query
- "can you explain how X is implemented..." → code_query
- "what does function Y do..." → code_query
- "which files handle Z..." → code_query
- "fix this tomorrow morning..." → task (with schedule — the "tomorrow" part is handled separately)
- "do this at 3pm..." → task (with schedule)
- "what should I know before the sprint review..." → query (meeting prep is handled in query path)
- "sprint summary..." → query
- "fix the bug in..." → task
- "add a button to..." → task
- "can you fix/add/update/create/implement/refactor..." → task
- Set needsClarification=true ONLY if the task is so vague it's impossible to start (extremely rare)`,
    process.cwd(),
  );

  // Parse the classification
  const startIdx = result.output.indexOf("===CLASSIFY===");
  const endIdx = result.output.indexOf("===END_CLASSIFY===");
  if (startIdx === -1) {
    // Fallback: assume task if classification fails
    return { type: "task", ack: "On it.", needsClarification: false };
  }

  const json = result.output.slice(startIdx + "===CLASSIFY===".length, endIdx === -1 ? undefined : endIdx).trim();
  try {
    const parsed = JSON.parse(json);
    return {
      type: parsed.type === "query" ? "query"
        : parsed.type === "code_query" ? "code_query"
        : "task",
      ack: parsed.ack || "On it.",
      needsClarification: parsed.needsClarification === true,
      clarifyQuestion: parsed.clarifyQuestion || undefined,
    };
  } catch {
    return { type: "task", ack: "On it.", needsClarification: false };
  }
}
