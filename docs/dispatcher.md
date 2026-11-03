# The Dispatcher and the Worker: vocabulary and interfaces

The words, the interfaces between the parts and the table of which Trigger and Launcher exist. The hosted
deployment (umbrella #316) is described step by step in [`deployment-vercel.md`](deployment-vercel.md); the
Dispatcher's code, configuration and Launchers are in [`dispatcher/README.md`](../dispatcher/README.md).

## Vocabulary

| Term | Meaning |
|---|---|
| **App** | The Next.js app with the database. Receives GitHub webhooks, creates jobs, stores results, serves the UI. It never reviews. |
| **Dispatcher** | The middle layer. Learns that a job exists, claims it with the dispatcher credential (today `RUNNER_TOKEN`), receives the per-job credential from the App and starts a Worker. It never reviews and never sees the git token or the model key. |
| **Trigger** | How the Dispatcher learns about a job: the **Webhook-Trigger** (the App calls it, signed). |
| **Dispatcher core** | Claim, per-job credential handling, concurrency cap, launch error handling. Platform-free. |
| **Launcher** | How a Worker is started: the **Sandbox-Launcher** (a fresh VM from a golden snapshot that hosts Docker; the Worker runs there as our hardened container). |
| **Worker** | The isolated process tree that executes exactly one job: the **Diff-Worker** (PR-Agent) or the **Dynamic-Worker** (OpenCode engine). It knows only the App URL, the job id and the per-job credential. |
| **Worker contract** | What the Worker may do with the per-job credential and nothing more: fetch job details, heartbeat, deliver the result. Identical whoever started the Worker. |
| **Hardened container spec** | One definition of the container flags: user, capabilities, `no-new-privileges`, read-only root, tmpfs, memory and pids limits, no volumes, devices or host namespaces (`contracts/worker-container.v1.json`). The Implementer has a profile of it with one work volume (below). |
| **Golden snapshot** | A snapshot of a VM with Docker installed and the Worker image pre-pulled. Every job gets a fresh clone; a snapshot never contains job data ([`golden-snapshot.md`](golden-snapshot.md)). |

**More than one App (#730).** One Dispatcher can serve several Apps. The key that signs a call names the app (a key belongs to
exactly one app), the core claims, heartbeats, releases and reports at that app only, each app may submit only the job kinds
the registry lists for it, and every job VM is tagged with its app (`tenant`), so one app can never claim, stop or read
another's jobs or VMs, and the Dispatcher counts each app's live VMs against its cap itself, so one app cannot take the Sandbox concurrency of another. That holds only while the platform's listing works: when it fails and no listing younger than a minute exists, the claim goes on (#802) and the cap is a soft limit, counted by the Dispatcher's own launches of the last ten minutes; the platform's own concurrency limit is then the only hard one. The legacy variables define the app `reviewer`; `DISPATCHER_APPS` adds the others
([`dispatcher/README.md`](../dispatcher/README.md), "More than one App"; variables in
[`deployment-vercel.md`](deployment-vercel.md), 3.2).

**The kind `implementer` (#759).** The Implementer's job kind (engine `implementer`, contract `runner-api.v1.json`) is served
for an app of `DISPATCHER_APPS` that names it in `kinds`, and for no other: the app `reviewer` (the legacy variables,
code-review.com) never has it, whatever `DISPATCHER_ENGINES` says (`REVIEWER_KINDS` in `dispatcher/src/core/types.ts`), so
code-review.com cannot start an agent job even if its app is misconfigured. The same three checks as for the other kinds
apply: a wake-up call for the kind from another app is `200 ignored` with `not_capable` and no claim, the claim asks for the
`implementer` engine only for an app whose kinds name it, and a claimed job of the kind for another app is released
unlaunched (`kind_not_allowed`). A job of the kind lives 3600 s by default (`DISPATCHER_WORKER_CONFIG.implementer.timeoutSeconds`,
60 to 21600) where Diff and Dynamic keep `DISPATCHER_JOB_TIMEOUT_SECONDS`. **The app cannot read that setting** (#752): the
hold it takes for a turn (`IMPLEMENTER_JOB_TIMEOUT_SECONDS` in `app/src/billing/hold.ts`) and the hard timeout at which the
queue fails a running turn with `timeout` (`DEFAULT_IMPLEMENTER_MAX_RUNTIME_MS` in `app/src/db/job-limits.ts`, the default
plus 10 minutes of grace) carry the default 3600. An operator who sets another `timeoutSeconds` gets a wrong hard timeout: a
shorter value leaves a turn that the Dispatcher stopped `running` in the app until 70 minutes have passed, and a longer one
has the app fail the turn with `timeout` at 70 minutes while its Worker still runs (and the hold too small); `billing-hold-pin.test.ts`
pins the two constants to the default only. Change the constants with the setting. The Sandbox launcher advertises the engine only when the deployment serves the kind (an app of `DISPATCHER_APPS` names it, #765): a deployment without it advertises
`pr-agent` and `opencode` as before, and the reviewer's key never gets the kind.
The deploy canary (`POST /probe`) follows the same rule: it requires the engines of Diff and Dynamic whatever else is
configured, and requires `implementer` only when the Launcher advertises it, so a deployment without the kind keeps its canary
and a missing reviewer engine still fails it. With the kind the route requires the report to name it, and the report can:
`KNOWN_ENGINES` (`dispatcher/src/probe/verdict.ts`), the `ProbeEngine` enum and the `maxItems` of
`contracts/probe-verdict.v1.json`, and `runner/src/code_reviewer_runner/verdict.py` know `implementer`, and the canary VM runs the probe a second
time in the Implementer's container profile and unites the two verdicts. The answer lists the engines it required
(`required`), and the canary prints the missing ones (`missing=`).

**The container profile of the Implementer (#760).** The hardened container of Diff and Dynamic cannot host an agent that
installs a repository's dependencies and runs its tests (read-only root, `noexec` 512 MB `/tmp`, 2 GB, 512 processes, no
volume). The Sandbox launcher picks the container spec by the job kind: Diff and Dynamic keep `WorkerContainerSpec`
unchanged; `implementer` gets `ImplementerContainerSpec` (`contracts/worker-container.v1.json`), which is the same spec with
exactly six fields changed: one **work volume** at `/work`, **the VM's Docker socket** (`/var/run/docker.sock` bind-mounted read-only at
`/run/docker.sock`, #745: the Worker is the Control container of the turn and starts the model door, the agent's container and the reader; it makes the Worker
effectively root on the VM, accepted because the agent never reaches it, `docs/implementer.md`, "The model door"), **memory** 768 MB (reservation 512 MB, no swap; the rest of the VM
is the OS's 512 MB, the door's 256 MB, the two readers' 256 MB each and the agent's container, whose limit the Launcher computes and hands over as `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB`: 2,048 MB at 2 vCPU), **2048 processes**, the four **environment names** `RUNNER_IMPLEMENTER_WORK_DIR` (`/work`),
`RUNNER_IMPLEMENTER_MODEL_DOOR` (`docker`), `RUNNER_IMPLEMENTER_SANDBOX_PROOF` (the snapshot's Sysbox verdict, `SANDBOX_SYSBOX_PROOF`: `proven` or `unproven`, and `unproven` when none was given; only `proven` lets the turn start) and `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB`, and a `forbiddenKeys` list without `dockerSocket`. The floor is the same: root filesystem read-only, every tmpfs
`noexec`, no privileged, no host bind, device or namespace (the Docker socket is the one exception, in this profile only), `no-new-privileges`, the same capabilities. The
work volume is the only writable path that may run a program; a bind or any other volume has no key in the schema.
Before anything else on the Implementer's VM (Diff and Dynamic launch as before) the launcher puts the directories Docker keeps its runtime in on memory, in three
steps (`run-directories`, `run-directory-docker`, `run-directory-containerd`, 2 s each): a `tmpfs` on `/run/docker` and one on `/run/containerd`, and `vm-prepare.sh` then runs with
`TMPDIR=/run/containerd` (`env TMPDIR=... vm-prepare.sh`, so that the daemon and the runtime it starts keep their temporary files there). The VM's `/run` and `/tmp` are directories of its one XFS disk,
and an exec needs files there (the pipes of the command, `runc-process...`): with the disk full by the agent's doing no command could be run in a container, neither the runner's look at the
repository nor its tunnel to the agent (measured on a VM: "failed to open stdout fifo ... no space left on device", "OCI runtime exec failed: open /tmp/runc-process...: no space left on device").
On memory they work on a full disk (`docs/implementer.md`, "The disk"). One more step, `ipv6-off` (3 s), runs before `vm-prepare.sh` starts the daemon: it writes 1 to `/proc/sys/net/ipv6/conf/default/disable_ipv6` and reads it back (no such file is the same as off; `all`, `lo` and `eth0` are left alone, the platform reaches the VM through them), so no bridge the daemon makes ever has an IPv6 address and root in a container cannot find the VM's control port over IPv6 (`docs/implementer.md`, "IPv6"). A step that fails ends the launch with the retryable `docker_not_ready`. After `vm-prepare.sh` the launcher runs `sysbox-prepare.sh` in the VM as root
(label `sysbox-prepare`, 40 s, the Implementer's VM only): it makes the VM able to run a Sysbox container, the sandbox of the next steps of `plans/implementer-sandbox.md`, and a failure ends the
launch with the retryable `sysbox_not_ready` (`docs/golden-snapshot.md`, "Sysbox"). Docker cannot give a named volume mount options, so before `docker run`
the launcher makes the volume in the job's VM as root, in eight steps (`work-volume-dir`, `-reserve-image`, `-reserve-fs`, `-reserve-mount`, `-mount`, `-options`, `-check`, `-create`): a directory below
`/var/lib/code-reviewer-work` with a directory `reserve` in it; the **reserve disk**, a file of 8 GiB (an eighth of the 64 GB disk every VM size has; `fallocate`, so that its blocks are taken now and
not when written) formatted as ext4 and mounted over a loop device on `reserve` (`nosuid,nodev`); a recursive bind of the directory onto itself with `rw,nosuid,nodev` (no `noexec`); a read of `/proc/self/mountinfo`
that must show exactly those options on that mount and on the reserve (a platform that ignored them would run the agent on a mount that honours
the setuid bit, and nothing else would show it); and a Docker named volume `code-reviewer-work-<job id>` bound to it with `rbind`, so that Control sees the reserve below `/work`. The agent's container mounts the Subpath `repo` of the volume
and sees nothing of the reserve. The tools are `mkdir`, `fallocate`, `mkfs.ext4`, `mount` and `cat` of the base image, so the snapshot needs nothing added.
Each step has 9 s; the eight add 72 s, the Sysbox boot 40 s (`SYSBOX_PREPARE_SECONDS`) and the three run-directory steps 9 s (3 s each) and the IPv6 step 3 s to the lifetime of an implementer VM
(`IMPLEMENTER_LAUNCH_EXTRA_SECONDS`, 124 s with the volume steps `WORK_VOLUME_STEPS_SECONDS`), and
`LAUNCH_STEPS_SECONDS` for Diff and Dynamic is unchanged (a test holds the sum, 20 s hand-over + 150 s + 124 s = 294 s, at least 5 s under the launch deadline of the core's 300 s). The mounts and the volume belong to the VM, which is stopped after every failure and by the App's stop call; nothing is
removed separately and nothing outlives the job. A failed, hung or unverified step stops the VM (`work_volume_failed`, retryable). The VM is
2 vCPU / 4 GB by default (`SANDBOX_KIND_DEFAULTS.implementer`); `DISPATCHER_WORKER_CONFIG.implementer` overrides the vCPUs and
the container memory value by value, and **a task's environment names the size of its own VM** (#818: `job.vcpus` of the App's claim answer, believed for the kind `implementer` only,
only 2, 4, 6 or 8: 1 vCPU leaves the agent less than `IMPLEMENTER_MIN_AGENT_MEMORY_MB` and is refused with `sandbox_size_unsupported` before a VM is created; precedence: the task's
environment, then the configuration, then the default; the Control container keeps its memory at every size, the agent's container gets what the VM has left; `docs/implementer.md`, "Environments"), and a limit the VM cannot hold beside the OS, the door and the reader is refused as `sandbox_config_invalid` at
every launch of the kind. At start a deployment that serves the kind only logs `worker_config_invalid` for such a value and
starts, and Diff and Dynamic do not read the entry. For a deployment that serves the kind the same value fails the canary (its VM is sized by it): see below. The operator's Dynamic variables (`RUNNER_DYNAMIC_*`) are not
given to an implementer container. The platform gives a VM a 64 GB disk (measured at 1, 2 and 8 vCPU: the same XFS file system, 61 GB free on a fresh VM, no quotas), which is the room of the agent, of the work volume
and of the reserve disk.

"Runner" is retired as a concept: the former runner process conflated the Dispatcher
(claim, cap) and the Worker host (heartbeat, supervise, deliver). Its identifiers (`RUNNER_*` variables, image and
service names, `/api/runners/v1`) stay until a dedicated rename.

## Interfaces

| Between | Interface | Defined in |
|---|---|---|
| GitHub and the App | Signed webhook `POST /api/webhooks/github-app` | [`github-app.md`](github-app.md) |
| App to Dispatcher (Webhook-Trigger) | `POST /dispatch`: a closed JSON body (`job.ready`, job id, review kind, attempt) signed with HMAC and a key id, at most 1 KiB. Answers `202`, `200 ignored`, `401`, `400`, `413`, `429`, `503` | `contracts/dispatch-webhook.v1.json`, `contracts/dispatch-signing-vectors.json`, `app/src/dispatch/README.md` |
| App to Dispatcher (stop) | `POST /stop`: a closed JSON body (`job.stop`, job id, stop id) signed like `/dispatch`; the Dispatcher stops the VMs tagged with that job. Answers `202`, `200 ignored` (`no_vm`, `replayed`), `401`, `400`, `413`, `503`; a Dispatcher of the previous release answers `404` | `contracts/dispatch-webhook.v1.json`, `dispatcher/README.md`, "The stop call" |
| Dispatcher to App (Dispatcher API) | `GET /api/runners/v1/version`, `POST /api/runners/v1/claim` (by job id, with the pool cap), `POST /api/runners/v1/jobs/{id}/heartbeat`, `POST /api/runners/v1/jobs/{id}/release`, with the dispatcher credential or the per-job credential | `contracts/runner-api.v1.json` |
| Dispatcher to Launcher | `capabilities(signal)`, `launch(spec, signal)`, optional `probe(signal)`; a `LaunchSpec` is `{appId, appUrl, jobId, credential, kind, timeoutSeconds, config}` | `dispatcher/src/core/types.ts`, `dispatcher/README.md` |
| Launcher to Worker | The start document `{appUrl, jobId, credential}` on **stdin only**, never an argument, environment variable or file; the container's entry mode `worker-once` (or `probe`) | `runner/README.md`, "Entry modes of the image" |
| Worker to App (Worker contract) | `GET /api/workers/v1/jobs/{id}` (job details, where the git token and the model key are revealed), `POST .../heartbeat`, `POST .../result`, with the per-job credential | `contracts/worker-api.v1.json` |
| Dispatcher to App (reaper) | `GET /api/runners/v1/jobs/{id}`: the state of a job, so that the reaper stops the VM of a job that is not `running` | `contracts/runner-api.v1.json` |
| Platform cron to Dispatcher | `GET /api/cron/reap-sandboxes` with `Authorization: Bearer <CRON_SECRET>` every 5 minutes | `dispatcher/README.md`, "The reaper" |
| Dispatcher to operator | `GET /health`; `POST /probe` (the canary probe of the deploy canary, with the operator credential `DISPATCHER_OPERATOR_TOKEN`, required with several Apps, else the `reviewer` token while `reviewer` is the only App and the token is unset; dispatch never runs it); `POST /apps/check` (per app: reachable, credential, features; operator credential only) | `dispatcher/README.md`, "The canary probe" and "More than one App", `contracts/dispatcher-ops.v1.json` |
| Operator to App | `/api/operator/v1`: workspaces, entitlements, limits, usage; only with `OPERATOR_API_TOKEN` | `contracts/operator-api.v1.json`, `app/src/operator-api/README.md` |

Nothing here is shared as source: the three projects (`app/`, `dispatcher/`, `runner/`) exchange only the contracts
in `contracts/` and the generated types in `src/contracts/`; a test fails on any import across projects.

## What exists

The Dispatcher has one Trigger, the Webhook-Trigger, and one Launcher, the Sandbox-Launcher: the hosted deployment
(`deployment-vercel.md`).

| Part | Entry | Status |
|---|---|---|
| Dispatcher core, Webhook-Trigger, `GET /health` | `dispatcher/src/index.ts` (Vercel) | exists |
| Sandbox-Launcher, canary probe, `POST /probe` | Vercel entry, with `SANDBOX_SNAPSHOT_ID` set | exists |
| Golden snapshot pipeline | `pnpm --dir dispatcher snapshot:build`, workflow `golden-snapshot.yml` | exists |
| Deploy canary | `pnpm --dir dispatcher probe:canary`, workflow `dispatcher-canary.yml` | exists |
| Reaper for VMs that outlived a job | a Dispatcher cron, `/api/cron/reap-sandboxes` | exists (#364) |
