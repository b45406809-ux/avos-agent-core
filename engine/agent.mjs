 import OpenAI from "openai";
import { CLAUDE_TOOLS, executeTool } from "./tools.mjs";
import * as fs from "fs";

function parseKeys(env) {
  return (process.env[env] || "").split(/[,\n]+/).map(k => k.trim()).filter(Boolean);
}

// 1. Build Multi-Account Slots
const CONFIGS = [
  { provider: "gemini", keys: parseKeys("GEMINI_API_KEYS"), baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
  { provider: "groq", keys: parseKeys("GROQ_API_KEYS"), baseURL: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { provider: "cerebras", keys: parseKeys("CEREBRAS_API_KEYS"), baseURL: "https://api.cerebras.ai/v1", model: "llama-3.3-70b" },
  { provider: "openrouter", keys: parseKeys("OPENROUTER_API_KEYS"), baseURL: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-pro" },
  { provider: "nvidia", keys: parseKeys("NVIDIA_API_KEYS"), baseURL: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct" }
];

let SLOTS = [];
for (const cfg of CONFIGS) {
  for (let i = 0; i < cfg.keys.length; i++) {
    SLOTS.push({
      provider: cfg.provider,
      client: new OpenAI({ apiKey: cfg.keys[i], baseURL: cfg.baseURL }),
      model: cfg.model,
      id: `${cfg.provider.toUpperCase()} (Account ${i + 1})`
    });
  }
}

if (SLOTS.length === 0) {
  console.error("❌ No API keys loaded! Add at least one provider key.");
  process.exit(1);
}

let slotIdx = 0;
function getSlot() {
  slotIdx = slotIdx % SLOTS.length;
  return SLOTS[slotIdx];
}
function rotateSlot(reason) {
  slotIdx = (slotIdx + 1) % SLOTS.length;
  console.log(`🔄 Rotated slot to: ${SLOTS[slotIdx].id} [Reason: ${reason}]`);
}

// Event Streamer to .agent/live_stream.jsonl
function emitStreamEvent(type, payload) {
  fs.mkdirSync(".agent", { recursive: true });
  fs.appendFileSync(".agent/live_stream.jsonl", JSON.stringify({ time: Date.now(), type, ...payload }) + "\n");
}

// 2. The Main Claude Code /goal Loop
async function run() {
  const goal = process.env.USER_PROMPT;
  const workspace = process.env.WORKSPACE_DIR || "./workspace";
  console.log(`🎯 Goal Initialized: ${goal}`);

  let messages = [
    {
      role: "system",
      content: `You are an elite autonomous software engineering agent matching Claude Code in /goal mode.
You operate inside a real Linux environment. Explore the codebase using 'glob_files' and 'grep_search'.
Always view lines using 'read_file_slice' before modifying with 'str_replace_editor'.
Run tests or compiler checks ('bash_exec') before finishing. Call 'finish_goal' when done.`
    },
    { role: "user", content: goal }
  ];

  let turn = 0;
  const maxTurns = 35;

  while (turn < maxTurns) {
    turn++;
    console.log(`\n── Turn ${turn}/${maxTurns} ──`);

    // Context Compaction check
    if (messages.length > 18) {
      console.log("🧹 Compacting context window...");
      const summarySlot = getSlot();
      const summaryRes = await summarySlot.client.chat.completions.create({
        model: summarySlot.model,
        messages: [
          { role: "system", content: "Summarize the progress, key findings, and modified files concisely." },
          { role: "user", content: JSON.stringify(messages.slice(1, -4)) }
        ]
      });
      messages = [
        messages[0],
        { role: "assistant", content: `[COMPACTED CONTEXT SUMMARY]: ${summaryRes.choices[0].message.content}` },
        ...messages.slice(-4)
      ];
    }

    // Attempt inference with cascading failover
    let response;
    for (let attempts = 0; attempts < SLOTS.length; attempts++) {
      const active = getSlot();
      try {
        emitStreamEvent("thought", { text: `Reasoning with ${active.id}...` });
        response = await active.client.chat.completions.create({
          model: active.model,
          messages,
          tools: CLAUDE_TOOLS,
          tool_choice: "auto",
          temperature: 0.1
        });
        break;
      } catch (err) {
        rotateSlot(err.message.slice(0, 60));
      }
    }

    if (!response) throw new Error("All provider slots failed!");

    const msg = response.choices[0].message;
    messages.push(msg);

    if (msg.content) {
      console.log(`🤖 Thought: ${msg.content}`);
      emitStreamEvent("thought", { text: msg.content });
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments);
        console.log(`🔧 Tool: ${name}`, args);
        emitStreamEvent("tool_start", { name, args });

        const result = executeTool(name, args, workspace);
        emitStreamEvent("tool_end", { name, preview: result.slice(0, 200) });

        if (result === "GOAL_ACCOMPLISHED") {
          console.log("🎉 Goal successfully accomplished!");
          emitStreamEvent("completed", { summary: args.summary });
          return;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result
        });
      }
    }
  }

  console.warn("⚠️ Reached max turns without explicit finish_goal.");
}

run().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
