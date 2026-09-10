import * as fs from "fs";
import * as path from "path";
import { generateProjectMap } from "./indexer.mjs";

/**
 * DynamicFieldGuide manages the shared stigmergic state and renders
 * the live .agent/FIELD_GUIDE.md document consumed by planners and workers.
 */
export class DynamicFieldGuide {
  constructor(workspaceDir = "./workspace", agentDir = "./.agent") {
    this.workspaceDir = path.resolve(workspaceDir);
    this.agentDir = path.resolve(agentDir);
    this.mdPath = path.join(this.agentDir, "FIELD_GUIDE.md");
    this.jsonPath = path.join(this.agentDir, "blackboard.json");

    // Ensure state directory exists
    fs.mkdirSync(this.agentDir, { recursive: true });

    // In-memory state structure
    this.state = {
      project: {
        targetRepo: process.env.TARGET_REPO || "local/workspace",
        branch: process.env.TARGET_BRANCH || "main",
        detectedStack: "Unknown",
        packageManager: "Unknown",
        testCommand: "echo 'No test runner configured'",
        compileCommand: "echo 'No build command configured'",
        entryPoints: []
      },
      goal: "",
      architectureMap: "",
      invariants: [
        "Read target line slices using 'read_file_slice' before editing.",
        "Surgical string replacements must include 3-5 lines of context to ensure uniqueness.",
        "Never merge code that fails the designated test verification oracle.",
        "Register all public functions, classes, and types with 'register_contract'."
      ],
      contracts: {}, // Module path -> array of signature strings
      tasks: [],     // Task DAG ledger
      knownIssues: []
    };

    this.isWriting = false;
    this.writeQueue = [];
  }

  /**
   * Initializes the blackboard for a new goal: auto-detects stack and builds AST map.
   */
  async initialize(userPrompt) {
    this.state.goal = userPrompt;
    
    // 1. Inspect repository structure and determine language toolchain
    this.detectEnvironment();

    // 2. Generate initial Tree-Sitter structural signature map
    try {
      console.log("🔍 [FieldGuide] Indexing target repository signatures via Tree-Sitter...");
      this.state.architectureMap = await generateProjectMap(".", this.workspaceDir, 40);
    } catch (err) {
      console.warn("⚠️ [FieldGuide] Tree-Sitter scan failed, using fallback directory list:", err.message);
      this.state.architectureMap = this.generateFallbackFileTree();
    }

    // 3. Persist initial files
    await this.persist();
  }

