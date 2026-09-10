import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_TOOLS, executeTool } from "./tools.mjs";
import { DynamicFieldGuide } from "./blackboard.mjs";
import { SwarmLogger } from "./logger.mjs";
import { WorktreeManager } from "./worktree.mjs";
import { Referee } from "./referee.mjs";

// ============================================================================
// 1. Runtime Configuration & Environment Sanity Checks
// ============================================================================
const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || "./workspace");
const goal = process.env.USER_PROMPT || "Analyze target repository and resolve pending issues";
const maxConcurrency = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || "4", 10));
const targetRepo = process.env.TARGET_REPO || "local/workspace";
const targetBranch = process.env.TARGET_BRANCH || "main";

// Token Governor Budget (Circuit Breaker)
const MAX_SWARM_TOKENS = 8_000_000;
let totalTokensConsumed = 0;

const logger = new SwarmLogger("./.agent");
const fieldGuide = new DynamicFieldGuide(workspaceDir, "./.agent");
const worktrees = new WorktreeManager(workspaceDir);

// ============================================================================
// 2. Multi-Provider Cascade Setup (Planner Tier & Worker Tier)
// ============================================================================
function parseKeys(envVar) {
  return (process.env[envVar] || "")
    .split(/[,\n]+/)
    .map(k => k.trim())
    .filter(Boolean);
}

// Frontier Tier Pool (for Planner DAG generation and AST Conflict resolution)
const PLANNER_SLOTS = [];
const geminiKeys = parseKeys("GEMINI_API_KEYS");
const openrouterKeys = parseKeys("OPENROUTER_API_KEYS");

geminiKeys.forEach((key, i) => {
  PLANNER_SLOTS.push({
    id: `gemini-planner-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
    model: "gemini-2.5-pro"
  });
});

openrouterKeys.forEach((key, i) => {
  PLANNER_SLOTS.push({
    id: `openrouter-planner-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1" }),
    model: "deepseek/deepseek-r1"
  });
});

// High-Throughput Tier Pool (for Worktree Leaf Tasks)
const WORKER_SLOTS = [];
const groqKeys = parseKeys("GROQ_API_KEYS");
const cerebrasKeys = parseKeys("CEREBRAS_API_KEYS");

groqKeys.forEach((key, i) => {
  WORKER_SLOTS.push({
    id: `groq-worker-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://api.groq.com/openai/v1" }),
    model: "llama-3.3-70b-versatile"
  });
});

cerebrasKeys.forEach((key, i) => {
  WORKER_SLOTS.push({
    id: `cerebras-worker-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://api.cerebras.ai/v1" }),
    model: "llama-3.3-70b"
  });
});

// If no fast provider keys exist, fall back to planner slots for workers
if (WORKER_SLOTS.length === 0 && PLANNER_SLOTS.length > 0) {
  console.warn("⚠️ No dedicated worker keys found. Re-routing worker tasks to Planner pool.");
  WORKER_SLOTS.push(...PLANNER_SLOTS);
}

if (PLANNER_SLOTS.length === 0 && WORKER_SLOTS.length === 0) {
  console.error("❌ Fatal: No provider API keys detected in environment.");
  process.exit(1);
}

let activeWorkerSlotIdx = 0;
let activePlannerSlotIdx = 0;

function trackTokens(usage) {
  if (!usage) return;
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  totalTokensConsumed += tokens;

  logger.emit("token_ledger", "GOVERNOR", {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalConsumed: totalTokensConsumed,
    limit: MAX_SWARM_TOKENS
  });

  if (totalTokensConsumed > MAX_SWARM_TOKENS) {
    throw new Error(`🛑 CIRCUIT BREAKER TRIGGERED: Exceeded budget of ${MAX_SWARM_TOKENS} tokens.`);
  }
}

/**
 * Resilient caller with exponential backoff, jitter, and automatic slot rotation.
 */
