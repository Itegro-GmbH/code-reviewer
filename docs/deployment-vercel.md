# Deploying Code Reviewer on Vercel (hosted deployment)

This is the guide for the **hosted deployment** (umbrella #316): the App as a serverless Vercel project, a
Dispatcher as a second Vercel project, and every review job run by a short-lived Worker inside a fresh Vercel
Sandbox VM. Follow it top to bottom for a first deployment. Every variable, command and step in it was checked
against the code on `development`; section 8 says what no test has proven yet, and that is a lot: **nobody has
run the whole path on Vercel yet** (the first real deployment is the one this guide is written for).

**Deployments are made by GitHub Actions, with Infisical as the secret manager, and a release has no manual step**
(#403). Merging to `main` runs `.github/workflows/deploy-production.yml`: it migrates the database, decides whether the
golden snapshot has to be rebuilt and rebuilds it when it does, stages the App and then the Dispatcher on Vercel
production (a staged deployment takes no domain), checks the staged App's health, runs the Dispatcher canary on the
staged Dispatcher, which must report the image this run built, and only then promotes both. Afterwards it writes the new
snapshot to Infisical and removes the snapshots nobody needs. A failure before the promotion leaves production on the
deployments and the snapshot it has. There is no staging environment and there are no preview deployments, and the
projects' Git integration is switched off. Section 2.1 lists everything to create once (GitHub, Infisical, Vercel);
section 5.1 explains the snapshot, section 5.6 a release.

## Contents

1. [What you are deploying](#1-what-you-are-deploying)
2. [What you need first](#2-what-you-need-first)
3. [Environment variables](#3-environment-variables)
4. [First deployment, step by step](#4-first-deployment-step-by-step)
5. [Operations](#5-operations)
6. [Sizing the Worker VMs](#6-sizing-the-worker-vms)
7. [Rolling back](#7-rolling-back)
8. [Known limits and what is not verified](#8-known-limits-and-what-is-not-verified)
9. [Follow-ups](#9-follow-ups)

## 1. What you are deploying

The words below are used exactly like this in the code, the other documents and the log lines
([`dispatcher.md`](dispatcher.md) has the interfaces).

| Term | Meaning |
|---|---|
| **App** | The Next.js app with the database. Receives GitHub webhooks, creates jobs, stores results, serves the UI. It never reviews. Vercel project 1, root directory `app/`. |
| **Dispatcher** | The middle layer. It is woken for a job, claims exactly that job, receives the per-job credential from the App and starts a Worker. It never reviews and never sees the git token or the model key. Vercel project 2, root directory `dispatcher/`, a Hono app. |
| Trigger | How the Dispatcher learns about a job. The **Webhook-Trigger**: the App calls it, signed. |
| Dispatcher core | Claim, per-job credential handling, concurrency cap, launch error handling. No platform code. |
| Launcher | How a Worker is started. The **Sandbox-Launcher**: a fresh VM from the golden snapshot, our hardened container run through Docker inside it. |
| **Worker** | The isolated process tree that runs exactly one job: the **Diff-Worker** (PR-Agent) or the **Dynamic-Worker** (OpenCode engine). It knows only the App URL, the job id and a per-job credential. |
| **Worker contract** | What the Worker may do with that credential and nothing more: fetch the job, heartbeat, deliver the result (`/api/workers/v1`, `contracts/worker-api.v1.json`). The same whoever started the Worker. |
| **Golden snapshot** | A snapshot of a VM with a pinned Docker installed and the Worker image already built. Every job gets a fresh clone; a snapshot never holds job data. |

"Runner" is a retired concept, but its names stay: `RUNNER_*` variables, `/api/runners/v1`, the image names.

### One job, end to end (webhook mode)

```
GitHub ──webhook──▶ App ──queues the job, then signed POST /dispatch──▶ Dispatcher (Trigger)
                     ▲                                                     │ core: claim by job id
                     │◀──── claim (RUNNER_TOKEN) / per-job credential ─────┤
                     │                                                     ▼ Sandbox-Launcher
                     │                                      fresh VM from the golden snapshot (fra1)
                     │                                      docker run, credential on stdin only
                     └──── Worker: fetch job, heartbeat, deliver result ◀──── Worker container
```

1. A pull request event reaches the App, which stores a job and, after the transaction committed, sends one signed
   `POST` to the Dispatcher's `/dispatch`.
2. The Dispatcher checks the signature, answers at once (`202`) and continues in the background: it claims exactly
   that job with `RUNNER_TOKEN`. The App enforces the pool cap in the same step and answers with the per-job
   credential. Nothing else reaches the Dispatcher: no git token, no model key.
3. The Sandbox-Launcher creates a VM from the golden snapshot (`persistent: false`, region `fra1`), prepares Docker,
   checks the image id against `SANDBOX_IMAGE_DIGEST` and runs the hardened Worker container. The App URL, the job id
   and the credential go in on **stdin only**.
4. The Worker fetches its job from the App (this is where the git token and the model key are minted, for this job
   only), heartbeats, delivers the result and exits. The Dispatcher does not watch it after the hand-over: when the job ends,
   **the App** sends the Dispatcher a signed `POST /stop` and the Dispatcher stops the job's VM (section 5.5). The VM itself
   never gets access to the Dispatcher.
5. The App's cron sweep (**every 2 hours**) is a safety net for what goes wrong in between: lapsed leases, resends of
   wake-ups that nobody acknowledged, jobs nobody claimed in time, notices that failed, the cleanup. **The normal
   flow never waits for it**: a review is sent when it is queued, a job that waited for a slot is sent when the slot
   frees, and a failed wake-up is repeated inside the request that made it (section 5.7). The sweep is sparse on
   purpose: a serverless Postgres that scales to zero (Neon, for one) goes to sleep after about five minutes without a
   query, and a cron every minute would keep it awake, and billed, around the clock.

### How the App finds the Dispatcher

`RUNNER_DISPATCH` has two values. `webhook` is the deployment's mode: when a job is queued the App sends the Dispatcher a
signed wake-up call, the Dispatcher claims exactly that job and starts a Worker in a fresh Sandbox VM. `poll` is the
default when the variable is unset: the App wakes nobody, so a queued job only waits (the test lanes use it, and the
first steps of section 4 run in it until step 5 switches the App to `webhook`). The App runs as functions on Vercel
and uses Postgres only.

### What the App does without a long-lived process

- No work at start: the schema is migrated by a command (`pnpm migrate`), the first-run setup code is made by a
  command (`pnpm setup-code`), and `/api/health` answers `503` with `{"status":"error","code":"SCHEMA_BEHIND"}` while
  the database lacks a migration of this version.
- Two crons (`app/vercel.json`): `/api/internal/repository-sync` once a day and `/api/internal/dispatch-sweep` **every
  2 hours**. Both need `CRON_SECRET`.

## 2. What you need first

**Vercel.**

- A team on a plan that allows what `app/vercel.json` and `dispatcher/vercel.json` ask for: a cron that runs **every
  2 hours** (the Dispatcher's reaper runs every 5 minutes) and, for the Dispatcher, a function
  `maxDuration` of **1800 seconds**. 1800 s is the *extended* maximum for Pro and Enterprise teams on Node.js 22 or 24
  and is a **beta limit**; 800 s is the generally available maximum and Hobby is limited to 300 s
  (`dispatcher/README.md`, "The Sandbox-Launcher"). Check your plan's current limits before you start: they are the
  platform's and they change.
- **The 2 hour cron is a safety net, and it is required.** It is the App's sweep (`/api/internal/dispatch-sweep`). The
  normal path does not depend on it: a review is sent to the Dispatcher by the request that queued it (a push starts
  its review at once; there is no debounce), a call that failed is repeated a few times inside that request, and a
  job that waited behind the pool cap or behind the running job of its pull request is sent when that slot frees.
  What only the sweep repairs, and how long that can take, is in section 5.7. Without it a lost Worker, a call that
  keeps failing and a job nobody claims are noticed late or never (the requests of the day, a delivery or a heartbeat,
  repair some of it). A plan that allows only daily crons cannot run this deployment; the daily `repository-sync` is
  not a substitute.
- Access to Vercel Sandbox for the team, in region `fra1`. Every project and snapshot of this deployment is in `fra1`
  and there is **no failover region** (snapshots are region-bound).
- Two projects, from the same Git repository:

  | Project | Root directory | Framework | Config |
  |---|---|---|---|
  | App | `app/` | Next.js | `app/vercel.json`: region `fra1`, install command `pnpm install --frozen-lockfile --filter code-reviewer-app...`, function durations, the two crons |
  | Dispatcher | `dispatcher/` | Hono (the entry is `src/index.ts`, the only file named `app`, `index` or `server` that imports `hono`) | `dispatcher/vercel.json`: region `fra1`, install command `pnpm install --frozen-lockfile --filter code-reviewer-dispatcher...`, `maxDuration` 1800 for `src/index.ts`, one cron (the reaper, every 5 minutes) |

  Both need Node.js 24 (`engines` in both `package.json` files, `.nvmrc`). Set the Node.js version of each project to
  24.x if the project's default differs.

  The two projects are members of one pnpm workspace (`pnpm-workspace.yaml`, one `pnpm-lock.yaml` at the repository
  root, #724): the packages of both projects are installed into `node_modules/.pnpm` at the root, outside each project's
  root directory. Each Vercel project must therefore have **Include source files outside of the Root Directory in the Build
  Step** switched on (Settings, Build and Deployment, Root Directory); the install command of each project is the one in its
  `vercel.json`, filtered to that project, so a deployment installs only what it needs. The deployment workflow builds in
  GitHub Actions from the repository root and uploads the result (`vercel deploy --prebuilt`), and
  `tools/vercel/check-build-output.mjs` fails the stage when a file a built function lists is not in the checkout.
- Crons run **only for the production deployment** of a project. A preview or staged deployment never sweeps (App) and never reaps (Dispatcher).
- A production domain for each project. The **App's URL must be reachable without a login** by GitHub (webhooks), by
  the Worker inside the VM (it calls the App's Worker API and has no way to send a bypass header) and by Vercel's cron.
  Do not put Vercel's Deployment Protection in front of the App's production domain. The Dispatcher is called only
  by the App and by the canary; if you protect it, use Protection Bypass for Automation and set the bypass secret in the two places
  named in section 3.

**An external Postgres, version 15 or newer** (Postgres 18 is what CI tests against),
reachable from Vercel's `fra1` functions and from the machine that runs `pnpm migrate`, with TLS. You need **two
roles** and **two URLs**:

| Role | URL | Used by | Needs |
|---|---|---|---|
| **migrate** | `DATABASE_URL_MIGRATE`, a **direct** connection (no pooler: the migration holds a session advisory lock) | `pnpm migrate` and `pnpm setup-code`, run by you, never by a Vercel function | Owns the database and its schema: creates and alters tables and indexes |
| **app** | `DATABASE_URL`, a **direct or session-mode** connection, **never a transaction pooler** | The App's functions | Reads and writes the tables the migrate role created; no DDL |

**Why `DATABASE_URL` must not be a transaction pooler.** The App serializes the integration sync of one GitHub
installation with a *session-level* advisory lock (`pg_advisory_lock`, then `pg_advisory_unlock` on the same session:
`withPostgresAdvisoryLock` in `app/src/db/postgres.ts`; it runs on installation webhooks and in the daily
`repository-sync`). Behind a pooler that hands out a different server connection per transaction, the lock and its
unlock can land on different backends: the serialization is lost, and a lock can stay held on a pooled backend so that
later syncs of that installation wait forever. A direct connection is right, and so is a pooler in **session mode**
(one client keeps one server connection for its whole session). Transaction mode and statement mode are not fine.
Keep `DATABASE_POOL_MAX` small (default 3, 20 at most): every function instance has its own pool, so the number of
connections your database must accept is the number of instances times that. The sweep's own lock is a transaction
lock and would survive a transaction pooler; the sync lock is why the URL cannot (follow-up: #371).

The migrations create tables and indexes only (no extension, type, function or sequence), so the app role needs
`usage` on the schema and `select, insert, update, delete` on the tables, including the tables created later. Run the
commands from a terminal; the three secrets (the admin password and the two role passwords) are read or generated into
shell variables, never typed into a command line, so they stay out of the shell history and the process list. Role
passwords are **hex** (`openssl rand -hex 32`), which cannot break a `postgres://` URL the way a base64 password with
`/`, `+` or `@` does.

```sh
read -rs -p 'Postgres admin password: ' PGPASSWORD; export PGPASSWORD; echo
MIGRATE_PW=$(openssl rand -hex 32); APP_PW=$(openssl rand -hex 32)
# 1. Roles and database, as the administrator, connected to any database:
psql -h <host> -U <admin> -d postgres -v ON_ERROR_STOP=1 <<SQL
create role cr_migrate login password '$MIGRATE_PW';
create role cr_app login password '$APP_PW';
create database code_reviewer owner cr_migrate;
SQL
# 2. The schema's privileges, as the administrator, connected to the new database:
psql -h <host> -U <admin> -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
revoke all on schema public from public;
grant usage, create on schema public to cr_migrate;
grant usage on schema public to cr_app;
SQL
# 3. Default privileges, as the migrate role (it owns the tables, so they cover every table it creates from now on):
PGPASSWORD=$MIGRATE_PW psql -h <host> -U cr_migrate -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
alter default privileges in schema public
  grant select, insert, update, delete on tables to cr_app;
SQL
```

If the admin is not a superuser (managed Postgres), creating a database *owned by* another role needs the admin to be
a member of that role (`grant cr_migrate to <admin>;` first, or your provider's way of doing it). Copy the two
passwords into your password manager now (`printf '%s\n' "$MIGRATE_PW" "$APP_PW"` prints them once, to the terminal
only), then `unset MIGRATE_PW APP_PW`. Steps 1 and 2 show how the URLs are built from them without printing or
recording them.

The privileges of step 3 only cover tables that `cr_migrate` creates **after** it. If the smoke test or the logs show
`permission denied for table ...` (migrate was run before step 3, or by another role), repair it; do not widen the
role:

```sh
read -rs -p 'cr_migrate password: ' PGPASSWORD; export PGPASSWORD; echo
psql -h <host> -U cr_migrate -d code_reviewer -v ON_ERROR_STOP=1 <<SQL
grant select, insert, update, delete on all tables in schema public to cr_app;
SQL
```

The role split is exercised in CI (`app/src/db/role-split.integration.test.ts` runs exactly the SQL above against a real
Postgres: migrate as `cr_migrate`, then health, read and write as `cr_app`, and the repair).

Back up the database yourself (the App makes no backups) and keep a copy of `APP_SECRET`
**apart from it**: a database restored without its `APP_SECRET` loses every stored credential.

**A GitHub App for the hosted instance.** Not the one of any other installation: a GitHub App has exactly one webhook
URL and one callback URL, so the hosted instance needs its own. It is created from the deployed App with one click
(admin portal, Integrations) in step 4, [`github-app.md`](github-app.md) has the details. Nothing about it is an
environment variable.

**GitHub, Infisical and Vercel, set up for the pipeline.** The workflows sign in to Infisical with one machine identity
whose sign-in values are four secrets of the GitHub environment `production`, and read everything else they need from
Infisical. Section 2.1 lists exactly what to create, and where. The former environments `hosted-snapshot` and
`hosted-canary` and the repository variable `DISPATCHER_CANARY_HOSTS` are **retired**: delete them once the
secrets they held are in Infisical `/ci`. The repository variable `GOLDEN_SNAPSHOT_ENABLED` is retired too: the
deployment builds a snapshot when it has to.

**On your machine**, a checkout of `main` (or the release tag), Node.js 24, pnpm 10 and `openssl`:
`pnpm install --frozen-lockfile` (the app and the Dispatcher are one pnpm workspace with one `pnpm-lock.yaml` at the root).
The commands in steps 1 and 4 run from there.

### 2.1 Setup of the deployment pipeline (once)

This repository is public: nothing below is written into it, no value, no id, no address. Names between `<` and `>` are
yours.

**GitHub** (repository settings, Environments):

- One environment, **`production`**. Deployment branches and tags: *Selected branches and tags*, only the branch
  `main`. **This rule is the security boundary.** Every job that signs in to Infisical runs in this environment, so a
  run on any other branch is refused before it can read a secret. The jobs' own condition (repository and
  `refs/heads/main`) only guards against accidents: anyone who can push a branch can push a workflow file without it,
  and only the environment's rule stops that run from reading the four secrets below. It is a setting in the
  dashboard that no workflow can verify (the job's token cannot read an environment's settings, and a check inside a
  job that the rule already admitted would prove nothing), so check it yourself when you set it up and after any
  change to the environment: `gh api repos/<owner>/<repo>/environments/production --jq '.deployment_branch_policy'`
  must show `custom_branch_policies: true`, and `gh api repos/<owner>/<repo>/environments/production/deployment-branch-policies --jq '.branch_policies[].name'`
  must list exactly `main`. Required reviewers are not set: every job of the pipeline would wait for the approval
  (section 7 says what that means for a rollback).
- Its four **secrets** (environment secrets, **not** variables: variables of a public repository are world-readable):

  | Secret | Meaning |
  |---|---|
  | `INFISICAL_CLIENT_ID` | The Client ID of the machine identity below |
  | `INFISICAL_CLIENT_SECRET` | Its Client Secret |
  | `INFISICAL_DOMAIN` | The address of your Infisical instance (`https://<infisical host>`) |
  | `INFISICAL_PROJECT_SLUG` | The slug of the Infisical project below |

  A called workflow does not see the environment's secrets on its own: the caller must pass them, or the secret is an
  empty string without any error (GitHub, "Reuse workflows", environment secrets). `deploy-production.yml` therefore
  passes exactly these four by name in the `secrets:` of every job that calls `vercel-stage.yml`, `golden-snapshot.yml`
  or `dispatcher-canary.yml` (never `secrets: inherit`, so nothing else crosses over), and each of those declares them
  as required `workflow_call` secrets. The called job still selects the environment with `environment: production`; a
  job that calls a workflow cannot take an environment itself. The first deployment failed on this (#408).

  Set them without typing a value into a command line, for example
  `read -rs -p 'value: ' V; printf '%s' "$V" | gh secret set INFISICAL_CLIENT_SECRET --env production; unset V`.
- No repository variable is needed, except `FACTORY_ENABLED` when you run a second App, and `FACTORY_EXPECTED_CAPABILITIES` when that App's capability set is not the default (section 5.8; both are *repository* variables, not variables of the environment `production`). Unset, the pipeline is exactly the one described here.
- Retired: the environments `hosted-snapshot` and `hosted-canary`, the repository variables `DISPATCHER_CANARY_HOSTS`
  and `GOLDEN_SNAPSHOT_ENABLED`.

**Infisical** (one project; the workflows use the environment slug **`prod`** and nothing else):

- Three folders in `prod` (a fourth, `/app-factory`, only for a second App, section 5.8):

  | Folder | Holds | Who reads it |
  |---|---|---|
  | `/ci` | Only what the workflows need, listed below | GitHub Actions, through the machine identity. Not synced to Vercel as a folder; two of its values reach the projects by reference (below) |
  | `/app` | The runtime variables of the App project: the table of section 3.1 | Vercel, by Secret Sync |
  | `/dispatcher` | The runtime variables of the Dispatcher project: the table of section 3.2, and the three `SANDBOX_SNAPSHOT_*` keys the pipeline writes (below) | Vercel, by Secret Sync; the pipeline writes the three keys |

- The keys of **`/ci`** (all required, except `DISPATCHER_OPERATOR_TOKEN`, which the canary loads when it exists: a workflow that names a key that is missing or empty stops with its name):

  | Key | What it is | Read by |
  |---|---|---|
  | `VERCEL_TOKEN` | A Vercel access token for the team (section 3.4 says how to limit it) | the deployment, the rollback, the canary's check of the staged host, the snapshot build |
  | `VERCEL_TEAM_ID` | The id of the Vercel team (`team_...`). The workflows export it as `VERCEL_ORG_ID` for the CLI | all of them |
  | `VERCEL_APP_PROJECT_ID` | The id of the App's Vercel project (`prj_...`) | the deployment, the rollback |
  | `VERCEL_DISPATCHER_PROJECT_ID` | The id of the Dispatcher's Vercel project | the deployment, the rollback, the canary, the snapshot build |
  | `VERCEL_APP_AUTOMATION_BYPASS_SECRET` | The App project's *Protection Bypass for Automation* secret: opens the staged App's address for the health check | the health check |
  | `VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET` | The same for the Dispatcher project: opens the staged Dispatcher's address for the canary | the canary |
  | `DATABASE_URL_MIGRATE` | The direct URL of the migrate role (section 2) | the migration |
  | `RUNNER_TOKEN` | The dispatcher credential, the canary's. **The value of the App's and the Dispatcher's `RUNNER_TOKEN`** | the canary |
  | `VERCEL_FACTORY_PROJECT_ID` | The id of the second App's Vercel project (section 5.8; only with `FACTORY_ENABLED`) | the second App's deployment, the rollback |
  | `VERCEL_FACTORY_AUTOMATION_BYPASS_SECRET` | The second App project's *Protection Bypass for Automation* secret (section 5.8) | the second App's health check |
  | `DATABASE_URL_MIGRATE_FACTORY` | The direct URL of the migrate role of the second App's database (section 5.8) | the second App's migration |
  | `DISPATCHER_OPERATOR_TOKEN` | **Optional until the Dispatcher has its operator token** (#730): the credential that opens `/probe`. **The value of the Dispatcher's `DISPATCHER_OPERATOR_TOKEN`**; add it to `/ci` and to `/dispatcher` together (`dispatcher/README.md`, "Rollout of the operator token"). With the second App (section 5.8) it also opens `/apps/check`, and the lane's `apps-check` requires it | the canary, when the key exists; the check of the Apps |

**Infisical Secret Sync** (the App's and the Dispatcher's variables reach Vercel from Infisical, never from a workflow):

- Two syncs, destination *Vercel*: source `prod` `/app` to the **App** project, environment **Production**; source `prod`
  `/dispatcher` to the **Dispatcher** project, environment **Production**. Switch auto-sync on. The deployment job then
  reads the result with `vercel pull`. Do not set a variable of these projects by hand in Vercel: the next sync would
  overwrite it. A change in Infisical takes effect with the **next deployment**, so wait until the sync shows
  *synced* and then run the *Deploy production* workflow.
- **Shared values.** Some values must be identical in both projects (section 3.3): `RUNNER_TOKEN`, the signing secret
  (`RUNNER_WEBHOOK_SECRET` and `DISPATCHER_SIGNING_SECRET`), the key id, the pool cap, the App's address
  (`BETTER_AUTH_URL` and `RUNNER_API_URL`) and, only if the Dispatcher's production domain is protected, the bypass secret
  (`RUNNER_WEBHOOK_BYPASS_TOKEN`). Keep each of them **once**, with Infisical secret references, so that they cannot
  drift apart: the value lives in one place, the other key holds a reference to it.

  | Value | Stored in | The other key is a reference |
  |---|---|---|
  | `RUNNER_TOKEN` | `/ci` `RUNNER_TOKEN` | `/app` `RUNNER_TOKEN` = `${prod.ci.RUNNER_TOKEN}`, `/dispatcher` `RUNNER_TOKEN` = `${prod.ci.RUNNER_TOKEN}` |
  | Signing secret | `/app` `RUNNER_WEBHOOK_SECRET` | `/dispatcher` `DISPATCHER_SIGNING_SECRET` = `${prod.app.RUNNER_WEBHOOK_SECRET}` |
  | Signing key id | `/app` `RUNNER_WEBHOOK_KEY_ID` | `/dispatcher` `DISPATCHER_SIGNING_KEY_ID` = `${prod.app.RUNNER_WEBHOOK_KEY_ID}` |
  | Pool cap | `/app` `RUNNER_DISPATCH_MAX_RUNNING` | `/dispatcher` `DISPATCHER_MAX_RUNNING` = `${prod.app.RUNNER_DISPATCH_MAX_RUNNING}` |
  | The App's address | `/app` `BETTER_AUTH_URL` | `/dispatcher` `RUNNER_API_URL` = `${prod.app.BETTER_AUTH_URL}` |
  | The Dispatcher's bypass secret (only if protected) | `/ci` `VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET` | `/app` `RUNNER_WEBHOOK_BYPASS_TOKEN` = `${prod.ci.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET}` |

  The notation is `${<env>.<folder>.<KEY>}`, with the **environment slug first**, then the folder path with dots, then the
  key: `${prod.ci.RUNNER_TOKEN}`. A short form without the environment slug is not resolved on a real
  instance: it stays literal text and would be synced to Vercel as such. After you set a reference up, check in the
  Infisical dashboard that the value shows as resolved, and once in Vercel that the synced variable holds the value and
  not the text of the reference. Everything else is **not** shared: in particular the two `CRON_SECRET`s are two values (section 3.3).

  **What is not in a folder.** There is no GitHub App credential and no model API key in `/ci`, `/app` or `/dispatcher`:
  the hosted App takes neither from its environment. The GitHub App is created from the deployed App in the admin portal
  (step 4) and its id, private key and secrets are stored in the database, encrypted with `APP_SECRET`; each workspace
  enters its own model key in its settings, and the operator's key for `managed` workspaces is saved in the admin portal
  under **LLM key** (`/admin/llm`, section 3.5), also encrypted in the database. The `GITHUB_*` and `LLM_API_KEY`
  variables the code still reads are not used by a hosted instance, which never sets them (section 3.1).

**The golden snapshot keys.** Three keys of `/dispatcher` belong to the pipeline: `SANDBOX_SNAPSHOT_ID`,
`SANDBOX_IMAGE_DIGEST` and `SANDBOX_SNAPSHOT_COMMIT` (the commit the snapshot was built from). **Do not create them,
and do not give them a placeholder.** Absent is the supported state ("no launcher, nothing is claimed"); a placeholder
that is not an id makes the Dispatcher refuse to start (`SANDBOX_SNAPSHOT_ID` set without a valid
`SANDBOX_IMAGE_DIGEST`, or the other way round, is a `ConfigError` when the function initialises), in every deployment
that does not get the pipeline's own values. The first deployment writes the keys (the write creates what is missing, so
the identity needs *create* as well as *edit* on exactly these three names: a 403 on that first write means the role
lacks it), and from then on **do not edit them by hand**: the pipeline writes them, and only after a promotion. They
are not secrets, and they must reach Vercel as ordinary variables, **not as Sensitive ones**: `vercel pull` does not
return a Sensitive variable, and a blank pair makes every deployment rebuild the snapshot (safe, but slow and wasteful).
After the first run, check once that the three keys exist in Infisical and in the Vercel project, and that Vercel does
not show them as Sensitive. The pipeline works from the pair its live Dispatcher deployment carries (section 5.1); the
keys are what Secret Sync and a deployment made by hand see.

**Machine identity** (Infisical, Access Control): **one** identity, **Universal Auth**, used by every job of the pipeline.
Its role is exactly this, and nothing more (create a custom role and add the identity to the project with it):

| Permission (Infisical project role) | Environment | Secret path | Secret names | Why |
|---|---|---|---|---|
| Secrets: describe and read value | `prod` | `/ci` | any | The jobs load the keys of `/ci` |
| Secrets: describe, create and edit | `prod` | `/dispatcher` | `SANDBOX_SNAPSHOT_ID`, `SANDBOX_IMAGE_DIGEST`, `SANDBOX_SNAPSHOT_COMMIT` | The persist job and the rollback write the pair |
| Read the project (to find it by its slug) | the project | | | The write path looks the project id up from `INFISICAL_PROJECT_SLUG` |

- **No** read of `/app` or `/dispatcher`, no other environment, no delete, no folder, project or identity
  administration. The secret path conditions are `$eq` `/ci` and `$eq` `/dispatcher`.
- **The condition on the three secret names (`$in` the three names) is recommended hardening**: it makes the write
  path unable to touch any other key of `/dispatcher` even if the code that calls it were changed. The pipeline does not
  depend on it (the code fixes the three names itself), so a role without it works.
- The same identity reads `/ci` in the read-only jobs and writes in two places; the repository's structure tests pin
  that only the `persist` job of `deploy-production.yml` and the `rollback` job of `rollback-production.yml` use the
  write path (`.github/actions/infisical-write-snapshot-pair`), and that every other job only loads keys of `/ci`.
- Set the identity's **Access Token TTL** low (minutes: a job lasts at most half an hour and signs in again for every
  key it loads) and, if your Infisical version offers it, a small **Number of Uses Limit**; a Client Secret in a GitHub
  environment is a bearer secret for anyone who ever passes the branch rule above. Create a Client Secret for the
  identity, put the Client ID and the Client Secret in the two GitHub secrets, and rotate the Client Secret on a
  schedule (section 5.2). Infisical's OIDC authentication for GitHub would replace the long-lived Client Secret
  (section 9). The Secret Syncs use Infisical's own connection to Vercel, not this identity.

**Vercel dashboard**, for each of the two projects:

1. Settings, Build and Deployment, **Root Directory**: `app` for the App project, `dispatcher` for the Dispatcher
   project, with **Include source files outside of the Root Directory in the Build Step** switched on for both (the
   workspace keeps the packages at the repository root, section 2). **Install Command**: leave the override off, the
   `installCommand` of the project's `vercel.json` applies. **Framework Preset**: Next.js for the App, Hono for the Dispatcher. Node.js Version 24.x. Name the projects
   as you like; no name appears in the repository.
2. **Git auto-deploy off.** `app/vercel.json` and `dispatcher/vercel.json` carry `"git": { "deploymentEnabled": false }`,
   which stops Vercel from building a push by itself. Also check Settings, Git: either disconnect the repository, or
   leave it connected for the display of the commit and keep that setting. A deployment is made by the workflow only.
3. Settings, Deployment Protection: leave *Standard Protection* on (it protects every address except the production
   domains) and switch on **Protection Bypass for Automation**. Copy that project's secret into the matching key of `/ci`
   (`VERCEL_APP_AUTOMATION_BYPASS_SECRET`, `VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET`). The App's production domain
   must stay reachable without a login (section 2).
4. Settings, General: copy the **Project ID** into `/ci` (`VERCEL_APP_PROJECT_ID`, `VERCEL_DISPATCHER_PROJECT_ID`); the
   team's id is in the team's Settings (`VERCEL_TEAM_ID`).
5. Account settings, Tokens: create the access token for `/ci` `VERCEL_TOKEN` (section 3.4).
6. Settings, Environment Variables: leave them to the Secret Sync.
7. **Function region.** `app/vercel.json` and `dispatcher/vercel.json` say `"regions": ["fra1"]`, which is what the
   deployments get whatever the dashboard's *Function Region* setting says (the file wins). Set the dashboard
   setting to `fra1` too, so that the two do not disagree: the Sandbox VMs and the golden snapshots are in `fra1` and
   there is no failover region (section 8).

**If the repository moves to another owner** (a transfer to an organization, a rename). The repository, its Actions
secrets and its environments move with it, and GitHub redirects the old address, but nothing in the pipeline follows
by itself:

- In the repository: every job that deploys, rolls back, snapshots or runs the nightly is guarded by
  `github.repository == '<owner>/<name>'`. A guard that still names the old owner **skips the job without an error**, so
  the next push to `main` deploys nothing. Change the guards in `.github/workflows/` and `REPOSITORY` in
  `app/src/ci/workflow-support.ts`; `app/src/ci/repository-identity.test.ts` fails for each place that was missed,
  among them the `$id` of the schemas in `contracts/` and the links in the community files.
- Outside it, nothing in the pipeline names the owner: the Infisical identity signs in with Universal Auth (a Client
  ID and Secret, no claim of the GitHub token is checked), Vercel and the Sandbox use the Vercel project's own OIDC token,
  the Vercel projects deploy by the CLI and have their Git auto-deploy off, and no image is published. What can still
  point at the old address is the Git connection in step 2 of the Vercel dashboard list (reconnect it if you keep it
  for the display of the commit), the **branch ruleset** and the **environment `production` rule** of the repository
  (check both after the move, as above), and the GitHub App: install it on the new owner, because an installation
  belongs to the account that holds the repositories.


## 3. Environment variables

Set them in Infisical, environment `prod`: the App's in the folder `/app`, the Dispatcher's in `/dispatcher`
(section 2.1); the Secret Syncs write them to the **Production** environment of the two Vercel projects. A change
applies only to deployments made after it: run the *Deploy production* workflow after every change. "Secret" means:
keep it in Infisical only (Vercel stores a synced secret as *Sensitive*, if the sync is set up so) and never write it in
a file, a log or an issue. Placeholders for every variable are in `.env.example` (App) and `dispatcher/.env.example`
(Dispatcher).

### Generating the secrets

Every secret below is random and **different from every other secret** (the App refuses a signing secret that equals
another credential of the App, the Dispatcher one that equals its `RUNNER_TOKEN`). Generate each one into a shell
variable and hand it straight to its destination, so that the value is never typed into a command line, never printed
and never in the shell history:

```sh
# a 64 character secret: RUNNER_TOKEN, CRON_SECRET (one per project), RUNNER_WEBHOOK_SECRET, OPERATOR_API_TOKEN
SECRET=$(openssl rand -hex 32)
printf '%s\n' "$SECRET"       # shown once, on the terminal only: paste it into the value field of Infisical
unset SECRET
# APP_SECRET, a different call:
SECRET=$(openssl rand -base64 32); printf '%s\n' "$SECRET"; unset SECRET
```

The value goes into the Infisical dashboard (the key in `/app`, `/dispatcher` or `/ci`, environment `prod`) and nowhere
else. `printf` is a shell built-in with the value in a variable, so the value is not in the history or the process list;
`echo "<value>" | ...` would put it in the history. Keep a copy of `APP_SECRET`, and only that one, in your password
manager: it is the one value that cannot be rotated (section 5.2). A value shared by both projects is generated once
and referenced (section 2.1). Rules the code enforces for
every secret: at least 32 characters, no white space or control characters.

### 3.1 The App project

| Variable | Required | Secret | Meaning |
|---|---|---|---|
| `APP_SECRET` | yes | **yes** | The master key: signs sessions and encrypts the credentials in the database. At least 32 characters. Never reused between environments. Changing it signs everybody out and makes stored credentials unreadable. |
| `BETTER_AUTH_URL` | yes, **before the first deployment** | no | The public https address of the App, no path (its production domain, so add the domain to the project first). Without it the App refuses to start (`AUTH_CONFIG_INVALID`). GitHub sends people back to `<this>/api/auth/callback/github`. |
| `DATABASE_URL` | yes | **yes** | The **app role's** Postgres URL (`postgres://` or `postgresql://`). **A direct or session-mode connection, never a transaction pooler** (section 2). |
| `DATABASE_POOL_MAX` | optional | no | Connections per function instance, 1 to 20, default 3. Every instance has its own pool: keep it small. |
| `PRODUCT_ID` | optional | no | Which product this deployment is: `code-review-com` (default) or `factory`. Unknown values stop the start (`DEPLOY_CONFIG_INVALID`, naming the variable). `/api/health` reports it. It also decides the brand the app speaks under: its name in pages and mails, the title, the name of the check run and of the GitHub App (the codename `Factory` until the brand is chosen). It is read when the server renders or builds, so each Vercel project, with its own variables, has its own. |
| `PRODUCT_CAPABILITIES` | optional | no | Comma list that narrows what the product has: `review`, `dynamic-review` (needs `review`), `billing`, `implementer` (needs `dynamic-review`; `factory` only, see section 5.8). Unset: the product's default (code-review.com: `review`, `dynamic-review` and `billing`, so the live deployment sets nothing; `factory`: `review,dynamic-review`, so an unset value never turns `implementer` on). A capability that is not in the set has no route, no navigation entry, no API and no background work: its paths answer as paths that do not exist. A value the product does not allow stops the start (`implementer` on code-review.com included). Read at build and at start, so change it with a new deployment. `/api/health` answers `{"status":"ok","product":...,"capabilities":[...]}`. Details: `app/src/capabilities/README.md`. |
| `RUNNER_TOKEN` | yes | **yes** | The **dispatcher credential**: what the Dispatcher claims jobs with. At least 32 characters. **Same value as the Dispatcher's `RUNNER_TOKEN`.** There is one token, no overlap while rotating (section 5.2). |
| `CRON_SECRET` | yes | **yes** | Vercel sends it as `Authorization: Bearer ...` to both cron routes. At least 32 characters. Without it every cron call is refused (`401`): the safety net of section 5.7 does not run (stuck jobs, lapsed leases of a quiet system, `dispatch_unavailable`, notices that failed). Vercel adds the header by itself once the variable exists. |
| `RUNNER_DISPATCH` | yes, **in step 5** | no | `webhook`. Leave it unset (`poll`) until step 5: in poll mode nothing wakes a Dispatcher. |
| `RUNNER_WEBHOOK_URL` | with `webhook` | no | The Dispatcher's wake-up endpoint: `https://<dispatcher production domain>/dispatch`. https, no credentials in it. |
| `RUNNER_WEBHOOK_SECRET` | with `webhook` | **yes** | The key the App signs the wake-up call with. At least 32 characters. **Same value as the Dispatcher's `DISPATCHER_SIGNING_SECRET`.** Different from every other secret. |
| `RUNNER_WEBHOOK_KEY_ID` | optional | no | The key's name, `a-z 0-9 _ -`, at most 32 characters, default `k1`. **Same value as the Dispatcher's `DISPATCHER_SIGNING_KEY_ID`.** Change it on every rotation. |
| `RUNNER_WEBHOOK_SECRET_PREVIOUS`, `RUNNER_WEBHOOK_KEY_ID_PREVIOUS` | optional | **yes** (secret) | The key being replaced, both or neither. Only checked and carried; the App signs with the current key only. |
| `RUNNER_WEBHOOK_BYPASS_TOKEN` | only if the Dispatcher is protected | **yes** | The project's Protection Bypass for Automation secret, sent as `x-vercel-protection-bypass`. Different from the signing secret. |
| `RUNNER_DISPATCH_MAX_RUNNING` | **set it** | no | The pool cap the App keeps to when it sends wake-ups for jobs that waited for a slot, 1 to 1000. **Must equal the Dispatcher's `DISPATCHER_MAX_RUNNING`.** Unset, the App still works (the claim enforces the Dispatcher's cap) but a freed slot wakes one waiting job at a time and the sweep wakes the Dispatcher for jobs it cannot take. |
| `RUNNER_DISPATCH_GIVE_UP_SECONDS` | optional | no | A job that waited this long without a claim fails with `dispatch_unavailable`, when the next sweep looks at it (**up to 2 hours later than the time itself**). 60 to 604800, default **3600** in webhook mode, off in poll mode, `0` turns it off. It is also the longest a job may queue while the pool is full: set it above the queue you accept. |
| `OPERATOR_API_TOKEN` | optional | **yes** | Switches on the operator API (`/api/operator/v1`: workspaces, entitlements and limits, usage). Unset, the API does not exist (404). At least 32 characters, different from `RUNNER_TOKEN` and `APP_SECRET`. |
| `LLM_MODEL`, `LLM_MAX_TOKENS` | optional | no | The instance's model and context window. `LLM_MODEL` is the default a review setting overrides; `LLM_MAX_TOKENS` is no setting, only a fallback window. A **`managed` workspace** (section 3.5) does not use them: the models of its reviews are the catalog entries its projects select (else the instance default entry of the kind; section 3.5), and what its reviews read of a pull request is cut to that entry's window. `LLM_MODEL` is an OpenRouter name, default `anthropic/claude-haiku-5.5`; a model for Dynamic jobs must be tool-capable (`dynamic-review.md`, "The model"). The LLM key is **not** an environment variable. |
| `NATIVE_OPENCODE_PROVIDERS` | optional | no | `1`, `true` or `on` runs Dynamic reviews on OpenRouter and Anthropic through the native OpenCode path (#578, design #544): the claim carries the model entry and the price of the catalog. Default off (unset). Needs catalog models that are enabled with a confirmed price for the operator's key (admin catalog), and Worker images and runners that read `dynamic.modelEntry`. Read at every claim, so removing it takes effect on the next claim. |
| `MODELS_DEV_URL`, `MODELS_DEV_FETCH` | optional | no | The model catalog (`app/src/models-dev/README.md`): the sweep reads the public models.dev catalog into the database once a day (when the last read is more than 23 hours old), so a new model needs no release. `MODELS_DEV_URL` names a mirror instead; `MODELS_DEV_FETCH=off` switches the read off (the catalog stays empty and nothing else changes). A failed or implausible read keeps the catalog it has; there is no cron of its own. |

Not set in the project, on purpose:

- `DATABASE_URL_MIGRATE`: the direct URL of the **migrate role**. Only `pnpm migrate` and `pnpm setup-code` read it:
  the deployment workflow (from Infisical `/ci`) and you, from the shell you run them in. The App never reads it; it
  is not in `/app` and not in a function.
- `VERCEL`: set by the platform.
- `NODE_ENV`, `NEXT_RUNTIME`: set by Next.js.
- `NEXT_PUBLIC_PRODUCT_ID`: the build copies `PRODUCT_ID` into it (`app/next.config.ts`) for the page that shows a crash in the root
  layout. Set `PRODUCT_ID` only; the start logs a warning when the two differ.
- `BETTER_AUTH_SECRET`: the deprecated name of `APP_SECRET`; a new instance never sets it.
- The `GITHUB_*`, `ALLOWED_GITHUB_*`, `LLM_PROVIDER` and `LLM_API_KEY` variables: older ways to configure GitHub and the
  model from the environment. A hosted instance never sets them (the admin portal does).

### 3.2 The Dispatcher project

A refusal at start names the variable, never its value (`ConfigError`: `required`, `invalid`, `too_short`,
`not_distinct`, `duplicate`).

| Variable | Required | Secret | Meaning |
|---|---|---|---|
| `RUNNER_API_URL` | yes | no | The App's public URL, `https://<app production domain>` (no path, query or credentials). Also the address the **Worker** inside the VM calls, so it must be reachable from the internet. |
| `RUNNER_TOKEN` | yes | **yes** | The dispatcher credential. **Same value as the App's `RUNNER_TOKEN`** and as `/ci` `RUNNER_TOKEN` (the canary's). |
| `DISPATCHER_MAX_RUNNING` | yes | no | The pool cap, 1 to 1000: how many launches may be in progress, and the cap the App enforces atomically at the claim. **Must equal the App's `RUNNER_DISPATCH_MAX_RUNNING`.** Each running job is one VM. |
| `DISPATCHER_SIGNING_KEY_ID` | yes | no | The key id the App signs with. **Same as the App's `RUNNER_WEBHOOK_KEY_ID`** (`k1` if that is unset). |
| `DISPATCHER_SIGNING_SECRET` | yes | **yes** | **Same value as the App's `RUNNER_WEBHOOK_SECRET`.** At least 32 characters, different from `RUNNER_TOKEN`. |
| `DISPATCHER_SIGNING_KEY_ID_PREVIOUS`, `DISPATCHER_SIGNING_SECRET_PREVIOUS` | optional | **yes** (secret) | The previous key, accepted while keys rotate. Both or neither. |
| `DISPATCHER_APPS` | optional | no | More than one App (#730): further Apps this Dispatcher serves besides `reviewer`, the App of the variables above. A JSON array on one line, at most 16 entries, each `{"id", "url", "kinds", "keyId", "maxRunning", "poolId"?}`: `id` is `a-z`, `0-9` and `-` (at most 24 characters, not `reviewer`), `url` the App's address (as `RUNNER_API_URL`), `kinds` any of `diff`, `dynamic` and `implementer` (the job kinds that App may submit and be given: nothing else, whatever the App sends; `implementer`, #759, is for an App of this array only, `reviewer` never has it, and **an older Dispatcher refuses the value at start, so set it only after the Dispatcher with #759 is live**), `keyId` its signing key id, `maxRunning` the pool cap of that App (1 to 1000, **equal to that App's `RUNNER_DISPATCH_MAX_RUNNING`**), `poolId` what is sent as `X-Runner-Id` (default: the id). Per App the Dispatcher reads `DISPATCHER_APP_<ID>_TOKEN` and `DISPATCHER_APP_<ID>_SIGNING_SECRET` (required, secret, at least 32 characters) and optionally `DISPATCHER_APP_<ID>_SIGNING_SECRET_PREVIOUS` with `DISPATCHER_APP_<ID>_SIGNING_SECRET_PREVIOUS_KEY_ID`; `<ID>` is the id in upper case with `-` as `_`. Every secret is different from every other, a key id or an address is used once, and a refusal names `DISPATCHER_APPS` and the App. Unset: only `reviewer` exists, exactly as before. Details: `docs/dispatcher.md`, "More than one App". |
| `DISPATCHER_OPERATOR_TOKEN` | optional | **yes** | The credential of `POST /probe` (the deploy canary) and `POST /apps/check`. At least 32 characters, different from every other secret. **Unset, `POST /probe` is still opened by `RUNNER_TOKEN`** (the rollout fallback, only while `reviewer` is the only App) and `POST /apps/check` refuses everyone. **Required with `DISPATCHER_APPS`**: the Dispatcher does not start without it. Set, no App's own credential opens either route: an App must not be able to start canary VMs, which cost money. Put it in `/ci` and `/dispatcher` together (`dispatcher/README.md`, "Rollout of the operator token"): the canary uses it when `/ci` has it. |
| `SANDBOX_SNAPSHOT_ID` | yes | no | The golden snapshot: `snapshotId` of its record. **The deployment pipeline sets it** (section 5.1): the Dispatcher deployment of every run carries the pair it uses as its own run-time variables, and the pipeline writes the pair to Infisical after the promotion. **Unset, the Dispatcher has no Launcher and claims nothing** (every wake-up is answered `200 ignored` with `not_capable`). Set with `SANDBOX_IMAGE_DIGEST` or not at all. |
| `SANDBOX_IMAGE_DIGEST` | with the snapshot | no | The Worker image id in that snapshot (`imageDigest` of the same record), `sha256:` and 64 hex characters. The Launcher refuses a VM whose image has another id. The pipeline sets the two together, and writes `SANDBOX_SNAPSHOT_COMMIT` (the commit the snapshot was built from; the Dispatcher does not read it) next to them. |
| `DISPATCHER_ENGINES` | optional | no | `pr-agent`, `opencode` or both (default both). `implementer` is added to the default when an App of `DISPATCHER_APPS` names the kind, and naming it here never gives it to `reviewer` (#759). The Launcher advertises `implementer` when it is in this list, and then `POST /probe` requires the canary report to name it (the canary VM runs a second probe in the Implementer's profile, #765); without it in the list nothing changes. `pr-agent` for a Diff-only deployment: it has no `POST /probe` and no canary VM. A Dynamic job is accepted whenever `opencode` is in this list and the snapshot pair is set: the Dispatcher runs no capability probe on a dispatch (section 8). |
| `DISPATCHER_JOB_TIMEOUT_SECONDS` | optional | no | How long a Worker of Diff or Dynamic may live, 60 to 21600, default **1200**. The Implementer (#759) has its own timeout in `DISPATCHER_WORKER_CONFIG` (default 3600). The function has to outlive only the launch (at most 300 s): the Dispatcher does not supervise the Worker after the hand-over (#487), so the function limit no longer bounds the job; the VM's own timeout (this plus `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`) and the reaper (section 5.5) do. |
| `DISPATCHER_WORKER_CONFIG` | optional | no | JSON `{"diff": {...}, "dynamic": {...}, "implementer": {...}}` (`implementer` also takes `timeoutSeconds`, 60 to 21600, default 3600): the VM size (`launcher.vcpus`) and the container memory (`container.memory.limit` / `reservation`) per Worker kind. Section 6. A wrong value fails when the function initialises (the variable is named in the log), not at the first job. |
| `DISPATCHER_POOL_ID` | optional | no | Sent as `X-Runner-Id`; the App counts the running jobs of the pool by it. Default `dispatcher`. |
| `SANDBOX_HANDOVER_SECONDS` | optional | no | How long the container must run before the Worker counts as having taken over, 1 to 120, default 20. |
| `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS` | optional | no | Seconds added to the job's timeout for the VM's own timeout, the backstop that ends a VM nobody stopped. At most 3600, at least 180 and 150 above the hand-over time, default 300. |
| `DISPATCHER_PROBE_REUSE_SECONDS` | optional | no | A forced probe (`POST /probe`, the deploy canary) within this time of the last answer is served from it, 0 to 600, default 60; `0` runs every one. |
| `DISPATCHER_PROBE_TIMEOUT_SECONDS` | optional | no | How long a probe (`POST /probe`) may take, canary VM included, 30 to 600, default 150. |
| `RUNNER_DYNAMIC_CAPABILITIES` | optional | no | Narrows the model's capabilities for Dynamic jobs and the canary: a JSON object on one line, at most 4096 characters. Normally unset (`docs/dynamic-review.md`, "The model"). Read only when `DISPATCHER_ENGINES` includes `opencode`. |
| `RUNNER_DYNAMIC_MAX_COST_USD` | optional | no | Only a fallback since #689: the maximum cost per review is set in the admin portal (General, Limits) and sent with every job. The most one Dynamic run from an app that sends none may cost, a plain positive decimal such as `2.5`. Unset: the Worker's default. |
| `CRON_SECRET` | yes, with the snapshot | **yes** | The secret Vercel's cron sends to the reaper route (`/api/cron/reap-sandboxes`, every 5 minutes) as `Authorization: Bearer ...`. At least 32 characters, different from `RUNNER_TOKEN` and every signing secret, and **a value of its own: do not reuse the App project's `CRON_SECRET`**. The route exists only when `SANDBOX_SNAPSHOT_ID` is set. Unset, every caller gets `401` and the log warns `reaper_cron_secret_missing`: nothing stops a VM that outlived its job (section 5.5). A malformed value (short, or equal to another secret) stops the start when the snapshot is set; without the snapshot it is ignored with a warning. |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | all three or none | **yes** (the token) | Platform access by access token. **None: the Dispatcher uses the project's own OIDC token**, which Vercel provides inside a function and which needs nothing to rotate. Prefer that. |

**Retired:** `DISPATCHER_PROBE_TTL_SECONDS` (#479). The Dispatcher no longer keeps a probe answer, so nothing has a time to
live. Delete it; a deployment that still has it starts, ignores it and logs the warning `deprecated_setting` once per
instance. Support for it is removed in a later release.

Not set by you: `VERCEL_OIDC_TOKEN` (the platform provides it). Only the Node entry (`pnpm start`, not used on
Vercel) reads `DISPATCHER_SHUTDOWN_GRACE_SECONDS` and `PORT`.

### 3.3 What must match between the two projects

| App | Dispatcher | Notes |
|---|---|---|
| `RUNNER_TOKEN` | `RUNNER_TOKEN` (and `RUNNER_TOKEN` in `/ci`) | One credential, three keys, one stored value: `/ci` holds it, the other two are `${prod.ci.RUNNER_TOKEN}` (section 2.1) |
| `RUNNER_WEBHOOK_SECRET` | `DISPATCHER_SIGNING_SECRET` | The signing key; the Dispatcher's is `${prod.app.RUNNER_WEBHOOK_SECRET}` |
| `RUNNER_WEBHOOK_KEY_ID` (default `k1`) | `DISPATCHER_SIGNING_KEY_ID` | Its name; `${prod.app.RUNNER_WEBHOOK_KEY_ID}` |
| `RUNNER_DISPATCH_MAX_RUNNING` | `DISPATCHER_MAX_RUNNING` | The pool cap, both must be set; the Dispatcher's is `${prod.app.RUNNER_DISPATCH_MAX_RUNNING}` |
| `RUNNER_WEBHOOK_URL` = `https://<dispatcher>/dispatch` | (the Dispatcher's own domain) | |
| `BETTER_AUTH_URL` (the App's domain) | `RUNNER_API_URL` | The same address; the Dispatcher's is `${prod.app.BETTER_AUTH_URL}`. The Dispatcher hands it to every Worker as the App URL |
| `RUNNER_WEBHOOK_BYPASS_TOKEN` | the Dispatcher project's bypass secret | Only with Deployment Protection; the App's is `${prod.ci.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET}` |
| `CRON_SECRET` | `CRON_SECRET` | **Not** the same value: each project has its own, because each cron route must open with its own secret only |

A Dispatcher that serves a further App (`DISPATCHER_APPS`, section 3.2) holds that App's `RUNNER_TOKEN` as `DISPATCHER_APP_<ID>_TOKEN`,
its `RUNNER_WEBHOOK_SECRET` as `DISPATCHER_APP_<ID>_SIGNING_SECRET`, its `RUNNER_WEBHOOK_KEY_ID` as `keyId`, its
`RUNNER_DISPATCH_MAX_RUNNING` as `maxRunning` and its `BETTER_AUTH_URL` as `url`; the table above is the `reviewer` app.

### 3.4 The GitHub side

| Where | Name | Meaning |
|---|---|---|
| environment `production` (secrets) | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_DOMAIN`, `INFISICAL_PROJECT_SLUG` | The sign-in to Infisical (section 2.1). Secrets, not variables |
| Infisical `prod` `/ci` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_APP_PROJECT_ID`, `VERCEL_DISPATCHER_PROJECT_ID`, the two bypass secrets, `DATABASE_URL_MIGRATE`, `RUNNER_TOKEN` | What the workflows need (section 2.1). The golden snapshot build reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_DISPATCHER_PROJECT_ID`; the Dispatcher's project is the one the snapshot has to be in |
| Infisical `prod` `/dispatcher` | `SANDBOX_SNAPSHOT_ID`, `SANDBOX_IMAGE_DIGEST`, `SANDBOX_SNAPSHOT_COMMIT` | Written by the pipeline after a promotion, with the same machine identity (section 2.1 has its role). Not secrets |
| retired | the environments `hosted-snapshot` and `hosted-canary`, the variables `DISPATCHER_CANARY_HOSTS` and `GOLDEN_SNAPSHOT_ENABLED` | Replaced by the above. The canary no longer keeps a list of hosts: the Vercel API says whether a staged host is the Dispatcher project's |

**What the build sees.** `vercel build` (which runs `next build`, the bundler and every plugin of the two projects) runs
without the Vercel token and after the dependencies were installed, so neither the token nor the install scripts meet.
It does see the **production runtime variables**: `vercel pull` writes them to `.vercel/.env.production.local`, and the
build loads them (the App's `DATABASE_URL` and `APP_SECRET`, the Dispatcher's `RUNNER_TOKEN` and signing secret, every
non-Sensitive variable the pull returns). Treat the build code of both projects, and every dependency in their
lockfiles, as trusted with those values; the lockfiles and the reviews of changes to them are what protects them.

**The Dispatcher is type-checked by the builder, not by `tsc`.** The Hono builder of the CLI checks the types through its
own language service, which finds packages the way `node` does and does not follow pnpm's symlinks the way `tsc` does.
`undici-types` (imported by `@types/node` for the global `Response`) is therefore a direct devDependency of the
Dispatcher, at the version `@types/node` uses; without it `vercel build` fails on every use of `Response` while
`make typecheck` is green (#412). The CI job "Dispatcher: static & tests" runs the same `vercel build` offline with a stub
project file, so such a difference fails in a pull request and not in a release.

**The Dispatcher's function is emitted file by file, and `vercel build` succeeding does not mean it starts.** The Hono
builder takes as the entry the first of `app`, `index` and `server` (project root, then `src/`) whose text imports
`hono`, and transpiles the files it reaches one by one, without bundling or rewriting imports. Two things followed
(#416): `src/app.ts` imported Hono and exported no app, so it was taken as the entry (renamed `src/dispatcher-app.ts`;
`src/index.ts` imports the `Hono` type, which is what makes it qualify), and the sources import each other as `./x.ts`,
which the emit kept while only `x.js` was in the function (`rewriteRelativeImportExtensions` in `tsconfig.json` makes the
emit write `.js`). The first request of the deployment failed with `ERR_MODULE_NOT_FOUND` and the canary reported
`deployment_not_ready`. The CI job "Dispatcher: static & tests" therefore also runs `dispatcher/scripts/check-built-function.mjs`
after the build: every relative import of the emitted files must name a file in the function, and the handler of
`.vc-config.json` must load, with placeholder settings and no network, and answer `GET /health` with 200.

**A Vercel access token acts for its owner in the whole team (or account) it is created for, not for one project**, whatever
the project ids in `/ci` say: create it from a dedicated account that has the lowest team role that can deploy, promote
and create Sandboxes and snapshots, give it an expiry if the dashboard offers one (and a calendar reminder to rotate it
before that day), and if the dashboard offers a token limited to the one project, use that. The token is the most
valuable key in `/ci`: it can deploy to production, which is why the environment `production` is restricted to `main`.

### 3.5 LLM keys: a workspace's own, or the operator's

- **`own` (the default).** Every workspace enters its own OpenRouter key (Settings, LLM); it is stored
  encrypted with `APP_SECRET`. A workspace without one fails its runs with `llm_not_configured`.
- **`managed`.** The operator's own key serves the workspaces whose entitlements say `keyMode: "managed"`. The
  instance admin saves that key in the admin portal under **LLM key** (`/admin/llm`): OpenRouter, write-only, encrypted
  in the database with `APP_SECRET` (so whoever holds the database and `APP_SECRET` can decrypt it), never shown again,
  never in a log, a Runs page or an answer of the operator API, and never given to the Dispatcher: the Worker receives
  it from the App when it fetches its job. It is **not** an environment variable and **not** a call of the operator API.
- **Setting a workspace to `managed`** is an entitlement, set with the operator API (`OPERATOR_API_TOKEN` must be set):
  `PUT /api/operator/v1/workspaces/{id}/entitlements` with `"keyMode": "managed"`, the whole entitlements body
  (`contracts/operator-api.v1.json`). A cost limit (`managedCostLimitMicroUsd`) needs `managed` and is a soft cap
  (section 8). The change takes effect at the next claim; a running job is not touched.
- **Upgrade every App instance first.** An instance of a release before #276 does not know the key mode: it would run a
  managed workspace's jobs on the workspace's own key and model and outside the cost limit. Roll the new App out
  completely before the first workspace is set to `managed`.
- **The cost limit of runs on a workspace's own key** (`ownKeyCostLimitMicroUsd`, #361) is part of the same body, and a
  write must state it. That makes the rollout a cutover: a `PUT` without the key is refused (`422 limits_invalid`) by an
  instance that knows it, and a `PUT` with it is refused by one that does not. **Upgrade every App instance first**
  (an old instance reads the limit and ignores it), **then** switch the writer (your billing service) to send
  `ownKeyCostLimitMicroUsd` in every body, `null` where there is no limit. A `422` during the rollout window means the
  writer reached an instance of the other release: treat it as retry-later, not as a refused plan.
- **The model is yours, through the catalog,** while a job runs on the operator's key (#432): the project selects an entry
  of your model catalog (a name members see; the provider and model behind it only you see), else the instance default
  entry of the kind (Diff or Dynamic) is used. At claim the resolver takes the entry's model and your key of the entry's
  provider; a Dynamic model must support tool calls (checked when the entry is released). `LLM_MODEL` and
  `LLM_MAX_TOKENS` are not used, and the workspace's `model` and Dynamic model review settings have no effect (they apply
  again if the workspace goes back to `own`); their routes refuse a model field with `MODEL_MANAGED_BY_INSTANCE`. An entry
  that is missing, retired, of the wrong kind or outside the plan's `modelAccess`, or an entry of a provider the runner
  did not advertise, fails the job with `managed_model_unavailable`; it never moves to another entry or to `LLM_MODEL`.
  The token budget of a job (no setting names it, #689) is 100,000 tokens, cut to the context window of the entry's model when the provider states a smaller one (the last
  window read when it cannot be asked: it is never sent larger). The model ids are visible to you
  and the runner only: not to a workspace, not in a result (`[model]` stands where a result repeated one), a record or a
  log. The quality tiers of #280 are gone (#434): the migration turned the models you had configured for Low, Medium and High into
  released catalog entries of the same names and made the Medium ones the defaults, and `PUT /api/operator/v1/model-tiers` is
  answered `404`. The old setting stays in the database, unread, for one release. Create and release the entries and set the defaults before you set a workspace to
  `managed`, and roll the new App out completely first (`app/src/model-catalog/README.md`).
  The workspace's Settings, LLM page shows a note instead of a key form.
- **No usable operator key** (none saved, or one that cannot be decrypted, for example after a changed `APP_SECRET`):
  every job of a managed workspace fails with **`llm_not_configured`**, and the log names `operator_key_missing` or
  `operator_key_unreadable`. Save the key in the admin portal and the next job runs. Save it **before** you set the
  first workspace to `managed`.

### 3.6 The billing webhook (only when billing is on)

Billing is off by default and a deployment that never turns it on needs nothing here: `POST /api/billing/webhook` answers
the 404 of a path that does not exist (#497, ADR 0006). What billing is, the Stripe account steps, the rates, the go-live order and
the day-to-day work are in [`billing.md`](billing.md); this section is only what the deployment must provide. When billing is on and the active adapter has a webhook (not
`manual`, which has none), the payment provider calls this route, and three things must hold:

- **Reachable without a login, from the internet.** The route is public (the signature is the authentication). Do not put
  Deployment Protection, a firewall rule or a WAF challenge in front of `/api/billing/webhook`; if the App project is
  protected, allow the provider's sources for this path. A refused delivery is retried by the provider (Stripe: for up to three days).
- **It must answer within a few seconds.** The handler makes no outbound call: it reads at most 256 KiB, checks the
  signature, applies the event in one database transaction and answers `200`. A cold function plus the database is the only
  cost.
- **A bad signature is `401` with an empty body**, a body the adapter cannot read `400`, a failure `500` (the provider
  redelivers). A signed event that is no event, and a payment that could not be credited (an unknown intent, an amount above what was asked), are answered `200` and not retried: watch the error log for `billing_webhook_event_invalid` and `billing_webhook_needs_review outcome=...`, and review the open rows on the admin page **Payment reviews** (`/admin/billing/reviews`, [`billing.md`](billing.md#payment-reviews)). The logs name a code (`billing_webhook_rejected code=signature_invalid`) and never the body.

**Stripe (#502).** The route is the one webhook endpoint of the instance; you do not create it by hand. In the admin portal, menu
**Billing**, "Create webhook endpoint" registers `https://<the App's production domain>/api/billing/webhook` at Stripe (the
address is the configured `BETTER_AUTH_URL`, never a request header, and must be reachable from the internet over https) with
the API version the App's calls use and these events, and stores the signing secret it gets back (an endpoint of the other
environment than the API key's is refused):

| Event | What the App does |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | Credits the **net** amount of the top-up (the amount without VAT), once per payment, to the workspace of **our own intent row**; a delayed method that is not paid yet is waited for. |
| `checkout.session.async_payment_failed`, `checkout.session.expired` | Marks the intent `failed` or `expired`. A payment that still arrives pays it. |
| `refund.created`, `refund.updated`, `refund.failed` | Debits the share of the credit that the refund takes back (one event per refund), or reverses that debit once when the refund fails or is canceled. |
| `charge.dispute.created`, `charge.dispute.funds_withdrawn` | Debits the disputed share (Stripe takes the money when a dispute opens). |
| `charge.dispute.closed`, `charge.dispute.funds_reinstated` | A lost dispute stays debited; a won one is reversed once. |

Anything else Stripe sends (for example `payment_intent.succeeded`, `charge.refunded` or `invoice.paid`) is answered `200` and
recorded `ignored_type`: add no further event types to the endpoint. The signing secret is checked over the exact bytes of the
body, within five minutes of the signature's time, and the same event id is never applied twice; make sure the clock of the
servers is right. Nothing may rewrite the body in front of the route (a proxy that re-encodes JSON breaks every signature).
An event of the other environment than the API key's (a test event at a live instance) is `400`. Stripe retries a `5xx` for
up to three days (in the sandbox three times): the credit is idempotent per payment, so a retry never credits twice.

**Check payment.** If a webhook is ever lost, an Owner or Admin of the workspace can press "Check payment" on a top-up
(`POST /api/w/<workspace>/billing/top-ups/<id>/check`): the App asks Stripe for that Checkout Session, once, in that request, and
applies the answer exactly as the webhook would have. A second press, or the webhook arriving late, changes nothing.

**Outbound from the App when billing runs on Stripe (#501).** A top-up is the one place the App calls out: the App function
reaches `api.stripe.com` over TLS (port 443; a few calls per top-up, 10 seconds at most per request, no redirect followed). On
Vercel nothing needs to be opened; on a network with an egress allow list add `api.stripe.com`. The credentials are the Stripe
key and webhook secret of the admin portal's Billing page, never an environment variable. Nothing is sent while billing is off
or when the active adapter is `manual`. The buyer's business name, address and VAT ID go to Stripe and nowhere else.

**Before billing goes on in production.** The Dispatcher must be of a release that reports its VMs (`vm_lifecycle`), or the admin page
refuses the switch. Put a rate limit on `POST /api/billing/webhook` at the Vercel firewall (a few dozen requests a minute per address
is plenty). Do not switch billing off while top-ups are open ([`billing.md`](billing.md#9-switching-off-and-what-to-know-first)).


## 4. First deployment, step by step

Do the steps in this order (migrate, variables, first deployment, setup code, webhook, smoke test); each one has a check.
Nothing is lost if you stop between steps.

Do section 2.1 first: the GitHub environment `production`, Infisical with its three folders, the two Secret Syncs and the
machine identity, and the two Vercel projects (with their production domains). The first deployment is the same
workflow as every later one: there is no manual deployment, and no manual snapshot.

### Step 1. Migrate the database

```sh
read -rs -p 'cr_migrate password: ' MIGRATE_PW; echo
export DATABASE_URL_MIGRATE="postgres://cr_migrate:${MIGRATE_PW}@<direct host>:5432/code_reviewer?sslmode=require"
unset MIGRATE_PW
pnpm --dir app migrate
```

(`read -rs` keeps the password out of the history and the process list. The URL stays in this shell only; close the
shell when you are done with steps 1 to 3.)

`pnpm migrate` takes the advisory lock `code-reviewer:migrate`, applies every pending migration in one transaction
and exits 0 (`[migrate] applied N migration(s): ...` or `[migrate] the schema is up to date, nothing to apply.`) or
exits 1 with one line and a code (a failed batch is rolled back). Two runs take turns. The URL is not printed.
**Check:** run it again; it must say that nothing is left to apply.

Every later deployment, and the first one of step 3, migrates first: the *Deploy production* workflow runs `pnpm --dir app migrate` before it stages
anything, with `DATABASE_URL_MIGRATE` from Infisical `/ci`, and a failed migration means no deployment. The App never
migrates by itself. This manual run is for the first time, and for the check of the roles above.

### Step 2. Put the variables into Infisical (still in poll mode)

1. Add the App's **production domain** to the App project first: `BETTER_AUTH_URL` must be that address, and the App
   refuses to start without it. The Dispatcher project needs its production domain too (step 5 uses it).
2. Put the variables of section 3.1 **except** the `RUNNER_DISPATCH` and `RUNNER_WEBHOOK_*` ones (poll mode is the
   default; webhook mode is step 5) into Infisical `prod` `/app`, including `BETTER_AUTH_URL` and `CRON_SECRET`, with the
   commands of "Generating the secrets". The database URL of the app role is built from a prompt and shown once on the
   terminal, to be pasted into `DATABASE_URL`; the migrate role's URL of step 1 goes into `/ci` as `DATABASE_URL_MIGRATE`:

   ```sh
   read -rs -p 'cr_app password: ' APP_PW; echo
   printf '%s\n' "postgres://cr_app:${APP_PW}@<host>:5432/code_reviewer?sslmode=require"
   unset APP_PW
   ```
3. Put the variables of section 3.2 into `/dispatcher`: `RUNNER_API_URL` (a reference to the App's `BETTER_AUTH_URL`,
   section 2.1), `RUNNER_TOKEN` (a reference to the one in `/ci`), `DISPATCHER_MAX_RUNNING` (start small, for example
   `2`), `DISPATCHER_SIGNING_KEY_ID` and `DISPATCHER_SIGNING_SECRET` (references to the App's `RUNNER_WEBHOOK_KEY_ID`, `k1`,
   and `RUNNER_WEBHOOK_SECRET`, which you create in `/app` now with the secret from "Generating the secrets"; the App
   ignores them until step 5, because `RUNNER_DISPATCH` is unset), `CRON_SECRET` (the reaper's, section 5.5), and
   optionally `DISPATCHER_ENGINES`, `DISPATCHER_WORKER_CONFIG` (section 6). Leave `VERCEL_TOKEN` and its siblings unset
   to use the project's OIDC token. **Leave the three `SANDBOX_SNAPSHOT_*` keys unset**: the first deployment builds the
   snapshot and writes them (a Dispatcher without a snapshot claims nothing, which is what you want until then).
4. Check that `/ci` holds the eight keys of section 2.1 and that both Secret Syncs show *synced*.

This guide is for a **new installation**. An installation that already has `SANDBOX_SNAPSHOT_ID` and
`SANDBOX_IMAGE_DIGEST` set by hand (the flow before the pipeline) and no `SANDBOX_SNAPSHOT_COMMIT` also works: the first
run sees an incomplete pair, builds a snapshot, and keeps the old one as the previous snapshot, which the live
Dispatcher deployment still runs, until the next run that rebuilds.

### Step 3. First deployment

Actions, *Deploy production*, *Run workflow* on `main` (or merge to `main`). With no snapshot pair the run builds the
golden snapshot (about two minutes plus the image build), then stages and checks and promotes everything in the order of
section 5.6. It takes a good deal longer than a normal release; the log of each job says what it is doing.

**Check:** every job is green; the `persist` and `cleanup` jobs ran (they write the pair to Infisical, and the three
`SANDBOX_SNAPSHOT_*` keys of `/dispatcher` now hold values). `https://<app>/api/health` answers `200 {"status":"ok"}`;
`503` with `SCHEMA_BEHIND` means the migration did not reach this database, `503` without a code that the database is not
reachable with `DATABASE_URL`. `https://<dispatcher>/health` answers `200 {"status":"ok"}`. The settings of the
Dispatcher are read when the function initialises, so a bad value shows as failing requests and a log line that names the
variable (`DISPATCHER_WORKER_CONFIG is invalid`, ...), not as a failed build; in the workflow that is a failed canary and
nothing is promoted. If you protect the production domain with Deployment Protection, every path answers the platform's
login page until the bypass header is sent: confirm
`curl -s -o /dev/null -w '%{http_code}' -H 'x-vercel-protection-bypass: <secret>' https://<dispatcher>/health`
prints `200` before step 5, or every wake-up waits half an hour (section 5.3).

Also check that the crons exist (the App's Cron Jobs settings list two, the Dispatcher's one) and that they are not
refused: the sweep (every 2 hours) shows `200` once `CRON_SECRET` is set (`401 CRON_UNAUTHORIZED` means the variable is
missing or not 32 characters), and so does the Dispatcher's reaper (every five minutes; `401` means its `CRON_SECRET` is
missing or malformed). **If the Dispatcher project is behind Deployment Protection, that the platform's cron gets past
it is not verified** (I could not confirm it from the platform's documentation): look at the first run, and if it is
refused, either switch protection off for the production domain (the Dispatcher checks a signature or a credential on
every route that does anything) or reap by hand (section 5.5).

**The canary.** The run called the *Dispatcher canary* workflow (`dispatcher-canary.yml`) on the staged Dispatcher, with
`engines` of `pr-agent,opencode` (the `canary_engines` input of *Deploy production*; `pr-agent` for a Diff-only
deployment). It signs in to Infisical, loads `RUNNER_TOKEN`, the bypass secret and the token, team and project id, and
**asks the Vercel API whether the deployment behind the host is a ready production deployment of the Dispatcher project
and the team, built from the commit of this run, before any request goes to it** (https, no port, no path, the
deployment's own address and not an alias; a wrong project, team or commit, an alias, a redirect or an API failure stops
the run with exit 2 or 1 and nothing is sent). Then it waits for `GET /health` and calls `POST /probe`, which creates a
canary VM from the snapshot, runs the image's `probe` mode with the real container flags and reports, including the
image id the deployment is configured with, which must be the one this run built.

**The canary is the only proof** (#479) that a deployment may run Dynamic jobs. The Dispatcher itself runs no probe when a job
is dispatched: no canary VM is made by a webhook, and a Dynamic job is accepted at once on a cold instance. That is safe
because a deployment goes live only after this canary passed, and the snapshot pair and the settings cannot change
during a deployment's lifetime. (The Worker still proves its own hardening again when it starts, section 8.)

**Pass:** exit 0, the deployment advertises every required engine from a probe that ran just now and names the image of
this run. **Fail** (exit 1): read the stable reasons in the output (`dispatcher/README.md`, "The canary probe"; for a
platform error the code is one of the closed `ProbeFailure` list, for a `denied` verdict the reasons of the startup
self-check in [`dynamic-review.md`](dynamic-review.md)) and do not go on; nothing was promoted, and the snapshot of the
run was discarded. Exit 2 means a wrong URL, a deployment that is not the Dispatcher's or a wrong option, and nothing
was sent. `canary_image_mismatch` means the staged deployment did not use the snapshot this run built: see section 8
(the run-time variables of a deployment). To run the canary alone on a staged deployment, Actions, *Dispatcher canary*,
*Run workflow* on `main`, with `url` set to that deployment's own address; it must be built from the head of `main`.

### Step 4. The setup code, then the first-run setup in the browser

A serverless instance has no log the operator reads, so the setup code is made by a command, with the same
`APP_SECRET` as the deployment:

```sh
read -rs -p 'APP_SECRET of the deployment: ' APP_SECRET; echo; export APP_SECRET
pnpm --dir app setup-code
```

(with `DATABASE_URL_MIGRATE` still exported; `unset APP_SECRET` afterwards). It prints `[setup-code] Setup code: <6 digits>`, valid for 60
minutes; running it again makes a new code and ends the old one. It refuses to print to anything but a terminal
(`SETUP_CODE_NOT_A_TERMINAL`; `--allow-pipe` overrides, only if you know where the output goes), on a database
that is behind (`SETUP_CODE_SCHEMA_BEHIND`: run step 1) and on an instance that is already set up
(`SETUP_ALREADY_DONE`).

Open `https://<app>`, enter the code and answer the three questions (tenancy, who may sign up, the admin account).
After that:

1. In the admin portal, **Integrations**, create the GitHub App of this instance with one click
   ([`github-app.md`](github-app.md)): its webhook URL is `https://<app>/api/webhooks/github-app`. Use the
   hosted instance's **own** App.
2. Install the App on one test repository, activate the repository as a project, and in the workspace enter an LLM
   key (Settings, LLM). Without it a run ends `llm_not_configured`.
3. Only if you operate `managed` workspaces (section 3.5): save the operator's key under **LLM key** (`/admin/llm`) now.
   It is optional for the first deployment and the smoke test.

Do not open test pull requests yet: the App is still in poll mode and nothing wakes the Dispatcher, so a job would only wait. Step 5 switches that on.

### Step 5. Switch the App to webhook mode

In Infisical `/app` add `RUNNER_DISPATCH=webhook`, `RUNNER_WEBHOOK_URL=https://<dispatcher>/dispatch`,
`RUNNER_DISPATCH_MAX_RUNNING` (the stored value `DISPATCHER_MAX_RUNNING` references: set it now to the cap you put in
step 2, and make `DISPATCHER_MAX_RUNNING` the reference) and, if needed, `RUNNER_WEBHOOK_BYPASS_TOKEN`. The signing
secret and key id (`RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`) are in `/app` since step 2. Wait for the Secret
Sync and run *Deploy production* again (a normal run: nothing to rebuild, so it is quick).

**Check:** the deployment starts. A webhook mode with a missing URL, a short or reused signing secret stops the start
with `DEPLOY_CONFIG_INVALID` naming the variables (never the values).

**Switch soon after step 4, and before pull requests are opened.** In poll mode the give-up is off. The first
webhook-mode sweep (it runs every 2 hours) applies `RUNNER_DISPATCH_GIVE_UP_SECONDS` (default 3600) to every job that has been queued longer
than that: such a job is **not woken, it fails with `dispatch_unavailable`** (no attempt is counted, and the next push or
the play button in the project list runs it again). Steps 3 and 4 take well under an hour of your time, and you opened no pull request before
this step, so normally nothing waits. If something does, let it fail and trigger it again, or raise the give-up time for
the switch and lower it afterwards. Jobs queued for less than the give-up time are woken by the first request that
touches the database (a delivery, a heartbeat) or by the next sweep.

### Step 6. Smoke test: a Diff review, then a Dynamic review

**Diff.** Open (or push to) a pull request on the test repository, or press the play button of its row in the project list and pick the pull request.

- Runs page: the run goes `queued`, `running`, `succeeded`; a review comment appears on the pull request.
- Dispatcher function log: `launched` for the job id (`launch_failed` with a `code` if it did not).
- The platform lists one VM named `cr-diff-<job id>-<random>` while it works (dashboard, or `Sandbox.list`), and it
  is gone, or stopped, afterwards.
- A run that stays `queued` for more than a few minutes: section 5.3.
- **Push to the open pull request** while the first review is still running, or after it: the new review starts at
  once (there is no debounce), unless the previous review of the pull request is still running: one job runs per
  pull request, and the new job is sent when the running one ends. If it does not start within a minute of that,
  look at section 5.3 and the Dispatcher log.

**Dynamic.** Dynamic Review is off for an instance until the admin turns it on, and it is only available when
the deploy canary of the deployment passed with `opencode`:

1. Admin, Setup, Instance, **Dynamic Review**: tick *Allow Dynamic Review on this instance*. Read
   [`dynamic-review.md`](dynamic-review.md), "Activation, step by step", step 1 and its rollback first: every App
   instance must already run the version that routes by review kind.
2. On the test project's settings page set the review kind to Dynamic.
3. Open a pull request. A Dynamic wake-up is accepted at once, also on a cold Dispatcher instance: no probe runs on the
   dispatch path (section 8). A `503` or `429` for another reason (a busy Dispatcher, a platform error) is repeated by the
   App inside the request, and by the repair work of section 5.7 if that does not help.
4. The Run shows the kind, the model and a result URL, and the summary comment is published.

**Done when:** one Diff run and one Dynamic run have succeeded, the Dispatcher log shows no `launch_failed`, the
sweep answers `200` (its runs are two hours apart), and no VM of the test is left running.

## 5. Operations

### 5.1 The golden snapshot: built, wired in and cleaned up by the pipeline

Nobody builds, wires in or deletes a snapshot by hand. Every run of *Deploy production* decides, builds if it has to,
proves, wires in and cleans up, in this order, and a failure at any point before the promotion leaves production on the
snapshot it has:

1. **Decide** (`snapshot-decide`). The pair production runs is read from the **live production deployment of the
   Dispatcher** (its meta carries `sandboxSnapshotId`, `sandboxImageDigest` and `sandboxSnapshotCommit`, put there by the
   deploy step), and, for a deployment made by hand, from the project's variables (`vercel pull`; Infisical `/dispatcher`
   by Secret Sync). If the live deployment cannot be read the run **stops** (`live_pair_unavailable`): stale variables
   must not decide in its place. The snapshot is **rebuilt** when: the commit of the pair is missing or not in the
   clone, the pair is missing or incomplete (the first deployment), an input of the Worker image changed between that
   commit and this run's commit, the **snapshot of the pair no longer exists** (`snapshot_missing`: a rollback went past
   the previous one, someone deleted it), or the run was started with `rebuild_snapshot` (the platform's base image
   changed, say). If the platform cannot say whether the snapshot exists the run stops (`snapshot_lookup_failed`).
   Otherwise the pair is reused. A pair that cannot be trusted is never reused: when in doubt it rebuilds.
   *The inputs* are exactly what the image build consumes (`IMAGE_INPUT_PATHS` in `dispatcher/src/snapshot/pair.ts`): the
   files `runner/Dockerfile` copies out of the build context (`runner/src`, `pyproject.toml`, `uv.lock`,
   `.python-version`, the two fetch scripts and the two pin files), the Dockerfile and the two ignore files, the license
   files, `docker/sandbox/vm-prepare.sh`, `docker/sandbox/sysbox-prepare.sh`, and the four files of the build tool that decide what is installed and checked
   in the snapshot (`config.ts` with the pinned Docker versions and the default build target, `pipeline.ts`,
   `scripts.ts`, `probe-flags.ts`). A test parses the Dockerfile's `COPY` lines and fails when one is missing from the
   list and when the list names something the build does not copy; another follows the imports of `pipeline.ts`. The
   tests of `runner/`, its README and the logic of the deployment steps are not inputs: editing them rebuilds nothing.
   A pair set up by hand before the pipeline existed (a snapshot and an image id, no commit) is not reusable, but its
   snapshot is kept as the previous one, so the first cleanup does not delete what the previous deployment still runs.
2. **Build** (`snapshot-build`, only if needed). The workflow `golden-snapshot.yml`, called by the run:
   a builder VM on Vercel Sandbox installs a pinned Docker, builds the Worker image from this commit, snapshots with no
   expiry, and a second VM from that snapshot scans it for secrets and job data, checks the image id and runs the
   image's own self-check ([`golden-snapshot.md`](golden-snapshot.md) has every step and failure code). It removes
   nothing of earlier runs (`--skip-retention`) and writes nothing to Infisical.
3. **Stage** (`stage-dispatcher`). First `snapshot:ops exists` checks that the snapshot is there (a re-run of failed jobs
   after the snapshot was removed stops here with `snapshot_missing`, not in a canary VM that cannot start). The staged
   Dispatcher deployment then gets the pair of this run as its **own run-time variables** (`vercel deploy --env
   SANDBOX_SNAPSHOT_ID=... --env SANDBOX_IMAGE_DIGEST=...`) and as meta. The project's variables, Infisical and the live
   deployment are not touched, so production keeps using the old pair until the promotion. This is the one mechanism of
   the pipeline that depends on how the platform treats `--env` next to the project's own variables (section 8); the
   canary does not trust it, it checks.
4. **Prove** (`canary`). The canary calls `POST /probe` of the staged Dispatcher, whose answer names the **snapshot id and
   the Worker image id** the deployment is configured with, and fails unless both are the ones this run built
   (`canary_image_mismatch`, no id printed). Both, because a rebuild of the same layers keeps the image id and changes
   the snapshot. The probe creates its canary VM from the snapshot the deployment uses. So the new snapshot is proven by
   the deployment that will run it, before anything is promoted.
5. **Promote**, App first, then Dispatcher (`promote-app`, `promote-dispatcher`). Each job checks again, right before it
   promotes, that its commit is still the head of `main`: *Re-run failed jobs* of an old run skips the first job's check,
   so the check is part of the jobs that act.
6. **Persist** (`persist`), **only after the Dispatcher is live**. The pair is written to Infisical `prod` `/dispatcher`
   with the machine identity's write path (section 2.1), after the same freshness check (a pair of an older run must not
   overwrite a newer one; if `main` moved on, the next run finds the live pair and writes it). Secret Sync then carries it
   to the project's variables for deployments made by hand and for the next `vercel pull`. Written also when nothing was
   rebuilt but the variables are behind the live pair (a repair, below). The three keys are written one after the other:
   a failure after the first leaves a mixed trio (a new id with an old image id, say), which a deployment made by hand
   would refuse to start with and which the next run repairs.
7. **Clean up** (`cleanup`), **after every promotion of the Dispatcher** (and after persist, when persist had something
   to do). Every golden snapshot is removed except: the new one (or the one in use, when nothing was rebuilt), the
   previous one (the one production ran before this run: the rollback target, the previous Dispatcher deployment, still
   references it), and the one the live deployment runs (read from the platform again, and if it cannot be read nothing
   is removed). Left alone besides: a snapshot younger than three hours that is not kept (a rehearsal by hand may be
   using it), and a builder with no snapshot younger than three hours; a builder with no snapshot **older** than three
   hours is the leftover of a build that was killed (builds are serialised and time out) and is removed. The rule is a
   list of what to keep, built from the current state, so it is safe to repeat after a failure halfway and it clears
   what an earlier run could not: what is gone is not planned again, and a list that does not contain a kept snapshot
   removes nothing.

**If the run fails before the promotion** (the build, the staging, the health check, the canary): production keeps the
old deployments and the old pair, Infisical was not written, and the `discard` job removes the snapshot this run built.
*Re-run failed jobs* after that is safe: the stage and the canary check that the snapshot exists and stop with
`snapshot_missing` if it does not, and *Re-run all jobs* builds a new one.

**If the Dispatcher's promotion failed, timed out or was cancelled:** the outcome is unknown. `vercel promote` requests
the promotion first and only then waits, so a timeout stops the waiting, not the promotion, and it can still land. Nothing
is discarded then (`discard` runs only when the promotion never started): the snapshot stays, and the next run's cleanup
keeps whichever one is live and removes the rest. Check the Dispatcher project's production deployment; if it is the new
one, the next run repairs the variables (below), and if it is not, the next cleanup removes the unused snapshot.

**If the promotion succeeded and `persist` failed:** the run fails loudly (red), production runs the new pair and
Infisical still holds the old one. Nothing breaks: the live Dispatcher deployment carries its pair as its own variables.
The next run reads the live deployment's pair, **prefers it over the variables**, finds that they differ and writes the
live pair (a repair), so the state heals itself on the next deployment; meanwhile a deployment made by hand from the
stale variables would use the old pair, whose snapshot the cleanup has not removed because `cleanup` runs after
`persist`. To heal it sooner, *Re-run failed jobs* of the run does exactly the persist step with the same pair.

**If `cleanup` fails or the run is cancelled after the promotion:** the pair is already written; the snapshots that
should have gone stay until the next run, whose cleanup removes everything not in its keep list.

**A release that changes the Worker image needs nothing from you:** merge to `main`; the run notices the changed
inputs, builds, proves the new snapshot on the staged Dispatcher and promotes. Only if the platform's base image or an
account-level setting changes without a change to the repository, run *Deploy production* with `rebuild_snapshot`.
The workflow *Golden snapshot*, started by hand, is a **rehearsal**: it builds and checks a snapshot and leaves it, wires
nothing in and persists nothing (a manual build that wrote the pair would let the pair drift away from what production
runs, and break the retention rule above). It has a queue of its own, apart from the build a deployment calls, and a
deployment's cleanup leaves a snapshot younger than three hours alone; an older rehearsal is removed by the next
cleanup.

### 5.2 Rotating secrets

| Secret | How |
|---|---|
| **Webhook signing key** (`RUNNER_WEBHOOK_SECRET`, `DISPATCHER_SIGNING_SECRET`) | No gap, in this order, each "deploy" being a run of *Deploy production* after the sync: (1) in `/dispatcher` write the new key as plain values into `DISPATCHER_SIGNING_KEY_ID` and `DISPATCHER_SIGNING_SECRET` (replacing the references) and the old one into `..._PREVIOUS`, deploy; (2) in `/app` set the new key (`RUNNER_WEBHOOK_KEY_ID`, `RUNNER_WEBHOOK_SECRET`), deploy; (3) after at least 5 minutes (the receiver's clock tolerance) remove the previous key from `/dispatcher`, put the references back, deploy. Use a **new key id** each time. |
| **`RUNNER_TOKEN`** (the dispatcher credential) | The App accepts exactly one, so there is a short gap: change the one stored value in Infisical `/ci` (the keys of `/app` and `/dispatcher` are references to it), wait for both syncs and run *Deploy production*, which redeploys **both**; the canary of that run already uses the new value. Claims that arrive between the two deployments fail and the job stays queued, to be resent when the next job ends, by the next request that touches the database or by the sweep; running Workers are not affected (they use their per-job credential, not this token). Do it when the queue is quiet. |
| **Vercel access** | With OIDC (no `VERCEL_TOKEN` in the Dispatcher project) there is nothing to rotate for the Launcher. For the pipeline: create a new access token (a dedicated one, with an expiry if the dashboard offers it: section 3.4), update `VERCEL_TOKEN` in `/ci` (and in `/dispatcher` if you chose token auth there, then redeploy), run a harmless check (*Deploy production* on an unchanged commit is one), then revoke the old token. The same holds for the Infisical Client Secret, which signs in the read and the write path alike: create a new one, update the GitHub secret `INFISICAL_CLIENT_SECRET`, run a check, revoke the old one. |
| **Bypass secret** | Regenerate it in the Dispatcher project's Deployment Protection settings, then update `/ci` `VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET` (`/app` `RUNNER_WEBHOOK_BYPASS_TOKEN` references it, if you use it) and run *Deploy production*. Wake-ups fail with `DISPATCH_REJECTED` in between. The App project's bypass secret (`/ci` `VERCEL_APP_AUTOMATION_BYPASS_SECRET`) is used by the health check only. |
| **`CRON_SECRET`** (App and Dispatcher, two separate values) | Change it in `/app` or `/dispatcher`, wait for the sync, run *Deploy production*. Vercel sends the new value to the next cron call; until the deployment is live the calls are refused (`401`) and one run of the sweep is lost (the next one, two hours later, covers it). |
| **`OPERATOR_API_TOKEN`** | Change it in `/app`, run *Deploy production*, give the operator's client the new one. |
| **`APP_SECRET`** | Not rotatable: changing it signs everybody out and makes every stored credential (GitHub App key, mail password, workspace LLM keys) unreadable. |

Any secret that was ever in a log, a chat or an issue is rotated the same way.

### 5.3 Reading what the Runs page and the logs say

A run's error code is shown on the Runs pages with a fixed sentence. Four belong to the hosted deployment:

| Where | Code | Meaning and what to do |
|---|---|---|
| Runs page | `dispatch_unavailable` | The job waited `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default) without anyone claiming it, no attempt is counted, and the next push or review request runs it again. Look at the **App's** sweep and send logs (`DISPATCH_SEND_FAILED`, `DISPATCH_REJECTED`) and at the Dispatcher's log. Usual causes: `RUNNER_WEBHOOK_URL` or the signing key do not match (`DISPATCH_REJECTED`: a wrong URL or secret looks like this and the App waits 30 minutes between tries), the Dispatcher is down or protected, `SANDBOX_SNAPSHOT_ID` is unset (`not_capable`), the pool is full for longer than the give-up time, or the sweep itself is refused (`CRON_SECRET`). |
| Runs page | `launch_failed` | The Worker could not be started even after three attempts. The cause is a launch code in the **Dispatcher's** log (line `launch_failed`, field `code`, plus `retryable`): the table in `dispatcher/README.md` ("The Sandbox-Launcher") lists them (`sandbox_auth_failed`, `sandbox_snapshot_missing`, `image_mismatch`, `docker_not_ready`, `worker_exited_early`, ...). |
| Runs page | `worker_exited` | Runs from before #487 only. The Dispatcher used to give a job back with this code when it saw the Worker's container end with an error. It no longer watches the container after the hand-over: a Worker that dies is found by its lease and the run ends `lease_expired` after three lost attempts. |
| Runs page | `dynamic_engine_unavailable` | A **Dynamic** job was dispatched and a Worker started, but the Worker refused it: its own startup self-check did not prove the container's isolation, so it serves Diff jobs only. No model was called and nothing was written to the pull request. The Worker's log says `Dynamic Review: opencode is not advertised, this runner serves Diff jobs only (<reason>)` and `job ... refused: the Dynamic engine is not advertised`. Since the Dispatcher runs no probe on a dispatch (section 8), this is the signal that the live deployment's container cannot be hardened: run the canary against it (section 4, step 3; Actions, *Dispatcher canary*), read the stable reason (`dynamic-review.md`, "The startup self-check"), fix it and redeploy through the pipeline so that a canary passes before it goes live. Diff jobs are not affected. |

Others you will meet: `no_capable_runner` (a Dynamic job nobody could run for 30 minutes, or for 3 hours while a runner was busy with other Dynamic jobs: `DISPATCHER_ENGINES` has no
`opencode`, or no Dispatcher is configured for it), `dynamic_review_disabled` (the gate is off), `lease_expired` (the Worker
stopped reporting), `quota_exhausted`, `workspace_suspended` and `entitlements_invalid` (the workspace's limits, set
through the operator API), `managed_model_unavailable` (the workspace is `managed` and its project selects no usable catalog entry for the kind
of review, and no instance default entry applies), `llm_not_configured` (the workspace has no LLM key, or it is `managed` and the operator has no usable key: section 3.5). The wake-up call's answers (`202`,
`200 ignored` with `not_claimable` or `not_capable`, `429`, `503`) and the App's back-off are in
`app/src/dispatch/README.md`, "What an answer means".

Logs: the App function logs `[sweep] requeued=.. given_up=.. sent=..` for a run that did something, `[dispatch]
DISPATCH_SEND_FAILED ...`, `[database] SCHEMA_BEHIND ...`; the Dispatcher logs `launched`, `launch_failed`,
`released`, `release_failed`, `lease_lost`, `probe_passed`, `probe_denied`, `probe_failed`. None holds a secret or a
URL.

### 5.4 Switching Dynamic Review off, and stopping the Dispatcher

- **Dynamic off, instantly:** Admin, Setup, Instance, Dynamic Review, untick. Waiting Dynamic jobs are cancelled
  `dynamic_review_disabled`; running ones finish.
- **Diff only:** set `DISPATCHER_ENGINES=pr-agent` and redeploy: no probe, no canary VM.
- **No Launcher:** unset `SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` and redeploy: the Dispatcher claims nothing. (A
  deployment of the pipeline carries its own pair and builds one when none is configured, so this is for a hand deployment.)
  Waiting jobs are not lost: Diff jobs fail with `dispatch_unavailable` after the give-up time, Dynamic ones with
  `no_capable_runner` after 30 minutes (3 hours at the latest while a runner is busy with other Dynamic jobs).
- **No more wake-ups:** `RUNNER_DISPATCH=poll` in the App. Jobs stay queued; nobody claims them.

### 5.5 Stopping VMs that outlived their job (the reaper)

The Dispatcher does not watch a Worker after it handed the job over (#487). When a job's claim ends for good (a result,
a failure, a cancel, a lease or runtime that ran out and ended the job), **the App** sends the Dispatcher a signed
`POST /stop` (`RUNNER_WEBHOOK_URL` with `/dispatch` replaced by `/stop`, signed with the same key as the wake-up call; best
effort, a bounded retry, never in the way of the job), and the Dispatcher stops the VMs tagged with that job. The call is
answered at once; stopping a VM with a running container takes 20 seconds or more, so the stop runs in the background.
Nothing needs configuring: the same two variables sign the wake-up and the stop. In the **App's** log a failed stop is
`[dispatch] DISPATCH_STOP_FAILED job=<id>` (the Dispatcher was down or kept failing), `DISPATCH_STOP_UNSUPPORTED` (a Dispatcher
of the previous release: no `/stop`, `404`), `DISPATCH_STOP_REJECTED status=<n>` (a wrong URL or secret) or
`DISPATCH_STOP_URL_INVALID` (`RUNNER_WEBHOOK_URL` does not end in `/dispatch`); in the **Dispatcher's** log `stop_received`,
`vm_stopped`, `vm_stop_failed`, `stop_replayed`, `stop_list_failed`, `stop_refused`.

A stop that did not arrive or failed, a job that went back to the queue (the next attempt's VM must not be stopped), or an App
of a previous release leave the VM running, idle and billed, until its own timeout (job timeout plus
`SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`). For a job that went back to the queue the reaper ends the lost attempt's VM only while
the retry is not yet `running`; once it is, the VM lives until its own timeout or until the job ends for good, when the stop
by the job ends every attempt's VM. The **reaper** (#364) is the safety net: Vercel's cron calls
`GET /api/cron/reap-sandboxes` of the Dispatcher every 5 minutes with `CRON_SECRET`, and it stops the VMs of this
deployment that outlived their purpose.

- **Deployments that share a Vercel team must not share a dispatch signing key.** A VM is scoped by the tag `app =
  code-reviewer` and the job's UUID only, with no tag of the deployment, and the stop (like the reaper) works on the team's
  Sandbox VMs. Two deployments (staging and production) with different signing keys cannot stop each other's VMs: a stop
  needs a signature and a job UUID that the signing App made. Give every deployment its own `RUNNER_WEBHOOK_SECRET` /
  `DISPATCHER_SIGNING_SECRET` and its own database; never copy one deployment's key or database snapshot into another.
- It lists only VMs named `cr-...` with the tag `app = code-reviewer` and checks each again: only a running,
  non-persistent VM of exactly the shape our code creates is ever stopped. The snapshot pipeline's builder and check
  VMs and anything else in the project never match.
- A VM younger than 2 minutes is never touched. One older than its own lifetime plus 2 minutes is stopped whatever the
  App says. A job VM whose job the App reports as not `running` is stopped; if the App's answer cannot be read the VM
  is **kept** (only its lifetime ends it then). A canary VM is ended by its lifetime only.
- The answer and the log hold counts and stable codes only: `listed`, `candidates`, `stopped`, `kept`, `unreadable`,
  `failed`, `deleted`, `deleteFailed`, `deleteKept`, `deleteNotTried`; events `vm_reaped`, `vm_reap_failed`, `vm_deleted`, `vm_delete_failed`, `vm_delete_kept`, `vm_delete_halted`, `job_state_unreadable`, `reap_done`, `reap_list_failed`.
  Besides stopping, each run deletes up to 50 ended (stopped, failed or aborted) VMs of ours that are a day old or older, so the platform's listing
  stays small (`dispatcher/README.md`, "The reaper"). A `500` with
  `REAP_LIST_FAILED` means the platform's listing failed; nothing was stopped and the next run tries again.
- **To check it:** Vercel's Cron Jobs settings of the Dispatcher project show the runs. During the smoke test, list the
  project's VMs after a job: none should be left running with a `cr-` name.
- **Deployment Protection:** whether the platform's cron is let through when the Dispatcher project is protected is not
  verified (step 3 says how to look).
- **If it does not run** (no `CRON_SECRET`, no snapshot configured, protection in the way, a plan that does not allow the cron), list the
  project's VMs now and then (names start with `cr-`, tags `app`, `kind`, `job`) and stop any that is older than a job
  can be. Leftover builders of the snapshot pipeline (`code-reviewer-golden-builder-*`) are handled in
  [`golden-snapshot.md`](golden-snapshot.md).

The reaper is not verified against the live platform: that the platform's listing honours the name prefix together with a tag
and reports `status`, `createdAt`, `timeout` and `tags` as the SDK types say, and that the project's cron may run every five
minutes. The reaper checks every VM itself, so it does not depend on the platform's filter.

### 5.6 Updating the App or the Dispatcher

> **Release with check runs and review verdicts (#405).** The App needs the *Checks* permission accepted on each installation, and every existing project starts to submit a review verdict after the update (`Review verdict` `off` keeps a project as it was) (the *Check the permissions* list on the Integrations page names a missing *Checks*, `docs/github-app.md`). The check runs of a hosted deployment are repaired by the sweep every two hours and by the requests that touch the database; no timer runs.

> **Release that removes the managed model tiers (#434, with #432 and #433).** The migration `20261018170000_migrate_model_tiers_to_catalog` runs in the `migrate` job and only adds: it turns the models you configured for Low, Medium and High into released catalog entries (`Low`, `Medium`, `High`, or `<Tier> (Diff)` and `<Tier> (Dynamic)` when a tier used two models), makes the Medium entries the instance defaults, and points every project that had a quality level at its entry, so no workspace on your key changes model. **Do this after the release, or managed reviews stop:** add the migrated entries to every `modelAccess` list you set on a workspace or on the instance default by hand. A workspace whose list does not contain the entry of its project, or the default entry of the kind, has its jobs ended with `managed_model_unavailable`; a list that is absent allows every released entry and needs nothing. Then check the entries (names, `released`, the Medium defaults) in the admin portal. Three behaviours differ from the tiers, on purpose: a tier that had no model for a review kind used to end the job with `managed_tier_unavailable`, and now the project runs that kind on the instance default entry (the Medium one); repositories activated or projects created after the release get the instance default, not the old tier of their workspace (a workspace-level tier was written into the projects that existed, and there is no workspace-level entry); and the stored tier of a project of a workspace on its own key is rewritten too, but nothing reads it while the workspace uses its own key. `/api/operator/v1/model-tiers` is gone: it answers `401` without a valid token and `404` with one (and the plain `404` of the platform while the operator API is off): update an external script that calls it before the release. A settings page opened before the release can still send the old quality level; that save is refused with `UNKNOWN_FIELD` and a reload fixes it. The old tier data stays in the database, unread, and is removed one release later. Instances on their own key see no change. A rollback is not safe: the previous release still finds the old tier data and runs the tiers as before, but a project whose settings were saved on the new release has lost its tier and runs on the default tier there, and the entries stay in the catalog. Roll #432, #433 and #434 together, and treat a fix forward as the normal way out (`app/src/model-catalog/README.md`, "Migrated from the tiers"). On a self-hosted instance, which migrates at start, going back to the previous image fails at startup, because migrations are forward only and the old image does not know this one: restore the database backup taken before the upgrade, or stay on the new image. On Vercel the `migrate` job is separate, so the previous deployment still starts. If the migration fails with `model tiers: N projects (…) changed while the migration wrote them`, a project was saved by a running instance (typically one of the previous release) three times in a row while the migration ran: nothing was applied (the whole migration is rolled back, and the message names the projects, at most 20), so run the deploy again; it is safe to repeat, and stopping the instances of the previous release first makes it certain.

A release is a pull request from `development` into `main`. **Merging it is the whole release**: it starts *Deploy
production* (`.github/workflows/deploy-production.yml`; you can also start it by hand on `main`), and nothing else is
done by hand, a change of the Worker image included (section 5.1). The jobs, in the order of their dependencies:

| Job | What it does | If it fails |
|---|---|---|
| `fresh` | The commit of the run is still the head of `main`. An older run (a re-run of an old run) is refused, unless a manual run was started with `allow_stale`. The promotion jobs and `persist` check it again right before they act, so a re-run of the failed jobs cannot skip it | Nothing is deployed |
| `migrate` | `pnpm --dir app migrate` against `DATABASE_URL_MIGRATE` from `/ci` | Nothing is deployed |
| `snapshot-decide` | Does the Worker image need a new golden snapshot? Is the one in use still there? (section 5.1) | Nothing is deployed |
| `snapshot-build` | Only if needed: builds and checks the snapshot | Nothing is promoted; the snapshot is discarded |
| `stage-app` | `vercel pull`, `vercel build --prod` (without the Vercel token), `vercel deploy --prebuilt --prod --skip-domain` for the App: a staged production deployment, no domain | Nothing is promoted |
| `stage-dispatcher` | The same for the Dispatcher, after the App and the snapshot, with the pair of the run as its own variables and meta | Nothing is promoted; the snapshot is discarded |
| `health-app` | `GET /api/health` of the staged App must answer `200` with `{"status":"ok"}`: `SCHEMA_BEHIND` stops at once, every other answer is retried for about five minutes, then fails | Nothing is promoted |
| `canary` | The Dispatcher canary on the staged Dispatcher, which must report the image id of the run (step 3 of section 4) | Nothing is promoted; the snapshot is discarded |
| `promote-app`, `promote-dispatcher` | `vercel promote` of the App, then of the Dispatcher, one job each | A project that did not promote keeps its old deployment: section 7 |
| `persist` | Writes the pair to Infisical, only after the Dispatcher is live (section 5.1) | The run fails loudly; the next run repairs it |
| `cleanup` | Removes the snapshots nobody needs, after every promotion of the Dispatcher and after `persist` when it ran | The next run removes them |
| `discard` | Removes the snapshot of a run that built one and whose Dispatcher promotion never started | The next cleanup removes it |
| `record` | Closes the GitHub deployment records (`app-production`, `dispatcher-production`), each with what happened to its own project | |

With the repository variable `FACTORY_ENABLED` set to `true`, the pipeline also has a lane for a second App, described in section 5.8. Unset, none of it runs.

Production stays on its previous deployments until `promote-app`. Do not rely on the platform to hold traffic back from a
deployment that is ahead of the database: it answers `/api/health` with `SCHEMA_BEHIND`, but nothing stops it from being
promoted by hand. The pipeline stops it. A migration always works for the version that is still running (additions
first, removals one release later), so an App instance **behind** the database is healthy and an instance **ahead**
of it reports `SCHEMA_BEHIND`. **That rule is not enforced by any tool**: the migration runs before anything is staged,
and a migration that removes or renames something the live version still uses, followed by a failed canary, leaves the
live App on a schema it cannot use. A pull request that adds a migration is reviewed for exactly this (additions
only; a removal waits one release), and the pull request template asks for it. The App is staged before the Dispatcher
because a release that changes the runner API needs the App first (`GET /api/runners/v1/version` lists the App's
features; a Dispatcher that finds one missing answers `503` and claims nothing). Runs queue one behind the other (one
group, `deploy-production`) and are never cancelled: a migration or a promotion in progress runs to its end. GitHub
keeps only the newest waiting run: a run that is waiting when a newer push arrives is cancelled, and the newer run
deploys the newer commit.

**What the Actions and GitHub pages show.** Every job that runs in the environment `production` (the migration, the
snapshot decision and build, both stages, the health check, the canary, both promotions, persist, cleanup, discard)
also gets a GitHub deployment record named `production` from GitHub itself, next to the two records the pipeline writes
(`app-production`, `dispatcher-production`). A release run therefore lists about a dozen `production` deployments, and
a run that stops early leaves some of them without a final status. That is how GitHub treats a job that names an
environment; the two named records are the ones that say what reached production.

The Vercel CLI that deploys, promotes and rolls back is installed from `tools/vercel`: the exact version in its
`package.json` and the whole dependency tree from the committed `package-lock.json`, with `npm ci --ignore-scripts`, so
that nothing the CLI pulls in changes from one run to the next (it runs with the token). Raise it deliberately, in one
pull request that changes both files.

### 5.7 What depends on the 2 hour sweep

The App's sweep (`GET /api/internal/dispatch-sweep`, every 2 hours, `CRON_SECRET`) is a **safety net** for the cases
below, not part of the path of a review (`app/src/dispatch/README.md`, "The cron sweep" and "Between two sweeps"). The
sweep is sparse so that a Postgres that scales to zero can sleep between webhooks; everything that has to happen
promptly is done by the request that causes it, after its response (`after()`), with no timer and no queue.

**The normal flow, without the sweep (webhook mode):**

| What | Who does it, and when |
|---|---|
| A review of a new pull request, of a push, a person's start with the play button | The App's enqueue hook sends the wake-up in the request that queued the job. There is no debounce. A push to a pull request whose review is still waiting replaces that waiting job; a review that is running finishes first, and the new job is sent when it ends (the next row) |
| A wake-up that failed (a 5xx, a timeout, no connection, `429`/`503` with a short `Retry-After`) | The same request repeats it up to three more times (pauses of 1, 3 and 8 seconds, at most 45 seconds in all, counted from the moment the request queued the job, so that 15 of the function's 60 seconds are left for what the request did before and for the database round trips; the routes that queue a job, the webhooks and the play button's review start (`/api/w/**`), have those 60 seconds set in `app/vercel.json`). `Retry-After` is honoured if it is 30 seconds or less: the 20 of a Dispatcher that is not ready and the 30 of a busy one both fit (#479). A refusal (`DISPATCH_REJECTED`) is never repeated: an operator has to look |
| A wake-up answered `429` (busy) or `503` (not ready) with a `Retry-After` the request does not wait for, or that kept failing after the repeats | The row keeps the longer of its back-off and the `Retry-After`, and **a job that ends** wakes it at once: the App asks these jobs along with the ones behind the pool cap (below), whatever time the row says, but never within 9 seconds of the last call. Any other delivery, heartbeat or result sends it when its time has passed (the last row of this table). No timer and no poll is added, so a database that scales to zero stays asleep |
| A job that waited behind the pool cap or behind the running job of its pull request | When a job ends (the Worker's result, a release), the App sends the waiting jobs, the one of the same pull request first, until as many wake-ups were accepted as the pool cap `RUNNER_DISPATCH_MAX_RUNNING` has free slots (one per freed slot when it is not set); a job that waits only for the running job of its own pull request is not asked |
| A job given back after a failed launch (`launch_failed`) | The release frees its slot first, then sends the job again once its retry time has passed (the Dispatcher gives it back with 30 seconds; the request waits for it if it fits in about 45 seconds, else the next request that touches the database or the sweep sends it) |
| The notice on a refused pull request (#281) | Posted after the response of the claim that refused the job |
| The lease of a Worker that vanished, and the calls that are due again | The next **delivery** of the GitHub webhook that queued a job (not an unused event or a duplicate), **heartbeat** or **result** of any Worker releases the leases that ran out and sends what is due, after its response, at most once every 30 seconds per function instance, under a lock of its own so that it can never make the cron a no-op. In a quiet system there may be none of these |

**Only the sweep (and so up to about 2 hours late), when nothing else happens:**

| What | Bound |
|---|---|
| A running job whose Worker vanished, in a quiet system (no delivery, no heartbeat of another job) | Its lease runs out after two minutes, and the job is requeued by the first request above, or by the sweep, or by a claim: **up to 2 hours**; the pull request shows "Running" meanwhile |
| A job nobody claimed for `RUNNER_DISPATCH_GIVE_UP_SECONDS` (`dispatch_unavailable`) | The give-up time plus **up to 2 hours** (the time is counted when the sweep runs) |
| A job that waited for the pool cap while the job that freed the slot ended by a **lease that ran out** (a Worker that vanished, nobody told the app) | Sent by the next request that touches the database once its row time (2 minutes after the refusal) has passed, else by the sweep: **up to 2 hours** |
| A dispatch the Dispatcher stopped (`not_capable`) | Asked again by the sweep, **every 2 hours** instead of every 10 minutes |
| A wake-up that kept failing after the inline repeats (or was refused `429`/`503` with a long `Retry-After`) in a system where **no job ends and no other request arrives** | Resent by the sweep, on the row's back-off: **up to 2 hours**. This is the one case a lone job can still wait: no event exists that could wake it, and a timer would keep the database awake. With the Dispatcher answering at once (no probe runs on a dispatch, section 8) it needs a Dispatcher that stays unavailable or busy for longer than the repeats (about 45 seconds) |
| A refusal notice whose post failed | Tried again at the next refusal on that pull request or by the sweep |
| The cleanup (rate limit counters, unverified accounts, remembered job keys, old dispatch rows) | Once per sweep, so every 2 hours (it only runs once per hour) |

**To see that it runs:** the App project's Cron Jobs settings list `/api/internal/dispatch-sweep` and its runs answer
`200`; the log shows `[sweep] requeued=.. given_up=.. sent=..` for every run that did something; `401 CRON_UNAUTHORIZED`
means `CRON_SECRET` is missing or short. The cron
runs only for the **production** deployment, so a staged or preview deployment never sweeps. A review that does not
start within a minute is not a sweep problem: look at section 5.3 and at the Dispatcher's log first.

### 5.8 A second App (the factory lane)

The same `app/` can be deployed a second time, as a separate Vercel project with its own database, and served by the same
Dispatcher. The lane is **merged dormant**: it runs only when the repository variable `FACTORY_ENABLED` is `true`. It is a
**repository variable** (Settings, Secrets and variables, Actions, *Variables*, repository), not a variable of the
environment `production`: the job that reads it does not run in that environment. It is a plain boolean (harmless in a
public repository, unlike the Infisical sign-in of section 2.1), and it exists because the lane is merged before its
Vercel project and its database do. The job `factory-flag` reads it once per run and every job of the lane reads that
job's output. Unset or `false`, *Deploy production* is the pipeline of section 5.6, job for job (plus the one job that
reads the switch, which nothing waits for).

**What is shared and what is separate.** The code, the pipeline, the Dispatcher, the golden snapshot (one snapshot serves
every App) and the machine identity are shared. The Vercel project, the database, the `CRON_SECRET`, the `APP_SECRET`, the
App's credential to the Dispatcher and its signing secret are the second App's own. What the product is called, which
features it has and which GitHub App it uses are settings of that project and of its database, not of the pipeline.

**Infisical.** A fourth folder `/app-factory` in `prod`, synced to the second project (a third Secret Sync, source
`prod` `/app-factory`, destination the second project, environment **Production**, auto-sync on). Its variables are those of
section 3.1, with its own values, and these are the ones that differ or are mandatory for the clone:

| Key in `/app-factory` | Value |
|---|---|
| `PRODUCT_ID` | `factory`. **Mandatory:** unset, the project starts as `code-review-com` (section 3.1) |
| `PRODUCT_CAPABILITIES` | `review,dynamic-review` (billing off). This is the product's default; it is set explicitly so that the value `health-factory` checks is written down. Changing it means changing the repository variable `FACTORY_EXPECTED_CAPABILITIES` at the same time (below) |
| `RUNNER_DISPATCH` | `webhook` |
| `RUNNER_WEBHOOK_URL` | `https://<dispatcher production domain>/dispatch`, the same Dispatcher as the first App's |
| `RUNNER_WEBHOOK_KEY_ID` | `factory-k1`: the `keyId` of the App's entry in `DISPATCHER_APPS` |
| `RUNNER_DISPATCH_MAX_RUNNING` | `2`: the `maxRunning` of the App's entry in `DISPATCHER_APPS` |
| `RUNNER_WEBHOOK_BYPASS_TOKEN` | Only if the Dispatcher is protected: `${prod.ci.VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET}` |
| `BETTER_AUTH_URL` | Its `vercel.app` address |

**The capability set of the factory.** The product `factory` allows `implementer`, the capability of the Software Factory's
Implementer; code-review.com refuses it and the start stops by name. It needs `dynamic-review` (and so `review`): a list with
`implementer` and without `dynamic-review` stops the start too. The product's default stays `review,dynamic-review`, so
an unset `PRODUCT_CAPABILITIES` never turns it on; the rollout of the Implementer sets the value explicitly, and the staged
App then reports `dynamic-review,implementer,review` (sorted). `health-factory` compares the set exactly with
the repository variable `FACTORY_EXPECTED_CAPABILITIES` (`dynamic-review,review` while it is unset), so a project whose
`PRODUCT_CAPABILITIES` names `implementer` is not promoted until that variable is changed with it (below); nothing live
changes in the meantime. The capability alone adds no page, no navigation entry
and no job: they come with later changes of the Implementer.

The keys of `/ci` for the lane are in the table of section 2.1. The Dispatcher learns about the App from `/dispatcher`,
with references so that a value lives once:

| Key in `/dispatcher` | Value |
|---|---|
| `DISPATCHER_APPS` | One JSON array on one line with the non-secret facts of the App: `[{"id":"factory","url":"https://<project>.vercel.app","kinds":["diff","dynamic","implementer"],"keyId":"factory-k1","maxRunning":2}]` (the format and every refusal are in section 3.2; the `implementer` kind only once the Dispatcher with #759 is deployed, else it refuses the unknown kind at start and `reviewer` has an outage; **from that moment `POST /probe` requires the canary report to name `implementer` (#765), so a failed proof blocks the promotion of everything this Dispatcher deploys, code-review.com's release included; there is no switch that waives the proof, and the way back is `kinds` back to `["diff","dynamic"]` in this variable and a redeploy**) |
| `DISPATCHER_APP_FACTORY_TOKEN` | `${prod.app-factory.RUNNER_TOKEN}` |
| `DISPATCHER_APP_FACTORY_SIGNING_SECRET` | `${prod.app-factory.RUNNER_WEBHOOK_SECRET}` |
| `DISPATCHER_OPERATOR_TOKEN` | `${prod.ci.DISPATCHER_OPERATOR_TOKEN}` |

Check once that the references show as resolved in Infisical and in Vercel (section 2.1). If a hyphen in the folder name
does not resolve on your instance, name the folder `/appfactory` in the references and the sync; nothing else changes.
`tools/factory-bootstrap/factory-bootstrap.sh` prints every one of these entries with its folder, the Vercel project
settings and, only when you run it with `--out`, writes the five random secrets of the second App into a new file that
only you can read (mode 0600), without ever printing or tracing one.

**The operator credential of the canary does not depend on the switch.** The canary opens `/probe` with
`DISPATCHER_OPERATOR_TOKEN` when `/ci` has that key, and with `RUNNER_TOKEN` when it has not (`dispatcher-canary.yml`, the
same step whether the lane runs or not). A Dispatcher that has the operator token accepts nothing else on `/probe`. So the
key must be in `/ci` and in `/dispatcher` **together**, and the Secret Sync must have carried the `/dispatcher` copy to the
Dispatcher project before the next run: a `/ci` copy alone would make the canary of the first App fail with `401`.
`tools/factory-bootstrap/factory-bootstrap.sh` lists both entries; fill them in one go (rollout order below).

**The database.** A second Postgres database receives the same migrations, with the same roles and grants (section 2), a
direct connection and a region near the projects. `pnpm --dir app setup-code` and the setup wizard create its first
administrator and workspace, as in step 4 of section 4; nothing is copied from the first database.

**The jobs.** All of them run in the environment `production` and use the Infisical sign-in as the others do, except
`factory-flag`, which holds no secret. Each has a short time limit, because `promote-dispatcher` waits for `promote-factory`
to finish (below).

| Job | What it does | Limit | If it fails |
|---|---|---|---|
| `factory-flag` | Reads `FACTORY_ENABLED` and outputs `enabled` (`true` only for the text `true`) | 2 min | The lane is skipped |
| `migrate-factory` | `pnpm --dir app migrate` against `DATABASE_URL_MIGRATE_FACTORY` (the second App's migrate role). A job of its own: the first App's `migrate` does not run it and does not wait for it | 15 min | The second App is not staged. Nothing of the first App's path changes |
| `stage-factory` | `vercel-stage.yml` for the second project, from the `app/` directory, after `migrate-factory`, in parallel with `stage-app` | 30 min | The second App is not promoted |
| `health-factory` | `GET /api/health` of the staged second App must answer `200` with `{"status":"ok"}`, **and** report `product` `factory` and exactly the capabilities of the repository variable `FACTORY_EXPECTED_CAPABILITIES`, `dynamic-review,review` while it is unset (`PRODUCT_MISMATCH` stops at once; a malformed variable stops the step before any request). This is one-sided: the first App's `health-app` does not yet assert its own product (#738) | 10 min | The second App is not promoted |
| `apps-check` | `POST /apps/check` of the staged Dispatcher (operator credential): every App it serves must be reachable and accept its credential (`app_unreachable`, `app_rejected`); a missing feature is a warning, because the live Apps are still the previous release | 5 min | The second App is not promoted |
| `promote-factory` | `vercel promote` of the second App, after `promote-app`, `health-factory`, `apps-check` and the canary | 10 min | The second App keeps its previous deployment |

`canary` runs once, for the Dispatcher, as without the lane. The promotion order is the App, the second App, the
Dispatcher (apps first, section 5.6). `record` also closes a `factory-production` deployment record.

**The capability set the health check expects (`FACTORY_EXPECTED_CAPABILITIES`).** `health-factory` compares the set the
staged App reports at `/api/health` with the **repository variable** `FACTORY_EXPECTED_CAPABILITIES` (a repository variable
like `FACTORY_ENABLED`, read by this job only). Unset or empty, the expectation is `dynamic-review,review`, which is the
check as it was before the variable existed, so nothing has to be set until the second App's capability set changes. The
value is the App's `PRODUCT_CAPABILITIES` as the health check lists it: the capability names, comma separated,
**sorted alphabetically**, with no space, no empty entry and no duplicate, for example `dynamic-review,implementer,review`.
The step checks that shape (and that every name is a known capability) first and fails before it asks the App anything;
the comparison itself stays exact, and `PRODUCT_MISMATCH` is final, not retried. Why a variable: the code that allows a new
capability has to be live before the App's `PRODUCT_CAPABILITIES` names it, and the expectation has to change in the same
moment as that setting; a literal in the workflow, changed by a pull request, cannot be both.

The order, for a capability added to the second App (the Implementer's `implementer` is the first case):

1. Release the code that allows the capability to `main` (the pipeline runs with the variable unset: the old set, green).
2. Only then, together: set `PRODUCT_CAPABILITIES` in Infisical `prod` `/app-factory` to the new list and set
   `FACTORY_EXPECTED_CAPABILITIES` to the new sorted list. Then run *Deploy production* once (the Secret Sync carries
   the setting to the project; the staged App starts with it).
3. To go back: reset both and deploy again. Removing the repository variable is the return to the default set.

**If only one of the two is changed**, the lane stops at `health-factory` with `PRODUCT_MISMATCH` (the variable names a
set the staged App does not report, or the other way round). The staged App is not promoted, `promote-factory` is skipped
and nothing live changes: the live second App keeps its previous deployment and settings. The release of the first App and
the Dispatcher is not affected (the lane never blocks it). A variable with a malformed value fails the same job earlier,
with an error that names the variable and shows the value with every character outside letters, digits, `,` and `-`
replaced by `?`. Fix the variable and run *Deploy production* again.

**The first promotion needs one manual step.** `apps-check` asks the staged Dispatcher about the Apps as they are *live*:
the address in `DISPATCHER_APPS` is the second App's production address. On the first run the second project has nothing
live, so that address answers nothing the Dispatcher accepts and `apps-check` fails with `app_unreachable: factory` (or
`app_rejected: factory`), and `promote-factory` is skipped. This is expected once, and the first App's release is not
affected. The deployment is staged and `health-factory` has checked it: promote it by hand with
`VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<factory project id> vercel promote <the staged address from the run's summary> --yes`
(or in the dashboard: the second project, Deployments, the staged one, *Promote*). From the next run on the address
answers and `apps-check` passes. A run in which `apps-check` fails with `app_unreachable: reviewer` is something else:
look at the Dispatcher.

**The second App never blocks the release of the first.** No job of the first App's path needs a job of the lane, the
second App's migration included: `migrate`, `snapshot-decide`, `stage-app`, `health-app`, `canary` and `promote-app` run
as without the lane, and a failed or skipped job of the lane changes none of their results
(`factory-lane-workflow.test.ts` evaluates the conditions with every lane job failing, and with the switch itself
failing). The conditions of `promote-dispatcher`, `persist`, `cleanup` and `discard` do not read a result of the lane.
Making the second App a gate later is a change of those conditions, and it should come with the first users of the second
App. What a failure of the lane can still affect, all of it:

1. **The run is red**, after the first App is promoted when the failure came late. The next run, or a manual one, tries
   again. The deployment records say what moved.
2. **Delay.** `promote-dispatcher` waits for `promote-factory` to finish (the order), and `persist`, `cleanup` and
   `discard` wait for `promote-dispatcher`; the next deployment waits for this run (deployments queue and are never
   cancelled). A factory job that hangs delays all of that until its time limit (the column above; staging is limited by
   `vercel-stage.yml` to 30 minutes), then the Dispatcher is promoted as usual. The limits are short on purpose; the
   reviewer's own jobs run in the meantime, so only the part the lane needs beyond them is lost. While the App is promoted
   and the Dispatcher is not, the App runs against the previous Dispatcher, which is the state any failed run leaves
   between the two promotions.
3. **Shared configuration, not jobs.** The Dispatcher is one deployment for both Apps. A malformed `DISPATCHER_APPS`, a
   missing or short `DISPATCHER_APP_FACTORY_*` secret or a missing `DISPATCHER_OPERATOR_TOKEN` makes the Dispatcher refuse
   to start (section 3.2), and the next canary of the first App fails with it, because the staged Dispatcher is the same one. So, before you set the switch,
   run *Deploy production* once with the switch still off after step 3 of the rollout: a green canary proves the Dispatcher
   starts with the registry. The operator token in `/ci` and `/dispatcher` also changes what `/probe` accepts, for both
   Apps. The Dispatcher's Sandbox concurrency is shared too: the caps of the Apps (`maxRunning`) add up,
   and their sum must fit what the team's Sandbox allows.

Nothing else: the migration of the second database, its staging, its health, the Apps check and its promotion cannot stop
the migration, the staging, the health check, the canary or the promotion of the first App.

**Rollout order.** (1) Release the Dispatcher with the App registry (`docs/dispatcher.md`) and the App with the capability
set; the lane's health check needs the product and the capabilities in `/api/health`. (2) Create the database and the
project, run the bootstrap tool, fill Infisical, add the Secret Sync (`docs/factory-bring-up.md` has the short list).
(3) Add `DISPATCHER_APPS`, the references and `DISPATCHER_OPERATOR_TOKEN` to `/dispatcher` and `/ci` together, wait until the Secret Sync shows
them synced, and run *Deploy production* with the switch still off: the canary must pass. (4) Set `FACTORY_ENABLED` to
`true` and run *Deploy production*; promote the second App by hand once (above). (5) Run `pnpm --dir app setup-code` against
the second database and finish the wizard in the browser.

**Switching it off.** Set `FACTORY_ENABLED` back to anything but `true`: the next run is the first App's pipeline again,
and `factory-flag` is the only job left over. The canary does not change: its credential follows `DISPATCHER_OPERATOR_TOKEN`
in `/ci`, not the switch, so leave that key (and the Dispatcher's copy) where it is while the Dispatcher has it: the
Dispatcher then accepts no other credential on `/probe`, and removing the key from `/ci` alone would break the canary of
the first App. The second project, its database, the Dispatcher's registry and the App's wake-ups are not touched: remove
`DISPATCHER_APPS` and the `DISPATCHER_APP_FACTORY_*` keys from `/dispatcher` if the Dispatcher should stop serving the App
(the operator token stays). To restore an earlier deployment of the second App, run *Rollback production* with
`factory_deployment` (section 7).

#### Rollout of the Implementer (the order of the steps)

The Implementer ([`implementer.md`](implementer.md)) is the first capability added to the second App after the lane exists.
It is dormant in every release, and code-review.com is not touched at any step. The keys and values, in the order that
works (the same steps with their checks, who does them and what undoes each are in [`factory-bring-up.md`](factory-bring-up.md),
"Switching on the Implementer"):

1. **Release the code to `main`.** The pipeline migrates the second database first, runs `health-factory` with the old set
   (`dynamic-review,review`) and the canary on the rebuilt snapshot, and promotes. Nothing live changes.
2. **`DISPATCHER_APPS`**, only after step 1 is live. Infisical `prod`, folder `/dispatcher`: in the factory entry set `kinds`
   to `["diff","dynamic","implementer"]`. Optional: an `implementer` entry of `DISPATCHER_WORKER_CONFIG` (sizes and
   `timeoutSeconds`; the defaults need none). Then run *Deploy production*, which stages and proves the Dispatcher with the
   kind. Set earlier, an older Dispatcher refuses the unknown kind at start and the first App has an outage. **This deploy is
   the first real proof of the engine:** the Launcher advertises `implementer` only when `DISPATCHER_APPS` names the kind, and
   `POST /probe` then requires the report of the canary VM to name it (a second probe in the Implementer's container
   profile, 110 seconds more, 260 seconds by default; with the kind keep `DISPATCHER_PROBE_TIMEOUT_SECONDS` at or below 190).
   When the Implementer's half fails, the Dynamic verdict stands and the report says `implementer_probe_failed`; the canary
   answers `503` and ends with `reasons=implementer_probe_failed missing=implementer, the release is blocked`. The promotions
   of the App, the factory and the Dispatcher all wait for the canary, so nothing staged in that run goes live, the first
   App's included (#797); there is no switch that waives the proof. The way back: set `kinds` back to `["diff","dynamic"]`,
   wait for the Secret Sync and deploy again.
3. **`PRODUCT_CAPABILITIES` and `FACTORY_EXPECTED_CAPABILITIES`, together.** Infisical `prod`, folder `/app-factory`, key
   `PRODUCT_CAPABILITIES` = `review,dynamic-review,implementer`; repository variable `FACTORY_EXPECTED_CAPABILITIES` =
   `dynamic-review,implementer,review`; then one *Deploy production*. One of the two alone ends in `PRODUCT_MISMATCH` at
   `health-factory`: nothing is promoted and nothing live changes.
4. **The maximum cost per review** in the factory's admin portal (General, Limits), raised from its default to the owner's
   per-turn maximum (the value is in the bring-up checklist). It is the only brake of a turn, and it is the cap of every job
   the factory claims, its own Diff and Dynamic reviews included.
5. **The factory's GitHub App, by one click in the admin portal, after the deploy of step 3** (the manifest then asks for
   Contents read and write; an App created earlier has it read-only and is updated by hand and approved by each
   installation: [`github-app.md`](github-app.md)). With tenancy `multi` the App is public; an installation reaches a
   workspace only when an Owner or Admin who owns the account has linked it. Also a model: a workspace key, or released
   catalog entries that serve Dynamic Review.
6. **The live smoke test** by the lead: [`implementer-smoke-test.md`](implementer-smoke-test.md).

To go back, remove `implementer` from `PRODUCT_CAPABILITIES`, reset the repository variable, and deploy again. The Dispatcher
entry and the permission may stay. What that does to running and queued tasks is in the bring-up checklist, step 3.

## 6. Sizing the Worker VMs

A Sandbox VM has 1 vCPU or an even number up to 8, and **2 GiB of memory per vCPU**: the smallest is 1 vCPU / 2 GB.
`DISPATCHER_WORKER_CONFIG` sets the size per Worker kind:

```json
{"dynamic": {"launcher": {"vcpus": 2}, "container": {"memory": {"limit": "3g", "reservation": "2g"}}}}
```

| Setting | Default | Notes |
|---|---|---|
| `launcher.vcpus` | 1 (1 vCPU / 2 GB) for both kinds | `1`, `2`, `4`, `6` or `8` |
| `container.memory.limit` | `1536m` | Leaves room for `dockerd` and the OS in a 2 GB VM; a limit that leaves the VM less than 256 MiB is refused. A 2 GB limit on a 2 GB VM gets killed by the VM's own memory cgroup (spike #317) |
| `container.memory.reservation` | `1280m` | |

Measured on the platform (spike #317 and the snapshot runs, region `fra1`): create from snapshot about 2 s, Docker
ready about 1 s after, the container's self-check plus start about 7 s, the whole path to "advertised" about 12 s; an
idle Worker container peaks near 360 MB. **The Dynamic-Worker's real worst case is not measured** (the spike ran no real
review): start with 2 vCPU / 4 GB and a 3 GiB limit for `dynamic` if you see `OOMKilled` or `worker_exited_early`, and
leave `diff` at the default until a real Diff review shows otherwise. A size change is configuration, not code, and
the canary uses the Dynamic size, so run it after changing it.

## 7. Rolling back

| What | How |
|---|---|
| **The App** | Actions, *Rollback production*, *Run workflow* on `main`, with `app_deployment` set to the deployment to restore (its id `dpl_...` or its address, from the Vercel dashboard or from the summary of an earlier run). The workflow first asks the Vercel API that it is a ready **production** deployment of the **App** project and team, then runs `vercel rollback` with the pinned CLI. Safe as long as the migrations since were additive (the previous version runs on a database that is ahead of it). A migration that has run is never undone. |
| **The second App** | The same workflow with `factory_deployment` (section 5.8). Only that project is touched; the project id is read from `/ci` when the input is given. |
| **The Dispatcher** | The same workflow with `dispatcher_deployment`. It also writes the restored deployment's golden snapshot pair (read from its meta) back to Infisical `/dispatcher`, so that the next deployment decides from what production runs again. Restore the **previous** Dispatcher deployment: its snapshot is kept by the cleanup (the new one and the previous one stay). The workflow checks that the snapshot of the target deployment still exists, and **refuses with `rollback_snapshot_missing`** when it is gone, before it touches either project: restoring the deployment would put production on a Dispatcher that fails every job, and writing its dead pair to Infisical would send the next deployment after it. To go further back, deploy the old commit as a new run instead (a manual run with `allow_stale`), which builds a snapshot for it. A deployment made by hand, which carries no pair, is let through. |
| **A pipeline that stopped between the two promotions** | The App was promoted and the Dispatcher was not (or the other way round): the GitHub deployment records say which (`app-production`, `dispatcher-production`). Run *Rollback production* for the one that moved, or fix the cause and run *Deploy production* again. A later deployment's `vercel promote` also ends a rollback's pause on the automatic assignment of the production domains. |
| **The snapshot** | Roll the Dispatcher back (row above): it restores the pair with the deployment. There is no separate action on the snapshot; the cleanup keeps the current and the previous one for exactly this. |
| **Webhook mode** | `RUNNER_DISPATCH=poll` stops the wake-ups. It is not a way back to another kind of runner: the App has no runner that polls. |
| **Dynamic Review** | The gate (section 5.4). |
| **A secret** | Section 5.2. |

*Rollback production* has a queue of its own (`rollback-production`), so an emergency rollback does not wait behind a
deployment and a waiting deployment cannot replace a waiting rollback. **It needs no approval**: whoever can run a
workflow on `main` can roll production back. The environment `production` is restricted to `main`, which is what keeps
other branches out; requiring reviewers on that environment would also gate every job of every deployment, so a
separate approval for rollbacks would need a second environment (section 9). Rolling back does not stop a deployment
that is running: if one is, the rollback and the deployment both finish, in whichever order, and the later one wins.

## 8. Known limits and what is not verified

**Not verified on the real platform (the first deployment is the test):**

- **The deployment pipeline** (#403) has never run on GitHub, Vercel or Infisical. Unit tests prove the logic against
  stand-ins and the shell of the steps against stub programs; the platform behavior below is only as good as the
  documentation and the CLI's source, which is why the pipeline fails closed on each point. The first real run is the test:
  - That the workflows are accepted and that the called workflows get the four Infisical secrets the callers pass by name
    (#408; the first run, which passed none, showed that they are empty otherwise).
  - That `vercel build` run from the repository root honors the project's Root Directory, and that it needs no token:
    the CLI's source and a run without a token against a pulled project directory say so (the build step runs with the
    token blanked), but nothing was run against a real project.
  - **That `vercel deploy --env` gives one deployment run-time variables that win over the project's own** (`--env`
    is a documented CLI option, but the create-deployment API reference does not list a body field for it). The
    canary does not trust it: the staged Dispatcher's `POST /probe` names the image id it is configured with, and a
    pair that did not reach the deployment fails the run with `canary_image_mismatch` before anything is promoted. If
    that happens on the first run, the pipeline is safe but cannot deploy a new snapshot until the mechanism is
    replaced (writing the pair to the project's variables through the API before staging is the alternative; it
    touches the project before the canary, which this design avoids).
  - That `targets.production` of the project follows a `vercel rollback` (the pipeline's idea of the "live" deployment
    is that field; if a rollback leaves it on the deployment rolled back from, the decision and the cleanup read the
    wrong pair until the next promotion), and that the project reports its production deployment as that field and a
    deployment's `meta`, `target`,
    `readyState`, `projectId` and `ownerId` as the API reference says (the snapshot decision, the canary's check and
    the rollback's check read them), and that a staged production deployment has the target `production`.
  - That a staged address is under Deployment Protection and the bypass header opens it, and that `vercel promote` and
    `vercel rollback` accept a deployment address in a non-interactive run (and what the exit code is when
    `--timeout` runs out).
  - That Infisical's API takes the calls of the write path as documented (`POST /api/v1/auth/universal-auth/login`,
    `GET /api/v1/projects/slug/{slug}`, `PATCH` and `POST /api/v4/secrets/{name}`), with the role of section 2.1, and
    that Secret Sync writes the three snapshot keys as ordinary variables and resolves the reference notation of
    section 2.1 across folders.
- The **Dispatcher on Vercel**: deploying `dispatcher/`, the platform's `waitUntil` for the launch and the stops, the 1800 s
  function limit (a beta limit, sized for the supervision #487 removed; lowering it is a follow-up), the cold-start and the probe behavior, and the OIDC authentication of the Sandbox
  SDK from a function. The spike did not deploy a function (its probe T14 was not run). The unit and integration
  tests run against the doubles in `fakes/`.
- The **mapping of the platform's errors** to launch codes goes by status and by words of the message; the platform's
  error bodies are undocumented, so it is not verified against the live API (`dispatcher/README.md`).
- **The whole chain on the real platform**: signed wake-up, claim, VM, Worker, result on a real GitHub pull request.
  CI runs the whole flow on fakes in the lane **`e2e-hosted`** (#332; `make test-e2e-hosted`, which needs a Postgres
  in `E2E_DATABASE_URL`; `TESTING.md`, "Hosted e2e lane"): the App in serverless mode on Postgres, the Dispatcher, the
  real Worker and PR-Agent, the Sandbox-Launcher over the local Sandbox double, and the failure journeys (Dispatcher
  down, give-up, launch failures, a Worker that dies, the pool cap, a deploy canary that fails, secrets in logs); the privileged
  lane `e2e-dynamic` adds the Dynamic journey with the real container's hardening. None of it touches Vercel, a real
  GitHub or a real model: this guide's step 6 is the manual twin on the real platform.
- **The reaper** against the live platform (section 5.5), and whether the platform's cron reaches it while the Dispatcher project is behind Deployment Protection.
- The **database role split** of section 2 on **your** Postgres provider. CI runs the guide's SQL against a plain
  `postgres:18` (`app/src/db/role-split.integration.test.ts`); a managed provider's rules for roles and owners may differ.
- **Dynamic Review memory**: the worst case in a 2 GB VM is unmeasured (section 6).
- The **golden snapshot** passed its checks in two real runs (the pinned Docker versions, the scan, the probe line).
  Retention was broken on the real platform in those runs and fixed in #365; its behavior on the real platform since
  the fix is not recorded. See "Not verified yet" in [`golden-snapshot.md`](golden-snapshot.md).

**Limits by design:**

- **One region.** `fra1` for the functions, the VMs and the snapshots; no failover.
- **The cost limit of a workspace is a soft cap** (`managedCostLimitMicroUsd`): cost is known only when a run settles,
  so runs in flight are not in the sum and a workspace can end above its limit by what the concurrent runs cost. The run
  limits are exact. A run with an unknown cost counts for nothing (`unknownCostCount` in the operator API's summary).
  The runs on a workspace's own key have a limit of their own
  (`ownKeyCostLimitMicroUsd`, same rules); an unknown cost is not bounded by either, and the app logs one line for each
  run that settles without a cost (job and workspace id only) so they can be watched. The operator API counts them per
  workspace and key mode for a period (`GET /usage/unknown-cost`), so an external service can alert on a rate without
  reading logs. Limits and the key mode are set through the operator API; the
  operator's own key (section 3.5) is saved by the instance admin only, and a workspace set to `managed` before every App
  instance runs the release that knows the key mode is served by the wrong key and outside the limit.
- **A managed workspace has no model of its own**: its projects select entries of your model catalog, or the instance
  default entry of the kind applies (`app/src/model-catalog/README.md`). An unusable entry fails the job with
  `managed_model_unavailable`, it does not move to another entry or to `LLM_MODEL`. The models never reach a workspace; a
  Dynamic model has to support tool calls. Create and release the entries and set the defaults before you set a workspace
  to `managed`. The tiers of #280 were turned into catalog entries by #434 and are gone.
- **A Worker that dies still holds its slot until its lease lapses** (two minutes after its last heartbeat): the Dispatcher does
  not watch a container after the hand-over (#487), so a Worker that exits non-zero before it has reported a result is not
  released when it ends. Only the next request that touches the database or the next sweep (up to 2 hours) then puts the job
  back, and the pull request shows "Running" meanwhile. The attempt is lost either way (three, then `failed` with
  `lease_expired`); the delay is the cost of holding no supervision (before, a container the Dispatcher saw end was released
  within seconds as `worker_exited`).
- **A review starts within seconds**: a push is sent when it is queued, with no debounce. What is
  up to 2 hours late is only the repair of abnormal cases (section 5.7).
- **The deploy canary is the only proof of the Dynamic container's hardening** (#479). The Dispatcher keeps no probe answer
  and runs no probe when a job is dispatched, so a cold instance costs a Dynamic job no delay and no canary VM. What it
  relies on: a deployment goes live only after the canary passed, and the snapshot pair and the settings are fixed for a
  deployment's lifetime. A snapshot or a platform that changes under a live deployment is not noticed by the Dispatcher;
  the Worker's own startup self-check (`dynamic_isolation_self_check_failed`) still refuses to run a review in a
  container that is not hardened, and the next deployment's canary shows it.
- **The pool cap is not a hard billing cap**: it limits launches in progress; an App-side limit per workspace is the
  other lever. A VM that outlives a function is stopped by the reaper at the next 5 minute run once its job has ended
  (section 5.5); if the reaper cannot run, its own timeout is the bound.
- **Dynamic Review on hosted** is gated on the hosted egress work (#82): the supervisor's own egress inside the VM
  is unrestricted by design, the Vercel firewall is not part of the security boundary, and the platform operator
  can read job secrets by construction (`dispatcher/README.md`). The container's hardening is proven by the deploy canary,
  not assumed: a deployment whose canary does not pass is not promoted.
- **The App's stop is best effort.** If the call does not arrive (the Dispatcher is down, the call failed after its two repeats,
  the App is on a release without it) the reaper (or, failing that, the VM timeout) ends the VM, billed meanwhile (section 5.5).
  A job that went back to the queue is not stopped: the VM of a lost attempt whose retry is already running lives until its own
  timeout or until the job's final stop, because the reaper keeps a VM whose job is running. The Dispatcher's function no longer
  has to outlive the job.
- **An accepted wake-up whose answer was lost is not stopped by the App.** The App sends a stop only for a job whose wake-up it saw
  acknowledged (`job_dispatches.acked_at`). If the Dispatcher accepted the call but the answer never arrived (the 8 s timeout, a
  lost response), no stop is sent for that job and only the reaper and the VM timeout end its VM.
- **Retired:** the runner's concept (its names stay).

## 9. Follow-ups

- Infisical OIDC for the repository's workflows instead of a Universal Auth client secret that is a bearer secret for
  anyone who passes the branch rule, and separate identities and folders by purpose (the migration URL, the deployment,
  the canary), so that a job holds only what it names by construction and not by convention.
- A second GitHub environment `production-rollback` with required reviewers, so that a rollback needs an approval
  without gating every deployment job.
- A tool that checks a new migration for removals (section 5.6).
- **Accepted:** every job that runs in the environment `production` also gets a GitHub deployment record (about a
  dozen per release run), some of which stay without a final status when a run ends early (section 5.6). Only the jobs
  that read or write secrets run there, and those need the environment; the two records the pipeline writes itself
  (`app-production`, `dispatcher-production`) are the ones that say what reached production.
- **Accepted:** the three snapshot keys are written one after the other, not in one call (section 5.1); a mixed trio
  is repaired by the next run.
