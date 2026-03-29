import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, platform } from "node:os";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";

function debugLog(msg: string) {
  try {
    const logFile = IS_WIN
      ? join(tmpdir(), "orbit-claude-debug.log")
      : "/tmp/orbit-claude-debug.log";
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
}

type ClaudeEvent = Record<string, unknown>;

function findClaude(): string {
  const home = homedir();

  if (IS_WIN) {
    // Windows search paths
    const candidates = [
      join(home, ".local", "bin", "claude.exe"),
      join(home, "AppData", "Local", "Programs", "claude", "claude.exe"),
      join(home, "AppData", "Roaming", "npm", "claude.cmd"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    try {
      return execFileSync("where", ["claude"], { encoding: "utf-8" }).trim().split("\n")[0].trim();
    } catch {
      return join(home, "AppData", "Roaming", "npm", "claude.cmd");
    }
  }

  // macOS / Linux
  const searchPath = `${home}/.local/bin:/usr/local/bin:/usr/bin:/opt/homebrew/bin:${home}/.npm-global/bin:${process.env.PATH || ""}`;
  try {
    return execFileSync("which", ["claude"], { env: { PATH: searchPath } }).toString().trim();
  } catch {
    return `${home}/.local/bin/claude`;
  }
}

const claudePath = findClaude();
const ORBIT_TMP = IS_WIN ? join(tmpdir(), "orbit-claude") : "/tmp/orbit-claude";

try { mkdirSync(ORBIT_TMP, { recursive: true }); } catch {}

export class ClaudeAgent {
  private envVars: Record<string, string>;
  private activeChildren: Set<import("node:child_process").ChildProcess> = new Set();
  private activeJobs: Set<{ jobLabel: string; poller: ReturnType<typeof setInterval>; files: string[] }> = new Set();
  private _aborted = false;

  get aborted() { return this._aborted; }

  constructor(anthropicApiKey?: string) {
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

    if (anthropicApiKey) {
      this.envVars.ANTHROPIC_API_KEY = anthropicApiKey;
    }
  }

  /**
   * Kill all active Claude processes and launchd jobs.
   * Called on graceful shutdown when extension disconnects.
   */
  killAll() {
    this._aborted = true;
    debugLog(`killAll: killing ${this.activeChildren.size} spawn processes, ${this.activeJobs.size} launchd jobs`);

    // Kill spawned child processes (Windows/Linux)
    for (const child of this.activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
      // Force kill after 3 seconds
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    }
    this.activeChildren.clear();

    // Remove launchd jobs and clean up temp files (macOS)
    for (const job of this.activeJobs) {
      clearInterval(job.poller);
      try { execFileSync("launchctl", ["remove", job.jobLabel]); } catch {}
      for (const f of job.files) {
        try { unlinkSync(f); } catch {}
      }
    }
    this.activeJobs.clear();
  }

  async run(
    prompt: string,
    cwd: string,
    onProgress?: (line: string) => void,
    onEvent?: (event: ClaudeEvent) => void,
  ): Promise<ClaudeResult> {
    if (IS_MAC) {
      return this.runViaPlist(prompt, cwd, onProgress, onEvent);
    }
    return this.runViaSpawn(prompt, cwd, onProgress, onEvent);
  }

  /**
   * Windows / Linux: run Claude directly via child_process.spawn
   */
  private runViaSpawn(
    prompt: string,
    cwd: string,
    onProgress?: (line: string) => void,
    onEvent?: (event: ClaudeEvent) => void,
  ): Promise<ClaudeResult> {
    if (this._aborted) {
      return Promise.resolve({ success: false, output: "", error: "Aborted" });
    }

    return new Promise((resolve) => {
      if (onProgress) onProgress("Starting Claude...");
      debugLog(`Running Claude (spawn): cwd=${cwd}, prompt=${prompt.length} chars`);

      const args = ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", prompt];

      // On Windows, if claude is a .cmd file, we need shell: true
      const isCmd = claudePath.endsWith(".cmd") || claudePath.endsWith(".bat");
      const child = spawn(claudePath, args, {
        cwd,
        env: this.envVars,
        shell: isCmd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeChildren.add(child);

      let finalOutput = "";
      let stderr = "";
      const startTime = Date.now();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as ClaudeEvent;
            if (onEvent) onEvent(event);
            if (event.type === "result") {
              const result = event.result as string;
              if (result) finalOutput = result;
            }
          } catch {
            if (line.trim().length > 0) {
              finalOutput += line + "\n";
            }
          }
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const timeStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
        if (onProgress) onProgress(`Claude is working... (${timeStr})`);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("close", (code) => {
        this.activeChildren.delete(child);
        const exitCode = code ?? 1;
        debugLog(`Claude done (spawn): exit=${exitCode}, output=${finalOutput.length}B`);
        if (onProgress) onProgress(exitCode === 0 ? "Claude finished" : `Claude exited with code ${exitCode}`);

        resolve({
          success: exitCode === 0,
          output: finalOutput.trim(),
          error: stderr.trim() || undefined,
        });
      });

      child.on("error", (err) => {
        this.activeChildren.delete(child);
        debugLog(`Claude spawn error: ${err.message}`);
        resolve({ success: false, output: finalOutput, error: err.message });
      });

      // Timeout after 30 minutes
      setTimeout(() => {
        try { child.kill(); } catch {}
        if (onProgress) onProgress("Claude timed out after 30 minutes");
        resolve({ success: false, output: finalOutput, error: "Timed out after 30 minutes" });
      }, 30 * 60 * 1000);
    });
  }

  /**
   * macOS: run Claude via launchd plist for quarantine-free execution
   */
  private runViaPlist(
    prompt: string,
    cwd: string,
    onProgress?: (line: string) => void,
    onEvent?: (event: ClaudeEvent) => void,
  ): Promise<ClaudeResult> {
    if (this._aborted) {
      return Promise.resolve({ success: false, output: "", error: "Aborted" });
    }

    return new Promise((resolve) => {
      if (onProgress) onProgress("Starting Claude...");
      const ts = Date.now();
      const prefix = `${ORBIT_TMP}/${ts}`;
      const promptFile = `${prefix}-prompt.txt`;
      const stdoutFile = `${prefix}-stdout.txt`;
      const stderrFile = `${prefix}-stderr.txt`;
      const exitFile = `${prefix}-exit.txt`;
      const scriptFile = `${prefix}-run.sh`;
      const plistFile = `${prefix}-job.plist`;
      const allFiles = [promptFile, stdoutFile, stderrFile, exitFile, scriptFile, plistFile];

      debugLog(`Running Claude (plist): cwd=${cwd}, prompt=${prompt.length} chars`);

      writeFileSync(promptFile, prompt);

      const envExports = Object.entries(this.envVars)
        .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
        .join("\n");

      writeFileSync(scriptFile, `#!/bin/bash
exec > "${stdoutFile}" 2> "${stderrFile}"
${envExports}
cd "${cwd}"
PROMPT=$(cat "${promptFile}")
"${claudePath}" --output-format stream-json --verbose --dangerously-skip-permissions "$PROMPT"
EXIT_CODE=$?
exec 1>/dev/null 2>/dev/null
echo "$EXIT_CODE" > "${exitFile}"
`, { mode: 0o755 });

      const jobLabel = `com.orbit.claude.${ts}`;
      const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${jobLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${scriptFile}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
</dict>
</plist>`;

      writeFileSync(plistFile, plistContent);

      try {
        execFileSync("launchctl", ["load", plistFile]);
        debugLog(`Launched job: ${jobLabel}`);
      } catch {
        try {
          execFileSync("launchctl", ["submit", "-l", jobLabel, "--", "/bin/bash", scriptFile]);
          debugLog(`Fallback to submit: ${jobLabel}`);
        } catch (e2) {
          resolve({ success: false, output: "", error: `Failed to launch Claude: ${e2}` });
          return;
        }
      }

      const cleanup = () => {
        try { execFileSync("launchctl", ["remove", jobLabel]); } catch {}
        for (const f of allFiles) {
          try { unlinkSync(f); } catch {}
        }
      };

      const startTime = Date.now();
      let lastReadPos = 0;
      let finalOutput = "";

      const poller = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const timeStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

        try {
          if (existsSync(stdoutFile)) {
            const content = readFileSync(stdoutFile, "utf-8");
            if (content.length > lastReadPos) {
              const newContent = content.slice(lastReadPos);
              lastReadPos = content.length;

              const lines = newContent.split("\n");
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line) as ClaudeEvent;
                  if (onEvent) onEvent(event);
                  if (event.type === "result") {
                    const result = event.result as string;
                    if (result) finalOutput = result;
                  }
                } catch {
                  if (line.trim().length > 0) {
                    finalOutput += line + "\n";
                  }
                }
              }

              if (onProgress) {
                onProgress(`Claude is working... (${timeStr}, ${Math.round(content.length / 1024)}KB)`);
              }
            } else if (onProgress) {
              onProgress(`Working... (${timeStr})`);
            }
          } else if (onProgress) {
            onProgress(`Starting... (${timeStr})`);
          }
        } catch {}

        try {
          if (!existsSync(exitFile)) throw new Error("not done");
          const exitContent = readFileSync(exitFile, "utf-8").trim();
          if (!exitContent) throw new Error("not done");
          const exitCode = parseInt(exitContent, 10);
          if (isNaN(exitCode)) throw new Error("not done");

          clearInterval(poller);
          this.activeJobs.delete(jobTracker);

          try {
            const finalContent = readFileSync(stdoutFile, "utf-8");
            if (finalContent.length > lastReadPos) {
              const remaining = finalContent.slice(lastReadPos);
              for (const line of remaining.split("\n")) {
                if (!line.trim()) continue;
                try {
                  const event = JSON.parse(line) as ClaudeEvent;
                  if (onEvent) onEvent(event);
                  if (event.type === "result") {
                    const result = event.result as string;
                    if (result) finalOutput = result;
                  }
                } catch {
                  finalOutput += line + "\n";
                }
              }
            }
          } catch {}

          let stderr = "";
          try { stderr = readFileSync(stderrFile, "utf-8"); } catch {}

          debugLog(`Claude done: exit=${exitCode}, output=${finalOutput.length}B`);
          if (onProgress) onProgress(exitCode === 0 ? "Claude finished" : `Claude exited with code ${exitCode}`);

          cleanup();
          resolve({
            success: exitCode === 0,
            output: finalOutput.trim(),
            error: stderr.trim() || undefined,
          });
        } catch {
          // Not done yet
        }

        if (elapsed > 1800) {
          clearInterval(poller);
          this.activeJobs.delete(jobTracker);
          if (onProgress) onProgress("Claude timed out after 30 minutes");
          cleanup();
          resolve({ success: false, output: finalOutput, error: "Timed out after 30 minutes" });
        }
      }, 2000);

      // Track this job for cleanup on shutdown
      const jobTracker = { jobLabel, poller, files: allFiles };
      this.activeJobs.add(jobTracker);
    });
  }
}
