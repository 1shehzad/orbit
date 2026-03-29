# Orbit

Autonomous dev agent Slack bot powered by Claude/Codex. Monitors mentions, analyzes problems, creates Linear tickets, writes code, tests, and ships — all without asking for permission.

## Architecture

```
orbit/
├── core/                         # Shared library
│   └── src/
│       ├── pipeline.ts           # Ticket processing pipeline
│       ├── linear.ts             # Linear GraphQL API client
│       ├── git.ts                # Git operations manager
│       ├── claude.ts             # Claude CLI agent wrapper
│       ├── codex.ts              # Codex CLI agent wrapper
│       ├── agent-factory.ts      # AI provider factory (claude/codex)
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
   - AI agent (Claude/Codex) implements the fix
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

---

## Getting Started

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Enter app name (e.g., "Orbit") and select your workspace
4. Click **Create App**

### Step 2: Enable Socket Mode

1. In your app settings, go to **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** to ON
3. You'll be prompted to create an **App-Level Token**:
   - Token name: `orbit-socket`
   - Scope: `connections:write`
   - Click **Generate**
4. Copy the token — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`

### Step 3: Configure Bot Token Scopes

1. Go to **OAuth & Permissions** (left sidebar)
2. Scroll down to **Scopes** → **Bot Token Scopes**
3. Add these scopes:

   | Scope | Purpose |
   |-------|---------|
   | `app_mentions:read` | Detect @orbit mentions |
   | `channels:history` | Read channel messages |
   | `channels:read` | List channels |
   | `chat:write` | Send messages |
   | `commands` | Slash commands (/orbit) |
   | `files:write` | Upload screenshots |
   | `groups:history` | Read private channel messages |
   | `groups:read` | List private channels |
   | `im:history` | Read DMs |
   | `im:read` | List DMs |
   | `im:write` | Open DMs (for catch-up summaries) |
   | `mpim:history` | Read group DMs |
   | `users:read` | Get user info |
   | `users:read.email` | Get user emails |

### Step 4: Configure User Token Scopes (Optional)

This lets the bot post messages **as you** instead of as a bot.

1. Still in **OAuth & Permissions**, scroll to **User Token Scopes**
2. Add these scopes:

   | Scope | Purpose |
   |-------|---------|
   | `chat:write` | Post messages as you |
   | `files:write` | Upload files as you |
   | `users:read` | Read user info |

### Step 5: Enable Events

1. Go to **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:
   - `app_mention` — when someone @mentions the bot
   - `message.channels` — messages in public channels
   - `message.groups` — messages in private channels
   - `message.im` — direct messages
   - `message.mpim` — group DMs
4. Click **Save Changes**

### Step 6: Add Slash Command

1. Go to **Slash Commands** (left sidebar)
2. Click **Create New Command**
3. Fill in:
   - Command: `/orbit`
   - Short Description: `Orbit dev agent commands`
   - Usage Hint: `[status|tickets|work|help|prep|catchup|repos|reviews]`
4. Click **Save**

### Step 7: Enable Away Mode (Presence Detection)

1. Go to **OAuth & Permissions**
2. Add to **Bot Token Scopes**:
   - `users:read` (already added above — needed for `users.getPresence`)

### Step 8: Install the App

1. Go to **Install App** (left sidebar)
2. Click **Install to Workspace**
3. Review and allow the permissions
4. You'll get two tokens:
   - **Bot User OAuth Token** → starts with `xoxb-` → this is your `SLACK_BOT_TOKEN`
   - **User OAuth Token** → starts with `xoxp-` → this is your `SLACK_USER_TOKEN`

### Step 9: Get the Signing Secret

1. Go to **Basic Information** (left sidebar)
2. Scroll to **App Credentials**
3. Copy **Signing Secret** → this is your `SLACK_SIGNING_SECRET`

### Step 10: Get Your User ID (for Owner Mode)

