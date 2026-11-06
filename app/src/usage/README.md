# Usage records

One row per job in `usage_records` (migration `20261014150000_create_usage_records`; epic #268, issue #272): what the
run consumed, in a form that can be counted atomically with the decision to start a run and read incrementally by
an outside service. The job's own `result` still holds the full usage for showing one run; this table is for
counting. It measures nothing itself: it stores the `usage.costUsd` that the runner reports, which is exact for both review kinds: the sum of the charges the model provider stated for every call, `null` when any is missing (#267 for Dynamic, #274 for Diff; `runner/README.md`).

| File                                             | Role                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `usage-records.ts`                               | Pure: the states, `costUsdToMicroUsd`, `settlementOfOutcome`, `keyModeOfAccessSource` |
| `../db/repositories/usage-records-repository.ts` | Scoped to one workspace: `reserve`, `setKeyMode`, `settle`, `get` and the three reads |
| `enforce-entitlements.ts`                        | Pure: `decideAdmission`, the order of the checks of a claim (below)                   |
| `unknown-cost-alert.ts`                          | Pure: the one log line for a run that settled without a cost (#361, below)            |
| `../db/repositories/usage-feed-repository.ts`    | Instance level: the feed of settled records and the count of unknown costs (#385)     |
| `plan-view.ts`, `usage-summary.ts`               | The plan page's view of a workspace and the read that builds it (#282, below)         |
| `http.ts`, `shared.ts`, `ui/`                    | The polling answer of the plan page, its wiring and the page (#282, below)            |
| `../db/repositories/claim-admission.ts`          | Instance level: resolves the entitlements inside the claim transaction and decides    |

## Columns

`id` (a text identifier; the cursor of the page of settled records is `(settled_at, id)`, so the id only has to be unique),
`workspace_id`, `job_id` (unique), `review_kind` (`diff` or `dynamic`, copied from the job), `key_mode` (`own` when the
job ran on the workspace's key, `managed` when it ran on the operator's: the `source` of the resolved LLM access),
`model_tier` (the managed tier of a run from before the catalog, `low`, `medium` or `high`, #280; **nothing writes it since #432** and it is null for every newer run and for a run on the workspace's own key. The name only, never the model behind it; it stays for one release and is removed with the other tier data, #434), `state`, `cost_micro_usd` (the reported `costUsd` times one
million, rounded half up; null when unknown), `prompt_tokens`, `completion_tokens` (null when unknown; all three are 32 bit integers, a larger number is stored as unknown), `reserved_at`,
`settled_at`, `settled_reason` (null unless the record was settled without a report of its run: `no_result`). The table checks the states, the key modes, that only a settled record has a time and a measurement,
and that amounts are not negative.

## Life of a record

```
claim --> reserved --complete with usage (failed or not), or a run that succeeded--> settled   (counts, with cost and tokens)
                   --job ended with no result from a runner that held it---------> settled   (counts, cost and tokens unknown, reason no_result)
                   --failed without usage, or ended before any runner began------> void      (does not count)
                   --superseded while it ran (#397)-----------> still reserved, marked `superseded` (not a run of the quota)
                        --the Worker reports-----------------> settled  (cost and tokens as reported, reason superseded)
                        --no report within window + grace-----> settled  (cost and tokens unknown, reason superseded)
```

- **A superseded run (#397).** A newer push replaced a run that was running (`src/jobs/README.md`, "Supersession"). Its
  record is marked at that moment (`settled_reason = 'superseded'` on the still `reserved` record) and from then on:
  - it is **not a run of the free quota**: `countByKind` (the run limits at claim, the plan page) and the summary's
    `recordCount`/`settledCount` leave it out, and `voidEndedJobs` and the sweep leave it alone while it drains
    (the summary lists such runs in `supersededCount`);
  - what it measured **is usage like any other**: the Worker's report settles it with the cost and tokens it reported
    (an exact cost when every call was priced), billed like the cost of any run (`usage_records`, the feed, the
    sums that the cost limits watch). An unknown cost stays unknown, adds nothing to a sum and is never billed
    (it is raised as an unknown-cost settlement like any other, #361); a report that shows no model call
    voids the record;
  - the claim of a superseded run lasts 240 seconds (a Worker learns of the push at its next heartbeat, at most 60
    seconds, then drains for at most 120, plus a margin; `src/db/supersede-timing.ts`, stated in the contract as
    `SupersedeTiming`), and a report is taken for 60 seconds more. A Worker that uses its whole drain is therefore
    billed its exact cost, whether or not some claim expired leases in between;
  - if no report comes within window and grace, the record settles with an unknown cost and unknown tokens (the
    request in flight may have been charged and nobody can say). A report that comes after that is refused (`409`): a
    record is settled once, and a reader of the usage feed may have it. The unknown cost is raised once, by the sweep
    that settled it, and a report that changes nothing raises none.
    The feed shows `reason: "superseded"` (`contracts/operator-api.v1.json`), so a billing reader can tell it from a normal
    run. The cost limits still apply to it: its known cost counts towards `managedCostLimitMicroUsd` or
    `ownKeyCostLimitMicroUsd` of the period it started in.
- **Reserve.** `claimNext` inserts the record in the transaction of the claim, so a job a runner holds always has
  one. A job claimed again after a lost lease keeps its record (`job_id` is unique): it never counts twice.
  The record is reserved with the key mode the claim decided in that transaction (#496: the entitlements', or the workspace's
  own choice while billing is on); the claim route, the Worker's fetch and the settlement read it from the record and never
  decide it again, so a choice made after the claim does not reach the run. A job claimed again after a lost lease keeps its one
  record and takes the key mode of the new claim (`setKeyMode`, only on a `reserved` record).
- **Settle.** `complete` settles the record from the result, in the transaction that ends the job:
  a reported usage settles it with its cost (possibly null: an unknown cost is `settled`, never `void`, and never
  zero) and tokens, whatever the outcome; a run that succeeded without any usage is settled with everything
  unknown; a run that failed without usage (checkout, configuration, a runner that never reached the model) is
  `void`. A run that failed after it used the model reports its usage in the failed result (#273: the runner puts
  it there, see `runner/README.md`), so a pull request that always fails near the end is counted at every attempt
  and cannot be retried at the operator's cost without anybody seeing it. A failed result whose usage shows no
  model call at all (a runner of an earlier release reports one for a command that never reached the model) is
  `void` too.
- **No result.** A job that a runner held and that then ended without any result (its lease ran out on the last
  attempt, `lease_expired`; it ran past the hard limit, `timeout`; its runner was shut down and gave it back on the
  last attempt, `runner_shutdown`) is `settled` with an unknown cost and unknown tokens and the reason
  `no_result` (`settled_reason`): the model may have been used, and counting it is the conservative reading. It is
  never `void`. A lease that runs out on an earlier attempt ends nothing: the job is tried again and its record
  stays `reserved`. Only the usage of the attempt that ends the job is recorded; the cost of earlier attempts that
  were lost is not (a follow-up of #273).
- **A job process the runner's loop ended.** The loop reports the process it had to end (hard timeout, killed by a
  signal, no result line, a result that disagrees with its exit code) with `errorReason` `no_result_from_process`,
  and a failed result with a usage it could not read with `unreadable_usage`; the Diff watchdog uses the first, and
  so does a Diff command that fails with no usage while a model request it sent was in flight or came back
  uncounted (PR-Agent counts only the calls that came back; #363). A
  failed result without a readable usage and with one of these reasons, or whose usage was sent and cannot be read,
  settles as `no_result` too. A runner of an earlier release never sends the reasons and an app of an earlier
  release ignores them: both stay void, as before.
- **Void without a report.** Every other way a job ends without `complete` made no model call anybody knows of
  (a cancellation at claim time, a release before the runner began, such as `launch_failed` of a Dispatcher or a
  failure of the runner API itself, a cancellation or replacement while the job waited again, a job that was never
  dispatched): its `reserved` record is voided in the same transaction as the transition. The runner side does both
  this and the `no_result` settlement with `closeRecordsOfEndedJobs` (`usage-records-sweep.ts`, also run when
  Dynamic Review is switched off); the scoped job repository (`cancelWaiting`, and the replacement in `enqueue`)
  voids with `voidEndedJobs()`: a job that waited never ran.
- **Immutable.** Every statement that changes a record only touches a `reserved` one; a repeated completion
  (`alreadyCompleted`) changes nothing. A job that was claimed before this table existed has no record; its
  completion creates one in its final state (key mode `own`, dated from the job's claim).
- Runs of workspaces without any entitlement are recorded too. Nothing here changes what a run does.

`reserved` and `settled` count towards a limit (#277, below), `void` does not.

## Billing and the record (#498)

While billing is on (`src/billing/README.md`, "Start, settle"), the record says whether its money is still to be settled (`billing_state`, #605: `open` from a claim
with billing on, `settled` after the one settlement, null for a job claimed with billing off), and the transaction that settles or voids the record, whichever path it
is, writes the `usage` entry of the price (none when the run is free). Nothing is held at the claim. The record keeps reporting the **real** model cost
(`cost_micro_usd`, the operator feed, the sums of the limits); the journal holds the price (AI cost times A plus started minutes times B). A record
settles once and so does its entry: a repeated completion changes neither. With billing off none of this runs.

## Run quotas and the plan page while billing is on (#499)

While billing is on (`isBillingOn`: the switch is set and the adapter is ready) the per-period run limits of an entitlements row are not enforced and the plan
and usage page shows no "Reviews in this period" rows: `PlanView.runs` is `null` and `readPlanView` does not even count the runs. The plan label, the start
of the period, the paused notice and the cost-limit bar (the own-key limit of #361 and the managed one) stay. The monthly total limit and the hourly brake
that replace the quotas are in `src/billing/README.md`, "Limits at claim". The operator API's limits are not touched (ADR 0006, section 6, no. 3 is still
open).
Since #505 the page itself is not shown while billing is on: `/w/<slug>/settings/plan` leads on to the billing page (`/w/<slug>/settings/billing`, `src/billing/README.md`, "The workspace page"), which takes its place in the settings navigation. The data route `GET /api/w/<slug>/plan` is unchanged.

## Limits and suspension at claim (#277)

What an operator allows a workspace (`src/workspaces/README.md`, "Entitlements") is enforced where a job is claimed,
in the transaction of `claimNext` (`runner-jobs-repository.ts`), after the oldest due job was taken and **before** its
record is reserved. That is the only way the check and the reservation are one step: two claims never both pass the
last unit, and a refused job leaves no record. Every way a job is claimed goes through it: the claim of a runner, the
split claim of a Dispatcher and the claim by job id.

`decideAdmission` decides in this order, the first refusal wins:

1. Entitlements that exist but cannot be read: `entitlements_invalid`. Never "unlimited", never an exception.
2. `suspended`: `workspace_suspended`.
3. The run limit of the job's kind (`diffRunsPerPeriod`, `dynamicRunsPerPeriod`): the records of that kind (`reserved`
   or `settled`) reserved at or after `period_start` at or above the limit refuse with `quota_exhausted` (detail
   `diff_runs` or `dynamic_runs`). `0` allows none, `null` is unlimited and is not read. **Skipped while billing is on
   (#499, ADR 0006, D5):** the claim passes `runQuotas: false` then, and the limit is neither read nor counted (`readsUsage`
   takes the same option, so a workspace with nothing but a run limit takes no lock). With billing off nothing changes: an
   operator keeps the limits of epic #268. Steps 1, 2 and 4 are not affected by billing.
4. The cost limit of the key the job runs on (#361): `managedCostLimitMicroUsd` for a workspace whose key mode is
   `managed` (the operator's key), `ownKeyCostLimitMicroUsd` for one whose key mode is `own` (its own key). The sum
   of the settled `cost_micro_usd` of **that key mode** reserved at or after `period_start` at or above the limit
   refuses with `quota_exhausted` (detail `managed_cost` or `own_key_cost`). A settled run with an unknown cost adds
   nothing to the sum, never a zero and never a guess, and it still counts in 3; the operator API's summary lists
   such runs apart (`unknownCostCount`), and every one of them is reported when it settles (below). Neither limit
   blocks a job of the other key mode.

A refused job ends `failed` with the code, in the claim transaction: no attempt is counted, no runner hears of it, no
credential or key is created, no record is written, and its holder, start time and lease are cleared (the Runs list
shows no duration for a run that did not start). The claim then tries the next job.
**Fairness:** a suspension and unreadable entitlements do not depend on the job, so they fail **all** the due jobs of
that workspace in one statement (and void the records of those that lost a lease), and a backlog never delays another
workspace. A refusal for a limit is decided per job (the count changes with every claim) and is bounded: at most 25
per call, then the call answers "nothing" and the runner asks again. The detail is only logged (`onRefused`, `[queue] job=... refused at
claim: quota_exhausted (diff_runs)`; a callback that throws is logged as `claim_refusal_log_failed` and ignored, so a
claimed job is never orphaned); the stored code is all the Runs pages get. The pull request notice (#281, `src/refusal-notices/README.md`) is posted
for `quota_exhausted` and `workspace_suspended` after the claim committed, once per pull request and period: the
refusal carries the `periodStart` it was decided under for that (`ClaimRefusal.periodStart`), and the notice does
not tell the three limits apart, so no detail is stored. A job claimed again after a lost lease keeps the one record it has and is **not counted against itself**
(it is left out of its own count), so it runs at a limit that its first claim used up; suspension and unreadable
entitlements still stop it, and its record is then voided.

- **Period.** A run belongs to the period it started in (`reserved_at`), for the count and the cost alike. Moving
  `period_start` forward (an operator's reset) takes effect on the next claim.
- **The cost limit is a soft cap and is not exact under concurrency.** Cost is only known when a run settles, so runs
  in flight are not in the sum (the run limits are exact, the cost limit is not). A run that starts below the limit may
  end above it by what the runs in flight at that moment cost; the overshoot is bounded by the number of concurrent
  runs times the per-run bounds, and it is recorded as usage like any other. A run with an unknown cost is not bounded
  at all by this limit.
- **Which runs a cost limit watches (#361).** Each limit watches one key mode, **decided by the record, not by the
  entitlements now**: the sum of a key mode counts the settled records whose own `key_mode` is that mode, and the
  claim checks the limit of the key mode the job will run on. That key mode is known at claim time: the key mode of the
  entitlements picks the key (#276, `keyModeForJob`); while billing is on it is the workspace's own choice, our models by default (#496). The check uses the entitlements the claim itself read inside its
  transaction, and reserves the record with that key mode in the same transaction; the key the job is given follows the
  record (#496), so a limit counts exactly the runs that spent that key and there is no window between the admission and
  the key.
  A workspace switched between `own` and `managed` in the middle of a period keeps the records of each mode
  under the limit of that mode: the own-key records stay under `ownKeyCostLimitMicroUsd` while it is `managed`, and
  come back into play if it is switched back. A key mode `managed` whose operator key is missing is not a quota matter
  (#276) and keeps its own code (`llm_not_configured`).
- **`ownKeyCostLimitMicroUsd` (#361)** is allowed with either key mode. **A managed cost limit next to the key mode `own`
  is read by nothing.** An operator can no longer write that shape (`cost_limit_requires_managed_key`, 422); an entry
  stored before that keeps working exactly as it did, the limit is ignored, and the claim logs it once per workspace
  and process (`onIgnoredCostLimit`). The own-key limit has no such rule: next to `managed` it is dormant until the
  workspace is switched back, and it keeps counting the own-key records it already has. Entries stored before the limit
  existed read it as `null` (unlimited, `LIMITS_ADDED_LATER`).
- **Unknown cost (#361).** A settled run with an unknown cost adds nothing to either sum, so a workspace whose runs all
  settle without a cost is bounded only by its run limits: **the cost limits do not bound unknown-cost runs.** Each such
  settlement is reported, once the transaction that made it committed, with one log line carrying the job id and the
  workspace id and nothing else (`unknownCostAlertLine`, `onUnknownCostSettled`; no figure, no model, no name): a run
  that settled with a usage whose cost is missing (`complete`), and a run that ended with no result (`no_result`: the
  sweep returns what it settled). A lost lease that is requeued settles nothing and raises nothing. A queue built on a database
  that is already a transaction reports nothing, as it cannot see its caller's commit. The operator API counts the same runs per workspace and key mode (below), for a
  reader that polls instead of reading logs. Alerting on the line (or the count) is the operator's way of watching
  what the limit cannot bound.
- **Subscription turns (#856).** A turn that ran on the Claude login of a customer's device reports `costUsd: null` with the
  basis `subscription`. Its record is settled with the tokens, no cost and `cost_basis = 'subscription'`: it is not an unknown cost
  (no alert, not in `unknownCostCount` or the operator feed of unknown costs), adds nothing to a sum and is never billed as AI
  cost. The estimate at API prices lives in the job's result and is shown on the Runs page as "≈ $X through a subscription".
  The minutes of the device are billed as for any job (owner question open).
- **Locking.** The claim already runs under the instance gate lock of the queue, which serializes claims. The workspace row is also locked `for no key update` (an
  insert that only references it does not wait), so the count stays exact if the gate is ever narrowed. The lock and
  the count are taken only when a limit applies to the job (`readsUsage`: the limit of its kind, or the cost limit of
  the key mode it runs on); a workspace that is unlimited, suspended, unreadable or without such a limit reads no usage
  and takes no lock (a `null` limit is never read). What every claim pays is three point reads (its row, or the instance default, and the job's own
  record).
- **Indexes.** The count is one query on `usage_records_workspace_reserved` (workspace, kind, reserved time). The cost
  sum only runs for a workspace with a cost limit for its key mode and reads that workspace's records of that key
  mode in the period.
- **Order with the project guard.** The entitlements are decided inside `claimNext`, before the claim guard (a
  project that was switched off) sees the job. A job of a suspended workspace whose project is also switched off
  therefore fails as `workspace_suspended` instead of being cancelled as `project_deactivated`. Switching a project off
  cancels its waiting jobs eagerly, so the guard only matters in a race; a test pins the order.
- **Mixed versions.** Nothing in the schema changed. An app instance from before #277 still claims, reserves records
  and ignores the entitlements; it shows an unknown code (`quota_exhausted`) with the general sentence if it ever lists
  a job that a newer instance refused. During a rolling upgrade a job claimed by an old instance is not checked.
- **Mixed versions of the own-key limit (#361).** No schema change: the limit lives in the JSON of the stored limits.
  An instance from before it reads an entry that holds it (reading ignores a limit it does not know) and claims
  without checking it, so **upgrade every instance before an own-key limit is set**; an entry stored before it reads the
  limit as `null` on a new instance. Writes must state it: a `PUT` that lacks the key is refused (`limits_invalid`) by
  a new instance, and a `PUT` that carries it is refused by an old one (a write refuses an unknown limit, so a typo
  cannot pass), so an external service updates its writes together with the rollout.

## Reads

Repository functions, the operator API that serves them (#278, `src/operator-api/README.md`) and the plan page of a
workspace (#282, below).

- `countByKind(since)`: records that count (`reserved`, `settled`) reserved at or after `since`, per review kind.
- `sumSettledCostMicroUsd(since, keyMode)`: the cost of settled records of the runs on that key mode (`own` or `managed`,
  the record's own `key_mode`) reserved at or after `since` (a run belongs to the period it started in, for the count and
  for the cost alike); an unknown cost adds nothing.
- `pageSettled({ after, limit, settledBefore?, from?, to? })`: settled records ordered by `(settled_at, id)` after a
  cursor, with the cursor for the next page. Never `reserved` or `void` records. `settledBefore` keeps back what was
  settled at or after that time (the operator API passes now minus the safety lag); `from` (included) and `to`
  (excluded) filter on `settled_at`.
- `summarize({ from, to })`: the runs that started in `[from, to)` (the period rule of the counts), per review kind and
  key mode: runs that count, settled runs, the sum of the known cost, settled runs with an unknown cost.
- The instance level `usage-feed-repository.ts` (`pageSettled({ after, limit, settledBefore? })`) is the same page for
  **every** workspace, for the operator API's feed; its `unknownCostCounts({ from, to, after?, limit })` counts the
  runs that settled without a cost per workspace and key mode (#385, below). It is classified as instance level in `scoping.test.ts`: it only
  reads, and every record names its workspace.

### The feed and the safety lag

A record's `settled_at` is stamped with the settling app instance's clock (`settle()` reads it just before the update),
and the record becomes visible when its transaction commits; if `settle` runs inside a longer outer transaction, the
whole gap to the commit counts against the lag. With concurrent writers (Postgres) two settlements can therefore become visible in the reverse order of
their stamps, and a reader that already moved past the later stamp would never see the earlier arrival. The operator
API only serves records settled **more than 60 seconds ago** (`USAGE_SAFETY_LAG_MS`, a validated instance constant:
`operator-api/contract.ts`), so a settlement may take up to that long to commit and still never be skipped. The
assumption is stated, not enforced: a transaction that stays open longer than the lag, or a clock that differs between
two app instances by more than the lag, could still reorder two records. Readers treat `id` as the idempotency key
anyway. `integration-tests/http/operator-api-usage.integration.test.ts` and
`usage-feed-repository.integration.test.ts` show both the hazard (a reader without the bound misses a late record) and
the guarantee.

Records are small and kept; there is no retention job.

## Counting unknown costs (#385)

A cost limit adds up known costs only (above), so the operator has to be able to see the runs it cannot bound,
**per workspace and per key mode**: the key mode decides which limit is leaking (`managedCostLimitMicroUsd` for the
operator's key, `ownKeyCostLimitMicroUsd` for the workspace's own), and the log line names neither the key nor a
rate. The count is a plain integer for each `(workspace, key mode)` and period, served by the operator API
(`GET /api/operator/v1/usage/unknown-cost`, `src/operator-api/README.md`), so an external service can alert on it
without log access.

- **The records are the count.** There is no second store. The counter lives where the settlement happens because it
  _is_ the settled record: a `settled` record whose `cost_micro_usd` is null. The settlement writes that record in
  the transaction that ends the job (`complete`) or that sweeps a job that ended with no result (`no_result`), so a
  count read from the records cannot drift from them, cannot count a rolled back transaction, and cannot count a
  settlement twice (a record is immutable once settled and a job has one record). A separate counter row would have
  to be incremented in that same transaction and could only ever disagree with the records; a read that groups them
  cannot.
- **What counts.** A `settled` record with an unknown cost: a run that reported its usage without a cost, a run that
  succeeded without any usage, and a run that ended with no result from its runner (`settled_reason = no_result`).
  A `reserved` record (still running), a `void` record, a record with a known cost (a cost of `0` is known) and a job
  that lost its lease and was requeued (its record stays `reserved`) never count. A repeated completion changes
  nothing.
- **The period rule is that of the summary and of the limits:** a run belongs to the period it started in
  (`reserved_at`), so a figure here equals the `unknownCostCount` of the workspace's summary added up over the review
  kinds of a key mode. It is a total, not a position in a feed: there is no safety lag. The count of a period can
  grow until its last run has settled; an alert on a rate reads the same period twice and compares.
- **The key mode is the record's own,** corrected from the resolved LLM access before the run (`setKeyMode`), so it is
  the key that was spent, not the one the entitlements name today.
- **Reading.** `usageFeed.unknownCostCounts({ from, to, after?, limit })` in the instance level
  `usage-feed-repository.ts` (it only reads, and every row names its workspace): one grouped query over the records of
  the period, paged by whole workspaces (`limit` workspaces after the workspace id `after`), ordered by workspace id then
  key mode. A workspace and key mode without an unknown cost is not listed. One workspace's own figures are the
  `unknownCostCount` of its summary; a workspace never sees another's.
- **Off by default.** Nothing is written for this and no setting exists: an instance without entitlements settles
  records as before, and the read is a path of the operator API, which answers 404 until `OPERATOR_API_TOKEN` is set.
- **No index yet.** The read filters the period on `reserved_at` across every workspace; no index leads with it, so it
  scans the records of the period's range as far as the planner can. Records are small and the call is a poll, not a
  hot path; add a partial index on unknown-cost settled records if a deployment polls often over a very large table (hundreds of thousands of records, or a poll more than once a minute). Suggested shape: `(workspace_id, reserved_at) where state = 'settled' and cost_micro_usd is null`. The query must then write `state = 'settled'` as a literal (`sql.lit('settled')`, as `voidEndedJobs` does for its partial index): Kysely binds a plain value as a parameter, and the planner does not choose a partial index for a bound value.
- **Mixed versions.** No schema change and no new setting. An instance of an earlier release has no such path (the
  operator API answers `404 not_found`); a reader that polls it during a rollout must treat that as "not yet", and
  read the summary of each workspace meanwhile. The log line is unchanged.

## The plan page (#282)

`/w/<slug>/settings/plan` ("Plan and usage", a sub-page of the workspace settings) says what the workspace may use, what
it has used in the current period and whether reviews are paused, **read-only for every member** (`view`). Its data
route is `GET /api/w/<slug>/plan`, which the page polls (the Runs pages' mechanism, `useLiveSnapshot`: every 10
seconds while the workspace has limits, every 30 while none apply, a failed update keeps the last data and says so, a
lost session stops it). The answer is `Cache-Control: no-store`; a workspace the person does not belong to is the answer
of a path that does not exist (page and route), like every workspace address.

`readPlanView` (`usage-summary.ts`) reads the effective entitlements (`readEffectiveEntitlements`, the claim's own
read) and, only for a workspace that has them, the usage since `period_start` through the repository of #272: the same
count (`countByKind`: `reserved` and `settled`, never `void`) and the same period rule (`reserved_at`) as the claim,
so the page and a refusal always agree. `buildPlanView` (`plan-view.ts`) is the boundary to the browser; it copies
named fields only:

| State        | When                                             | What the page says                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `unlimited`  | no entitlements (no row, no instance default)    | "No limits apply to this workspace." No navigation entry (the page is still there by address).                                                                                                                           |
| `unreadable` | entitlements exist but fail the checks of a read | That the limits cannot be read and reviews are not started. Nothing else (the claim refuses with `entitlements_invalid`).                                                                                                |
| `limited`    | the rest                                         | The plan label (operator text, shown as text), the start of the period (never an end: the app does not know it), "3 of 5" and "1 of 2" per kind or "no limit", a notice when reviews are paused, and the cost bar below. |

- **Counts.** "N of limit" or "N used, no limit"; "limit reached" is said in words when `used >= limit`.
- **The cost limit is shown as a percentage, never as an amount.** A bar (`role="progressbar"`, whose name and
  `aria-valuetext` are the visible sentence "62 % of the usage limit used") appears only when the
  key the workspace runs on has a cost limit (#361): `managedCostLimitMicroUsd` for the operator's key (`managed`),
  `ownKeyCostLimitMicroUsd` for its own key. The claim watches nothing else, and a managed limit next to the key mode
  `own` is read by nothing (above), so it is not shown; neither is the limit of the other key mode. The percentage is
  the settled cost of that key mode in the period divided by the limit, **rounded down** (100 means the limit is reached, as the claim refuses at
  `used >= limit`) and **at most 100**: a run that was in flight when the limit was reached may take the total past it,
  and the page does not claim to know by how much. The page says that it is not exact (soft cap). A limit of 0 reads 100. Settled runs of that key mode whose cost is unknown are counted apart ("2 finished reviews could not be measured and are not in
  this percentage"), never as zero. Neither the API nor the DOM holds an amount, a currency or the measured cost, in
  any unit; the measured sum does not leave `buildPlanView`.
- **A managed workspace** is told that the instance provides the models. The page never shows a model, a tier, a key or
  anything of a job, the reason of a suspension, or whether the entitlements are the workspace's own or the instance
  default; a test looks for each in the answer and in the markup.
- **Navigation.** The settings sub-nav lists "Plan" (before "Advanced") only while the workspace has entitlements
  (`planPageAvailable`: its own row or the instance default, readable or not). Every settings page asks once per request.
  The address is the one the refusal notice and the operator's page lead to (`planReturnPath`, `src/plan-handoff/`).
- **"Manage plan"** (#284) is on this page too, for an Owner or Admin while the instance has a plan management page.
- **Mixed versions.** No schema change, no new setting. An app of the previous release has no plan page and no route
  (both answer as a path that does not exist), and its General settings keep working; the plan address the notice and
  the operator's page use is only set once a plan management page is (`src/plan-handoff/README.md`: upgrade every
  instance first).

## Tests

The count of unknown costs (#385): `../db/repositories/unknown-cost-counts.integration.test.ts` (Postgres:
known and unknown cost, both key modes, `no_result` once, a lost lease, a rolled back transaction, the period, another
workspace, concurrent completions, paging) and the operator API's usage tests
(`integration-tests/http/operator-api-usage.integration.test.ts`, the contract test and the route-file test).

The own-key cost limit (#361): `enforce-entitlements.test.ts` (the decision and which limit reads which sum),
`jobs/claim-limits.integration.test.ts` (the claim on Postgres: reached, the other key mode, a switch in the
middle of a period, unknown cost, `0` and `null`, a moved period, a lost lease, a race at the soft cap, another
workspace, the unknown-cost alert), `unknown-cost-alert.test.ts` (what the line may say),
`usage-records-repository.integration.test.ts` (the sum per key mode), `workspaces/entitlements-validation.test.ts` and
the operator API contract test (`integration-tests/compatibility/operator-api-contract.integration.test.ts`).

`usage-records.test.ts` (rounding and settlement rules), `usage-records-repository.integration.test.ts` and the
Postgres twin, `integration-tests/http/runner-api-usage.integration.test.ts` (claim, completion, lease loss),
the rows of `scoped-isolation.integration.test.ts`, and the operator API's usage endpoints
(`usage-feed-repository.integration.test.ts`, `integration-tests/http/operator-api-usage.integration.test.ts`). The plan
page: `plan-view.test.ts` (the percentage and what the view leaves out), `usage-summary.integration.test.ts` (real
records: period, `reserved` and `void`, kinds, key modes, unknown cost), `ui/plan-page.test.tsx` (the page, the bar's
text, no colour-only state, the polling), `ui/plan-page.integration.test.tsx` (the page file with the real wiring),
`integration-tests/http/plan-route-file.integration.test.ts` and the "GET plan" row of
`workspace-isolation.integration.test.ts` (the route).
