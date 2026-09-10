import * as fs from "fs";
import * as path from "path";
import { callPlanner, callWorker, getTokenLedgerReport } from "./providers.mjs";
import { CLAUDE_TOOLS, executeTool } from "./tools.mjs";
import { DynamicFieldGuide } from "./blackboard.mjs";
import { SwarmLogger } from "./logger.mjs";
import { WorktreeManager } from "./worktree.mjs";
import { Referee } from "./referee.mjs";
import { EvalRunner } from "../harness/eval_runner.mjs";

// ============================================================================
// 1. Environment & Subsystem Setup
// ============================================================================
const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || "./workspace");
const goal = process.env.USER_PROMPT || "Analyze target repository and resolve pending tasks";
const maxConcurrency = Math.max(1, parseInt(process.env.MAX_CONCURRENCY || "4", 10));
const targetRepo = process.env.TARGET_REPO || "local/workspace";
const targetBranch = process.env.TARGET_BRANCH || "main";

const logger = new SwarmLogger("./.agent");
const fieldGuide = new DynamicFieldGuide(workspaceDir, "./.agent");
const worktrees = new WorktreeManager(workspaceDir, "./.worktrees");
const evaluator = new EvalRunner(workspaceDir, "./.agent");

// ============================================================================
// 2. Lead Architect: Dynamic DAG Generation
// ============================================================================
async function planTaskDAG(goal, fieldGuideMarkdown) {
  logger.emit("thought", "PLANNER", { text: "Analyzing Tree-Sitter AST signatures and generating topological Task DAG..." });

  const systemPrompt = `You are the Lead Systems Architect.
You are given the live Field Guide and Tree-Sitter signatures of an actual codebase.
Decompose the user's goal into an explicit, topological DAG of atomic, implementable units of work.

STRICT REQUIREMENTS:
1. Divide work cleanly across modules so workers can run in parallel without file collisions.
2. Explicitly specify 'dependencies' as an array of prerequisite task IDs.
3. Assign a concrete 'verificationCommand' (e.g., 'npm test path/to/test.ts', 'cargo test module', 'pytest tests/test_feature.py').
4. Return ONLY valid JSON matching this schema:
{
  "tasks": [
    {
      "id": "task_1",
      "description": "Concrete functional deliverable",
      "filesTargeted": ["relative/path/to/file.ext"],
      "verificationCommand": "npm test",
      "dependencies": []
    }
  ]
}`;

  const res = await callPlanner({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `FIELD GUIDE & CODEBASE CONTEXT:\n${fieldGuideMarkdown}\n\nUSER GOAL:\n${goal}` }
    ],
    response_format: { type: "json_object" }
  });

  try {
    const raw = JSON.parse(res.response.choices[0].message.content);
    return raw.tasks || [];
  } catch (err) {
    throw new Error(`Planner output failed JSON validation: ${err.message}`);
  }
}

