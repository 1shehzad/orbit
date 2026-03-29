import type { App } from "@slack/bolt";
import { basename } from "node:path";
import { GitManager, createAgent } from "@orbit/core";
import type { ProjectConfig } from "@orbit/core";
import type { ThreadState } from "./threads.js";
import { textBlock, divider, header, context } from "./slack.js";

export interface TicketDefinition {
  /** Unique index for dependency references (e.g., "T1", "T2") */
  key: string;
  title: string;
  description: string;
  priority: number;
  labels: string[];
  /** Keys of tickets this depends on (e.g., ["T1"]) */
  dependsOn: string[];
}

export interface AnalysisResult {
  /** Synced repos with their base branch */
  syncedRepos: string[];
  /** Codebase context summary */
  codebaseContext: string;
  /** Detailed spec with file references */
  spec: string;
  /** Spec analysis — gaps/questions found, or "approved" */
  analysis: { approved: boolean; questions: string[] };
  /** Task classification */
  classification: {
    type: string;       // bug_fix, new_feature, refactor, config_change, multi_service
    complexity: string; // small, medium, large
    ticketCount: number;
    sequential: boolean;
    tickets: TicketDefinition[];
  };
}

/**
 * Run the full analysis pipeline:
 * 1. Pull remote changes
 * 2. Scan codebase
 * 3. Prepare spec with file references
 * 4. Analyse spec for gaps
 * 5. Classify task and break into tickets
 */
export async function analyzeProblem(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
): Promise<AnalysisResult> {
  const { channelId, threadTs } = thread;
  const git = new GitManager(config.projectFolder);
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  const baseBranch = config.baseBranch || "staging";

  const post = async (text: string) => {
    await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  };

  // ─── Step 1: Pull remote changes ───
  thread.phase = "analyzing";
  const repos = await git.discoverRepos();
  const syncedRepos: string[] = [];

  for (const repo of repos) {
    try {
      await git.pullFromBase(repo, baseBranch);
      syncedRepos.push(basename(repo));
    } catch {
      // Repo doesn't have baseBranch, skip
    }
  }

  if (syncedRepos.length === 0) {
    throw new Error(`No repos found with "${baseBranch}" branch in ${config.projectFolder}`);
  }

  await post(`:arrows_counterclockwise: Synced ${syncedRepos.length} repo(s) to latest \`${baseBranch}\`: ${syncedRepos.map(r => `\`${r}\``).join(", ")}`);

  // ─── Step 2: Scan codebase ───
  await post(`:mag: Scanning codebase...`);

  const scanResult = await claude.run(
    `You are analyzing a project workspace. Scan ALL subdirectories (each is a git repo).

For each repo, gather:
1. Tech stack (check package.json, tsconfig.json, requirements.txt, go.mod, etc.)
2. Key directories and their purpose (src/, routes/, models/, components/, etc.)
3. Important config files and patterns
4. Last 5 commits (run: git log --oneline -5)
5. Database/ORM patterns if any

Output a concise summary in this exact format:

===CODEBASE_CONTEXT===
## Repos
<for each repo: name, tech stack, purpose — one line each>

## Structure
<key directories and what they contain>

## Patterns
<coding conventions, frameworks, middleware, auth patterns>

## Recent Changes
<notable recent commits across repos>
===END_CONTEXT===

Be concise. No more than 60 lines total.`,
    config.projectFolder,
  );

  const codebaseContext = extractBetween(scanResult.output, "===CODEBASE_CONTEXT===", "===END_CONTEXT===")
    || scanResult.output.slice(0, 3000);

  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: [
      header("Codebase Context"),
      textBlock(codebaseContext.length > 2900 ? codebaseContext.slice(0, 2900) + "..." : codebaseContext),
    ],
    text: "Codebase context scanned",
  });

  // ─── Step 3: Prepare spec with file references ───
  await post(`:page_facing_up: Preparing detailed spec...`);

  const specResult = await claude.run(
    `You are a senior software architect. Given this problem and codebase context, create a detailed implementation spec.

PROBLEM:
${thread.problem}

CODEBASE CONTEXT:
${codebaseContext}

WORKSPACE: ${config.projectFolder}
REPOS: ${syncedRepos.join(", ")}

Analyze the codebase to find the exact files that need changes. Read relevant files to understand the current code.

Output in this exact format:

===SPEC===
## Problem Summary
<1-2 sentence summary of what needs to be done>

