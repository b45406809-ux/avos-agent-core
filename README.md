# AVOS agent core

AVOS is a same-origin Cloudflare application for durable, authenticated coding-agent runs. The React workspace talks to one Worker. **D1 is authoritative** for ownership, document metadata, permissions, run state, ordered events, leases, counters, and checkpoint pointers. Workers KV contains only prompt, attachment, transcript, and checkpoint bytes. A Durable Object provides hibernating WebSocket fan-out, and Queues make GitHub dispatch retryable. The production application requires **Workers, D1, Workers KV, Durable Objects, and Queues**. R2 is not used.

## Personal, free-only deployment

The intended setup stays on Cloudflare's Workers Free plan and does not require a credit card. `npm run setup` uses the Cloudflare REST API directly (not Wrangler) to verify access, create or reuse `avos_swarm_db`, `avos-agent-documents`, and `avos-agent-dispatch`, apply migrations, upload the Worker with D1/KV/Queue/Durable Object bindings and variables, enable its subdomain, and perform a KV write/read/delete smoke check. Ignored metadata, including the generated production KV namespace ID, is saved at `.avos/deployment.json`. The script never calls an R2 API and never requests an account upgrade or payment method.

Create an account-scoped Cloudflare token with:

* **Account — Workers Scripts: Edit** (and Read where the token UI separates it);
* **Account — D1: Edit**;
* **Account — Workers KV Storage: Edit**;
* **Account — Queues: Edit**;
* **Account — Account Settings: Read**, if required to discover the account;
* **Zone — Workers Routes: Edit** only when configuring a custom-domain Worker route (not needed for `workers.dev`).

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, plus the owner/GitHub App values shown in `.env.example`, then run:

```sh
npm run setup
npm run doctor
```

Every fork owner must provision their own Cloudflare/GitHub resources and credentials. Free-plan limits can stop new heavy operations; AVOS does not fall back to paid storage. In-app counters are estimates, while Cloudflare's dashboard is authoritative. Model API use can still incur charges when a paid provider is selected. Private repositories can consume included or billed GitHub Actions minutes; public-repository standard GitHub-hosted runner use follows GitHub's current terms.

## Storage and retention

Prompts are UTF-8 KV values and never workflow inputs. The default prompt limit is 2 MiB with a warning and requirements-section index above 250 KiB. Attachments are browser-SHA-256-verified, type checked, capped at 20 MiB each, 50 MiB and 20 files per mission, and normally expire after 10 days. Allowed text, document, PDF, and common image types become `validated`; archives, executables, disk images, encrypted files, and unsupported types are rejected with guidance to commit them to the target repository. No malware scanner is claimed.

KV writes happen before D1 metadata creation; a document becomes `available` only after an immediate checksum-verified read. Since KV is eventually consistent, runners retry unavailable document IDs with bounded exponential backoff. Runners never provide KV keys: authenticated routes resolve database document IDs and ownership. Checkpoints are structured JSON written only at safe boundaries, with the latest five retained per run. Restore verifies checksum, schema, mission checksum, and repository revision.

D1 events use indexed cursor replay and should contain bounded message deltas, combined progress, summaries, and GitHub artifact references—not token-by-token text or large tool output. Detailed events and completed runs default to 30 days; session metadata and memories remain until deleted. GitHub Actions uploads complete logs, diffs, evaluations, emergency checkpoints, and diagnostics for five days, excluding credentials, cookies, leases, tokens, and environment dumps. Artifact name, workflow run ID, checksum, and purpose are registered in D1 through authenticated runner routes.

## Runtime flow

The browser reconstructs state from a snapshot, indexed replay, then WebSocket events (SSE is also available). Dispatch contains only opaque run/correlation IDs, environment, and protocol version. The executor obtains GitHub OIDC, receives a rotating five-minute scoped lease, checks out the target repository, restores a validated checkpoint with bounded retries, invokes configured agents, refreshes its lease, handles permission decisions and cancellation, verifies changes, and publishes through a pull request by default.
