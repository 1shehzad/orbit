import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { LinearClient } from "./linear.js";
import { GitManager } from "./git.js";
import { createAgent } from "./agent-factory.js";
import type { AIAgent } from "./agent-factory.js";
import type { LinearTicket, TicketStatus, TestCase, QAResult, PRInfo, ProjectConfig } from "./types.js";

export interface PipelineEvents {
  status_update: [status: TicketStatus];
  activity_log: [entry: { type: string; content: string }];
  processing_started: [data: { count: number }];
  all_complete: [data: { count: number }];
  ticket_complete: [data: { ticketId: string }];
  fix_complete: [data: { ticketId: string }];
  qa_result: [data: { ticketId: string; result: QAResult }];
  pr_created: [data: { ticketId: string; pr: PRInfo }];
  error: [data: { message: string }];
}

export class TicketPipeline extends EventEmitter<PipelineEvents> {
  private linear: LinearClient;
  private git: GitManager;
  private claude: AIAgent;
  private config: ProjectConfig;
  private _aborted = false;

  constructor(config: ProjectConfig) {
    super();
    this.config = config;
    this.linear = new LinearClient(config.linearApiKey);
    this.git = new GitManager(config.projectFolder);
    this.claude = createAgent(config.aiProvider ?? "claude", config.anthropicApiKey);
  }

  /** Access the Linear client directly (for ticket creation, etc.) */
  getLinearClient(): LinearClient {
    return this.linear;
  }

  /**
   * Abort all running operations: kills Claude processes and stops ticket loop.
   */
  abort() {
    this._aborted = true;
    this.claude.killAll();
    this.log("system", "Pipeline aborted — all AI processes killed");
  }

  private updateStatus(ticketId: string, phase: TicketStatus["phase"], progress: string, extra?: Partial<TicketStatus>) {
    this.emit("status_update", { ticketId, phase, progress, ...extra });
  }

  private log(type: string, content: string) {
    this.emit("activity_log", { type, content });
  }

  async fetchAssignedTickets(): Promise<LinearTicket[]> {
    const assigneeId = this.config.assigneeId || (await this.linear.getMyId());
    return this.linear.getAssignedTickets(assigneeId);
  }

  async getWorkflowStates(): Promise<{ id: string; name: string; type: string }[]> {
    if (!this.config.linearTeamId) return [];
    return this.linear.getWorkflowStates(this.config.linearTeamId);
  }

  /**
   * Process selected tickets one by one. Each ticket gets its own Claude prompt.
   * Flow per ticket:
   * 1. Pull from staging
   * 2. Move ticket to In Progress
   * 3. Claude resolves ticket (implement + build + test + create PR + merge)
   * 4. Generate manual test case
   * 5. Move ticket to In Review
   */
  async processAllTickets(tickets: LinearTicket[]): Promise<void> {
    const baseBranch = this.config.baseBranch || "staging";
    const repos = this.config.repos?.length ? this.config.repos : await this.git.discoverRepos();

    // Discover active repos once
    this.log("system", `Discovering repos with "${baseBranch}" branch...`);
    const activeRepos: string[] = [];
    for (const repo of repos) {
      try {
        await this.git.pullFromBase(repo, baseBranch);
        activeRepos.push(repo);
        this.log("git", `Pulled ${baseBranch} for ${basename(repo)}`);
      } catch {
        this.log("warning", `${basename(repo)} has no "${baseBranch}" branch, skipping`);
      }
    }
    if (activeRepos.length === 0) {
      this.log("error", `No repos have a "${baseBranch}" branch`);
      return;
    }

    const repoNames = activeRepos.map((r) => basename(r));

    this.log("system", `Processing ${tickets.length} tickets sequentially...`);
    this.emit("processing_started", { count: tickets.length });

    for (let i = 0; i < tickets.length; i++) {
      if (this._aborted) {
        this.log("system", "Aborted — skipping remaining tickets");
        break;
      }

      const ticket = tickets[i];
      this.log("system", `\n--- Ticket ${i + 1}/${tickets.length}: ${ticket.identifier} — ${ticket.title} ---`);

      try {
        await this.processSingleTicket(ticket, baseBranch, activeRepos, repoNames);
      } catch (err) {
        if (this._aborted) break;
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.log("error", `Failed ${ticket.identifier}: ${errorMsg}`);
        this.updateStatus(ticket.id, "error", errorMsg);
      }
    }

    this.log("system", "All tickets processed");
    this.emit("all_complete", { count: tickets.length });
  }