## Affected Files
<for each file that needs changes:>
- \`repo/path/to/file.ts:LINE_START-LINE_END\` — what needs to change and why

## Dependencies
<files/modules that are related but may not need changes>

## Implementation Plan
<numbered steps, specific and actionable>

## Risks
<potential issues, edge cases, things that could break>
===END_SPEC===

Be specific. Reference exact file paths and line numbers. Read files before referencing them.`,
    config.projectFolder,
  );

  const spec = extractBetween(specResult.output, "===SPEC===", "===END_SPEC===")
    || specResult.output.slice(0, 4000);

  thread.spec = spec;

  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: [
      header("Implementation Spec"),
      textBlock(spec.length > 2900 ? spec.slice(0, 2900) + "..." : spec),
    ],
    text: "Implementation spec prepared",
  });

  // ─── Step 4: Analyse spec for gaps ───
  await post(`:thinking_face: Reviewing spec for completeness...`);

  const analysisResult = await claude.run(
    `You are a tech lead reviewing an implementation spec. Check for completeness, risks, and missing information.

ORIGINAL PROBLEM:
${thread.problem}

SPEC:
${spec}

CODEBASE CONTEXT:
${codebaseContext}

Review the spec and output in this exact format:

===ANALYSIS===
{
  "approved": true/false,
  "confidence": "high/medium/low",
  "gaps": ["list of missing information or ambiguities"],
  "risks": ["list of risks not covered in the spec"],
  "questions": ["specific questions to ask the user to fill gaps — ONLY if approved is false"]
}
===END_ANALYSIS===

Set "approved" to true if the spec is solid enough to proceed. Only set false if there are critical gaps that would lead to a wrong implementation. Minor uncertainties are OK — proceed with best judgment.`,
    config.projectFolder,
  );

  const analysisJson = extractBetween(analysisResult.output, "===ANALYSIS===", "===END_ANALYSIS===");
  let analysis: { approved: boolean; questions: string[] } = { approved: true, questions: [] };

  try {
    const parsed = JSON.parse(analysisJson || "{}");
    analysis = {
      approved: parsed.approved !== false,
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    };

    // Post analysis summary
    const statusEmoji = analysis.approved ? ":white_check_mark:" : ":warning:";
    const statusText = analysis.approved ? "Spec approved — ready to proceed" : "Gaps found — need clarification";
    const details: string[] = [`${statusEmoji} *${statusText}*`];

    if (parsed.gaps?.length > 0) {
      details.push("\n*Gaps:*\n" + parsed.gaps.map((g: string) => `• ${g}`).join("\n"));
    }
    if (parsed.risks?.length > 0) {
      details.push("\n*Risks:*\n" + parsed.risks.map((r: string) => `• ${r}`).join("\n"));
    }

    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: [
        header("Spec Review"),
        textBlock(details.join("\n")),
        context(`Confidence: *${parsed.confidence || "medium"}*`),
      ],
      text: statusText,
    });
  } catch {
    // If parsing fails, assume approved
    await post(`:white_check_mark: Spec review complete — proceeding.`);
  }

  // ─── Step 5: Classify task and break into tickets ───
  await post(`:label: Classifying task and creating ticket breakdown...`);

  const classifyResult = await claude.run(
    `You are a project manager breaking down a software task into Linear tickets.

PROBLEM:
${thread.problem}

SPEC:
${spec}

CODEBASE CONTEXT:
${codebaseContext}

Classify this task and break it into the minimum number of tickets needed.

Output in this exact format:

===CLASSIFICATION===
{
  "type": "bug_fix|new_feature|refactor|config_change|multi_service",
  "complexity": "small|medium|large",
  "ticketCount": <number>,
  "sequential": true/false,
  "reasoning": "why this classification",
  "tickets": [
    {
      "key": "T1",
      "title": "Short descriptive title",
      "description": "Detailed description with file references from the spec.\\n\\n**Affected files:**\\n- \`repo/path/file.ts:10-25\` — what changes\\n\\n**Acceptance criteria:**\\n- [ ] Criterion 1\\n- [ ] Criterion 2\\n\\n**Definition of done:**\\n- Build passes\\n- Tests pass\\n- Merged to base branch",
      "priority": 2,
      "labels": ["bug", "api"],
      "dependsOn": []
    },
    {
      "key": "T2",
      "title": "Second ticket that depends on T1",
      "description": "...",
      "priority": 3,
      "labels": ["frontend"],
      "dependsOn": ["T1"]
    }
  ]
}
===END_CLASSIFICATION===

Rules:
- Small = 1 ticket, Medium = 2-3 tickets, Large = 4+ tickets
- Priority: 1 = urgent, 2 = high, 3 = medium, 4 = low
- Each ticket gets a unique key (T1, T2, T3...) for dependency references
- dependsOn lists keys of tickets that MUST be completed before this one starts
- If ticket B changes files that ticket A also changes, B dependsOn A
- sequential = true if ALL tickets must be done in strict order
- sequential = false if some tickets are independent
- labels: use short lowercase tags (bug, feature, api, frontend, backend, database, config, refactor, test)
- Include exact file paths with line numbers in descriptions
- Include acceptance criteria as a checklist
- Prefer fewer, well-scoped tickets over many tiny ones`,
    config.projectFolder,
  );

  const classifyJson = extractBetween(classifyResult.output, "===CLASSIFICATION===", "===END_CLASSIFICATION===");

  const fallbackTicket: TicketDefinition = {
    key: "T1",
    title: thread.problem.slice(0, 80),
    description: thread.problem,
    priority: 2,
    labels: [],
    dependsOn: [],
  };

  let classification: AnalysisResult["classification"] = {
    type: "new_feature",
    complexity: "small",
    ticketCount: 1,
    sequential: false,
    tickets: [fallbackTicket],
  };

  try {
    const parsed = JSON.parse(classifyJson || "{}");
    const tickets: TicketDefinition[] = Array.isArray(parsed.tickets)
      ? parsed.tickets.map((t: Record<string, unknown>, i: number) => ({
          key: (t.key as string) || `T${i + 1}`,
          title: (t.title as string) || "",
          description: (t.description as string) || "",
          priority: (t.priority as number) || 2,
          labels: Array.isArray(t.labels) ? t.labels as string[] : [],
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn as string[] : [],
        }))
      : classification.tickets;

    classification = {
      type: parsed.type || "new_feature",
      complexity: parsed.complexity || "small",
      ticketCount: parsed.ticketCount || tickets.length,
      sequential: parsed.sequential ?? false,
      tickets,
    };
  } catch {}

  // Post classification
  const typeLabels: Record<string, string> = {
    bug_fix: ":bug: Bug Fix",
    new_feature: ":sparkles: New Feature",
    refactor: ":recycle: Refactor",
    config_change: ":wrench: Config Change",
    multi_service: ":link: Multi-Service",
  };
  const complexityLabels: Record<string, string> = {
    small: ":green_circle: Small (1 ticket)",
    medium: ":large_orange_circle: Medium (2-3 tickets)",
    large: ":red_circle: Large (4+ tickets)",
  };

  const ticketList = classification.tickets
    .map((t) => {
      const deps = t.dependsOn.length > 0 ? ` _(depends on: ${t.dependsOn.join(", ")})_` : "";
      const labels = t.labels.length > 0 ? ` \`${t.labels.join("` `")}\`` : "";
      return `*${t.key}.* *${t.title}*${labels}${deps}\n    ${t.description.split("\n")[0].slice(0, 120)}`;
    })
    .join("\n");

  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: [
      header("Task Classification"),
      textBlock([
        `*Type:* ${typeLabels[classification.type] || classification.type}`,
        `*Complexity:* ${complexityLabels[classification.complexity] || classification.complexity}`,
        `*Tickets:* ${classification.ticketCount}`,
        `*Execution:* ${classification.sequential ? "Sequential (dependent)" : "Independent"}`,
      ].join("\n")),
      divider(),
      textBlock(`*Ticket Breakdown:*\n${ticketList}`),
    ],
    text: `Classified as ${classification.type} — ${classification.ticketCount} ticket(s)`,
  });

  return { syncedRepos, codebaseContext, spec, analysis, classification };
}

