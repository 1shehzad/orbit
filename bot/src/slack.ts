import type { KnownBlock, Block } from "@slack/types";
import type { ThreadState } from "./threads.js";
import type { LinearTicket, TicketStatus, QAResult, PRInfo } from "@orbit/core";
import type { UserConfig } from "./users.js";

/** Simple text section block */
export function textBlock(text: string, markdown = true): KnownBlock {
  return {
    type: "section",
    text: { type: markdown ? "mrkdwn" : "plain_text", text },
  };
}

/** Divider block */
export function divider(): KnownBlock {
  return { type: "divider" };
}

/** Header block */
export function header(text: string): KnownBlock {
  return {
    type: "header",
    text: { type: "plain_text", text, emoji: true },
  };
}

/** Context block (small grey text) */
export function context(text: string): KnownBlock {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
}

/** Build the acknowledgement message when a problem is received */
export function ackBlocks(problem: string): (KnownBlock | Block)[] {
  return [
    header("Orbit — Problem Received"),
    textBlock(problem.length > 300 ? problem.slice(0, 300) + "..." : problem),
    divider(),
    textBlock("I'll analyze the codebase and break this down into tasks. Stand by..."),
    context("Phase: *Analyzing*"),
  ];
}

/** Build a status update message (posted once, then updated in-place) */
export function statusBlocks(thread: ThreadState): (KnownBlock | Block)[] {
  const phaseLabels: Record<string, string> = {
    received: "Received",
    analyzing: "Analyzing codebase & preparing specs",
    clarifying: "Waiting for your answers",
    planning: "Creating Linear tickets",
    executing: `Processing tickets (${thread.completedTicketIds.size}/${thread.tickets.length})`,
    completed: "All done!",
    error: "Error encountered",
  };

  const blocks: (KnownBlock | Block)[] = [
    header("Orbit — Status"),
    textBlock(`*Phase:* ${phaseLabels[thread.phase] || thread.phase}`),
  ];

  if (thread.tickets.length > 0) {
    const lines = thread.tickets.map((t) => {
      const done = thread.completedTicketIds.has(t.id);
      const icon = done ? ":white_check_mark:" : ":hourglass_flowing_sand:";
      return `${icon} <${t.url}|${t.identifier}> — ${t.title}`;
    });
    blocks.push(divider(), textBlock(lines.join("\n")));
  }

  if (thread.errors.length > 0) {
    const lastErr = thread.errors[thread.errors.length - 1];
    blocks.push(divider(), textBlock(`:warning: ${lastErr}`));
  }

  blocks.push(context(`Started: <!date^${Math.floor(thread.createdAt.getTime() / 1000)}^{date_short_pretty} at {time}|${thread.createdAt.toISOString()}>`));

  return blocks;
}

/** Format a ticket completion message */
export function ticketCompleteBlocks(ticket: LinearTicket, status: TicketStatus): (KnownBlock | Block)[] {
  const blocks: (KnownBlock | Block)[] = [
    textBlock(`:white_check_mark: *<${ticket.url}|${ticket.identifier}>* — ${ticket.title} — *Done*`),
  ];

  if (status.testCases && status.testCases.length > 0) {
    const tcLines = status.testCases.map((tc) => {
      const steps = tc.steps.map((s, i) => `    ${i + 1}. ${s}`).join("\n");
      return `*${tc.title}*${tc.route ? ` (${tc.route})` : ""}\n${steps}`;
    });
    blocks.push(textBlock("*Test Cases:*\n" + tcLines.join("\n\n")));
  }

  return blocks;
}

/** Format an error message */
export function errorBlocks(message: string): (KnownBlock | Block)[] {
  return [
    textBlock(`:x: *Error:* ${message}`),
  ];
}

