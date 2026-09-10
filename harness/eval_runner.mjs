import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ============================================================================
// 1. Core Evaluation Runner
// ============================================================================
export class EvalRunner {
  constructor(workspaceDir = "./workspace", outputDir = "./.agent") {
    this.workspaceDir = path.resolve(workspaceDir);
    this.outputDir = path.resolve(outputDir);
    this.reportPath = path.join(this.outputDir, "eval_report.json");
    this.summaryMdPath = path.join(this.outputDir, "EVAL_SUMMARY.md");

    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Main entry point: runs the evaluation suite based on detected or specified mode.
   *
   * @param {object} options
   * @param {"auto" | "native" | "sqllogictest"} [options.mode="auto"]
   * @param {string} [options.customCommand] - Custom test command to execute
   * @param {string} [options.sqllogicSuitePath] - Directory or file of .test files
   * @param {string} [options.dbBinary] - Path to compiled engine binary for sqllogictest
   * @returns {Promise<EvalResult>}
   */
  async run(options = {}) {
    const mode = options.mode || "auto";
    console.log(`🧪 [EvalRunner] Initializing Evaluation Harness (Mode: ${mode.toUpperCase()})...`);

    let result;

    if (mode === "sqllogictest" || (mode === "auto" && options.sqllogicSuitePath)) {
      result = await this.runSqlLogicTestSuite(
        options.sqllogicSuitePath || "./harness/sqllogictest",
        options.dbBinary || "./workspace/target/release/sqlite-rs"
      );
    } else {
      result = this.runNativeTestSuite(options.customCommand);
    }

    this.persistReport(result);
    return result;
  }

  // ==========================================================================
  // 2. Repository-Native Test Harness (Cargo / NPM / Pytest / Go)
  // ==========================================================================

  /**
   * Executes the target repository's native test framework and extracts structured metrics.
   */
  runNativeTestSuite(customCommand) {
    const command = customCommand || this.inferNativeTestCommand();
    console.log(`🏃 [EvalRunner] Executing native test oracle: '${command}'...`);

    const startTime = Date.now();
    const res = spawnSync("bash", ["-c", command], {
      cwd: this.workspaceDir,
      encoding: "utf-8",
      timeout: 180000, // 3-minute timeout
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        CI: "true",
        RUST_BACKTRACE: "1",
        NODE_ENV: "test",
        PYTHONUNBUFFERED: "1"
      }
    });

    const durationMs = Date.now() - startTime;
    const stdout = res.stdout || "";
    const stderr = res.stderr || "";
    const rawOutput = stdout + "\n" + stderr;
    const exitCode = res.status ?? (res.error ? 124 : 1);

    const metrics = this.parseNativeTestOutput(rawOutput);

    const passed = exitCode === 0 && metrics.failed === 0;

    return {
      suiteType: "native",
      command,
      passed,
      exitCode,
      durationMs,
      metrics: {
        total: metrics.total,
        passed: metrics.passed,
        failed: metrics.failed,
        skipped: metrics.skipped,
        passRatePercentage: metrics.total > 0 ? ((metrics.passed / metrics.total) * 100).toFixed(2) : (passed ? "100.00" : "0.00")
      },
      failures: metrics.failureDetails,
      rawOutputSnippet: rawOutput.slice(-2000)
    };
  }

  /**
   * Parses test results across common ecosystems into unified metrics.
   */
  parseNativeTestOutput(output) {
    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failureDetails = [];

    // Rust (cargo test)
    // Matches: "test result: ok. 42 passed; 0 failed; 1 ignored; ..."
    const rustMatch = output.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
    if (rustMatch) {
      passed = parseInt(rustMatch[2], 10);
      failed = parseInt(rustMatch[3], 10);
      skipped = parseInt(rustMatch[4], 10);
      total = passed + failed + skipped;

      const failureLines = output.split("\n").filter(l => l.startsWith("test ") && l.endsWith("... FAILED"));
      failureDetails.push(...failureLines);
      return { total, passed, failed, skipped, failureDetails };
    }

    // TypeScript/JavaScript (Jest / Vitest)
    // Matches: "Tests:  3 failed, 12 passed, 15 total"
    const jestMatch = output.match(/Tests:\s+(?:(\d+) failed,\s+)?(?:(\d+) passed,\s+)?(?:(\d+) skipped,\s+)?(\d+) total/);
    if (jestMatch) {
      failed = parseInt(jestMatch[1] || "0", 10);
      passed = parseInt(jestMatch[2] || "0", 10);
      skipped = parseInt(jestMatch[3] || "0", 10);
      total = parseInt(jestMatch[4], 10);
      return { total, passed, failed, skipped, failureDetails };
    }

    // Python (pytest)
    // Matches: "=== 12 passed, 2 failed, 1 skipped in 1.23s ==="
    const pyMatch = output.match(/=+\s+(?:(\d+) passed)?(?:,\s+)?(?:(\d+) failed)?(?:,\s+)?(?:(\d+) skipped)?.*in/);
    if (pyMatch) {
      passed = parseInt(pyMatch[1] || "0", 10);
      failed = parseInt(pyMatch[2] || "0", 10);
      skipped = parseInt(pyMatch[3] || "0", 10);
      total = passed + failed + skipped;
      return { total, passed, failed, skipped, failureDetails };
    }

    // Go (go test)
    const goPassed = (output.match(/--- PASS:/g) || []).length;
    const goFailed = (output.match(/--- FAIL:/g) || []).length;
    if (goPassed > 0 || goFailed > 0) {
      passed = goPassed;
      failed = goFailed;
      total = passed + failed;
      return { total, passed, failed, skipped, failureDetails };
    }

    // Generic fallback: check exit code
    const isSuccess = output.includes("PASS") || output.includes("ok") || !output.includes("FAIL");
    return {
      total: 1,
      passed: isSuccess ? 1 : 0,
      failed: isSuccess ? 0 : 1,
      skipped: 0,
      failureDetails: isSuccess ? [] : ["Native command returned non-zero exit status."]
    };
  }

