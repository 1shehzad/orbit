import type { App } from "@slack/bolt";
import type { ProjectConfig } from "@orbit/core";
import { LinearClient } from "@orbit/core";
import { createThread, getAllActiveThreads, loadPersistedThreads } from "../threads.js";
import {
  globalStatusBlocks, configBlocks, resumeBlocks, textBlock, header, divider, context,
  ticketListBlocks, userConfigBlocks, workStartedBlocks, statusBlocks,
} from "../slack.js";
import {
  resolveProjectConfig, getAllProjects,
  upsertProject, mapChannel, unmapChannel, setDefaultProject,
  removeProject, setProjectField,
} from "../projects.js";
import {
  getUserConfig, mergeUserConfig, setUserField, clearUserField, clearUserConfig,
} from "../users.js";
import { runPipeline } from "../runner.js";
import { generateStandup } from "../standup.js";
import { checkPendingReviews } from "../reviewer.js";
import { getAllReposSummary } from "../monitor.js";
import { getInteractionsSince, formatCatchUp } from "../interaction-log.js";
import { getPendingTasks, cancelTask } from "../scheduler.js";
import { learnCodeStyle } from "../style-learner.js";
import { generateMeetingPrep } from "../meeting-prep.js";
import type { KnownBlock, Block } from "@slack/types";
import type { LinearTicket } from "@orbit/core";
import type { BotConfig } from "../config.js";

/**
 * Register the /orbit slash command.
 * Subcommands: status, config, project, tickets, work, me, resume, help
 */
