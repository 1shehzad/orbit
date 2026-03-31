/**
 * Orbit Automated Setup — uses Playwright to configure Slack app,
 * extract tokens, install dependencies, and write .env.
 *
 * Usage: npx tsx setup-auto.ts
 *
 * Flow:
 * 1. Install dependencies + build
 * 2. Open browser → user logs into Slack (manual — 2FA/CAPTCHA)
 * 3. Playwright creates app from manifest
 * 4. Extracts all tokens (bot token, user token, signing secret, app token)
 * 5. Collects Linear API key + workspace info from user
 * 6. Writes bot/.env
 * 7. Ready to run
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { execSync } from "child_process";

const ROOT = import.meta.dirname || process.cwd();

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function log(msg: string) {
  console.log(`  → ${msg}`);
}

function heading(msg: string) {
  console.log(`\n  ── ${msg} ──\n`);
}

async function main() {
  console.log("");
  console.log("  ╔═══════════════════════════════════════╗");
  console.log("  ║   Orbit — Automated Setup (Playwright) ║");
  console.log("  ╚═══════════════════════════════════════╝");
  console.log("");

  // ── Step 1: Prerequisites ──
  heading("Step 1: Prerequisites");

  // Check AI provider
  let aiProvider = "claude";
  try {
    execSync("which claude", { stdio: "ignore" });
    log("✓ Claude CLI found");
  } catch {
    try {
      execSync("which codex", { stdio: "ignore" });
      log("✓ Codex CLI found");
      aiProvider = "codex";
    } catch {
      log("⚠ No AI provider found (claude or codex)");
      const choice = await ask("Install? (1=Claude, 2=Codex, 3=Skip): ");
      if (choice === "1") {
        log("Installing Claude CLI...");
        execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
        execSync("claude login", { stdio: "inherit" });
        aiProvider = "claude";
      } else if (choice === "2") {
        log("Installing Codex CLI...");
        execSync("sudo npm install -g @openai/codex", { stdio: "inherit" });
        execSync("codex login", { stdio: "inherit" });
        aiProvider = "codex";
      }
    }
  }

  // ── Step 2: Install & Build ──
  heading("Step 2: Install & Build");
  log("Installing dependencies...");
  execSync("npm install", { cwd: ROOT, stdio: "inherit" });
  log("Building...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
  log("✓ Build complete");

  // ── Step 3: Slack App Setup via Playwright ──
  heading("Step 3: Slack App Setup");
  log("Opening browser — please log into Slack if prompted.");
  log("The script will automate the rest after you're logged in.");
  console.log("");

  const manifest = readFileSync(join(ROOT, "slack-app-manifest.json"), "utf-8");

  // Launch visible browser so user can handle login/2FA
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to Slack app creation
  await page.goto("https://api.slack.com/apps");

  // Wait for user to be logged in — detect by looking for "Create New App" button
  log("Waiting for you to log in...");
  await page.waitForSelector('a:has-text("Create New App"), button:has-text("Create New App")', {
    timeout: 300_000, // 5 minutes to log in
  });
  log("✓ Logged in!");

  // Click "Create New App"
  log("Creating app from manifest...");
  await page.click('a:has-text("Create New App"), button:has-text("Create New App")');

  // Wait for modal and click "From an app manifest"
  await page.waitForSelector('text=From an app manifest', { timeout: 10_000 });
  await page.click('text=From an app manifest');

  // Select workspace (click the first one if multiple)
  await page.waitForTimeout(2000);
  try {
    // If workspace picker appears, select the first workspace
    const workspaceOption = page.locator('.c-select_options_list__option').first();
    if (await workspaceOption.isVisible({ timeout: 3000 })) {
      await workspaceOption.click();
    }
  } catch {
    // Single workspace — auto-selected
  }

  // Click Next
  try {
    await page.click('button:has-text("Next")', { timeout: 5000 });
  } catch {
    // Might not need "Next" if workspace was pre-selected
  }

  // Wait for manifest editor
  await page.waitForTimeout(2000);

  // Switch to JSON tab
  try {
    await page.click('text=JSON', { timeout: 5000 });
  } catch {
    // Might already be on JSON tab
  }

  // Clear existing content and paste manifest
  await page.waitForTimeout(1000);
  const editor = page.locator('textarea, .CodeMirror, [role="textbox"], .ace_editor').first();
  try {
    // Try textarea first
    const textarea = page.locator('textarea').first();
    if (await textarea.isVisible({ timeout: 2000 })) {
      await textarea.fill(manifest);
    } else {
      // Try CodeMirror or other editors
      await page.evaluate((m) => {
        // CodeMirror
        const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
        if (cm) { cm.setValue(m); return; }
        // Ace editor
        const ace = (window as any).ace?.edit(document.querySelector('.ace_editor'));
        if (ace) { ace.setValue(m); return; }
        // Fallback: find any textarea
        const ta = document.querySelector('textarea');
        if (ta) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;
          nativeInputValueSetter?.call(ta, m);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, manifest);
    }
  } catch (err) {
    log("⚠ Couldn't auto-paste manifest. Please paste it manually.");
    log("  Manifest is in: slack-app-manifest.json");
    await ask("Press Enter after pasting the manifest...");
  }

  // Click Next/Create
  await page.waitForTimeout(1000);
  try {
    await page.click('button:has-text("Next")', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Create")', { timeout: 5000 });
  } catch {
    log("⚠ Please click 'Next' then 'Create' in the browser.");
    await ask("Press Enter after the app is created...");
  }

  log("✓ App created!");
  await page.waitForTimeout(3000);

  // ── Step 4: Install the app ──
  log("Installing app to workspace...");
  try {
    // Navigate to Install App page
    await page.click('text=Install App', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Install to Workspace"), a:has-text("Install to Workspace")', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click Allow on OAuth page
    try {
      await page.click('button:has-text("Allow")', { timeout: 10_000 });
    } catch {
      log("⚠ Please click 'Allow' in the browser.");
      await ask("Press Enter after allowing...");
    }
  } catch {
    log("⚠ Please install the app manually in the browser.");
    await ask("Press Enter after installing...");
  }

  await page.waitForTimeout(3000);
  log("✓ App installed!");

  // ── Step 5: Extract tokens ──
  heading("Step 4: Extracting Tokens");

  // Get Bot Token from OAuth & Permissions
  let botToken = "";
  let userToken = "";
  try {
    await page.click('text=OAuth & Permissions', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Extract bot token
    const botTokenEl = page.locator('text=xoxb-').first();
    if (await botTokenEl.isVisible({ timeout: 3000 })) {
      botToken = await botTokenEl.textContent() || "";
      botToken = botToken.trim();
    }

    // Extract user token
    const userTokenEl = page.locator('text=xoxp-').first();
    if (await userTokenEl.isVisible({ timeout: 3000 })) {
      userToken = await userTokenEl.textContent() || "";
      userToken = userToken.trim();
    }
  } catch {}

  if (!botToken) {
    log("⚠ Couldn't auto-extract bot token.");
    botToken = await ask("Paste Bot User OAuth Token (xoxb-...): ");
  } else {
    log(`✓ Bot Token: ${botToken.slice(0, 15)}...`);
  }

  if (!userToken) {
    log("⚠ Couldn't auto-extract user token.");
    userToken = await ask("Paste User OAuth Token (xoxp-..., Enter to skip): ");
  } else {
    log(`✓ User Token: ${userToken.slice(0, 15)}...`);
  }

  // Get Signing Secret from Basic Information
  let signingSecret = "";
  try {
    await page.click('text=Basic Information', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Click "Show" button next to signing secret
    const showButtons = page.locator('button:has-text("Show")');
    const count = await showButtons.count();
    for (let i = 0; i < count; i++) {
      try {
        await showButtons.nth(i).click();
        await page.waitForTimeout(500);
      } catch {}
    }

    // Find signing secret value
    const secretEl = page.locator('[class*="secret"], [class*="credential"]').first();
    if (await secretEl.isVisible({ timeout: 2000 })) {
      signingSecret = (await secretEl.textContent() || "").trim();
    }
  } catch {}

  if (!signingSecret || signingSecret.length < 10) {
    log("⚠ Couldn't auto-extract signing secret.");
    signingSecret = await ask("Paste Signing Secret: ");
  } else {
    log(`✓ Signing Secret: ${signingSecret.slice(0, 10)}...`);
  }

  // Get App-Level Token from Socket Mode
  let appToken = "";
  try {
    await page.click('text=Socket Mode', { timeout: 5000 });
    await page.waitForTimeout(2000);

    // Look for existing app-level token or generate one
    const tokenEl = page.locator('text=xapp-').first();
    if (await tokenEl.isVisible({ timeout: 3000 })) {
      appToken = (await tokenEl.textContent() || "").trim();
    } else {
      // Need to generate one
      try {
        await page.click('button:has-text("Generate Token"), a:has-text("Generate Token")', { timeout: 3000 });
        await page.waitForTimeout(1000);

        // Fill token name
        const nameInput = page.locator('input[placeholder*="name"], input[name*="name"]').first();
        if (await nameInput.isVisible({ timeout: 2000 })) {
          await nameInput.fill("orbit-socket");
        }

        // Add scope
        try {
          await page.click('text=connections:write', { timeout: 2000 });
        } catch {}

        await page.click('button:has-text("Generate")', { timeout: 3000 });
        await page.waitForTimeout(2000);

        const newTokenEl = page.locator('text=xapp-').first();
        if (await newTokenEl.isVisible({ timeout: 3000 })) {
          appToken = (await newTokenEl.textContent() || "").trim();
        }
      } catch {}
    }
  } catch {}

  if (!appToken) {
    log("⚠ Couldn't auto-extract app token.");
    appToken = await ask("Paste App-Level Token (xapp-...): ");
  } else {
    log(`✓ App Token: ${appToken.slice(0, 15)}...`);
  }

  // Close browser
  await browser.close();
  log("✓ Browser closed");

  // ── Step 6: Collect remaining info ──
  heading("Step 5: Project Configuration");

  const linearApiKey = await ask("Linear API Key (lin_api_...): ");
  const linearTeamId = await ask("Linear Team ID/Key (e.g., ENG): ");
  const workspaceRoots = await ask("Workspace root (e.g., /Users/you/work): ");
  const baseBranch = (await ask("Base branch (default: staging): ")) || "staging";
  const ownerUserId = await ask("Your Slack User ID (U0...): ");

  const awayMode = ((await ask("Enable away mode? (y/n, default: y): ")) || "y").toLowerCase();
  const screenshots = ((await ask("Enable screenshots? (y/n, default: n): ")) || "n").toLowerCase();
  const standupChannelId = await ask("Standup channel ID (Enter to skip): ");
  const standupTime = (await ask("Standup time (HH:MM, default: 09:00): ")) || "09:00";

  // ── Step 7: Write .env ──
  heading("Step 6: Writing Configuration");

  const envContent = `# Slack
SLACK_BOT_TOKEN=${botToken}
SLACK_SIGNING_SECRET=${signingSecret}
SLACK_APP_TOKEN=${appToken}
SLACK_USER_TOKEN=${userToken}

# Linear
LINEAR_API_KEY=${linearApiKey}
LINEAR_TEAM_ID=${linearTeamId}

# AI
AI_PROVIDER=${aiProvider}

# Project
WORKSPACE_ROOTS=${workspaceRoots}
BASE_BRANCH=${baseBranch}

# Server
PORT=3000

# Access Control
ALLOWED_USER_IDS=${ownerUserId}
OWNER_USER_ID=${ownerUserId}

# Context
CONTEXT_FOLDER=~/.orbit-context

# Test Mode (remove for production)
TEST_MODE=1

# Standup
STANDUP_CHANNEL_ID=${standupChannelId}
STANDUP_TIME=${standupTime}

# Activity Monitor
MONITOR_INTERVAL_MINUTES=5
SCREENSHOTS_ENABLED=${screenshots === "y" ? "true" : "false"}
SCREENSHOT_RETENTION_DAYS=7

# Away Mode
AWAY_MODE_ENABLED=${awayMode === "y" ? "true" : "false"}
PRESENCE_POLL_SECONDS=60
DM_POLL_SECONDS=60
`;

  writeFileSync(join(ROOT, "bot", ".env"), envContent);
  log("✓ bot/.env written");

  // Create context folder
  const contextDir = join(process.env.HOME || "~", ".orbit-context");
  mkdirSync(contextDir, { recursive: true });
  log("✓ ~/.orbit-context created");

  console.log("");
  console.log("  ╔═══════════════════════════════════════╗");
  console.log("  ║          Setup Complete! 🚀           ║");
  console.log("  ╚═══════════════════════════════════════╝");
  console.log("");
  console.log("  Invite the bot to your Slack channels:");
  console.log("    /invite @Orbit");
  console.log("");
  console.log("  Start the bot:");
  console.log("    npm run start:bot");
  console.log("");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