  inferNativeTestCommand() {
    const exists = (f) => fs.existsSync(path.join(this.workspaceDir, f));
    if (exists("Cargo.toml")) return "cargo test";
    if (exists("package.json")) return "npm test";
    if (exists("go.mod")) return "go test ./...";
    if (exists("pytest.ini") || exists("pyproject.toml")) return "pytest";
    return "npm test --if-present";
  }

  // ==========================================================================
  // 3. SQLLogicTest Conformance Suite Engine
  // ==========================================================================

  /**
   * Evaluates target database binaries against official .test conformance scripts.
   */
  async runSqlLogicTestSuite(suitePath, dbBinary) {
    const resolvedSuite = path.resolve(suitePath);
    const resolvedBinary = path.resolve(dbBinary);

    console.log(`🗄️ [EvalRunner] Running SQLLogicTest conformance suite: ${resolvedSuite}`);

    if (!fs.existsSync(resolvedBinary)) {
      return {
        suiteType: "sqllogictest",
        passed: false,
        exitCode: 1,
        durationMs: 0,
        metrics: { total: 0, passed: 0, failed: 1, skipped: 0, passRatePercentage: "0.00" },
        failures: [`Database engine binary not found at '${resolvedBinary}'. Build it before testing.`],
        rawOutputSnippet: "Engine binary missing."
      };
    }

    // Collect all .test files
    const testFiles = [];
    if (fs.statSync(resolvedSuite).isDirectory()) {
      const entries = fs.readdirSync(resolvedSuite);
      for (const e of entries) {
        if (e.endsWith(".test")) testFiles.push(path.join(resolvedSuite, e));
      }
    } else {
      testFiles.push(resolvedSuite);
    }

    let totalStatements = 0;
    let passedStatements = 0;
    let failedStatements = 0;
    const failures = [];
    const startTime = Date.now();

    for (const file of testFiles) {
      const testCases = this.parseSqlLogicTestFile(fs.readFileSync(file, "utf-8"));
      console.log(`  📄 Testing ${path.basename(file)} (${testCases.length} assertions)...`);

      for (const tc of testCases) {
        totalStatements++;
        const testRes = this.evaluateSqlCase(tc, resolvedBinary);

        if (testRes.passed) {
          passedStatements++;
        } else {
          failedStatements++;
          failures.push({
            file: path.basename(file),
            line: tc.lineNumber,
            query: tc.sql,
            expected: tc.expected,
            actual: testRes.actual,
            error: testRes.error
          });

          // Abort file early if failure threshold exceeded (prevents infinite test loops)
          if (failures.length >= 25) break;
        }
      }

      if (failures.length >= 25) break;
    }

    const durationMs = Date.now() - startTime;
    const passed = failedStatements === 0 && totalStatements > 0;

    return {
      suiteType: "sqllogictest",
      passed,
      durationMs,
      metrics: {
        total: totalStatements,
        passed: passedStatements,
        failed: failedStatements,
        skipped: 0,
        passRatePercentage: totalStatements > 0 ? ((passedStatements / totalStatements) * 100).toFixed(2) : "0.00"
      },
      failures: failures.slice(0, 20),
      rawOutputSnippet: `Evaluated ${totalStatements} SQL logic assertions across ${testFiles.length} suites.`
    };
  }

  /**
   * Parses official SQLLogicTest script grammar.
   */
  parseSqlLogicTestFile(content) {
    const lines = content.split("\n");
    const cases = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      // Statement verification (statement ok / statement error)
      if (line.startsWith("statement ok") || line.startsWith("statement error")) {
        const expectedStatus = line.split(" ")[1];
        const lineNumber = i + 1;
        i++;
        const sqlLines = [];
        while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("----")) {
          sqlLines.push(lines[i]);
          i++;
        }
        cases.push({
          type: "statement",
          lineNumber,
          expected: expectedStatus,
          sql: sqlLines.join("\n").trim()
        });
      }