/**
 * Refine the spec after receiving clarification answers.
 * Uses Claude to incorporate answers, update the spec, and re-check for gaps.
 * Returns updated analysis with potentially new questions (multi-round).
 */
export async function refineSpec(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
  answers: { question: string; answer: string }[],
): Promise<{ approved: boolean; questions: string[]; assumptions: string[] }> {
  const { channelId, threadTs } = thread;
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  const analysis = thread.analysisResult!;

  const post = async (text: string) => {
    await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  };

  await post(`:arrows_counterclockwise: Incorporating your answers and updating spec (round ${thread.clarifyRound})...`);

  const answersBlock = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join("\n\n");

  // Use Claude to update the spec with the answers
  const refineResult = await claude.run(
    `You are a senior software architect updating an implementation spec based on new clarifications.

ORIGINAL PROBLEM:
${thread.problem}

CURRENT SPEC:
${analysis.spec}

CODEBASE CONTEXT:
${analysis.codebaseContext}

CLARIFICATIONS RECEIVED:
${answersBlock}

Update the spec to incorporate these answers. Then review the updated spec for any remaining gaps.

Output in this exact format:

===REFINED_SPEC===
<the full updated spec — same format as before with ## Problem Summary, ## Affected Files, etc.>
===END_REFINED_SPEC===

===REFINED_ANALYSIS===
{
  "approved": true/false,
  "confidence": "high/medium/low",
  "gaps": ["remaining gaps if any"],
  "risks": ["updated risks"],
  "questions": ["new questions ONLY if there are still critical gaps — keep this minimal"],
  "assumptions": ["assumptions you made where the answers were unclear or incomplete"]
}
===END_REFINED_ANALYSIS===

Be strict: only set approved=false if there are truly critical unknowns left. Most gaps can be resolved with reasonable assumptions.`,
    config.projectFolder,
  );

  // Parse refined spec
  const refinedSpec = extractBetween(refineResult.output, "===REFINED_SPEC===", "===END_REFINED_SPEC===");
  if (refinedSpec) {
    analysis.spec = refinedSpec;
    thread.spec = refinedSpec;
  }

  // Parse refined analysis
  const refinedJson = extractBetween(refineResult.output, "===REFINED_ANALYSIS===", "===END_REFINED_ANALYSIS===");
  let result = { approved: true, questions: [] as string[], assumptions: [] as string[] };

  try {
    const parsed = JSON.parse(refinedJson || "{}");
    result = {
      approved: parsed.approved !== false,
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    };

    // Post update
    const statusEmoji = result.approved ? ":white_check_mark:" : ":warning:";
    const statusText = result.approved ? "Spec updated and approved" : "Still have gaps";

    const details: string[] = [`${statusEmoji} *${statusText}*`];
    if (result.assumptions.length > 0) {
      details.push("\n*Assumptions made:*\n" + result.assumptions.map((a) => `• ${a}`).join("\n"));
    }
    if (parsed.gaps?.length > 0) {
      details.push("\n*Remaining gaps:*\n" + parsed.gaps.map((g: string) => `• ${g}`).join("\n"));
    }

    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: [
        header(`Spec Review — Round ${thread.clarifyRound}`),
        textBlock(details.join("\n")),
        context(`Confidence: *${parsed.confidence || "medium"}*`),
      ],
      text: statusText,
    });
  } catch {
    await post(`:white_check_mark: Spec updated — proceeding.`);
  }

  // Store assumptions
  if (result.assumptions.length > 0) {
    thread.assumptions.push(...result.assumptions);
  }

  // Update the analysis result
  analysis.analysis = { approved: result.approved, questions: result.questions };

  return result;
}

