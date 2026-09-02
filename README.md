# CloudRAG infra

CDK TypeScript app that hosts several **specialist RAG agents** for one client, in their AWS account. Per stage (`dev`/`prod`) it synthesizes:

* `CloudRAGCore-{stage}` — the shared **Core** data plane (`lib/stacks/core-stack.ts`): one isolated VPC, one RDS Postgres instance (which hosts one database per agent), one ingest queue + dead-letter queue, one vector indexer, one Comprehend redactor, a DynamoDB staging table for documents awaiting role review, and a provisioner that creates each agent's database on demand.
* `CloudRAGAuth-{stage}` — the shared **Auth** tier (`lib/stacks/auth-stack.ts`): a Cognito User Pool minting the role claims the orchestrator filters retrieval by, one Cognito Group per role declared across every silo, and (dev only) a set of demo users. See [Roles & authentication](#roles--authentication).
* `CloudRAG-{stage}` — the shared **App** tier (`lib/stacks/app-stack.ts`): one multi-agent orchestrator (FastAPI + Pydantic AI) that also serves the chat + admin single-page app directly. The orchestrator surfaces every agent as a selectable model and routes each chat to that agent's database + prompt module. See [The chat application](#the-chat-application).
* `CloudRAG-{stage}-agent-{id}` — one **Agent Silo** per specialist (`lib/stacks/agent-silo-stack.ts`): an ingest bucket, a provisioned `agent_<id>` database, and an SSM registry entry. No compute of its own. Declared in [`config/agent-silos.ts`](config/agent-silos.ts) — see [Agent Silos](#agent-silos).

The App and Agent Silo stacks depend on Core (the App peers to the Core VPC; each Agent Silo uses the Core queue and provisioner) and on Auth (the App verifies caller tokens against the Cognito pool), so Core and Auth deploy first.

## Requirements

Before the first deploy, make sure all of the following are in place — the deploy will otherwise fail, or succeed but fail at runtime:

* **AWS credentials** for the target account, region **eu-west-1** (the DB instance and the Gemma 3 / Titan models used here live there).
* **Node.js ≥ 20** and a running **Docker** daemon — Docker builds the orchestrator image (a multi-stage build that also compiles the chat + admin frontend, `services/orchestrator/frontend/`); the indexer and provisioner Lambdas bundle their `pg8000` dependency (locally via host pip, falling back to Docker).
* **CDK bootstrap** for the account/region (one-time): `npx cdk bootstrap aws://<account-id>/eu-west-1`.
* **Bedrock model access** — the console *Model access* page has been retired: serverless foundation models auto-enable on first invocation in each commercial region. The default models — **Gemma 3 4B IT** (`google.gemma-3-4b-it`) and **Titan Text Embeddings v2** (`amazon.titan-embed-text-v2:0`) — need no manual activation in eu-west-1; the first call enables them. Access is governed by **IAM**: the orchestrator and indexer roles carry the `bedrock:InvokeModel` grants these stacks create. (A model served from **AWS Marketplace** must be invoked once by a principal with AWS Marketplace permissions to enable it account-wide.)
* **`.env.{stage}`** filled in (see [Configuration](#configuration)) — at minimum `CDK_ACCOUNT` and `CDK_REGION`.

Then: `npx cdk bootstrap …` → `npm run deploy:dev`.

## Configuration

Each stage reads its config from `.env.{stage}` (see `.env.example`):

```
CDK_ACCOUNT=<aws account id>
CDK_REGION=<aws region>
VECTOR_DB_ALLOWED_PRINCIPALS=<comma-separated IAM user/role ARNs>
```

`VECTOR_DB_ALLOWED_PRINCIPALS` controls who may open a tunnel to the database (see [Connecting to the database](#connecting-to-the-database)). Leave it empty to grant no one access.

The **agents** are configured separately, in code, in [`config/agent-silos.ts`](config/agent-silos.ts).

## Agent Silos

Each specialist agent is one entry in `config/agent-silos.ts`:

```ts
{ id: 'hr', displayName: 'HR Assistant', promptModule: 'hr', roles: HrRole, ingestWorkflow: IngestWorkflow.UIMediated, llmModelId?, redactPii? }
```

`bin/cloudrag.ts` loops the array to build one `AgentSiloStack` each (bucket + `agent_<id>` database + SSM registry). The `promptModule` maps to a prompt in `services/orchestrator/app/prompts/`. `roles` is that silo's own role enum (e.g. `HrRole`, declared alongside `agentSilos` in the same file) — role *names* are Cognito Group names, shared across silos that declare the same one. `ingestWorkflow` picks how newly-ingested documents get their roles — see [Roles & authentication](#roles--authentication).

* **Add an agent:** add an entry → `npm run deploy:dev`. If it reuses an existing `promptModule`, the orchestrator picks it up from SSM with **no orchestrator redeploy**; a genuinely new behaviour means adding a `PromptFlow` in `services/orchestrator/app/prompts/__init__.py` (a code change → the orchestrator image redeploys).
* **Remove an agent:** `cdk deploy` never deletes a stack that left the app, so removing an entry alone **orphans** the agent (its bucket + database keep running). Offboard in order — destroy first, then delete the entry:
  ```bash
  CDK_STAGE=dev npx cdk destroy CloudRAG-dev-agent-<id>
  ```
  `npm run silos:orphans` diffs deployed agent stacks against the config and flags leftovers.
* **Retention on destroy (per stage):** the bucket uses a CFN removal policy (dev `DESTROY` + auto-delete, prod `RETAIN`); the database is handled by the provisioner (dev `DROP DATABASE … WITH (FORCE)`, prod retains). Dev is fully disposable; prod keeps each agent's bucket + database.

Because the frontend, VPC, and NAT are **shared**, adding an agent costs only a database (negligible on the shared instance) + a bucket — not another app tier.

## Deploying

```bash
# deploy everything for a stage (Core first, then App + agent silos)
# each stack will ask for permissions to be approved separately so expect to hit "y" several times
npm run deploy:dev
CDK_STAGE=prod npm run deploy:prod
# the app url will be in the final outputs with the name CloudRAG-dev.AppUrl
# the usernames superuser, veridia-user, veridia-exec-team, hr-user, hr-hr-manager, hr-exec-team will be created
# the password in dev will be Demo1234! for all users


# or deploy stacks individually
CDK_STAGE=dev npx cdk deploy CloudRAGCore-dev          # shared data plane - takes about 10 minutes because of provisioning Postgres
CDK_STAGE=dev npx cdk deploy CloudRAGAuth-dev          # Cognito user pool
CDK_STAGE=dev npx cdk deploy CloudRAG-dev              # orchestrator + chat/admin app
CDK_STAGE=dev npx cdk deploy CloudRAG-dev-agent-hr     # one agent silo

```

## Uploading sample docs

You can load the sample corpora with the following:

npm run corpus:import veridia # this will be available for RAG immediately
npm run corpus:import hr      # this will be placed in the review queue in the UI before hitting the vector database



## Ingesting documents in detail

The shared indexer routes each message to the right agent's database (resolved from the source bucket or an `agent` field, via the SSM registry), optionally redacts PII with Comprehend (per-agent, `redactPii` in the config), embeds with Titan v2, and upserts into that agent's `embeddings` table.

Two ways to feed an agent (`hr` in the examples):

* **Upload a document** to the agent's bucket — an S3 event enqueues it:

  ```bash
  aws s3 cp ./doc.txt s3://$(aws ssm get-parameter --name /cloudrag/$CONNECTION_ENV/agents/hr/bucket --query Parameter.Value --output text)/
  ```

* **Enqueue text directly** to the shared queue, naming the target agent:

  ```bash
  aws sqs send-message \
    --queue-url $(aws ssm get-parameter --name /cloudrag/$CONNECTION_ENV/core/ingest-queue-url --query Parameter.Value --output text) \
    --message-body '{"agent":"hr","id":"doc-1","text":"Jane Doe can be reached at jane@example.com."}'
  ```

**PII redaction** is per-agent, set by `redactPii` in `config/agent-silos.ts` (default on) and stored at `/cloudrag/{stage}/agents/{id}/redact`. To change it, edit the config and redeploy that agent stack.

## Connecting to the database

The instance sits in an isolated subnet with no public IP. Access is IAM-gated to principals in `VECTOR_DB_ALLOWED_PRINCIPALS`, via one of two paths:

* **`npm run db:connect`** — starts the dev-only DB bastion (a `t4g.nano`, stopped when not in use), SSHes into it through the existing [EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html) with a local port-forward to Postgres, and drops into `psql` — one command, and it stops the bastion again once you disconnect (`\q` or Ctrl-C). `aws ec2-instance-connect open-tunnel` itself only supports remote port 22/3389 (AWS-enforced, not this repo's choice) so it can't reach Postgres directly — this is why the bastion hop exists at all. Costs roughly $0.35–3/month depending on how often it's used (mostly the instance's EBS volume, which persists whether it's running or not; the compute itself is only billed while it's up). Dev only — there's no bastion in prod.
* **`npm run db:cloudshell`** — prints the one-time [CloudShell VPC environment](https://docs.aws.amazon.com/cloudshell/latest/userguide/vpc-environment.html) setup (subnet + security group) and a one-liner to paste into that session to connect instead. No standing infrastructure at all (~$0/month), but you're working in a browser shell rather than your own terminal.

Either way: the instance's maintenance database is `postgres`; each agent's data is in its own `agent_<id>` database (`\l` to list, `\c agent_hr` to inspect one).

The provisioner creates each `agent_<id>` database with the `vector` extension, an `embeddings` table, and its HNSW index, so no manual schema setup is needed. The schema in each database is:

```sql
CREATE TABLE embeddings (
  id bigserial PRIMARY KEY,
  source_id text UNIQUE NOT NULL,
  content text,
  embedding vector(1024),          -- Titan Text Embeddings v2
  created_at timestamptz DEFAULT now()
);
CREATE INDEX embeddings_embedding_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);
```

## The chat application

The App stack is one multi-agent orchestrator that also serves the chat + admin frontend
directly — there's no separate frontend service:

```
Browser (SPA, logged into Cognito) → public ALB → Orchestrator (FastAPI + Pydantic AI)
                                                     │ every route requires the caller's own
                                                     │ Cognito token (X-Cognito-Token header)
                                                     │ pick agent = pick model
                                                     ├─ embed query (Titan v2)
                                                     ├─ top-k retrieve from agent_<id>,   (over VPC peering)
                                                     │  filtered by the caller's roles
                                                     └─ Gemma 3 4B on Bedrock (Converse, IAM)  (via NAT)
```

* **Orchestrator** — `services/orchestrator/`, an OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`, streaming and non-streaming) plus an admin API (`/api/admin/*`, see below). `/v1/models` lists each Agent Silo (read from SSM); a chat request routes by the `model` field to that agent's database (filtered by the caller's Cognito roles) and prompt module (for behaviour), then answers with Gemma 3 (or the agent's `llmModelId`) via Bedrock Converse — IAM auth, no API key.
* **Frontend** — `services/orchestrator/frontend/`, a small React + Vite single-page app, built in a Docker multi-stage build and served by the orchestrator itself (`/`, mounted last so it can't shadow any API route). No Cognito Hosted UI (no owned domain for this POC): the login screen calls Cognito's `InitiateAuth` directly from the browser.
* **Networking** — the App VPC (`10.1.0.0/16`, public + private-with-NAT) is peered to the isolated Core VPC (`10.0.0.0/16`) for Postgres; Bedrock, DynamoDB, and Cognito are reached over NAT. The ALB is public, but every route is gated at the application layer (a valid Cognito token; `Superuser` for `/api/admin/*`) rather than by network placement.

After `cdk deploy`, the App stack outputs `AppUrl` — open it, sign in (see [Roles & authentication](#roles--authentication) for demo credentials), pick a specialist, and chat. Ingest into that agent first (above) so retrieval has something to return; with no data the agent still answers, just without grounding.

## Roles & authentication

Retrieval is filtered by role: each document's `allowed_roles` (a `text[]` column on `embeddings`)
must overlap the caller's Cognito groups, or be empty/`NULL` (nothing tags it that way by default
— see ingest workflows below). The `Superuser` role always bypasses the filter.

* **Roles are per-silo**, declared as a string enum right next to that silo's config entry in
  `config/agent-silos.ts` (e.g. `VeridiaRole`, `HrRole`) — a role's string value *is* its Cognito
  Group name, so no id/translation layer exists anywhere. A name declared by more than one silo
  (e.g. `"Exec-Team"`) is still just one shared Cognito Group. Two roles are global, fixed
  sentinels (the `Role` enum, also in `config/agent-silos.ts`): `Unauthenticated` (no/invalid
  token — never an actual group) and `Superuser` (bypasses every silo's filter).
* **Ingest workflow** — each silo's `ingestWorkflow` decides how a newly-ingested document gets
  its `allowed_roles`:
  * `AllUser` — auto-tagged with that silo's `User` role (so it's visible to anyone holding at
    least `User`, not to `Unauthenticated` callers).
  * `UIMediated` — staged in a DynamoDB table instead of being written to Postgres at all;
    reviewed on the app's **Admin** tab (visible only to `Superuser`), where checking roles and
    clicking Publish inserts it into that silo's `embeddings` table with the chosen roles (or
    Discard drops it).
* **Dev-only demo users** — the Auth stack seeds one Cognito user per (silo, role) pair (e.g.
  `hr-hr-manager`, `veridia-user`) plus `superuser`, all sharing one password: `Demo1234!`. Never
  created for `prod`. Listed in the `DemoUsernames` output after deploy.

> ⚠️ The demo users' shared, hardcoded password is a deliberate POC convenience — fine because
> nothing behind it is real data. Don't reuse this pattern anywhere real credentials matter.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run test`    perform the jest unit tests
* `npm run deploy:dev` / `deploy:prod`   deploy all stacks for that stage
* `npm run destroy:dev`   tear all dev stacks down (skips the prompt; there is no prod destroy by design)
* `npm run silos:orphans`   list agent stacks deployed but no longer in the config
* `npm run corpus:import -- <agentId>`   upload `corpora/<agentId>_corpus/` into that silo's ingest bucket
* `npm run db:connect`   start the DB bastion, tunnel, and `psql` in one command; stops the bastion on disconnect (see [Connecting to the database](#connecting-to-the-database))
* `npm run db:cloudshell`   print CloudShell VPC environment setup + a connect one-liner instead (no standing infrastructure)
* `npx cdk diff` / `npx cdk synth`   diff against, or emit, the synthesized templates

## Spin up for a day, then tear down

Everything in `dev` uses `DESTROY` removal policies (RDS, buckets, VPCs) and explicit 7-day log groups, so a throwaway cycle leaves nothing billable behind:

```bash
npm run deploy:dev    # ~20-30 min (RDS is the long pole)
# ... use the AppUrl output, then when done ...
npm run destroy:dev   # ~15-20 min
```

Idle run-rate for the shared `dev` stacks is roughly **$4/day** (1 Fargate task, 1 ALB, 1 NAT gateway, 4 VPC interface endpoints, the RDS instance), plus per-agent buckets/databases and the (stopped-by-default) DB bastion's EBS volume (all negligible) and usage-based Bedrock tokens. `destroy` deletes the RDS with no final snapshot, so ingested data is lost — expected for a disposable environment.