      // Query verification (query <type-string> [sortmode])
      else if (line.startsWith("query")) {
        const parts = line.split(/\s+/);
        const typeString = parts[1] || "T";
        const lineNumber = i + 1;
        i++;
        const sqlLines = [];
        while (i < lines.length && !lines[i].startsWith("----")) {
          sqlLines.push(lines[i]);
          i++;
        }
        i++; // Skip '----' separator

        const expectedLines = [];
        while (i < lines.length && lines[i].trim() !== "") {
          expectedLines.push(lines[i].trim());
          i++;
        }

        cases.push({
          type: "query",
          lineNumber,
          typeString,
          sql: sqlLines.join("\n").trim(),
          expected: expectedLines.join("\n")
        });
      }
      i++;
    }

    return cases;
  }

  /**
   * Executes a single parsed SQLLogicTest assertion against the database engine binary.
   */
  evaluateSqlCase(testCase, dbBinary) {
    try {
      const res = spawnSync(dbBinary, {
        input: testCase.sql + ";\n",
        encoding: "utf-8",
        timeout: 5000
      });

      const actualOut = (res.stdout || "").trim();
      const exitCode = res.status;

      if (testCase.type === "statement") {
        if (testCase.expected === "ok") {
          return { passed: exitCode === 0, actual: actualOut, error: res.stderr };
        } else {
          return { passed: exitCode !== 0, actual: actualOut, error: res.stderr };
        }
      }

      if (testCase.type === "query") {
        if (exitCode !== 0) {
          return { passed: false, actual: actualOut, error: res.stderr || "Query exited with error code" };
        }

        // Compare values or MD5 hash if expected exceeds hash threshold
        const normalizedActual = actualOut.replace(/\r\n/g, "\n").trim();
        const normalizedExpected = testCase.expected.replace(/\r\n/g, "\n").trim();

        if (normalizedExpected.startsWith("valueshash:")) {
          const actualHash = crypto.createHash("md5").update(normalizedActual + "\n").digest("hex");
          const expectedHash = normalizedExpected.split(":")[1].trim();
          return { passed: actualHash === expectedHash, actual: `hash:${actualHash}`, expected: `hash:${expectedHash}` };
        }

        return {
          passed: normalizedActual === normalizedExpected,
          actual: normalizedActual,
          expected: normalizedExpected
        };
      }

      return { passed: true };
    } catch (err) {
      return { passed: false, actual: "", error: err.message };
    }
  }

  // ==========================================================================
  // 4. Persistence & Reporting
  // ==========================================================================

  persistReport(result) {
    // 1. Write JSON Report for Machine Ingestion / CI Artifacts
    fs.writeFileSync(this.reportPath, JSON.stringify(result, null, 2), "utf-8");

    // 2. Render Markdown Summary for GitHub Step Summary
    const md = `# 🧪 Evaluation Conformance Report
**Status:** ${result.passed ? "✅ PASSED" : "❌ FAILED"} | **Suite:** \`${result.suiteType}\` | **Duration:** \`${(result.durationMs / 1000).toFixed(2)}s\`

### 📊 Conformance Metrics
| Metric | Value |
| :--- | :--- |
| **Pass Rate** | **${result.metrics.passRatePercentage}%** |
| **Total Assertions** | ${result.metrics.total} |
| **Passed** | ${result.metrics.passed} |
| **Failed** | ${result.metrics.failed} |
| **Skipped** | ${result.metrics.skipped} |

${result.failures.length > 0 ? `### 🚨 Failure Breakdown\n\`\`\`json\n${JSON.stringify(result.failures.slice(0, 10), null, 2)}\n\`\`\`` : "### 🎉 All assertions passed with zero regressions."}

---
*Generated by AVOS Conformance Oracle.*
`;

    fs.writeFileSync(this.summaryMdPath, md, "utf-8");
  }
}

// ============================================================================
// 5. Standalone CLI Invocation
// ============================================================================
if (process.argv[1] && process.argv[1].endsWith("eval_runner.mjs")) {
  const args = process.argv.slice(2);
  let customCmd = null;
  let mode = "auto";
  let suitePath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cmd" && args[i + 1]) customCmd = args[++i];
    if (args[i] === "--mode" && args[i + 1]) mode = args[++i];
    if (args[i] === "--suite" && args[i + 1]) suitePath = args[++i];
  }

  const runner = new EvalRunner();
  runner.run({ mode, customCommand: customCmd, sqllogicSuitePath: suitePath })
    .then(res => {
      console.log(`\n[EvalRunner] Execution Finished. Result: ${res.passed ? "PASSED" : "FAILED"}`);
      process.exit(res.passed ? 0 : 1);
    })
    .catch(err => {
      console.error("[EvalRunner] Fatal Error:", err);
      process.exit(1);
    });
      }
