# The Factory-Runner: spikes and decisions

The Factory-Runner is the Implementer's Control, packaged to run on a customer's Linux machine and take the jobs of its
workspace (the plan is the owner's `plans/customer-runner.md`, milestones R0 to R4, epic #852). Its app side (registration, the
list, routing) is R1a; the runner itself, with the base and OpenCode, is R1b. This document holds what the app does for it, how
the runner is built and used, and what was **measured** before it was built; it grows with the milestones.

- [Registration and routing](#registration-and-routing-r1a-854): how a machine becomes a runner of a workspace (R1a).
- [The Factory-Runner](#the-factory-runner-r1b-854): the service, the `factory-runner` command, the image, installation for a
  developer and operation in a VM (R1b).
- [Spikes R0](#spikes-r0-853): what was measured on a real VM before the build.

## Registration and routing (R1a, #854)

The app side of the runner, built before the runner so that the runner has something to talk to. The code is
[`app/src/runner-fleet/`](../app/src/runner-fleet/README.md) (the page and the member's routes), `app/src/runner-api/registration.ts` (the runner's calls)
and `app/src/runner-identity/` (what both share); the wire format is
[`contracts/runner-registration.v1.json`](../contracts/runner-registration.v1.json) (examples in
`contracts/examples/runner-registration/`), held by the app and by the runner's contract tests.

### Registration

```
member (Owner/Admin)                    app                                     runner (customer's machine)
POST /api/w/:ws/runners/tokens   ->  token crt_... (1 hour, once, hash kept)
      shown once, with the command
      factory-runner register --token crt_...  ------------------------------>  POST /api/runners/v1/register
                                                                                 { token, name, labels, baseVersion, manifest, limits }
                                         <- 201 { runnerId, credential crc_..., minBaseVersion }
                                            (credential hash kept)
                                                                                 every later call: Authorization: Bearer crc_...
```

- **Token.** `POST /api/w/:workspace/runners/tokens` (Owners and Admins, right `manage_runners`; a workspace holds at most 20 unused ones). The answer
  carries the token once, in `token`, with `expiresAt`; the page shows it as the command `factory-runner register --token ...` to copy. The app keeps a
  SHA-256 of it. It is valid for one hour and works once: the exchange is a single conditional update, so two runners racing for one token cannot both win.
  An unknown, a used and an expired token are the same answer, `401 RUNNER_REGISTRATION_TOKEN_INVALID`.
- **Exchange.** The runner says its name (1 to 80 characters, one line), its **labels** (at most 20, lower case, `[a-z0-9][a-z0-9._:-]{0,39}`), the **version of
  its base** (`1.4.0`), its **manifest** and its **limits**. The manifest names the harnesses it announces (`opencode`, or `custom/name`), each with its
  version and whether it is `ready` (installed, logged in, proven by the runner's selftest), and its capabilities such as `agent-docker` (announced only
  when the selftest ran a container in a Docker inside Sysbox, see S2 below). The limits (`cpus`, `memoryMb`, `diskGb`, `parallelRuns`) are informational:
  they are enforced on the machine. What the format does not know is dropped; what it knows and gets wrong is refused with the field's name, never its value.
  The answer carries the runner's **credential** (`crc_` and 43 characters), once; the app keeps a hash.
- **Configuration lives in the runner** (decision 8). The runner sends the same announcement with `PUT /api/runners/v1/self` at start and whenever one of its
  labels, its version, its manifest or its limits changes; the app keeps the last word it got.
- **Renewal.** `POST /api/runners/v1/credential` gives the runner a new credential. The one it presented stays valid until the new one is used once, so an
  answer lost on the way does not lock the runner out.
- **Last seen.** Every authenticated call of the runner is its heartbeat; the claim, which it makes every 30 seconds or so, is the one that matters. The
  list shows a runner as _online_ when it was heard from within two minutes and _offline_ otherwise.
- **Revoking.** Owners and Admins revoke a runner on the page (`POST /api/w/:workspace/runners/:id/revoke`). The next call of that runner is
  `401 RUNNER_UNAUTHORIZED`, the answer for any credential the app does not know. The same holds for every report about the job it was running (`heartbeat`, `complete`, `release`, `steps`, `session` and `resume-session`; the Worker API's calls of the same names take the per-job credential alone and never a runner's). Revoking also **ends the runner's running jobs at once**: their leases are cut to now and the queue's expiry runs, so a turn (one attempt) fails with its own code, `runner_revoked` (free, with its own text on the run page: the runner was removed, not "ran out of retries"), and its write token and record are dealt with as for any lost lease. What it already pushed stays on the branch.
- **The minimum version of the base** (decision 9). `RUNNER_MIN_BASE_VERSION` (unset: none) is the oldest base that gets jobs. A claim by a runner below
  it is `426 RUNNER_UPDATE_NEEDED` with `minBaseVersion`, the list shows _update needed_, and the runner says so on the machine. The app never updates a runner.
- **Two doors.** The shared `RUNNER_TOKEN` (the Dispatcher's, and the poll mode's) and a runner credential are different secrets; a request that carries a
  `crc_` credential takes the runner's path and never the shared one, and the other way round.

### Environments of the kind `runner`

An environment is either `hosted` (a VM of the platform: a size, a setup script and a network rule, as before) or `runner`: **labels instead of all
three**. A runner environment names at least one and at most twenty labels (lower case, `[a-z0-9][a-z0-9._:-]{0,39}`); a size, a script or a network
rule in its body is refused with the field's name, not silently dropped. Size, script and network are the runner's own business (decision 8). Hosted
environments change in no way; a body without a `kind` is hosted, as every body was before.

The turn copies the kind and the labels with the rest of the environment (`implementer_turns.environment_kind`, `environment_labels`), so editing or
deleting the environment touches no turn, and the claim routes by the turn's own row.

### Routing

- **Who takes a runner turn.** Only a runner of the **same workspace** that has **every label** of the environment, announces the harness of the profile
  **ready** (today always `opencode`: profiles know no other harness) and is not below the minimum base version. A runner without a ready OpenCode gets
  nothing; one below the minimum gets `426 RUNNER_UPDATE_NEEDED`. The runner claims with its credential and takes the engine `implementer` only: not a
  review, not a split claim, not a job by id. The claim is the ordinary claim of a turn (the same input, the key and the model entry as the Dispatcher's
  Worker gets them), so a runner's turn is built exactly like a hosted one. Its calls about the job (`heartbeat`, `complete`, `release`, `steps`, and the two snapshot calls below) take the
  credential too, for a job of its own workspace only (`404 RUNNER_JOB_NOT_FOUND` for any other); the Dispatcher's calls (`vm`, the job state) take the
  shared token alone.
- **Who never does.** A **hosted job never goes to a customer's runner**, and a **runner turn never goes to the Dispatcher or to the shared token**: the
  claim statement itself excludes the turns of runner environments from every claim that is not a runner's, and the dispatch (the signed wake-up call, its
  rows, its listings and its sweep) skips them, so the Dispatcher is not woken for a job it cannot take.
- **Waiting.** A turn that waits for a runner shows **"Waiting for a runner with labels gpu, linux"** on the run page. After `RUNNER_WAIT_DEADLINE_MINUTES`
  (default 30) without a claim it ends **cancelled with `no_runner_available`**, free: no attempt, no credential, no charge, and it is not run again by
  itself. This pass runs wherever the queue expires jobs (every claim, the sweep), so it works in poll mode too. A busy pool of other runners does not
  delay it: the wait is for _these labels_.
- **No operator key on a runner** (decision 2). A runner environment needs a model of the workspace's **own key**. Starting a task with a managed model
  (a catalog entry) in a runner environment is refused with `IMPLEMENTER_RUNNER_NEEDS_OWN_KEY` (422) before a session, a turn or a job exists; a workspace
  without its own key for the model's provider is refused by the rule every task meets. The claim holds the same line: a runner turn whose selection would
  be managed ends `runner_needs_own_key` before a key or a credential exists.

### Resume on customer runners (#879)

A follow-up turn continues the conversation of the earlier turns: the engine's session is taken as a file at the end of every turn (the session snapshot, [`implementer.md`](implementer.md#the-session-snapshot-839))
and imported into the engine of the next turn, which may run on another machine ([`implementer.md`](implementer.md#follow-up-turns-resume-in-the-runner-840)). On the hosted deployment the Worker moves the file with the
per-job credential (`PUT /api/workers/v1/jobs/{id}/session`, `GET .../resume-session`). A customer's runner holds no such credential and the runner credential stays out of the Worker API
(a Worker route answers `401 WORKER_CREDENTIAL_INVALID` to it), so the runner has two calls of its own:

```
runner                                                                           app
PUT /api/runners/v1/jobs/{id}/session?part=0&parts=2&bytes=..&rawBytes=..&sha256=..&opencodeVersion=..
    Authorization: Bearer crc_...      X-Lease-Token: <lease token of the claim>
    body: the bytes of the part (up to 3 MiB)                                ->  200 { version, part, parts, complete }
GET /api/runners/v1/jobs/{id}/resume-session?part=n
    Authorization: Bearer crc_...      X-Lease-Token: <lease token of the claim>
                                                                             <-  200 the bytes of the part, x-snapshot-* headers
                                                                                 204 the session has no stored snapshot
```

- **The same calls.** The handlers are the Worker API's (`storeSnapshotPart`, `readResumeSessionPart`): the same parts of exactly 3 MiB (at most three), the same description of the whole file in the query or in the
  headers, the same digest and size checks, the same replacement of the session's snapshot once the last part is in, the same reading of the earlier turns' snapshot of the job's own session and of no other. The wire
  format is `RunnerSessionPartQuery`, `RunnerSessionPartResponse`, `RunnerResumeSessionQuery` and `RunnerResumeSessionHeaders` of [`contracts/runner-api.v1.json`](../contracts/runner-api.v1.json), which say the same about
  the fields as the Worker contract's definitions (a test holds them to it). Neither call extends the lease.
- **The lease token is a header.** The calls with a JSON body (`heartbeat`, `complete`, `steps`) carry the token in the body; here the body is raw bytes (or there is none), so it is `X-Lease-Token`
  (`RunnerLeaseTokenHeader`: 8 to 256 characters). A missing or malformed one is `400 RUNNER_REQUEST_INVALID` with the field `x-lease-token`, never its value.
- **Who may call.** A live runner and nobody else: a revoked or unknown credential, the shared token and a per-job credential are the same `401 RUNNER_UNAUTHORIZED`. The job must be of the runner's own workspace
  **and held by this very runner**: a job of another workspace, a job another runner holds and a hosted job (a Dispatcher holds it) are all `404 RUNNER_JOB_NOT_FOUND`, so the answer says nothing about which. Then the lease
  token decides, as it does for the steps: a lease that ran out, a claim that ended or a token that is not the claim's is `409 RUNNER_LEASE_LOST` (stop sending). A job that is not a turn of the Implementer is `400`.
  These two calls answer `404` for a job another runner of the workspace holds, while `steps`, `heartbeat` and `complete` check the workspace and the lease token only and answer `409 RUNNER_LEASE_LOST` for the same job.
  The difference is deliberate for these two calls and not yet for the others: whether `steps`, `heartbeat` and `complete` should check the holder too is a separate question (a follow-up, not decided here).
- **The switch.** The app lists the feature `runner_session_snapshot` in `KnownAppFeature`. `implementer_snapshot` says only that the **Worker API's** calls exist, and an app can have those and not these (production
  lists it today without the runner routes); a runner on a customer's machine reads the list from `GET /api/runners/v1/version` **with its own credential** (the call answers a live runner as well as a Dispatcher
  or a running claim) and uses the two calls only if it finds `runner_session_snapshot` there. It needs no claim feature: the claim names `implementer_resume` already, and the job says with
  `implementer.resume.snapshot` whether there is a file to read.
- **Resume works on customer runners (the runner's side, #879).** `RunnerJobApi` of the `factory-runner` (`runner/src/code_reviewer_runner/factory_runner/job_api.py`) speaks the two calls above, **on the condition that
  the app lists `runner_session_snapshot`**; against an app without it the runner behaves as before.
  - *Paths and header.* `snapshot` sends to `/api/runners/v1/jobs/{id}/session` and `resume_session` to `/api/runners/v1/jobs/{id}/resume-session?part=n` (the query, the parts and the checks of the answer are the
    Worker client's, shared code), with the runner credential in `Authorization` and the lease token of the claim in `X-Lease-Token`. The token is read from the claim the runner holds (`hold`), goes into the header and
    nowhere else: not into an error text, not into a log line, not into the URL. A job the runner does not hold sends nothing.
  - *The switch is read for every job.* The service asks the version call (`check_app`, with the runner's credential, `GET /api/runners/v1/version?jobId=...`) after it holds the claim and before the host starts the job.
    The features of an earlier job are forgotten first: an app that does not answer, or lists nothing, is an app without the snapshot for this job. A runner's job is not a Worker API job, so `worker_api` is not asked for.
    `supports_snapshot` is true if and only if `runner_session_snapshot` is listed; `implementer_snapshot` (the Worker routes) does not count.
  - *Off means off.* The host opens no snapshot channel for a turn on such an app, so the process takes no export, and does not download a stored session either: the turn runs as before and a follow-up continues from the
    summary (`summary_only`). This also fixes the fault of #874 in which an app that listed `implementer_snapshot` made the host open the channel while the runner could only call routes that refuse its credential.
    The constructor switch `RunnerJobApi(snapshot=...)` is gone: the app decides.
  - *Answers.* Upload: `404` and `409` (`RUNNER_LEASE_LOST`, `RUNNER_JOB_ENDED`) are `LeaseLost` (the sender stops, nothing more is sent for the job), `401` is `CredentialInvalid` (a `LeaseLost` too), any other `4xx` (`400`,
    `413`) is `ApiRejected` and not retried, `5xx`, `408`, `425`, `429` and no answer are `ApiUnavailable` and retried within the sender's time. Download: `204` is "no stored snapshot" (`no_snapshot`), and every other answer
    (`400`, `401`, `404`, `409`, `5xx`) is a failed download (`download_failed`): the turn is never failed by it, it continues from the summary, and a lost lease shows at the next heartbeat.

- **What the runner does with it.** Nothing new: the host downloads the stored session before the process starts and uploads the snapshot beside the final push, exactly as for a Worker
  ([`implementer.md`](implementer.md#follow-up-turns-resume-in-the-runner-840)). Which machine ran the earlier turns does not matter: the snapshot belongs to the session.
- **Tests.** `app/src/runner-api/runner-session.integration.test.ts` (the parts and the bounds through the runner's door, a snapshot stored by one runner and read by another, another workspace, another runner,
  a lease that ran out, a revoked runner, a hosted job, the shared token and a per-job credential, the Worker routes still closed to a runner, the version call), `runner-session-contract.test.ts` and
  `runner/tests/contract/test_snapshot_contract.py` (the contract on both sides). The runner's client: `runner/tests/unit/test_factory_runner_job_api.py` (paths, header, the switch on and off per job, the
  statuses, no secret in an error or a log), `runner/tests/contract/test_runner_session_client_contract.py` (the real client on HTTP against the fake App, which holds every query, header and answer to the
  `Runner*` definitions: parts of one to three, 204, a lost lease, a revoked runner, the switch) and, in `runner/tests/integration/test_factory_runner_loopback.py`, two turns through the service in which turn 2 reads the
  snapshot turn 1 stored, and an app that lists only `implementer_snapshot`, which gets no channel and no download.

### Validator rules

The validator of workflows (`POST .../workflows/validate`, and every save) knows the kind of each environment and, for each profile version it runs, whether
its model is managed and which harness it runs with:

| Code                   | When                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_needs_own_key` | An agent step runs a profile with a **managed model** in an environment of the kind `runner`. Managed models run on platform VMs only. |
| `harness_needs_runner` | An agent step runs a profile whose **harness is not OpenCode** in an environment that is not a runner's.                               |

Profiles know only OpenCode today. The field `harness` is accepted in a profile document (`"opencode"` and nothing else: no other value is a harness a profile
can name), nothing is stored for it, and the second rule is prepared for the first harness a runner announces; this change adds none.

### Known limits and follow-ups

- **Harness filter in the claim.** The claim checks that the runner announces `opencode` as ready, because profiles name no other harness. When the
  first second harness exists, the claim must filter on the harness of the turn's profile version (stored with it, see the follow-up in
  [`profiles.md`](profiles.md)); until then a runner with a ready OpenCode is eligible for every runner turn.
- **Waiting turn and a workflow step.** A workflow step that runs in a runner environment waits like any turn, up to `RUNNER_WAIT_DEADLINE_MINUTES`; if no
  runner takes it, the step fails with `no_runner_available` and a text, at no cost, and the run fails with `step_failed`.

## The Factory-Runner (R1b, #854)

The runner is the Implementer's Control, packaged to run on a customer's Linux machine: **the same code as the hosted Control**
(the job host, the model door with the key out of the agent, the cost ledger, the step records, the finish tool, the session
snapshot, the git rules: no remote in the agent, the runner pushes every local branch, never force), started by a loop that
claims its own jobs instead of being handed one by the Dispatcher. The code is
[`runner/src/code_reviewer_runner/factory_runner/`](../runner/src/code_reviewer_runner/factory_runner); the command is
`factory-runner`.

```
machine (Linux, Docker)
├─ factory-runner  (container of the runner image, root, the host's Docker socket, a volume at /work)
│    ├─ announce (PUT /self): labels, base version, manifest {opencode ready, capabilities}, limits
│    ├─ claim (POST /claim, every 30 s or so; it is also the heartbeat of the runner)
│    ├─ job host (the hosted one): job process with the job on stdin, heartbeats, steps, result with the lease token
│    └─ through the host's Docker, per turn:  model door · agent container (the pinned OpenCode) · reader · git mirror
└─ volumes: factory-runner-home (the configuration), factory-runner-work (/work: mirror, repository, result)
```

### What is the same as hosted, and what is not

| Part                                     | On a runner                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model door, key, cost ledger             | As hosted. The key is the workspace's **own** key (BYOK): the claim hands it over, it lives in the door's container, the agent only holds a worthless bearer. A managed model never reaches a runner. |
| Steps, finish tool, result, git rules    | As hosted (same code).                                                                                                                                |
| Agent's container                        | The same image, the same fixed address on the same internal model network, memory without swap, no host mount, no socket, **but** the runtime is `sysbox-runc` only where the self-test proved it; otherwise the daemon's default (`runc`), with an init that only says "ready". |
| The agent's own Docker                   | **Not part of the base** (decision 3, S2). The capability `agent-docker` is announced only when the self-test ran a container in a Docker inside Sysbox. A job whose setup needs Docker is for a runner that announces it. |
| Lease, heartbeat, result                 | The runner API (`/api/runners/v1/jobs/{id}/heartbeat`, `/complete`, `/steps`) with the runner's credential and the lease token of the claim in the body. |
| Session snapshot and stored session      | The runner API (`/api/runners/v1/jobs/{id}/session`, `/resume-session`) with the runner's credential and the lease token in `X-Lease-Token`, **if the app lists `runner_session_snapshot`** (see "Resume on customer runners"); otherwise none, and a follow-up continues from the summary. |
| Sizing                                   | The configured memory and CPUs, not the VM size the Dispatcher computes. One run at a time.                                                           |

### Install (developer, one machine)

Needs Docker (the engine, not rootless) and a Linux machine; Sysbox is optional (it only adds `agent-docker`).

```sh
# the images: the runner (the Worker image with the command) and the agent. A release publishes both;
# a developer builds them from a checkout of the repository:
docker build -f runner/Dockerfile --target sandbox -t code-reviewer-runner-sandbox:local .
docker build -f runner/Dockerfile --target agent -t code-reviewer-agent:golden .
docker build -f runner/Dockerfile.factory-runner --build-arg WORKER_IMAGE=code-reviewer-runner-sandbox:local -t factory-runner:local runner

alias factory-runner='docker run --rm -i --name factory-runner-cli \
  -v factory-runner-home:/var/lib/factory-runner factory-runner:local'

# in the app (Owner or Admin): Runners, "Add a runner", copy the token. Then, the safest way first: the token
# is read from standard input, so it is in no argument list and in no shell history.
printf '%s' 'crt_...' | factory-runner register --token-file - --name build-box --labels linux,gpu
factory-runner selftest        # the base on this machine, see below; needs the socket and /work, so run it like the service:

docker run -d --name factory-runner --restart unless-stopped --stop-timeout 150 \
  -v /var/run/docker.sock:/run/docker.sock \
  -v factory-runner-home:/var/lib/factory-runner \
  -v factory-runner-work:/work \
  factory-runner:local run
```

- **Where the token can come from** (in this order of safety): `--token-file FILE` (`-` reads standard input), the environment
  variable `FACTORY_RUNNER_TOKEN`, and `--token crt_...`, **the least safe**: an argument is visible in the process list of the machine
  and stays in the shell history. The token is valid for one hour and works once, which limits what a leak costs, not whether to avoid it.
  `--token` and `--token-file` together are a usage error. A wrong token is refused without printing it.
- **`--stop-timeout 150`.** `docker stop` sends SIGTERM and kills the container after 10 seconds unless told otherwise. The runner answers
  SIGTERM by giving the running job back to the queue (`runner_shutdown`): the job process gets up to 120 seconds to wind down
  (`IMPLEMENTER_TERMINATE_GRACE_SECONDS`), then the runner reports the shutdown for up to 10 more. With the default of 10 seconds the
  runner would be killed in the middle of that, the job would stay with the runner until its lease ran out, and its containers (the
  model door among them, which holds the workspace's key) would stay on the machine. 150 is those 130 seconds with a margin. A
  runner that is killed anyway (`SIGKILL`, a power cut) leaves its containers and `/work` behind; the next start removes them (below).
- A job needs the **whole `/work` volume to itself**: before a claim, and right after every job, the runner removes the folders of a turn from
  it (`reserve`, `repo`, `result`; nothing else, links are not followed; a folder a job made unreadable, mode 000, gets its rights back first)
  and every container and network that carries the label `code-reviewer.role` and this runner's id. Do not put anything of yours into those names, and do not share the work volume between runners.
- **No `--hostname`, no `--network host`, no `--privileged`.** The runner finds the name of its `/work` volume by reading its own
  container from the daemon (the hostname is the container id), and the agent mounts that volume by name.
- **The Docker socket is root of the machine.** The runner needs it (it starts the containers of a turn); the agent never gets it.
  Run the runner on a machine you are willing to give that to, which is what a self-hosted runner of any CI system asks too.
- **The model network is fixed** (`10.213.77.0/29`, `code-reviewer-model`) and the containers have fixed names, so one daemon runs
  one turn at a time and the address must be free on the machine.
- With the image pinned to a **digest** in a release, the runner pulls the agent image itself when the daemon does not have it
  (`/opt/code-reviewer/agent-image.json`, or `FACTORY_RUNNER_AGENT_IMAGE`).

### The command

| Command                        | What it does                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `register [--token-file F \| --token T] [--name N] [--labels a,b] [--url U] [--cpus] [--memory-mb] [--disk-gb] [--runtime] [--agent-image] [--force]` | Exchanges the token for the runner's credential (read from `--token-file`, `-`, `FACTORY_RUNNER_TOKEN` or `--token`, see above) and writes the configuration (file mode 0600, directory 0700). If the app accepted the token but the file cannot be written, it says `runner registered, but its credential could not be saved: revoke it in the app and register again` and ends with exit code 8: the credential is shown once and is lost. Refuses to replace a registration without `--force`. Without `--url` it goes to `https://code-review.com`. The manifest of the registration is empty: `run` announces what the self-test proved. |
| `run`                          | The service loop (below).                                                                                                                  |
| `run --once [--wait SECONDS]`  | Takes **one** job and ends with its exit code. With no job within `--wait` (default 600) it ends with **exit code 0** and the line `no job for the labels of this runner within Ns: nothing to do`. |
| `selftest [--json]`            | Proves the base (below). Exit code 0 when it holds, 5 when it does not. Needs no registration. It only looks: it pulls and names no image, so a missing or not pinned agent image is reported as not ready (a starting `run` pulls it). It may run beside a service; its throwaway container is one more on the daemon for the seconds it takes. |
| `config show`                  | The configuration as the runner sees it (file and environment), the credential only as `set` / `not set`.                                  |

**Exit codes** (the same list is in `factory_runner/base.py`):

| Code | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done. In `run --once` also: **no job came** within the wait (the app answered; nothing was waiting for these labels)                            |
| 1    | A job failed or was lost; a runner that cannot clean the machine in `run --once`; `register` was refused or the app could not be reached       |
| 2    | Usage (a wrong argument, no token for `register`)                                                                                               |
| 3    | The app requires a newer base (`426`)                                                                                                           |
| 4    | Revoked: the app does not know the credential any more                                                                                          |
| 5    | Not ready: the self-test failed (the failed check says why)                                                                                     |
| 6    | Configuration: a value is missing or wrong; a file with a credential and no `runnerId` (`register --force`, or add the runnerId); a runner with no identity |
| 7    | `run --once` only: **the app never answered a claim** during the whole wait. Not the same as 0: the runner does not know whether a job waited. An app that answered once and was lost later is "no job", exit 0 |
| 8    | `register` only: the app registered the runner, but its credential could not be saved (revoke the runner in the app and register again)        |
| 9    | Another factory-runner uses this Docker daemon (see "One runner per daemon"); the log names the first container or network found; the runner announced nothing and claimed nothing |

### Configuration

The file is `$FACTORY_RUNNER_HOME/config.json` (`~/.factory-runner`; `/var/lib/factory-runner` in the image). **Every value can come
from the environment instead, and the environment wins**, which is how a VM that runs one job gets its credential without a file:

| Variable                                 | Meaning                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `FACTORY_RUNNER_URL`                     | The app (`https://...`; `http://` only for loopback, or with `FACTORY_RUNNER_ALLOW_HTTP=1`)  |
| `FACTORY_RUNNER_CREDENTIAL`              | The runner's credential (`crc_...`), a secret                                                |
| `FACTORY_RUNNER_NAME`, `FACTORY_RUNNER_LABELS` | The name, and the labels (comma separated, lower case)                                 |
| `FACTORY_RUNNER_CPUS`, `_MEMORY_MB`, `_DISK_GB` | The limits (below)                                                                    |
| `FACTORY_RUNNER_AGENT_IMAGE`, `FACTORY_RUNNER_RUNTIME` | The agent image to pull; `auto` (default), `runc` or `sysbox-runc`                |
| `FACTORY_RUNNER_TOKEN`                   | `register` only: the registration token, an alternative to `--token-file` (not read by `run`) |

A wrong value is refused with the name of the field and never its value (the file holds a secret). The credential is **renewed**
(`POST /credential`) between jobs when it is older than seven days and **was read from the file**; the new one is written before it
is used, because the app keeps the old one valid until the new one is used once. Only the credential and its time are written, into
the file as it is on disk: what the environment overrides (address, name, labels, limits) never ends up in it. A credential from the
**environment** belongs to whoever set it (a VM that runs one job; a secret store) and is **never renewed**, even when a file with an
older credential exists. A renewal whose file cannot be written is dropped: the old credential stays in use and the next job asks again.

### The service loop

0. **One runner per daemon.** The runner first takes a lock: a container `code-reviewer-runner-lock` (created, never started) that
   carries its id and no role label. If it exists and carries another id, the runner ends with exit code 9. Then it looks at every
   container (in any state: running, exited, paused, restarting) and every network with the label `code-reviewer.role` whose
   `code-reviewer.runner` is another id or missing. The first one it finds ends the start with exit code 9, and the log says which:
   `another factory-runner uses this Docker daemon: container code-reviewer-agent (role agent, runner none); one runner per daemon for now`.
   Nothing is announced or claimed. What carries its own id is not foreign: the tidy removes it (below). Leftovers of an earlier
   registration (`register --force` makes a new id) look foreign: remove them by hand if no other runner runs. The lock is removed when
   the runner ends; one left by a crash is taken over by the same runner on its next start. A runner with no identity (no id, no
   credential) sweeps nothing and ends with exit code 6: the role label alone never selects what to remove.
1. **Prepare.** Check the machine (below) and decide the runtime: `auto` tries `sysbox-runc` when the daemon has it and falls back to
   `runc` when the self-test does not pass under it.
2. **Announce** (`PUT /api/runners/v1/self`): labels, base version, the manifest (`opencode` with the version the runner pins and
   `ready`; `capabilities` such as `agent-docker`) and the limits it works within. A runner whose base is not proven announces
   `ready: false` and takes no job (exit code 5; the failed check is in the log).
3. **Tidy**, before the first claim and again whenever a job has ended: every container and network with the labels `code-reviewer.role`
   and `code-reviewer.runner=<this runner's id>` is removed (what a killed runner left, the door with the workspace's key above all),
   then `/work/reserve`, `/work/repo` and `/work/result` are emptied (a turn refuses to start on leftovers: `setup_failed ... exists
   already`). The work volume is left alone when a container could not be removed (it may still mount it), and so is a folder with a
   mount point below it (another device than `/work`): both are problems, so no claim. Rights are changed through opened folders
   (`O_NOFOLLOW`, `fchmod`), never by path. The same runs right after each
   job. A runner that cannot tidy takes **no job** (it says why in the log, `run --once` ends with exit code 1, `run` tries again after a
   minute): a job it took would fail in its set-up.
4. **Claim**, every 30 seconds with a little jitter. The claim is the runner's heartbeat: the list shows it online for two minutes after.
   A claim names the engine `implementer` and the features the job host understands, so the job is built exactly as the Dispatcher's
   Worker gets it.
5. **Run** the job through the hosted job host. Its credential is the runner's; the job process gets the job on its stdin and a minimal
   environment, never the runner's credential. A SIGTERM or SIGINT gives the running job back (`runner_shutdown`) and ends the loop.
6. What a claim's failure means: `401` the runner is **revoked**, stop for good (exit 4); `426` **update needed**, say so, wait five
   minutes (`--once`: exit 3); the app unreachable, wait 5 s, 10 s, ... up to five minutes.

**Revoking** a runner in the app ends the job it is running at once (the app cuts the lease; the runner's next heartbeat is a `401`, the
host ends the process, nothing more is sent) and the next claim stops the service.

What the runner meets of the routing above (R1a part 2): it is offered a turn only when the turn's environment labels are all among its
own, its workspace is the turn's and it announces a **ready** OpenCode; below `RUNNER_MIN_BASE_VERSION` the claim is the `426` it
reads as "update needed". A revoked runner's turn ends in the app as `runner_revoked` (the runner learns it from the `401` of its
next call and does not report); a turn that no runner takes ends as `no_runner_available` in the app, and the runner is not involved.

### `run --once`: a VM that runs one job and ends

```sh
FACTORY_RUNNER_URL=https://code-review.com \
FACTORY_RUNNER_CREDENTIAL=crc_... \
FACTORY_RUNNER_LABELS=itegro-claude \
FACTORY_RUNNER_MEMORY_MB=4096 \
docker run --rm -v /var/run/docker.sock:/run/docker.sock -v /work \
  --env FACTORY_RUNNER_URL --env FACTORY_RUNNER_CREDENTIAL --env FACTORY_RUNNER_LABELS --env FACTORY_RUNNER_MEMORY_MB \
  factory-runner:local run --once --wait 120
```

The VM announces itself (so the app sees an ordinary runner with these labels), takes the one job that is waiting for them, runs it,
reports and ends; **with no job within the wait it ends with exit code 0** and says so, so a VM that was started for a job another
runner took costs nothing more. **If the app never answered a claim during the whole wait it ends with exit code 7 instead**: the runner
cannot know whether a job waited, so whoever started the VM can tell "nothing to do" from "never spoke to the app" and try again. The credential comes from the VM's secret store; nothing is written to disk. The anonymous volume
`-v /work` is the work volume of the turn and goes with the container.

### The self-test

`factory-runner selftest` is the proof of the base (decision 3) and runs at the start of every `run`. In order, each with a stable
name: `docker` (the daemon answers and has the chosen runtime), `work-volume` (`/work` is a Docker volume of this container),
`memory` (the agent gets at least 1024 MB: 60% of the machine up to 16 GiB unless `memoryMb` is set), `agent-image` (below),
`agent-container` (the agent's container starts under the runtime with the limits, no network, and is ready), `opencode` (it reports
the pinned version), `canned-turn` and, as a capability that may fail without costing the base, `agent-docker`.

**The agent image is held to the pin.** The runner names the image it starts agents from `code-reviewer-agent:golden`, and a daemon
may already have an image of that name from an earlier version. When the reference the runner was given (`AGENT_IMAGE_REF` baked in,
or `FACTORY_RUNNER_AGENT_IMAGE`) names its image **by digest**, the digest is compared with the ones the daemon knows the image by; a
different one is replaced (pulled and named again) and the check says `replaced`. With a **tag** nothing can be compared, so the check
passes with a **warning** (`the image behind a tag can change`) and the engine decides: if `opencode --version` in the container is not
the version this runner pins, the image is pulled once and the check repeated; if it is still wrong, the runner is **not ready** and
the log says which version was found, which is pinned and what to set. A release pins both the runner image's base and the agent image
by digest (`runner/Dockerfile.factory-runner` says so, and warns at build time when `AGENT_IMAGE_REF` is a tag).

The **canned turn** is a whole turn of the pinned OpenCode inside that container against a canned model
(`canned_provider.py`, an OpenAI-style completion with a stream, run beside the engine): the engine starts, calls a provider,
streams the words, ends with the usage the model gave. No network, no key, no model, no subscription. `agent-docker` is checked
only under `sysbox-runc`: a container is made from a file of the image and run in the agent's own Docker.
What it does **not** prove is covered elsewhere: the door and the git rules by the unit and lane tests of the Implementer, the
Sysbox wall by a VM with Sysbox.

### Limits

Enforced on the containers of a turn, through the host's Docker (`limits.py`): **memory** (`Memory` = `MemorySwap` of the agent's
container; below 1024 MB the runner is not ready), **CPUs** (`NanoCpus`), **one run at a time**. Announced to the app and shown in its
list: the same, plus `diskGb`.

What is **not** limited (S4, follow-up R2): the **CPU limit applies to the agent's container only**. The model door, the reader, the
rule helpers, the setup container and the runner's own git processes run without one (they are small and short, but they are not
capped). **Disk is not limited at all**: `diskGb` is announced (the free space of `/work` when not set) and shown in the list, nothing
enforces it. The work folders of a turn are emptied after the job (above), but the Docker images, the session volumes and whatever
the agent writes into its container during a turn are the machine's to bound: size the machine's disk for the largest job you accept,
and watch `docker system df`.

**R2** (not done): a disk budget for the work and session volumes with cleanup; limits for the containers beside the agent (reader,
doors); more than one run at a time (needs per-run names and networks); the install script, `update` and the signed self-update;
the Sysbox install step.

### Tests

Unit (`tests/unit/test_factory_runner_*.py`, `test_runner_profile.py`): configuration, command, loop with doubles, once mode, self-test
with a double daemon (also: a stale agent image), limits, the cleaning between jobs (two turns in a row over the service, with the
code of a turn's own directory set-up), the credential's source and the Dockerfile's promises. Contract (`tests/contract/test_factory_runner_contract.py`): the runner's real client against
a fake App (`tests/runner_app.py`) that holds every body to `runner-registration.v1.json` and `runner-api.v1.json`. Integration
(`tests/integration/test_factory_runner_loopback.py`): register, announce, claim, run a turn through the real job host with a
stand-in job process, heartbeat, report; no job in time; the once mode with the environment alone; a revoked runner (before a claim
and during a turn); an app that requires an update. Lane (`tests/lane/test_runner_selftest.py`): the self-test on a real
daemon with the real agent image, and the removal of what a killed run left (a labelled container and network; an unlabelled container
stays). The whole turn with a model and a repository is the Implementer's lane (`test_implementer_turn.py`),
whose code the runner runs unchanged.

### Security notes

- **Without Sysbox (`runc`) the agent is root with ordinary Docker isolation.** The agent's container runs as root inside the
  container, as it does under Sysbox, but under `runc` that root is the machine's root user in a container of the daemon, kept in by
  namespaces, Docker's default capabilities and seccomp profile and the cgroup, and nothing else; under Sysbox the same root is an unprivileged user on the host
  (a user namespace of its own) and the agent can also run its own Docker (`agent-docker`). A container escape of the kind that
  hits Docker now and then is therefore **root on the machine** under `runc`, reachable from whatever the agent runs: the model, the
  code of the repository it works on, a prompt injected through it. The agent has no network except the model door, no mount of the host,
  no socket, no key (the door holds it), no added capability, no swap and a memory limit, which is what closes the ordinary ways out;
  it does not make `runc` a sandbox for hostile code. Run a `runc` runner on a machine that holds nothing you cannot lose
  and that is no stepping stone to anything (a VM, not a workstation), or install Sysbox and let `auto` choose it. The announcement
  says nothing about it yet; the runner's runtime is in the self-test line `agent-container: runtime ...`.
- **Firewall tables in the host's network namespace stay behind (S5).** To close what a container that owns its network namespace could
  open, Control installs `nft` tables in the **machine's** namespace, from a one-shot helper container with `NET_ADMIN` and nothing else
  (`implementer/host_rules.py`, `implementer/setup_container.py`): `setup_egress` (an `ip` table that drops what the Setup container
  may not reach: the machine itself, private ranges, the other bridges), and `implementer_ipv6_agent` and `implementer_ipv6_setup`
  (`inet` tables that drop IPv6 from the agent's and the Setup container's bridge; only on a kernel that has the `inet` family). They
  only drop, they only name the interface of Control's own bridges, and they hook before Docker's own rules, so they cannot block
  anything else on the machine. On a hosted VM they go with the VM. On a runner **nothing removes them**: they stay after a job and
  after the service is stopped, until the machine restarts (nft tables are not persistent) or you delete them
  (`nft delete table ip setup_egress`, `nft delete table inet implementer_ipv6_agent`, and so on). The `inet` tables are flushed
  when a job installs them again, so they stay one table of the same rules. `setup_egress` is not: each job that runs a Setup
  container appends the same rules once more, which blocks nothing new and accumulates until the table is deleted or the machine
  restarts (R2 deletes it after the job). (The tables of the model door and the network door, `door_egress` and `netdoor_egress`,
  live in the door container's own network namespace and go with the container.) Removing the host tables with the leftovers of a
  job is R2.

### Known limits

- **One runner per Docker daemon.** The containers have fixed names (`code-reviewer-agent` ...) and the model network a fixed address, so a
  second runner on the same daemon would fail every turn with a 409. Every container and network a runner's job creates carries
  `code-reviewer.runner=<runnerId>` (a runner without an id from the file, one with a credential from the environment, uses a digest of
  the credential), so a runner removes only its own and refuses to start beside another (exit 9). **The operator must run one runner per
  daemon.** Another runner is recognised only while it has a container or a network on the daemon, or holds the lock; two runners with the
  same id (one configuration copied to two machines on one daemon) are not told apart. The lock closes the window of two different runners
  that start in the same moment. Unique names, and with them more runners on one daemon, are R2. The hosted version sets no id and is
  unchanged.
- **Snapshot and stored session.** Resume works on customer runners (#879, "Resume on customer runners"): the runner sends `PUT .../session` and `GET .../resume-session` to the runner API's routes when
  the app lists `runner_session_snapshot`. Against an app that does not list it (an older release) a turn on a runner takes **no snapshot** and a follow-up turn continues from the summary of the earlier ones
  (the fallback of the plan).
- **SIGTERM during the self-test** (N4) comes before the signal handlers are installed and ends the process at once; nothing is claimed.
- **No warning for a `config.json` that is too open** (N5): the file is written 0600 in a 0700 folder, but a mode changed later is not noticed.
- **`proven` under `runc`** (N6): the name of the sandbox proof says only that the self-test passed; under `runc` there is no Sysbox wall (see the security notes).
- **No proxy for the app client** (N7): the runner talks to the app directly (`HTTPS_PROXY` is not read).
- **`register --force`** (N8) replaces the local file and leaves the old runner in the app's list: revoke it there.
- **The credential file** is as safe as the machine: whoever reads it is the runner. Revoke the runner in the app if the machine is lost.
- **The page's command** shows `factory-runner register --token ...` without an address; the command goes to `https://code-review.com`.
  `--url` is for another app.

## Spikes R0 (#853)

R0 settles two questions of the plan on a real VM, with no real model, no real key and no subscription:

- **S1**: can Claude Code run headless in the agent's container, and what does the runner need to know to drive it (events,
  finish tool, resume, permissions, login, cost)?
- **S2**: what does the agent's own Docker cost on a plain Linux host, where Sysbox may be missing?

S3 (Anthropic's answer on unattended runs with a subscription token) is the owner's action and is not a measurement.

**Where it was measured.** A `spike-853-r0-*` Vercel Sandbox VM from the platform's **plain** image (no snapshot, none of
our boot steps): Ubuntu 26.04.1, kernel 6.18.56, 2 vCPU, 4 GB, no systemd, no AppArmor, `docker.io` 29.1.3 installed by
the script. The whole script ran clean on three fresh VMs in a row (the numbers below are those of the last, `-4`; the
other two are within the ranges given). Claude Code **2.1.311** (npm `stable` on 2026-11-04; `latest` was 2.1.318) in a
`node:24-bookworm-slim` image. The provider is the strict scripted Anthropic Messages fake of `fakes/wire` (it refuses a
history the real API would refuse) behind a made-up key, listening on the VM's address of an `--internal` Docker network,
the way the model door does: the Claude Code container has no route anywhere else, and it runs, so it needs no internet
beyond its provider. The fake is used **unchanged**; only its listening address is widened inside the script's own
subclass (`fakes/` is not touched). Every token and key in the script is a made-up string.

**Rerun.** On a `spike-` VM, as root, with `runner/`, `fakes/` and `docker/` copied to it (no `uv sync`: standard library
only): `hostname spike-853-1; python3 runner/scripts/runner_spikes.py all --out /root/out` (about six minutes; `s1` and
`s2` alone; `--only events,finish,kill,resume,permissions,auth,cost,stream-input,resources` and
`--only none,rootless,privileged,sysbox-plain,sysbox`). It prints one JSON line per check (`{"check", "ok"}`) and per
fact, and keeps the raw `stream-json` of every run and the requests the provider saw in `--out`. The script refuses to run
unless the host name starts with `spike-` or `FOLLOW_UP_SPIKE_I_AM_ON_A_SPIKE_VM=1` is set (it pulls images, installs
packages and removes containers by fixed names); the platform names its VMs with a random id, so set the host name first.
The mapping of events to step records and the rules of the finish tool are unit tests
(`runner/tests/unit/test_runner_spikes.py`).

### S1: Claude Code headless in a container

#### (a) The events of `claude -p --output-format stream-json --verbose`

One scripted turn: read a file (after a thought), run a command beside a second read (parallel tool use), edit the file,
end with text. Four model calls; 13 events (48 with `--include-partial-messages`); 0.79 s wall from `docker run` to exit,
of which Claude Code's own `duration_ms` was 301 (API 143). Container memory peak 141 MiB; the image is 251 MB (27 s to
build: Node, `git`, `ripgrep`, `npm i -g @anthropic-ai/claude-code@2.1.311`).

| Event                                     | When                                                                                                 | What it carries                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `system/init`                             | once, first                                                                                          | `session_id`, `cwd`, `model`, `permissionMode`, `apiKeySource` (`ANTHROPIC_API_KEY`, `apiKeyHelper`, `none`), `claude_code_version`, `tools[]`, `mcp_servers[{name,status,source}]`, `memory_paths`, `capabilities[]`, the lists of slash commands, skills, agents, plugins                                                                                                                      |
| `system/status`, `system/thinking_tokens` | before each call, while thinking                                                                     | progress only; ignored                                                                                                                                                                                                                                                                                                                                                                           |
| `assistant`                               | **one per content block**, when the block has ended; all blocks of one model call share `message.id` | `message.content[0]` is a `thinking` (text and `signature`), `text` or `tool_use` (`id`, `name`, `input`, `caller:{type:direct}`) block; `message.usage` is the usage **of `message_start`** (`output_tokens` is 1, not the real count); `timestamp`; `parent_tool_use_id`                                                                                                                       |
| `user`                                    | when a tool ended; parallel tools in the order they **finished**                                     | `message.content[{type:"tool_result", tool_use_id, content, is_error?}]`; beside it `tool_use_result` (the structured result: file, patch, stdout) and `tool_result_meta[{id, permission_decision}]`                                                                                                                                                                                             |
| `stream_event`                            | only with `--include-partial-messages`                                                               | Anthropic's raw stream events. `message_delta.usage` is the **final** usage of a call (`output_tokens` 21, 22, 23, 24 where the `assistant` events say 1)                                                                                                                                                                                                                                        |
| `result`                                  | once, last                                                                                           | `subtype` (`success`, `error_max_budget_usd`, `error_during_execution`), `is_error`, `result` (the last text), `session_id`, `total_cost_usd`, `usage{input_tokens, output_tokens, cache_*, cache_creation{ephemeral_5m, ephemeral_1h}}`, `modelUsage{<model>:{inputTokens, ..., costUSD, costBasis}}`, `permission_denials[]`, `terminal_reason`, `num_turns`, `duration_ms`, `duration_api_ms` |

**Mapping to our step records** (`step_records.py`). A tool call has no event at its start but the `assistant` event of its
`tool_use` block, which comes before the tool runs, so that event is `running`. The proposed adapter (`ClaudeEvents` in
the script) turns each Claude Code event into the engine-shaped event that the unchanged `StepConverter` already reads, so
that the bounds (16 KiB of text, 4 KiB of input, 5,000 records), the redaction and "an output is never recorded" stay
where they are and `StepFeeder` does not change:

| Claude Code                    | Our record                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `assistant` block `thinking`   | `reasoning` (the part is finished when the event comes), `partId` = `<message.id>.<n>`                                   |
| `assistant` block `text`       | `text`                                                                                                                   |
| `assistant` block `tool_use`   | `tool`, `running`, `partId` = the `tool_use` id (it matches the id pattern), `tool` = the name, `input` = the JSON input |
| `user` `tool_result`           | the same `tool` part again: `completed`, or `error` with the text of the result when `is_error`                          |
| `stream_event` `message_delta` | `step` with the call's tokens (`input`, `output`, `cacheRead`, `cacheWrite`) and `reason` = `stop_reason`; **no cost**   |
| `result`                       | ends the turn; `total_cost_usd` is the turn's total                                                                      |

Verified on the run: 1 `reasoning`, 1 `text`, 8 `tool` records (4 tools, each `running` then `completed`), 4 `step` records;
the step tokens add up to the `result` (input 4,100, output 90). **It needs `--include-partial-messages`**: without it the
output tokens of a step are wrong (1). Other things the adapter must know: Claude Code's tool names are capitalised
(`Read`, `Edit`, `Write`, `Bash`, `Agent`, `Skill`, `WebFetch`, ...) where OpenCode's are lower case, and this version has
**no `Glob` or `Grep` tool** (an attempt answers `No such tool available`; the agent searches with `Bash` and the bundled
`rg`); a per-call cost is in no event, so the runner prices a step from the book. Not measured: the text a real model
returns for a thinking block (a summary or nothing), and the events of a sub-agent (`parent_tool_use_id` is set for them).

#### (b) The finish tool as an MCP server

`submit_result` with a JSON-schema input (`summary` required, `files` an array of strings, `additionalProperties: false`),
once as a **stdio** server inside the container and once as an **HTTP** server on the runner's side (Streamable HTTP, one
`POST` per message, a bearer capability in the header). The script has the agent submit a result the tool must reject (a
number, an unknown field), then a correct one.

| Question                                 | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Claude Code list and call it?       | **Yes**, both ways. `init.mcp_servers` says `{name:"factory", status:"connected"}`, `init.tools` has `mcp__factory__submit_result`, the calls reach the server. A whole turn takes 0.86 s (stdio), 0.89 s (HTTP).                                                                                                                                                                                                                            |
| How is it offered to the model?          | **Deferred by default.** The first request has no schema for it: only its name in a system reminder and the `ToolSearch` tool, so a real model must first call `ToolSearch`. With `ENABLE_TOOL_SEARCH=false` the first request carries the tool whole, `input_schema` as sent (`additionalProperties: false` kept) beside 25 built-in tools. Not measured with a real model: how often it would find the tool by itself.                     |
| Does Claude Code validate the arguments? | **No.** `{"summary":5,"extra":true}` reached the server. The server is the validator.                                                                                                                                                                                                                                                                                                                                                        |
| How does a rejection reach the agent?    | The server answers `result:{isError:true, content:[{type:"text", text:"Rejected: unknown field \"extra\" ..."}]}`; the model gets a `tool_result` with `is_error: true` and **that text unchanged**; the second call (correct) was accepted. The same for the command (below).                                                                                                                                                               |
| Handshake                                | `server/discover` first (MCP draft 2026-07-28), then `initialize` (2025-11-25), `notifications/initialized`, `tools/list`. A server answers an unknown method with JSON-RPC `-32601` and it falls back. Over HTTP: `Accept: application/json, text/event-stream`, the bearer header on **every** request, the `Mcp-Session-Id` of the `initialize` answer echoed, and a `GET /mcp` (an attempt to open a stream) answered `405` is accepted. |

**An HTTP finish tool on the runner's side contradicts a rule of the base**: the agent container reaches the model door and
nothing else, Control has no address the agent can reach. The measurement used the VM's address on the internal network for
the server. So the finish tool for Claude Code is a **stdio shim inside the container** that validates against the
schema (delivered with the config, like the OpenCode config) and hands the result to the runner through the exec channel,
as the command does; or the door grows a per-run capability endpoint.

**Built in #843.** The finish tool of the hosted Implementer is this shim: one standard-library program, `finish_tool.py`, is `factory-submit` (the
command) and `factory-submit mcp` (the stdio MCP server with the tool `submit_result`) in the agent's container, and Control imports the same file for
its own check; see [`implementer.md`](implementer.md#the-finish-tool). OpenCode 1.19.0 takes the server from its config (`mcp.finish`, `type: local`,
the command the engine starts itself) and names the tool `finish_submit_result`; a test with the real binary and the strict fake provider hands in a
wrong result and a right one through the tool and through the command (`runner/tests/engine/test_engine_implementer_finish.py`, and the Docker lane
`runner/tests/lane/test_implementer_finish.py`). The result goes to a file on a directory of the work volume that Control reads through a reader, not
over the exec channel; a harness of a runner reads the same directory.

#### (c) `factory-submit` as a command through the Bash tool

`echo '<json>' | factory-submit` on `PATH`: a rejected result is exit code 2 and a line on stderr; Claude Code returns
`Exit code 2\nfactory-submit: rejected: unknown field "extra" (allowed: summary, files)` as a `tool_result` with
`is_error: true`; the corrected call was accepted. It needs no MCP and no tool search, and works for any level-0 harness.
It depends on the prompt telling the agent to use it.

#### (d) `--resume` after the container was thrown away

`CLAUDE_CONFIG_DIR` or `~/.claude` on a mounted directory. Turn one in a container, the container removed, turn two in a new
container with the same directory and `--resume <session-id>`:

| Question                              | Answer                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does turn two continue?               | **Yes.** The strict provider got a first request of 5 messages with turn one's instruction, its answer and the result of its `Read`; it accepted the history. The session id stays the same (no fork).                                                                                          |
| What is on the volume?                | `projects/-work/<session-id>.jsonl` (the transcript, tool outputs included, **254 KB after a turn of two calls, +5 KB per extra turn**), `plugins/` and `backups/` (a few bytes). The made-up API key is **not** in any file there.                                                             |
| `~/.claude.json`                      | lives **outside** `~/.claude`; with only `~/.claude` mounted a new container prints `Claude configuration file not found at: /root/.claude.json` (harmless). `CLAUDE_CONFIG_DIR=/session` puts it, the credentials file and the sessions into **one** directory: use that.                      |
| Choose the id                         | `--session-id <uuid>` on turn one; `--resume <same uuid>` continues it (checked).                                                                                                                                                                                                               |
| Empty volume                          | exit code 1, `result` `is_error: true`, stderr `No conversation found with session ID: ...`, **no model call**. The runner must detect it and fall back (a fresh session with a summary of the branch).                                                                                         |
| Another working directory             | `--resume` found the session by id and carried the history from `/other` too, but the transcripts are filed by the working directory (`projects/-work/`): keep the agent's path fixed (`/work/repo`).                                                                                           |
| Container killed in a running command | exit 137, the session ends with a `tool_use` nothing answered. **`--resume` repairs it**: it sends a synthetic `tool_result` (`[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. ...]`) and the strict provider accepts the history. |
| A second message in the same process  | `--input-format stream-json` takes a second user message after the first `result` (the hosted turn's extra message for a dirty tree): two `result`s, same session id, `total_cost_usd` **cumulative** in the process (0.0074, then 0.0112).                                                     |

#### (e) The permission mode for an unattended run

The script asks for five things (a read, a command writing in the working directory, an edit, a write outside it, a command
writing outside it) under each way of running:

| Way of running (in the container, as root unless noted)                                                                                                    | Result                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| no flag (`-p` default)                                                                                                                                     | only the read ran; the other four were **refused** (`permission_denials` 4): `Output redirection to '/work/bash-out.txt' needs approval ...` |
| `--permission-mode acceptEdits`                                                                                                                            | read, bash in the working directory, edit ran; write outside and bash outside refused                                                        |
| `--permission-mode dontAsk`                                                                                                                                | read ran, four refused ("denied because Claude Code is running in don't ask mode")                                                           |
| `--allowedTools "Read,Edit,Write,Bash"`                                                                                                                    | all five ran (as root, `touch /etc/...` too), mode stays `default`; only the listed tools                                                    |
| `--permission-mode bypassPermissions`, `--dangerously-skip-permissions`, or `--settings '{"permissions":{"defaultMode":"bypassPermissions"}}'` **as root** | **refused to start**, exit 1: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`                 |
| the same with **`IS_SANDBOX=1`**                                                                                                                           | all five ran, mode `bypassPermissions`, no denial                                                                                            |
| `--dangerously-skip-permissions` as uid 1000                                                                                                               | four ran; `touch /etc/...` failed on file permissions (`Permission denied`), which is the OS and not Claude Code                             |

The hosted agent is root with its own Docker, and the sandbox is the guard, not a list. So the adapter runs
`--permission-mode bypassPermissions` **with `IS_SANDBOX=1`**. `IS_SANDBOX` is **not in Anthropic's documentation** (which
only says that the root check "is skipped automatically inside a recognized sandbox"): it is a behaviour of 2.1.311 to be
watched, and the runner's `selftest` must run a canned turn of the adapter and fail the harness when it breaks. The
alternative is a non-root agent user, which gives up what the base promises (root, `apt`, a free Docker). Deny rules still
hold in bypass mode (documented); `--allowedTools` would be a closed list. `claude --help` has `--max-budget-usd`,
`--resume`, `--session-id`, `--fork-session`, `--input-format`, `--include-partial-messages`, `--mcp-config`,
`--strict-mcp-config`, `--settings`, `--setting-sources`, `--append-system-prompt`, `--add-dir`, `--bare`,
`--no-session-persistence`; it does **not** list `--max-turns`. A note for prompts: Claude Code refuses a Bash command that
chains `sleep N` and tells the agent to use its `Monitor` tool.

#### (f) What carries the login

Each variant ran a one-line turn against a provider that accepts the made-up value as the key or as a bearer token.

| Way                                                                                                                        | What the provider received                                                                     | `init.apiKeySource` / notes                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                                                                        | `x-api-key`                                                                                    | `ANTHROPIC_API_KEY`; in `-p` the key is always used when present (documented)                                                                                                                                                                                               |
| `CLAUDE_CODE_OAUTH_TOKEN`                                                                                                  | `Authorization: Bearer <token>` and an `anthropic-beta` that contains `oauth`                  | `none`; `claude auth status` says `{"loggedIn":true,"authMethod":"oauth_token"}`; the token is not written to any file                                                                                                                                                      |
| `ANTHROPIC_AUTH_TOKEN`                                                                                                     | `Authorization: Bearer <token>`, no oauth beta                                                 | `none`                                                                                                                                                                                                                                                                      |
| both a key and an OAuth token                                                                                              | the key (`x-api-key` only)                                                                     | documented order: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, the stored login                                                                                                                                                  |
| `~/.claude/.credentials.json` (`claudeAiOauth{accessToken, refreshToken, expiresAt, scopes, subscriptionType}`, mode 0600) | the same bearer and oauth beta                                                                 | with `expiresAt` in the past it **still sent the stale token** and the run succeeded: a refresh, if it was tried, could not leave the internal network and did not fail the run. A real refresh needs Anthropic's token endpoint, which the agent container must not reach. |
| `apiKeyHelper` in settings                                                                                                 | **both** `x-api-key` and `Authorization: Bearer` with the helper's output                      | `apiKeyHelper`                                                                                                                                                                                                                                                              |
| nothing                                                                                                                    | no request at all; exit 1, `result` `is_error: true`, text `Not logged in · Please run /login` | `none`                                                                                                                                                                                                                                                                      |

Every way honours `ANTHROPIC_BASE_URL`, subscription traffic included, and takes any string as the credential (the format is
not checked locally). So the local door could swap a **dummy** token for the real one as it swaps the API key, and the token
would not enter the agent container (expected to work, **not tried** with a real token). `claude setup-token` (documented:
a one-year inference-only token, printed once and stored nowhere, "for CI pipelines, scripts, or other environments where
interactive browser login isn't available") is the form for a runner; the stored login file is not (it refreshes itself).

#### (g) The cost figure

| Run                                                                                         | `total_cost_usd`                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key, the scripted turn (input 4,100, output 90, cache read 1,210, cache write 210 + 38) | **0.0150285**, which is exactly the list price of the usage (Sonnet: $3 / $15 / $0.30 / $3.75 / $6 per million); `modelUsage.<model>.costBasis` is `list`; no per-call cost in any event                      |
| the same with a subscription-style bearer login                                             | the same figure and `costBasis: list` (documented as a client-side estimate; **what a real subscription run reports is not measured**)                                                                        |
| a model name nobody priced                                                                  | a fallback figure (0.0198, 1.32 times the list price), `costBasis: unknown`, and a stderr line `[claude-code:unrecognized_model]`: treat anything but `list` as "unknown"                                     |
| `--max-budget-usd 0.01`                                                                     | the turn ends after the third call (0.0112 spent): `result.subtype: error_max_budget_usd`, `is_error: true`, `terminal_reason: budget_exhausted`, exit 1. It stops **after** the call that crosses the limit. |

For an API-key run the door's ledger stays the exact figure and the brake. A subscription run goes through no door, so
`--max-budget-usd` and the job's clock are its only brakes.

### S2: the agent's own Docker on a plain host

All options run `docker:29.9.2-dind` (or its `-rootless` variant, the digest-pinned version of the agent image's Docker
binaries) as the agent's container on the VM's Docker, then run `postgres:17-alpine` in it. "Ready" is the time from
`docker run -d` until the inner `docker info` answers; "answers" is from the inner `docker run -d` until `pg_isready` and
`select 6*7` answer (the image is already pulled inside); the pull (3 to 6 s, the network's) is not in it. Memory is the outer
container's cgroup peak with postgres running.

| Option                                                           | What the container needs from the host                                     | Ready                                                                          | Pull inside | Postgres answers                                                                                 | Memory peak | Does `docker run postgres` work?                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- |
| **3. No Docker in the agent** (plain container)                  | nothing: no capability, no device, default seccomp                         | 0.27 s (start)                                                                 | -           | 1.26 s as a **service container** beside it on a shared network                                  | -           | no (`docker: not found`, no socket); a service container the runner starts works                            |
| **2. Rootless DinD**, no flags                                   | -                                                                          | **fails**: `rootlesskit ... fork/exec /proc/self/exe: operation not permitted` |             |                                                                                                  |             | no                                                                                                          |
| rootless + `/dev/net/tun` only                                   | the device                                                                 | fails, same error (the default seccomp profile)                                |             |                                                                                                  |             | no                                                                                                          |
| rootless + tun + `seccomp=unconfined`                            | + no syscall filter                                                        | 2.2 s                                                                          | 3.9 s       | **fails** at `docker run`: `error mounting "proc" to rootfs at "/proc": operation not permitted` | 476 MiB     | no                                                                                                          |
| rootless + tun + `seccomp=unconfined` + `systempaths=unconfined` | + the masked `/proc` paths unmasked                                        | 1.6 s                                                                          | 5.6 s       | 1.4 s                                                                                            | 542 MiB     | **yes** (8.8 s from `docker run` to a running postgres)                                                     |
| the same + `apparmor=unconfined`                                 | + no AppArmor profile (this VM has none: **not testable here**)            | 1.4 s                                                                          | 3.8 s       | 1.4 s                                                                                            | 450 MiB     | yes                                                                                                         |
| rootless + `--privileged`                                        | everything                                                                 | 2.4 s                                                                          | 4.4 s       | 1.4 s                                                                                            | 466 MiB     | yes                                                                                                         |
| **Rootful DinD, `--privileged`**                                 | everything: the container is root of the host                              | 2.5 s                                                                          | 3.7 s       | 1.2 s                                                                                            | 505 MiB     | yes; **and the agent mounted the host's root disk (`/dev/vdb`) and read its `/etc/hostname`**               |
| **1. Sysbox** (`--runtime=sysbox-runc`, `docker:dind`)           | the runtime and two daemons on the host (below); the container has no flag | **1.6 s** (3.1 s for the second start)                                         | 4.6 s       | 2.0 s (8.9 s for the second, which pulled inside)                                                | 425 MiB     | **yes**; root of the container is host uid 165536 (`uid_map 0 165536 65536`); the host disk is out of reach |

(Ranges over the three clean VMs: Sysbox ready 1.6 to 2.7 s, rootless 1.4 to 2.1 s, rootful 2.4 to 2.9 s; a running postgres
from `docker run` including the pull 8.4 to 11.6 s, 6.6 to 9.1 s and 7.4 to 10.1 s.) A rootless run is **user 1000** in the
container with `Running in rootless-mode without cgroups`: no `apt`, no `sudo`, no memory or CPU limit for the containers
inside, slirp4netns for the network. **A DinD started with an empty `DOCKER_TLS_CERTDIR` waits 15 s on purpose** ("Startup is
intentionally delayed": it binds an unprotected TCP port): the agent's init must not.

#### Sysbox on this distribution (the question of what it means for customers)

| Question                                                        | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install on Ubuntu **26.04** (officially supported: up to 24.04) | the pinned `sysbox-ce_0.7.1.linux_amd64.deb` (14.5 MB, checksum as pinned, 50 MB installed) installs in 3.1 s, `sysbox-runc` runs, a container and a DinD under it run. **Nothing needed a newer package**. Kernel 6.18 needs no shiftfs.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| What the package depends on                                     | `Depends: debconf, fuse, lsb-release, rsync, iptables`; the maintainer script also needs **`jq`** (to edit `daemon.json`) and **`systemctl`** (to restart Docker), which it does not declare, and the golden snapshot installs **`kmod`** beside it for the same reason.                                                                                                                                                                                                                                                                                                                                                                                               |
| What the package does to a host                                 | installed **as a customer would**, with Docker running and no `daemon.json`, it **rewrote `/etc/docker/daemon.json`**: the `sysbox-runc` runtime, **`bip: 172.20.0.1/16`** and **`default-address-pools: 172.25.0.0/16`**, and then, with no container present, runs `systemctl restart docker` (line 278; with containers it only prints the advice to restart). Here there is no systemd, so the script died with exit 127 and left the package `half-configured` (the binaries worked all the same). With the daemon stopped, as the golden snapshot does it, it installs clean. A customer's Docker is restarted or has its network ranges changed by the install. |
| What a host must run                                            | `sysbox-mgr` and `sysbox-fs` (the package's `systemd` units do it on a normal host; here started by hand). Without them `docker run --runtime=sysbox-runc` fails: `failed to register with sysbox-mgr ... /run/sysbox/sysmgr.sock: no such file`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Which of our boot steps this platform needs                     | After the daemons, `docker run` still failed with `re-mounting procfs caused: operation not permitted` until the platform's read-only mounts over `/proc/kcore` and `/proc/keys` were unmounted. That is a **quirk of the platform's VM**, not of Sysbox. `/dev/net/tun` mode 0600 is the other quirk (it stopped rootless DinD, below; a regular host has 0666). A customer's host needs neither step.                                                                                                                                                                                                                                                                |
| Official support (Sysbox's own table, not measured here)        | Ubuntu 20.04, 22.04 and 24.04 and Debian 10 and 11 with the package, kernel 5.4 up (24.04: 6.8 up), systemd, Docker **not** from snap; Fedora, Rocky, Alma, CentOS and Amazon Linux only as a work in progress; RedHat only in the paid edition.                                                                                                                                                                                                                                                                                                                                                                                                                       |

### What follows for the runner

**S1.** Claude Code is a good level-2 harness: structured events that map cleanly onto the step records, a finish tool as
a real tool, resume across a thrown-away container (even after a kill), an unattended mode, a login that is one variable and
a cost figure. The adapter is: `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages
--permission-mode bypassPermissions --model <m> [--resume <id> | --session-id <uuid>] [--max-budget-usd <n>]
--mcp-config <shim> --strict-mcp-config`, with `CLAUDE_CONFIG_DIR` on the session volume, `IS_SANDBOX=1`,
`ENABLE_TOOL_SEARCH=false`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, and the login as
`ANTHROPIC_API_KEY` (BYOK, behind the door) or `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). The version is pinned in
the image layer, and the selftest runs a canned turn of the adapter against the fake, because `IS_SANDBOX`,
`--include-partial-messages` and the tool-search switch are behaviours of a version.

**S2.** The agent's own Docker is a **capability the runner announces** (`agent-docker`), not part of the base:

- **Proven means Sysbox.** The runner announces `agent-docker` only when its selftest has started a Sysbox container with a
  Docker in it and run a container in that. Everything else the agent does without it.
- **Rootless DinD does not fit the base.** It needs `seccomp=unconfined` and `systempaths=unconfined` (and on Ubuntu
  23.10+/24.04, where AppArmor restricts unprivileged user namespaces, `apparmor=unconfined`, which this VM could not
  show), and the agent is then an unprivileged user without `apt`, `sudo` or limits for its containers, which is not the
  hosted agent. It stays a documented fallback at most.
- **`--privileged` DinD is out**: the agent reads the host's disk. So is the host's Docker socket.
- **Without Sysbox the agent still works** (no Docker in the agent, 0.27 s to start, no host change). A project that needs
  a database in its tests can have the runner start **service containers** beside the agent (postgres answered after
  1.3 s from the agent), which is a feature for later and needs only the runner's own Docker.

Not measured here: a host with systemd and AppArmor (Ubuntu 22.04/24.04 as a customer has them), Debian, a kernel older than
6.18, Sysbox's own install on a host with running containers, the cost of the daemons Sysbox keeps running (idle memory of
`sysbox-mgr` and `sysbox-fs`), and any real model, real subscription or real key.
