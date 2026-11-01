# Dispatcher

The middle layer of the hosted deployment (#316). It learns that a review job exists, claims exactly that job
from the App with the dispatcher credential, receives the per-job credential, starts a Worker through a
Launcher and hands the job over. It never reviews, and it never sees the git token or the model key: the App
reveals those to the Worker when the Worker fetches its job.

The words used here and the interfaces are in [`docs/dispatcher.md`](../docs/dispatcher.md); deploying it is in
[`docs/deployment-vercel.md`](../docs/deployment-vercel.md).

```
App ──signed POST /dispatch──▶ Trigger ──▶ core ──claim──▶ App
                                            │  ◀── per-job credential
                                            └──▶ Launcher.launch(...)   (heartbeats with the credential meanwhile)
```

| Part                                                                              | Where                                              | Status                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dispatcher core: claim, capacity, heartbeat during the launch, release on failure | `src/core/`                                        | here; platform-free (no `node:*`, no platform SDK: ESLint and a test check it)     |
| Webhook-Trigger: `POST /dispatch`, `GET /health`                                  | `src/triggers/webhook.ts`, `src/dispatcher-app.ts` | here                                                                               |
| Stop route: signed `POST /stop` (#487)                                            | `src/triggers/stop.ts`, `src/stop/`                | here                                                                               |
| Fake Launcher (tests)                                                             | `src/launchers/fake.ts`                            | here                                                                               |
| Hardened container spec renderer and `ContainerLauncher` (#325)                   | `src/launchers/container*.ts`                      | here, used by the Sandbox-Launcher (#329)                                          |
| Sandbox-Launcher over the Vercel Sandbox SDK (#329)                               | `src/launchers/sandbox*.ts`, `vercel-sandbox.ts`   | here, wired into the Vercel entry when `SANDBOX_SNAPSHOT_ID` is set                |
| Canary probe, `POST /probe`, canary VM, deploy canary command (#331, #479)        | `src/probe/`, `src/launchers/sandbox-canary.ts`    | here: the deploy canary's only way in; dispatch never runs a probe                 |
| Vercel entry, a default export                                                    | `src/index.ts`                                     | here: the Sandbox-Launcher when a golden snapshot is configured, else `noLauncher` |
| Node test host, `@hono/node-server` and a graceful shutdown                       | `src/test-support/node-host.ts`                    | tests only: the hosted e2e lane and the integration tests, never a deployment      |
| Golden snapshot pipeline (a command, not a runtime part)                          | `src/snapshot/`, `pnpm snapshot:build`             | here (#330), `docs/golden-snapshot.md`                                             |

The Vercel entry never imports the Node test host or `node:child_process`
(none of ours: the Sandbox SDK's dependency tree holds `execa` for a local-development token fetch and `undici`; the
test leaves out exactly those two, each only as imported by its known importer); `src/bundle/serverless-bundle.test.ts` follows the import graph of `src/index.ts` to prove it. Without a real
Launcher an entry uses `noLauncher`: it advertises no engine, so every wake-up call is answered `200 ignored` with the
reason `not_capable` and nothing is claimed. The Vercel entry uses it until `SANDBOX_SNAPSHOT_ID` is set.

## The wake-up call

`POST /dispatch` follows `contracts/dispatch-webhook.v1.json`. In this order: content type (`application/json`) and
size (1 KiB at most), the form of the headers, the timestamp (300 seconds either way), the key id (the current and
the previous key), the signature (constant time), the closed body, and that its `dispatchId` equals the header. A
refusal never says which check failed: `401` for the clock, the key or the signature, `400` for a malformed or
invalid call, `413` for an oversize body, with the same body every time. Nothing is claimed for a refused call.

A verified call gets its answer at once: `202 accepted` (the Worker is being started in the background: `waitUntil` on
the platform, a tracked promise in the Node process), `200 ignored` with `not_claimable` (the claim answered `204`: a
replay, a job that is running or finished, or the pool cap) or `not_capable` (no configured engine of the Launcher
runs that kind; nothing is claimed), `429` or `503` with `Retry-After`.

## The stop call (#487)

The Dispatcher holds no supervision after the hand-over. When a job's claim ends, the **App** tells it to stop that job's
Sandbox VM with `POST /stop` (`contracts/dispatch-webhook.v1.json`, `DispatchStop`: `{version, type: "job.stop", jobId,
stopId, sentAt}`, closed, at most 1 KiB, no secret). The VM never gets access to the Dispatcher: it runs an untrusted review
and holds only the App's address and the job credential, and nothing in it can call this route.

- **Verified like `/dispatch`**, by the same code (`src/triggers/verified-request.ts`): content type and size, the form of
  the headers, the clock, the current and the previous key, the signature in constant time, then the closed body, whose
  `stopId` must equal the `x-dispatch-id` header. A refusal never says which check failed: the same `401`/`400`/`413` with the
  same body as `/dispatch`, and nothing is looked up or stopped.
- **Replay protection by `stopId`.** A stop id that was handled is answered `200 {"status":"ignored","reason":"replayed"}`
  and nothing is done (`src/stop/replay-guard.ts`: in memory, bounded, and the id is forgotten when the platform could not be
  asked, so the same call can be repeated). The memory is per instance: a replay that reaches another instance stops the same
  VMs again, which is harmless because a stop is idempotent. The clock window of the signature (5 minutes) bounds how long a
  captured call could be replayed at all.
- **Tag-scoped.** `jobId` is a strict UUID (it becomes a tag filter, never part of a command). The route lists the VMs
  tagged `{app, kind, job}` for that job and stops those, nothing else (`src/stop/job-stopper.ts`); a VM of another job, a
  canary or a foreign VM is never touched. No VM means `200 {"status":"ignored","reason":"no_vm"}`: a stop is idempotent.
- **Answers.** `202 {"status":"stopping","vms":[...]}` when VMs are being stopped in the background (`waitUntil` on the platform, the
  tracker of the Node test host): stopping a VM with a running container takes 20 seconds or more, and the App does not wait for
  it. `vms` (#493) names the VMs, so the App can take the moment of the answer as the end of their billable minutes; it is
  additive and optional for the reader. `503` with `Retry-After` when the platform could not be asked; the App repeats it. A stop that fails later is logged
  (`vm_stop_failed`, the job and the VM name) and left to the reaper.
- **Log events.** `stop_received` (`jobId`, `vms`), `vm_stopped`, `vm_stop_failed`, `stop_replayed`, `stop_list_failed`
  (`code`), `stop_refused` (`verdict` only). No key, signature or platform text.

A VM is scoped by the tags `app = code-reviewer`, the job's UUID and, since #730, `tenant`, the app that claimed the job (see "More
than one App"): a stop signed by one app of a Dispatcher never reaches a VM of another. Two separate Dispatcher deployments in
one Vercel team must still use different dispatch signing keys (and databases), or one's valid stop could name the other's job
(`docs/deployment-vercel.md`, section 5.5).

A job that goes back to the queue is **not** stopped by the App (the next attempt's VM could already exist when the call
arrives). The VM of a lost attempt lives until its own timeout or until the job ends for good, when the stop by the job also
ends it; the reaper ends it earlier only while the retry is not yet `running` (it keeps a VM whose job is `running`).

## The report of the VM (#493)

The App measures the minutes of a VM (`app/src/billing/README.md`, "Billable minutes") and only the Dispatcher knows when a VM
is created. Right after `Sandbox.create` returned, the Sandbox-Launcher calls `spec.onVmCreated({ name, startedAt,
timeoutSeconds })` (the platform's name, the Dispatcher's clock and the VM's own timeout); the core then sends `POST
/api/runners/v1/jobs/:id/vm` with the dispatcher token and the job credential it holds during the launch (`VmStartRequest`,
`contracts/README.md`). Nothing about the VM reaches the Worker, and the VM gets no new endpoint.

- **Only to an App that lists `vm_lifecycle`** in its version answer (not a required feature: an older App is still served, and
  nothing is sent to it).
- **Best effort, in the background.** The callback returns at once and never throws; the core sends the report while the launch
  goes on and waits for it only at the very end of the launch phase. Up to three tries (pauses of 1 and 3 seconds) for what may
  pass (no answer, `429`, `5xx`); no repeat for a refusal (the claim ended, an old credential). A report that did not work
  logs `vm_report_failed` with the job id and nothing else (never the credential, the URL or the App's text), and **never fails or
  delays a launch, a heartbeat or a job transition**: the App then measures the VM by the backstop of its own, or counts
  0 minutes when it got no report at all.
- A Launcher that creates no VM (the fake) never calls the callback.

## More than one App (#730)

One Dispatcher can serve several Apps (the same code deployed twice, each with its own database). The protocol did not change:
the key that signs a wake-up or stop call already identified the sender, so **a key belongs to exactly one app and the key is
the whole identity of the sender**.

- **Registry.** The legacy variables (`RUNNER_API_URL`, `RUNNER_TOKEN`, `DISPATCHER_SIGNING_*`, `DISPATCHER_MAX_RUNNING`,
  `DISPATCHER_POOL_ID`) define the app `reviewer`, unchanged; with nothing else set the Dispatcher behaves exactly as before.
  `DISPATCHER_APPS` adds apps (`id`, `url`, `kinds`, `keyId`, `maxRunning`, `poolId`), and the secrets come from variables
  named after the id: `DISPATCHER_APP_<ID>_TOKEN`, `DISPATCHER_APP_<ID>_SIGNING_SECRET` and, while rotating,
  `..._SIGNING_SECRET_PREVIOUS` with `..._SIGNING_SECRET_PREVIOUS_KEY_ID`. At start a refusal names the variable (and the app),
  never a value: a repeated id, the reserved id `reviewer`, a repeated key id or address (addresses are compared as the platform
  reads them: `https://APP.example:443/` and `https://app.example` are one address), a kind that is not on the list in code
  (`diff`, `dynamic`; a later `implementer` is added there and in the contracts, never by configuration), a missing or short
  secret, `DISPATCHER_APPS` without `DISPATCHER_OPERATOR_TOKEN`, and a secret equal to any other secret of any app, to the
  operator token or to `CRON_SECRET`. **A malformed `DISPATCHER_APPS` or one missing per-app secret fails the whole Dispatcher at
  start, `reviewer` included** (it does not serve one app and skip another): the pre-promote health check and the canary catch
  it before the deployment is promoted, and the previous deployment keeps serving.
- **Per-app core.** `core.handle({appId, jobId, reviewKind})`: the app comes from the verified key. Each app has its own client
  (address, credential, `X-Runner-Id`), its own cap (`maxRunning`, also sent with its claim; one app at its cap answers `busy`
  and takes no slot of another, so the ceiling is the sum of the caps; see "The cap is counted here too" below), its own memory of the version answer, and its own
  heartbeats, releases and VM reports. `LaunchSpec.appUrl` is the registry's address of the app that claimed the job, never a
  value of a request. A claim answered `204` is `ignored`: there is no fallback to another app.
- **Job kinds per app.** A wake-up call for a kind outside the app's `kinds` is answered `200 ignored` with `not_capable` (an
  answer the App already understands and does not resend on), logged as `kind_not_allowed`, and **no claim is made**. The claim
  asks for the engines of the app's kinds only. A claimed job of another kind, **or of a kind whose engine this Dispatcher does
  not serve** (a Dynamic job when `opencode` is not in `DISPATCHER_ENGINES` or not advertised), is released (`launch_failed`),
  logged as the error `kind_not_allowed` (`reason` `kind` or `engine`), and no VM is created. The `reviewer`'s kinds are the ones of `diff` and `dynamic` whose engine is in `DISPATCHER_ENGINES`: **never `implementer` (#759)**, whatever `DISPATCHER_ENGINES` names (`REVIEWER_KINDS`), and a list that leaves the `reviewer` no kind is refused. `implementer` is a kind an entry of `DISPATCHER_APPS` can name (`"kinds":["diff","dynamic","implementer"]`); the default engines then include `implementer`, and the claim of that app asks for it. The Sandbox launcher advertises `implementer` **only when this deployment serves it** (`settings.core.engines` includes it: an entry of `DISPATCHER_APPS` names the kind, which adds it to the default engines, or `DISPATCHER_ENGINES` names it explicitly; #765); a deployment without the kind advertises exactly `pr-agent` and `opencode`, as before, and the reviewer's key never gets the kind. Where it is advertised a wake-up call for the kind is launched (a launch is refused before a VM is created only for an invalid `DISPATCHER_WORKER_CONFIG.implementer`: `sandbox_config_invalid`). **Set the kind in `DISPATCHER_APPS` only after this version is live: an older Dispatcher refuses the unknown kind at start.** **The deploy canary (`POST /probe`) requires `implementer` exactly when the Launcher advertises it:** the route requires the engines of `diff` and `dynamic` always and `implementer` when `launcher.capabilities` lists it, so a deployment without the kind keeps a canary that depends on nothing of the Implementer, a missing `pr-agent` or `opencode` still fails it, and a deployment with the kind cannot pass with a report that lacks `implementer`. The report can name it: `KNOWN_ENGINES` in `dispatcher/src/probe/verdict.ts`, the `ProbeEngine` enum and the `maxItems` of `ProbeVerdict` and `ProbeReport` in `contracts/probe-verdict.v1.json`, and `runner/src/code_reviewer_runner/verdict.py` all know it. **The canary VM proves it:** for a deployment that serves the kind it runs the `probe` mode a second time in the same VM, in the container profile of the Implementer (the work volume made as a job's is, its flags and environment), and unites the two verdicts (`mergeVerdictOutputs`); `implementer` is in the report only when the Dynamic container passed and the Implementer's container proved git, the guard files, the network rules and a prepared, exec-capable work volume (the `implementer_*` reasons of the verdict say which is missing). `pnpm probe:canary` needs no new option: its default `--engines` stay `pr-agent,opencode`, and the engines the route required are demanded as well, so the canary passes on a deployment with the kind exactly when the report names `implementer`. When it does block, the answer lists the engines the route required (`required`) and the canary prints the missing ones (`missing=`).
- **VM isolation.** Every job VM carries the tag `tenant=<app id>` next to `{app, kind, job}`; the name format is unchanged.
  The stop route lists with the app of the verified key and returns only VMs whose tenant is that app (a VM without the tag was
  created before this release and belongs to `reviewer`): **a stop signed by one app can never end a VM of another**. Stop ids
  are remembered per app. The reaper asks the state of a VM's job at the app its tag names, through that app's client, and
  never at another; an unreadable answer or a tenant this Dispatcher does not serve keeps the VM until its lifetime ends.
  Canary VMs have no tenant. The platform's listing narrows by one tag only, so the tenant is checked in code.
- **The cap is counted here too.** The App enforces an app's cap at the claim, but an app that is buggy or compromised can
  ignore its cap, and one app must not take the Sandbox concurrency of another. Where the platform can be listed (the
  Sandbox-Launcher, i.e. wherever the reaper exists) **and more than one app is configured**, the Dispatcher counts for each claim what the app occupies by its own
  numbers: the live job VMs of its `tenant` tag (a VM without the tag counts for `reviewer`; canaries and VMs the platform is
  ending do not count), the VMs created since the listing, and its launches in progress that have no VM yet. Above the app's
  `maxRunning` **plus a tolerance of the cap and two more** (so twice the cap plus two VMs in all, the VM this call would start
  counted) the wake-up call is answered `busy` (`app_cap_reached` in the log) and **the app is not called at all**. It is a
  backstop against a runaway app, not a fair share: it counts VMs, and a VM outlives its job for a while (the listing is up to
  five seconds old, the stop call of a finished job comes after its result, and the VM of a Worker that died stays until the
  reaper stops it, one per attempt of a crash loop). An exact comparison would refuse the job the App rightly sends, and
  nothing wakes it again before the sweep (the hosted E2E of a crash loop at cap 1 showed it). Even with the tolerance, an app
  in a crash loop whose dead Workers leave more than twice the cap plus two VMs can have a job **delayed, not lost**: the
  wake-up call is answered `busy` and the App offers the job again, until the reaper has stopped the leftovers. The cap is that of the app: for
  `reviewer` `DISPATCHER_MAX_RUNNING`, unchanged. _Cost:_ one listing of the project's `cr-` VMs (all pages) per five seconds at most, shared by every claim in that time;
  claims that arrive together share one call. A claim therefore sees a VM that ended up to five seconds late (the safe side)
  and one that started in that time through the count of the Dispatcher's own launches. A listing that gives no answer in four
  seconds counts as a failed one (claims never wait longer, and a waiting claim holds no launch slot). If the listing fails,
  the last good one is used for up to a minute; after that the claim answers `unavailable` (retry in 60 s, `fleet_list_failed` in the log) and
  nothing is claimed. Without a fleet (a local Launcher), **and with one app only (today's production, a Dispatcher with no
  `DISPATCHER_APPS`)**, the platform is not listed for the cap at all: the cap is the launches in progress and the App's own,
  exactly as before #730, so the cap adds no platform call and no new way to refuse. The count starts with the second app. The sum of the caps
  plus their tolerances should stay within the team's Sandbox concurrency (a platform limit not verified here); then no app
  can starve another.
- **Operator credential.** `POST /probe` (it starts canary VMs, which cost money) and `POST /apps/check` are opened by
  `DISPATCHER_OPERATOR_TOKEN`, not by an app's token. **With `DISPATCHER_APPS` it is required** (the Dispatcher does not start
  without it): next to another app the token of `reviewer` must not open `/probe` either. With only `reviewer` and no operator
  token (rollout, as before #730) `/probe` is still opened by the token of `reviewer`, without a warning; `/apps/check`
  refuses everyone. Several apps assembled without the token (not possible through the environment) open `/probe` to nobody
  and log `operator_token_missing`. `pnpm probe:canary` reads `DISPATCHER_OPERATOR_TOKEN`, else `RUNNER_TOKEN`.
- **`POST /apps/check`** asks each app's `GET /api/runners/v1/version` with that app's credential and answers
  `AppsCheckResponse` (`contracts/dispatcher-ops.v1.json`): ids, booleans and stable codes, no address, secret or text.
- **Rollout.** (1) Release this version with no change of environment: only `reviewer` exists. (2) Add `DISPATCHER_APPS`, the
  app's secrets and `DISPATCHER_OPERATOR_TOKEN`, deploy. Rolling back to an older Dispatcher is safe: it ignores the unknown
  variables.
- **Rollout of the operator token and the deploy canary.** Once the Dispatcher has `DISPATCHER_OPERATOR_TOKEN`, `/probe` is no
  longer opened by `RUNNER_TOKEN`, so the canary of `.github/workflows/dispatcher-canary.yml` must call with the operator
  token or every promotion is blocked. The workflow loads `DISPATCHER_OPERATOR_TOKEN` from Infisical `/ci` **when the key is
  there** (a failed load of that one key is allowed) and `pnpm probe:canary` prefers it over `RUNNER_TOKEN`. In this order:
  (a) release the workflow change to `main` (the key is not in `/ci` yet, so the canary still uses `RUNNER_TOKEN`);
  (b) in one sitting generate the token (`openssl rand -hex 32`, different from every other secret), add it to Infisical as
  `DISPATCHER_OPERATOR_TOKEN` in `/ci` **and** as `${prod.ci.DISPATCHER_OPERATOR_TOKEN}` in `/dispatcher` (the Secret Sync to
  the Dispatcher project; never only one of the two: a canary with the token against a Dispatcher without it, or the other way
  round, is refused with 401 and blocks the promotion); (c) wait for the sync, run _Deploy production_: the staged Dispatcher
  has the variable, the canary uses it, and the run summary says which credential it used. To undo, remove the key from both
  places and deploy. Before (b) the token may exist in no place at all; the order "token into Infisical, then workflow, then
  Dispatcher" works only if (b) is not split. PR #733 (the factory lane) adds the same secret name and an opt-in input to the
  same workflow; the two are compatible: the input forces the operator credential and fails when it is missing, the optional
  load here is for the time before it is on.
- **Not built.** Fair sharing between apps beyond the cap per app, and a per-app snapshot or Worker configuration. A job VM
  now has four tags (`app`, `kind`, `job`, `tenant`); the Sandbox API's typings allow at most five. The limit on the length of
  a tag value is not verified (`tenant` is at most 24 characters, the longest value is the 36 characters of the job id).

## What the core does

1. Engines are the configured ones (`DISPATCHER_ENGINES`) that the Launcher advertises (`capabilities`, fail closed).
   The job's kind must be among them, else `not_capable`. Nothing is probed or waited for here (#479): a Dynamic job is
   accepted whenever `opencode` is configured and a snapshot pair is set, on a cold instance too. The proof of the
   container's hardening is the deploy canary ("The canary probe", below).
2. Capacity: no more launches in progress than `DISPATCHER_MAX_RUNNING`, else `429`; the same number is sent as
   `maxRunning` so the App enforces the cap atomically.
3. The App must offer the features of the split (`GET /api/runners/v1/version`: `worker_api`, `claim_by_job_id`,
   `pool_cap`, `release`), remembered for ten minutes. A previous release has no such route or lacks a feature:
   `503`, nothing claimed. An answer to the claim that is not the split one (a previous release sends the job input
   and a git token) is refused unread.
4. `POST /api/runners/v1/claim` with `{engines, features: ["worker_credential"], jobId, maxRunning}` and `X-Runner-Id`.
   `204` means ignored.
5. `launcher.launch({appUrl, jobId, credential, kind, timeoutSeconds, config}, signal)`, while heartbeating with the
   job credential every `heartbeatIntervalSeconds` so the two minute lease does not lapse. The launch has five
   minutes. At the deadline, or on a shutdown, the signal aborts and the job is released with `launch_failed` (the
   App counts it as a failed attempt). When a heartbeat shows the lease is lost the launch is stopped and nothing is
   released. The credential is held in memory only, in the scope of that one launch, and is dropped when the launch resolves.
   After the hand-over the core never heartbeats again and holds nothing: the Worker owns the lease, and the Dispatcher
   neither watches the container nor releases the job (#487; the release for a container that ended with an error after the
   hand-over, `worker_exited` of #375, is gone: a Worker that dies is found by its lease, which lapses after two minutes, and then by the next expiry pass: the next claim or the sweep, so on an idle instance up to about the sweep interval).
   The release of a launch that failed is made by the App against the job credential: a job that already has its result,
   or that a newer claim holds, is answered `409`/`401` and nothing changes (a `409` is logged at info as
   `release_job_ended`; a `401`/`404` as the warning `release_not_holder`; neither is retried). The release is tried three times; if the App cannot be
   reached it logs `release_failed` with the reason and the lease ends the job as before.
6. Logs go through a masker: the dispatcher token, the signing secrets and anything shaped like a job credential or an
   `Authorization` value are replaced. Only stable codes are logged for an error, never its text.

## The sender

The App sends the call (`app/src/dispatch/README.md`, #326) when it runs with `RUNNER_DISPATCH=webhook`: `RUNNER_WEBHOOK_URL`
is this project's `/dispatch`, and `RUNNER_WEBHOOK_SECRET` / `RUNNER_WEBHOOK_KEY_ID` are `DISPATCHER_SIGNING_SECRET` /
`DISPATCHER_SIGNING_KEY_ID`. It reads only the status (and `Retry-After` of `429`/`503`) of the answer: `202` is
acknowledged, `200 ignored` with `not_claimable` is sent again after two minutes, with `not_capable` never again; `429`
and `503` are retried after `Retry-After` or the back-off, whichever is longer; any other status waits half an hour and
raises an alert in the App's log.

## The Launcher

```ts
interface Launcher {
  capabilities(signal): Promise<readonly Engine[]>; // what it can run; fail closed
  launch(spec: LaunchSpec, signal): Promise<void>; // resolves when the Worker has taken over; throws LaunchError
  probe?(signal): Promise<ProbeResult>; // runs the canary probe now (POST /probe only); never rejects
}
```

`LaunchSpec.config` is the per-kind part of `DISPATCHER_WORKER_CONFIG`: `container` (what the container spec lets a
Launcher change, the memory limit) and `launcher` (the Launcher's own options, which the core does not read).
`LaunchSpec.timeoutSeconds` follows the kind (#759): `DISPATCHER_JOB_TIMEOUT_SECONDS` for Diff and Dynamic, 3600 for the
Implementer unless `DISPATCHER_WORKER_CONFIG.implementer.timeoutSeconds` (60 to 21600) says otherwise; the VM's timeout is
that plus the margin, and the reaper's fallback lifetime is the longest of the kinds some app has.

## The container spec renderer

`src/launchers/container.ts` renders the hardened container spec (`contracts/worker-container.v1.json`, the one
definition of the container) to
`docker run` arguments: foreground with stdin attached, `--rm`, the user, `--cap-drop ALL` and the eight
`--cap-add`, `no-new-privileges`, a read-only root, the three tmpfs, memory, reservation, swap, pids, stop timeout
and the default bridge. No `--privileged`, no mount, no device, no host namespace. `renderDockerRunArguments`
refuses a spec that weakens the container (a forbidden key, a weaker value, an unknown key) and an option that
could become a flag, with the stable codes of `CONTAINER_ERROR_CODES`.

- `ContainerLauncher<H extends ContainerHost>` takes a host (where `docker` runs: the Sandbox VM, a local daemon)
  and a `LaunchSpec`. It renders the flags with `spec.config.container` (the memory limit of the job's Worker
  kind: `applyOverrides` changes only the keys the spec lists as overridable and keeps the swap equal to the limit),
  sets `RUNNER_JOB_TIMEOUT_SECONDS`, and hands `{appUrl, jobId, credential}` to the container on **stdin only**. It
  refuses to start if an argument would contain the credential.
- **Per-launcher additions (#345).** `RenderOptions.additions` / `ContainerLauncherConfig.additions` take the
  contract's `WorkerContainerLauncherAdditions`: exactly the two `net.ipv6.conf.{all,default}.disable_ipv6=1`
  switches, rendered as `--sysctl`, nothing else (`additions_not_allowed`). The Sandbox-Launcher passes
  `SANDBOX_LAUNCHER_ADDITIONS` for every Worker kind, because the Sandbox kernel only supports the nft `ip` family
  and the Dynamic-Worker then needs IPv6 off from the container spec. The shared spec does not have them
  (a full-mode host behaves as before); the default is no additions.
- **The Implementer's profile (#760).** `IMPLEMENTER_CONTAINER_SPEC` (`ImplementerContainerSpec` of the contract) is the
  default spec with a `workVolume` (`/work`, `rw,nosuid,nodev`, a named volume), `3g`/`2560m` memory, 2048 pids and the three
  `RUNNER_IMPLEMENTER_*` names. A spec with a `workVolume` key is checked as the profile (exact values, the floor shared),
  every other as the default one; `RenderOptions.workVolume` names the volume (required by the profile, refused by the
  default) and renders `--mount type=volume,source=<name>,target=/work`. `workVolumeCommands` returns the root steps that make
  the volume in the VM (`mkdir`, a bind mount remounted with the volume's options, `docker volume create` over it), which
  `SandboxDockerHost.createWorkVolume` runs; the Launcher picks the profile by the job kind. Diff and Dynamic render
  byte-identical flags to before (the golden files).
- The entry mode of the image (`worker-once`, `probe`) is a placeholder until the image has its entry modes (#324); the
  names are those #324 proposes, and nothing else changes when it fixes them.
- `seccomp.ts` derives, from Docker's default profile, a profile that denies chosen socket families (AF_VSOCK);
  off unless a profile path is passed as `seccompProfile`. Not required by the spike; not yet run against a daemon.
- A Sandbox VM needs `docker/sandbox/vm-prepare.sh` (the cgroup root fix, then `dockerd`) before the first
  `docker run` with limits; it is the host's job, not part of the flags. The Sandbox-Launcher runs it on every VM start.

## The Sandbox-Launcher

`src/launchers/sandbox.ts` starts the Worker of one job as our hardened container inside a fresh Sandbox VM
(#329). Vercel's firewall is not part of the security boundary: everything security-relevant comes from the container
(`ContainerLauncher`, one spec), run through Docker inside a throw-away VM. All platform-specific code is in
`vercel-sandbox.ts`, behind the small `SandboxService` port of `sandbox-service.ts`; `fakes/sandbox/` holds the doubles.

Per job, after the core has claimed it:

1. `Sandbox.create` from the golden snapshot (#330): `persistent: false` (a persistent sandbox writes a snapshot of the
   job on stop), region `fra1`, no failover region (snapshots are region-bound), a VM size per Worker kind, tags
   `{app, kind, job}`, and a **timeout of the job's plus 300 seconds** (`SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`, at least 180 and at least 150 more than the
   hand-over time: the platform counts from the creation of the VM, the Worker's own timer from the start of the container, so
   the margin has to cover create, `vm-prepare.sh`, the image check and the hand-over besides the Worker's `timeout` result), the backstop that ends a VM nobody stops. The name
   is `cr-<kind>-<job id>-<random>`: unique per launch, so a second attempt of a job never meets the first one's VM, and
   it carries the job for lookup. A VM is never reused.
2. `/usr/local/sbin/vm-prepare.sh` as root (the cgroup fix and `dockerd`, spike F1), then `docker image inspect` of the
   image in the VM: its id must equal `SANDBOX_IMAGE_DIGEST`. Otherwise `image_mismatch` and the VM is stopped.
3. `docker run --interactive` with the flags of the container spec (`SANDBOX_LAUNCHER_ADDITIONS` for every kind), by
   image **id** (exactly what was verified, never a pull). The start document `{appUrl, jobId, credential}` is written to
   the process's stdin and the pipe closed. **It is in no argument, no environment variable and no file on the VM**; the
   SDK adapter has no way to set an environment or write a file, and a test searches every request for the credential.
4. The launch resolves when the Worker has taken over: the container is running and has run for `SANDBOX_HANDOVER_SECONDS`
   (20), or ended with 0 sooner. Until then the core heartbeats with the credential so the lease does not lapse. A
   container that ends with an error first is `worker_exited_early`. The time is the stand-in for the Worker's own first
   heartbeat, which the Worker does not announce (follow-up).
5. **After the hand-over the Launcher holds nothing (#487).** `launch()` resolves and ends: no `wait()` on the container, no
   work in `waitUntil`, no stop, no callback. The Worker owns the lease and the VM is ended by the App's signal (`POST /stop`,
   "The stop call"), with the reaper and the VM timeout as the safety nets. A Worker that dies after the hand-over is not
   seen by the Dispatcher: its lease lapses after two minutes without a heartbeat and the App requeues the job at the next expiry pass (the next
   claim or the sweep: on an idle instance up to about the sweep interval, 2 hours; the attempt is lost either way). There is no `poweroff` in the image (spike T13), so a VM is only ever ended by `stop()`
   (about 2.4 s for an idle VM, 22.6 s with a running container).
   An exit with an error _before_ the hand-over fails the launch with `worker_exited_early`, and the core releases the job
   once, with `launch_failed`.

**The function lifetime and the VM timeout.** Nothing is held in `waitUntil` for a job's life any more. A function lives for
the launch (at most 300 s: create, prepare, image check, hand-over) and for the work it started in the background: the
stop of a failed launch's VM, and the stops of `POST /stop`. `vercel.json` still sets `maxDuration` of `src/index.ts` to
**1800 s** and the region to `fra1`; that was sized for the supervision (job plus launch) and the launch alone needs far less,
so lowering it is a follow-up once a deployment has run without supervision. Production had observed the platform cutting
the old supervision at 300 s, which left the VM running, idle and billed until the VM timeout: this change is the answer.
Where the App's stop call does not arrive (the App is down, the call failed after its retries, a requeued job, a Dispatcher
that was restarted before the stop finished), **the reaper and the VM timeout are the backstop**: the VM keeps running, idle
and billed, until the next reaper run that finds its job not `running`, or until job + margin after its creation. A requeued
job whose retry is already `running` keeps the lost attempt's VM until its own timeout, or until the job's final stop.

Every failure before the hand-over stops the VM by name and ends in a `LaunchError` with a stable code and a `retryable`
flag. The core releases the job with `launch_failed` and the App counts the attempt (three attempts, then `failed`), no
matter whether the flag is set; it is for logs and for the operator (log lines `launch_failed` with the code and `retryable`,
then `released`, `release_job_ended`, `release_not_holder` or `release_failed`, each with the `reason`).

| Code                                                                      | Retryable                    | Cause                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox_rate_limited`, `sandbox_quota_exceeded`                          | yes                          | the platform's limits                                                                                                                                                                                                                                                                |
| `sandbox_network`, `sandbox_unavailable`                                  | yes                          | no answer, or a platform error (these also stop by name: the VM may exist)                                                                                                                                                                                                           |
| `image_not_ready`                                                         | yes                          | the platform says the snapshot is not ready                                                                                                                                                                                                                                          |
| `sandbox_auth_failed`                                                     | no                           | the platform refuses the credentials (HTTP 401 or 403): an expired or wrong token or OIDC token                                                                                                                                                                                      |
| `docker_not_ready`                                                        | yes                          | `vm-prepare.sh` exited with an error (cgroup or `dockerd`). The log line `vm_prepare_failed` (`code`, `exitCode`, `sandbox`, `jobId` or `canary`) carries `stderrTail`: the last lines of its stderr, masked and capped (#473)                                                       |
| `vm_prepare_failed`                                                       | yes                          | a call of the host preparation failed in a way no other code names (a platform failure keeps its own code)                                                                                                                                                                           |
| `worker_exited_early`                                                     | no for exit 1, yes otherwise | the container ended with an error before the hand-over. Exit 1 is the Worker reporting that the job failed, after delivering its own result: a second VM gets the same answer. A setup error (2), docker's own refusals (125 to 127) and a kill (137) are about this VM or its start |
| `worker_start_failed`                                                     | yes                          | the container could not be started                                                                                                                                                                                                                                                   |
| `sandbox_snapshot_missing`, `sandbox_region_mismatch`, `sandbox_rejected` | no                           | the snapshot is gone or in another region; the platform refuses the request                                                                                                                                                                                                          |
| `image_missing`, `image_mismatch`                                         | no                           | the VM has no such image, or not the configured one                                                                                                                                                                                                                                  |
| `sandbox_config_invalid`                                                  | no                           | a VM size or memory limit the Launcher cannot run                                                                                                                                                                                                                                    |
| `work_volume_failed`                                                      | yes                          | a step of the Implementer's work volume failed, took over 10 s, or the mount lacks `nosuid`/`nodev`/`rw` or has `noexec`                                                                                                                                                             |
| `sandbox_create_failed`                                                   | no                           | an error it does not recognise                                                                                                                                                                                                                                                       |
| `launch_aborted`                                                          | no                           | the deadline, a lost lease or a shutdown aborted the launch                                                                                                                                                                                                                          |

The classification of the platform's errors goes by the HTTP status first (429 rate limit, 402 quota, 401 and 403 authentication, 5xx platform), then by the code of the error body (an explicit quota or `limit_exceeded` code), then by words of the message for the snapshot and the region; a message that only says `limit` or `exceeds` is not a quota; the
platform does not document its error bodies, so the mapping is **not verified against the live API** (a follow-up of the
first real run). Only the code is logged, never the platform's text.

**Sizes.** The platform's VMs have 1 vCPU or an even number up to 8, and 2 GiB of memory per vCPU. Per Worker kind,
`DISPATCHER_WORKER_CONFIG` sets the VM (`launcher.vcpus`) and the container memory (`container.memory`), for example
`{"dynamic": {"launcher": {"vcpus": 2}, "container": {"memory": {"limit": "3g", "reservation": "2g"}}}}`. Without
configuration both kinds get 1 vCPU / 2 GB and a container limit of `1536m` (reservation `1280m`), which leaves room
for `dockerd` and the OS; a limit that leaves the VM less than 256 MiB is refused. The spike suggests 2 vCPU / 4 GB for
the Dynamic-Worker; its real peak is not measured yet, so that is a configuration change, not a code change. A wrong
value of Diff or Dynamic fails the deployment at start (`DISPATCHER_WORKER_CONFIG`), not the first job. The Implementer (#760) defaults to
2 vCPU / 4 GB and a container limit of `3g` (reservation `2560m`); `DISPATCHER_WORKER_CONFIG.implementer` overrides each value,
and a wrong value of it never stops the Dispatcher from starting: a
deployment that serves the kind logs `worker_config_invalid` at start, and every launch of the kind is refused with
`sandbox_config_invalid` until the value is corrected (a deployment that does not serve the kind does not read the entry). **The same value also fails the canary of a deployment that serves the kind** (the canary cannot size the Implementer's VM: its half is `implementer_probe_failed` and `POST /probe` is `503`), so the release of that deployment, code-review.com's included when it serves the kind, is blocked until the value is corrected. Its container is the profile `IMPLEMENTER_CONTAINER_SPEC` (next section), and its launch makes the work
volume in the VM between the image check and `docker run`.

**Capabilities.** The Launcher advertises `pr-agent` and `opencode`, and `implementer` when the deployment serves the kind (an app of `DISPATCHER_APPS` names it, #765); the engines the deployment serves are its
`DISPATCHER_ENGINES` (#479). No probe stands between a Dynamic job and its claim: the hardening of the container is
proven by the deploy canary before a deployment goes live (next section), and the Worker checks itself again when it
starts.

**The Dynamic configuration of the container.** The container of a Dynamic job (not a Diff job's) is given the operator's
`RUNNER_DYNAMIC_CAPABILITIES` (the model's descriptor, a JSON object) and `RUNNER_DYNAMIC_MAX_COST_USD` (the cost limit of
a run) from the Dispatcher's own environment: both names are on the
container spec's allow-list, both are non-secret, and a value that is not of the right form fails the deployment at start,
not the first Dynamic job. The runner reads them again and decides what they mean. The canary gets the same. They are read, and refused when malformed, only by a deployment that serves Dynamic jobs
(`DISPATCHER_ENGINES` includes `opencode`): a typo there does not take a Diff-only Dispatcher down.

**What the container can reach (documented, not relied on).** The VM's agent listens on `172.17.0.1:23456` (the Docker
bridge gateway). Container root can reach it; the Dynamic engine's uid cannot, only because the egress rules drop it
(spike #317). No process in the VM can open an `AF_VSOCK` socket: a platform filter denies it, and Docker's default
profile adds a second layer. Nothing here depends on these; they are recorded because the supervisor's egress inside the
VM is unrestricted by design (#82 stays an open hosted gate). The platform operator can read job secrets by construction.

**Authentication.** Without credentials the SDK uses the OIDC token of the Vercel project, automatic inside a Function.
With `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` it uses that access token. The token is masked in every log
line and is never sent anywhere but to the SDK.

## The canary probe

The Dynamic-Worker's container must be hardened, and "hardened" is proven, not configured. **The deploy canary is the only
proof** (#479): a deployment goes live only after `POST /probe` of the staged Dispatcher passed with `opencode`, and the
snapshot pair and the settings cannot change during a deployment's lifetime. The Dispatcher therefore runs **no probe when
a job is dispatched or claimed**, keeps no in-memory proof and has no time to live for one: a Dynamic job is accepted
whenever `DISPATCHER_ENGINES` contains `opencode` and a snapshot pair is set, on a cold instance as on a warm one, and no
canary VM is started by a dispatch. (Earlier, a cold instance answered the first Dynamic wake-up `503` with
`Retry-After: 20` while a probe ran, which the App did not wait for; `CapabilitiesPending` and `withCapabilityProbe` are
gone.) The Vercel entry gives the Sandbox-Launcher its `probe` with `withProbeEndpoint` (`src/probe/probe-endpoint.ts`)
when `DISPATCHER_ENGINES` includes `opencode` **or `implementer`**; a Diff-only deployment has no probe and no canary VM.

**What is proven.** The image's `probe` mode (#324, `runner/README.md`) runs the container's own startup in a canary VM
and prints one line, the verdict (`contracts/probe-verdict.v1.json`): the engines the container may advertise and, when
`opencode` is not among them, the stable reasons of the startup self-check (`docs/dynamic-review.md`, "The startup
self-check"). `opencode` is in it only when the whole self-check passed: the hardening of the container (root, the eight
capabilities then `NET_ADMIN` and `SETPCAP` dropped, a read-only root), the egress mode (the full `inet` ruleset or the
fallback), IPv6 proven off where the fallback ruleset needs it, the pinned engine and `rg`, and the probe as the engine
user. The canary runs with the **real flags** of a Dynamic-Worker: the one rendered container spec, the memory of the
Dynamic kind, the two IPv6 switches of the Sandbox variant (`SANDBOX_LAUNCHER_ADDITIONS`) and the Dynamic environment of a
job, so a launch flag that is wrong makes the probe fail instead of the job. A deployment that serves the Implementer gets a **second probe in the same VM** (#765): the container of the Implementer's profile (`IMPLEMENTER_CONTAINER_SPEC`, its memory, its three environment names and the work volume made as a job's is), also by the real flags, and `probe` as its command. The VM is as large as the larger of the two kinds. **The two halves do not take each other down:** `opencode` and its reasons are read from the Dynamic container's output only, `implementer` and its reasons from the Implementer's only (`mergeVerdictOutputs`). When the second half cannot be run, is no verdict or fails a check, the Dynamic verdict stands and the report says `implementer_probe_failed` (or the Implementer's own `implementer_*` reason), and the canary log names the half (`canary_implementer_probe_failed`, `canary_implementer_not_proven`).

**The canary VM** (`src/launchers/sandbox-canary.ts`) is a job VM without a job: a VM from the golden snapshot
(`persistent: false`, `fra1`, the size of a Dynamic job, tags `{app, kind: canary, job: canary}`, a timeout beyond the
probe's own as the backstop), `vm-prepare.sh`, the image check (a probe of another image proves nothing), `docker run` of
the image by id with `probe` as its command, and the VM is stopped by name whatever happened. It has no stdin, no App URL,
no token and no credential. The exit status of the probe must be 0 (the probe ran; 2 means it had nothing to say).

**Reading the verdict** (`src/probe/verdict.ts`) treats it as data from a container that runs next to hostile pull request
content: one line, at most 64 KiB, version 1; the engines it knows and the reasons of the contract's closed list are
kept, anything else (a field, a text, a value shaped like a secret) is dropped and never echoed or logged. `opencode`
counts as proven only when the verdict says it **and** gives no reason against it, and no reason was dropped as unknown.

**One probe at a time** (`src/probe/capability-probe.ts`). Any number of forced probes share the one that runs. A probe that
takes longer than `DISPATCHER_PROBE_TIMEOUT_SECONDS` (150) is a `failed` answer (`probe_timeout`). The probe then waits up
to 10 seconds for the run to finish stopping its canary VM before it answers, so the stop is part of the work held in
`waitUntil` and a frozen function does not leave the VM to its timeout. The last answer, whatever its status, is kept in
memory only to serve a forced probe within `DISPATCHER_PROBE_REUSE_SECONDS` (below); it is never read by a dispatch.

**What a wake-up call sees.** The same for both kinds: the core applies `DISPATCHER_ENGINES`, the cap and the claim. A Dynamic
job on a Dispatcher that is not configured for `opencode` is answered `200 ignored` with `not_capable` (the App stops
sending it, revives the dispatch ten minutes later, and a Dynamic job that nobody can run ends `no_capable_runner` after 30
minutes without a working runner, 3 hours at the latest, `app/src/dispatch/README.md`). A `503`/`429` the App sees now comes from a busy or failing Dispatcher or platform,
never from a probe; the App repeats it inside the request and wakes it again from the repair work
(`app/src/dispatch/README.md`, "Between two sweeps").

The stable reasons and codes are logged (`probe_passed`, `probe_denied` with the reasons, `probe_failed` with the code):
the reasons of the self-check list, and for a probe that gave no verdict a code of the **closed** list `ProbeFailure`
(`src/probe/failure-codes.ts`, equal to the contract's): the launch codes of a job VM (`sandbox_unavailable`,
`docker_not_ready`, `image_mismatch`, ...) and `probe_timeout`, `probe_unreadable` (the output is not a verdict),
`probe_exit_nonzero`, `probe_exec_failed`, `probe_aborted`, `probe_not_supported`, `probe_error`. Anything else, such as a code in
a platform's error, is `probe_error`.

**Cost.** One short canary VM (tens of seconds) per deploy canary, and no other; a deployment that serves the Implementer adds the steps of the work volume and a second probe to it (`IMPLEMENTER_PROBE_EXTRA_SECONDS`: the probe's time, the VM's life and the reaper's `canaryLifetimeSeconds` grow by that, well inside the function limit of 1800 s; the deploy canary's own request timeout of 300 s holds with the defaults). A Diff-only deployment
(`DISPATCHER_ENGINES=pr-agent`) has no probe.

**Retired setting.** `DISPATCHER_PROBE_TTL_SECONDS` (how long an answer counted) is obsolete. A deployment that still sets
it starts, ignores the value (whatever it holds) and logs `deprecated_setting` once per instance; support for it is removed in
a later release.

### `POST /probe`

Forces a probe (or joins the one that runs) and answers its report (`ProbeReport` of the contract). The call needs the
dispatcher credential as `Authorization: Bearer <RUNNER_TOKEN>`, checked in constant time **before** anything is started: a
refused call creates no VM, and every refusal is the same `401` with the same body.

**Throttle.** A forced probe is served from the last answer, whatever its status, when that is younger than
`DISPATCHER_PROBE_REUSE_SECONDS` (60; 0 turns it off; `checkedAt` of the report says when it was made), so a holder of the
credential cannot run canary VMs back to back. A fresh deployment instance has an empty cache, so the deploy canary
against a new deployment is always a real run. A probe that failed or was denied is reported to its caller and the deploy
step is blocked; it changes nothing about what the running Dispatcher dispatches.

| Status | Body                                                                                          | Meaning                                                           |
| ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `200`  | `{version, status, ok: true, engines, reasons, required, checkedAt}`                          | every engine this deployment is configured to serve is advertised |
| `503`  | the same with `ok: false`; `status` is `denied` (with `reasons`) or `failed` (with `failure`) | the canary did not pass, or could not run: block the release      |
| `401`  | `RUNNER_UNAUTHORIZED`                                                                         | no, a wrong or a malformed credential                             |

`status: failed` with `failure: probe_not_supported` is a Launcher that has no probe (`noLauncher`, or a
Diff-only deployment): it proves nothing and advertises what it advertises.

### The deploy canary

`pnpm probe:canary --url https://<dispatcher> [--verify-vercel [--expect-commit <sha>]] [--allowed-hosts host,host] [--check-only] [--engines pr-agent,opencode] [--wait-seconds 120] [--timeout-seconds 300]`
(`src/probe/canary.ts`) is the step of a release pipeline that calls `POST /probe` and fails the release when the Dynamic
canary fails. The credential is `RUNNER_TOKEN` in the environment (never an argument); `VERCEL_AUTOMATION_BYPASS_SECRET`, when set,
is sent as `x-vercel-protection-bypass` for a deployment behind deployment protection. It waits for the deployment to answer
`GET /health` first (never sending the credential there), sends the credential to that one URL (https, or http to this machine;
no redirect is followed) and prints stable codes and the contract's reasons only. With `--allowed-hosts` (or
`CANARY_ALLOWED_HOSTS`) a URL whose host is not on the list is refused with exit 2 **before any request**, this machine included;
an empty list refuses every URL (for a person at a terminal). With **`--verify-vercel`** (what the release pipeline uses) the
command first asks the Vercel API, with `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` (the Dispatcher's project) from
the environment, whether the deployment behind the URL's host is a **ready production deployment** of that project and that team (and,
with `--expect-commit <sha>`, built from that commit: `meta.githubCommitSha`, which the deploy step sets), and sends
nothing to the host otherwise. A 429, a 5xx or no answer from the platform is asked again twice and then reported as
unavailable, not as a wrong deployment. The URL must then be https on the default port with no path, and the host must be the deployment's own
address (the API answers with it as `url`): an alias or a domain is refused. The token goes to `api.vercel.com` only, the
dispatcher credential to the verified host only, and the API's answer is never printed. A staged production deployment gets
a new host with every deployment, which is why a list of hosts cannot work in a pipeline. `--check-only` does only these
checks, without a credential and without a probe.

`CANARY_EXPECT_IMAGE_DIGEST` (an image id `sha256:...`) and `CANARY_EXPECT_SNAPSHOT_ID` (a snapshot id) are the pair the
deployment must report: `POST /probe` names the image and the golden snapshot the deployment is configured with
(`SANDBOX_IMAGE_DIGEST` and `SANDBOX_SNAPSHOT_ID`; `imageDigest` and `snapshotId` in `contracts/probe-verdict.v1.json`), the
Launcher proves in the canary VM that the snapshot holds exactly that image, and the canary fails with
`canary_image_mismatch` (exit 1, no id printed) when the answer names another image or snapshot or none. The pipeline
passes the pair of the snapshot it built, so a pair that did not reach the staged deployment cannot pass on the old
one, and a rebuild that left the image id unchanged is told apart by its snapshot id.

| Exit | Meaning                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the deployment advertises every required engine (both by default, and `implementer` when it serves the kind) from a probe that ran just now                                                                 |
| `1`  | it does not, it could not be reached or refused the credential, or answered something that is not a report, or the Vercel API could not be asked (`canary_verification_unavailable`): **block the release** |
| `2`  | wrong use (a bad URL or option), or a deployment that is not the Dispatcher project's (`canary_deployment_not_verified`); nothing was sent                                                                  |

`.github/workflows/dispatcher-canary.yml` runs it (`workflow_dispatch`, or `workflow_call` from `deploy-production.yml`, which
calls it between "stage the Dispatcher" and "promote") with `--verify-vercel`, in the GitHub environment `production`. Its
inputs are `url` (the staged deployment's own address) and `engines` (`pr-agent` for a Diff-only deployment). The job loads
`RUNNER_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_DISPATCHER_PROJECT_ID` and
`VERCEL_DISPATCHER_AUTOMATION_BYPASS_SECRET` from Infisical `prod` `/ci` with the shared action
`.github/actions/infisical-ci-secrets`, after the dependencies were installed and just before the canary step, and it runs
only from `main` (its own condition, because a manual run executes the code of the branch it is started on). The
Infisical sign-in is four **secrets** of the environment `production` (`docs/deployment-vercel.md`, section 2.1); the
environment's deployment branches are restricted to `main` as the second layer. **Retired:** the environment
`hosted-canary` and the repository variable `DISPATCHER_CANARY_HOSTS`: the canary keeps no list of hosts any more.

The sequence of a release is the workflow `deploy-production.yml` (`docs/deployment-vercel.md`, section 5.6): the
Dispatcher is deployed as a staged production deployment (`vercel deploy --prebuilt --prod --skip-domain`; a preview
deployment does not have the production variables) that carries the golden snapshot pair of the run as its own run-time
variables, the canary runs against it with the commit of the run and the image id the run built, and only on exit 0 and a
healthy App is anything promoted. `rollback-production.yml` puts a previous deployment back by hand.

### The snapshot steps of the pipeline (`pnpm snapshot:ops`)

`pnpm snapshot:ops <decide|persist|exists|verify|cleanup>` (`src/snapshot/ops-cli.ts`) holds the steps of the deployment that
look after the golden snapshot, so that their logic is tested apart from the workflow. Ids, tokens and the Infisical
client secret come from the environment, never from arguments; every line printed is a stable code; the exit status is
0 done, 1 failed, 2 wrong use.

| Command                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `decide --sha <commit> --env-file <file> --github-output <file> [--force]` | Does the Worker image need a new snapshot? Compares the commit of the pair in use (the live deployment's meta, else the project's pulled variables) with the commit given, on the paths of `IMAGE_INPUT_PATHS` (`src/snapshot/pair.ts`: exactly what the build consumes). Rebuild if they differ, if the commit or the pair is missing, if the snapshot of the pair no longer exists, or with `--force`. Stops (exit 1) when the live deployment or the list of snapshots cannot be read. Writes `rebuild`, `reason`, `repair`, the pair and `previous-snapshot-id` as step outputs. |
| `persist [--from-deployment <id or address>]`                              | Writes the pair (`PAIR_SNAPSHOT_ID`, `PAIR_IMAGE_DIGEST`, `PAIR_COMMIT`, or the pair in the meta of the deployment) to Infisical `prod` `/dispatcher`: signs in with `INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`, finds the project by `INFISICAL_PROJECT_SLUG` on `INFISICAL_DOMAIN` (https only), updates the three keys one after the other and creates one that does not exist. Nothing else is written. Imports nothing but our own modules and Node built-ins (a test holds it).                                                                                       |
| `exists`                                                                   | Is the golden snapshot `PAIR_SNAPSHOT_ID` still there? `snapshot_missing` or `snapshot_lookup_failed` otherwise. Run before a deployment uses a pair.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `verify --deployment <id or address> [--check-snapshot]`                   | Is the deployment a ready production deployment of the project and team (`VERCEL_PROJECT_ID`)? With `--check-snapshot`, is the snapshot of its pair still there (`rollback_snapshot_missing`)? Used before a rollback.                                                                                                                                                                                                                                                                                                                                                               |
| `cleanup`                                                                  | Removes the golden snapshots except `KEEP_SNAPSHOT_IDS` and the one the live deployment runs; with `DISCARD_SNAPSHOT_ID` removes just that one. Leaves a young snapshot (three hours) that is not kept alone, and removes a builder with no snapshot older than that. Removes nothing when the live deployment cannot be read or when no kept snapshot is among the builders.                                                                                                                                                                                                        |

**The engine uid and the VM's agent channel (#317).** The spike found that no process in the VM can open an `AF_VSOCK` socket
(a platform filter) and that the container's root can reach the VM's agent on the Docker bridge gateway while the engine
uid cannot, only because its egress rules drop it. The probe proves those rules (`network_probe_failed`, `network_rules_not_installed`),
so a Dynamic-Worker whose rules are not in place is not advertised. A seccomp profile that denies a socket family
(`src/launchers/seccomp.ts`) stays available but is not required and is not enabled.

## The reaper (#364)

The App stops a job's VM with a signed `POST /stop` when the job's claim ends ("The stop call"). A stop that did not
arrive or failed, a job that went back to the queue, or a VM that nobody was told about (the App of a previous release sends
no stop) leave the VM running, idle and billed, until its own timeout (job timeout plus margin). The reaper is the safety net:
the platform's cron calls
`GET /api/cron/reap-sandboxes` every five minutes (`vercel.json`) and it stops the VMs that outlived their purpose.

- **Credential.** `CRON_SECRET` of this project, which the platform sends as `Authorization: Bearer <secret>`. A secret
  of its own: at least 32 characters, no space or control character, and different from the dispatcher credential and
  every signing secret; no other credential opens the route, and it opens nothing else. The route exists only with a
  golden snapshot configured (otherwise `404`). Where it exists, a malformed secret is a start-up error (fail closed) and
  an unset one makes every caller get `401`, with a `reaper_cron_secret_missing` warning at start. Where it does not
  exist, a malformed `CRON_SECRET` is ignored with a `cron_secret_ignored` warning (variable and reason, never the value),
  so a Dispatcher that never reaps is not taken down by it.
- **Which VMs.** The listing is narrowed by the name prefix `cr-` and the tag `app = code-reviewer`, and every VM it
  returns is checked again: only a running or pending, non-persistent VM of exactly the shape our code creates is ever considered.
  A job VM is named `cr-<diff|dynamic>-<job id>-<8 hex>` with the tags `kind` and `job` equal to the name's; a canary
  VM (#331) is named `cr-canary-<8 hex>` and tagged `kind = canary`, `job = canary`. The golden snapshot's builder and
  check VMs carry the same `app` tag, a `role` tag and `code-reviewer-golden-` names (the builder is also persistent): they never match, and neither does
  anything else (another deployment's VM, a person's, a lookalike).
- **Which are leftovers.** Younger than two minutes: never. Older than its lifetime (the timeout the platform reports
  for the VM, or the configured one: job timeout plus VM margin for a job VM, `DISPATCHER_PROBE_TIMEOUT_SECONDS` plus the
  margin for a canary; plus two minutes of grace; a reported timeout above the longest possible one is not believed):
  stopped, whatever the App says. A canary has no job, so only that ends it. A job VM: stopped when the App says its job
  is not `running` (`GET /api/runners/v1/jobs/{id}` with the dispatcher credential, one call per job).
- **A draining job (#397).** A superseded job whose claim is still valid (`draining: true` in the job state): its Worker is finishing the model requests in flight and reporting what they cost. The VM stays until the claim ends (the Worker's report, or the App's claim window of 240 seconds), then it is a leftover like any other. An App that does not send the field, or a Dispatcher that does not read it, treats a superseded job as ended.
- **Fail safe.** If the App's answer cannot be read (no answer, a refusal, a server error, an App without the call, an
  unknown job or status, a body of another shape) the VM is kept: only its lifetime can stop it then. A failed listing
  stops nothing and answers `500 REAP_LIST_FAILED`.
- **Stopping and logs.** By the listed name; a VM that is already gone is not an error, a failed stop is counted and
  retried by the next run (runs may overlap, stopping twice is harmless). Stable events and codes only
  (`vm_reaped`, `vm_reap_failed`, `job_state_unreadable`, `reap_done`, `reap_list_failed`); the answer holds counts
  (`listed`, `candidates`, `stopped`, `kept`, `unreadable`, `failed`). No credential, token or platform error text.

Not verified against the live platform: that `Sandbox.list` honours the name prefix together with a tag in one call and
reports `status`, `createdAt`, `timeout` and `tags` as the SDK types say, and that the project's cron may run every five minutes
(first deployment, staging). The reaper does not depend on the platform's filter: it checks every VM itself.

## Configuration

Names only: a refusal names the variable, never the value.

| Variable                                                                   | Meaning                                                                                                                                                                                       | Default                                                                                 |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `RUNNER_API_URL`                                                           | Base URL of the App                                                                                                                                                                           | required                                                                                |
| `RUNNER_TOKEN`                                                             | The dispatcher credential (the runner API token)                                                                                                                                              | required                                                                                |
| `DISPATCHER_MAX_RUNNING`                                                   | The pool cap, 1 to 1000                                                                                                                                                                       | required                                                                                |
| `DISPATCHER_SIGNING_KEY_ID`, `DISPATCHER_SIGNING_SECRET`                   | The key the App signs the wake-up call with; the secret has at least 32 characters and differs from every other secret                                                                        | required                                                                                |
| `DISPATCHER_SIGNING_KEY_ID_PREVIOUS`, `DISPATCHER_SIGNING_SECRET_PREVIOUS` | The previous key, accepted while the keys rotate                                                                                                                                              | none                                                                                    |
| `DISPATCHER_POOL_ID`                                                       | Sent as `X-Runner-Id`; the App counts the running jobs of the pool by it                                                                                                                      | `dispatcher`                                                                            |
| `DISPATCHER_ENGINES`                                                       | `pr-agent`, `opencode`, `implementer` or a list; the `reviewer` never gets `implementer`                                                                                                      | `pr-agent,opencode`, plus `implementer` when an app of `DISPATCHER_APPS` names the kind |
| `DISPATCHER_JOB_TIMEOUT_SECONDS`                                           | How long a Worker of Diff or Dynamic may live, 60 to 21600                                                                                                                                    | `1200`                                                                                  |
| `DISPATCHER_WORKER_CONFIG`                                                 | JSON `{"diff": {...}, "dynamic": {...}, "implementer": {...}}` with `container.memory` and `launcher`; `implementer` also `timeoutSeconds` (60 to 21600)                                      | none (Implementer: 3600 s)                                                              |
| `SANDBOX_SNAPSHOT_ID`                                                      | Vercel entry: the golden snapshot (#330 record `snapshotId`). Unset: no launcher, nothing is claimed                                                                                          | none                                                                                    |
| `SANDBOX_IMAGE_DIGEST`                                                     | The Worker image id in that snapshot (#330 record `imageDigest`, `sha256:` and 64 hex). Required with the snapshot                                                                            | none                                                                                    |
| `SANDBOX_HANDOVER_SECONDS`                                                 | How long the container runs before the Worker counts as having taken over, 1 to 120; with create, `vm-prepare.sh` and the image check (150 s) it must fit in the core's 300 s launch deadline | `20`                                                                                    |
| `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS`                                        | Seconds added to the job's timeout for the VM's own, 180 to 3600 and at least the hand-over time plus 150                                                                                     | `300`                                                                                   |
| `DISPATCHER_PROBE_TTL_SECONDS`                                             | **Retired (#479), ignored.** Accepted with any value and a `deprecated_setting` warning; removed in a later release                                                                           | none                                                                                    |
| `DISPATCHER_PROBE_REUSE_SECONDS`                                           | A forced probe (`POST /probe`) is served from an answer younger than this instead of a new canary VM, 0 to 600; 0 runs every one                                                              | `60`                                                                                    |
| `DISPATCHER_PROBE_TIMEOUT_SECONDS`                                         | How long a probe may take, the canary VM included, 30 to 600; the reaper (#364) takes a canary's lifetime from it plus the margin                                                             | `150`                                                                                   |
| `RUNNER_DYNAMIC_CAPABILITIES`, `RUNNER_DYNAMIC_MAX_COST_USD`               | The operator's Dynamic configuration for the container of a Dynamic job and for the canary: a JSON object (no line breaks, at most 4096 characters) and a plain positive decimal              | none                                                                                    |
| `CRON_SECRET`                                                              | Vercel entry: the secret of the platform's cron for the reaper route (#364), at least 32 characters, different from every other secret. Unset: the route refuses everyone                     | none                                                                                    |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                      | Platform access by token (all three). Without a token the OIDC token is used                                                                                                                  | OIDC                                                                                    |
| `DISPATCHER_SHUTDOWN_GRACE_SECONDS`                                        | Node test host only: how long launches may finish after SIGTERM, 0 to 600                                                                                                                     | `60`                                                                                    |

## The golden snapshot pipeline

`src/snapshot/` builds and checks the VM snapshot that every Sandbox job VM is cloned from (#330). It is a command
(`pnpm snapshot:build`, run by `.github/workflows/golden-snapshot.yml`), not part of the Dispatcher at run time: no entry
imports it and the serverless bundle does not contain it. It talks to the platform through the port `src/snapshot/service.ts`
(`vercel-service.ts` is the only file that knows the SDK) and its tests run against `fakes/vercel-sandbox`. Steps, the record,
rebuild, rollback, retention, the scan and the failure codes are in `docs/golden-snapshot.md`.

## Working here

From the repository root: `make lint`, `make typecheck`, `make test-unit`, `make test-integration`, `make verify`.
Inside `dispatcher/`: `pnpm test`, `pnpm test:int`, `pnpm test:privileged` (a Docker daemon and the Worker image, `make test-sandbox-local`), `pnpm exec vitest run <path>`.
`src/contracts/` is generated from `contracts/` (`make generate-contracts`) and never edited by hand. The project
imports nothing from `app/` or `runner/`; what is shared is the contracts and `fakes/` (`fakes/dispatcher-app` is the
fake App every test here runs against). See `TESTING.md` for the test rules.

The hosted end-to-end lane (#332, `TESTING.md`, "Hosted e2e lane") runs this project as a process: `src/test-support/hosted-e2e-main.ts` is the
Node test host's composition with the Sandbox-Launcher and the canary probe (`POST /probe`) over the local mode of the Sandbox double
(`fakes/sandbox/local.ts`) and `fakes/sandbox/bin/docker-worker.sh`, which runs the real Worker as a local process in place of the
container. It repeats the wiring of `sandboxFromEnvironment` with that one platform, so a change to the wiring is a change there too. It
is test code: no entry of a deployment imports it.