  /**
   * Deep environment inspection across package manifests and config files.
   */
  detectEnvironment() {
    const exists = (file) => fs.existsSync(path.join(this.workspaceDir, file));
    const readJson = (file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.workspaceDir, file), "utf-8"));
      } catch {
        return null;
      }
    };

    // Node.js / TypeScript / JavaScript
    if (exists("package.json")) {
      const pkg = readJson("package.json") || {};
      const hasTs = exists("tsconfig.json") || Boolean(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
      
      this.state.project.detectedStack = hasTs ? "TypeScript (Node.js)" : "JavaScript (Node.js)";
      
      if (exists("pnpm-lock.yaml")) this.state.project.packageManager = "pnpm";
      else if (exists("yarn.lock")) this.state.project.packageManager = "yarn";
      else if (exists("bun.lockb")) this.state.project.packageManager = "bun";
      else this.state.project.packageManager = "npm";

      const pm = this.state.project.packageManager;
      this.state.project.testCommand = pkg.scripts?.test ? `${pm} test` : `${pm} test --if-present`;
      this.state.project.compileCommand = hasTs ? "npx tsc --noEmit" : "node -e 'process.exit(0)'";
      
      const candidates = ["src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "index.ts", "index.js", "src/app.ts"];
      this.state.project.entryPoints = candidates.filter(exists);
      return;
    }

    // Rust
    if (exists("Cargo.toml")) {
      this.state.project.detectedStack = "Rust";
      this.state.project.packageManager = "cargo";
      this.state.project.testCommand = "cargo test";
      this.state.project.compileCommand = "cargo check";
      
      const candidates = ["src/lib.rs", "src/main.rs", "tests/"];
      this.state.project.entryPoints = candidates.filter(exists);
      return;
    }

    // Go
    if (exists("go.mod")) {
      this.state.project.detectedStack = "Go";
      this.state.project.packageManager = "go";
      this.state.project.testCommand = "go test ./...";
      this.state.project.compileCommand = "go vet ./...";
      
      const candidates = ["main.go", "cmd/main.go", "pkg/"];
      this.state.project.entryPoints = candidates.filter(exists);
      return;
    }

    // Python
    if (exists("pyproject.toml") || exists("requirements.txt") || exists("setup.py")) {
      this.state.project.detectedStack = "Python";
      this.state.project.packageManager = exists("poetry.lock") ? "poetry" : "pip";
      this.state.project.testCommand = exists("pytest.ini") || exists("tests") ? "pytest" : "python -m unittest discover";
      this.state.project.compileCommand = "python -m py_compile $(git ls-files '*.py')";
      
      const candidates = ["app.py", "main.py", "src/__init__.py"];
      this.state.project.entryPoints = candidates.filter(exists);
      return;
    }

    // C / C++
    if (exists("CMakeLists.txt")) {
      this.state.project.detectedStack = "C/C++ (CMake)";
      this.state.project.packageManager = "cmake";
      this.state.project.testCommand = "ctest --output-on-failure";
      this.state.project.compileCommand = "cmake --build build";
      return;
    }

    // Fallback Generic
    this.state.project.detectedStack = "Generic Polyglot";
    this.state.project.packageManager = "system";
    this.state.project.testCommand = "echo 'No test command found'";
    this.state.project.compileCommand = "echo 'No compile command found'";
  }

  /**
   * Fallback directory scanner when Tree-sitter is unavailable for certain formats.
   */
  generateFallbackFileTree() {
    const files = [];
    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist" || e.name === "target") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files.push(path.relative(this.workspaceDir, full));
      }
    };
    try {
      walk(this.workspaceDir);
      return files.slice(0, 50).map(f => `📄 ${f}`).join("\n");
    } catch {
      return "Unable to enumerate directory structure.";
    }
  }

  // ==========================================================================
  // Task DAG Management
  // ==========================================================================

  setTasks(taskList) {
    this.state.tasks = taskList.map(t => ({
      id: t.id,
      description: t.description,
      filesTargeted: t.filesTargeted || [],
      dependencies: t.dependencies || [],
      verificationCommand: t.verificationCommand || this.state.project.testCommand,
      status: "PENDING",
      summary: ""
    }));
    this.persist();
  }

  updateTaskStatus(taskId, status, summary = "") {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = status;
      if (summary) task.summary = summary;
    }
    this.persist();
  }

  // ==========================================================================
  // Stigmergic State (Shared Memory)
  // ==========================================================================

  /**
   * Worker calls this to register a newly exported type, function, or trait signature.
   */
  registerContract(modulePath, signature) {
    const cleanMod = modulePath.replace(/^\.\//, "");
    if (!this.state.contracts[cleanMod]) {
      this.state.contracts[cleanMod] = [];
    }

    const cleanSig = signature.trim();
    if (!this.state.contracts[cleanMod].includes(cleanSig)) {
      this.state.contracts[cleanMod].push(cleanSig);
      console.log(`📋 [FieldGuide] Registered contract in ${cleanMod}: ${cleanSig.slice(0, 60)}...`);
    }

    this.persist();
  }

  /**
   * Records a global architectural constraint discovered during execution.
   */
  registerInvariant(invariantText) {
    if (!this.state.invariants.includes(invariantText)) {
      this.state.invariants.push(invariantText);
      this.persist();
    }
  }

  /**
   * Records a known blocker, regression, or failing test case.
   */
  recordIssue(issueText) {
    this.state.knownIssues.push({
      issue: issueText,
      timestamp: Date.now()
    });
    this.persist();
  }

  // ==========================================================================
  // Prompt Context Generators
  // ==========================================================================

  /**
   * Context payload injected into the prompt of worker agents.
   */
  getAsWorkerContext() {
    const contractEntries = Object.entries(this.state.contracts);
    const contractsList = contractEntries.length === 0
      ? "  (None registered yet)"
      : contractEntries.map(([mod, sigs]) => `  * Module: ${mod}\n    ${sigs.join("\n    ")}`).join("\n\n");

    const issuesList = this.state.knownIssues.length === 0
      ? "  None reported."
      : this.state.knownIssues.slice(-3).map(i => `  ! ${i.issue}`).join("\n");

    return `### GLOBAL STIGMERGIC FIELD GUIDE (Shared Memory)
- Target Codebase: ${this.state.project.targetRepo} (${this.state.project.detectedStack})
- Package Manager: ${this.state.project.packageManager}
- Primary Test Oracle: ${this.state.project.testCommand}
- Architectural Invariants:
${this.state.invariants.map(inv => `  - ${inv}`).join("\n")}

- Registered Sibling Interfaces (Do NOT conflict with or duplicate these):
${contractsList}

- Known Active Issues / Regressions:
${issuesList}
`;
  }

  /**
   * Overview payload injected into the prompt of the planner.
   */
  getAsPlannerContext() {
    return `REPOSITORY: ${this.state.project.targetRepo}
STACK: ${this.state.project.detectedStack}
DEFAULT TEST ORACLE: ${this.state.project.testCommand}
ENTRY POINTS: ${this.state.project.entryPoints.join(", ") || "None identified"}

TREE-SITTER CODEBASE SKELETON:
${this.state.architectureMap}
`;
  }

  // ==========================================================================
  // Persistence & Markdown Renderer
  // ==========================================================================

  /**
   * Thread-safe asynchronous writer queue to prevent race conditions during parallel worker merges.
   */
  async persist() {
    return new Promise((resolve) => {
      this.writeQueue.push(resolve);
      if (!this.isWriting) {
        this.processWriteQueue();
      }
    });
  }

  async processWriteQueue() {
    if (this.writeQueue.length === 0) {
      this.isWriting = false;
      return;
    }

    this.isWriting = true;
    const callbacks = [...this.writeQueue];
    this.writeQueue = [];

    try {
      // 1. Write structured JSON
      fs.writeFileSync(this.jsonPath, JSON.stringify(this.state, null, 2), "utf-8");

      // 2. Render clean Markdown
      const md = this.renderMarkdown();
      fs.writeFileSync(this.mdPath, md, "utf-8");
    } catch (err) {
      console.error("❌ [FieldGuide] Failed to persist state:", err.message);
    } finally {
      callbacks.forEach(cb => cb());
      this.processWriteQueue();
    }
  }

  renderMarkdown() {
    const { project, goal, architectureMap, invariants, contracts, tasks, knownIssues } = this.state;

    return `# 🧭 SWARM FIELD GUIDE: ${project.targetRepo}
**Stack:** \`${project.detectedStack}\` | **Manager:** \`${project.packageManager}\` | **Oracle:** \`${project.testCommand}\` | **Branch:** \`${project.branch}\`

---

## 1. Goal & Mission Statement
> "${goal}"

---

## 2. Operational Invariants
${invariants.map(i => `* ${i}`).join("\n")}

---

## 3. Registered Contracts & Shared Interfaces (Stigmergy Blackboard)
${Object.keys(contracts).length === 0 ? "_No sibling contracts registered yet._" : ""}
${Object.entries(contracts).map(([mod, sigs]) => `### Module: \`${mod}\`\n\`\`\`\n${sigs.join("\n")}\n\`\`\``).join("\n\n")}

---

## 4. Architectural Map (Tree-Sitter Signatures)
${architectureMap || "_No signatures indexed._"}

---

## 5. Task DAG & Verification Ledger

| Task ID | Description | Targeted Files | Verification Oracle | Status |
| :--- | :--- | :--- | :--- | :--- |
${tasks.length === 0 ? "| _None_ | _No tasks decomposed yet_ | - | - | PENDING |" : ""}
${tasks.map(t => `| \`${t.id}\` | ${t.description} | \`${(t.filesTargeted || []).join(", ") || "*"}\` | \`${t.verificationCommand}\` | ${t.status === "VERIFIED" ? "✅ VERIFIED" : t.status === "IN_PROGRESS" ? "🔄 IN_PROGRESS" : t.status === "FAILED" ? "❌ FAILED" : "⏳ PENDING"} |`).join("\n")}

---

## 6. Known Regressions & Active Issues
${knownIssues.length === 0 ? "_No active regressions._" : knownIssues.map(ki => `* ⚠️ [${new Date(ki.timestamp).toISOString().slice(11, 19)}] ${ki.issue}`).join("\n")}
`;
  }
}

// Named alias export for compatibility
export const FieldGuide = DynamicFieldGuide;