1. In Slack, click your profile picture → **Profile**
2. Click the **three dots** (more) menu → **Copy member ID**
3. This is your `OWNER_USER_ID` (format: `U0XXXXXXXX`)

### Step 11: Invite the Bot to Channels

In each Slack channel where you want the bot to work:
```
/invite @Orbit
```

---

## Configure Environment

```bash
cp bot/.env.example bot/.env
```

Edit `bot/.env` with your values:

```env
# ── Slack (from steps above) ─────────────────────────────
SLACK_BOT_TOKEN=xoxb-...          # Step 8: Bot User OAuth Token
SLACK_SIGNING_SECRET=...          # Step 9: Signing Secret
SLACK_APP_TOKEN=xapp-...          # Step 2: App-Level Token
SLACK_USER_TOKEN=xoxp-...         # Step 8: User OAuth Token (optional)

# ── Owner Mode ────────────────────────────────────────────
OWNER_USER_ID=U0XXXXXXXX          # Step 10: Your Slack Member ID

# ── Linear ────────────────────────────────────────────────
# Get from: Linear → Settings → API → Personal API keys
LINEAR_API_KEY=lin_api_...
LINEAR_TEAM_ID=ENG                # Your team key (e.g., ENG, PROD)

# ── AI Provider ──────────────────────────────────────────
AI_PROVIDER=claude                # "claude" or "codex"

# ── Project ───────────────────────────────────────────────
PROJECT_FOLDER=/path/to/your/project
BASE_BRANCH=staging
```

---

## Connect AI Provider

### Option A: Claude (default)

```bash
# Install Claude CLI
npm install -g @anthropic-ai/claude-code

# Login (opens browser — uses your Claude Pro/Max subscription)
claude login

# Verify
claude -p "say hello" --output-format text

# Set in .env
AI_PROVIDER=claude
```

Or use an API key instead of CLI login:
```env
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...
```

### Option B: Codex

```bash
# Install Codex CLI
npm install -g @openai/codex

# Login (uses your ChatGPT Plus/Pro subscription — no API credits needed)
codex login

# Verify
codex exec "say hello"

# Set in .env
AI_PROVIDER=codex
```

---

## Build & Run

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Start
npm run start:bot
```

---

## Optional Features

### Activity Monitoring + Screenshots

Tracks what you're working on every 5 minutes (git activity, active app, screenshots).

```env
WORKSPACE_ROOTS=/Users/you/work/repo1,/Users/you/work/repo2
MONITOR_INTERVAL_MINUTES=5
SCREENSHOTS_ENABLED=true
SCREENSHOT_RETENTION_DAYS=7
ACTIVITY_CONTEXT_DAYS=7
```

### Away Mode

Bot auto-handles all @mentions when your Slack status is "away".

```env
AWAY_MODE_ENABLED=true
PRESENCE_POLL_SECONDS=60
```

### Daily Standup

Auto-posts standup to a channel at a scheduled time.

```env
STANDUP_CHANNEL_ID=C0XXXXXXX      # Channel ID (right-click channel → Copy link → ID at end)
STANDUP_TIME=09:00                # 24-hour format
```

### Context Files

Create `~/.orbit-context/` and add markdown files about yourself:

```bash
mkdir -p ~/.orbit-context
```

- `role.md` — Your role, team, responsibilities
- `platform.md` — Your product/platform context

These help the bot answer questions accurately as you.

---

## Slash Commands

| Command | What it does |
|---------|-------------|
| `/orbit status` | Show all active sessions |
| `/orbit tickets` | List your assigned Linear tickets |
| `/orbit work ENG-100 ENG-101` | Start working on specific tickets |
| `/orbit prep` | Meeting prep summary |
| `/orbit catchup 4h` | What happened last 4 hours |
| `/orbit repos` | List all repos in workspace |
| `/orbit reviews` | Check pending PR reviews |
| `/orbit standup` | Post standup now |
| `/orbit learn-style` | Generate code style guide |
| `/orbit help` | Show all commands |
