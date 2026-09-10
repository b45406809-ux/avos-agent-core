import OpenAI from "openai";

// ============================================================================
// 1. Budget & Circuit Breaker State
// ============================================================================
const DEFAULT_MAX_RUN_TOKENS = 8_000_000; // 8M token runaway safeguard
const MAX_BUDGET_TOKENS = parseInt(process.env.MAX_BUDGET_TOKENS || String(DEFAULT_MAX_RUN_TOKENS), 10);

const tokenLedger = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0.0,
  callsCount: 0
};

// Pricing estimates per 1M tokens (blended input/output) for cost governance
const PROVIDER_COST_PER_MILLION = {
  "gemini-2.5-pro": { input: 1.25, output: 5.0 },
  "gemini-2.5-flash": { input: 0.075, output: 0.30 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.3-70b": { input: 0.60, output: 0.60 },
  "deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
  "deepseek/deepseek-chat": { input: 0.14, output: 0.28 },
  "meta/llama-3.3-70b-instruct": { input: 0.70, output: 0.80 }
};

/**
 * Tracks token usage and trips the circuit breaker if the budget is exceeded.
 */
export function trackUsage(usage, model = "") {
  if (!usage) return;

  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = prompt + completion;

  tokenLedger.promptTokens += prompt;
  tokenLedger.completionTokens += completion;
  tokenLedger.totalTokens += total;
  tokenLedger.callsCount += 1;

  // Calculate approximate cost
  const rates = PROVIDER_COST_PER_MILLION[model] || { input: 0.5, output: 1.5 };
  const cost = (prompt / 1_000_000) * rates.input + (completion / 1_000_000) * rates.output;
  tokenLedger.estimatedCostUsd += cost;

  if (tokenLedger.totalTokens > MAX_BUDGET_TOKENS) {
    throw new Error(
      `🛑 CIRCUIT BREAKER TRIGGERED: Swarm exceeded global budget of ${MAX_BUDGET_TOKENS.toLocaleString()} tokens ` +
      `(Consumed: ${tokenLedger.totalTokens.toLocaleString()} tokens, Est. Cost: $${tokenLedger.estimatedCostUsd.toFixed(4)}).`
    );
  }
}

export function getTokenLedgerReport() {
  return { ...tokenLedger };
}

// ============================================================================
// 2. Provider Slot Pool & Multi-Account Management
// ============================================================================

function parseKeyList(envVarName) {
  return (process.env[envVarName] || "")
    .split(/[,\n]+/)
    .map(k => k.trim())
    .filter(Boolean);
}

class ProviderSlot {
  constructor({ id, provider, client, model, tier }) {
    this.id = id;
    this.provider = provider;
    this.client = client;
    this.model = model;
    this.tier = tier; // "planner" | "worker"
    this.cooldownUntil = 0;
    this.failureCount = 0;
    this.successCount = 0;
  }

  isAvailable() {
    return Date.now() >= this.cooldownUntil;
  }

  markRateLimited(cooldownSeconds = 60) {
    this.failureCount += 1;
    this.cooldownUntil = Date.now() + cooldownSeconds * 1000;
    console.warn(`⏳ [ProviderPool] Slot '${this.id}' rate-limited. Pausing for ${cooldownSeconds}s.`);
  }

  markSuccess() {
    this.failureCount = 0;
    this.successCount += 1;
  }
}

// Master lists for Planner tier (frontier reasoning) and Worker tier (high-throughput)
const PLANNER_SLOTS = [];
const WORKER_SLOTS = [];

function initializeProviderSlots() {
  // 1. Google Gemini
  const geminiKeys = parseKeyList("GEMINI_API_KEYS");
  geminiKeys.forEach((key, idx) => {
    // Gemini Pro for Planner
    PLANNER_SLOTS.push(new ProviderSlot({
      id: `gemini-pro-acc${idx + 1}`,
      provider: "gemini",
      client: new OpenAI({ apiKey: key, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
      model: "gemini-2.5-pro",
      tier: "planner"
    }));
    // Gemini Flash for Workers
    WORKER_SLOTS.push(new ProviderSlot({
      id: `gemini-flash-acc${idx + 1}`,
      provider: "gemini",
      client: new OpenAI({ apiKey: key, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }),
      model: "gemini-2.5-flash",
      tier: "worker"
    }));
  });

  // 2. Groq (Llama 3.3 70B Versatile)
  const groqKeys = parseKeyList("GROQ_API_KEYS");
  groqKeys.forEach((key, idx) => {
    WORKER_SLOTS.push(new ProviderSlot({
      id: `groq-acc${idx + 1}`,
      provider: "groq",
      client: new OpenAI({ apiKey: key, baseURL: "https://api.groq.com/openai/v1" }),
      model: "llama-3.3-70b-versatile",
      tier: "worker"
    }));
  });

  // 3. Cerebras (Ultra-fast Llama 3.3 70B)
  const cerebrasKeys = parseKeyList("CEREBRAS_API_KEYS");
  cerebrasKeys.forEach((key, idx) => {
    WORKER_SLOTS.push(new ProviderSlot({
      id: `cerebras-acc${idx + 1}`,
      provider: "cerebras",
      client: new OpenAI({ apiKey: key, baseURL: "https://api.cerebras.ai/v1" }),
      model: "llama-3.3-70b",
      tier: "worker"
    }));
  });

  // 4. OpenRouter (Reasoning & general fallback)
  const openrouterKeys = parseKeyList("OPENROUTER_API_KEYS");
  openrouterKeys.forEach((key, idx) => {
    const client = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/avos-agent-core",
        "X-Title": "AVOS Agent Swarm"
      }
    });

    // DeepSeek R1 for Planner
    PLANNER_SLOTS.push(new ProviderSlot({
      id: `openrouter-r1-acc${idx + 1}`,
      provider: "openrouter",
      client,
      model: "deepseek/deepseek-r1",
      tier: "planner"
    }));

    // DeepSeek V3/Chat for Workers
    WORKER_SLOTS.push(new ProviderSlot({
      id: `openrouter-chat-acc${idx + 1}`,
      provider: "openrouter",
      client,
      model: "deepseek/deepseek-chat",
      tier: "worker"
    }));
  });

  // 5. NVIDIA NIM
  const nvidiaKeys = parseKeyList("NVIDIA_API_KEYS");
  nvidiaKeys.forEach((key, idx) => {
    WORKER_SLOTS.push(new ProviderSlot({
      id: `nvidia-acc${idx + 1}`,
      provider: "nvidia",
      client: new OpenAI({ apiKey: key, baseURL: "https://integrate.api.nvidia.com/v1" }),
      model: "meta/llama-3.3-70b-instruct",
      tier: "worker"
    }));
  });

  // Fallback pooling: If no workers configured, planner slots serve as workers
  if (WORKER_SLOTS.length === 0 && PLANNER_SLOTS.length > 0) {
    WORKER_SLOTS.push(...PLANNER_SLOTS);
  }
  if (PLANNER_SLOTS.length === 0 && WORKER_SLOTS.length > 0) {
    PLANNER_SLOTS.push(...WORKER_SLOTS);
  }

  if (PLANNER_SLOTS.length === 0 && WORKER_SLOTS.length === 0) {
    throw new Error("❌ Fatal: No provider API keys configured. Set at least one provider key (GEMINI, GROQ, CEREBRAS, OPENROUTER, or NVIDIA).");
  }
}