/** Format the final summary */
export function summaryBlocks(thread: ThreadState): (KnownBlock | Block)[] {
  const total = thread.tickets.length;
  const done = thread.completedTicketIds.size;
  const failed = thread.errors.length;

  const blocks: (KnownBlock | Block)[] = [
    header("Orbit — Complete"),
    textBlock(`*${done}/${total}* tickets completed${failed > 0 ? `, *${failed}* error(s)` : ""}`),
  ];

  // Ticket status list
  if (thread.tickets.length > 0) {
    const lines = thread.tickets.map((t) => {
      const isDone = thread.completedTicketIds.has(t.id);
      const icon = isDone ? ":white_check_mark:" : ":x:";
      return `${icon} <${t.url}|${t.identifier}> — ${t.title}`;
    });
    blocks.push(divider(), textBlock(lines.join("\n")));
  }

  // PR links
  if (thread.prs.length > 0) {
    const prLines = thread.prs.map((p) =>
      `• <${p.url}|${p.repo}#${p.number}> — ${p.title}`
    );
    blocks.push(divider(), textBlock(`:rocket: *Pull Requests:*\n${prLines.join("\n")}`));
  }

  // Staging URLs
  if (thread.stagingUrls.length > 0) {
    const unique = [...new Set(thread.stagingUrls)];
    const urlLines = unique.map((u) => `• <${u}|${u}>`);
    blocks.push(textBlock(`:globe_with_meridians: *Staging:*\n${urlLines.join("\n")}`));
  }

  // Assumptions
  if (thread.assumptions.length > 0) {
    const assumptionLines = thread.assumptions.map((a) => `• ${a}`);
    blocks.push(divider(), textBlock(`:memo: *Assumptions made:*\n${assumptionLines.join("\n")}`));
  }

  // Items needing human review
  const reviewItems: string[] = [];
  if (failed > 0) {
    reviewItems.push(`${failed} ticket(s) had errors — check thread above for details`);
  }
  if (thread.assumptions.length > 0) {
    reviewItems.push(`${thread.assumptions.length} assumption(s) were made — verify they're correct`);
  }
  if (thread.prs.length > 0) {
    reviewItems.push(`${thread.prs.length} PR(s) need code review before merging`);
  }

  if (reviewItems.length > 0) {
    const reviewLines = reviewItems.map((r) => `• ${r}`);
    blocks.push(divider(), textBlock(`:eyes: *Needs human review:*\n${reviewLines.join("\n")}`));
  }

  blocks.push(context("Reply in this thread with feedback or issues — Orbit will create fix tickets automatically."));

  return blocks;
}

/** Format the /orbit status response */
export function globalStatusBlocks(activeThreads: ThreadState[]): (KnownBlock | Block)[] {
  if (activeThreads.length === 0) {
    return [textBlock("No active Orbit sessions.")];
  }

  const lines = activeThreads.map((t) => {
    const ticketInfo = t.tickets.length > 0
      ? ` — ${t.completedTicketIds.size}/${t.tickets.length} tickets`
      : "";
    return `• <#${t.channelId}> — *${t.phase}*${ticketInfo} — "${t.problem.slice(0, 80)}..."`;
  });

  return [
    header("Orbit — Active Sessions"),
    textBlock(lines.join("\n")),
  ];
}

/** Format the /orbit config response */
export function configBlocks(config: {
  projectFolder: string;
  baseBranch?: string;
  linearTeamId?: string;
}): (KnownBlock | Block)[] {
  return [
    header("Orbit — Configuration"),
    textBlock([
      `*Project Folder:* \`${config.projectFolder}\``,
      `*Base Branch:* \`${config.baseBranch || "staging"}\``,
      `*Linear Team:* \`${config.linearTeamId || "not set"}\``,
    ].join("\n")),
  ];
}

/** Format QA verification results */
export function qaResultBlocks(ticket: LinearTicket, qa: QAResult): (KnownBlock | Block)[] {
  const icon = qa.buildPassed && qa.testsPassed ? ":white_check_mark:" : ":x:";
  const blocks: (KnownBlock | Block)[] = [
    textBlock(`${icon} *QA Verification — ${ticket.identifier}* (attempt ${qa.attempt}/${qa.maxAttempts})`),
    textBlock([
      `• Build: ${qa.buildPassed ? ":white_check_mark: Pass" : ":x: Fail"}`,
      `• Tests: ${qa.testsPassed ? ":white_check_mark: Pass" : ":x: Fail"}`,
      `• Lint: ${qa.lintPassed ? ":white_check_mark: Pass" : ":warning: Skip/Fail"}`,
    ].join("\n")),
  ];

  if (!qa.buildPassed && qa.buildOutput) {
    blocks.push(textBlock(`\`\`\`${qa.buildOutput.slice(0, 500)}\`\`\``));
  }
  if (!qa.testsPassed && qa.testOutput) {
    blocks.push(textBlock(`\`\`\`${qa.testOutput.slice(0, 500)}\`\`\``));
  }

  return blocks;
}