/**
 * Generate assumptions for unanswered questions when timeout triggers.
 * Claude fills in best guesses for each unanswered question.
 */
export async function generateAssumptions(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
  unansweredQuestions: string[],
): Promise<void> {
  const { channelId, threadTs } = thread;
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  const analysis = thread.analysisResult!;

  const post = async (text: string) => {
    await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  };

  await post(`:hourglass: Clarification timeout reached. Generating best-effort assumptions...`);

  const questionsBlock = unansweredQuestions
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");

  const assumeResult = await claude.run(
    `You are a senior engineer who needs to proceed without full answers from the stakeholder.

PROBLEM:
${thread.problem}

SPEC:
${analysis.spec}

CODEBASE CONTEXT:
${analysis.codebaseContext}

UNANSWERED QUESTIONS:
${questionsBlock}

For each unanswered question, make a reasonable assumption based on the codebase and common patterns. Then update the spec.

Output in this exact format:

===ASSUMPTIONS===
{
  "assumptions": [
    {"question": "the original question", "assumption": "what you decided to assume and why"}
  ]
}
===END_ASSUMPTIONS===

===UPDATED_SPEC===
<full updated spec incorporating your assumptions>
===END_UPDATED_SPEC===

Be conservative. Prefer the simpler, safer approach when uncertain.`,
    config.projectFolder,
  );

  // Parse assumptions
  const assumeJson = extractBetween(assumeResult.output, "===ASSUMPTIONS===", "===END_ASSUMPTIONS===");
  try {
    const parsed = JSON.parse(assumeJson || "{}");
    if (Array.isArray(parsed.assumptions)) {
      const assumptionLines = parsed.assumptions.map(
        (a: { question: string; assumption: string }) => `• *Q:* ${a.question}\n  *A (assumed):* ${a.assumption}`,
      );
      thread.assumptions.push(...parsed.assumptions.map((a: { assumption: string }) => a.assumption));

      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks: [
          header("Assumptions Made"),
          textBlock(assumptionLines.join("\n\n")),
          context("These assumptions were made because no response was received within the timeout. If any are wrong, you can correct them later."),
        ],
        text: "Assumptions made for unanswered questions",
      });
    }
  } catch {}

  // Update spec
  const updatedSpec = extractBetween(assumeResult.output, "===UPDATED_SPEC===", "===END_UPDATED_SPEC===");
  if (updatedSpec) {
    analysis.spec = updatedSpec;
    thread.spec = updatedSpec;
  }

  // Mark as approved since we made assumptions
  analysis.analysis = { approved: true, questions: [] };
}

