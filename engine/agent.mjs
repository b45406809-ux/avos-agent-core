import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_TOOLS, executeTool } from "./tools.mjs";
import { DynamicFieldGuide } from "./blackboard.mjs";
import { SwarmLogger } from "./logger.mjs";
import { Referee } from "./referee.mjs";

// ============================================================================
// 1. Environment & Configuration
// ============================================================================
const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || "./workspace");
const goal = process.env.USER_PROMPT || "Inspect repository and report findings";
const maxTurns = parseInt(process.env.MAX_TURNS || "35", 10);
const targetRepo = process.env.TARGET_REPO || "local/workspace";

// Circuit Breaker Token Governor
const MAX_SESSION_TOKENS = 4_000_000;
let totalTokensConsumed = 0;

const logger = new SwarmLogger("./.agent");
const fieldGuide = new DynamicFieldGuide(workspaceDir, "./.agent");

// ============================================================================
// 2. Multi-Provider Cascade Setup
// ============================================================================
function parseKeys(envVar) {
  return (process.env[envVar] || "")
    .split(/[,\n]+/)
    .map(k => k.trim())
    .filter(Boolean);
}

const PROVIDER_SLOTS = [];

// Gemini (Fast & large context)
parseKeys("GEMINI_API_KEYS").forEach((key, i) => {
  PROVIDER_SLOTS.push({
    id: `gemini-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
    model: "gemini-2.5-flash"
  });
});

// Groq (Ultra low-latency inference)
parseKeys("GROQ_API_KEYS").forEach((key, i) => {
  PROVIDER_SLOTS.push({
    id: `groq-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://api.groq.com/openai/v1" }),
    model: "llama-3.3-70b-versatile"
  });
});

// Cerebras (High tokens/sec)
parseKeys("CEREBRAS_API_KEYS").forEach((key, i) => {
  PROVIDER_SLOTS.push({
    id: `cerebras-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://api.cerebras.ai/v1" }),
    model: "llama-3.3-70b"
  });
});

// OpenRouter (General fallback)
parseKeys("OPENROUTER_API_KEYS").forEach((key, i) => {
  PROVIDER_SLOTS.push({
    id: `openrouter-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://openrouter.ai/api/v1" }),
    model: "deepseek/deepseek-chat"
  });
});

// NVIDIA NIM
parseKeys("NVIDIA_API_KEYS").forEach((key, i) => {
  PROVIDER_SLOTS.push({
    id: `nvidia-${i + 1}`,
    client: new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" }),
    model: "meta/llama-3.3-70b-instruct"
  });
});

if (PROVIDER_SLOTS.length === 0) {
  console.error("❌ Fatal: No provider API keys detected in environment variables.");
  process.exit(1);
}

let activeSlotIndex = 0;

function trackTokens(usage) {
  if (!usage) return;
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  totalTokensConsumed += tokens;

  logger.emit("token_ledger", "GOVERNOR", {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalConsumed: totalTokensConsumed,
    limit: MAX_SESSION_TOKENS
  });

  if (totalTokensConsumed > MAX_SESSION_TOKENS) {
    throw new Error(`🛑 CIRCUIT BREAKER TRIGGERED: Exceeded run limit of ${MAX_SESSION_TOKENS} tokens.`);
  }
}

/**
 * Executes chat completion with exponential backoff and slot rotation across providers.
 */