  private async processSingleTicket(
    ticket: LinearTicket,
    baseBranch: string,
    activeRepos: string[],
    repoNames: string[],
  ): Promise<void> {
    const branchName = `feature/${ticket.identifier.toLowerCase()}`;
    const maxQARetries = 3;

    // Step 1: Pull latest
    this.updateStatus(ticket.id, "pulling", "Pulling latest...");
    for (const repo of activeRepos) {
      try {
        await this.git.pullFromBase(repo, baseBranch);
      } catch {
        // Already pulled initially, non-critical
      }
    }

    // Step 2: Move to In Progress in Linear
    this.updateStatus(ticket.id, "developing", "Moving to In Progress...");
    await this.moveTicketToState(ticket, "In Progress");

    // Step 3: Claude implements (no merge — just branch + push)
    this.updateStatus(ticket.id, "developing", "Claude is working...");
    this.log("system", `Sending ${ticket.identifier} to Claude...`);

    const desc = ticket.description || "No description provided";
    const prompt = `You have ONE Linear ticket to implement completely.

WORKSPACE: You are in a project root with these repos: ${repoNames.join(", ")}
Each subfolder is its own git repo. BASE BRANCH: ${baseBranch}

TICKET: [${ticket.identifier}] ${ticket.title}
Description: ${desc}

Do these steps in order:

1. CHECKOUT: git checkout ${baseBranch} in all relevant repos, then git pull origin ${baseBranch}
2. CREATE BRANCH: git checkout -b ${branchName} in all relevant repos
3. IMPLEMENT: Make the code changes to resolve this ticket across all relevant repos
4. BUILD: Run "npm run build" in changed repos — fix any build errors until it passes
5. TEST: Run "npm test -- --passWithNoTests" in changed repos — fix any test failures until they pass
6. COMMIT: git add -A && git commit -m "feat(${ticket.identifier}): ${ticket.title}" in all changed repos
7. PUSH: git push -u origin ${branchName} in all changed repos

DO NOT merge to ${baseBranch}. A PR will be created automatically after QA verification.

After completing ALL steps above, output the completion marker and a manual test case.

MANDATORY OUTPUT — you MUST output this at the end:

===TICKET_DONE:${ticket.identifier}===
\`\`\`json
{"testCases": [{"id": "tc-1", "title": "Brief manual QA test title", "steps": ["Step 1: Do something specific", "Step 2: Verify expected result"], "route": "/relevant-route-if-ui"}]}
\`\`\`

The test case is for a human QA tester to manually verify this ticket works. Rules:
- Exactly 1 test case (max 2 if the ticket has distinct UI + API changes)
- 2-3 short, specific steps
- Include a "route" only if the change is UI-related

IMPORTANT:
- Do NOT ask questions. Just implement.
- If the ticket is unclear, use your best judgment.
- NEVER skip the ===TICKET_DONE=== marker and test case JSON.`;

    const result = await this.claude.run(
      prompt,
      this.config.projectFolder,
      (line) => {
        this.log("progress", line);
        this.updateStatus(ticket.id, "developing", line);
      },
      (event) => {
        this.handleClaudeEvent(event, ticket);
      },
    );

    if (!result.success || !result.output) {
      const errorMsg = result.error || "AI agent failed";
      this.log("error", `${ticket.identifier} failed: ${errorMsg}`);
      this.updateStatus(ticket.id, "error", errorMsg);
      return;
    }

    const testCases = this.parseTicketOutput(result.output, ticket);

    // Step 4: Automated QA verification with retries
    const qaResult = await this.runQAVerification(ticket, branchName, activeRepos, maxQARetries);
    this.emit("qa_result", { ticketId: ticket.id, result: qaResult });

    if (!qaResult.buildPassed || !qaResult.testsPassed) {
      this.log("error", `${ticket.identifier} failed QA after ${qaResult.attempt} attempt(s)`);
      this.updateStatus(ticket.id, "error", `QA failed: ${!qaResult.buildPassed ? "build" : "tests"} failing after ${qaResult.attempt} retries`);
      return;
    }

    // Step 5: Create PR
    this.updateStatus(ticket.id, "creating_pr", "Creating pull request...");
    const prInfos: PRInfo[] = [];

    for (const repo of activeRepos) {
      try {
        const currentBranch = await this.git.getCurrentBranch(repo);

        // Skip repos where Claude didn't create the feature branch
        if (currentBranch !== branchName) {
          // Try to checkout the branch — if it doesn't exist, this repo wasn't touched
          try {
            await this.git.checkoutBranch(repo, branchName);
          } catch {
            continue; // Branch doesn't exist in this repo, skip
          }
        }

        const repoName = basename(repo);
        const prBody = this.buildPRDescription(ticket, desc, testCases, qaResult);

        const pr = await this.git.createPR(repo, branchName, baseBranch, `feat(${ticket.identifier}): ${ticket.title}`, prBody);
        const prInfo: PRInfo = {
          url: pr.url,
          number: pr.number,
          title: ticket.title,
          branch: branchName,
          repo: repoName,
        };
        prInfos.push(prInfo);
        this.emit("pr_created", { ticketId: ticket.id, pr: prInfo });
        this.log("success", `PR created for ${repoName}: ${pr.url}`);
      } catch (err) {
        this.log("warning", `Could not create PR in ${basename(repo)}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Add PR links as comment on Linear ticket
    if (prInfos.length > 0) {
      const prLinks = prInfos.map((p) => `- [${p.repo}#${p.number}](${p.url})`).join("\n");
      try {
        await this.linear.addComment(ticket.id, `**Pull Request(s) created:**\n${prLinks}\n\n**QA Status:** Build ✅ | Tests ✅ | Lint ${qaResult.lintPassed ? "✅" : "⚠️"}`);
      } catch {}
    }

    // Update status
    if (testCases) {
      this.updateStatus(ticket.id, "done", "Complete — PR created, awaiting review", { testCases });
    } else {
      this.updateStatus(ticket.id, "done", "Complete — PR created, awaiting review");
    }

    // Move to In Review
    try {
      await this.moveTicketToState(ticket, "In Review");
      this.log("success", `${ticket.identifier} → In Review`);
    } catch (err) {
      this.log("warning", `Could not move ${ticket.identifier} to In Review: ${err instanceof Error ? err.message : err}`);
    }

    this.emit("ticket_complete", { ticketId: ticket.id });
  }

  private buildPRDescription(
    ticket: LinearTicket,
    description: string,
    testCases: TestCase[] | null,
    qaResult: QAResult,
  ): string {
    const lines: string[] = [
      `## Summary`,
      ``,
      `Resolves [${ticket.identifier}](${ticket.url}): ${ticket.title}`,
      ``,
      description.length > 500 ? description.slice(0, 500) + "..." : description,
      ``,
      `## QA Verification`,
      ``,
      `| Check | Status |`,
      `|-------|--------|`,
      `| Build | ${qaResult.buildPassed ? "✅ Pass" : "❌ Fail"} |`,
      `| Tests | ${qaResult.testsPassed ? "✅ Pass" : "❌ Fail"} |`,
      `| Lint  | ${qaResult.lintPassed ? "✅ Pass" : "⚠️ Skipped/Fail"} |`,
    ];

    if (qaResult.attempt > 1) {
      lines.push(``, `> Auto-fixed after ${qaResult.attempt} attempt(s)`);
    }

    if (testCases && testCases.length > 0) {
      lines.push(``, `## Manual Test Cases`);
      for (const tc of testCases) {
        lines.push(``, `### ${tc.title}${tc.route ? ` (\`${tc.route}\`)` : ""}`);
        for (let i = 0; i < tc.steps.length; i++) {
          lines.push(`${i + 1}. ${tc.steps[i]}`);
        }
      }
    }

    lines.push(``, `---`, `🤖 Generated by Orbit`);
    return lines.join("\n");
  }

  private async runQAVerification(
    ticket: LinearTicket,
    branchName: string,
    activeRepos: string[],
    maxAttempts: number,
  ): Promise<QAResult> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.updateStatus(ticket.id, "qa_verifying", `QA verification (attempt ${attempt}/${maxAttempts})...`);
      this.log("phase", `QA verification attempt ${attempt}/${maxAttempts} for ${ticket.identifier}`);

      let buildPassed = true;
      let buildOutput = "";
      let testsPassed = true;
      let testOutput = "";
      let lintPassed = true;
      let lintOutput = "";

      for (const repo of activeRepos) {
        // Ensure we're on the feature branch before running checks
        const currentBranch = await this.git.getCurrentBranch(repo);
        if (currentBranch !== branchName) {
          try {
            await this.git.checkoutBranch(repo, branchName);
          } catch {
            continue; // Branch doesn't exist in this repo, skip
          }
        }

        // Build
        const buildResult = await this.git.runBuild(repo);
        if (!buildResult.success) {
          buildPassed = false;
          buildOutput += `[${basename(repo)}] ${buildResult.output}\n`;
        }

        // Tests
        const testResult = await this.git.runTests(repo);
        if (!testResult.success) {
          testsPassed = false;
          testOutput += `[${basename(repo)}] ${testResult.output}\n`;
        }

        // Lint
        const lintResult = await this.git.runLint(repo);
        if (!lintResult.success) {
          lintPassed = false;
          lintOutput += `[${basename(repo)}] ${lintResult.output}\n`;
        }
      }

      const qaResult: QAResult = {
        buildPassed,
        buildOutput: buildOutput || undefined,
        testsPassed,
        testOutput: testOutput || undefined,
        lintPassed,
        lintOutput: lintOutput || undefined,
        selfReviewPassed: buildPassed && testsPassed,
        attempt,
        maxAttempts,
      };

      if (buildPassed && testsPassed) {
        this.log("success", `${ticket.identifier} passed QA on attempt ${attempt}`);
        return qaResult;
      }

      // Auto-fix retry if not the last attempt
      if (attempt < maxAttempts) {
        this.log("warning", `${ticket.identifier} QA failed, attempting auto-fix (${attempt}/${maxAttempts})...`);
        this.updateStatus(ticket.id, "developing", `Auto-fixing QA failures (attempt ${attempt + 1})...`);

        const fixErrors: string[] = [];
        if (!buildPassed) fixErrors.push(`BUILD ERRORS:\n${buildOutput}`);
        if (!testsPassed) fixErrors.push(`TEST FAILURES:\n${testOutput}`);
        if (!lintPassed) fixErrors.push(`LINT ERRORS:\n${lintOutput}`);

        const fixPrompt = `You previously implemented ticket [${ticket.identifier}] ${ticket.title} but QA verification failed.

Fix these errors on branch "${branchName}":

${fixErrors.join("\n\n")}

Steps:
1. Fix all errors in the code
2. Run "npm run build" — ensure it passes
3. Run "npm test -- --passWithNoTests" — ensure tests pass
4. Commit the fix: git add -A && git commit -m "fix(${ticket.identifier}): address QA failures"
5. Push: git push origin ${branchName}

Output ===FIX_DONE:${ticket.identifier}=== when complete.`;

        await this.claude.run(
          fixPrompt,
          this.config.projectFolder,
          (line) => { this.log("progress", line); },
          (event) => { this.handleClaudeEvent(event, ticket); },
        );
      }
    }

    // All attempts exhausted
    return {
      buildPassed: false,
      testsPassed: false,
      lintPassed: false,
      selfReviewPassed: false,
      attempt: maxAttempts,
      maxAttempts,
    };
  }

  private parseTicketOutput(output: string, ticket: LinearTicket): TestCase[] | null {
    // Look for the TICKET_DONE marker
    const markerIdx = output.indexOf(`===TICKET_DONE:${ticket.identifier}===`);
    if (markerIdx === -1) {
      // Try parsing from the full output
      return this.extractTestCases(output);
    }

    const afterMarker = output.slice(markerIdx);
    return this.extractTestCases(afterMarker);
  }

  private extractTestCases(text: string): TestCase[] | null {
    const jsonMatch = text.match(/```json\s*(\{[\s\S]*?\})\s*```/) ||
                      text.match(/(\{"testCases"[\s\S]*?\})\s/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.testCases && Array.isArray(parsed.testCases)) {
        return parsed.testCases.map((tc: TestCase) => ({
          ...tc,
          passed: false,
        }));
      }
    } catch {}
    return null;
  }

  private handleClaudeEvent(event: Record<string, unknown>, ticket: LinearTicket) {
    const type = event.type as string;

    if (type === "assistant" && event.message) {
      const msg = event.message as { content?: Array<{ type: string; text?: string }> };
      if (msg.content) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            const text = block.text.trim();
            if (text && !text.startsWith("===") && text.length > 5) {
              this.log("thinking", text.length > 200 ? text.slice(0, 200) + "..." : text);
            }
          }
        }
      }
    }

    if (type === "tool_use") {
      const name = event.name as string;
      const input = event.input as Record<string, unknown>;
      if (name === "Bash" || name === "bash") {
        const cmd = (input.command || input.cmd || "") as string;
        this.log("tool", `$ ${cmd.length > 150 ? cmd.slice(0, 150) + "..." : cmd}`);
        this.detectPhaseFromCommand(cmd, ticket);
      } else if (name === "Edit" || name === "edit" || name === "Write" || name === "write") {
        const file = (input.file_path || input.path || "") as string;
        this.log("tool", `Editing ${file}`);
      } else if (name === "Read" || name === "read") {
        const file = (input.file_path || input.path || "") as string;
        this.log("tool", `Reading ${file}`);
      } else {
        this.log("tool", `${name}`);
      }
    }
  }

  private detectPhaseFromCommand(cmd: string, ticket: LinearTicket) {
    if (cmd.includes("npm run build") || cmd.includes("npx tsc")) {
      this.updateStatus(ticket.id, "building", "Building...");
      this.log("phase", "Building...");
    } else if (cmd.includes("npm test") || cmd.includes("npx vitest") || cmd.includes("npx jest")) {
      this.updateStatus(ticket.id, "testing", "Running tests...");
      this.log("phase", "Testing...");
    } else if (cmd.includes("git merge") || cmd.includes("git push")) {
      this.updateStatus(ticket.id, "merging", "Merging...");
      this.log("phase", "Merging...");
    }
  }

  // Called when user checks all manual test checkboxes — move to Done
  async moveTicketToDone(ticketId: string, ticketTitle: string): Promise<void> {
    if (!this.config.linearTeamId) return;
    const states = await this.linear.getWorkflowStates(this.config.linearTeamId);
    const doneState = states.find((s) => s.type === "completed");
    if (doneState) {
      await this.linear.moveTicket(ticketId, doneState.id);
      await this.linear.addComment(
        ticketId,
        `Development and manual QA verification complete for **${ticketTitle}**. All checks passed.`,
      );
    }
  }

  /**
   * Called when user reports an error during manual testing.
   * Sends the error to Claude to fix, then returns the result.
   */
  async fixTicketError(
    ticket: LinearTicket,
    errorNote: string,
  ): Promise<void> {
    const baseBranch = this.config.baseBranch || "staging";
    const repos = this.config.repos?.length ? this.config.repos : await this.git.discoverRepos();
    const repoNames = repos.map((r) => basename(r));

    this.log("system", `Fixing ${ticket.identifier}: ${errorNote}`);
    this.updateStatus(ticket.id, "developing", "Claude is fixing the reported issue...");

    const prompt = `A manual QA tester found an issue with ticket [${ticket.identifier}] ${ticket.title}.

WORKSPACE: You are in a project root with these repos: ${repoNames.join(", ")}
Each subfolder is its own git repo. BASE BRANCH: ${baseBranch}

THE REPORTED ERROR:
${errorNote}

ORIGINAL TICKET DESCRIPTION:
${ticket.description || "No description"}

Fix this issue. The code is already on the ${baseBranch} branch. Steps:
1. Identify and fix the issue in the relevant files
2. Run "npm run build" in changed repos — fix any build errors
3. Run "npm test -- --passWithNoTests" in changed repos — fix any failures
4. Commit: git add -A && git commit -m "fix(${ticket.identifier}): address QA feedback"
5. Push: git push origin ${baseBranch}

After fixing, output the completion marker:
===TICKET_DONE:${ticket.identifier}===
\`\`\`json
{"testCases": [{"id": "tc-1", "title": "Verify the fix", "steps": ["Step 1: Reproduce the original issue", "Step 2: Verify it is now resolved"], "route": "/relevant-route"}]}
\`\`\`

Do NOT ask questions. Just fix it.`;

    const result = await this.claude.run(
      prompt,
      this.config.projectFolder,
      (line) => {
        this.log("progress", line);
        this.updateStatus(ticket.id, "developing", line);
      },
      (event) => {
        this.handleClaudeEvent(event, ticket);
      },
    );

    if (result.success && result.output) {
      const testCases = this.parseTicketOutput(result.output, ticket);
      if (testCases) {
        this.updateStatus(ticket.id, "done", "Fix complete — re-verify manually", { testCases });
      } else {
        this.updateStatus(ticket.id, "done", "Fix complete — re-verify manually");
      }
      this.log("success", `${ticket.identifier} — fix applied, please re-test`);
      this.emit("fix_complete", { ticketId: ticket.id });
    } else {
      const errorMsg = result.error || "AI agent failed to fix";
      this.log("error", `${ticket.identifier} fix failed: ${errorMsg}`);
      this.updateStatus(ticket.id, "error", errorMsg);
    }
  }

  private async moveTicketToState(ticket: LinearTicket, stateTypeOrName: string): Promise<boolean> {
    try {
      if (!this.config.linearTeamId) {
        this.log("warning", `No Linear Team ID configured — cannot move ${ticket.identifier}`);
        return false;
      }
      const states = await this.linear.getWorkflowStates(this.config.linearTeamId);
      // Match by type first, then by name (case-insensitive)
      const targetState = states.find((s) => s.type === stateTypeOrName)
        || states.find((s) => s.name.toLowerCase() === stateTypeOrName.toLowerCase());
      if (!targetState) {
        this.log("warning", `No "${stateTypeOrName}" state found in Linear for ${ticket.identifier}`);
        return false;
      }
      await this.linear.moveTicket(ticket.id, targetState.id);
      this.log("system", `${ticket.identifier} → ${targetState.name}`);
      return true;
    } catch (err) {
      this.log("warning", `Failed to move ${ticket.identifier}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
