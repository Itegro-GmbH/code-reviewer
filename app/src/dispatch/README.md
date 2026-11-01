# Dispatch webhook (the Webhook-Trigger, sending side)

In a serverless deployment no process polls the app for jobs. When a job is queued, the app wakes the
Dispatcher (#316) with one signed `POST`; the Dispatcher claims exactly that job (`jobId` in the claim, #322) and
starts a Worker. This folder is the sending side (#326). The receiving side is the Dispatcher project
(`dispatcher/`, #327); the wire format is `contracts/dispatch-webhook.v1.json` and
`contracts/dispatch-signing-vectors.json`, which both ends are tested against.

**Off by default.** `RUNNER_DISPATCH` is `poll` unless set to `webhook`. In poll mode there is no hook, no row
in `job_dispatches` and no HTTP: the app behaves as it did before this folder existed (runners poll).

## Settings

`config.ts` is the one place that knows the names. A refusal names the variable, never the value.

| Variable                                                           | Meaning                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_DISPATCH`                                                  | `poll` (default) or `webhook`                                                                                                    |
| `RUNNER_WEBHOOK_URL`                                               | The Dispatcher's `POST /dispatch`. https, no credentials in it (plain http only for `localhost`, `127.0.0.1`, `[::1]`)           |
| `RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`                   | The signing key: at least 32 characters, no white space; the id (`a-z0-9_-`, at most 32, default `k1`) names it for the receiver |
| `RUNNER_WEBHOOK_SECRET_PREVIOUS`, `RUNNER_WEBHOOK_KEY_ID_PREVIOUS` | The key being replaced, both or neither. The app signs with the current key only; see "Rotating the key"                         |
| `RUNNER_WEBHOOK_BYPASS_TOKEN`                                      | Optional. Sent as `x-vercel-protection-bypass` when the Dispatcher project sits behind the platform's deployment protection      |
| `RUNNER_DISPATCH_GIVE_UP_SECONDS`                                  | The sweep's give-up (#328, "The cron sweep"): default 3600 in webhook mode, off in poll mode; `0` is off                         |
| `RUNNER_DISPATCH_MAX_RUNNING`                                      | Optional. The pool cap the sweep keeps to when it sends (#328), 1 to 1000                                                        |

The signing secret is a credential of its own and must differ from `RUNNER_TOKEN`, `APP_SECRET`,
`BETTER_AUTH_SECRET`, `OPERATOR_API_TOKEN`, `CRON_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`,
`GITHUB_OAUTH_CLIENT_SECRET` and `LLM_API_KEY` (`OTHER_CREDENTIAL_VARIABLES`), and its previous value and the bypass
token must differ from it. A production start with `RUNNER_DISPATCH=webhook` and a missing URL, a short or reused
secret ends with `DEPLOY_CONFIG_INVALID` (`src/deploy/startup.ts`, serverless start included). At run time a bad
setting turns the dispatch off for that call and logs `DISPATCH_CONFIG_INVALID` once; it never fails a queue call.

The Dispatcher's own names for the same key are `DISPATCHER_SIGNING_KEY_ID` and `DISPATCHER_SIGNING_SECRET`
(`dispatcher/README.md`).

## How a job is announced

| File                                                        | Role                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                                 | `loadDispatchConfig`, `dispatchConfigProblems`                                                                                                                                                                                                                                                                               |
| `request.ts`                                                | `buildDispatchRequest`: the closed body (`{version, type:"job.ready", jobId, reviewKind, attempt, dispatchId, sentAt}`, no secret, no repository data) and the headers; `signDispatch`                                                                                                                                       |
| `send.ts`                                                   | `sendDispatch`: one `POST`, 8 seconds for everything, no redirect followed; the answer becomes a `SendResult`                                                                                                                                                                                                                |
| `outcome.ts`                                                | `decideOutcome`: what an answer means (state, next time, alert); the back-off schedule                                                                                                                                                                                                                                       |
| `service.ts`                                                | `createDispatchService`: `onEnqueued` (the queue hook, with the bounded inline retries, #395), `sendDue` (the hook for the sweep), `sendJob` (one job of its listing; it sends only a row that is due now, so a listing older than another sender's claim sends nothing), `sendWaiting` and `redispatch` (a job ended, #395) |
| `job-ended.ts`, `opportunistic.ts`, `maintenance-shared.ts` | What happens between two sweeps (#395): the reaction to a job that ended, and the repair work of the requests that touch the database                                                                                                                                                                                        |
| `hook.ts`, `shared.ts`                                      | The hook for `createJobQueue` (none in poll mode), run through Next's `after()`; `getDispatchService()` for the sweep                                                                                                                                                                                                        |
| `db/repositories/job-dispatches-repository.ts`              | The rows of `job_dispatches`                                                                                                                                                                                                                                                                                                 |

1. A producer (the GitHub webhook, a comment, the start button) enqueues through `jobQueueFor`
   (`src/jobs/shared.ts`), which passes `onEnqueued` to `createJobQueue`. The queue calls it **after the enqueue
   transaction committed**, with the result; a hook that throws is ignored. `producers.test.ts` fails if a producer
   builds a queue some other way.
2. The hook hands the work to `after()` (Next keeps a serverless function alive for it, `waitUntil` on the
   platform). The GitHub response, the comment handling and the start button never wait for it and never fail
   because of it. There is no timer and no loop in the app for this.
3. `onEnqueued` acts for a **new** job and for an `already_active` one; a job returned as `same_delivery`,
   `same_comment` or `same_head` gets nothing, and neither does a job that was created already failed (Dynamic Review
   off). It makes the `job_dispatches` row and, if the job is due, sends: every job is due at once, a push included
   (there is no debounce since #395). A job that is not due yet (a job given back with a retry time) only gets its row
   with `next_dispatch_at = run_after`.
4. The send is **claimed in the row first** (`claimSend`: a compare and set on `next_dispatch_at`, which also counts
   the attempt), so the request that queued the job, the sweep and another instance never send one call twice. If
   the sender dies, the claim runs out after 30 seconds and the job is due again.

5. A call that failed with a transient answer (a 5xx, a timeout, no connection, `429`/`503`) is made again **inside the
   same request** (#395), at most three more times, after 1, 3 and 8 seconds (`INLINE_RETRY_DELAYS_MS`), a `Retry-After`
   of up to 30 seconds honoured (`INLINE_RETRY_MAX_WAIT_MS`: the 20 of a Dispatcher that is not ready, the 30 of a busy one),
   and never longer than 45 seconds in all, counted from the moment the request queued the job (`INLINE_RETRY_BUDGET_MS`, `receivedAt` of the hook; the `/api/w/**` routes have their 60 seconds set in `app/vercel.json`; the function lives 60, and a repeat is started only
   when its pause and its longest possible call, 8 seconds, still fit). A longer `Retry-After` is not waited for: the row
   keeps it and the job is woken by a slot that frees ("Between two sweeps"), by the repair work or by the sweep.
   A refusal (`rejected`) is never repeated inline. A job that was taken meanwhile (it is no longer `queued`) is not
   sent again. What is still unsent after that is left to the row's back-off, to "Between two sweeps" and to the sweep.

The job is durable before any of this: nothing here can lose it or undo the enqueue. If even the row cannot be
written, the job is still queued, and `sendDue` finds queued, due jobs **without** a row as well.

## What an answer means (`outcome.ts`)

| Answer                                                                         | Stored                  | Next                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `202`                                                                          | `acked`, `acked_at`     | Looked at again after the **acknowledgement timeout** (2 minutes); sent again only if the job is still queued then (the claim failed, or the Worker launch was given back) |
| `200 ignored`, `not_claimable` (or any other reason of the right form)         | `pending`               | Again after the acknowledgement timeout (not due, running, pool cap reached, ...)                                                                                          |
| `200 ignored`, `not_capable`                                                   | `stopped`               | Not by the send itself: the Dispatcher cannot run that review kind. The sweep asks again, at its next run ("The cron sweep", step 3)                                       |
| `429`, `503`                                                                   | `pending`, failures + 1 | The longer of the schedule and `Retry-After` (seconds or HTTP date, at most 1 hour). Only the status and `Retry-After` are read; the body is dropped                       |
| other `5xx`, timeout, no connection                                            | `pending`, failures + 1 | 10 s, 30 s, 2 min, 5 min, then 15 min                                                                                                                                      |
| any other status (`4xx`, a redirect, an unexpected `2xx`, an unreadable `200`) | `pending`, failures + 1 | **30 minutes**, and an error log line `DISPATCH_REJECTED` (a wrong URL or a wrong secret looks like this)                                                                  |

`last_status` and `last_code` (`DISPATCH_RESULT_CODES`) keep the last answer for support. The failures count resets
on any answer that is not a failure.

## Between two sweeps (#395)

The sweep runs **every 2 hours**, a safety net (next section). Everything the normal flow needs happens in the request that
causes it, after the response (`after()`), with no timer and no queue, and only while `RUNNER_DISPATCH=webhook`:

- **A job ended or was given back** (`job-ended.ts`; the Worker's result, the runner API's `complete`, a Dispatcher's
  `release`): the **freed slot first**. `sendWaiting` asks the queued jobs that were answered `not_claimable` (the pool
  cap, the running job of their pull request), whatever time their row says, the job of the same pull request first,
  then the oldest, **until as many wake-ups were accepted as there are free slots** below
  `RUNNER_DISPATCH_MAX_RUNNING` (one when the cap is not set), at most 20 candidates: a job that is refused again does
  not use the slot. The walk stops at the first `429`, `503`, timeout or lost connection (that answer is about the Dispatcher, not about the job: the others would get it too), and no send starts that could not end before the deadline (the longest call, 8 seconds, is counted in). Left out: a job whose own pull request has a running job (it would be refused again), a job whose
  last call is younger than 9 seconds (`WAITING_MIN_GAP_MS`: a call in flight holds the row, and two events must not
  send one job twice). A job the Dispatcher answered `429` (busy) or `503` (not ready) **is** asked (#479, `WAITING_DISPATCH_CODES`): whatever its
  `Retry-After` says, a slot that freed is the moment the Dispatcher is most likely to take it, and a `Retry-After` longer than
  a request waits for would otherwise leave the job to the repair work or the 2 hour sweep. The row's own time still holds for
  every other sender. No timer or poll is added: this runs in the request that ends a job, so an idle system stays idle.
  **Then** a job that was **given back** (queued again) is sent again by `redispatch`: its retry time is waited for
  inside the request when it fits (the Dispatcher gives a job back with 30 seconds; a little slack is added because a
  timer can fire early), else the next sender sends it. One deadline of 45 seconds from the start of the reaction
  (`JOB_ENDED_BUDGET_MS`) covers both, so that the request, whose function lives 60 seconds, is not cut in the middle
  of a send. An acknowledged job (`202`) is not "waiting": its own look comes after the acknowledgement timeout.
- **A request touched the database** (`opportunistic.ts`; a GitHub delivery that queued a job, dropped waiting ones or
  changed an installation, and not an unused event, a duplicate or an ignored one: `webhooks/touch-policy.ts`; a Worker's or
  runner's heartbeat and result): the leases that ran out are released (`expireStaleJobs`) and `sendDue` sends what is
  due. At most once per 30 seconds per function instance, under a lock **of its own** (`OPPORTUNISTIC_LOCK`), not the
  sweep's: the two may overlap, so a run of this work can never make the cron a no-op. Both are also done by the sweep;
  every send is fenced by the compare and set on the row, so overlapping senders send a call once. A sweep that
  finds the sweep's lock held is logged (`DISPATCH_SWEEP_SKIPPED`).

## The cron sweep (#328)

A serverless deployment has no process that polls and none that lives long enough to hold a timer. The platform's cron
is the safety net for what the requests above did not repair: `GET /api/internal/dispatch-sweep`, **every 2 hours**
(`0 */2 * * *`, `app/vercel.json`; sparse on purpose, so that a database that scales to zero can sleep between
webhooks), with
`Authorization: Bearer <CRON_SECRET>` like the daily repository sync. A missing or wrong
secret is `401` with no side effect, and nothing below `/api/internal` is open except the two exact paths of the
two crons (`src/auth/access.ts`).

| File                             | Role                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `app/src/cron/dispatch-sweep.ts` | The route's handler: the secret, the try-lock, the answer (counts only)                                                               |
| `app/src/db/try-lock.ts`         | `tryWithLock`: a Postgres transaction advisory try-lock (`pg_try_advisory_xact_lock(328, 1)`) on a dedicated connection, not the pool |
| `sweep.ts`                       | `createDispatchSweep(...).run()`: the steps of one run                                                                                |
| `sweep-settings.ts`              | The two settings below                                                                                                                |
| `sweep-shared.ts`                | The wiring of the running server                                                                                                      |

**Overlapping runs.** A run that starts while another one is still working (the platform retries, or a run
outlasts its slot) does not queue behind it: it answers `{"status":"skipped","reason":"already_running"}` and
does nothing. The lock lives and dies with one transaction on a connection of its own (not the pool, whose connections the steps
need: a pool of one still works), so a crashed instance can never leave it locked. Every step is also safe on its own, so a second instance that got in anyway (for example the job
creation hook running at the same moment) only ever sees compare-and-set statements.

**One run, in order.** A step that fails is logged by its name (`[sweep] SWEEP_STEP_FAILED step=<name>`, never the
cause) and does not stop the others; the answer is then `500` with `failedSteps`, and the next run tries again.

1. **`expire`** (`expireStaleJobs()`, which claims did and now nobody does): a running job whose lease lapsed is
   queued again with the attempt counted (on the last allowed attempt it fails with `lease_expired`), a job that runs
   longer than 25 minutes fails with `timeout` whatever its heartbeats say, and a Dynamic job nobody can run is
   cancelled (`no_capable_runner`, after 30 minutes without a working runner, after 3 hours at the latest: `jobs/README.md`). Its row in `job_dispatches` is due by then (the acknowledgement timeout is as long
   as the lease), so step 4 sends it again.
2. **`give_up`**: a job that has been **queued for the give-up time without a claim** fails with the stable code
   `dispatch_unavailable` (copy on the Runs pages, `runs/error-copy.ts`) and no attempt is counted, so the pull
   request is free for the next push or review request. "Queued" is counted from the later of the time the job
   became due (`run_after`, so a retry time does not eat the budget) and the time it was last queued (a job given back
   after a lost lease waits again from then, never from its first due time). A job whose dispatch a Dispatcher
   **acknowledged** (`202`) within the last acknowledgement timeout is spared: that Dispatcher is working on it.
   A job that is running is never touched by this step. The time is `RUNNER_DISPATCH_GIVE_UP_SECONDS`: **3600 (60
   minutes) when `RUNNER_DISPATCH=webhook`**, **off in poll mode** unless the operator sets it, `0` turns it off, a
   value outside 60 to 604800 or one that is not a whole number keeps the default of the mode. It is also the longest a
   job may wait when the pool is full, so set it above the longest queue you accept.
3. **`revive`** (webhook mode): a dispatch **stopped** with `not_capable` (the Dispatcher cannot run that review
   kind) is made pending again at the first sweep that finds it stopped for `STOPPED_REVIVE_MS` (10 minutes) or longer, if its job is still queued, so a
   Dispatcher that was updated or got its engine back is asked again, at a slow pace and never in a hot loop (every
   2 hours, since the sweep runs that often). A Dynamic job that nobody can ever run still ends as `no_capable_runner`
   after 30 minutes (3 hours at the latest while a runner of the engine is busy, `jobs/README.md`), when a claim or the sweep looks at it (step 1).
4. **`send`** (webhook mode, `getDispatchService()?.sendDue(limit)`): every queued job that is due and has no row, or
   whose row is due and not stopped, is sent: jobs queued by an instance that had no hook, a row that could not be
   written, a job given back with a retry time that has passed, a call that was never acknowledged, an acknowledged job that is still
   queued after the acknowledgement timeout (the claim failed, or the Worker launch was given back). **The pool cap:**
   with `RUNNER_DISPATCH_MAX_RUNNING` (1 to 1000, normally the Dispatcher's `DISPATCHER_MAX_RUNNING`) the run sends
   at most as many calls as there are free slots (the cap minus the jobs running now, never more than 20 a run), and
   none at the cap, so a long queue does not wake the Dispatcher for nothing; the job is sent when a slot frees ("Between two sweeps"), or in the
   first run after a slot frees. Unset, the sweep does not limit itself and the Dispatcher's own cap (enforced by the
   app at the claim, `maxRunning`) is the only limit. The first call right after a job is queued (the hook of
   `jobQueueFor`) is not held back by the cap: the claim is.
5. **`notices`** (#281): the notices of refused reviews whose post failed (`refusal_notices` rows that are `pending`, past
   their wait and under 3 attempts) are tried again, at most 20 a run (`src/refusal-notices/README.md`). Without this
   step a failed notice is only retried when the next push on the pull request is refused.
6. **`cleanup`**: the cleanup a server runs on a timer (`maintenance/cleanup.ts`: old rate limit counters,
   unverified accounts, verification and reset links, signed states, remembered job keys, **and the `job_dispatches`
   rows of jobs that finished a week ago**) runs **once when the hour has changed**. The hour of the last
   successful run is kept in `app_meta` (`maintenance.sweep_cleanup_hour`), so every instance sees the same one; a run
   that failed is tried again by the next run.
7. **`billing_holds`** (#591, legacy since #605): while billing is on, the old holds of jobs that ended while it was off are
   released (`src/billing/README.md`, "Old holds (legacy)"), at most 500 a run. No claim takes a hold any more, so on an
   instance that never took one the step finds nothing. It reads only the billing switch while billing is off. A failure is a
   failed step (`billing_holds`) and is tried again by the next run.
8. **`balance_mails`** (#506): mails the balance crossings that are due (`src/billing/README.md`, "Balance notifications (#506)"): a settlement
   of this sweep or of a superseded job has no response to send after. It reads only the billing switch while billing is off and
   never throws; a failure is a failed step (`balance_mails`). The answer of the route counts the mails sent (`balanceMailsSent`).
9. **`journal_check`** (#626): while billing is on, a bounded step of the daily check of the billing journal (`verify()` of every workspace;
   `src/billing/README.md`, "The scheduled journal check (#626)"). It reads one instance setting when no pass is due and only the
   billing switch while billing is off. An inconsistency is logged by the code `BILLING_JOURNAL_INCONSISTENT` and its result is shown on
   the admin billing page; the answer of the route counts the workspaces checked in this run (`journalChecked`). A failure is a failed
   step (`journal_check`).
10. **`models_dev`** (#548): the daily read of the models.dev catalog (`src/models-dev/README.md`) when the last success is more
    than 23 hours old and the last failure more than an hour old; it is last so that a slow answer from the internet never
    delays the steps above. A fetch that fails records its own failure (`models_dev_fetch_state`) and keeps the rows it has;
    that is not a failed step. The whole step (fetch, lookups and write) has one deadline of `MODELS_DEV_BUDGET_MS` (90 s;
    the route runs 300 s, the check runs take 40 s of it); a step that cannot finish writes nothing and fails with
    `models_dev_timeout`. The attempt is recorded before it starts. Nothing happens with `MODELS_DEV_FETCH=off`.

The answer is `{"status":"ok","expired":{...},"givenUp":n,"revived":n,"sent":n,"noticesTried":n,"cleanedUp":bool,"holdsReleased":n,"journalChecked":n,"modelsDev":"applied"|"skipped"|"failed"|null}`; a line
`[sweep] requeued=.. lease_expired=.. timed_out=.. given_up=.. revived=.. sent=..` is logged for a run that did
something. Nothing a database or a Dispatcher said reaches a log or an answer.

## Stopping the VM when a job ends (#487)

The Dispatcher holds no supervision after it handed a job to its Worker, and the Worker's VM never gets access to the
Dispatcher (it runs an untrusted review and holds only this app's address and the job credential). So **the App tells the
Dispatcher** when the claim of a job has ended, and the Dispatcher stops that job's VMs (`dispatcher/README.md`, "The stop
call"). `stop.ts` is the sender; `shared.ts` (`stopEndedClaims`) hands it to `after()` like every other reaction.

| File                                        | Role                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stop.ts`                                   | `createStopService(...).stopJobs(ids)`: the lookup of the job's dispatch row, one signed `POST` per job, the bounded retry, the log line; `stopUrlOf`                                                       |
| `request.ts`                                | `buildStopRequest`: the closed `DispatchStop` body (`{version, type:"job.stop", jobId, stopId, sentAt}`) and the headers; the same `signDispatch` as the wake-up call, with `stopId` as the `x-dispatch-id` |
| `shared.ts`                                 | `getStopService()` (none in poll mode) and `stopEndedClaims(jobIds)`: after the response, never throws                                                                                                      |
| `db/repositories/runner-jobs-repository.ts` | `onClaimsEnded(jobIds)`: the one place that sees every end of a claim, after its transaction committed                                                                                                      |

**When.** The queue calls `onClaimsEnded` for a claim that ended **for good**: a result delivered (`complete`, also the report of
a superseded run), a failure, a cancel (`cancelClaimed`), a job given back on its last attempt (`release`), a heartbeat past the
hard limit (`timeout`), and the leases and runtimes that ran out and ended the job (`expireStaleJobs`, the expiry step of every
claim, so the sweep, the opportunistic repair work and a claim all stop what they end). It names a job once per call, never
for a call that changed nothing (a repeated report, a stranger's token). A job that went **back to the queue** (a lapsed
lease or a release with attempts left) is not named: the Dispatcher stops by the job, the next attempt's VM could exist when
the call arrives. The VM of the lost attempt lives until its own timeout or until the job ends for good, when the stop by the
job also ends it; the reaper ends it earlier only while the retry is not yet `running` (it keeps a VM whose job is `running`).

**Which jobs.** Only a job whose wake-up a Dispatcher **acknowledged** (`job_dispatches.acked_at` is set). In poll mode
(`RUNNER_DISPATCH=poll`, the default) there is no service and nothing is sent, and in webhook mode a job that was not
woken through the Dispatcher has no acknowledged row, so it gets no call either. The call
goes to the address of the wake-up (`RUNNER_WEBHOOK_URL`) with its last path segment `dispatch` replaced by `stop`
(`stopUrlOf`); an address that does not end in `/dispatch` gets no stop and the job logs `DISPATCH_STOP_URL_INVALID`.

**Never in the way.** The job's transition has committed before anything is sent; the call runs in `after()` and nothing
awaits it, throws from it or is changed by it. A failure is best effort:

| Answer                                                                 | What the App does                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `202`, `200` (`stopping`, `no_vm`, `replayed`)                         | done. A `202` that names the VMs (`vms`, #493; a bounded read of the body, anything that is not a short list of well-formed names counts as none) ends those VMs at the App's clock (`app_stop_confirmed`, "Billable minutes" in `billing/README.md`); the other answers name none, and the backstop applies |
| `429`, `503`, other `5xx`, a timeout (5 seconds a call), no connection | repeated after 1 s and 3 s (`STOP_RETRY_DELAYS_MS`; the longer of the pause and `Retry-After`, cut to 5 s), the **same `stopId`** every time, so a stop that arrived twice is a replay the receiver ignores; then logged as `DISPATCH_STOP_FAILED`                                                           |
| `404`                                                                  | a Dispatcher of the previous release has no `/stop`: logged once as `DISPATCH_STOP_UNSUPPORTED`, not repeated; the reaper ends the VM as before                                                                                                                                                              |
| any other status (`401`, `400`, `413`, a redirect)                     | logged as `DISPATCH_STOP_REJECTED` with the status (a wrong URL or secret looks like this), not repeated                                                                                                                                                                                                     |

One line per job and call, `[dispatch] <CODE> job=<id> [status=<n>]`, never the URL, a key, a header or the text of an answer or
an error. At most about 25 seconds a job (two pauses of up to 5 seconds and three calls of 5 seconds), five jobs at a time.

## Rotating the key

The receiver accepts a current and a previous key. Order: (1) give the Dispatcher the new key as current and the old
one as previous; (2) switch the app to the new key (`RUNNER_WEBHOOK_SECRET`, `RUNNER_WEBHOOK_KEY_ID`); (3) remove the
previous key from the Dispatcher when no call signed with it can still be in flight (the receiver's tolerance is
5 minutes). The app's `..._PREVIOUS` pair is only checked and carried (it must be a strong, distinct secret); the app
never signs with it.

## Logs

A failed stop logs `[dispatch] DISPATCH_STOP_FAILED`, `DISPATCH_STOP_UNSUPPORTED`, `DISPATCH_STOP_REJECTED` or
`DISPATCH_STOP_URL_INVALID` (`STOP_RESULT_CODES`, "Stopping the VM when a job ends"); a stop that worked but whose VM end could
not be stored logs `DISPATCH_VM_END_FAILED` (#493).
A failed send logs `[dispatch] DISPATCH_SEND_FAILED job=<id> code=<name> status=<n|none> failures=<n> retry_at=<time>`;
an answer an operator has to look at logs `DISPATCH_REJECTED`; a failure inside the dispatch logs `DISPATCH_FAILED`
with the database error code. Never the URL, the key, the key id, a signature, a header or the text of an error.

## Mixed versions

The table is new and nothing reads it but this code, so an app of the previous release on the same database is
unaffected; the jobs it queues have no row and are found by `sendDue`. The default is poll mode, which changes
nothing. A Dispatcher of the previous release has no `/dispatch`; the app then gets `404`, which is the "any other
status" case above (30 minute wait and an alert), never a lost job.

The stop call (#487) adds no table and no column, and the dispatch contract only grows: a Dispatcher of the previous release has
no `POST /stop` and answers `404`, which the App logs once per job (`DISPATCH_STOP_UNSUPPORTED`) and goes on; an App of the
previous release sends no stop, and the new Dispatcher's reaper ends the VMs as it did before (`contracts/README.md`, "Rolling
out the stop call"). The Dispatcher of this release no longer releases a job whose container ended with an error after the
hand-over (`worker_exited`, #375): a Worker that dies is found by its lease and the next expiry pass (the next claim or the sweep), so such a job is requeued
after two minutes at the earliest and on an idle instance up to about the sweep interval, instead of within seconds.

The sweep (#328) adds no table and no column. `dispatch_unavailable` is a new value in the free-text `jobs.error_code`;
a previous release shows a failed job with a code it does not know under its general sentence and the code, never as
an error. A previous release has no `/api/internal/dispatch-sweep`: a cron entry that reaches it gets `404`, which
changes nothing. While old and new instances share a database, the new sweep only does what the old claim path
already did (`expireStaleJobs`), plus the compare-and-set statements of this folder; a lease lapsed by the new sweep
is the same lease an old instance's claim would have expired.