/**
 * Re-run classification on an updated spec (after clarification rounds).
 * Updates thread.analysisResult.classification in place.
 */
export async function reclassify(
  app: App,
  thread: ThreadState,
  config: ProjectConfig,
): Promise<void> {
  const claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  const analysis = thread.analysisResult!;
  const { channelId, threadTs } = thread;

  const classifyResult = await claude.run(
    `You are a project manager breaking down a software task into Linear tickets.

PROBLEM:
${thread.problem}

SPEC:
${analysis.spec}

CODEBASE CONTEXT:
${analysis.codebaseContext}

${thread.assumptions.length > 0 ? `ASSUMPTIONS MADE:\n${thread.assumptions.map((a) => `- ${a}`).join("\n")}\n` : ""}

Classify this task and break it into the minimum number of tickets needed.

Use the same JSON format with key, title, description, priority, labels, and dependsOn fields per ticket.

===CLASSIFICATION===
{ "type": "...", "complexity": "...", "ticketCount": N, "sequential": bool, "tickets": [...] }
===END_CLASSIFICATION===`,
    config.projectFolder,
  );

  const classifyJson = extractBetween(classifyResult.output, "===CLASSIFICATION===", "===END_CLASSIFICATION===");

  try {
    const parsed = JSON.parse(classifyJson || "{}");
    const tickets: TicketDefinition[] = Array.isArray(parsed.tickets)
      ? parsed.tickets.map((t: Record<string, unknown>, i: number) => ({
          key: (t.key as string) || `T${i + 1}`,
          title: (t.title as string) || "",
          description: (t.description as string) || "",
          priority: (t.priority as number) || 2,
          labels: Array.isArray(t.labels) ? t.labels as string[] : [],
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn as string[] : [],
        }))
      : analysis.classification.tickets;

    analysis.classification = {
      type: parsed.type || analysis.classification.type,
      complexity: parsed.complexity || analysis.classification.complexity,
      ticketCount: parsed.ticketCount || tickets.length,
      sequential: parsed.sequential ?? analysis.classification.sequential,
      tickets,
    };
  } catch {}

  // Post updated classification
  const typeLabels: Record<string, string> = {
    bug_fix: ":bug: Bug Fix",
    new_feature: ":sparkles: New Feature",
    refactor: ":recycle: Refactor",
    config_change: ":wrench: Config Change",
    multi_service: ":link: Multi-Service",
  };

  const ticketList = analysis.classification.tickets
    .map((t) => {
      const deps = t.dependsOn.length > 0 ? ` _(depends on: ${t.dependsOn.join(", ")})_` : "";
      return `*${t.key}.* *${t.title}*${deps}\n    ${t.description.split("\n")[0].slice(0, 120)}`;
    })
    .join("\n");

  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    blocks: [
      header("Updated Classification"),
      textBlock([
        `*Type:* ${typeLabels[analysis.classification.type] || analysis.classification.type}`,
        `*Tickets:* ${analysis.classification.ticketCount}`,
      ].join("\n")),
      divider(),
      textBlock(`*Ticket Breakdown:*\n${ticketList}`),
    ],
    text: `Reclassified — ${analysis.classification.ticketCount} ticket(s)`,
  });
}

/** Extract text between two markers */
function extractBetween(text: string, start: string, end: string): string {
  const startIdx = text.indexOf(start);
  if (startIdx === -1) return "";
  const afterStart = text.slice(startIdx + start.length);
  const endIdx = afterStart.indexOf(end);
  if (endIdx === -1) return afterStart.trim();
  return afterStart.slice(0, endIdx).trim();
}
