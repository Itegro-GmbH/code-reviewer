# Runner API

The runner (Python, `runner/`) asks the app for work over HTTP: it **claims** a job, sends
**heartbeats** while it works, and **completes** the job with the result. The wire format is
`contracts/runner-api.v1.json` (see `contracts/README.md`); this file says what the calls mean.

A second door, the **Worker API** (`/api/workers/v1`, #320), lets one process that holds a **per-job
credential** fetch, heartbeat and deliver exactly one job, and nothing else. It shares the queue, the
checks and the redaction with the runner API and is described in "The Worker API" below.

| Call                                      | Success                        | Meaning                                                                |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `POST /api/runners/v1/claim`              | `200` job, `204` nothing to do | Reserves the oldest due job and hands it out with its credentials      |
| `POST /api/runners/v1/jobs/:id/heartbeat` | `200`                          | Extends the lease (2 minutes; runners beat every 30 seconds)           |
| `POST /api/runners/v1/jobs/:id/complete`  | `200`                          | Stores the result and finishes the job                                 |
| `POST /api/runners/v1/jobs/:id/release`   | `200`                          | A Dispatcher gives a claimed job back (#322, "The Dispatcher's calls") |
| `POST /api/runners/v1/jobs/:id/vm`        | `200`                          | A Dispatcher reports the VM it created for a claim (#493)              |
| `GET /api/runners/v1/version`             | `200`                          | The app's version and features (#322)                                  |

| File                               | Role                                                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`                           | `createRunnerApi(deps)`: the order of the checks and the three entry points                                                                                                                                                                                           |
| `claim.ts`                         | The claim: `checkJob` (guard, LLM access, settings, pull request) and `buildJobInput` (the credentials and the job input, the one place that makes a secret of a job), the response. A claim with the feature `worker_credential` runs the first only                 |
| `release.ts`                       | The Dispatcher's release (#322): `handleRelease`                                                                                                                                                                                                                      |
| `vm.ts`                            | The Dispatcher's report of the VM it created (#493): `handleVmStart`                                                                                                                                                                                                  |
| `app-version.ts`                   | `APP_VERSION`, the `version` of `app/package.json`, for the version call                                                                                                                                                                                              |
| `report.ts`                        | Heartbeat and complete (`finishJob`, shared with the Worker API's result)                                                                                                                                                                                             |
| `worker-api.ts`, `worker-fetch.ts` | The Worker API (#320): `createWorkerApi(deps)` (credential check, details, heartbeat, result) and the details call that mints the secrets                                                                                                                             |
| `body.ts`                          | Reading a JSON body up to 64 KiB, shared by both APIs                                                                                                                                                                                                                 |
| `requests.ts`                      | The checks on job id, `X-Runner-Id` and the two request bodies (hand written, kept in line with the contract by the compatibility test)                                                                                                                               |
| `token-auth.ts`, `startup.ts`      | The `RUNNER_TOKEN` check (constant time, at least 32 characters) and the warning at a start without the production check                                                                                                                                              |
| `redact.ts`                        | Removes anything that looks like a credential from a result before it is stored                                                                                                                                                                                       |
| `responses.ts`                     | Every answer: `Cache-Control: no-store`, the error form `{ error: { code, message } }`                                                                                                                                                                                |
| `claim-guard.ts`, `job-options.ts` | The two hooks (below); `project-claim-guard.ts` and `review-settings-job-options.ts` are what the running server plugs in                                                                                                                                             |
| `claimed-keys.ts`                  | In the database, encrypted (`job_claimed_keys`): the LLM keys handed out for each job (a list, at most 3), so a rotated key can still be masked in its result by whichever app instance completes it                                                                  |
| `contract.ts`                      | The TypeScript types and code lists of the contract                                                                                                                                                                                                                   |
| `shared.ts`                        | The wiring of the running server (`getRunnerApi()`, `withRunnerApi`, `getWorkerApi()`, `withWorkerApi`); the route files under `src/app/api/runners/v1/` and `src/app/api/workers/v1/` only call these, which answer a failure while setting up in the usual 500 form |

## Workspaces

The runner token belongs to the instance, not to a workspace: a claim hands out the oldest due job of any
workspace (`createRunnerQueue`, not scoped). Everything the claim then looks up for that job (repository,
connection, project, review settings) is looked up in the workspace of the job (`job.workspaceId`), so the
credentials are those of the job's own connection. Nothing of this shows in the contract: the answers
are the same as for a single workspace.

## A managed Dynamic result without a cost (#553)

`finishJob` (`report.ts`, shared by the runner API's `complete` and the Worker API's `result`) stores a Dynamic result of a job on
the operator's key (and, since #754, of a turn of the Implementer) that claims a success and reports a usage with no cost (`usage.costUsd` null) as `dynamic_accounting_failed`
(`managed-cost-guard.ts`): a managed run never settles with an unknown cost, and the code is free for the customer. A failure keeps
the runner's code. On the workspace's own key a null cost is a success whose usage record settles with an unknown cost (minutes
only in billing).

## The result of a turn of the Implementer (#754)

A turn is a job of the kind `implementer` and finishes through the same `finishJob` as every job. Its result carries the closed
block `result.implementer` (`ImplementerResult` in the contract; `parseResult` in `requests.ts` reads it with the bounds of the
schema and the compatibility test requires the same verdict as the contract file; the app is stricter in two ways it must be: the
invariants the contract states in words, `pushed` never without a `headCommit` and `headCommit` the last of the commits when any are
listed, and control characters, which are taken out of the text and ids because a NUL cannot be stored). A `null` block is refused,
as the contract has no null for it. The block is held to the kind of the job
(`implementer-report.ts`): a job of another kind that sends one is refused (`400 RUNNER_REQUEST_INVALID`, field
`result.implementer`), and so is a **successful** turn without one. A failed turn may have none (the runner failed before it had a
repository). A refused report completes nothing and changes nothing.

What happens to a block that is accepted:

- `redactResult` removes from the summary, the commit subjects and the file paths: the exact secrets the app knows (the LLM key of
  the workspace and of the claim, the runner token, and the Worker credential on the Worker API; as they are and URL-encoded,
  JSON-escaped and in base64) and everything shaped like a credential (GitHub tokens, `sk-` keys, `crj_` credentials, `Bearer`
  lines). A secret split by zero-width or other format characters (U+200B and the like) is found too: the text is searched
  without them, and rewritten only when something was found. What it does not catch is a secret in any other disguise (reversed,
  spelled in pieces, look-alike letters, another encoding); the git token of a job is not known to the app, so it is caught by its
  shape (`ghs_...`) only. On the operator's key the model ids and the provider are taken out of the summary and the
  subjects too (`withoutManagedModel`); the paths are the repository's and stay.
- The queue's `complete` (`runner-jobs-repository.ts`), in the transaction that ends the job, gives the session its result with
  `recordTurnResult` (`db/implementer-turn-result.ts`): `head_commit` is the head the runner reports as pushed (`pushed: true`; the app takes the runner's word, it
  does not read the remote), plus the summary and the saved OpenCode session, and the session is `idle`. A failed turn keeps its block, so a turn that stopped
  at its cost limit after it pushed is a failed job with visible work. A failure without a block records nothing but the end (the
  session still becomes `idle`, its fields unchanged).
- A runner shut down by a redeploy reports `runner_shutdown`; the job is given back (a turn has one attempt, so it fails) and its
  report is not stored, but the work it reports is recorded on the session in the same transaction (`release` with `result`), so a
  push made before the SIGTERM keeps `head_commit`. A `launch_failed` ran no agent and records nothing.
- A report of a turn may be larger than any other: `IMPLEMENTER_MAX_BODY_BYTES` (`contract.ts`, about 26 MB) covers every limit of
  `ImplementerResult` with each character taken as the 12 bytes the runner's escaped JSON needs for a character outside the Basic
  Multilingual Plane. The limit is read for the job of the report (runner API `complete`, Worker API `result`); Diff and Dynamic keep
  64 KiB (`RUNNER_MAX_BODY_BYTES`), and so does any report for a job that is not there. A platform may limit a request body lower
  before the app sees it.
- Only the call that ended the job does this. A report with a lost lease (`409`) or one for a job that is settled already (late,
  repeated, or with another result) changes nothing in the session. A job that ends without any report (lease expired, never
  dispatched, no capable runner) sets the session `idle` through `idleSessionsOfEndedTurns` (#752).
- Usage and cost are settled as for Dynamic (`settlementOfOutcome`; the call trace is stored the same way), and a managed native turn
  that succeeds with an unknown cost, or with no usage at all, is stored as `dynamic_accounting_failed` (`managed-cost-guard.ts`; a
  Dynamic result without usage keeps its old treatment). The members never read the
  cost of a run on the operator's key: the Runs views take it out (`run-view.ts`), the stored usage keeps it for the settlement.
- Billing classes of the Implementer's codes are in `billing/outcome.ts`: `agent_gave_up`, `push_rejected`, `branch_violation` and
  `time_limit_reached` are charged (the agent ran), the codes that end a turn before it are free.

## Authentication

`Authorization: Bearer <RUNNER_TOKEN>` on every call. One shared token in the MVP, read from the
environment on every request, without surrounding white space. A missing, wrong, empty or
differently schemed token, and a server without `RUNNER_TOKEN` (or with a blank or **too short** one:
under 32 characters never matches, so a weak token fails closed), all get the same
`401 RUNNER_UNAUTHORIZED` answer,
before anything else is looked at. The comparison hashes both sides and compares in constant time, so
lengths and characters do not matter and it never throws. The session guard lets `/api/runners/**`
through (`src/auth/access.ts`): this token is the authentication.

`X-Runner-Id` is a free-form name (letters, digits and `._:@-`, up to 64 characters) that ends up in
`jobs.runner_id` and in the logs. There is no rate limit on failed attempts: that is why the token must
be long and random (`openssl rand -hex 32`); a production start with a missing or short token is refused (`DEPLOY_CONFIG_INVALID`, `src/deploy/startup.ts`), any other start logs one warning. It is bookkeeping, not a security boundary: what proves that a runner
holds a job is the **lease token**.

## The lease token

Every claim response carries a new `leaseToken`; heartbeat and complete must send it in the body.
The queue (`src/jobs`) checks it, not the runner id, so a runner that stalled past its lease, lost the
job and claimed it again gets a different token, and its old execution is turned away with
`409 RUNNER_LEASE_LOST`. The token is a secret of the holder: logs never contain it. It has 256 random
bits (base64url, 43 characters; it was a UUID before #320, and a runner treats it as opaque).

## Status codes

| Status | Code                            | When                                                                                                                |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `401`  | `RUNNER_UNAUTHORIZED`           | Token missing, wrong or not configured                                                                              |
| `400`  | `RUNNER_ID_INVALID`             | `X-Runner-Id` is not a plain id                                                                                     |
| `400`  | `RUNNER_REQUEST_INVALID`        | Job id is not a UUID, the body is not JSON or a field is missing or wrong (`fields` names them, never their values) |
| `404`  | `RUNNER_JOB_NOT_FOUND`          | No job with that id                                                                                                 |
| `409`  | `RUNNER_LEASE_LOST`             | The caller does not hold the job (lease lost, job finished, wrong token, past the hard time limit)                  |
| `409`  | `RUNNER_RESULT_CONFLICT`        | `complete` for a completed job with another result                                                                  |
| `200`  |                                 | `complete` repeated with the same result (`alreadyCompleted: true`, nothing is stored twice)                        |
| `413`  | `RUNNER_BODY_TOO_LARGE`         | Body over 64 KiB                                                                                                    |
| `503`  | `RUNNER_GIT_ACCESS_UNAVAILABLE` | Credentials could not be created now; `Retry-After` says when                                                       |
| `500`  | `RUNNER_INTERNAL_ERROR`         | Something unplanned; the log has the cause, the answer none                                                         |
| `401`  | `WORKER_CREDENTIAL_INVALID`     | Worker API only: the credential is missing, not of the form of one, for another job, of an earlier claim, or spent  |
| `409`  | `RUNNER_JOB_ENDED`              | Worker API only: the job is over (finished, failed, cancelled, ended by the app); the Worker stops                  |

Every answer, including `204`, carries `Cache-Control: no-store`.

## Claim

`claimNext(runnerId)` reserves a job (and first expires lapsed leases, see `src/jobs/README.md`). **#277: inside that
transaction, before the usage record is reserved, the entitlements of the job's workspace are checked** (a suspended
workspace, a used up run or cost limit, or entitlements that cannot be read): the job ends `failed` with
`workspace_suspended`, `quota_exhausted` or `entitlements_invalid` and the next one is tried, so none of the steps
below runs for it, no credential exists and no record is written (`src/usage/README.md`, "Limits and suspension at
claim"). **#498, #605: while billing is on, the balance check comes next, in the same transaction, and nothing is held:** a workspace whose balance is zero or below
zero has the job end `failed` with `insufficient_balance` or `balance_negative` (and `billing_rates_incomplete` when a rate is missing), with no
record and no entry. **#499:** before the balance it checks the hidden hourly brake and the workspace's monthly limit and ends the job `failed` with
`reviews_paused`, `monthly_limit_reached` or, when it cannot evaluate them for good, `billing_limits_unreadable` (a failure that may pass puts the job back in the queue for a later claim instead, `src/billing/README.md`, "Limits at claim"), with no record and no entry either; otherwise the record is written (`src/billing/README.md`, "Start, settle"). Every claim
path passes through it: the legacy claim, the split claim of a Dispatcher and the claim by job
id (for which a refused job answers `204`, like any job that cannot be claimed). Then, for that job, in this order:

1. **The claim guard** may refuse it (below).
2. **The model selection, then the key** (#432, ADR 0005, 2.8; `claim-selection.ts`, `src/llm/selection.ts`). The key mode
   of the job's own workspace is the one its claim recorded (`claimedKeyMode`; the claim decides it from the effective entitlements,
   in which the key mode is the workspace's own choice while billing is on, #496): `own` (also a
   workspace without entitlements), `managed` or unreadable (the job ends `llm_not_configured`, reason
   `entitlements_invalid`, no usage key mode is written). The mode is decided once, in the transaction of the claim, and
   reserved in the usage record (#496); the checks of the runner's claim, the Worker's fetch and any fetch again of the same claim
   read it from the record (`claimedKeyMode`) and only the standing and the model access from the entitlements as they are
   stored now (`entitlementsFor` = `readEntitlements`), so a choice made after the claim never reaches the job. A job claimed
   afresh (a lost lease) is decided again at that claim.
   Then the **provider, model and key mode's key source** are chosen _before_ any key is loaded, for the job's **pinned
   kind** (never the project's current kind), by `resolveModelSelection`:
   - **Own key:** the provider and model come from the layers of the settings (the workspace default and the project;
     `JobOptions.selection.layers`, built by `review-settings-job-options.ts`) over the instance's model
     (`ClaimDeps.builtInModel`). A model counts only for the provider it was set for; a model next to a provider of
     another layer ends the job `job_llm_options_invalid` (the save refuses the same pairing, `MODEL_PROVIDER_MISMATCH`).
     The plan's `modelAccess` is not evaluated (#432-T06, T16), and the entry catalog of the operator is not read. **A Dynamic project
     may name a catalog provider and model** (#555, `src/native-providers/README.md`); that selection is carried through the
     claim as a catalog model, see "A catalog model on the workspace's own key" below. A Diff job never is one.
   - **Operator's key:** the entry the project selected for the kind (`catalogEntryDiff`, `catalogEntryDynamic`), else the
     instance default entry of the kind, read from the catalog (`ClaimDeps.catalog`: the one entry, and the defaults only
     when the project names none). It must exist, be released, serve the kind, be allowed by the plan's `modelAccess`
     and have a provider the runner can run; otherwise the job ends `managed_model_unavailable` (the log names the
     opaque entry id, the kind and the reason, `no_selection`, `missing`, `not_released`, `kind_mismatch`, `not_allowed`
     or `provider_unsupported`; never a model or a provider) with no key and no token made, and never moves to another
     entry, provider or the instance's model (decision C5). `managed_tier_unavailable` is no code of the claim any more; the Runs copy keeps
     its sentence for old rows only.
   - **The `llmProviders` gate** (contracts/README.md, "Rolling out providers"): a provider other than the default
     goes only to a caller that listed it. A runner's claim names its list in the body (absent means `openrouter`);
     a Worker names it in the `llmProviders=` query of its details call. The claim of a **Dispatcher** names no list the
     app can rely on, so it does not judge the provider (every provider of the app passes, unless the Dispatcher listed
     some); the Worker's first fetch decides. An own job whose provider is unknown or not listed ends
     `llm_provider_unsupported`; the log line carries the provider as the tenant wrote it, cut to 64 characters with the
     cut marked and every non-printable character replaced (`src/llm/provider-text.ts`).
   - The input of the managed branch is the whole entitlements object, so any further fact about the workspace that decides a
     managed job goes through the same input, not a second read path.

   Only a selection that succeeded loads the key (`keyFor`, `src/llm/assemble.ts`): the workspace's own key **of the
   selected provider**, or the operator's key of it, as the selection's key source says; it does not read the
   entitlements again, so the key always belongs to the key mode the selection was made for. A workspace without a key
   for that provider ends the job as `failed` with `llm_not_configured` (log reason `no_key`, `key_unreadable`,
   `key_binding_mismatch`, `operator_key_missing`, `operator_key_unreadable`); another provider's key is never used.
   **Operations:** this fails every job of that workspace a runner claims, up to 25 per request, for good; entering a
   key later does not revive them (they have to be queued again, for example by a new commit or a comment). The key is
   remembered, encrypted, in the database before the response leaves (`claimed-keys.ts`); if that fails the job is
   given back and the runner gets a 500 without a key. The usage record notes the provider and, for a job on the
   operator's key, the catalog entry's id and its name as it is now (`recordSelection`, columns `llm_provider`,
   `catalog_entry_id`, `catalog_entry_name`; never the model). The claim logs `selection entry=<id> kind=<kind>` for
   such a job, and no model.
   **Options** of the job come with the selection (`JobOptionsSource`, below): the options of the review settings go into
   `env`. **The token budget** (`llm.maxTokens`) is no setting since #689: the claim decides it for every job
   (`reviewTokenBudget`, `src/model-catalog/token-budget.ts`) as 100,000, cut to the context window of the job's model when
   the provider's metadata states one (else to the window last read). A Diff job on the workspace's own key asks no provider
   (`ClaimDeps.knownContextWindow`): it is cut to the smallest window the models.dev catalog in the database states for its
   model and its fallback model, else to the instance's `LLM_MAX_TOKENS`, else it keeps the 100,000.
   **The cost limit** (`llm.maxCostUsd`, `llm.operatorMaxCostUsd`) is decided by `job-cost-limit.ts`: the customer's limit
   and the operator's maximum per review (#689, the admin portal, the instance setting `review_max_cost_cents`, read at
   each job through `ClaimDeps.operatorCostLimitCents`) go to a caller that names `operator_cost_limit` as two values; a caller
   that names `cost_limit` alone gets the smaller of the two in `llm.maxCostUsd`; a caller that names neither gets neither, and
   the claim logs `carries no cost limit` (a Dynamic Review is then held only to the runner's `RUNNER_DYNAMIC_MAX_COST_USD`, a Diff Review to none; a turn of the Implementer is not given that: the runner has no limit of its own for it, so the job ends `implementer_engine_unavailable`); a caller that names `operator_cost_limit` alone gets the smaller of the two in `llm.operatorMaxCostUsd`. **On the operator's
   key** the model of the job is the entry's, never the workspace's; the capabilities of #279 are read for it, from the
   selection's provider. The entry's model is remembered with the key,
   so the result a runner reports is stripped of it (`usage.model` becomes `null`, the model ids of every entry of every
   status are masked in the text). The Worker's first fetch decides the same again with the same code (`checkJob`).
   `llm.baseUrl`, `llm.requireParameters` and `llm.fallbackModels` are never sent (the LLM configuration has no base
   URL, and the MVP has no fallback chain); the runner adds OpenRouter's `provider.require_parameters` to every
   request for OpenRouter by itself (#270). The usage record itself was reserved by `claimNext`, in the transaction of
   the claim (`src/usage/README.md`); a failure of these calls gives the job back.

   **The cost of a native job (#553).** Right after the selection and before the key is loaded, a Dynamic job whose selection
   names a catalog model (`ClaimDeps.nativeCost`, `src/native-cost/README.md`) gets its cost policy. On the operator's key a model
   that is not enabled with a confirmed price ends the job `managed_model_unavailable` (the log: `entry=<id> kind=<kind>
reason=<catalog_price_unconfirmed|catalog_model_unavailable>:<reason>`), with no key, token or VM and a `void` usage record; a
   price check that itself fails gives the job back instead. The policy goes into the job as `dynamic.cost`, only to a caller
   that named `dynamic_cost_policy` (else the job ends `dynamic_engine_unavailable`). A job that is not native is unchanged and
   the price service is not asked.

   **The model entry of a native job (#578).** After the policy, the same decision step asks `nativeCost.entryFor` for the entry of
   the model (the last known catalog row, no key, no price) and sends it as `dynamic.modelEntry` with the policy. An entry that
   cannot be built ends the job like an unavailable model (`managed_model_unavailable` on the operator's key, with
   `reason=entry_<code>` in the log; `dynamic_model_features_unsupported` on an own key of a registry provider), before any key or
   token exists; a failed read gives the job back. The two registry providers keep their API address whatever the catalog trusts: an
   entry whose address is not the registry's is refused with `reason=entry_upstream_not_registry`
   (`src/native-cost/registry-addresses.ts`). A native job does not read the provider's model metadata. Whether a registry provider
   is native at all is the app's switch `NATIVE_OPENCODE_PROVIDERS` (default off; `src/native-cost/README.md`).

   **A catalog model on the workspace's own key (#555).** A Dynamic job on the workspace's own key may name a provider of the
   models.dev catalog and one of its models (`contracts/opencode-providers.v1.json`; the project settings save only a pair the
   catalog lists, `MODEL_NOT_IN_CATALOG` otherwise). The sequence, all before any key, token or VM exists:
   1. `resolveModelSelection` accepts the provider only when `ClaimDeps.nativeCost` is wired (`SelectionDeps.nativeModels`) and
      marks the selection as a catalog model (`catalog: true`).
   2. `costOf` builds the per-job entry of #548 with `nativeCost.entryFor` (`Checked.modelEntry`, sent as `dynamic.modelEntry`). **A
      model that models.dev stopped listing keeps being served** from its last known row (decision of 2026-10-19 on #548; the claim
      logs it and the settings page warns), because a provider's retirement is not the catalog's housekeeping. For a catalog
      selection the refusals have their own codes: **a row that is gone** ends the job `llm_model_unavailable`, and **a provider that
      cannot carry a key** (blocked by `url_changed` or `rejected`, no longer supported, an address that is not the trusted one in its
      canonical form) ends it `llm_provider_unsupported`. The log names the kind and the stable reason (`entry_model_not_in_catalog`,
      `entry_provider_url_blocked`, ...), never a provider or a model. There is no move to another model, provider or key.
   3. The cost policy of #553 is judged first (an own key is never refused for a price; an unknown price gets the token cap).
   4. `keyFor` reveals **only the chosen provider's key** (`llm_api_key.<slug>`). A workspace that has a key for another provider but
      not for this one ends `llm_not_configured`; the key of provider B is never used for provider A.
      The Runs copy for `llm_model_unavailable` says the model is no longer offered and asks the workspace to pick another one
      (`runs/error-copy.ts`).
   5. **Where the key goes.** For a provider outside the registry the destination is exactly the catalog's trusted address
      (`src/native-cost/README.md`, "Where the key goes"); the workspace types none.
      **The pin (#588).** The selection carries the address the project pinned when it selected the provider
      (`Selection.pinnedAddress`); `entryFor` serves the entry only if the catalog trusts exactly that address, else the job ends
      `provider_address_changed` (free; the Runs copy tells an Owner or Admin to confirm the new address in the review settings of
      the project), before any key or token exists. A selection with no pin (made before this) is pinned by its first claim to the
      address the entry names (`ClaimDeps.providerPins.adopt`); a claim that loses that race to another pin holds to the pin in force, and it adopts nothing when another project of the workspace pinned another address for the provider (the job is refused). A failed adoption gives the job back with `provider_pin_check_failed`.

3. **The pull request** is read through the provider's `getPullRequest`. A pull request that does not
   exist ends the job with `pr_not_found`, one that is closed or merged with `pull_request_closed`;
   `prUrl` in the response is the URL the provider reports.
4. **Credentials** are created with the provider's `jobAccess`: a new installation token for exactly this
   repository, with the least permissions. This is the only place that does it; nothing is created when a
   job is queued, and nothing is cached or kept. The token is revealed (`revealGitAccess`) into the
   response and the local value is dropped with it.

### The engines of a claim (#195)

The claim body is optional: `{ "engines": ["pr-agent", "opencode"] }`. The runner advertises the
engines it can run; an absent or empty body is a previous-release runner and means `pr-agent` only.
The claim only hands out a job whose review kind one of those engines can run (`pr-agent` runs Diff,
`opencode` runs Dynamic), filtered in the atomic SQL claim. An unknown engine, a duplicate or an
empty list is `400 RUNNER_REQUEST_INVALID`, and a body over 64 KiB is `413`, both before any job is
claimed and any credential is created. The token check comes first.

**#746, #753:** the contract names a third engine, `implementer`, and a third kind of job, `implementer` (the Implementer of the factory
deployment, `contracts/README.md`, "The Implementer kind"). A claim that names the engine is handed a turn; a claim that does not never
gets one (the atomic claim filters by engine), and a claimed turn for a caller without the engine is refused by `kind-guard.ts` with
`implementer_engine_unavailable` before the guard, the key or a credential is looked at, so it is never built as a Diff job.

## The claim of a turn (#753)

A turn is a job of the kind `implementer` with a record in `implementer_turns` (the instruction, the model it was started with, its cost
limit) and `implementer_sessions` (the branch, the base branch). The claim and the Worker's fetch take the road of every job (`checkJob`,
then `buildJobInput`) with these differences:

| Step          | A review job                                                  | A turn                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Options       | the review settings of the project                            | the turn's record: `{entryId}` (operator's key) or `{provider, model}` (own key), the cost limit of the turn. A choice that does not fit the key mode the claim decided ends the job (`managed_model_unavailable` / `llm_model_unavailable`); it is never moved to another model                                                                                                                                                                      |
| Model         | `selectModel` for the kind                                    | `selectModel` for the Dynamic kind (`projectKindOf`): the entry must serve `dynamic`; the model must be native (entry and cost policy), else `implementer_config_invalid`. A catalog provider on the workspace's own key is held to the address the workspace's projects pinned for it (`ClaimDeps.pinnedAddresses`): one pin, exactly that address; several different pins, none (`provider_address_changed`); no pin, the catalog's trusted address |
| Platform read | the pull request (`pr_not_found`, `pull_request_closed`)      | none: no pull request is read. The repository and its connection must be active (`git_connection_disabled`) and the installation must hold `contents: write` (`installationPermissions`, else `git_write_not_granted`, ended for good)                                                                                                                                                                                                                |
| Token         | `jobAccess` (`contents: read`)                                | `implementerAccess` (`contents: write`, `metadata: read`, one repository). Behind the capability: a deployment without `implementer` gets `INTEGRATION_CAPABILITY_ABSENT`, mapped to `implementer_engine_unavailable`, before GitHub is asked                                                                                                                                                                                                         |
| Input         | `prUrl`, `command`, `git`, `llm`, `env` (+ `dynamic`, `base`) | `reviewKind: implementer`, `implementer {repo {fullName, cloneUrl}, baseBranch, branch, instruction, limits {timeLimitSeconds: 3600}, cost, modelEntry}`, `git`, `llm` (`maxTokens`, the cost limit by `jobCostLimit` as for Dynamic), `env: {}`                                                                                                                                                                                                      |

`cloneUrl` is the repository's own address with `.git`, and must satisfy the rule of the runner's workspace (https, a host, no credential,
query or fragment); an address that does not ends the job `implementer_config_invalid` before any credential exists.

A turn needs a runner that names `cost_limit` or `operator_cost_limit` (and `dynamic_cost_policy`): the cost limit is the brake of a turn and
the runner has no limit of its own for this kind, so a caller that names neither ends the job `implementer_engine_unavailable`, as for an
engine that cannot run the kind, before any credential exists.

A failure that may pass (GitHub down while the installation is read or the token is made) gives the job back with `Retry-After`.
A turn is never run twice (`maxAttempts` 1), so it is put back in the queue only while **no input was ever handed to a Worker**: the
write tokens are remembered before an input leaves, so a turn whose ledger is empty has handed out none (`noInputHandedOut`, asked
before the call builds anything), and its release carries `beforeStart`. After a first fetch delivered an input, a later failing fetch
ends the turn like any lost attempt of it, because the Worker of the first fetch may be running.

**The write token ends with the turn.** The token lives up to an hour and nothing may keep it alive after its job
(`write-token.ts`). `implementerAccess`'s counterpart is `revokeImplementerAccess` (`DELETE /installation/token`, not behind the
capability, never throws). It answers whether the token is off: `true` for a 2xx or a 401 (switched off before, or expired), `false` for
a server error, a rate limit, a refusal, no answer in 3 s or no connection. Each token the claim hands out is remembered sealed with the
time it expires next to the keys of the job (`job_claimed_keys`, `gitTokens`, rows changed under `FOR UPDATE`) before it leaves, and is
forgotten **only after the platform said it is off, or once it has expired on its own**. A token that could not be switched off stays and is
tried again. It is switched off:

- when the fetch or claim fails after the token was made and before the input reached a Worker (`revokeUndelivered`: exactly that token,
  with the value in hand, even if the ledger cannot be written; it is also what a failure after the mint inside `buildJobInput` does);
- when the turn is over, however it ended: the stored result (success or failure, also a repeated report), a Worker or a Dispatcher giving
  the job back, and every end of a claim of the queue (`onClaimsEnded`: the reaper, a stop, the hard timeout, a cancel), after the
  response (`revokeAllOf`, `revokeEnded`);
- by the retry: the maintenance between requests (`opportunistic.ts`) and the sweep (step `write_tokens`) look at the turns that ended
  lately and still hold a token, until the token expires. Both exist only in a deployment with the capability `implementer`.

The body may also name `features` (#279): `["dynamic_capabilities"]` says the runner reads
`dynamic.capabilities`. Unknown names are ignored; a list that is not a list of plain names is
`400 RUNNER_REQUEST_INVALID`. A previous-release runner names none.

**#666:** `["cost_limit"]` says the runner reads `llm.maxCostUsd`, the cost limit of the job's project in US dollars (the effective
`maxCostCents` of the review settings, `/100`), and enforces it next to its own limit. Both kinds of job carry it, in `llm`, and only
when the project (or the workspace default) sets one; a job that meets a caller without the feature (a runner's
claim, or a Worker's details request) gets no `maxCostUsd` and runs with the operator's own limit alone; the app logs
`runs without its project cost limit`. The job is not refused: a runner or Worker image older than the app can exist for the minutes
between the promotion of the App and of the Dispatcher (`contracts/README.md`, #666), and a refused review is worse than a project
limit that is not kept for that window. A project without a limit sends nothing.

A Diff job keeps the exact legacy payload, whatever runner asked, unless its project has a cost limit and the caller named
`cost_limit` (#666): no other field is added, so a previous-release runner parses it unchanged. A Dynamic job is only ever handed to a runner that
advertised `opencode`, and its `input` is tagged:

- `reviewKind: "dynamic"`;
- `dynamic`: `{ model, skill, limits: { maxFindings } }` — model/skill/limits only, a closed object.
  There is no field for the fixed core, a permission, an executable command or an endpoint, and the
  skill is literal data. **#279:** `capabilities` (`DynamicModelCapabilities`) is added to `dynamic`
  when the claim built it from the provider's model metadata (`src/llm/dynamic-capabilities.ts`) and the
  runner named `dynamic_capabilities`. A claim of a Dynamic job reads the metadata of its model (cached)
  before any credential is created: a model whose metadata says it has no tool calling or no required
  tool choice ends as `dynamic_model_features_unsupported`, whatever runner claimed it; metadata that
  cannot be read (provider unreachable, unknown model, no stated window) sends nothing, logs
  `model capabilities not read (<why>)` and the runner uses its own description, as before;
- `base`: `{ repository, baseRef, headSha, previousReviewedSha, attemptedShas, attemptedShasTruncated, comparison }` — the exact queued head,
  the base identity the provider reported, and the _declared_ comparison mode (`full` in this stage;
  the checkout verifies completeness before it trusts it). `previousReviewedSha` is the head of the
  last successful review of the same kind (#199), or `null` when there is none; `attemptedShas`
  (#255, optional: left out when there are none, so a runner from before #255 still accepts the job)
  are the heads of the pull request's earlier jobs of that kind that ran and did not succeed (`failed`
  or at least one lost attempt; created after the last succeeded job and before this one, newest
  first, at most 20): a run may have written the summary before it ended, and the publisher accepts
  exactly these heads as the comment's state; `attemptedShasTruncated` (#257, optional: sent only as
  `true`, so a runner from before #257 still accepts the job) says that more heads qualified than the
  list holds, and lets the publisher recover a bot-owned summary whose head fell out of it with a full
  review;
- `env: {}`: no PR-Agent option is promoted into the Dynamic job.

The kind, the engines and the tagged shape are also the contract `ClaimRequest`, `Engine`,
`ReviewKind`, `DynamicReview` and `ClaimBase` in `contracts/runner-api.v1.json`; a Dynamic job whose
kind is not in the runner's engines ends as `dynamic_engine_unavailable` rather than being run by
PR-Agent.

A job that cannot run for a reason that will not go away (LLM not configured, pull request
gone, connection removed or suspended, repository not part of the installation, permissions missing)
ends as `failed` with a stable code (`CLAIM_FAILURE_CODES` in `claim.ts`; a guard may name its own code),
the runner is not told, and
the next job is tried (up to 25 per request, then `204`). If ending the job itself fails (a database
error), the job is given back like after any other unexpected error. A reason that may pass (GitHub rate limiting
or down, the pull request could not be read) gives the job back with `release`: it counts as a lost
attempt like a lapsed lease (3 attempts, then it fails with the reason as its code), waits until the
`Retry-After` time and the runner gets `503`. `Retry-After` is what the platform said (a rate limit),
otherwise 30 seconds, at most 15 minutes. An unexpected error also gives the job back and answers
`500`.

`/review` takes no arguments: the claim never carries `args` (#203). The claim refuses a job whose
command is not `review` as `job_args_invalid` instead of handing a runner a command it would refuse
(in practice the claim selection already excludes removed commands).

## Complete

The body is `{ leaseToken, result }`. `result` is what `code-reviewer-run-job` prints, plus an optional
`errorMessage`. `ok` and `errorCode` agree (`errorCode` is `null` exactly when `ok`).

- Stored: the checked result, with every field filled, in `jobs.result`; for `ok: false` the job's
  `error_code` is the runner's code, or `unknown` if the app does not know it (the original stays in the
  result).
- **No secrets are stored.** The runner redacts its own log. As a second line, `redact.ts` removes
  anything that looks like a credential (GitHub tokens, provider keys, bearer credentials) and the exact
  LLM key of the claim (from the database, so any app instance knows it), the current key of the job's workspace
  and the runner token from `logTail`, `errorMessage` and `commentUrl` before they are stored. The
  git token is not known to the app after the claim, so it can only be recognised by its shape.
- **A runner that is shut down** reports `ok: false, errorCode: "runner_shutdown"`. That is not a result:
  the job is given back with `release` (it waits again, one attempt counted, the same cap as a lapsed
  lease; on the last allowed attempt it fails with `runner_shutdown`) and the answer says
  `status: "queued"` (or `failed`). Nothing is stored. Reporting it again, or after the lease was lost,
  is `409`.
- **Usage record.** In the transaction that ends the job, its usage record is settled from the result: a
  reported usage settles it with `usage.costUsd` in micro-USD (rounded half up, null when unknown) and the
  tokens, a failed result too when it made a model call before it failed (#273); a failed result without usage voids it
  (`src/usage/README.md`). A repeated completion changes nothing. A job that ends without any result is closed by the
  queue, not by this call: settled with an unknown cost and the reason `no_result` when a runner held it.
- Repeating the same completion answers `200` with `alreadyCompleted: true`; another result for a
  completed job is `409`. "Same" is compared on the stored form, so leaving out an optional field is
  not a different result.
- A body over 64 KiB is refused with `413` before it is parsed.

## The Worker API (#320)

`/api/workers/v1/jobs/:id` (`GET`), `/heartbeat` and `/result` (`POST`). The rule behind them: a Worker
acts with a credential that reaches **one job**, and the answers to the Dispatcher that started it carry
no secret of that job. The credential itself opens the details call, so whoever holds it can fetch the
secrets: the app does not bind it to a process. The Dispatcher is trusted to hand it to the Worker on
stdin only and to use it for nothing else; the part of the isolation that the app enforces is that the
Dispatcher's own credential (`RUNNER_TOKEN`) never reaches a Worker route and a job credential never reaches the
runner API.

**The split claim.** A claim whose body names the feature `worker_credential` (a Dispatcher) runs the same
guard, LLM access check and pull request check as before, ends or gives back a job exactly as before, and
then answers with `SplitClaimResponse`: `{ id, credential, reviewKind, leaseExpiresAt,
heartbeatIntervalSeconds }`. There is **no `input`, no git token and no model key** in it, and no
installation token is made. Without the feature the answer is the legacy `ClaimResponse`, byte for byte
as before (a previous release's runner never names it).

**The credential.** `crj_` and 256 random bits (base64url, 43 characters), made by the queue in the
transaction of the claim (`jobs/worker-credential.ts`). It is shown once, in that response, and never
stored: the database keeps `wc1:` and its SHA-256 as the **lease token** of the claim, so heartbeat,
result, release and every other statement fenced by the lease token are fenced by the credential without
a second column and without the secret at rest. The Worker API looks a credential up by its hash
(`queue.holding`); a lease token of a legacy claim has no `wc1:` form and never matches, and the
credential is not a lease token of the runner API (`409 RUNNER_LEASE_LOST` there). It is valid for its
job and its claim only: a job that is queued again (lease expired, released) clears the token, a new
claim makes a new credential, and the old one gets `401`. Nothing logs it, and a result is redacted of it.

**Authentication.** `Authorization: Bearer crj_...` only. The dispatcher credential (`RUNNER_TOKEN`),
a lease token, a credential of another job, an unknown job and a missing header all get the one `401
WORKER_CREDENTIAL_INVALID` (same status, headers and body, so it says nothing about which jobs exist).
Conversely the job credential on `claim` is `401 RUNNER_UNAUTHORIZED`. The session guard and the setup gate let
`/api/workers/**` through like `/api/runners/**` (`src/auth/access.ts`, `src/setup/gate.ts`).

**Details** (`GET`). `?features=dynamic_capabilities` (a comma separated list, unknown names ignored) has
the same meaning as `features` in a claim: an optional job field reaches only a Worker that reads it.
This is where the secrets are made, by the same code as the legacy claim's step 4 (`buildJobInput`): the
checks run again (the project may have been switched off, the key removed, the pull request closed), and
so does the **standing of the workspace** (#276): a workspace suspended since the claim, or whose entitlements became
unreadable, gets no key and no token and the job ends with `workspace_suspended` or `entitlements_invalid`, the code
the claim would have used. Quotas are not counted again, they were decided at the claim. The installation token is minted for exactly this repository, the model key is revealed and **remembered**
(`job_claimed_keys`, so a result is masked after a key rotation by whichever instance serves it). Every key handed out
for the job stays remembered (up to 3, the fetch budget; a key already known takes no place), so the key of the first
fetch is still masked after the operator rotated its key before the second.
At most **3 fetches per claim** (the count is on the job row and reset by every claim); each mints a fresh
token; the fourth is `401`. A permanent failure (the project is off, the key is gone, the installation was
removed, the pull request closed) ends the job with its stable code (the same list as `CLAIM_FAILURE_CODES`)
and answers `409 RUNNER_JOB_ENDED`; a failure that may pass (GitHub down or rate limiting) gives the job
back with an attempt counted and answers `503` with `Retry-After`; anything unplanned gives it back and
answers `500`. A Dispatcher that sees `409`/`503` for its Worker just sees the job end or come back.

**Heartbeat.** Extends the lease like the legacy call; the body is read up to 64 KiB and ignored.
**Result.** `{ result }` (the credential identifies the job), redacted and stored by the same code as
`complete` (`finishJob`). `runner_shutdown` and `launch_failed` are not results: the job is given back (an
attempt counted, `status: "queued"`, or `failed` on the last attempt) and the credential is dead. After the
job reached a final state only a repeat of the same result is accepted (`200 alreadyCompleted`; another
result `409 RUNNER_RESULT_CONFLICT`); every other call answers `409 RUNNER_JOB_ENDED`. Over 64 KiB is `413`
before the body is parsed, and the credential is checked before the body is read.

**Mixed versions.** The change is additive: the legacy routes, their answers and the lease semantics are
the same; the only differences visible to an old runner are a longer lease token and one more stable code
for a result (`launch_failed` is just another reported code on the legacy `complete`). The migration adds
a column with a default, so an app instance of the previous release keeps working on the migrated database.
A job claimed with a credential by a new instance and then handled by an old instance only has an opaque
lease token it can neither guess nor serve; its lease runs out and the job is tried again.

## The Dispatcher's calls (#322)

A Dispatcher (#316) is woken by the dispatch webhook for one job, claims exactly that job and starts a
Worker. It cannot count what runs, so the app counts for it. Three additions, all optional on the wire:

- **Claim by id.** `jobId` in the claim body adds `id = :jobId` to the claim SQL (Postgres) and
  nothing else: the job must be `queued`, due, of a kind the advertised `engines` can run, and its pull
  request must have no running job. Anything else (unknown, running, finished, cancelled, superseded, not
  due yet, another kind) is `204`, with no attempt counted and no other job handed out, also when the named
  job ends at claim time (closed pull request, project switched off). Two claims for one id: one wins, the
  other is `204`. It works with the legacy answer too; the answer shape depends only on `worker_credential`.
- **Pool cap.** `maxRunning` (1 to 1000) counts the running jobs whose `runner_id` equals the request's
  `X-Runner-Id` (the pool) inside the claim transaction, after lapsed leases were requeued, and answers `204`
  at or above the cap. Another pool is unaffected. Atomic because a claim is the only way a job becomes
  running and every claim holds the exclusive Dynamic-gate lock on Postgres (`pg_advisory_xact_lock(195, 1)`,
  `db/dynamic-review-lock.ts`), so two claims of one pool cannot
  both see room for one more; `claim-by-id-queue.integration.test.ts` (#322-T06) keeps it that way, on Postgres in CI.
  A `maxRunning` of 0, a negative or fractional one, one over 1000 and a `jobId` that is no UUID are
  `400 RUNNER_REQUEST_INVALID` before any job is claimed.
- **Release.** `POST /api/runners/v1/jobs/:id/release` with `{ credential, reason, retryAfterSeconds? }`: the
  dispatcher credential in `Authorization`, the job credential in the body. It is the queue's `release`, so an
  attempt is counted (a failed Worker launch is a failed attempt, no separate budget), the job waits again
  from `retryAfterSeconds` (default: at once) and fails on the last allowed attempt (three). The stored
  error code is `launch_failed` or `worker_exited` (#375: the Worker started and its container ended with an
  error before it reported a result), whatever else was sent becomes `launch_failed` (the reason is logged, the UI has
  copy for both codes). The Dispatcher of #487 sends only `launch_failed`: it holds no supervision after the hand-over, so
  `worker_exited` stays accepted for a Dispatcher of the previous release and for the runs already stored. An App that does not know it
  accepts any reason of the right form and stores `launch_failed`. Answers: `200` `{ job: { id, status: "queued" | "failed" } }`; `400` for a body that does not
  fit (a lease token is not a credential); `401 WORKER_CREDENTIAL_INVALID` for a credential that is not the
  running claim of that job (another job's, an earlier claim's, made up; nothing changes); `404` for an unknown
  job; `409 RUNNER_JOB_ENDED` when the claim of that credential has ended (a job that already has its result is
  this answer too, and its result stands: the release of a Worker that delivered its result and then exited with an
  error is a no-op). A repeated release of a job that
  was queued again is `401` (the claim is gone). The credential is never logged or returned.
- **VM start (#493).** `POST /api/runners/v1/jobs/:id/vm` with `{ credential, vmName, startedAt, timeoutSeconds }`
  (`VmStartRequest`, closed): the dispatcher credential in `Authorization`, the job credential in the body, like the release, so the
  Worker (which holds only the second) cannot call it. The Dispatcher says that it created the VM of the claim, right after
  `Sandbox.create` returned; `startedAt` is its clock (the App keeps it between the claim and its own clock), `timeoutSeconds` the
  VM's own timeout (60 to 86,400). The first report of a VM wins: `200 { status: "recorded" }`, a repeat `200 { status:
"replayed" }` and nothing changes. `400` for a body that does not fit (an unknown field, a bad name, time or timeout; the
  refusal names fields, never values); `401 WORKER_CREDENTIAL_INVALID` for a credential that is not a claim of the job;
  `404` for an unknown job; `409 RUNNER_JOB_ENDED` when the claim ended or is not the running one (nothing is stored; the
  backstop covers that VM). The credential is never logged. It only measures (`billing/README.md`, "Billable minutes"); a
  Dispatcher sends it best effort and a failure never touches a launch or a job. Advertised as the feature `vm_lifecycle`: a
  Dispatcher sends nothing to an App that does not list it. #498: a claim keeps at most four VMs (`MAX_VMS_PER_CLAIM`; the rest are answered `replayed`),
  and the Dispatcher's claim names the claim feature `vm_lifecycle` next to `worker_credential` (the app notes which Dispatchers it serves,
  `src/billing/dispatcher-features.ts`).
- **Version.** `GET /api/runners/v1/version` answers `{ version: 1, appVersion, features }` with
  `features` from `APP_FEATURES` (`worker_api`, `claim_by_job_id`, `pool_cap`, `release`, `vm_lifecycle`). It takes the
  dispatcher credential; a Worker may also call it with its credential **and** `?jobId=<its job>` (the
  credential must be the running claim of that job, a primary key lookup), to check the app before it
  fetches its job. The answer holds nothing of any job.

- **Job state (#364).** `GET /api/runners/v1/jobs/:id` answers `{ version: 1, job: { id, status } }` with the
  status of the job (`queued`, `running`, `succeeded`, `failed`, `superseded`, `cancelled`) and nothing else: no job
  input, lease, repository or credential, and nothing is written. The dispatcher credential only (a per-job
  credential is `401 RUNNER_UNAUTHORIZED`), a job id that is no UUID is `400` and an unknown job `404
RUNNER_JOB_NOT_FOUND`, both before anything else is read. A Dispatcher's reaper asks it to find the Sandbox
  VMs of jobs that ended (`dispatcher/README.md`, "The reaper"). It is not in `APP_FEATURES`: a Dispatcher
  does not need it to claim, and one that meets an app without the route reads a `404` without an error body as
  "state unknown". **#397:** a superseded job whose claim is still valid (its Worker is finishing the model requests in
  flight and has not reported) answers `draining: true` next to its status; the reaper keeps its VM until then. The
  field is left out otherwise, and a Dispatcher that does not know it sees a superseded job as ended (the VM is
  reaped after the usual age).

**Mixed versions.** No migration. A previous-release app does not know `jobId` or `maxRunning` and would
claim the _next_ job and ignore the cap, and has no `release` or `version` route (`404`): a Dispatcher
must therefore read `/version` and refuse to claim unless the features it needs are listed (`404` or a
missing feature means "app too old"). The legacy claim (no body, or `engines` and `features` only) makes the
same queue call and the same SQL as before; a runner of the previous release is not affected, and a new app
behind an old Dispatcher is not either (nobody sends the new fields). The job state call is the same kind
of addition: a new Dispatcher with an app without it keeps claiming and its reaper falls back to the maximum
lifetime of a VM; an old Dispatcher never calls it.

## A superseded run (#397)

A new push supersedes the running automatic review of the pull request when its holder understands it: a runner whose
claim names the feature `supersede` (not a Dispatcher's split claim, which is not the holder), or a Worker whose job
details request names it (`?features=supersede`; the app notes it on the job, `accepts_supersede`). The other calls
keep their meaning and the rest is additive:

- **Heartbeat** (`/api/runners/v1/jobs/:id/heartbeat`, `/api/workers/v1/jobs/:id/heartbeat`): `200` with
  `job.superseded: true`, while the claim lasts; the lease is **not** extended (it ends at the claim window, 240
  seconds after the push: the Worker's next heartbeat, at most 60, its own drain, 120, and a margin; see
  `SupersedeTiming` in `contracts/runner-api.v1.json`). After that, or after the report, the usual `409`.
- **Complete / result:** accepted **once** for a superseded claim: `200` with `job.status: "superseded"`; the job
  stays `superseded`, the result is stored (it can carry `errorCode: "superseded"`, the runner's own code), and the
  usage record is settled from the usage it reports with the reason `superseded` (`src/usage/README.md`). The same
  report again is `200 alreadyCompleted`, another one `409 RUNNER_RESULT_CONFLICT`. **A report that comes after the
  claim ran out** is still taken for a grace of 60 seconds (the sweep does not settle the record before), so a Worker
  that used its whole drain is billed its exact cost whenever some claim happens to expire leases; **after the
  grace** it is refused with `409` (`RUNNER_LEASE_LOST`), like a heartbeat, and nothing is stored: the record was
  (or is about to be) settled once with an unknown cost, and a record is not changed after it may have been served.
- **Job details** of a superseded claim: `409 RUNNER_JOB_ENDED`, like any ended job. A release of one
  (`worker_exited` from a Dispatcher of the previous release) is `409`/`401` and changes nothing.

**Mixed versions of the supersede (#397).** One migration adds `jobs.accepts_supersede` (default 0) and widens the
check of `usage_records.settled_reason`; an app of the previous release ignores both. A job is superseded only when
its holder named `supersede`, so a runner or Worker of an earlier release is never superseded and nothing changes
for it. **A push during the boot of the VM is not superseded:** a Dispatcher's claim is not the holder's (`!split`),
and the flag is set by the Worker's first job details request, so a push between the claim and that request finds a
running job that does not accept it. The new job waits behind the stale run as before; this is by design and safe,
not a missed supersede to chase. A Dispatcher that does not read `draining` sees a superseded job as ended.

## Hooks

- **`ClaimGuard`** (`claim-guard.ts`): `check(job)` returns `{ allow: true }` or
  `{ allow: false, errorCode, outcome? }`. The running server uses `createProjectClaimGuard`
  (`project-claim-guard.ts`): a job whose repository has no active project (the project was switched
  off after the job was queued, or the deactivation raced with the claim) is not handed out. Its
  outcome is `cancel`: `cancelClaimed` ends exactly this job as `cancelled` with `project_deactivated`
  in one statement fenced by the lease token (running to cancelled, no attempt counted, never queued
  in between, so also on the last allowed attempt, and the slot of its head commit is free again), like
  a job that was waiting when the project was switched off. The other waiting jobs of the repository
  were cancelled by the deactivation, and a job enqueued after a reactivation is not touched. The
  default outcome `fail` ends the job as `failed` with the guard's code. No credentials are created
  for a refused job. The other half of the rule is `createJobProjectHooks` (`src/jobs/project-hooks.ts`),
  wired in `src/projects/shared.ts`: deactivating a project cancels its waiting jobs in the same
  transaction; running jobs finish.
- **`JobOptionsSource`** (`job-options.ts`): `optionsFor(job)` returns the options of one job, so they
  can differ per repository: `env` (the extra options of the review PR-Agent tool, `PR_REVIEWER__*`;
  a previous release also sent the removed tools' families, which the runner accepts and ignores) and
  optionally
  `llm: { model, fallbackModels, maxCostCents }` (the token budget is the claim's since #689). The running server uses
  `createReviewSettingsJobOptionsSource` (`review-settings-job-options.ts`): the review settings of the
  job's repository (project over global defaults over built-in values, read at claim time) go through
  `toRunnerSettings`. The values are text of the type PR-Agent's option has (`"5"`, `"true"`); an option
  that is off is left out. A `model` replaces the model of the LLM access; a null or missing
  value is left out of the job. `fallbackModels` is accepted and **not handed on**: no fallback chain is
  decided for the MVP. A key outside the review family ends the job as `job_env_invalid`, a model or
  size the runner would refuse as `job_llm_options_invalid`. The key pattern is
  `RUNNER_ENV_KEY_PATTERN` in `contract.ts` (one option name per key, no second `__`): the only
  definition in the app, equal to `JobEnv` in the contract file and to the runner's `_ENV_KEY`; the
  review settings import it.
- **`claimed-keys.ts`**: the claim notes the key it handed out; `complete` masks the key of the claim
  and the current key (`redact.ts`, `maskSecretInText` of `src/llm`) in the log, the error message and
  the other text fields before the result is stored. The note lives in the memory of the process only
  (capped, oldest first; a restart forgets it, and masking then falls back to the current key and to the
  shape of a credential), because a key is never written to the database.

## Where the trigger policy lives

The trigger policy (CR-31: drafts, the review settings, the check against
the current head commit, dropping the waiting jobs of a closed pull request) and the project gate
(CR-24, CR-5) are wired in the webhook handler (`src/webhooks/README.md`), so the runner API only sees
jobs the policy let through.

## Tests

- `integration-tests/http/runner-api-usage.integration.test.ts`: the usage record from claim to completion.
- `integration-tests/http/runner-api-claim.integration.test.ts`, `-report`, `-security` and
  `-route-files`: the real handlers with a real Postgres database and the fake GitHub; the route files with
  the wiring of the running server and a delivery that goes through the webhook route first.
- `integration-tests/http/runner-api-native-own.integration.test.ts` (#555): a catalog model on the own key: the entry, the one key revealed,
  `llm_not_configured` for a key of another provider, `llm_model_unavailable`, an unlisted model still served.
- `integration-tests/http/runner-api-projects.integration.test.ts`: the wiring to the projects, the
  review settings and the LLM configuration (CR-46).
- `integration-tests/compatibility/runner-api-contract.integration.test.ts`: the contract.
- `integration-tests/http/worker-api.integration.test.ts` (#320): the split claim and the three Worker
  calls with the rules of the credential; `integration-tests/compatibility/worker-api-contract.integration.test.ts`:
  the real answers against `contracts/worker-api.v1.json`; `src/jobs/worker-credential*.test.ts`: the
  credential and its queue side (also on Postgres in CI).
- `token-auth.test.ts`, `requests.test.ts`, `redact.test.ts`, `claimed-keys.test.ts`, `project-claim-guard.test.ts`: unit tests.
- The harness is `src/test-support/runner-api-harness.ts`; `projects: true` wires the guard and the
  options like the running server (real project service and review settings), otherwise every job may
  run and has no extra options.
