# AVOS durable agent control plane

AVOS is a same-origin Cloudflare application for durable, authenticated coding-agent runs. The React workspace talks to one Worker. D1 is authoritative for run state and ordered events; R2 stores prompts, attachments, transcripts and checkpoints; one Durable Object per active run provides hibernating WebSocket fan-out; Queues make GitHub dispatch retryable. A GitHub-hosted supervisor authenticates with OIDC and receives a short-lived run-scoped lease.

## Workspace

- `apps/web` — React/TypeScript operator workspace.
- `apps/control-plane` — Worker API and `RunCoordinator` Durable Object.
- `packages/protocol` — strict, versioned Zod wire schemas.
- `packages/agent-runtime` — importable agent engine and long-lived supervisor.
- `migrations` — ordered D1 migrations; legacy data remains available as read-only history.
- `.github/workflows/agent.yml` — minimal-permission OIDC executor.
- `.github/workflows/deploy.yml` — deterministic Cloudflare deployment.

## Local development

```sh
npm ci
npm run build
npx wrangler d1 migrations apply avos-local --local --config apps/control-plane/wrangler.toml
npm run dev
```

Copy `.env.example` and configure your own immutable `OWNER_GITHUB_ID`, OAuth App, GitHub App installation, Cloudflare account, and control repository. A login name is displayed only; authorization always compares GitHub's numeric user ID. Forks must never reuse another deployment's IDs, URLs, OAuth credentials, or Cloudflare resources.

Run `npm run setup` for API-only, idempotent provisioning (no global Wrangler invocation), or `npm run doctor` for read-only diagnostics. The deployer reuses `avos_swarm_db`, creates or reuses `avos-agent-objects` and `avos-agent-dispatch`, applies migrations, and writes discovered IDs to ignored `.avos/deployment.json`. Configure secrets through Cloudflare's encrypted secret API/dashboard; never commit them or pass them in workflow inputs. The required Worker configuration is `OWNER_GITHUB_LOGIN`, `OWNER_GITHUB_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_HMAC_KEY`, `CONTROL_REPOSITORY`, `CONTROL_REPOSITORY_DEFAULT_BRANCH`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `OIDC_AUDIENCE`, and `CREDENTIAL_KEK`.

Set `REPOSITORY_ALLOWLIST` to a comma-separated `owner/repository` list for a personal deployment. Empty means every repository accessible to the configured GitHub App installation. GitHub App authentication is recommended. Provider credentials may instead be configured as GitHub repository/environment secrets named `GEMINI_API_KEYS`, `GROQ_API_KEYS`, `CEREBRAS_API_KEYS`, and `OPENROUTER_API_KEYS`; they are never browser-visible. AVOS software and public-repository GitHub-hosted execution can be free, but model inference may cost money unless the selected provider grants a free allowance. Planner fallback to a worker-grade model is disabled unless degraded mode is explicitly enabled.

## Lifecycle

The browser persists only the last observed sequence. It reconstructs normalized state from a snapshot, replay, then WebSocket events (SSE is available at `/api/runs/:id/stream`). Prompts are written to R2 before a bounded dispatch containing only the run ID, correlation ID, environment and protocol version. The executor obtains GitHub OIDC, receives a rotating five-minute lease, restores a checkpoint, streams validated events, handles approvals/cancellation, and enters a budget-aware three-minute warm window. Pull requests are the publishing default; direct pushes require a separately approved capability.