async function callWithFailover(slots, getSlotIdx, setSlotIdx, payload, maxAttemptsPerSlot = 3) {
  let startIdx = getSlotIdx();

  for (let s = 0; s < slots.length; s++) {
    const slot = slots[(startIdx + s) % slots.length];

    for (let attempt = 1; attempt <= maxAttemptsPerSlot; attempt++) {
      try {
        const response = await slot.client.chat.completions.create({
          ...payload,
          model: slot.model
        });

        trackTokens(response.usage);
        setSlotIdx((startIdx + s) % slots.length);
        return response;
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && /rate limit|quota/i.test(err.message));
        const isServerErr = err.status >= 500;

        if ((isRateLimit || isServerErr) && attempt < maxAttemptsPerSlot) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(`[Slot ${slot.id}] Status ${err.status || "err"}. Backing off for ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        console.warn(`[Slot ${slot.id}] Slot failed. Rotating to next candidate...`);
        break;
      }
    }
  }

  throw new Error("All provider slots exhausted across cascade.");
}

// ============================================================================
// 3. Lead Architect / Planner Tier
// ============================================================================
async function planTaskDAG(goal, fieldGuideContent) {
  logger.emit("thought", "PLANNER", { text: "Analyzing Tree-Sitter AST & generating topological DAG..." });

  const systemPrompt = `You are the Lead Systems Architect.
You are inspecting an actual codebase mapped through Tree-sitter signatures.
Decompose the user's high-level goal into an explicit, topological DAG of atomic tasks.

STRICT CONSTRAINTS:
1. Each task must be independently implementable in an isolated branch.
2. If task B depends on interfaces introduced in task A, mark dependencies: ["task_A_id"].
3. Assign a concrete verificationCommand that proves correctness without hallucinating (e.g. 'npm test', 'cargo test target', 'pytest test_file.py').
4. Return ONLY valid JSON matching this schema:
{
  "tasks": [
    {
      "id": "task_1",
      "description": "Precise functional requirement",
      "filesTargeted": ["path/to/file.ext"],
      "verificationCommand": "npm test",
      "dependencies": []
    }
  ]
}`;

  const response = await callWithFailover(
    PLANNER_SLOTS,
    () => activePlannerSlotIdx,
    (idx) => { activePlannerSlotIdx = idx; },
    {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `FIELD GUIDE & CODEBASE CONTEXT:\n${fieldGuideContent}\n\nUSER GOAL:\n${goal}` }
      ],
      response_format: { type: "json_object" }
    }
  );

  try {
    const raw = JSON.parse(response.choices[0].message.content);
    return raw.tasks || [];
  } catch (err) {
    throw new Error(`Planner output failed JSON validation: ${err.message}`);
  }
}

// ============================================================================
// 4. Worker Execution Engine (Isolated Worktrees)
// ============================================================================
async function runWorkerSession(task, workerWorkspace) {
  let messages = [
    {
      role: "system",
      content: `You are an expert engineer implementing an assigned unit of work in an isolated worktree.
Target Repository: ${targetRepo}
Workspace Directory: ${workerWorkspace}
Target Files: ${JSON.stringify(task.filesTargeted)}

${fieldGuide.getAsWorkerContext()}

OPERATIONAL INVARIANTS:
1. Inspect target files with 'read_file_slice' before editing.
2. Edit surgical line segments using 'edit_file' (include 3-5 lines of context for uniqueness).
3. If you introduce a shared interface or export, notify the swarm by calling 'register_contract'.
4. Test your implementation via 'bash_exec' with: ${task.verificationCommand}.
5. Call 'finish_goal' ONLY when your verification command passes with 0 errors.`
    },
    {
      role: "user",
      content: task.errorFeedback
        ? `PREVIOUS RUN FAILED TEST ORACLE:\n${task.errorFeedback}\n\nFix all compilation or test errors now.`
        : `Task: ${task.description}\nTargeted Files: ${task.filesTargeted.join(", ")}`
    }
  ];

  let turn = 0;
  const maxTurns = 18;

  const workerTools = [
    ...CLAUDE_TOOLS,
    {
      type: "function",
      function: {
        name: "register_contract",
        description: "Register a reusable exported signature or interface in the global Field Guide",
        parameters: {
          type: "object",
          properties: {
            module: { type: "string", description: "Module or file path" },
            signature: { type: "string", description: "Exact exported function/class/type declaration" }
          },
          required: ["module", "signature"]
        }
      }
    }
  ];

  while (turn < maxTurns) {
    turn++;

    // Context compression for long turns
    if (messages.length > 14) {
      messages = [
        messages[0],
        { role: "assistant", content: `Context checkpoint: Completed initial investigation and edits.` },
        ...messages.slice(-4)
      ];
    }

    const response = await callWithFailover(
      WORKER_SLOTS,
      () => activeWorkerSlotIdx,
      (idx) => { activeWorkerSlotIdx = idx; },
      {
        messages,
        tools: workerTools,
        tool_choice: "auto"
      }
    );

    const choice = response.choices[0].message;
    messages.push(choice);

    if (choice.content) {
      logger.emit("thought", `WORKER (${task.id})`, { text: choice.content });
    }

    if (choice.tool_calls && choice.tool_calls.length > 0) {
      for (const call of choice.tool_calls) {
        const { name } = call.function;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch (_) {
          args = {};
        }

        logger.emit("tool_start", `WORKER (${task.id})`, { tool: name, args });

        let result = "";
        if (name === "register_contract") {
          fieldGuide.registerContract(args.module, args.signature);
          result = "Registered contract in global Field Guide.";
        } else {
          result = await executeTool(name, args, workerWorkspace);
        }

        logger.emit("tool_end", `WORKER (${task.id})`, {
          tool: name,
          preview: String(result).slice(0, 150)
        });

        if (result === "GOAL_ACCOMPLISHED") {
          return { success: true, summary: args.summary || "Task finished by worker." };
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: String(result)
        });
      }
    }
  }

  return { success: false, summary: "Reached maximum turn threshold." };
}

/**
 * Executes a single task with an automated Referee self-healing loop.
 */
async function executeTaskWithHealing(task, workerWorkspace, maxRetries = 3) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    logger.emit("thought", `WORKER (${task.id})`, {
      text: `Starting attempt ${attempt}/${maxRetries} for: "${task.description}"`
    });

    task.errorFeedback = lastError;
    const workerResult = await runWorkerSession(task, workerWorkspace);

    if (!workerResult.success) {
      console.warn(`⚠️ Worker failed turn loop on attempt ${attempt}.`);
    }

    // Referee Verification
    logger.emit("test_verify", "REFEREE", { taskId: task.id, command: task.verificationCommand });
    const verification = Referee.verify(task.verificationCommand, workerWorkspace);

    if (verification.passed) {
      logger.emit("test_passed", "REFEREE", { taskId: task.id });
      
      // Merge back to main workspace
      const mergeRes = worktrees.mergeBranch(task.id);
      if (mergeRes.success) {
        logger.emit("branch_merged", "REFEREE", { taskId: task.id });
        fieldGuide.updateTaskStatus(task.id, "VERIFIED", workerResult.summary);
        return true;
      }

      console.error(`Merge conflict in task ${task.id}: ${mergeRes.conflict}`);
      lastError = `Git merge conflict:\n${mergeRes.conflict}`;
    } else {
      logger.emit("self_healing", "REFEREE", {
        taskId: task.id,
        attempt,
        error: verification.output.slice(0, 300)
      });
      lastError = verification.output;
    }
  }

  worktrees.removeWorkerBranch(task.id);
  fieldGuide.updateTaskStatus(task.id, "FAILED", `Failed after ${maxRetries} attempts.`);
  return false;
}

// ============================================================================
// 5. Topological DAG Concurrency Scheduler
// ============================================================================
async function runTopologicalScheduler(tasks) {
  const completed = new Set();
  const executing = new Map(); // taskId -> Promise

  while (completed.size < tasks.length) {
    // 1. Find tasks whose dependencies are fully met and are not running
    const readyTasks = tasks.filter(t =>
      !completed.has(t.id) &&
      !executing.has(t.id) &&
      (t.dependencies || []).every(dep => completed.has(dep))
    );

    // 2. Schedule up to maxConcurrency
    const availableSlots = maxConcurrency - executing.size;
    const batch = readyTasks.slice(0, availableSlots);

    for (const task of batch) {
      fieldGuide.updateTaskStatus(task.id, "IN_PROGRESS");
      const workerWorkspace = worktrees.createWorkerBranch(task.id);
      logger.emit("worktree_created", "ORCHESTRATOR", { taskId: task.id, path: workerWorkspace });

      const taskPromise = executeTaskWithHealing(task, workerWorkspace)
        .then(passed => {
          executing.delete(task.id);
          if (passed) {
            completed.add(task.id);
          } else {
            throw new Error(`Verification oracle failed on ${task.id}`);
          }
        });

      executing.set(task.id, taskPromise);
    }

    // 3. Deadlock Detection
    if (executing.size === 0 && completed.size < tasks.length) {
      const remaining = tasks.filter(t => !completed.has(t.id)).map(t => t.id);
      throw new Error(`DAG Deadlock: Circular dependencies or unsatisfied requirements for [${remaining.join(", ")}].`);
    }

    // Wait for at least one worker to finish before scheduling the next batch
    await Promise.race(executing.values());
  }
}

// ============================================================================
// 6. Master Orchestrator Main Routine
// ============================================================================
async function main() {
  console.log("===============================================================================");
  console.log(`🐝 AVOS SWARM ENGINE: Initializing`);
  console.log(`🎯 Target Repository: ${targetRepo} (${targetBranch})`);
  console.log(`🎯 Goal: "${goal}"`);
  console.log(`⚡ Max Concurrency: ${maxConcurrency} workers`);
  console.log("===============================================================================");

  logger.emit("init", "ORCHESTRATOR", {
    goal,
    targetRepo,
    branch: targetBranch,
    maxConcurrency
  });

  // Step 1: Initialize Field Guide by parsing real ASTs in workspace
  await fieldGuide.initialize(goal);
  logger.emit("field_guide_initialized", "ORCHESTRATOR", {
    stack: fieldGuide.state.project.detectedStack,
    oracle: fieldGuide.state.project.testCommand
  });

  // Step 2: Planner generates Task DAG
  const rawGuideContent = fs.readFileSync(fieldGuide.filePath, "utf-8");
  const tasks = await planTaskDAG(goal, rawGuideContent);

  if (!tasks || tasks.length === 0) {
    console.log("⚠️ Planner identified zero tasks required. Goal may already be satisfied.");
    return;
  }

  fieldGuide.setTasks(tasks);
  fs.writeFileSync(".agent/task_dag.json", JSON.stringify(tasks, null, 2), "utf-8");
  logger.emit("dag_generated", "PLANNER", { totalTasks: tasks.length, tasks });

  // Step 3: Run workers topologically in parallel worktrees
  await runTopologicalScheduler(tasks);

  // Step 4: Final verification pass on the merged workspace
  console.log("\n⚖️ [Referee] Running final integration test pass on main workspace...");
  const finalCheck = Referee.verify(fieldGuide.state.project.testCommand, workspaceDir);

  if (!finalCheck.passed) {
    logger.emit("error", "REFEREE", { error: "Final integration pass failed on workspace root." });
    throw new Error(`Main branch regression detected:\n${finalCheck.output}`);
  }

  logger.emit("completed", "ORCHESTRATOR", {
    summary: `Swarm verified ${tasks.length} tasks successfully against ${targetRepo}`
  });

  console.log("\n===============================================================================");
  console.log("🎉 SWARM EXECUTION COMPLETED: All tasks passed verification oracle.");
  console.log("===============================================================================");
}

main().catch(err => {
  logger.emit("error", "ORCHESTRATOR", { message: err.message, stack: err.stack });
  console.error("\n💥 Swarm Engine Fatal Error:", err);
  process.exit(1);
});
