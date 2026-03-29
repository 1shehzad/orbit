# Orbit

Autonomous dev agent Slack bot powered by Claude Code. Monitors mentions, analyzes problems, creates Linear tickets, writes code, tests, and ships — all without asking for permission.

## Architecture

```
orbit/
├── core/                         # Shared library
│   └── src/
│       ├── pipeline.ts           # Ticket processing pipeline
│       ├── linear.ts             # Linear GraphQL API client
│       ├── git.ts                # Git operations manager
│       ├── claude.ts             # Claude CLI agent wrapper
│       └── types.ts              # Shared type definitions
├── bot/                          # Slack Bot (Node.js + @slack/bolt)
│   └── src/
│       ├── index.ts              # Entry point
│       ├── config.ts             # Configuration from env vars
│       ├── handlers/
│       │   ├── mention.ts        # @mention detection & routing
│       │   ├── message.ts        # Thread reply handler (clarify/feedback)
│       │   └── commands.ts       # /orbit slash commands
│       ├── analyzer.ts           # Problem analysis & spec generation
│       ├── classifier.ts         # Message intent classification
│       ├── runner.ts             # Pipeline executor
│       ├── responder.ts          # Query response (answers as you)
│       ├── codeqa.ts             # Code Q&A handler
│       ├── reviewer.ts           # PR review handler
│       ├── scheduler.ts          # Task scheduling
│       ├── standup.ts            # Daily standup generation
│       ├── monitor.ts            # Activity monitor + screenshots
│       ├── presence-monitor.ts   # Away mode detection
│       ├── activity-store.ts     # JSONL activity storage
│       ├── activity-context.ts   # Context file regeneration
│       ├── context-updater.ts    # Task-based context updates
│       ├── interaction-log.ts    # Daily interaction logging
│       ├── deploy-monitor.ts     # PR deployment watcher
│       ├── meeting-prep.ts       # Sprint/meeting prep
│       ├── style-learner.ts      # Code style analysis
│       ├── threads.ts            # Thread state persistence
│       ├── projects.ts           # Multi-project config
│       ├── users.ts              # Per-user config overrides
│       └── post.ts               # Post as user or bot
└── package.json                  # Workspace root
```

## How It Works

### Flow per task:

1. **Classify** — detect if message is a query, code question, or task
2. **Analyze** — scan codebase, generate implementation spec
3. **Clarify** — ask questions if needed (skipped in away mode)
4. **Plan** — break into Linear tickets with dependencies
5. **Execute** per ticket:
   - Pull latest from base branch
   - Create feature branch
   - Claude implements the fix
   - Build + test (auto-fix up to 3 retries)
   - Create PR, merge to staging
   - Generate manual QA test cases
6. **Monitor** — watch deployment status, post preview URL
7. **Summary** — post results with PR/ticket links

### Away Mode:

When the owner goes away on Slack, the bot automatically takes over:
- Answers queries using context files
- Executes tasks without waiting for clarification
- Posts a catch-up summary when the owner returns

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp bot/.env.example bot/.env
# Edit bot/.env with your Slack, Linear, and project settings

# 3. Build
npm run build

# 4. Start
npm run start:bot
```
