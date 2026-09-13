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

Configure Worker secrets with `wrangler secret put`; never expose them as workflow inputs or browser storage. Required production values are documented beside the bindings in `apps/control-plane/wrangler.toml`.

## Lifecycle

The browser persists only the last observed sequence. It reconstructs normalized state from a snapshot, replay, then WebSocket events (SSE is available at `/api/runs/:id/stream`). Prompts are written to R2 before a bounded dispatch containing only the run ID, correlation ID, environment and protocol version. The executor obtains GitHub OIDC, receives a rotating five-minute lease, restores a checkpoint, streams validated events, handles approvals/cancellation, and enters a budget-aware three-minute warm window. Pull requests are the publishing default; direct pushes require a separately approved capability.
