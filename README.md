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

Set only `CLOUDFLARE_ACCOUNT_ID`, a narrowly scoped `CLOUDFLARE_API_TOKEN`, and `BOOTSTRAP_OWNER_GITHUB_ID` (numeric ID or GitHub login), then run:

```sh
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… BOOTSTRAP_OWNER_GITHUB_ID=octocat npm run setup
```

The bootstrap resolves the login to its immutable numeric GitHub ID, derives the fork, default branch, workflow identity, workers.dev origin, and stable `avos-runner` audience, and generates the session key, credential-encryption key, and a 15-minute one-time setup nonce with cryptographically secure randomness. Generated values are uploaded directly as encrypted Worker secret bindings. Only the nonce hash is retained by the Worker, and no secret is written to `.avos/deployment.json`.

Open the single setup URL printed by the deployment script. It is single-use, expires after 15 minutes, and is restricted to the configured owner. AVOS then creates a private GitHub App through GitHub's manifest flow. Each fork creates its own App with only Metadata read, Actions read/write, Contents read/write, and Pull requests read/write. The returned private key and client secret are encrypted immediately and never enter browser JavaScript. Install the App on the AVOS fork and at least one target repository; the installation callback discovers its ID automatically.

In **Settings → Models and providers**, add Gemini, Groq, OpenRouter, Cerebras, or NVIDIA credentials. Key pools are split into individually encrypted AES-GCM records in D1, validated before enablement, and never displayed again. Runners call the lease-authenticated provider proxy, so model keys do not enter GitHub Actions. Choose qualified planner and worker models, budgets, fallbacks, compaction model, and degraded-mode policy before running the control-plane and agent smoke checks.

A fresh-fork setup is therefore:

1. Fork AVOS.
2. Create the scoped Cloudflare token described above.
3. Run the bootstrap deployment script with the three bootstrap values.
4. Open the printed one-time setup URL.
5. Create and authorize the per-fork GitHub App through the manifest flow.
6. Install it on the fork and selected target repositories.
7. Sign in as the configured GitHub owner.
8. Add and validate a model-provider credential in encrypted settings.
9. Configure provider routing and run diagnostics.
10. Run a successful smoke mission and a cancellation smoke mission.

After bootstrap, revoke the deployment token. If automated future updates need it, store it only as a GitHub Actions secret in the fork—not as an AVOS runtime credential. AVOS can deploy in `setup_required` mode without any provider credential, but mission creation and dispatch remain disabled until GitHub and qualified planner/worker models pass validation. Setup progresses explicitly through `cloudflare_ready`, `owner_claim_pending`, `github_app_pending`, `github_installation_pending`, `provider_pending`, `smoke_test_pending`, `ready`, or an owner-selected permitted `degraded` state.

## Storage and retention

Prompts are UTF-8 KV values and never workflow inputs. The default prompt limit is 2 MiB with a warning and requirements-section index above 250 KiB. Attachments are browser-SHA-256-verified, type checked, capped at 20 MiB each, 50 MiB and 20 files per mission, and normally expire after 10 days. Allowed text, document, PDF, and common image types become `validated`; archives, executables, disk images, encrypted files, and unsupported types are rejected with guidance to commit them to the target repository. No malware scanner is claimed.

KV writes happen before D1 metadata creation; a document becomes `available` only after an immediate checksum-verified read. Since KV is eventually consistent, runners retry unavailable document IDs with bounded exponential backoff. Runners never provide KV keys: authenticated routes resolve database document IDs and ownership. Checkpoints are structured JSON written only at safe boundaries, with the latest five retained per run. Restore verifies checksum, schema, mission checksum, and repository revision.

D1 events use indexed cursor replay and should contain bounded message deltas, combined progress, summaries, and GitHub artifact references—not token-by-token text or large tool output. Detailed events and completed runs default to 30 days; session metadata and memories remain until deleted. GitHub Actions uploads complete logs, diffs, evaluations, emergency checkpoints, and diagnostics for five days, excluding credentials, cookies, leases, tokens, and environment dumps. Artifact name, workflow run ID, checksum, and purpose are registered in D1 through authenticated runner routes.

## Runtime flow

The browser reconstructs state from a snapshot, indexed replay, then WebSocket events (SSE is also available). Dispatch contains only opaque run/correlation IDs, environment, and protocol version. The executor obtains GitHub OIDC, receives a rotating five-minute scoped lease, checks out the target repository, restores a validated checkpoint with bounded retries, invokes configured agents, refreshes its lease, handles permission decisions and cancellation, verifies changes, and publishes through a pull request by default.


Provider calls are brokered by the control plane after OIDC registration through the scoped runner lease; raw provider credentials are never sent to the runner, workflow inputs, checkpoints, or artifacts. While an agent is active, the supervisor concurrently rotates the lease and polls D1-backed commands. Cancellation aborts the model loop and child process, persists a final remote checkpoint, and exits without pushing a branch. A successful agent exit means the repository verification oracle passed; only then does the runner create a fresh branch, commit and push the changes with a repository-scoped GitHub App token, and open a pull request.
