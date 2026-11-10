# 0005: Runner v2: one Dispatcher contract

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** the owner, designed in conversation on 2026-11-10
- **Implemented by:** epic #969; this record with #971 (labels and the claim), then #972 to #974 (M1) and #975 to #982 (M2, M3)
- **Amends:** the shape section of the Factory-Runner plan (a runner on the host's Docker). Its decisions on registration, labels, BYOK, the cost
  display and Anthropic's terms stand unless changed below

## 1. Context

Today two things claim jobs. The hosted Dispatcher (Vercel) claims with the shared `RUNNER_TOKEN`, usually by job id after the signed wake-up
call, and starts a VM whose size it takes from the claim. A customer's runner (`docs/runner.md`) claims with its own credential and gets the turn
of a runner environment of its workspace. The claim statement keeps them apart with two special rules ("a hosted job never goes to a customer's
runner", "a runner turn never goes to the Dispatcher"), and each new kind of dispatcher would need a third.

## 2. Decision

There is **always a Dispatcher** (a Vercel Function hosted, a service on a customer's Linux machine, later maybe Kubernetes). It decides how it
learns about work (poll or webhook), how much it runs at once and how it starts the sandbox. Inside the sandbox runs always the same VM content and
the same Worker image. Three interfaces carry this: **App ⇄ Dispatcher** (registration, labels and harness manifest, delivery, doorbell, the claim of the
next matching job, release, stop; never a job's secrets), **Dispatcher ⇄ Sandbox** (start `{appUrl, jobId, crj_}`, environment control) and **Worker ⇄
App** (the Worker API, `crj_`, everywhere).

1. **Labels.** Every job requires labels and a dispatcher takes a job only when it has **all** of them (#971). The namespace `cr:` is reserved: `cr:managed`
   and one `cr:size-<vCPUs>` for each size of `contracts/environment-sizes.v1.json`. Only the platform identity (`RUNNER_TOKEN`) may carry them; a
   customer's runner that announces one is refused (`422 RUNNER_LABEL_RESERVED`), and the check is by identity, never by spelling. A hosted job gets
   `cr:managed` and its size label when it is enqueued, a runner turn the labels of its environment. The two special rules are this one rule. The
   claim without a `jobId` returns the oldest due job the caller matches (labels, workspace, harness); with a `jobId` it works as before while the hosted
   Dispatcher is still woken by id. The claim answer names the size label (`sizeLabel`), which the Dispatcher checks; the VM size stays the environment's `vcpus` or the operator's configuration.
2. **Delivery** (#972). The claim is the only way to a job. A poll, the doorbell (a webhook without data) or a freed slot triggers it. The doorbell goes
   to every matching webhook dispatcher and the first claim wins. A full dispatcher declines and forgets; the app rings again on events (a job is
   enqueued, a job of its group ended) and the sweep stays the rare safety net.
3. **Capacity** is the dispatcher's business (it claims only with a free slot); business limits (the pool cap, answered `204`) stay in the app. The
   hosted Dispatcher does not count VMs itself: the fleet listing caused the outage of 2026-10-31.
4. **Access has three sources** (#973, #980): `managed` (the platform's keys, platform identity only), `app-key` (the workspace's own key, kept in the app
   and handed to the Worker through the Worker API) and local (`local-key`, `subscription`: only on the dispatcher's device, never in the app). The
   manifest says harness, auth and models, never credential names. The dispatcher picks a credential and hands the VM only that one.
5. **Subscriptions only self-hosted.** Anthropic's terms forbid to "collect, store, or intermediate Claude.ai credentials or session tokens" (read again
   2026-11-10); hosted stays API keys. The local Dispatcher holds no job secrets (#974).
6. **Self-hosted Linux** (M2): one service as a normal user (root only at install), Firecracker VMs built from the same recipe as the golden snapshot, no
   Docker needed on the host and the host's Docker never touched. The VM reaches only a proxy of the dispatcher (a static nft table on our TAP devices),
   which enforces the outer network rule: wide for the setup, narrowed after.
7. **All harnesses in `agent:golden`** (#981; needs the owner's confirmation of Anthropic's Commercial Terms).
8. **No isolation level is reported to the app:** the customer knows how well their machine is protected.

## 3. Details of #971

- `jobs.required_labels` (text, one label on each line, nullable). Null is a job written before the column: the claim reads it as the labels of its
  runner environment, or as `cr:managed` for any other job, so queued jobs are routed as before and the migration rewrites no row.
- The claim statement has one label condition for both callers (`required <@ labels`); the platform identity's labels are `PLATFORM_LABELS`, a customer's
  runner's are those it announced without any label of `cr:`. The harness rule (#856) stays beside it; #973 moves it into the labels' company.
- A runner environment cannot name a `cr:` label either, or a turn would require `cr:managed`. One stored before the namespace was reserved may hold such
  a label: the claim and the enqueue drop every `cr:` label from an environment's labels, and the platform branch of the claim excludes runner turns outright
  (`environment_kind = 'runner'`), so a customer's turn is never the platform's. A job whose required list is empty is nobody's.
- `SplitClaimResponse.sizeLabel` is optional on the wire so a Dispatcher can read an app of the release before; `vcpus` keeps its value and still decides the VM size. A label that names
  a size the Dispatcher does not offer gives the job back unlaunched.

## 3b. Details of #972

- **Delivery is announced** (`delivery` in `POST /register` and `PUT /self`): `poll` (default) or `webhook` with an https URL the app checks (no private, link-local or internal
  host, no credentials, no redirect). The platform's dispatcher has no announcement: `RUNNER_WEBHOOK_URL` and its signing secret are its delivery, so a hosted deployment keeps
  working with only those. `PUT /self` replaces what the app holds, so a dispatcher announces its delivery every time.
- **A signing secret for each dispatcher**, made by the app (never chosen by the dispatcher, so none is weak or shared), shown once in the answer that made it and kept sealed with
  the app's secret, bound to the runner's row. Rotation is `rotateSecret: true`, with no grace period: the dispatcher takes the new secret from the answer. The signing rule and
  the receiver are those of the platform's dispatcher (`contracts/dispatch-webhook.v1.json`); `contracts/dispatch-signing-vectors.json` gains the vectors of another dispatcher's key.
- **The doorbell is only a doorbell** (the body of #316, no job data) and goes to every webhook dispatcher that matches (workspace, every label, a ready harness, the minimum
  base). The claim decides: first wins, the others get `204`. The state of each (job, dispatcher) pair is a row of its own (`job_rings`, the columns of `job_dispatches`): one row
  per job could not say that one dispatcher is full and another failed. The platform's `job_dispatches` is untouched.
- **`busy` is a known reason of `200 ignored`.** The row rests for the period of the cron (`BUSY_REST_MS`, 2 hours); it is rung again by an event and by the sweep. It counts as "waiting"
  (`WAITING_DISPATCH_CODES`), so the platform's `sendWaiting` asks a hosted Dispatcher that said it too. The hosted Dispatcher still answers a full pool with `429` and `Retry-After`.
- **Events, bounded:** an enqueue, and the end of any claim (`onClaimsEnded`: a result, a failure, a cancel, a lapsed lease, a timeout) ring the waiting jobs of the group (the labels
  the ended job required and the labels of the runner that held it). At most 20 pairs, no pair twice within 9 seconds, a dispatcher that is full or unreachable once per reaction.
  The sweep (every 2 hours; the comments that said once a minute are fixed) stays the safety net.
- **Stop** goes to the webhook dispatcher that holds the job (`jobs.runner_id`), signed with its own secret; a polling dispatcher learns from its worker ending.
- **Only with the dispatch webhook on** (`RUNNER_DISPATCH=webhook`, hosted): in poll mode the app makes no outgoing call.
- **Not done here:** the hosted Dispatcher still claims by the `jobId` of the doorbell and still answers a full pool with `429`; a UI to show the secret once and to rotate it.

## 4. Alternatives considered

- **A third special rule for each new dispatcher.** Rejected: it multiplies with every kind of dispatcher and the rules cannot be read off one statement.
- **A hosted/self-hosted flag on the job instead of labels.** Rejected: it says what kind of dispatcher, not what the job needs, and a size or a GPU would
  need a second mechanism.
- **Backfilling `required_labels` in the migration.** Rejected: a rewrite of the biggest table under a lock for what a null read already gives.

## 5. Consequences

Hosted and self-hosted differ only in their labels and in how they start the sandbox. A new kind of dispatcher needs no change to the claim. A
customer can never run on the platform's identity, and the platform never runs a customer's turn. The cost is one more column and the reserved
namespace, which makes `cr:` unavailable to customers for good.

## 6. Open questions

Whether harness and model belong in the profile (the owner will revisit them after the runners), Kubernetes, Claude Code with BYOK hosted, and the
subscription login through a door.

## 7. Out of scope

The harness manifest, the local Dispatcher without job secrets and everything of M2 and M3: each is its own issue of epic #969.