async function callModelWithRetry(messages, tools, maxAttemptsPerSlot = 3) {
  const startIdx = activeSlotIndex;

  for (let s = 0; s < PROVIDER_SLOTS.length; s++) {
    const slot = PROVIDER_SLOTS[(startIdx + s) % PROVIDER_SLOTS.length];

    for (let attempt = 1; attempt <= maxAttemptsPerSlot; attempt++) {
      try {
        const response = await slot.client.chat.completions.create({
          model: slot.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.1
        });

        trackTokens(response.usage);
        activeSlotIndex = (startIdx + s) % PROVIDER_SLOTS.length;
        return { response, slotId: slot.id };
      } catch (err) {
        const isRateLimit = err.status === 429 || (err.message && /rate limit|quota/i.test(err.message));
        const isServerErr = err.status >= 500;

        if ((isRateLimit || isServerErr) && attempt < maxAttemptsPerSlot) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.warn(`[Slot ${slot.id}] Error (${err.message}). Retrying in ${Math.round(delay)}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        console.warn(`[Slot ${slot.id}] Slot exhausted or non-retryable error. Rotating to next slot.`);
        break;
      }
    }
  }

  throw new Error("All provider slots failed across multi-provider cascade.");
}

// ============================================================================
// 3. Dynamic Context Compaction (OpenCode AutoCompact Pattern)
// ============================================================================
async function compactConversationHistory(messages, systemMessage) {
  logger.emit("thought", "AGENT", { text: "Context history approaching threshold. Running semantic compaction..." });
  console.log("🧹 [Compaction] Condensing previous turns into summary checkpoint...");

  const oldMessages = messages.slice(1, -4); // Retain system prompt and last 4 recent messages
  const slot = PROVIDER_SLOTS[activeSlotIndex];

  try {
    const summaryRes = await slot.client.chat.completions.create({
      model: slot.model,
      messages: [
        {
          role: "system",
          content: "You are a concise technical summarizer. Condense the prior interactions into a crisp progress report: files viewed, modified, tools executed, and current status."
        },
        {
          role: "user",
          content: JSON.stringify(oldMessages)
        }
      ]
    });

    trackTokens(summaryRes.usage);
    const summary = summaryRes.choices[0].message.content;

    return [
      systemMessage,
      {
        role: "assistant",
        content: `[PRIOR EXECUTION CHECKPOINT SUMMARY]:\n${summary}`
      },
      ...messages.slice(-4)
    ];
  } catch (err) {
    console.warn("⚠️ Failed to summarize history, slicing older messages:", err.message);
    return [systemMessage, ...messages.slice(-6)];
  }
}

// ============================================================================
// 4. Main Autonomous ReAct Loop
// ============================================================================
async function main() {
  console.log("===============================================================================");
  console.log(`🤖 AVOS STANDALONE AGENT: Initializing`);
  console.log(`🎯 Target Repository: ${targetRepo}`);
  console.log(`🎯 Goal: "${goal}"`);
  console.log(`📂 Workspace: ${workspaceDir}`);
  console.log("===============================================================================");

  logger.emit("init", "AGENT", { goal, targetRepo, workspace: workspaceDir });

  // 1. Inspect dynamic target repository & initialize Field Guide
  await fieldGuide.initialize(goal);
  logger.emit("field_guide_initialized", "AGENT", {
    stack: fieldGuide.state.project.detectedStack,
    oracle: fieldGuide.state.project.testCommand
  });

  // 2. Assemble Claude Code Tools + Reusable Contract Tool
  const tools = [
    ...CLAUDE_TOOLS,
    {
      type: "function",
      function: {
        name: "register_contract",
        description: "Record an exported signature or interface in the global Field Guide",
        parameters: {
          type: "object",
          properties: {
            module: { type: "string", description: "Path or module name" },
            signature: { type: "string", description: "Function, class, or type declaration" }
          },
          required: ["module", "signature"]
        }
      }
    }
  ];

  const systemMessage = {
    role: "system",
    content: `You are an elite autonomous software engineering agent operating directly in a real Linux environment.
Target Repository: ${targetRepo} (${fieldGuide.state.project.detectedStack})
Workspace Directory: ${workspaceDir}
Default Test Oracle: ${fieldGuide.state.project.testCommand}

${fieldGuide.getAsWorkerContext()}

CRITICAL RULES:
1. Orient yourself: Use 'get_project_map' or 'get_file_outline' before inspecting full implementations.
2. Read before editing: Use 'read_file_slice' to inspect exact line numbers and whitespace.
3. Edit with precision: Use 'edit_file' with 3-5 lines of context to ensure exact, unique matches.
4. Verify continuously: Use 'bash_exec' to run '${fieldGuide.state.project.testCommand}' after changes.
5. Finish only when verified: Calling 'finish_goal' triggers the Referee test oracle. If tests fail, your task will NOT be accepted.`
  };

  let messages = [
    systemMessage,
    { role: "user", content: goal }
  ];

  let turn = 0;

  while (turn < maxTurns) {
    turn++;
    console.log(`\n── Turn ${turn}/${maxTurns} ──`);

    // Automatic Context Compaction
    if (messages.length > 16) {
      messages = await compactConversationHistory(messages, systemMessage);
    }

    const { response, slotId } = await callModelWithRetry(messages, tools);
    const choice = response.choices[0].message;
    messages.push(choice);

    if (choice.content) {
      console.log(`💬 Thought [${slotId}]:\n${choice.content}`);
      logger.emit("thought", `AGENT (${slotId})`, { text: choice.content });
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

        console.log(`🔧 Tool [${name}]:`, JSON.stringify(args));
        logger.emit("tool_start", "AGENT", { tool: name, args });

        // Special Tool: Register Contract
        if (name === "register_contract") {
          fieldGuide.registerContract(args.module, args.signature);
          const result = `Registered contract for module '${args.module}' in Field Guide.`;
          logger.emit("tool_end", "AGENT", { tool: name, preview: result });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
          continue;
        }

        // Special Tool: Finish Goal with Mandatory Referee Check
        if (name === "finish_goal") {
          console.log(`⚖️ [Referee] Agent requested goal completion. Running verification oracle: ${fieldGuide.state.project.testCommand}...`);
          logger.emit("test_verify", "REFEREE", { command: fieldGuide.state.project.testCommand });

          const check = Referee.verify(fieldGuide.state.project.testCommand, workspaceDir);

          if (check.passed) {
            console.log("✅ [Referee] Verification succeeded! Goal completed successfully.");
            logger.emit("completed", "AGENT", { summary: args.summary || "Goal achieved and verified." });
            console.log("\n===============================================================================");
            console.log("🎉 MISSION ACCOMPLISHED: Target project tests passed.");
            console.log("===============================================================================");
            return;
          } else {
            console.warn(`❌ [Referee] Verification failed:\n${check.output.slice(0, 300)}`);
            logger.emit("self_healing", "REFEREE", { error: check.output.slice(0, 300) });

            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `REJECTED BY REFEREE ORACLE. Command '${fieldGuide.state.project.testCommand}' failed with output:\n${check.output}\nFix these issues before calling finish_goal again.`
            });
            continue;
          }
        }

        // Standard Claude Code Tools Execution
        const output = await executeTool(name, args, workspaceDir);
        logger.emit("tool_end", "AGENT", {
          tool: name,
          preview: String(output).slice(0, 150)
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: String(output)
        });
      }
    } else {
      console.log("ℹ️ No tool calls emitted. Awaiting next turn...");
    }
  }

  console.warn("⚠️ Max turns reached without passing the verification oracle.");
  logger.emit("error", "AGENT", { error: "Max turns exhausted without successful finish_goal." });
}

main().catch(err => {
  logger.emit("error", "AGENT", { message: err.message, stack: err.stack });
  console.error("\n💥 Fatal Agent Error:", err);
  process.exit(1);
});
