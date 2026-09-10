import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Referee evaluates code changes against deterministic test oracles,
 * parses compiler diagnostics, and guards against broken merges.
 */
export class Referee {
  /**
   * Primary verification entry point used by swarm.mjs and agent.mjs.
   *
   * @param {string} command - Test or compiler command (e.g. 'cargo test', 'npm test', 'pytest')
   * @param {string} cwd - Absolute or relative directory of the workspace or worktree
   * @param {object} options - Execution overrides (timeoutMs, env)
   * @returns {{ passed: boolean, output: string, exitCode: number, durationMs: number }}
   */
  static verify(command, cwd = "./workspace", options = {}) {
    const resolvedCwd = path.resolve(cwd);
    const timeout = Math.min(Math.max(options.timeoutMs || 90000, 5000), 300000); // 5s to 5m
    const startTime = Date.now();

    if (!command || command.trim() === "" || command.includes("No test")) {
      return {
        passed: true,
        output: "No verification oracle configured. Passed by default.",
        exitCode: 0,
        durationMs: 0
      };
    }

    try {
      const res = spawnSync("bash", ["-c", command], {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout,
        maxBuffer: 15 * 1024 * 1024, // 15MB buffer for large test outputs
        env: {
          ...process.env,
          ...options.env,
          CI: "true",
          RUST_BACKTRACE: "1",
          NODE_ENV: "test",
          PYTHONUNBUFFERED: "1"
        }
      });

      const durationMs = Date.now() - startTime;
      const stdout = res.stdout || "";
      const stderr = res.stderr || "";

      // Handle command execution timeouts
      if (res.error && res.error.code === "ETIMEDOUT") {
        return {
          passed: false,
          output: `TIMEOUT: Command '${command}' timed out after ${timeout / 1000} seconds.\n${this.extractTail(stdout + "\n" + stderr, 30)}`,
          exitCode: 124,
          durationMs
        };
      }

      // Successful test pass
      if (res.status === 0) {
        return {
          passed: true,
          output: this.extractSummary(stdout, stderr),
          exitCode: 0,
          durationMs
        };
      }

      // Failure: parse and isolate actionable diagnostics for self-healing
      const failureReport = this.parseActionableDiagnostics(stdout, stderr, res.status);

      return {
        passed: false,
        output: failureReport,
        exitCode: res.status ?? 1,
        durationMs
      };
    } catch (err) {
      return {
        passed: false,
        output: `Referee Execution Exception: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startTime
      };
    }
  }

  /**
   * Filters out compilation noise (downloading crates, intermediate object logs)
   * and isolates the exact root-cause compiler errors or failing test assertions.
   */
  static parseActionableDiagnostics(stdout, stderr, exitCode) {
    const raw = (stdout + "\n" + stderr).trim();
    const lines = raw.split("\n");

    // 1. Rust diagnostics (rustc / cargo test)
    if (raw.includes("error[E") || raw.includes("FAILED") || raw.includes("panicked at")) {
      const rustErrors = [];
      let capturing = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("error[E") || line.startsWith("error:") || line.includes("panicked at")) {
          capturing = true;
        }
        if (capturing) {
          rustErrors.push(line);
          // Stop capturing once a section ends
          if (line.trim() === "" && rustErrors.length > 25) {
            capturing = false;
          }
        }
        if (line.includes("failures:") || line.startsWith("test ") && line.endsWith("FAILED")) {
          rustErrors.push(line);
        }
      }

      if (rustErrors.length > 0) {
        return `RUST DIAGNOSTIC REPORT (Exit code ${exitCode}):\n` + rustErrors.slice(0, 50).join("\n");
      }
    }

    // 2. TypeScript / JavaScript diagnostics (tsc / jest / vitest)
    if (raw.includes("TS") || raw.includes("FAIL ") || raw.includes("AssertionError")) {
      const tsErrors = lines.filter(l => 
        l.includes("error TS") || 
        l.includes("FAIL ") || 
        l.includes("Expected:") || 
        l.includes("Received:") ||
        l.includes("● ") ||
        l.includes("AssertionError")
      );

      if (tsErrors.length > 0) {
        return `TYPESCRIPT/TEST FAILURE REPORT (Exit code ${exitCode}):\n` + tsErrors.slice(0, 40).join("\n");
      }
    }

    // 3. Python diagnostics (pytest / unittest)
    if (raw.includes("FAILED ") || raw.includes("Traceback") || raw.includes("AssertionError")) {
      const pyErrors = [];
      let inTraceback = false;

      for (const line of lines) {
        if (line.includes("Traceback (most recent call last):") || line.startsWith("FAILED ")) {
          inTraceback = true;
        }
        if (inTraceback) {
          pyErrors.push(line);
        }
      }

      if (pyErrors.length > 0) {
        return `PYTHON DIAGNOSTIC REPORT (Exit code ${exitCode}):\n` + pyErrors.slice(-40).join("\n");
      }
    }

    // 4. Go diagnostics (go test / go vet)
    if (raw.includes("--- FAIL:") || raw.includes(": undefined:") || raw.includes(": syntax error")) {
      const goErrors = lines.filter(l => 
        l.includes("--- FAIL:") || 
        l.includes("FAIL\t") || 
        l.includes(".go:")
      );

      if (goErrors.length > 0) {
        return `GO TEST REPORT (Exit code ${exitCode}):\n` + goErrors.slice(0, 40).join("\n");
      }
    }

    // Generic fallback: capture the last 40 lines of the output (where failures usually print)
    return `TEST ORACLE FAILED (Exit code ${exitCode}):\n${this.extractTail(raw, 40)}`;
  }

  /**
   * Extracts a brief confirmation summary from passing test outputs.
   */
  static extractSummary(stdout, stderr) {
    const combined = (stdout + "\n" + stderr).trim();
    const lines = combined.split("\n").filter(Boolean);

    // Look for standard test summary lines
    const summaryLine = lines.find(l => 
      l.includes("test result: ok") ||
      l.includes("passed") ||
      l.includes("Tests:") ||
      l.includes("PASS") ||
      l.includes("OK")
    );

    return summaryLine ? `Verification Passed: ${summaryLine.trim()}` : "Verification Passed with 0 errors.";
  }

  /**
   * Helper to grab the most relevant end lines of a terminal trace.
   */
  static extractTail(str, numLines = 30) {
    const lines = str.split("\n").filter(Boolean);
    if (lines.length <= numLines) return lines.join("\n");
    return lines.slice(-numLines).join("\n");
  }

  /**
   * Formats a failure payload specifically for injection into a worker agent's context.
   */
  static formatWorkerFeedback(taskId, verificationResult, attempt, maxAttempts) {
    return `### 🚨 VERIFICATION ORACLE FAILURE (Attempt ${attempt}/${maxAttempts})
Task: ${taskId}
The verification command returned non-zero exit status (${verificationResult.exitCode}).

ROOT CAUSE DIAGNOSTICS:
\`\`\`
${verificationResult.output}
\`\`\`

INSTRUCTIONS:
1. Review the line numbers and error codes above.
2. Use 'read_file_slice' to inspect the affected code and surrounding context.
3. Apply surgical corrections with 'edit_file'.
4. Do NOT call 'finish_goal' until you have run 'bash_exec' and verified the fix passes with zero errors.`;
  }
          }
