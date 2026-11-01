# Job queue

A job is one requested run of a command (`review`; `/ask`, `/improve` and `/describe` were removed)
on one pull request.
The queue lives in Postgres (table `jobs`, migration `20261010191500_create_jobs`); runners take jobs
from it through the runner API (CR-28), webhooks and the UI put jobs in. Everything goes through
`createJobQueue` (`job-queue.ts`, scoped to one workspace) and `createRunnerQueue` (`runner-queue.ts`, the
lease side, for the whole instance). They call the jobs repositories
(`src/db/repositories/jobs-repository.ts` and `runner-jobs-repository.ts`, the only code that changes the
table). The running server gets its queues from `jobQueueFor(workspaceId)` / `getJobQueue()` (the
workspace the signed-in user works in) and `getRunnerQueue()` (`shared.ts`). The pages that show runs read the table through
`src/db/repositories/runs-repository.ts` (read only; `src/runs/README.md`).

| File                  | Role                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-queue.ts`        | `createJobQueue(db, workspaceId, options)`: `enqueue`, `cancelWaitingForRepository`, `discardWaitingForPr`, `discardWaitingAutomaticForPr`, `get`, `list`. A job of another workspace is not there for it                                                                                                                    |
| `runner-queue.ts`     | `createRunnerQueue(db, options)`: `claimNext`, `heartbeat`, `complete`, `release`, `cancelClaimed`, `expireStaleJobs`, `get`. **Not scoped**: runners serve the whole instance, a claim hands out the oldest due job of any workspace, and every change is fenced by the lease token. The `Job` it returns has `workspaceId` |
| `../db/job-status.ts` | The statuses and the table of allowed transitions; the repository builds its update conditions from it                                                                                                                                                                                                                       |
| `job-input.ts`        | `validateEnqueueInput`: field level checks before anything is written                                                                                                                                                                                                                                                        |
| `job-types.ts`        | `Job`, the inputs and results, the trigger kinds and the error codes the queue itself writes                                                                                                                                                                                                                                 |
| `../db/job-limits.ts` | Lease, maximum runtime and maximum attempts, with their defaults                                                                                                                                                                                                                                                             |
| `shared.ts`           | `jobQueueFor(workspaceId)`, `getRunnerQueue()`: the queues of the running server. `jobQueueFor` attaches the dispatch hook (below)                                                                                                                                                                                           |
| `errors.ts`           | `JobQueueError` with the stable codes `JOB_INPUT_INVALID` (with `fieldErrors`) and `JOB_REPOSITORY_UNKNOWN`                                                                                                                                                                                                                  |

Every job belongs to the workspace of its repository (`jobs.workspace_id`; the database refuses a job
whose repository is in another workspace, which `enqueue` reports as `JOB_REPOSITORY_UNKNOWN`). Jobs
refer to `repositories`, not to projects. Whether a repository has an active project is checked
by the code that enqueues (the trigger policy of the webhook handler, CR-31), not here.

## Statuses

```
queued --claim--> running --complete--> succeeded | failed
queued --newer automatic job--> superseded     running --lease lost or release--> queued (attempts + 1)
running --newer automatic job, holder understands it--> superseded (drains, #397)
queued --project off / PR closed--> cancelled  running --last attempt lost, or too long--> failed
queued --review kind changed--> cancelled
queued --claim refused by the workspace's entitlements--> failed (never runs, no attempt, no usage record; #277)
```

`succeeded`, `failed`, `superseded` and `cancelled` are final; nothing leads back from them. A
superseded job keeps `superseded_by`; a cancelled or failed job keeps its `error_code`
(`project_deactivated`, `pull_request_closed`, `review_kind_changed`, `lease_expired`, `timeout`, or
the code a runner reported).

## Entitlements at claim (#277)

`claimNext` is also where what an operator allows a workspace is enforced (`src/usage/README.md`, "Limits and
suspension at claim"). After the oldest due job is taken, inside the same transaction and before its usage record is
reserved, `admitClaimedJob` (`db/repositories/claim-admission.ts`) resolves the entitlements of the job's workspace
and decides. A refused job is ended `failed` right there, with `workspace_suspended`, `quota_exhausted` or
`entitlements_invalid`; no attempt is counted, it is never handed out, it has no usage record, its holder, start time
and lease are cleared, and `claimNext` tries the next job. A suspension or unreadable entitlements fail all the
workspace's due jobs in one statement; a limit refuses job by job, at most 25 per call, then `null`. `onRefused` (an option of `createRunnerQueue`, wired to a
log line and, for a limit or a suspension, the pull request notice of #281 in `shared.ts`) is called after the commit, once per refused job, with the code, the
period start and, for a quota, which limit. A claim by job id that is refused answers `null`, like any job that cannot be claimed. An instance whose
workspaces have no entitlements (and no default) does the same two reads per claim and nothing else.

## The review kind of a job (#195)

A job is queued for exactly one review kind, `diff` (PR-Agent) or `dynamic` (the read-only agent of
the epic), stored in `jobs.review_kind`. It is resolved when the job is enqueued, from the project's
stored settings, **inside the enqueue transaction** (`review-kind.ts`). Before resolving the kind,
`jobs-repository.ts` locks the workspace-scoped repository row, the same row settings saves lock
with `FOR UPDATE` on PostgreSQL (including before the first project row exists). The lock is retained through commit, so a concurrent kind change
can never leave a stale-kind job waiting. A producer never passes a kind; a repository without a project row is Diff.

The rollout gate: Dynamic Review is only **queued** when the instance setting `dynamic_review` says
`{ enabled: true }` (`dynamic-review-gate.ts`), default off. With the gate off, a
Dynamic project still gets a run, and that run is created `failed` with `dynamic_review_disabled` —
visible in Runs, never a silent Diff review and never a Dynamic row a previous-release app could
claim. PostgreSQL queue writers take the instance gate advisory lock before row locks: shared for
enqueue/settings, exclusive for gate changes and runner transitions; multi-row operations then lock
jobs by ascending id (full order: `contracts/README.md`). Disabling cancels queued Dynamic work and
leaves running jobs, their leases/heartbeats and PR slots unchanged. A release or lease expiry with
the gate off fails Dynamic work with `dynamic_review_disabled` instead of requeueing it. Use the
instance settings repository setter; a raw SQL update bypasses this boundary. The instance admin
switches it on the portal's Instance page (the Dynamic Review card, `src/admin/`), which uses that
setter; there is no CLI. See `contracts/README.md` for the
upgrade/rollback order.

The kind widens what the queue treats as "the same job": the automatic per-head uniqueness, the
comment/manual duplicate check and supersession all include it, so a Diff job and a Dynamic job of one
pull request are two jobs. Per-PR serialization (one running job per pull request) is **not** split by
kind: two waiting kinds of one pull request still run one after the other.

A runner only ever claims a kind one of its engines can run (`runner-capabilities.ts`,
`runner-queue.ts`): the claim filters on `review_kind` in the atomic statement, so an ineligible job is
never selected — it keeps waiting without an attempt being counted and without credentials being
created. A runner advertises `opencode` only when it is the Dynamic runner and its startup self-check
passed (a default runner never does), so a Dynamic job that no such runner claims is
**cancelled** after `noCapableRunnerMs` (default 30 minutes, `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS`) with
the stable code `no_capable_runner`, **unless a runner of the engine is busy** (#752): while a job of the same kind is `running`, or ended after a
claim within that deadline by anything but the reaper (`lease_expired`, `timeout`, `command_removed` are no proof a runner worked), the job keeps
waiting, up to the absolute limit `noCapableRunnerAbsoluteMs` (3 hours, `DEFAULT_NO_CAPABLE_RUNNER_ABSOLUTE_MS`; not a setting; an
operator's `noCapableRunnerMs` above it wins). The pass runs after the lease and runtime passes of `expire`, so a crashed or hung runner's job
is not `running` when it is looked at; the lookup is served by the partial index `jobs_ended_after_claim` and `jobs_status_run_after`. That is the one exception to "waiting forever": it is a bounded
outcome, not a failed review, and no attempt is counted. This initial-claim deadline starts at the
later of creation and `run_after`, so a scheduled delay does not consume the waiting budget. Jobs
already claimed (`attempts > 0` after lease loss/release) follow the existing lease/attempt/backoff
policy instead, independently of which runner polls first.

A hosted deployment (`RUNNER_DISPATCH=webhook`, #316) has a second bound, from the cron sweep (#328,
`src/dispatch/README.md`): a job that was queued for `RUNNER_DISPATCH_GIVE_UP_SECONDS` (default 3600) without any
Dispatcher claiming it **fails** with `dispatch_unavailable` (`failUndispatched` of the runner queue), with no attempt
counted; the time counts from the later of `run_after` and the last time the job was queued. In poll mode this is off
unless the operator sets the variable. The same sweep expires lapsed leases (`expireStaleJobs`), which a claim did
and, with nobody claiming, nothing else would.

When the project's review kind changes, #194's `ReviewSettingsHooks.onProjectSettingsChanged` calls
`cancelWaitingForReviewKindChange` in the settings transaction: the project's waiting jobs become
`cancelled` with `review_kind_changed`, a running job finishes, and a rejecting hook rolls the
settings change (and the cancellation) back. The same happens when the review kind of the workspace defaults changes (#676):
`onWorkspaceDefaultsKindChanged` cancels the waiting jobs of every project that stores no kind of its own, in the transaction
that writes the defaults. That transaction first locks every repository row of the workspace `FOR UPDATE` in ascending id (the lock
an enqueue takes before it reads the default) and only then reads which projects follow, so a review that is being queued meanwhile
is either cancelled with the others or reads the new kind. The hook is `createJobReviewSettingsHooks`, wired in `review-settings/shared.ts`.

## The implementer kind (#752)

A turn of the Implementer (part of #745, the Software Factory deployment) travels through this queue as a job of the kind
`implementer`, so claim, lease, heartbeat, release, stop, dispatch, usage records and entitlements are the ones of every job.
`createJobQueue(...).enqueueImplementerTurn` makes the session, its first turn (`src/db/repositories/implementer-repository.ts`) and
the job in one transaction. The `jobs` table is shaped like a pull request review, so **`db/implementer-job-shape.ts` is the one place
that writes the pull request columns** of a turn:

| Column                                         | Value                                                                                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review_kind` / `trigger_kind` / `actor_login` | `implementer` / `manual` / the person                                                                                                                                                                             |
| `pr_number`                                    | `-slot` of the session: never a GitHub pull request, and the unique index "one running job per repository and pull request" becomes "one running turn per session" (two sessions of a repository run in parallel) |
| `pr_url`                                       | `<repository url>/tree/<branch>`                                                                                                                                                                                  |
| `head_sha`                                     | the tip of the base branch when the task was accepted                                                                                                                                                             |
| `command` / `args`                             | `review` / empty                                                                                                                                                                                                  |
| `delivery_id`                                  | `implementer:<workspace id>:<clientRequestId>`: the workspace is part of it because the unique index spans every workspace                                                                                        |

What differs from a review, and why a consumer that assumes a pull request is gated by the kind:

- **Enqueue.** Refused with `JOB_KIND_UNAVAILABLE`, writing nothing, without the capability `implementer`. The Dynamic gate is not
  consulted (it is about Dynamic Review, not a runtime flag for this kind). A repeated `clientRequestId` returns the turn it made
  (`status: "existing"`) and writes nothing; it is looked up before the session is created, and two racing requests find each other.
- **Claim.** `REVIEW_KINDS_OF_ENGINE`: the engine `implementer` serves this kind and nothing else, and no other engine serves it. A
  runner without the engine never selects the job, so no attempt is counted and no credential made. It waits for such a runner at
  most `noCapableRunnerMs` (30 minutes) when no runner of the engine is working, and at most `noCapableRunnerAbsoluteMs` (3 hours) while one is busy
  with another turn; then it is cancelled with `no_capable_runner`, as a Dynamic job is.
- **Limits.** `maxAttempts` is 1 (`IMPLEMENTER_MAX_ATTEMPTS`): a lost lease or a released claim fails the turn (`lease_expired`, the
  released reason), it is never queued again, because a second run would meet the branch the first one pushed. The hard timeout is
  70 minutes (`implementerMaxRuntimeMs`, the Dispatcher's 60 plus 10), the other kinds keep 25.
- **The session.** A job that ends without a report of its run (lease, give-up, never dispatched, no capable runner, refused claim,
  cancelled by its holder) sets the session `idle` (`idleSessionsOfEndedTurns`, called from the sweep that closes usage records and
  from `complete`), otherwise it would stay `running` for good. A report records the result with `recordTurnResult` in the transaction of `complete` (#754, `runner-api/README.md`).
- **Pull request consumers.** `cancelWaiting` (project deactivated, review kind changed, pull request closed, draft) never touches the
  kind. `previousReviewedSha` and `attemptedShas` answer nothing for it. The check run reconciler and its sweep skip it (it would
  otherwise fill the sweep's batch for good). A claim refused for the entitlements fails the turn with the code and tells the refusal
  hook its kind; the notice on a pull request is not made for it. The claim of the runner API builds its input from the turn's record (#753).
- **Usage and billing.** The record is reserved at claim with the kind `implementer` (billing off and on). For the plan's run limits,
  the rate of a minute and the model catalog it counts and costs as `dynamic` (`projectKindOf`), the engine it runs on; the journal
  entry keeps its own kind. The checks on `usage_records.review_kind` and `billing_journal_entries.review_kind` take the value
  (migration `20261030190000`).

A project still selects `diff` or `dynamic` and nothing else (`PROJECT_REVIEW_KINDS`); `JOB_KINDS` adds `implementer`.

## Enqueueing

`enqueue` runs in one transaction (the write lock is taken up front), in this order:

1. **Same delivery.** A job with the same `delivery_id` exists: it is returned (`same_delivery`). This
   makes the webhook route's claim and the enqueue safe to repeat.
   **Same comment.** The comment (`commentId`, a `comment` job) is in `job_comments` already: the job
   that answered it is returned (`same_comment`), whatever became of that job. GitHub's delivery id is
   not covered by the signature, so a captured signed comment replayed under a new delivery id would
   otherwise run its command again once the first job has finished. `job_comments` has one row per
   (repository, comment) and names the job that answers it. The row is written for every comment that
   gets an answer: for the job it created, and for the equal job it found already waiting or running
   (`already_active`), so the replay of that second comment is recognised later too.
2. **Automatic jobs** (`trigger_kind = webhook`): one per (repository, pull request, head commit,
   command) while it is waiting, running, succeeded or failed (`same_head`). A superseded or cancelled
   job frees the slot, so a commit that comes back (a force push to an old state) is reviewed again.
3. **Jobs a person started** (`comment`, `manual`): exempt from the head commit rule, but there is never a
   duplicate of a waiting or running job for the same pull request, command and arguments
   (`already_active`): the existing job is returned, and if it is waiting behind a `run_after` in the
   future (a job given back with a retry time) it is made due now, because a person does not wait.
   Different arguments are different jobs (`/review` takes none; a historical person job
   with arguments is still its own job).
4. **Supersession.** A new automatic job replaces the _automatic_ jobs of the same pull request, review kind,
   command and arguments that would review an older state (status `superseded`, `superseded_by` set, in the
   transaction of the enqueue):
   - a **waiting** one is dropped; it never ran;
   - a **running** one (#397) is superseded **only if its holder understands it** (`accepts_supersede`, set by a
     claim that names the feature `supersede`, or by the Worker's job details request; #396). Jobs of a runner or
     Worker of an earlier release are left alone and the new job waits behind them as before. A running job a
     person started (`comment`, `manual`) is never superseded, and a person's job never supersedes anything.

   A superseded **running** job **drains**: it keeps `runner_id`, its lease token and its claim time; `finished_at` is
   set; `lease_expires_at` is set to the claim window (`SUPERSEDED_DRAIN_MS` in `../db/supersede-timing.ts`, 240 seconds: the Worker's next heartbeat, at most 60, its own drain, 120, the longest model request, and a margin) and is not extended
   by heartbeats. The Worker's host reads the end of the window from `leaseExpiresAt` in the heartbeat answer and ends its
   process `KILL_MARGIN_SECONDS` (20) before it, so the report arrives while the claim holds. Its heartbeats are answered `superseded` (`job.superseded: true`) while the window lasts, so
   its Worker stops sending model requests, finishes the ones in flight and reports; its **report is accepted
   once** and stored (the job stays `superseded`; it settles the usage record, below), also a little after the window
   (a grace of 60 seconds, `SUPERSEDED_REPORT_GRACE_MS`). Only when window and grace are over without a report does the
   next claim, sweep or request that expires leases settle the record with an unknown cost; a report after that is
   refused (`409`).
   The unique index that allows one running job per pull request (`jobs_one_running_per_pull_request_unique`) is on
   `status = 'running'`, so the draining job does not hold the pull request: **the new job is claimable at
   once** and both run for a short time. `attemptedShas` names the head of a superseded job that ran, like a failed
   one, so the publisher recognises a comment it may have written just before it heard of it.

`run_after` is `now` unless the caller passes a later time (only a job given back with a retry time waits; there is
no debounce of `synchronize` since #395). A manual job is due at once. The start button
(CR-33, `src/manual-reviews/README.md`) is the producer of `manual` jobs; it passes the head commit and the
pull request address it got from the platform and the login of the signed in person.

Unique indexes enforce the promises even if the code were wrong: one job per delivery id, one answer
per comment of a repository (the primary key of `job_comments`, migration `20261011090000_create_job_comments`),
one automatic job per head commit and command in the slot-holding statuses, one running job per pull
request.

**The enqueue hook (#326).** `createJobQueue(db, workspaceId, { onEnqueued })` calls `onEnqueued(result)` with what
`enqueue` returned (a new job or an existing one) once its transaction has committed, never for a refused enqueue,
and ignores a hook that throws. The running server passes the dispatch hook through `jobQueueFor` (`shared.ts`),
which is how a job queued by the GitHub webhook, a comment or the start button wakes a Dispatcher when
`RUNNER_DISPATCH=webhook`; by default there is no hook (`src/dispatch/README.md`). A producer must get its queue
from `jobQueueFor` (`src/dispatch/producers.test.ts`).

## Claiming, leases, attempts

`claimNext(runnerId)` runs in one transaction:

1. **Expire.** Running jobs whose lease ran out go back to `queued` with `attempts + 1`, runner and
   times cleared (the old runner is no longer the holder); on the last allowed attempt
   (`attempts + 1 >= maxAttempts`, default 3) the job is `failed` with `lease_expired` instead. Then
   running jobs claimed longer than `maxRuntimeMs` ago (default 25 minutes: the runner's 20 minute
   hard timeout plus 5) are `failed` with `timeout`, whatever their heartbeats say. The runtime is
   counted from the latest claim. No scheduler is needed: every claim does this.
2. **Claim.** One `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` hands out the oldest due
   job (`status = queued`, `run_after <= now`, ordered by `created_at`) of a pull request that has no
   running job. Two runners claiming at once are serialized by the write lock; each gets a different
   job or nothing.

**Billing (#498, #605).** After the admission and before the record, `claimNext` checks the balance of the workspace while billing is on (above zero starts the job, and
nothing is held), or fails the job with `insufficient_balance`, `balance_negative` or `billing_rates_incomplete` (no attempt, no record, no entry, a notice on
the pull request for the first two). **#499:** before the balance, while billing is on, the claim also checks the hidden hourly brake and the workspace's monthly
total limit and fails the job with `reviews_paused` or `monthly_limit_reached` (a notice on the pull request for both), or with
`billing_limits_unreadable` when it could not evaluate them for good (no notice); a failure that may pass (a deadlock, a timeout, a busy database) instead puts the job back in the queue, due 15 seconds later with an attempt counted, and it fails with that code only when its attempts are used up; the plan run quotas of the entitlements are not enforced then
(`src/billing/README.md`, "Limits at claim"). Every transaction below that ends a job, or ends its record, settles the job's money in the same transaction, one `usage` entry unless the run is free
(`src/billing/README.md`, "Start, settle"): `complete`, the expiry of leases and runtimes, `release` on the last attempt, `cancelClaimed`,
`failUndispatched`, the drain of a superseded run, and the cancelling or replacing of waiting jobs. With billing off none of it runs.

The claim also reserves the job's usage record (`usage_records`, `src/usage/README.md`) in the same
transaction, `complete` settles it, and every transition that ends a job without `complete` closes it: settled with an
unknown cost (`no_result`) when a runner held the job and sent no result (lease lost on the last attempt, hard limit,
runner shut down on the last attempt), void for every other end.

That statement is the only dialect specific code (`src/db/repositories/jobs-claim.ts`); a port to
Postgres changes it (`FOR UPDATE SKIP LOCKED`) and nothing else.

### The lease token

Every claim gets a new random `lease_token`, returned by `claimNext` next to the job (it is not a field
of `Job` and is never listed or logged). `heartbeat`, `complete` and `release` take that token, not the
runner id, and answer `not_holder` for any other: a runner that stalled past its lease, was requeued
and claimed the same job again under the _same_ runner id cannot be confused with its own stale
execution. Requeueing clears the token; a finished job keeps it, so a repeated report is recognised.
`runner_id` is bookkeeping only.

`heartbeat(jobId, leaseToken)` sets `heartbeat_at` and extends the lease to now + 2 minutes (runners
beat every 30 seconds). It also enforces the hard limit: a job claimed longer ago than `maxRuntimeMs`
is failed with `timeout` by the heartbeat itself and the holder is told `not_holder`, so a runner busy
on a hung job learns to stop without anybody else claiming.

`complete(jobId, leaseToken, outcome)` finishes the job as `succeeded` or `failed` with the result and
error code. The holder keeps a job as long as the row is `running` with its token: a lease that has
run out but whose job nobody has taken yet does not cost it the job (an expired lease is acted on when
the next runner claims, not before). `complete` with the same outcome again answers
`already_completed`; with another outcome `outcome_conflict` (also what the holder of a job that the
expiry failed gets).

`release(jobId, leaseToken, reason, { retryAt? })` gives a claimed job back (runner shutdown, no token
for the repository). It is a lost attempt with the same rule as a lapsed lease: the job waits again
(from `retryAt`, default now), or, on the last allowed attempt, fails with `reason` as its error code.
`attempts` therefore never grows past the maximum.

## Dropping waiting jobs

`cancelWaitingForRepository(repositoryId)` (project deactivated) and
`discardWaitingForPr(repositoryId, prNumber)` (pull request closed; all queued jobs of it, also the ones a person started) and `discardWaitingAutomaticForPr` (turned into a draft; only `webhook` jobs, error code `pull_request_draft`) set waiting jobs to `cancelled`;
running jobs finish. Nothing is deleted.

`cancelClaimed(jobId, leaseToken, errorCode)` is the one exception for a _running_ job: the claim of the
runner API uses it when it finds the project of a just claimed job switched off. One statement keyed on
the job id and the lease token (running to cancelled), no attempt counted, never queued in between. It
is deliberately not a transition of the shared table (`canTransition`): `cancelWaiting...` derives its
statuses from that table and must never cancel a running job.

## Tests

`../db/job-status.test.ts` and `job-input.test.ts` are unit tests of the pure rules. The queue itself is
tested against a real Postgres database in `job-queue.integration.test.ts` (time is moved by a hand-set
clock) and `job-queue-concurrency.integration.test.ts` (callers that overlap are real child
processes). `list` returns at most 100 jobs (500 at most) unless told otherwise. `integration-tests/webhooks/review-trigger-jobs.integration.test.ts` runs a signed
delivery through the webhook route into the queue. That the claim is the only dialect specific code is
checked in code review.

## For the tickets that build on it

- **CR-31 (triggers).** Done: the webhook handler applies the trigger policy before the intake
  (`src/webhooks/README.md`, "The trigger policy for automatic reviews"). It checks the active
  project, skips drafts and switched-off settings, compares a push with the pull request's current
  head commit (`getPullRequest`) _before_ enqueueing and calls `discardWaitingForPr` when a pull request
  closes. It debounced `synchronize` through `runAfter` until #395, which removed the wait: a push is due at once.
- **CR-24 (projects).** Done (CR-46): `createJobProjectHooks` (`project-hooks.ts`) calls `cancelWaitingForRepository` in the transaction of the deactivation; `src/projects/shared.ts` plugs it in.
- **CR-28/CR-29 (runner).** The runner API exists (`src/runner-api/README.md`); it uses `release` for
  "token creation failed". Its claim guard skips and cancels jobs of repositories
  without an active project (`project-claim-guard.ts`, wired in CR-46). The runner (CR-29) reports its
  shutdown through `complete` with the error code `runner_shutdown`; the runner API turns that into
  `release`, so the job is requeued with the attempt cap (the runner never calls `release` itself).
- **CR-32 (comments).** Done: the trigger carries the comment id, and the queue
  dedupes on it (`same_comment`). The queue's own limit of 10 000 characters stays as a safety net.
  The removed command question truncation went away with the commands (#203).
