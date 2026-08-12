# AgentFlow

A multi-tenant workflow orchestrator for chaining AI agent steps. Organizations
build workflows out of ordered steps, start them manually or by webhook,
schedule or database event, and watch them execute live. Runs pause for human
approval and resume where they left off.

Built on Nhost (PostgreSQL, Hasura, Auth, Functions) with a Next.js frontend.

---

## Video Demonstration

https://youtu.be/VNKVwbYJxdY

## Try it

**Live app: https://agentflow-wheat.vercel.app**


Sign in with any of these. Password for all four is `Password123!`

| Email | Organization | Role |
|---|---|---|
| `owner.a@agentflow.test` | Northwind Support | owner |
| `editor.a@agentflow.test` | Northwind Support | editor |
| `viewer.a@agentflow.test` | Northwind Support | viewer |
| `owner.b@agentflow.test` | Contoso Operations | owner |

Start as the owner of Northwind. Open **Support triage**, press **Run**, and the
run view fills in live. It stops at step 03 for approval; approve it and the
rest completes without a refresh.

Then sign in as `owner.b` in a private window, paste any Northwind run URL, and
watch it refuse to exist.

The backend runs on Nhost's free tier, which pauses a project after a week of
inactivity. If the app looks dead, it is waking up; give it a minute.

---

## What it does

Six step types:

| Step | Behaviour |
|---|---|
| `llm_call` | Calls Groq, OpenRouter, or OpenAI. Falls back to a stub with a disclosed delay when no key is set. |
| `http_request` | Outbound HTTP, hardened against server-side request forgery. |
| `conditional_branch` | Ten fixed operators, no expression evaluation. Branch targets must be later positions, so workflows always terminate. |
| `approval_gate` | Stops the run. Only an owner or editor of the owning organization can clear it. |
| `notify` | Writes a notification row; an event trigger delivers it. Owner-only. |
| `db_write` | Writes to tenant-scoped storage. Owner-only. |

Four ways to start a run: manually, by webhook with a bearer token, on a cron
schedule, or from a database event.

---

## Running it locally

**On Windows, WSL2 is required.** The Nhost CLI has no native Windows build,
and Git Bash is not a substitute. `wsl --install` in an elevated PowerShell,
then work inside Ubuntu. Keep the repo in the Linux filesystem (`~/agentflow`),
not under `/mnt/c`, or Docker file watching behaves strangely.

### Prerequisites

- Node.js 20+ (installed inside WSL, not on Windows)
- Docker, with `docker ps` working from inside WSL
- Nhost CLI: `curl -L https://raw.githubusercontent.com/nhost/cli/main/get.sh | bash`

### Setup

```bash
git clone https://github.com/Veebeeo/agentflow.git
cd agentflow
cd functions && npm install && cd ..
cd web && npm install && cd ..
```

Create `.secrets` in the repo root:

```
HASURA_GRAPHQL_ADMIN_SECRET='<openssl rand -hex 32>'
NHOST_WEBHOOK_SECRET='<openssl rand -hex 32>'

# RS256 keypair. Generated for you by `nhost config pull` after linking a
# cloud project. For a purely local setup, generate one with:
#   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048
NHOST_JWT_KID='<a UUID>'
NHOST_JWT_PRIVATE_KEY="<PEM, newlines escaped as \n>"
NHOST_JWT_PUBLIC_KEY="<PEM, newlines escaped as \n>"

AGENTFLOW_FUNCTIONS_URL='http://functions:3000'
AGENTFLOW_FUNCTIONS_SECRET='<openssl rand -hex 32>'
AGENTFLOW_SECRETS_KEY='<openssl rand -base64 32>'
AGENTFLOW_METADATA_URL='http://graphql:8080/v1/metadata'

LLM_PROVIDER='groq'
LLM_API_KEY=''
LLM_MODEL='llama-3.3-70b-versatile'

GRAFANA_ADMIN_PASSWORD='<openssl rand -hex 32>'
SLACK_WEBHOOK_URL=''
HTTP_ALLOWED_HOSTS=''

```

`AGENTFLOW_SECRETS_KEY` must decode to exactly 32 bytes, which is what
`openssl rand -base64 32` produces.

**The LLM key is optional.** Leave `LLM_API_KEY` empty and `llm_call` runs in
stub mode: a disclosed 900 ms delay and a deterministic response keyed on
whether the input reads as urgent, so the conditional branch still branches and
the whole demo works. For real calls, a free key from console.groq.com takes two
minutes.

Then:

```bash
nhost config validate
nhost up
```

Read the URL table it prints; the subdomains vary. Copy `web/.env.example` to
`web/.env.local` and make the URLs match. Note that the local stack serves
GraphQL at `/v1/graphql` while Nhost Cloud serves it at `/v1` — the code handles
both, but the env file has to be right for your environment.

```bash
cd web && npm run dev
```

Create the four demo accounts through the sign-up screen, then seed the
organizations and workflow from `nhost/seeds/default/001_demo.sql`. The seed
cannot create users, because Nhost Auth owns `auth.users` and hashes the
passwords itself.

---

## Layout

```
nhost/
  migrations/default/            schema, triggers, quota and lease functions
  metadata/
    databases/default/tables/    one file per table; permissions live here
    databases/default/functions/ tracked SQL functions
    actions.yaml + actions.graphql
    cron_triggers.yaml
  seeds/default/001_demo.sql

functions/
  _lib/
    engine.ts                    the executor: claim, advance, pause, resume
    repo.ts                      every database access in one reviewable place
    safe-fetch.ts                SSRF-hardened outbound HTTP
    template.ts                  {{...}} resolution, a lookup and not an evaluator
    crypto.ts                    AES-256-GCM for org secrets
    steps/                       one module per step type
  trigger-workflow-run.ts        Action: start a run
  approve-step.ts                Action: clear or reject an approval gate
  create-webhook-trigger.ts      Action: mint a webhook token, owner only
  webhook-trigger.ts             Action: public inbound endpoint
  execute-run.ts                 event handler that drives the engine
  cron/scheduler.ts              due schedules and stalled runs
  events/                        lead ingestion, notification delivery

web/
  app/                           sign in, dashboard, builder, live run view
  lib/                           nhost client, subscriptions, GraphQL documents
  components/
```

---

## Where each requirement lives

| Requirement | Where |
|---|---|
| Organizations, members, roles | `up.sql`, `public_org_members.yaml` |
| Workflows, steps, triggers | `up.sql`, `public_workflow_steps.yaml` |
| Runs with a paused state | `workflow_runs.status`, `_lib/engine.ts` |
| Step runs with attempts and approver | `step_runs`, `_lib/engine.ts` |
| Aggregation | `org_usage_current_period` view |
| Permission layer 1, org and role scoping | every `filter:` in `metadata/databases/default/tables/` |
| Permission layer 2, privileged steps | `step_type.is_privileged`, `guard_privileged_step` |
| Query: workflows with steps, triggers, latest run | `web/lib/queries.ts` → `ORG_WORKFLOWS` |
| Mutation: create and edit a workflow | `CREATE_WORKFLOW`, `SAVE_STEPS`, `ADD_TRIGGER` |
| Mutation: approve a paused gate | `APPROVE_STEP` → `functions/approve-step.ts` |
| Subscription on step_runs including paused | `STEP_RUNS_SUBSCRIPTION` |
| The Action integration | `functions/trigger-workflow-run.ts`, `_lib/engine.ts` |
| Retry | `_lib/retry.ts`, `step_runs.attempt` |
| Non-manual triggers | webhook, cron, and database event all live |
| Frontend auth and org context | `web/lib/session.tsx` |
| Run hidden for viewers | `web/app/workflows/[id]/page.tsx` |
| Live status with pause and approve | `web/app/runs/[id]/page.tsx` |
| Quota indicator | `web/components/QuotaMeter.tsx` |

---

---

## Known limitations

Stated plainly rather than buried.

- **Email verification is off** so the demo accounts work immediately.
- **`HTTP_ALLOWED_HOSTS` is narrow in production** (`postman-echo.com`), which
  is the correct posture but means arbitrary outbound URLs are refused on the
  hosted instance. The SSRF checks in `safe-fetch.ts` apply regardless.
- **Trigger payload shapes differ per trigger type.** A manual run supplies
  `{message}` while a database event supplies `{row: {...}}`, so the first
  step's template accommodates both. A production system would solve this with
  per-trigger input mapping.
- **Webhook tokens are shown once and cannot be read back**, which is
  deliberate, but the UI currently discards the token from view faster than it
  should.
- **`org_secrets` has no rotation flow.** Changing `AGENTFLOW_SECRETS_KEY`
  makes existing values undecryptable, which is correct behaviour and an
  incomplete feature.
- **Model output is not fully deterministic.** `temperature` is set to 0 on the
  classification step so the branch behaves consistently, but a model can still
  phrase a verdict unexpectedly.
