
### `README.md`

```markdown
# 🐝 AVOS Agent Core: Autonomous Multi-Agent Coding Swarm

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg)](package.json)
[![Tree-Sitter](https://img.shields.io/badge/AST%20Parser-WebTreeSitter%20(WASM)-orange.svg)](engine/indexer.mjs)
[![Architecture](https://img.shields.io/badge/Architecture-Cursor%20Swarm%20%2B%20Claude%20Code-purple.svg)](engine/swarm.mjs)

**AVOS Agent Core** is a serverless, autonomous multi-agent engineering swarm designed to plan, execute, and verify complex coding tasks across multi-million-token repositories.

Inspired by **Cursor's SQLite rewrite swarm experiment**, **Plandex's Tree-sitter project maps**, and **OpenCode / Claude Code's hardened tool primitives**, this engine breaks away from the limitations of single-agent sequential loops through **topological DAG parallelism, isolated Git worktrees, stigmergic shared memory, and automated compiler/test verification gates**.

---

## 🌟 Key Architectural Pillars

```
                       ┌──────────────────────────────┐
                       │   USER / SPECIFICATION       │
                       │ (Target Repo + Prompt Goal)  │
                       └──────────────┬───────────────┘
                                      │
                                      ▼
                        ┌────────────────────────────┐
                        │   LEAD ARCHITECT / PLANNER │ ◄── Tree-Sitter
                        │ (Frontier: Gemini Pro / R1)│     AST Project Map
                        └─────────────┬──────────────┘
                                      │ Generates Topological Task DAG
                                      ▼
                       ┌──────────────────────────────┐
                       │   STIGMERGIC FIELD GUIDE     │
                       │ (.agent/FIELD_GUIDE.md state)│
                       └───────┬──────────────┬───────┘
                               │              │
             ┌─────────────────┴────┐    ┌────┴─────────────────┐
             ▼                      ▼    ▼                      ▼
    ┌─────────────────┐   ┌─────────────────┐    ┌─────────────────┐
    │ WORKER AGENT 1  │   │ WORKER AGENT 2  │    │ WORKER AGENT N  │
    │ (Groq/Llama-3.3)│   │(Cerebras/Llama) │    │ (Gemini Flash)  │
    └────────┬────────┘   └────────┬────────┘    └────────┬────────┘
             │                     │                      │
             │ Worktree Branch A   │ Worktree Branch B    │ Worktree Branch N
             ▼                     ▼                      ▼
    ┌──────────────────────────────────────────────────────────────┐
    │               REFEREE & CONFORMANCE ORACLE                   │
    │  1. Diagnostic Extraction (`rustc`, `tsc`, `pytest`, `go`)   │
    │  2. Self-Healing Feedback Loop (3-strike retry)              │
    │  3. LLM-Assisted Semantic Merge Resolver                     │
    └──────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
                       ┌──────────────────────┐
                       │  VERIFIED TARGET PR  │
                       │    (or Direct Push)  │
                       └──────────────────────┘
