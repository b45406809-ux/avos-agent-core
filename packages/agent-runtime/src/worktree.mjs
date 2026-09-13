import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * WorktreeManager isolates worker agent environments using Git Worktrees.
 * Each worker operates on an independent directory and branch, preventing file locks.
 */
export class WorktreeManager {
  constructor(baseDir = "./workspace", worktreeParentDir = "./.worktrees") {
    this.baseDir = path.resolve(baseDir);
    this.worktreeParentDir = path.resolve(worktreeParentDir);
    
    // Serial execution queue for main git index operations (avoids index.lock collisions)
    this.gitLock = Promise.resolve();
    
    fs.mkdirSync(this.worktreeParentDir, { recursive: true });
    this.ensureGitRepo();
  }

  /**
   * Internal mutex to serialize git commands that modify .git metadata
   */
  async withGitLock(fn) {
    const nextLock = this.gitLock.then(async () => {
      return await fn();
    });
    this.gitLock = nextLock.catch(() => {}); // prevent chain breakage on errors
    return nextLock;
  }

  /**
   * Ensures the target workspace is an initialized Git repository with an initial commit.
   */
  ensureGitRepo() {
    const gitDir = path.join(this.baseDir, ".git");

    if (!fs.existsSync(gitDir)) {
      console.log("⚙️ [Worktree] Initializing Git repository in workspace root...");
      execSync("git init", { cwd: this.baseDir, stdio: "ignore" });
    }

    // Configure user identity if not present
    try {
      execSync("git config user.name", { cwd: this.baseDir, stdio: "pipe" });
    } catch {
      execSync('git config user.name "AVOS Swarm Engine"', { cwd: this.baseDir, stdio: "ignore" });
      execSync('git config user.email "swarm@avos.ai"', { cwd: this.baseDir, stdio: "ignore" });
    }

    // Add safe directory exceptions
    try {
      execSync(`git config --global --add safe.directory "${this.baseDir}"`, { stdio: "ignore" });
      execSync(`git config --global --add safe.directory "*"`, { stdio: "ignore" });
    } catch (_) {}

    // Ensure at least one commit exists on base branch so worktree branching succeeds
    try {
      execSync("git rev-parse HEAD", { cwd: this.baseDir, stdio: "pipe" });
    } catch {
      console.log("⚙️ [Worktree] Creating initial baseline commit...");
      execSync("git add -A && git commit -m 'chore: initial workspace baseline' --allow-empty", {
        cwd: this.baseDir,
        stdio: "ignore"
      });
    }

    // Clean up stale worktree references from previous aborted runs
    try {
      execSync("git worktree prune", { cwd: this.baseDir, stdio: "ignore" });
    } catch (_) {}
  }

  /**
   * Creates an isolated worktree and branch for a worker task.
   * Returns the absolute directory path where the worker can safely edit.
   */
  async createWorkerBranch(taskId) {
    return await this.withGitLock(async () => {
      const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const branchName = `agent-task-${sanitizedId}`;
      const worktreePath = path.join(this.worktreeParentDir, sanitizedId);

      // Clean up previous worktree or directory if left over
      this.cleanupPathAndBranch(worktreePath, branchName);

      // Create branch and worktree rooted from current HEAD of main workspace
      try {
        execSync(`git worktree add -B "${branchName}" "${worktreePath}" HEAD`, {
          cwd: this.baseDir,
          stdio: "pipe",
          encoding: "utf-8"
        });
      } catch (err) {
        // Fallback: force prune and retry once
        execSync("git worktree prune", { cwd: this.baseDir, stdio: "ignore" });
        execSync(`git worktree add -f -B "${branchName}" "${worktreePath}" HEAD`, {
          cwd: this.baseDir,
          stdio: "pipe",
          encoding: "utf-8"
        });
      }

      return worktreePath;
    });
  }