export function registerCommands(app: App, _defaultConfig: ProjectConfig, botConfig?: BotConfig) {
  app.command("/orbit", async ({ command, ack, respond }) => {
    await ack();

    // Guard: only respond to allowed users
    if (botConfig?.allowedUserIds.length && !botConfig.allowedUserIds.includes(command.user_id)) {
      await respond({ text: "You don't have permission to use Orbit.", response_type: "ephemeral" });
      return;
    }

    const args = command.text.trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase() || "help";
    const userId = command.user_id;

    switch (subcommand) {
      case "status": {
        const activeThreads = getAllActiveThreads();
        await respond({
          blocks: globalStatusBlocks(activeThreads),
          text: `${activeThreads.length} active session(s)`,
          response_type: "ephemeral",
        });
        break;
      }

      // ─── /orbit tickets ───
      case "tickets": {
        const channelConfig = resolveProjectConfig(command.channel_id);
        const config = mergeUserConfig(channelConfig, userId);

        try {
          const linear = new LinearClient(config.linearApiKey);
          const assigneeId = config.assigneeId || (await linear.getMyId());
          const tickets = await linear.getAssignedTickets(assigneeId);

          await respond({
            blocks: ticketListBlocks(tickets),
            text: `${tickets.length} assigned ticket(s)`,
            response_type: "ephemeral",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({
            text: `:x: Failed to fetch tickets: ${msg}\n\nMake sure your Linear API key is set. Use \`/orbit me set linear_key <key>\` or set \`LINEAR_API_KEY\` in env.`,
            response_type: "ephemeral",
          });
        }
        break;
      }

      // ─── /orbit work [identifiers...] ───
      case "work": {
        const channelConfig = resolveProjectConfig(command.channel_id);
        const config = mergeUserConfig(channelConfig, userId);
        const identifiers = args.slice(1).map((a) => a.toUpperCase());

        try {
          const linear = new LinearClient(config.linearApiKey);
          const assigneeId = config.assigneeId || (await linear.getMyId());
          let tickets = await linear.getAssignedTickets(assigneeId);

          // Filter to specific identifiers if provided
          if (identifiers.length > 0) {
            tickets = tickets.filter((t) => identifiers.includes(t.identifier));
            if (tickets.length === 0) {
              await respond({
                text: `:x: None of the specified tickets (${identifiers.join(", ")}) were found in your backlog/unstarted queue.`,
                response_type: "ephemeral",
              });
              break;
            }
          }

          if (tickets.length === 0) {
            await respond({
              text: "No assigned tickets in backlog/unstarted state. Nothing to work on.",
              response_type: "ephemeral",
            });
            break;
          }

          // Post in channel (visible to everyone)
          const threadTs = (Date.now() / 1000).toFixed(6); // fallback
          const startMsg = await app.client.chat.postMessage({
            channel: command.channel_id,
            blocks: workStartedBlocks(tickets),
            text: `Orbit — Working on ${tickets.length} ticket(s)`,
          });

          const actualTs = startMsg.ts || threadTs;

          // Create a thread state for this work session
          const thread = createThread(
            command.channel_id,
            actualTs,
            userId,
            `Working on ${tickets.length} assigned ticket(s): ${tickets.map((t) => t.identifier).join(", ")}`,
          );
          thread.tickets = tickets;

          // Post status message in thread
          const statusResult = await app.client.chat.postMessage({
            channel: command.channel_id,
            thread_ts: actualTs,
            blocks: statusBlocks(thread),
            text: "Orbit — Status",
          });
          thread.statusMessageTs = statusResult.ts;

          await respond({
            text: `:white_check_mark: Started processing ${tickets.length} ticket(s). Check the thread for progress.`,
            response_type: "ephemeral",
          });

          // Run the pipeline
          runPipeline(app, thread, config).catch((err) => {
            console.error("Work pipeline error:", err);
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({
            text: `:x: Failed to start work: ${msg}`,
            response_type: "ephemeral",
          });
        }
        break;
      }

      // ─── /orbit me ───
      case "me": {
        const action = args[1]?.toLowerCase();

        if (!action || action === "show") {
          const user = getUserConfig(userId);
          const projects = getAllProjects();
          const currentProject = projects.find((p) => p.channels.includes(command.channel_id));
          await respond({
            blocks: userConfigBlocks(user, currentProject?.name || "default"),
            text: "Your Orbit config",
            response_type: "ephemeral",
          });
          break;
        }

        if (action === "set") {
          const field = args[2];
          const value = args.slice(3).join(" ");
          if (!field || !value) {
            await respond({
              text: "Usage: `/orbit me set <field> <value>`\nFields: `linear_key`, `linear_team`, `assignee`, `folder`, `branch`, `anthropic_key`",
              response_type: "ephemeral",
            });
            break;
          }

          const err = await setUserField(userId, field, value);
          if (err) {
            await respond({ text: `:x: ${err}`, response_type: "ephemeral" });
          } else {
            await respond({
              text: `:white_check_mark: Set \`${field}\` for your user config.`,
              response_type: "ephemeral",
            });
          }
          break;
        }

        if (action === "clear") {
          const field = args[2];
          if (!field) {
            await respond({
              text: "Usage: `/orbit me clear <field>` — reverts a field to the project default.",
              response_type: "ephemeral",
            });
            break;
          }
          const err = await clearUserField(userId, field);
          if (err) {
            await respond({ text: `:x: ${err}`, response_type: "ephemeral" });
          } else {
            await respond({
              text: `:white_check_mark: Cleared \`${field}\` — will use project default.`,
              response_type: "ephemeral",
            });
          }
          break;
        }

        if (action === "reset") {
          await clearUserConfig(userId);
          await respond({
            text: `:white_check_mark: All your personal config has been reset. Using project defaults.`,
            response_type: "ephemeral",
          });
          break;
        }

        await respond({
          text: [
            "*User config subcommands:*",
            "• `/orbit me` — Show your config",
            "• `/orbit me set <field> <value>` — Set a personal override",
            "• `/orbit me clear <field>` — Clear a field (use project default)",
            "• `/orbit me reset` — Reset all personal config",
            "",
            "*Fields:* `linear_key`, `linear_team`, `assignee`, `folder`, `branch`, `anthropic_key`",
          ].join("\n"),
          response_type: "ephemeral",
        });
        break;
      }

      // ─── /orbit config ───
      case "config": {
        const action = args[1]?.toLowerCase();

        if (!action || action === "show") {
          const channelConfig = resolveProjectConfig(command.channel_id);
          const projects = getAllProjects();
          const currentProject = projects.find((p) =>
            p.channels.includes(command.channel_id),
          );

          const blocks: (KnownBlock | Block)[] = [
            header("Orbit — Configuration"),
            textBlock([
              `*Active project for this channel:* \`${currentProject?.name || "default"}\``,
              `*Project Folder:* \`${channelConfig.projectFolder}\``,
              `*Base Branch:* \`${channelConfig.baseBranch || "staging"}\``,
              `*Linear Team:* \`${channelConfig.linearTeamId || "not set"}\``,
              `*Linear API Key:* \`${channelConfig.linearApiKey ? "••••" + channelConfig.linearApiKey.slice(-4) : "not set"}\``,
            ].join("\n")),
          ];

          await respond({ blocks, text: "Orbit configuration", response_type: "ephemeral" });
          break;
        }

        if (action === "set") {
          const field = args[2];
          const projectFlag = args.indexOf("--project");
          const projectName = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
          const valueEnd = projectFlag >= 0 ? projectFlag : args.length;
          const value = args.slice(3, valueEnd).join(" ");

          if (!field || !value) {
            await respond({
              text: "Usage: `/orbit config set <field> <value> [--project <name>]`\nFields: `linear_key`, `linear_team`, `folder`, `branch`, `anthropic_key`, `assignee`",
              response_type: "ephemeral",
            });
            break;
          }

          const targetProject = projectName || (() => {
            const projects = getAllProjects();
            const mapped = projects.find((p) => p.channels.includes(command.channel_id));
            return mapped?.name || "default";
          })();

          const err = await setProjectField(targetProject, field, value);
          if (err) {
            await respond({ text: `:x: ${err}`, response_type: "ephemeral" });
          } else {
            await respond({
              text: `:white_check_mark: Set \`${field}\` on project \`${targetProject}\`.`,
              response_type: "ephemeral",
            });
          }
          break;
        }

        await respond({
          text: [
            "*Config subcommands:*",
            "• `/orbit config` — Show current config",
            "• `/orbit config set <field> <value>` — Update a config field",
            "• `/orbit config set <field> <value> --project <name>` — Update for specific project",
            "",
            "*Fields:* `linear_key`, `linear_team`, `folder`, `branch`, `anthropic_key`, `assignee`",
          ].join("\n"),
          response_type: "ephemeral",
        });
        break;
      }

      // ─── /orbit project ───
      case "project": {
        const action = args[1]?.toLowerCase();

        if (!action || action === "list") {
          const projects = getAllProjects();
          const lines = projects.map((p) => {
            const channels = p.channels.length > 0
              ? p.channels.map((c) => `<#${c}>`).join(", ")
              : "_no channels_";
            return `• *${p.name}* — \`${p.config.projectFolder}\` — ${channels}`;
          });
          await respond({
            blocks: [
              header("Orbit — Projects"),
              textBlock(lines.join("\n")),
              context("Use `/orbit project add <name> <folder>` to add a project."),
            ],
            text: `${projects.length} project(s)`,
            response_type: "ephemeral",
          });
          break;
        }

        if (action === "add") {
          const name = args[2];
          const folder = args[3];
          if (!name || !folder) {
            await respond({
              text: "Usage: `/orbit project add <name> <project_folder> [--branch <branch>] [--team <team_id>]`",
              response_type: "ephemeral",
            });
            break;
          }
          const branchIdx = args.indexOf("--branch");
          const teamIdx = args.indexOf("--team");
          const branch = branchIdx >= 0 ? args[branchIdx + 1] : undefined;
          const team = teamIdx >= 0 ? args[teamIdx + 1] : undefined;
          await upsertProject(name, { projectFolder: folder, baseBranch: branch, linearTeamId: team });
          await respond({
            text: `:white_check_mark: Project \`${name}\` added with folder \`${folder}\`.`,
            response_type: "ephemeral",
          });
          break;
        }

        if (action === "remove") {
          const name = args[2];
          if (!name) { await respond({ text: "Usage: `/orbit project remove <name>`", response_type: "ephemeral" }); break; }
          const ok = await removeProject(name);
          await respond({
            text: ok ? `:white_check_mark: Project \`${name}\` removed.` : `:x: Cannot remove \`${name}\`.`,
            response_type: "ephemeral",
          });
          break;
        }

        if (action === "map") {
          const name = args[2];
          const channelArg = args[3];
          let channelId = command.channel_id;
          if (channelArg) { const m = channelArg.match(/<#([A-Z0-9]+)/); if (m) channelId = m[1]; }
          if (!name) { await respond({ text: "Usage: `/orbit project map <name> [#channel]`", response_type: "ephemeral" }); break; }
          const ok = await mapChannel(channelId, name);
          await respond({
            text: ok ? `:white_check_mark: <#${channelId}> mapped to \`${name}\`.` : `:x: Project \`${name}\` not found.`,
            response_type: "ephemeral",
          });
          break;
        }

        if (action === "unmap") {
          const channelArg = args[2];
          let channelId = command.channel_id;
          if (channelArg) { const m = channelArg.match(/<#([A-Z0-9]+)/); if (m) channelId = m[1]; }
          await unmapChannel(channelId);
          await respond({ text: `:white_check_mark: <#${channelId}> unmapped.`, response_type: "ephemeral" });
          break;
        }

        if (action === "default") {
          const name = args[2];
          if (!name) { await respond({ text: "Usage: `/orbit project default <name>`", response_type: "ephemeral" }); break; }
          const ok = await setDefaultProject(name);
          await respond({
            text: ok ? `:white_check_mark: Default project set to \`${name}\`.` : `:x: Project \`${name}\` not found.`,
            response_type: "ephemeral",
          });
          break;
        }

        await respond({
          text: [
            "*Project subcommands:*",
            "• `/orbit project` — List all projects",
            "• `/orbit project add <name> <folder> [--branch <b>] [--team <t>]`",
            "• `/orbit project remove <name>`",
            "• `/orbit project map <name> [#channel]`",
            "• `/orbit project unmap [#channel]`",
            "• `/orbit project default <name>`",
          ].join("\n"),
          response_type: "ephemeral",
        });
        break;
      }

      // ─── /orbit resume ───
      case "resume": {
        const restored = await loadPersistedThreads();
        const resumable = restored.filter((t) => t.phase === "executing" && t.tickets.length > 0);
        const summaries = resumable.map((t) => ({
          channelId: t.channelId, problem: t.problem, phase: t.phase,
          ticketsDone: t.completedTicketIds.size, ticketsTotal: t.tickets.length,
        }));
        await respond({ blocks: resumeBlocks(summaries), text: `${resumable.length} session(s)`, response_type: "ephemeral" });

        for (const thread of resumable) {
          try {
            const projectConfig = resolveProjectConfig(thread.channelId);
            const config = mergeUserConfig(projectConfig, thread.userId);
            await app.client.chat.postMessage({
              channel: thread.channelId, thread_ts: thread.threadTs,
              text: `:arrows_counterclockwise: Resuming — ${thread.completedTicketIds.size}/${thread.tickets.length} done.`,
            });
            runPipeline(app, thread, config).catch((err) => console.error("Resume error:", err));
          } catch (err) { console.error("Resume failed:", err); }
        }
        break;
      }

      // ─── /orbit scheduled ───
      case "scheduled": {
        const action = args[1]?.toLowerCase();
        if (action === "cancel" && args[2]) {
          const ok = await cancelTask(args[2]);
          await respond({
            text: ok ? `:white_check_mark: Task cancelled.` : `:x: Task not found or already executed.`,
            response_type: "ephemeral",
          });
          break;
        }

        const pending = getPendingTasks();
        if (pending.length === 0) {
          await respond({ text: "No scheduled tasks.", response_type: "ephemeral" });
          break;
        }

        const lines = pending.map((t) => {
          const time = new Date(t.executeAt).toLocaleString("en-US", {
            weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          });
          return `• *${time}* — "${t.message.slice(0, 80)}" (\`${t.id}\`)`;
        });

        await respond({
          blocks: [
            header(`Scheduled Tasks (${pending.length})`),
            textBlock(lines.join("\n")),
            context("Cancel: `/orbit scheduled cancel <task_id>`"),
          ],
          text: `${pending.length} scheduled task(s)`,
          response_type: "ephemeral",
        });
        break;
      }

      // ─── /orbit learn-style ───
      case "learn-style": {
        if (!botConfig) { await respond({ text: "Config not available.", response_type: "ephemeral" }); break; }
        await respond({ text: "Analyzing your recent code to learn your style...", response_type: "ephemeral" });
        try {
          const channelConfig = resolveProjectConfig(command.channel_id);
          const config = mergeUserConfig(channelConfig, userId);
          const result = await learnCodeStyle(botConfig.workspaceRoots, botConfig.contextFolder, config.anthropicApiKey);
          await respond({ text: `:white_check_mark: ${result}`, response_type: "ephemeral" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Style learning failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit prep ───
      case "prep": {
        const channelConfig = resolveProjectConfig(command.channel_id);
        const config = mergeUserConfig(channelConfig, userId);
        try {
          const prep = await generateMeetingPrep(config, botConfig?.workspaceRoots || []);
          await respond({ text: prep, response_type: "ephemeral" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Prep failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit catchup ───
      case "catchup": {
        // Default: last 4 hours. Accept optional "Nh" argument (e.g., "8h", "24h")
        let sinceHours = 4;
        const hoursArg = args[1]?.match(/^(\d+)h$/i);
        if (hoursArg) sinceHours = parseInt(hoursArg[1], 10);

        const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
        try {
          const interactions = await getInteractionsSince(since);
          const summary = formatCatchUp(interactions);
          await respond({ text: summary, response_type: "ephemeral" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Catch-up failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit repos ───
      case "repos": {
        if (!botConfig) { await respond({ text: "Config not available.", response_type: "ephemeral" }); break; }
        try {
          const summary = await getAllReposSummary(botConfig.workspaceRoots);
          if (summary.total === 0) {
            await respond({ text: "No repos found. Set WORKSPACE_ROOTS in .env.", response_type: "ephemeral" });
            break;
          }
          const lines = summary.repos.map((r) => {
            const status = r.uncommitted > 0 ? ` — ${r.uncommitted} uncommitted` : "";
            return `• \`${r.name}\` (\`${r.branch}\`)${status}`;
          });
          await respond({
            blocks: [
              header(`Orbit — All Repos (${summary.total})`),
              textBlock(lines.join("\n")),
              context(`Workspace roots: ${botConfig.workspaceRoots.join(", ")}`),
            ],
            text: `${summary.total} repos`,
            response_type: "ephemeral",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Repo scan failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit standup ───
      case "standup": {
        const channelConfig = resolveProjectConfig(command.channel_id);
        const config = mergeUserConfig(channelConfig, userId);
        try {
          await respond({ text: "Generating standup...", response_type: "ephemeral" });
          const standup = await generateStandup(config, userId);
          await app.client.chat.postMessage({
            channel: command.channel_id,
            text: standup,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Standup failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit reviews ───
      case "reviews": {
        const channelConfig = resolveProjectConfig(command.channel_id);
        const config = mergeUserConfig(channelConfig, userId);
        try {
          await checkPendingReviews(app, config, command.channel_id);
          await respond({ text: "Checked for pending reviews.", response_type: "ephemeral" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ text: `:x: Review check failed: ${msg}`, response_type: "ephemeral" });
        }
        break;
      }

      // ─── /orbit help ───
      case "help":
      default: {
        await respond({
          text: [
            "*Orbit — Autonomous Dev Agent*",
            "",
            "Mention `@orbit` with a problem description to start:",
            "> @orbit Users can't reset their password when using SSO",
            "",
            "*Commands:*",
            "• `/orbit tickets` — List your assigned Linear tickets",
            "• `/orbit work` — Start working on all your assigned tickets",
            "• `/orbit work ENG-123 ENG-456` — Work on specific tickets",
            "• `/orbit status` — Show active sessions",
            "• `/orbit me` — View/set your personal config (Linear key, folder, branch)",
            "• `/orbit config` — Show/update project configuration",
            "• `/orbit project` — Manage projects & channel mappings",
            "• `/orbit scheduled` — View/cancel scheduled tasks",
            "• `/orbit learn-style` — Analyze your code and generate a style guide",
            "• `/orbit prep` — Sprint/meeting prep summary",
            "• `/orbit catchup` — What happened while you were away (default: last 4h, or `/orbit catchup 8h`)",
            "• `/orbit repos` — List all tracked repos across workspaces",
            "• `/orbit standup` — Post your standup now",
            "• `/orbit reviews` — Check pending PR reviews",
            "• `/orbit resume` — Resume interrupted sessions",
            "• `/orbit help` — Show this message",
          ].join("\n"),
          response_type: "ephemeral",
        });
        break;
      }
    }
  });
}