// ============================================================================
// 3. Worker Execution Loop (Isolated Worktree & Self-Healing)
// ============================================================================
async function runWorkerSession(task, workerWorkspace) {
  let messages = [
    {
      role: "system",
      content: `You are an expert engineer implementing an assigned task in an isolated Git worktree.
Target Repository: ${targetRepo}
Workspace Directory: ${workerWorkspace}
Target Files: ${JSON.stringify(task.filesTargeted)}

${fieldGuide.getAsWorkerContext()}

INVARIANTS:
1. Inspect files with 'read_file_slice' before editing.
2. Apply surgical changes with 'edit_file' (include 3-5 lines of surrounding context).
3. If you introduce or change any exported function, class, or type, call 'register_contract'.
4. Test changes locally via 'bash_exec' with: ${task.verificationCommand}.
5. Call 'finish_goal' ONLY when your verification command passes with 0 errors.`
    },
    {
      role: "user",
      content: task.errorFeedback
        ? `PREVIOUS RUN FAILED TEST ORACLE:\n${task.errorFeedback}\n\nFix all compilation or test assertion errors now.`
        : `Task Deliverable: ${task.description}\nTargeted Files: ${task.filesTargeted.join(", ")}`
    }
  ];

  const workerTools = [
    ...CLAUDE_TOOLS,
    {
      type: "function",
      function: {
        name: "register_contract",
        description: "Register an exported signature, trait, or interface in the global Field Guide",
        parameters: {
          type: "object",
          properties: {
            module: { type: "string", description: "Module or file path" },
            signature: { type: "string", description: "Exact exported signature declaration" }
          },
          required: ["module", "signature"]
        }
      }
    }
  ];

  let turn = 0;
  const maxTurns = 18;

  while (turn < maxTurns) {
    turn++;

    // Context compression for long sessions
    if (messages.length > 14) {
      messages = [
        messages[0],
        { role: "assistant", content: `Context checkpoint: Completed initial investigation and edits.` },
        ...messages.slice(-4)
      ];
    }

    const { response, slotId } = await callWorker({
      messages,
      tools: workerTools,
      tool_choice: "auto"
    });

    const choice = response.choices[0].message;
    messages.push(choice);

    if (choice.content) {
      logger.emit("thought", `WORKER (${task.id})`, { slotId, text: choice.content });
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
          result = `Registered contract in Field Guide for module '${args.module}'.`;
        } else {
          result = await executeTool(name, args, workerWorkspace);
        }

        logger.emit("tool_end", `WORKER (${task.id})`, {
          tool: name,
          preview: String(result).slice(0, 150)
        });

        if (result === "GOAL_ACCOMPLISHED") {
          return { success: true, summary: args.summary || "Task completed by worker." };
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
 * Orchestrates worker execution with the Referee self-healing loop.
 */
async function executeTaskWithHealing(task, workerWorkspace, maxRetries = 3) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    logger.emit("thought", `WORKER (${task.id})`, {
      text: `Executing attempt ${attempt}/${maxRetries} for: "${task.description}"`
    });

    task.errorFeedback = lastError;
    const workerResult = await runWorkerSession(task, workerWorkspace);

    if (!workerResult.success) {
      console.warn(`⚠️ Worker finished turn loop without clean verification on attempt ${attempt}.`);
    }

    // Referee Verification Oracle
    logger.emit("test_verify", "REFEREE", { taskId: task.id, command: task.verificationCommand });
    const verification = Referee.verify(task.verificationCommand, workerWorkspace);

    if (verification.passed) {
      logger.emit("test_passed", "REFEREE", { taskId: task.id, durationMs: verification.durationMs });

      // Merge worktree branch into main workspace
      const mergeRes = await worktrees.mergeBranch(task.id);
      if (mergeRes.success) {
        logger.emit("branch_merged", "REFEREE", { taskId: task.id });
        fieldGuide.updateTaskStatus(task.id, "VERIFIED", workerResult.summary);
        return true;
      }

      // Handle merge collision using LLM Conflict Resolver
      console.warn(`💥 [Worktree] Merge conflict on task ${task.id}. Attempting semantic resolution...`);
      for (const conflictFile of mergeRes.conflictingFiles) {
        const resolvedContent = await worktrees.resolveConflictWithLLM(
          conflictFile,
          mergeRes.diff,
          callPlanner
        );
        fs.writeFileSync(path.join(workspaceDir, conflictFile), resolvedContent, "utf-8");
      }

      // Re-verify main workspace after manual resolution
      const postResolveCheck = Referee.verify(task.verificationCommand, workspaceDir);
      if (postResolveCheck.passed) {
        worktrees.removeWorkerBranch(task.id);
        fieldGuide.updateTaskStatus(task.id, "VERIFIED", "Resolved via semantic merge.");
        return true;
      }

      lastError = `Merge conflict resolution failed tests:\n${postResolveCheck.output}`;
    } else {
      logger.emit("self_healing", "REFEREE", {
        taskId: task.id,
        attempt,
        error: verification.output.slice(0, 300)
      });
      lastError = Referee.formatWorkerFeedback(task.id, verification, attempt, maxRetries);
    }
  }

  await worktrees.removeWorkerBranch(task.id);
  fieldGuide.updateTaskStatus(task.id, "FAILED", `Failed after ${maxRetries} attempts.`);
  return false;
}

// ============================================================================
// 4. Topological DAG Concurrency Scheduler
// ============================================================================
async function runTopologicalScheduler(tasks) {
  const completed = new Set();
  const executing = new Map(); // taskId -> Promise

  while (completed.size < tasks.length) {
    // Find unblocked tasks whose dependencies are verified
    const readyTasks = tasks.filter(t =>
      !completed.has(t.id) &&
      !executing.has(t.id) &&
      (t.dependencies || []).every(dep => completed.has(dep))
    );

    // Fill slots up to maxConcurrency
    const availableSlots = maxConcurrency - executing.size;
    const batch = readyTasks.slice(0, availableSlots);

    for (const task of batch) {
      fieldGuide.updateTaskStatus(task.id, "IN_PROGRESS");
      const workerWorkspace = await worktrees.createWorkerBranch(task.id);
      logger.emit("worktree_created", "ORCHESTRATOR", { taskId: task.id, path: workerWorkspace });

      const taskPromise = executeTaskWithHealing(task, workerWorkspace)
        .then(passed => {
          executing.delete(task.id);
          if (passed) {
            completed.add(task.id);
          } else {
            throw new Error(`Task ${task.id} failed verification oracle.`);
          }
        });

      executing.set(task.id, taskPromise);
    }

    if (executing.size === 0 && completed.size < tasks.length) {
      const remaining = tasks.filter(t => !completed.has(t.id)).map(t => t.id);
      throw new Error(`DAG Deadlock: Unmet dependencies for tasks [${remaining.join(", ")}].`);
    }

    // Wait for any worker to finish before scheduling the next batch
    await Promise.race(executing.values());
  }
}

// ============================================================================
// 5. Main Execution Entry Point
// ============================================================================
async function main() {
  console.log("===============================================================================");
  console.log(`🐝 AVOS SWARM ENGINE: Initializing`);
  console.log(`🎯 Target Repository: ${targetRepo} (${targetBranch})`);
  console.log(`🎯 Goal: "${goal}"`);
  console.log(`⚡ Concurrency Limit: ${maxConcurrency} workers`);
  console.log("===============================================================================");

  logger.emit("init", "ORCHESTRATOR", {
    goal,
    targetRepo,
    branch: targetBranch,
    maxConcurrency
  });

  // 1. Inspect target workspace and initialize dynamic Field Guide
  await fieldGuide.initialize(goal);
  logger.emit("field_guide_initialized", "ORCHESTRATOR", {
    stack: fieldGuide.state.project.detectedStack,
    oracle: fieldGuide.state.project.testCommand
  });

  // 2. Generate Topological Task DAG
  const rawGuideContent = fs.readFileSync(fieldGuide.mdPath, "utf-8");
  const tasks = await planTaskDAG(goal, rawGuideContent);

  if (!tasks || tasks.length === 0) {
    console.log("⚠️ Planner identified zero tasks required. Goal may already be satisfied.");
    return;
  }

  fieldGuide.setTasks(tasks);
  fs.writeFileSync(".agent/task_dag.json", JSON.stringify(tasks, null, 2), "utf-8");
  logger.emit("dag_generated", "PLANNER", { totalTasks: tasks.length, tasks });

  // 3. Execute Worker Tasks in Parallel Worktrees
  await runTopologicalScheduler(tasks);

  // 4. Final Comprehensive Conformance Evaluation
  console.log("\n🧪 [Referee] Executing final evaluation oracle on unified workspace...");
  const evalResult = await evaluator.run({
    mode: "auto",
    customCommand: fieldGuide.state.project.testCommand
  });

  if (!evalResult.passed) {
    logger.emit("error", "REFEREE", { error: "Final integration evaluation failed." });
    throw new Error(`Post-merge regression detected: ${evalResult.metrics.failed} tests failed.`);
  }

  // 5. Finalize and report token metrics
  const ledger = getTokenLedgerReport();
  logger.emit("completed", "ORCHESTRATOR", {
    summary: `Swarm completed ${tasks.length} tasks successfully on ${targetRepo}.`,
    tokenMetrics: ledger
  });

  console.log("\n===============================================================================");
  console.log(`🎉 SWARM EXECUTION COMPLETED SUCCESSFULLY`);
  console.log(`📊 Tokens Consumed: ${ledger.totalTokens.toLocaleString()} (Est. Cost: $${ledger.estimatedCostUsd.toFixed(4)})`);
  console.log(`📊 Total API Calls: ${ledger.callsCount}`);
  console.log("===============================================================================");
}

main().catch(err => {
  logger.emit("error", "ORCHESTRATOR", { message: err.message, stack: err.stack });
  console.error("\n💥 Swarm Engine Fatal Error:", err);
  worktrees.cleanupAll();
  process.exit(1);
});