// Bootstrap slots immediately on module import
initializeProviderSlots();

// ============================================================================
// 3. Resilient Cascade Dispatcher
// ============================================================================

let plannerIndex = 0;
let workerIndex = 0;

/**
 * Executes a chat completion request with automatic slot rotation,
 * exponential backoff, and rate-limit recovery.
 *
 * @param {"planner" | "worker"} tier - Target model pool tier
 * @param {object} payload - OpenAI chat completion payload (messages, tools, response_format)
 * @param {object} options - Retries and timeout options
 */
export async function executeCompletion(tier, payload, options = {}) {
  const isPlanner = tier === "planner";
  const slots = isPlanner ? PLANNER_SLOTS : WORKER_SLOTS;
  const maxAttemptsPerSlot = options.maxAttemptsPerSlot || 3;
  let startIndex = isPlanner ? plannerIndex : workerIndex;

  let lastError = null;

  for (let s = 0; s < slots.length; s++) {
    const slotIdx = (startIndex + s) % slots.length;
    const slot = slots[slotIdx];

    // Check if slot is currently cooling down from a 429
    if (!slot.isAvailable()) {
      const waitRemaining = Math.ceil((slot.cooldownUntil - Date.now()) / 1000);
      console.log(`⏩ [ProviderPool] Skipping slot '${slot.id}' (cooling down for ${waitRemaining}s).`);
      continue;
    }

    for (let attempt = 1; attempt <= maxAttemptsPerSlot; attempt++) {
      try {
        const reqPayload = {
          ...payload,
          model: slot.model
        };

        // DeepSeek R1 and reasoning models reject custom temperature
        if (slot.model.includes("r1") || slot.model.includes("o1") || slot.model.includes("o3")) {
          delete reqPayload.temperature;
        }

        const response = await slot.client.chat.completions.create(reqPayload);

        // Record metrics and verify cost governor
        trackUsage(response.usage, slot.model);
        slot.markSuccess();

        // Update round-robin cursor for next call
        if (isPlanner) plannerIndex = slotIdx;
        else workerIndex = slotIdx;

        return {
          response,
          slotId: slot.id,
          provider: slot.provider,
          model: slot.model
        };
      } catch (err) {
        lastError = err;
        const status = err.status || (err.response ? err.response.status : 0);
        const errMsg = err.message || "";
        const isRateLimit = status === 429 || /rate limit|quota|resource exhausted/i.test(errMsg);
        const isServerErr = status >= 500 && status < 600;

        if (isRateLimit) {
          slot.markRateLimited(60);
          break; // Stop retrying this slot, proceed to next provider
        }

        if (isServerErr && attempt < maxAttemptsPerSlot) {
          // Exponential backoff with random jitter: (2^attempt * 1000ms) + jitter
          const delay = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
          console.warn(`⚠️ [Slot ${slot.id}] Server error ${status}. Retrying in ${delay}ms (attempt ${attempt}/${maxAttemptsPerSlot})...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        console.warn(`⚠️ [Slot ${slot.id}] Unrecoverable error: ${errMsg.slice(0, 120)}. Rotating.`);
        break; // Move to next slot
      }
    }
  }

  throw new Error(`All ${tier} provider slots failed. Last error: ${lastError ? lastError.message : "Unknown failure"}`);
}

/**
 * Shorthand helper for Planner tier requests (Tree-Sitter DAG decomposition, AST merge conflict resolution).
 */
export async function callPlanner(payload, options = {}) {
  return await executeCompletion("planner", payload, options);
}

/**
 * Shorthand helper for Worker tier requests (Worktree leaf tasks, file editing).
 */
export async function callWorker(payload, options = {}) {
  return await executeCompletion("worker", payload, options);
    }
