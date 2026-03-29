import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, platform } from "node:os";

const IS_WIN = platform() === "win32";

function debugLog(msg: string) {
  try {
    const logFile = IS_WIN
      ? join(tmpdir(), "orbit-codex-debug.log")
      : "/tmp/orbit-codex-debug.log";
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export interface CodexResult {
  success: boolean;
  output: string;
  error?: string;
}

type CodexEvent = Record<string, unknown>;

function findCodex(): string {
  const home = homedir();

  if (IS_WIN) {
    const candidates = [
      join(home, "AppData", "Roaming", "npm", "codex.cmd"),
      join(home, ".local", "bin", "codex.exe"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    try {
      return execFileSync("where", ["codex"], { encoding: "utf-8" }).trim().split("\n")[0].trim();
    } catch {
      return join(home, "AppData", "Roaming", "npm", "codex.cmd");
    }
  }

  // macOS / Linux
  const searchPath = `${home}/.local/bin:/usr/local/bin:/usr/bin:/opt/homebrew/bin:${home}/.npm-global/bin:${process.env.PATH || ""}`;
  try {
    return execFileSync("which", ["codex"], { env: { PATH: searchPath } }).toString().trim();
  } catch {
    return `${home}/.local/bin/codex`;
  }
}

/**
 * Check if Codex CLI is installed and authenticated.
 */
export async function isCodexAvailable(): Promise<boolean> {
  try {
    const codexPath = findCodex();
    if (!existsSync(codexPath)) return false;
    const authPath = join(homedir(), ".codex", "auth.json");
    return existsSync(authPath);
  } catch {
    return false;
  }
}

const ORBIT_TMP = IS_WIN ? join(tmpdir(), "orbit-codex") : "/tmp/orbit-codex";
try { mkdirSync(ORBIT_TMP, { recursive: true }); } catch {}

/**
 * CodexAgent — same interface as ClaudeAgent, uses OpenAI Codex CLI.
 *
 * Codex CLI uses your ChatGPT Plus/Pro subscription (no API credits needed).
 * Install: npm install -g @openai/codex && codex login
 *
 * Runs `codex exec` with full-auto approval for autonomous coding.
 */
export class CodexAgent {
  private envVars: Record<string, string>;
  private activeChildren: Set<import("node:child_process").ChildProcess> = new Set();
  private _aborted = false;

  get aborted() { return this._aborted; }

  constructor(_apiKey?: string) {
    const home = homedir();

    if (IS_WIN) {
      this.envVars = {
        ...process.env as Record<string, string>,
        HOME: home,
        USERPROFILE: home,
      };
    } else {
      const expandedPath = `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${home}/.npm-global/bin:${process.env.PATH || ""}`;
      this.envVars = {
        HOME: home,
        PATH: expandedPath,
        USER: process.env.USER || "",
        SHELL: "/bin/bash",
        TMPDIR: process.env.TMPDIR || "/tmp",
        LANG: process.env.LANG || "en_US.UTF-8",
      };
    }

    // Codex uses ChatGPT auth (~/.codex/auth.json), not an API key.
    // If OPENAI_API_KEY is set, pass it through for API-based usage.
    if (_apiKey) {
      this.envVars.OPENAI_API_KEY = _apiKey;
    }
  }

  killAll() {
    this._aborted = true;
    debugLog(`killAll: killing ${this.activeChildren.size} codex processes`);
    for (const child of this.activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    }
    this.activeChildren.clear();
  }

  async run(
    prompt: string,
    cwd: string,
    onProgress?: (line: string) => void,
    _onEvent?: (event: CodexEvent) => void,
  ): Promise<CodexResult> {
    if (this._aborted) {
      return { success: false, output: "", error: "Aborted" };
    }

    const codexPath = findCodex();

    return new Promise((resolve) => {
      if (onProgress) onProgress("Starting Codex...");
      debugLog(`Running Codex: cwd=${cwd}, prompt=${prompt.length} chars`);

      // codex exec with full-auto approval (no user confirmation needed)
      // --full-auto: approve all file writes and commands automatically
      // Prompt is sent via stdin to avoid shell argument length limits
      const args = ["exec", "--full-auto", "-q", "-"];

      const isCmd = codexPath.endsWith(".cmd") || codexPath.endsWith(".bat");
      const child = spawn(codexPath, args, {
        cwd,
        env: this.envVars,
        shell: isCmd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeChildren.add(child);

      // Send prompt via stdin
      child.stdin.write(prompt, "utf-8");
      child.stdin.end();

      let stdout = "";
      let stderr = "";
      const startTime = Date.now();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        stdout += text;

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const timeStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
        if (onProgress) onProgress(`Codex is working... (${timeStr})`);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("close", (code) => {
        this.activeChildren.delete(child);
        const exitCode = code ?? 1;
        debugLog(`Codex done: exit=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`);

        // Extract the meaningful output from Codex's response
        const output = extractCodexOutput(stdout, stderr);

        if (onProgress) onProgress(exitCode === 0 ? "Codex finished" : `Codex exited with code ${exitCode}`);

        resolve({
          success: exitCode === 0,
          output: output.trim(),
          error: exitCode !== 0 ? (stderr.trim() || undefined) : undefined,
        });
      });

      child.on("error", (err) => {
        this.activeChildren.delete(child);
        debugLog(`Codex spawn error: ${err.message}`);
        resolve({ success: false, output: stdout, error: err.message });
      });

      // Timeout after 30 minutes
      setTimeout(() => {
        try { child.kill(); } catch {}
        if (onProgress) onProgress("Codex timed out after 30 minutes");
        resolve({ success: false, output: extractCodexOutput(stdout, stderr), error: "Timed out after 30 minutes" });
      }, 30 * 60 * 1000);
    });
  }
}

/**
 * Extract meaningful output from Codex CLI response.
 *
 * Codex output format:
 *   ... session header ...
 *   user
 *   <prompt>
 *   codex
 *   <response>
 *   tokens used
 *   <count>
 *   <response repeated>
 *
 * We extract the response after "codex\n" or after "tokens used\n<count>\n".
 */
function extractCodexOutput(stdout: string, stderr: string): string {
  const combined = stdout + "\n" + stderr;

  // Strategy 1: Content after "tokens used\n<number>\n" — the final clean response
  const tokensMatch = combined.match(/tokens used\s*\n\s*[\d,]+\s*\n([\s\S]+)$/);
  if (tokensMatch) {
    const candidate = tokensMatch[1].trim();
    if (candidate.length > 0) return candidate;
  }

  // Strategy 2: Content between "codex\n" and "tokens used"
  const codexSection = combined.match(/\ncodex\n([\s\S]*?)\ntokens used/);
  if (codexSection) {
    const candidate = codexSection[1].trim();
    if (candidate.length > 0) return candidate;
  }

  // Strategy 3: Content after last "codex\n"
  const lastCodex = combined.lastIndexOf("\ncodex\n");
  if (lastCodex !== -1) {
    const candidate = combined.slice(lastCodex + 7).trim();
    if (candidate.length > 0) return candidate;
  }

  // Fallback: return stdout as-is
  return stdout.trim();
}
