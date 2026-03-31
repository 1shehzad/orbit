#!/bin/bash
set -e

echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║       Orbit — Setup Wizard        ║"
echo "  ╚═══════════════════════════════════╝"
echo ""

# ── Step 1: Prerequisites ──
echo "Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install it from https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
  echo "❌ npm not found."
  exit 1
fi
echo "✓ npm $(npm --version)"

# Check git
if ! command -v git &> /dev/null; then
  echo "❌ git not found."
  exit 1
fi
echo "✓ git $(git --version | cut -d' ' -f3)"

# Check gh CLI
if ! command -v gh &> /dev/null; then
  echo "⚠  GitHub CLI (gh) not found — PR creation won't work. Install: brew install gh"
fi

echo ""

# ── Step 2: AI Provider ──
echo "── AI Provider Setup ──"
echo ""

AI_PROVIDER=""
if command -v claude &> /dev/null; then
  echo "✓ Claude CLI found ($(claude --version 2>/dev/null || echo 'installed'))"
  AI_PROVIDER="claude"
elif command -v codex &> /dev/null; then
  echo "✓ Codex CLI found"
  AI_PROVIDER="codex"
fi

if [ -z "$AI_PROVIDER" ]; then
  echo "No AI provider found. Which do you want to install?"
  echo "  1) Claude (recommended — uses Claude Pro/Max subscription)"
  echo "  2) Codex (uses ChatGPT Plus/Pro subscription)"
  echo "  3) Skip (I'll install later)"
  read -p "Choice [1/2/3]: " ai_choice
  case $ai_choice in
    1)
      echo "Installing Claude CLI..."
      npm install -g @anthropic-ai/claude-code
      echo "Login to Claude:"
      claude login
      AI_PROVIDER="claude"
      ;;
    2)
      echo "Installing Codex CLI..."
      sudo npm install -g @openai/codex
      echo "Login to Codex:"
      codex login
      AI_PROVIDER="codex"
      ;;
    *)
      echo "Skipping AI provider setup. Set AI_PROVIDER in bot/.env later."
      AI_PROVIDER="claude"
      ;;
  esac
fi

echo ""

# ── Step 3: Install dependencies ──
echo "── Installing Dependencies ──"
npm install
echo ""

# ── Step 4: Build ──
echo "── Building ──"
npm run build
echo ""

# ── Step 5: Slack App Setup ──
echo "── Slack App Setup ──"
echo ""
echo "You need to create a Slack app. This takes 2 minutes:"
echo ""
echo "  1. Open: https://api.slack.com/apps"
echo "  2. Click 'Create New App' → 'From an app manifest'"
echo "  3. Select your workspace"
echo "  4. Switch to JSON tab and paste the contents of: slack-app-manifest.json"
echo "  5. Click 'Create'"
echo "  6. Click 'Install to Workspace' → 'Allow'"
echo ""
echo "  This automatically configures all scopes, events, commands,"
echo "  socket mode, and interactivity in one step."
echo ""

# Open the manifest file and Slack app page
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "Opening Slack app creation page..."
  open "https://api.slack.com/apps"
  echo "Opening manifest file for you to copy..."
  cat slack-app-manifest.json | pbcopy
  echo "✓ Manifest copied to clipboard!"
elif command -v xdg-open &> /dev/null; then
  xdg-open "https://api.slack.com/apps" 2>/dev/null || true
fi

read -p "Press Enter when you've created and installed the Slack app..."
echo ""

# ── Step 6: Collect tokens ──
echo "── Configure Tokens ──"
echo ""
echo "From your Slack app settings, grab these values:"
echo ""

read -p "Bot Token (xoxb-...): " SLACK_BOT_TOKEN
read -p "Signing Secret: " SLACK_SIGNING_SECRET

echo ""
echo "Go to 'Socket Mode' in left sidebar → copy the App-Level Token:"
read -p "App Token (xapp-...): " SLACK_APP_TOKEN

echo ""
echo "Go to 'OAuth & Permissions' → copy the User OAuth Token:"
read -p "User Token (xoxp-..., optional — press Enter to skip): " SLACK_USER_TOKEN

echo ""
echo "── Linear Setup ──"
echo "Get your API key from: Linear → Settings → API → Personal API keys"
read -p "Linear API Key (lin_api_...): " LINEAR_API_KEY
read -p "Linear Team ID/Key (e.g., ENG): " LINEAR_TEAM_ID

echo ""
echo "── Project Setup ──"
read -p "Workspace root (parent folder of your projects, e.g., /Users/you/work): " WORKSPACE_ROOTS
read -p "Base branch (default: staging): " BASE_BRANCH
BASE_BRANCH=${BASE_BRANCH:-staging}

echo ""
echo "── Owner Setup ──"
echo "Your Slack Member ID: In Slack, click your profile → ⋮ → Copy member ID"
read -p "Your Slack User ID (U0...): " OWNER_USER_ID

echo ""
echo "── Optional Features ──"
read -p "Enable away mode? (y/n, default: y): " AWAY_MODE
AWAY_MODE=${AWAY_MODE:-y}

read -p "Enable screenshots? (y/n, default: n): " SCREENSHOTS
SCREENSHOTS=${SCREENSHOTS:-n}

read -p "Standup channel ID (press Enter to skip): " STANDUP_CHANNEL_ID
read -p "Standup time (HH:MM, default: 09:00): " STANDUP_TIME
STANDUP_TIME=${STANDUP_TIME:-09:00}

# ── Step 7: Write .env ──
echo ""
echo "── Writing bot/.env ──"

cat > bot/.env << ENVEOF
# Slack
SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET=$SLACK_SIGNING_SECRET
SLACK_APP_TOKEN=$SLACK_APP_TOKEN
SLACK_USER_TOKEN=$SLACK_USER_TOKEN

# Linear
LINEAR_API_KEY=$LINEAR_API_KEY
LINEAR_TEAM_ID=$LINEAR_TEAM_ID

# AI
AI_PROVIDER=$AI_PROVIDER

# Project
WORKSPACE_ROOTS=$WORKSPACE_ROOTS
BASE_BRANCH=$BASE_BRANCH

# Server
PORT=3000

# Access Control
ALLOWED_USER_IDS=$OWNER_USER_ID
OWNER_USER_ID=$OWNER_USER_ID

# Context
CONTEXT_FOLDER=~/.orbit-context

# Test Mode (remove for production)
TEST_MODE=1

# Standup
STANDUP_CHANNEL_ID=$STANDUP_CHANNEL_ID
STANDUP_TIME=$STANDUP_TIME

# Activity Monitor
MONITOR_INTERVAL_MINUTES=5
SCREENSHOTS_ENABLED=$( [ "$SCREENSHOTS" = "y" ] && echo "true" || echo "false" )
SCREENSHOT_RETENTION_DAYS=7

# Away Mode
AWAY_MODE_ENABLED=$( [ "$AWAY_MODE" = "y" ] && echo "true" || echo "false" )
PRESENCE_POLL_SECONDS=60
DM_POLL_SECONDS=60
ENVEOF

echo "✓ bot/.env written"

# Create context folder
mkdir -p ~/.orbit-context
echo "✓ ~/.orbit-context created"

echo ""
echo "  ╔═══════════════════════════════════╗"
echo "  ║         Setup Complete! 🚀        ║"
echo "  ╚═══════════════════════════════════╝"
echo ""
echo "  Invite the bot to your Slack channels:"
echo "    /invite @Orbit"
echo ""
echo "  Start the bot:"
echo "    npm run start:bot"
echo ""