  /**
   * Commits all changes within a worker's isolated worktree.
   */
  commitWorkerChanges(taskId, commitMessage = "feat(worker): apply task implementation") {
    const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const worktreePath = path.join(this.worktreeParentDir, sanitizedId);

    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Cannot commit: Worktree directory ${worktreePath} does not exist.`);
    }

    try {
      execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });

      // Check if there are staged changes
      const status = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" }).trim();
      if (!status) {
        return { committed: false, message: "No changes to commit." };
      }

      execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
        cwd: worktreePath,
        stdio: "pipe"
      });

      const hash = execSync("git rev-parse HEAD", { cwd: worktreePath, encoding: "utf-8" }).trim();
      return { committed: true, commitHash: hash };
    } catch (err) {
      throw new Error(`Failed to commit in worktree ${sanitizedId}: ${err.message}`);
    }
  }

  /**
   * Merges a completed worker branch back into the main workspace.
   * If a merge conflict occurs, attempts automatic conflict extraction.
   */
  async mergeBranch(taskId) {
    return await this.withGitLock(async () => {
      const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const branchName = `agent-task-${sanitizedId}`;
      const worktreePath = path.join(this.worktreeParentDir, sanitizedId);

      // 1. Commit any uncommitted changes in the worktree
      try {
        this.commitWorkerChanges(taskId, `feat(worker): finalize ${taskId}`);
      } catch (_) {}

      // 2. Remove the active worktree before merging so git doesn't complain about checked-out branch
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: this.baseDir,
          stdio: "ignore"
        });
      } catch (_) {
        if (fs.existsSync(worktreePath)) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        execSync("git worktree prune", { cwd: this.baseDir, stdio: "ignore" });
      }

      // 3. Attempt merge into main workspace
      try {
        execSync(`git merge --no-ff -m "feat(swarm): merge verified task ${taskId}" ${branchName}`, {
          cwd: this.baseDir,
          stdio: "pipe",
          encoding: "utf-8"
        });

        // Delete the merged branch
        execSync(`git branch -D ${branchName}`, { cwd: this.baseDir, stdio: "ignore" });
        return { success: true };
      } catch (err) {
        // Collect conflict details
        const conflictStatus = execSync("git status --porcelain", { cwd: this.baseDir, encoding: "utf-8" });
        const conflictingFiles = conflictStatus
          .split("\n")
          .filter(line => line.startsWith("UU ") || line.startsWith("AA ") || line.startsWith("DD "))
          .map(line => line.slice(3).trim());

        let conflictDiff = "";
        try {
          conflictDiff = execSync("git diff", { cwd: this.baseDir, encoding: "utf-8" });
        } catch (_) {}

        // Abort merge to restore main workspace to clean state
        try {
          execSync("git merge --abort", { cwd: this.baseDir, stdio: "ignore" });
        } catch (_) {}

        return {
          success: false,
          conflict: err.message,
          conflictingFiles,
          diff: conflictDiff
        };
      }
    });
  }

  /**
   * Resolves standard 3-way merge conflict markers using an LLM Referee.
   */
  async resolveConflictWithLLM(filePath, conflictDiff, plannerClient, plannerModel) {
    console.log(`⚖️ [Worktree] Invoking LLM merge referee for ${filePath}...`);

    const prompt = `You are an expert Git Conflict Resolver.
A concurrent agent merge caused the following conflict markers in file '${filePath}'.

STRICT RULES:
1. Merge both changes cleanly without losing functionality.
2. Remove all '<<<<<<<', '=======', and '>>>>>>>' conflict markers.
3. Return ONLY the clean, final file contents. Do not include markdown code blocks (e.g. no \`\`\` or \`\`\`rust).

CONFLICT DIFF:
${conflictDiff}`;

    const res = await plannerClient.chat.completions.create({
      model: plannerModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0
    });

    let resolvedContent = res.choices[0].message.content.trim();

    // Strip accidental code block wrapping
    if (resolvedContent.startsWith("```")) {
      resolvedContent = resolvedContent.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
    }

    return resolvedContent;
  }

  /**
   * Completely tears down an isolated worker branch and removes its directory.
   */
  async removeWorkerBranch(taskId) {
    return await this.withGitLock(async () => {
      const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const branchName = `agent-task-${sanitizedId}`;
      const worktreePath = path.join(this.worktreeParentDir, sanitizedId);
      this.cleanupPathAndBranch(worktreePath, branchName);
    });
  }

  /**
   * Synchronous internal helper to destroy branch and path
   */
  cleanupPathAndBranch(worktreePath, branchName) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, {
        cwd: this.baseDir,
        stdio: "ignore"
      });
    } catch (_) {}

    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch (_) {}
    }

    try {
      execSync("git worktree prune", { cwd: this.baseDir, stdio: "ignore" });
    } catch (_) {}

    try {
      execSync(`git branch -D "${branchName}"`, { cwd: this.baseDir, stdio: "ignore" });
    } catch (_) {}
  }

  /**
   * Emergency teardown of all worktrees on process exit
   */
  cleanupAll() {
    try {
      execSync("git worktree prune", { cwd: this.baseDir, stdio: "ignore" });
      if (fs.existsSync(this.worktreeParentDir)) {
        fs.rmSync(this.worktreeParentDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}
