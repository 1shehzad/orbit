import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`[${basename(cwd)}] ${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

export class GitManager {
  private projectFolder: string;

  constructor(projectFolder: string) {
    this.projectFolder = projectFolder;
  }

  async discoverRepos(): Promise<string[]> {
    const entries = await readdir(this.projectFolder, { withFileTypes: true });
    const repos: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const repoPath = join(this.projectFolder, entry.name);
        try {
          await run("git", ["rev-parse", "--git-dir"], repoPath);
          repos.push(repoPath);
        } catch {
          // not a git repo, skip
        }
      }
    }
    return repos;
  }

  async pullFromBase(repoPath: string, baseBranch: string): Promise<void> {
    await run("git", ["fetch", "origin"], repoPath);

    // Check if the branch exists on remote
    try {
      await run("git", ["rev-parse", "--verify", `origin/${baseBranch}`], repoPath);
    } catch {
      const repoName = basename(repoPath);
      throw new Error(`SKIP: ${repoName} has no "${baseBranch}" branch on remote`);
    }

    // Check if local branch exists
    try {
      await run("git", ["rev-parse", "--verify", baseBranch], repoPath);
      await run("git", ["checkout", baseBranch], repoPath);
    } catch {
      // Local branch doesn't exist, create it tracking the remote
      await run("git", ["checkout", "-b", baseBranch, `origin/${baseBranch}`], repoPath);
    }

    await run("git", ["pull", "origin", baseBranch], repoPath);
  }

  async createFeatureBranch(repoPath: string, branchName: string): Promise<void> {
    // Delete existing local branch if it exists (stale from previous run)
    try {
      await run("git", ["branch", "-D", branchName], repoPath);
    } catch {
      // branch doesn't exist, fine
    }
    await run("git", ["checkout", "-b", branchName], repoPath);
  }

  async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
    await run("git", ["checkout", branchName], repoPath);
  }

  async commitAll(repoPath: string, message: string): Promise<void> {
    await run("git", ["add", "-A"], repoPath);
    try {
      await run("git", ["commit", "-m", message], repoPath);
    } catch {
      // nothing to commit
    }
  }

  async pushBranch(repoPath: string, branchName: string): Promise<void> {
    await run("git", ["push", "-u", "origin", branchName], repoPath);
  }

  async mergeToBase(repoPath: string, branchName: string, baseBranch: string): Promise<void> {
    await run("git", ["checkout", baseBranch], repoPath);
    await run("git", ["merge", branchName, "--no-edit"], repoPath);
    await run("git", ["push", "origin", baseBranch], repoPath);
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    return run("git", ["branch", "--show-current"], repoPath);
  }

  async hasChanges(repoPath: string): Promise<boolean> {
    const status = await run("git", ["status", "--porcelain"], repoPath);
    return status.length > 0;
  }

  async listBranches(repoPath: string): Promise<string[]> {
    const output = await run("git", ["branch", "-a"], repoPath);
    return output.split("\n").map((b) => b.trim().replace("* ", ""));
  }

  /**
   * Get commits from the last N hours by a specific author (or all authors).
   */
  async getRecentCommits(repoPath: string, sinceHours = 24, author?: string): Promise<string[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const args = ["log", `--since=${since}`, "--oneline", "--no-merges", "-20"];
    if (author) args.push(`--author=${author}`);
    try {
      const output = await run("git", args, repoPath);
      return output ? output.split("\n").filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get recently merged PRs using gh CLI.
   */
  async getRecentPRs(repoPath: string, sinceHours = 24): Promise<{ number: number; title: string; url: string }[]> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    try {
      const output = await run("gh", [
        "pr", "list", "--state", "merged",
        "--search", `merged:>=${since.split("T")[0]}`,
        "--json", "number,title,url",
        "--limit", "20",
      ], repoPath);
      return output ? JSON.parse(output) : [];
    } catch {
      return [];
    }
  }

  /**
   * Get open PRs requesting review from the current user.
   */
  async getPRsToReview(repoPath: string): Promise<{ number: number; title: string; url: string; author: string; additions: number; deletions: number }[]> {
    try {
      const output = await run("gh", [
        "pr", "list", "--search", "review-requested:@me",
        "--json", "number,title,url,author,additions,deletions",
        "--limit", "20",
      ], repoPath);
      const prs = output ? JSON.parse(output) : [];
      return prs.map((pr: Record<string, unknown>) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: (pr.author as Record<string, string>)?.login || "unknown",
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get the diff for a specific PR.
   */
  async getPRDiff(repoPath: string, prNumber: number): Promise<string> {
    try {
      return await run("gh", ["pr", "diff", String(prNumber)], repoPath);
    } catch {
      return "";
    }
  }

  /**
   * Get PR details (description, files changed, etc.)
   */
  async getPRDetails(repoPath: string, prNumber: number): Promise<{ title: string; body: string; url: string; files: string[] }> {
    try {
      const output = await run("gh", [
        "pr", "view", String(prNumber),
        "--json", "title,body,url,files",
      ], repoPath);
      const data = JSON.parse(output);
      return {
        title: data.title || "",
        body: data.body || "",
        url: data.url || "",
        files: (data.files || []).map((f: { path: string }) => f.path),
      };
    } catch {
      return { title: "", body: "", url: "", files: [] };
    }
  }

  /**
   * Submit a PR review with comments.
   */
  async submitPRReview(
    repoPath: string,
    prNumber: number,
    body: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT",
  ): Promise<void> {
    await run("gh", [
      "pr", "review", String(prNumber),
      "--body", body,
      event === "APPROVE" ? "--approve" : event === "REQUEST_CHANGES" ? "--request-changes" : "--comment",
    ], repoPath);
  }

  async createPR(
    repoPath: string,
    branchName: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<{ url: string; number: number }> {
    // Push branch first
    await this.pushBranch(repoPath, branchName);

    // Create PR using gh CLI
    const output = await run("gh", [
      "pr", "create",
      "--base", baseBranch,
      "--head", branchName,
      "--title", title,
      "--body", body,
    ], repoPath);

    // gh pr create outputs the PR URL
    const url = output.trim();
    const prNumber = parseInt(url.split("/").pop() || "0", 10);
    return { url, number: prNumber };
  }

  async runBuild(repoPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const output = await run("npm", ["run", "build"], repoPath);
      return { success: true, output };
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  async runTests(repoPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const output = await run("npm", ["test", "--", "--passWithNoTests"], repoPath);
      return { success: true, output };
    } catch (err) {
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
  }

  async runLint(repoPath: string): Promise<{ success: boolean; output: string }> {
    try {
      const output = await run("npm", ["run", "lint"], repoPath);
      return { success: true, output };
    } catch (err) {
      // Lint script might not exist
      if (String(err).includes("Missing script")) {
        return { success: true, output: "No lint script found, skipping" };
      }
      return { success: false, output: err instanceof Error ? err.message : String(err) };
    }
  }
}