```

1. **Tree-Sitter Structural Skeletonization (`engine/indexer.mjs`)**:
   Uses WASM Tree-sitter to strip implementation bodies and index only signatures, classes, traits, and exported functions. Reduces context footprint by **95–98%** (turning a 20M-token repo into a <10k token architectural map).
2. **Zero-Lock Concurrency via Git Worktrees (`engine/worktree.mjs`)**:
   Parallel workers edit independently in isolated `.worktrees/<task_id>` directories. Eliminates `.git/index.lock` collisions, dirty working tree races, and accidental file overwrites.
3. **Stigmergy & Shared Field Guide (`engine/blackboard.mjs`)**:
   Agents do not message each other directly. Instead, they coordinate through a live, persistent architectural blackboard (`.agent/FIELD_GUIDE.md`), dynamically registering contracts and types.
4. **Referee Oracle & Self-Healing Loop (`engine/referee.mjs`)**:
   Code is never merged based on LLM confidence. The Referee executes real compiler and test commands (`cargo test`, `npm test`, `pytest`), strips noisy build logs, and delivers actionable `stderr` feedback directly to workers for automated self-correction.
5. **Multi-Provider Cascade & Cost Governor (`engine/providers.mjs`)**:
   Routes high-level reasoning to frontier planner models (`gemini-2.5-pro`, `deepseek-r1`) and high-volume leaf coding to ultra-fast endpoints (`llama-3.3-70b` on Groq / Cerebras). Includes automatic HTTP 429 cooldowns and an 8M token circuit breaker.

---

## 📁 Repository Structure

```
avos-agent-core/
├── .github/
│   └── workflows/
│       └── agent.yml          # GitHub Actions Swarm runner (Security gate, Toolchain, PR creator)
├── .agent/                    # Ephemeral runtime state (Field Guide, Telemetry, Task DAG)
│   ├── FIELD_GUIDE.md         # Stigmergic shared memory and interface contracts
│   ├── live_stream.jsonl      # Real-time event stream log
│   └── task_dag.json          # Topological dependency graph generated by Planner
├── engine/
│   ├── swarm.mjs              # Master Swarm Orchestrator (Topological DAG scheduler)
│   ├── agent.mjs              # Standalone single-agent ReAct loop (for targeted debugging)
│   ├── blackboard.mjs         # Stigmergy & dynamic stack discovery engine
│   ├── worktree.mjs           # Git worktree lifecycle & LLM semantic merge resolver
│   ├── indexer.mjs            # WASM Tree-sitter AST skeletonizer (TS, Rust, Go, Python, C/C++)
│   ├── tools.mjs              # Hardened tool primitives (glob, grep, read slice, edit, bash)
│   ├── referee.mjs            # Verification Oracle & diagnostic error parser
│   └── providers.mjs          # Multi-provider cascade router & token governor
├── harness/
│   ├── sqllogictest/          # Official SQLite conformance test suites (optional)
│   └── eval_runner.mjs        # Native test & SQLLogicTest evaluation benchmark runner
├── ui/                        # Web Operator Dashboard (Hostable on GitHub Pages)
│   ├── index.html             # Parameter form & live terminal viewport
│   ├── app.js                 # GitHub Actions REST API poller & log parser
│   └── style.css              # Dark high-contrast terminal theme
├── package.json               # ESM module manifest & Tree-sitter WASM dependencies
└── README.md
```

---

## 🚀 Quickstart Guide

### 1. Repository Secrets Setup

In your `avos-agent-core` repository on GitHub, navigate to **Settings > Secrets and variables > Actions** and add:

| Secret Name | Description | Example / Source |
| :--- | :--- | :--- |
| `AGENT_UI_SECRET` | Security validation passphrase for the UI | Any random hex string (e.g. `openssl rand -hex 16`) |
| `USER_GITHUB_TOKEN` | GitHub Personal Access Token (PAT) with `repo` scope | [GitHub PAT Settings](https://github.com/settings/tokens) |
| `GEMINI_API_KEYS` | Google Gemini API keys (comma-separated for pooling) | [Google AI Studio](https://aistudio.google.com/) |
| `GROQ_API_KEYS` | Groq API keys (comma-separated for pooling) | [Groq Console](https://console.groq.com/) |
| `CEREBRAS_API_KEYS`| Cerebras API keys (comma-separated for pooling) | [Cerebras Cloud](https://cloud.cerebras.ai/) |
| `OPENROUTER_API_KEYS`| OpenRouter API keys (comma-separated for pooling) | [OpenRouter Keys](https://openrouter.ai/keys) |
| `NVIDIA_API_KEYS` | NVIDIA NIM API keys (optional) | [NVIDIA Build](https://build.nvidia.com/) |

---

### 2. Launching Missions via Web UI (GitHub Pages)

1. Open `ui/index.html` in any browser (or serve via GitHub Pages from the `ui/` directory).
2. Enter your **GitHub PAT**, **Control Repo** (`your-username/avos-agent-core`), and **`AGENT_UI_SECRET`**.
3. Provide your **Target Repository** (e.g., `your-username/my-project`) and your **Mission Goal**.
4. Select your **Execution Mode** (`swarm` or `single`) and click **Launch Mission**.
5. Watch the live terminal stream events as workers branch, write code, run tests, and merge into `main`.

---

### 3. Running Locally / CLI Mode

You can also run the agent or swarm directly against any local repository:

```bash
# 1. Clone control plane and install dependencies
git clone https://github.com/your-username/avos-agent-core.git
cd avos-agent-core
npm install

# 2. Export provider keys
export GEMINI_API_KEYS="AIzaSy..."
export GROQ_API_KEYS="gsk_..."

# 3. Run Multi-Worker Swarm against a target repo
WORKSPACE_DIR="/path/to/target/project" \
USER_PROMPT="Refactor database connection pool and verify with tests" \
npm run swarm

# 4. Or run Single-Agent ReAct loop
WORKSPACE_DIR="/path/to/target/project" \
USER_PROMPT="Fix off-by-one error in varint decoder" \
npm run agent
```

---

## 📊 Benchmark & Architectural Comparison

| Capability | Standard Claude Code | Cursor Composer | AVOS Swarm (`swarm.mjs`) |
| :--- | :--- | :--- | :--- |
| **Concurrency** | Sequential (1 agent) | Sequential (1 agent) | **Topological DAG (N parallel workers)** |
| **Workspace Isolation** | In-place editing (file collision risk) | In-place editing (file collision risk) | **Git Worktrees (`.worktrees/<task_id>`)** |
| **Context Management** | Context fills and degrades after ~15 turns | Context overflows on large files | **Tree-Sitter Project Map + Auto-Compaction** |
| **Verification** | Assumes code works unless manually run | Relies on user interaction | **Automated Referee Gate (`Referee.verify`)** |
| **Merge Conflicts** | Manual resolution | Manual resolution | **LLM Semantic AST Merge Referee** |
| **Cost Efficiency** | 100% Frontier Model pricing ($$$) | 100% Frontier Model pricing ($$$) | **10–15x cheaper (Dual-Tier Cascade Routing)** |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
```