/** Format PR creation message */
export function prCreatedBlocks(ticket: LinearTicket, pr: PRInfo): (KnownBlock | Block)[] {
  return [
    textBlock(`:rocket: *PR Created — ${ticket.identifier}*\n<${pr.url}|${pr.repo}#${pr.number}> — ${pr.title}\nBranch: \`${pr.branch}\``),
  ];
}

/** Format deploy detection message */
export function deployBlocks(ticket: LinearTicket, stagingUrl: string): (KnownBlock | Block)[] {
  return [
    textBlock(`:globe_with_meridians: *Deployed to staging — ${ticket.identifier}*\n<${stagingUrl}|View on staging>`),
  ];
}

/** Format resumed session message */
export function resumeBlocks(threads: { channelId: string; problem: string; phase: string; ticketsDone: number; ticketsTotal: number }[]): (KnownBlock | Block)[] {
  if (threads.length === 0) {
    return [textBlock("No interrupted sessions found to resume.")];
  }

  const lines = threads.map((t) =>
    `• <#${t.channelId}> — *${t.phase}* — ${t.ticketsDone}/${t.ticketsTotal} tickets — "${t.problem.slice(0, 60)}..."`
  );

  return [
    header("Orbit — Resuming Sessions"),
    textBlock(lines.join("\n")),
    context("These sessions were interrupted and are being resumed automatically."),
  ];
}

/** Format assigned tickets list */
export function ticketListBlocks(tickets: LinearTicket[]): (KnownBlock | Block)[] {
  if (tickets.length === 0) {
    return [textBlock("No assigned tickets found in backlog/unstarted state.")];
  }

  const priorityIcons: Record<number, string> = {
    0: ":white_circle:",  // No priority
    1: ":red_circle:",    // Urgent
    2: ":large_orange_circle:", // High
    3: ":large_yellow_circle:", // Medium
    4: ":large_blue_circle:",   // Low
  };

  const lines = tickets.map((t, i) => {
    const icon = priorityIcons[t.priority] || ":white_circle:";
    const labels = t.labels.length > 0 ? ` \`${t.labels.map((l) => l.name).join("` `")}\`` : "";
    return `${icon} *${i + 1}.* <${t.url}|${t.identifier}> — ${t.title}${labels}`;
  });

  return [
    header(`Orbit — Your Tickets (${tickets.length})`),
    textBlock(lines.join("\n")),
    divider(),
    context("Use `/orbit work` to process all, or `/orbit work ENG-123 ENG-456` to pick specific ones."),
  ];
}

/** Format user config display */
export function userConfigBlocks(user: UserConfig | undefined, projectName: string): (KnownBlock | Block)[] {
  const mask = (val?: string) => val ? "••••" + val.slice(-4) : "_using project default_";
  const show = (val?: string) => val ? `\`${val}\`` : "_using project default_";

  const blocks: (KnownBlock | Block)[] = [
    header("Orbit — Your Config"),
    textBlock([
      `*Project:* \`${projectName}\``,
      `*Linear API Key:* ${mask(user?.linearApiKey)}`,
      `*Linear Team:* ${show(user?.linearTeamId)}`,
      `*Assignee ID:* ${show(user?.assigneeId)}`,
      `*Project Folder:* ${show(user?.projectFolder)}`,
      `*Base Branch:* ${show(user?.baseBranch)}`,
      `*Anthropic Key:* ${mask(user?.anthropicApiKey)}`,
    ].join("\n")),
    divider(),
    context("Set: `/orbit me set <field> <value>` | Clear: `/orbit me clear <field>` | Reset all: `/orbit me reset`"),
  ];

  return blocks;
}

/** Format "work started" message */
export function workStartedBlocks(tickets: LinearTicket[]): (KnownBlock | Block)[] {
  const lines = tickets.map((t) =>
    `:hourglass_flowing_sand: <${t.url}|${t.identifier}> — ${t.title}`
  );

  return [
    header("Orbit — Starting Work"),
    textBlock(`Processing *${tickets.length}* ticket(s):\n${lines.join("\n")}`),
  ];
}
