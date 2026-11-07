# The Factory-Runner: spikes and decisions

The Factory-Runner is the Implementer's Control, packaged to run on a customer's Linux machine and take the jobs of its
workspace (the plan is the owner's `plans/customer-runner.md`, milestones R0 to R4, epic #852). Its app side (registration, the
list, routing) is R1a; the runner itself, with the base and OpenCode, is R1b. This document holds what the app does for it, how
the runner is built and used, and what was **measured** before it was built; it grows with the milestones.

- [Registration and routing](#registration-and-routing-r1a-854): how a machine becomes a runner of a workspace (R1a).
- [The Factory-Runner](#the-factory-runner-r1b-854): the service, the `factory-runner` command, the image, installation for a
  developer and operation in a VM (R1b).
- [Claude Code, R3](#claude-code-r3-856): the first slice of the Claude Code harness (adapter core) and what is left.
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
    The call is bounded as a whole (10 s, `VERSION_CALL_TOTAL_SECONDS`, part of the lease budget in `resume_download.py`). A call that fails, is too slow or gives no list never stops the job: it runs without the snapshot and
    the runner logs one warning with the class of the failure (nothing of the answer). An app that answers with a list that leaves out `implementer_steps` switches the steps off for the job; only an app that gave no list at all keeps the default (steps on).
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
its model is managed and which harness it runs with. Since #919 the environment is part of the profile, so the same two rules are checked when a **profile** is saved
(`POST .../profiles`, at `/environment`), and again for a step at its `/profile` (at its `/environment` for a profile version saved before #919, whose step names the environment):

| Code                   | When                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_needs_own_key` | A profile (or an agent step) runs a **managed model** in an environment of the kind `runner`. Managed models run on platform VMs only. |
| `harness_needs_runner` | A profile (or an agent step) has a **harness other than OpenCode** in an environment that is not a runner's.                            |

A profile names its harness (`opencode` or `claude-code`, [`profiles.md`](profiles.md)); a harness other than OpenCode runs only on a runner.

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

### Install (one line, R2)

For a Linux machine with **Docker** (the engine, not rootless), **systemd** and x86_64. Create a registration token in the app
(Owner or Admin: Runners, "Add a runner"; it is valid for an hour and works once), then, as root. **The installer asks for the token on
the terminal** (the input is hidden; nothing of it is in the process list, the shell history or the log of `sudo`):

```sh
curl -fsSL https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh | sudo sh
# settings go behind `-s --`:   ... | sudo sh -s -- --labels linux,gpu --disk-gb 50
```

or from a file that only root can read (save the script first: under `curl | sh` the standard input *is* the script, so `--token-file -`
cannot read the token from it):

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh
sudo sh install.sh --token-file /root/runner-token --labels linux,gpu
```

`FACTORY_RUNNER_TOKEN=crt_... sudo sh install.sh` also works, but **only use it on a machine where that does not matter**: the token is
then in your shell history, in the log of `sudo` and, while the command starts, in the process list. The installer prints that warning when
the token came from the environment. (The token is valid for one hour and works once, which limits what a leak costs, not whether to avoid it.)

[`runner/install/install.sh`](../runner/install/install.sh) is one POSIX shell file. In this order it:

1. **checks** Linux, x86_64, root, Docker (the daemon answers, not rootless), systemd, `curl`, `openssl`, `base64` and `sha256sum`;
2. reads the **release channel** (`runner/release-channel.json`: the image repository, the addresses of the signed release manifest and its
   signature, and the public key that proves them; or the file you name with `--channel-file`). **Empty until the owner fills it: then the
   installer stops with "no runner image is published yet"** and installs nothing;
3. fetches the **manifest and its signature**, **verifies the signature with `openssl`** (ECDSA P-256, SHA-256; see "Updates"), **pulls the image
   by the digest the manifest names**, checks that the image carries the release number the manifest names, and names it `factory-runner:current`.
   A manifest that does not verify, or an image that is not the release it names, installs nothing (the image is removed again). **The installer
   never goes back**: it reads the release of the installed `current`, and when the announced release is the same, older, or one a
   `factory-runner update --rollback` rejected (see "Updates"), it pulls nothing and changes no tag. `previous` is set only when `current` changes;
4. writes the **command** `/usr/local/bin/factory-runner` (a throwaway container of `factory-runner:current` with the socket, the
   configuration volume and `/work`) and the **systemd unit** `/etc/systemd/system/factory-runner.service`: the container `run --rm
   --stop-timeout 150` with the host's Docker socket (for the runner only: the agent never gets it), the volumes `factory-runner-home`
   (the configuration, the credential) and `factory-runner-work` (`/work`), `FACTORY_RUNNER_IMAGE_TAG=factory-runner:current`,
   `Restart=always` (but not after exit codes 4 revoked, 6 configuration, 9 shared daemon), `TimeoutStopSec=170` and a rotated log of the
   container (`--log-opt max-size=10m --log-opt max-file=3`);
5. **registers** the machine with the token and applies `--name --labels --url --cpus --memory-mb --disk-gb`;
6. enables and **starts** the service.

The token is **never an argument** (`--token` is refused, it would be in the process list and the shell history): it comes from
`--token-file FILE` (`-`: standard input; a file that is named and cannot be read is an error, not a silent skip), from
`FACTORY_RUNNER_TOKEN` (with the warning above), or is asked for on the terminal without echo. It reaches the registration on the
standard input of a container, in no argument and no environment of it. With no token the service is installed and not started, and the
script prints the command to register by hand: `factory-runner register --token-file - < /path/to/token-file` (your shell opens the
file, the command passes it on as the container's standard input; a path the container cannot see is not needed) and then
`systemctl enable --now factory-runner`.

**A download that is cut off changes nothing.** Under `curl | sh` the shell runs the file while it receives it. All of the script is
functions; the last line, `{ main "$@"; }`, is the only command that does anything, and the script ends with the line `install: done`. A cut
anywhere, also inside that last line, defines a few functions at most or is a syntax error; a run that does not print `install: done` did not finish.

**Safe to run again.** A registered machine is not registered twice (the token is not used); a setting you pass is applied with
`config set`; the unit is rewritten only when it differs and a running service is **never restarted** (it switches to a newer image by
itself between two jobs, and reads a changed configuration when it next starts: `systemctl restart factory-runner` after its job). A second
run also finds the newer release and stages it, as `factory-runner update` does, and **never installs an older or a rolled-back one**.
`--purge` is only valid with `--uninstall`.

**The memory of a rollback is read with the installed image, and fails open.** The installer reads `rejected-release` (see "Updates") with
`factory-runner:current`, the only thing on the machine that can read the volume. A file that exists but cannot be read, or holds no whole
number, does not stop the install: it is ignored with a warning on the standard error, and a release that was rolled back may then be
installed again. No file is the normal case and says nothing. **After `--uninstall` without `--purge` and a new install** there is no image
yet when the installer decides, so it cannot read the file even though the volume still has it: it may install the release that was rolled
back (the uninstall says so). To keep the block, write the number into the file again after the install (see "Updates", "the way back by
hand") or `--purge` and start over; the running service reads the file and takes no release up to that number from then on.

**A fresh pull can lose its digest reference.** The service removes the digest references of old releases when it starts (see "Updates"),
and so a pull by digest that is not named yet (`tag`) is one of them. Both the installer and `factory-runner update` pull a second time
when the reference is gone before the tag (the pull is by digest: the same image) and fail with "could not be named" after the second
one; the next run succeeds.

`--dry-run` says what it would do and changes nothing. `--uninstall` removes the service, the command and the images and keeps the
configuration and `/work`; `--uninstall --purge` removes those too (revoke the runner in the app: its credential keeps working
until then). Afterwards the firewall tables Control left in the machine's network namespace (the security notes below) are deleted
by `nft delete table ...` or at the next restart of the machine.

**Sysbox is a separate step, `--sysbox`, never part of the base install.** It prints what it does and asks you to type `yes` on the
terminal (`--yes` accepts the warnings when there is none). **The question comes before the first change** (the image, the unit, the
registration), with the checks it needs and the download of the package and its SHA-256 check; with no terminal and no `--yes` the
installer stops there with "nothing was changed". Any answer but `yes` is not a failure: the base installation goes on without Sysbox.
Only then does the package go in, after `/etc/docker/daemon.json` was copied to `daemon.json.factory-runner-backup` (a backup that exists
already, from an earlier `--sysbox` run, is **kept**: a second copy would be the file the package rewrote, not the original):

- it installs the package `sysbox-ce 0.7.1` (the version of the golden snapshot, checked against its SHA-256);
- the package **rewrites `/etc/docker/daemon.json`** (a copy is kept next to it first): the `sysbox-runc` runtime, `bip` 172.20.0.1/16 and
  `default-address-pools` 172.25.0.0/16, so the network ranges of your other containers can change;
- it **restarts Docker** when no container is running (so none may be: the step refuses otherwise, stop the runner first);
- it needs `jq` and `systemctl`, runs `sysbox-mgr` and `sysbox-fs` as services, and is officially supported on Ubuntu 22.04 and 24.04
  (26.04 was tested, not supported; see "Spikes R0");
- what you get is the capability `agent-docker`: the agent may run its own Docker. Without Sysbox the runner works and the agent has none.

Restart the service afterwards so that the runtime `auto` finds Sysbox.

What the script cannot know: whether a real systemd and a real daemon behave as its tests assume. The first install on a machine is the
test of that; `factory-runner selftest` is the proof of the base (below).

### Install from source (developer, one machine)

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
| `selftest [--json] [--with-claude-code]` | Proves the base (below). On a device with a Claude Code login it also looks at Claude Code (no model call); with `--with-claude-code`, by hand, it runs one tiny real turn on that login (a few cents of your subscription, see "Claude Code with your subscription"). Exit code 0 when it holds, 5 when it does not. Needs no registration. It only looks: it pulls and names no image, so a missing or not pinned agent image is reported as not ready (a starting `run` pulls it). It may run beside a service; its throwaway container is one more on the daemon for the seconds it takes. |
| `config show`                  | The configuration as the runner sees it (file and environment), the credential only as `set` / `not set`.                                  |
| `config set [--name N] [--labels a,b] [--cpus N\|none] [--memory-mb N\|none] [--disk-gb N\|none] [--parallel N] [--runtime R] [--agent-image I\|none] [--auto-update on\|off]` | Changes the file **on the device** (labels, limits, parallelism, name, runtime, image, automatic updates). Every value goes through the check of `register`; one wrong value changes nothing. `none` removes a limit. The credential and everything not named stay as they are, and the environment is never written into the file; when a variable overrides a setting that was changed, it says so. A running service reads the file when it starts: restart it after its job. `--parallel` accepts 1: this runner takes one job at a time. |
| `credential show`              | `credential: set (from the file)` or `not set`, and how old it is. Never the value.                                                         |
| `credential renew`             | Asks the app for a new credential and saves it **before** anything uses it (the app keeps the old one valid until the new one was used once, so a failed write loses nothing). Not for a credential from the environment. Exit code 4 when the runner was revoked. |
| `update [--rollback]`          | Fetches the newest release, **verifies it** and stages it (see "Updates"). Never touches a running job. `--rollback` points `current` back at the image before the last update **and remembers the release it left**: no update, by the service or by this command, takes that release or an older one again until a higher one is announced. |

**Exit codes** (the same list is in `factory_runner/base.py`):

| Code | Meaning                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done. In `run --once` also: **no job came** within the wait (the app answered; nothing was waiting for these labels)                            |
| 1    | A job failed or was lost; a runner that cannot clean the machine in `run --once`; `register` was refused or the app could not be reached       |
| 2    | Usage (a wrong argument, no token for `register`)                                                                                               |
| 3    | The app requires a newer base (`426`)                                                                                                           |
| 4    | Revoked: the app does not know the credential any more                                                                                          |
| 5    | Not ready: the self-test failed (the failed check says why). The service waits five minutes before it ends with it, so the unit's restart does not run the self-test every ten seconds; `run --once` ends at once |
| 6    | Configuration: a value is missing or wrong; a file with a credential and no `runnerId` (`register --force`, or add the runnerId); a runner with no identity |
| 7    | `run --once` only: **the app never answered a claim** during the whole wait. Not the same as 0: the runner does not know whether a job waited. An app that answered once and was lost later is "no job", exit 0 |
| 8    | `register` only: the app registered the runner, but its credential could not be saved (revoke the runner in the app and register again)        |
| 9    | Another factory-runner uses this Docker daemon (see "One runner per daemon"); the log names the first container or network found; the runner announced nothing and claimed nothing |
| 10   | The service switched to an updated image between two jobs and ended so that its supervisor (systemd, `Restart=always`) starts it again from `factory-runner:current` (see "Updates") |

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
| `FACTORY_RUNNER_AUTO_UPDATE`             | `1` (default) or `0`: the service updates itself between jobs (see "Updates"); `factory-runner update` works either way |
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

**Claude Code in the self-test** (#856, `factory_runner/claude_code_selftest.py`). A device that has a Claude Code login gets more lines after
the base; a device with none gets none. They are a capability like `agent-docker`: a failing one is said and never costs the base (the names
start with `claude-code`, and `base_ok` and the exit code leave them out).

- **By default, readiness only, no model call, no cost:** `claude-code-login` (the token file or variable is usable; the value is never
  printed), `claude-code-layer` (the layer with the pinned version is on the daemon; it says whether it was checked against the pinned
  digests or is a version the device chose), `claude-code-version` (`claude --version` as the unprivileged user in a throwaway container made
  from the layer: no network, no volume, no login in it, removed afterwards; it must report the version the layer was built for).
- **`selftest --with-claude-code`, by hand only:** after readiness, one **real turn** with the device's real login, in the container and behind
  the network door of a job (the forced rule: `api.anthropic.com`, port 443), with the prompt "Reply with the single word: ok", the model
  alias `haiku` and a budget of $0.25. It is a real call to Anthropic: it costs a few cents of the user's subscription (the line prints the
  estimate at API prices, "through your subscription") and bills nothing. A failure is the exit code 5 then (by default a Claude Code line
  that fails is only said). Nothing automated runs it: the service loop and the tests never do (the tests use doubles for the door and the
  container and a scripted `stream-json`).
- The line `claude-code: ready; no model was called (...)` says which depth ran.

### Limits

Enforced through the host's Docker (`limits.py`, `disk_budget.py`):

| Limit                | Setting                  | What is enforced                                                                                                                                                                                                                         |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory               | `memoryMb`               | `Memory` = `MemorySwap` of the **agent's container and of the setup container** (#855; below 1024 MB the runner is not ready). The default is 60% of the machine up to 16 GiB.                                                              |
| CPUs                 | `cpus`                   | `NanoCpus` of the **agent's container and of the setup container** (#855: the container that runs the environment's script is as free as the agent, so it had no business being the one that ran without a limit).                            |
| Jobs at a time       | `parallelRuns`           | One. A second would collide on the fixed names and the fixed model network (R3 or later).                                                                                                                                                |
| **Disk**             | `diskGb`                 | A **budget per job**, below.                                                                                                                                                                                                             |

**The disk budget** (#855). `diskGb` is what one job may hold on the machine's disk. While a job runs (every 20 seconds) the runner measures
what the job made: the folders of the turn in `/work` (`reserve`, `repo`, `result`, by the allocated blocks of their files, a file with
several links once, links not followed), the **writable layer of every container of this runner** (the agent's, the setup container's, the
door's: this is where what an agent writes into its container, its session files among it, is), and what the setup container's result added
to the agent image: the image it is committed as (`code-reviewer-agent:environment`) **minus the size of the agent image** it was made
from (the base image is the runner's, shared, and there before the job), and **once**: as soon as that image exists, the setup container's
own writable layer is not counted any more, because it is what the commit wrote into the image. The Docker images of the runner itself and
the images and containers of other things on the daemon are not the job's and not counted. When the measure passes the budget:

1. the job process is ended the way a shutdown ends it (`JobHost`, the `guard`), and the job is **reported as failed**, not given back (it
   would fill the disk again): error code `runner_error`, error reason `disk_budget_exceeded`, and a text that names the budget and what
   was in use;
2. the cleaning that follows every job removes everything it made: the containers and networks of this runner, the folders of `/work`
   and the environment image (the name `code-reviewer-agent:environment`, so the daemon frees its layers). A hosted VM loses all of this
   with the VM; a machine would keep it, and without this step a run of jobs that commit an environment image would fill the disk.

**The budget is an emergency brake, not a quota.** The measure is taken every 20 seconds, so a job can write more than the budget
between two looks (the job is ended at the next one, and what it wrote is removed); and some things are **not measured**: what a job's
Docker inside **Sysbox** writes (the inner Docker's images and containers live under `/var/lib/sysbox` on the host, which is not walked and
which the daemon's size figure for the outer container does not include), **container logs** (the unit rotates its own; the logs of the
job's containers are not counted), and anything outside the folders and layers above. The budget stops a job that fills the disk; it does not
promise that a job stays below the number, and it is no replacement for keeping free space on the machine.

Without `diskGb` there is no budget and the machine's disk is the limit; the app still shows the free space of `/work` as the disk of the
runner. Choose the budget for the largest job you accept, and keep the rest of the machine's disk free for the images of the runner
(`docker system df` shows them). A measure that fails (a daemon that does not answer) counts for nothing and never ends a job.

What is **still not limited** (a follow-up): the CPU of the model door, the reader, the rule helpers and the runner's own git processes (they
have a memory limit and are small and short), and more than one run at a time.

### Updates (R2)

A runner updates itself between jobs, or on the device (`factory-runner update`); **never from the app** (decision 9). The app may require a
minimum base version: a runner below it gets no job, says "update needed" (claim answer `426`) and, if it can, updates at once.

**Where the release comes from, and what proves it.** A release is announced by a small **manifest** `{"repository": "...", "digest":
"sha256:...", "release": N}` and a **detached signature** over exactly its bytes (ECDSA over P-256 with SHA-256, DER). Where they are
and the public key are the **release channel**, [`runner/release-channel.json`](../runner/release-channel.json):

```json
{ "version": 1, "repository": "", "manifestUrl": "", "signatureUrl": "", "publicKey": "" }
```

`publicKey` is the base64 of the DER of the SubjectPublicKeyInfo. The file is **copied into the runner image**
(`/opt/code-reviewer/release-channel.json`), so a setting on the device cannot redirect an update; the installer reads the same file from
the repository. **No extra program is needed to check it**: the runner uses the `cryptography` library it already has, the installer
`openssl`. **It is empty in this repository.** A runner with an empty channel does not look for updates (it says so once),
`factory-runner update` says "no release channel" (exit code 1), and the installer stops with "no runner image is published yet".

**What is checked** (`factory_runner/update.py`; the installer does the same steps with `openssl`):

1. the manifest and the signature are fetched (https only, at most 64 KiB) and the signature must verify with the channel's key, which
   must be an ECDSA P-256 key; the manifest must name the channel's repository, a `sha256:` digest and a release number of 1 or more;
2. the release number must be **higher** than the running one's (the label `code-reviewer.runner.release` of the running image) **and
   higher than the release a rollback left** (below): a signed older manifest that somebody serves again is no way back, and nothing is
   pulled for it;
3. only then is the image pulled **by the digest the manifest names** (the daemon checks the content against it); its label must carry the
   manifest's release number, otherwise it is removed again and nothing changes;
4. the digest is named `factory-runner:current` (the one before it `factory-runner:previous`, for `update --rollback`).

After a switch the service removes the **digest references** of the releases before `current` and `previous` (each pull by digest leaves
one, and while it stays the daemon cannot free the old image); `--uninstall` removes the images by name and by their digest references.

**Between jobs.** The unit starts the container from `factory-runner:current` and restarts it when it ends. The service looks for a release
ten minutes after its start and then every six hours, **only between two jobs**; and when the image behind `current` is another one than the
one the container runs (staged by the service or by `factory-runner update`), it ends with exit code **10** before its next claim and the unit
starts it again from the new image. A job that is running is never touched. Both only apply when the unit says so
(`FACTORY_RUNNER_IMAGE_TAG`): a runner somebody started by hand with `docker run` never ends itself for an update, and `run --once` never
updates. `factory-runner config set --auto-update off` stops the looking by itself; an update the app requires is looked for anyway.

**On the device.** `factory-runner update` stages the newest verified release and says so; the service switches to it after the job it is
running. `factory-runner update --rollback` and a restart of the service go back one release, and the rollback **writes the release it
left into the file `rejected-release` of the configuration volume**. From then on neither the service (every six hours) nor `factory-runner
update` nor the installer takes that release or an older one again; the first release **above** it is taken as usual. (Without that, the
service would take the same release back ten minutes after the operator had rolled it back.) The command says so; a rollback whose memory
cannot be written changes nothing.

**A new image that does not run: the way back by hand.** A new image that does not pass its own self-test is not ready (exit code 5): the
service waits five minutes, ends, and the unit starts it again, so a bad update is tried every few minutes, not every ten seconds, and takes
no job. To go back when `factory-runner update --rollback` is not possible (the new image does not start at all):

```sh
docker tag factory-runner:previous factory-runner:current && sudo systemctl restart factory-runner
```

Then write the bad release into `rejected-release` so that the service does not take it again (the file holds the number and a newline):
`docker run --rm --entrypoint sh -v factory-runner-home:/var/lib/factory-runner factory-runner:current -c 'echo N > /var/lib/factory-runner/rejected-release'`. Do not leave this to `factory-runner update --rollback`
after the handmade tag: `current` and `previous` then both are the old release, so the rollback would remember that one and not the bad one.
Deleting the file lifts the block; a higher release than the one in the file is taken anyway. **There is no automatic watchdog** that rolls back a new image that exits with an error within
a few minutes: a check that works when the new image cannot even start has to live outside the image (a host-side script in the unit), which
is more than this step; it is a follow-up (see "Known limits").

**What is not in this repository, for the owner.** The release pipeline: nothing publishes a runner image today, and the tests of the images
pipeline hold that no workflow logs in to a registry, pushes an image or asks for `packages: write` (#677: the source is visible but not
licensed, and a public image would let anybody run the service; publishing the runner image would also hand the Worker image's copyleft
packages to customers, which `THIRD_PARTY_LICENSES.md`, "Copyleft and distribution", says must be reviewed first). So, **until the owner
decides to publish and adds such a pipeline, no runner can install or update itself from a release**; the code, the installer and the tests
are ready for it. The pipeline has to make, from `main` or by a manual dispatch and never in a run a pull request starts:

1. the agent image and the runner image (`runner/Dockerfile.factory-runner` on the Worker image, with `AGENT_IMAGE_REF` the agent image's
   **digest** and `RUNNER_RELEASE` a number that grows with every release, for instance the run number), pushed to a registry the customers can
   pull from without a login;
2. the manifest, signed with a key that only the pipeline holds:

   ```sh
   openssl ecparam -genkey -name prime256v1 -noout -out release-key.pem          # once; keep it secret
   openssl pkey -in release-key.pem -pubout -outform DER | base64 -w0            # the publicKey of the channel
   printf '{"repository": "REGISTRY/IMAGE", "digest": "sha256:...", "release": N}' > manifest.json
   openssl dgst -sha256 -sign release-key.pem -out manifest.sig manifest.json     # DER, what the runner reads
   ```

3. the manifest and the signature at the two addresses the channel names (a GitHub release asset or a static address will do), moved **last**,
   after the image is pushed and its label was checked;
4. the channel file filled in this repository (`repository`, `manifestUrl`, `signatureUrl`, `publicKey`): a change of the key is a change of
   this file and a new image.

The signing key is the one new secret this needs. Losing it stops updates (a runner keeps working); leaking it lets whoever holds it
announce an image, so keep it where the other release secrets are. The tests sign with a throwaway key (`tests/unit/release_support.py`).

### Uninstall

`sudo sh install.sh --uninstall` (see "Install"), then revoke the runner in the app. By hand: `systemctl disable --now factory-runner`, remove
the unit and `/usr/local/bin/factory-runner`, `docker rm -f factory-runner`, `docker rmi factory-runner:current factory-runner:previous` (and the digest references, `docker images --digests`),
and with the configuration and the work volume gone, `docker volume rm factory-runner-home factory-runner-work`. The firewall tables of
the security notes (`nft delete table ip setup_egress`, and so on) go with the next restart of the machine.

### Tests

Unit (`tests/unit/test_factory_runner_*.py`, `test_runner_profile.py`, `test_install_script.py`): configuration, command, loop with doubles, once mode, self-test
with a double daemon (also: a stale agent image), limits, the cleaning between jobs (two turns in a row over the service, with the
code of a turn's own directory set-up), the credential's source and the Dockerfile's promises. Contract (`tests/contract/test_factory_runner_contract.py`): the runner's real client against
a fake App (`tests/runner_app.py`) that holds every body to `runner-registration.v1.json` and `runner-api.v1.json`. Integration
(`tests/integration/test_factory_runner_loopback.py`): register, announce, claim, run a turn through the real job host with a
stand-in job process, heartbeat, report; no job in time; the once mode with the environment alone; a revoked runner (before a claim
and during a turn); an app that requires an update. Lane (`tests/lane/test_runner_selftest.py`): the self-test on a real
daemon with the real agent image, and the removal of what a killed run left (a labelled container and network; an unlabelled container
stays), and the disk budget (`tests/lane/test_runner_disk_budget.py`: what a container writes into its layer is
measured, a budget that is passed is noticed, the tidy frees the layer and the environment image). The whole turn with a model and a
repository is the Implementer's lane (`test_implementer_turn.py`), whose code the runner runs unchanged.

R2 (#855): `tests/unit/test_factory_runner_manage.py` (`config set`, `credential`, `update`, the proof), `test_factory_runner_disk_budget.py`
(the measure, the guard, the host ending a job), the update cases in `test_factory_runner_service.py` (switch between jobs only, never during
one, never in `--once`, update needed looks at once), and `test_install_script.py`, which runs `install.sh` against stand-ins for `docker`,
`systemctl` and `curl` in a directory that plays the root of the machine, with the real `openssl` checking a manifest that `cryptography` signed: the verified digest, the unit, the token only on
standard input, idempotence, no restart of a running service, a signature that does not verify, the dry run, the Sysbox warnings and its
refusal without a terminal, uninstall, and that the installer, `update.py`, the Dockerfile and the golden snapshot agree on the channel file and
the versions. CI also runs `shellcheck` on the installer. **No test starts a real systemd unit or installs a package:**
nothing runs on a machine of ours; the first install on a real machine is the test of that.

Fix round 1 of the review of R2 added: a rollback that survives the auto-updater (`test_factory_runner_manage.py`, and the service test
that runs the policy after a rollback), a script that is cut off anywhere and one that runs from its standard input
(`test_install_script.py`, with a stand-in that consumes the standard input and a pseudo-terminal for the prompts), the installer that
never goes back, the disk budget with a big base image under a small commit (`test_factory_runner_disk_budget.py`, lane L02 against the
size the commit really added), and the event loop that stays free while a call waits for the one before it.

### First install on a real host (the live test)

What the tests cannot know and the first install must check (nothing of this runs in CI):

1. **The image store.** With Docker's **containerd image store** (`docker info` lists `io.containerd.snapshotter.v1` as the storage driver
   status) the id of the image a container reports and the id of the tag may differ. The service compares them
   (`docker inspect <container> --format '{{.Image}}'` against `docker image inspect factory-runner:current --format '{{.Id}}'`): if
   they differ for a freshly started service, it ends with exit code 10 at its first look, again and again. Check that the two are **equal**
   after the first start; if not, the comparison has to use the image's digest instead and this is a bug to fix before the next runner.
2. **The size figures** under that store: `docker image inspect --format '{{.Size}}'` of the agent image and of an image committed from it
   (the lane test L02 asserts that the difference is what the commit added) and `SizeRw` of a container (lane test L01).
3. **A real update and rollback:** publish two releases, let the service switch, `factory-runner update --rollback`, restart, and wait
   past the first look (ten minutes): `current` must stay on the earlier release; announce a third and watch it taken.
4. **A new image that does not run** (for instance an image whose self-test fails): the service must retry every few minutes, not every
   ten seconds (`journalctl -u factory-runner`), and `docker tag factory-runner:previous factory-runner:current && systemctl restart
   factory-runner` must bring the runner back.
5. **The installer on a terminal:** `curl ... | sudo sh` asks for the token with the input hidden; with `--sysbox` the question comes before
   anything is pulled, "no" continues, and `daemon.json.factory-runner-backup` exists after "yes".

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
  restarts (a follow-up of R2). (The tables of the model door and the network door, `door_egress` and `netdoor_egress`,
  live in the door container's own network namespace and go with the container.) Removing the host tables with the leftovers of a
  job is a follow-up.

### Known limits

- **No watchdog for a bad update.** A new image that fails is tried again every few minutes and the operator rolls back by hand (see
  "Updates"); rolling back by itself and rejecting the release when the new image ends with an error within N minutes is a follow-up.
- **The manifest has no expiry (freeze attack).** The signature proves that a manifest is ours, not that it is the newest: whoever controls the
  address can keep serving an older signed manifest (a runner never goes below the running release, so this only *freezes* it, and the
  app's minimum base version still forces an update where it matters). A signed `expires` date in the manifest, checked by the runner and the
  installer, would close it; it is a follow-up.
- **Rotating the release key** is a new `release-channel.json` in a new image: a runner that runs an image with the old key cannot
  verify a manifest signed with the new one, and so does not update. Plan a release signed with the old key that carries the new channel
  file before the old key is retired.
- **The disk budget is an emergency brake** (measured every 20 seconds; not the inner Docker of Sysbox, not container logs; see "Limits").
- **One runner per Docker daemon.** The containers have fixed names (`code-reviewer-agent` ...) and the model network a fixed address, so a
  second runner on the same daemon would fail every turn with a 409. Every container and network a runner's job creates carries
  `code-reviewer.runner=<runnerId>` (a runner without an id from the file, one with a credential from the environment, uses a digest of
  the credential), so a runner removes only its own and refuses to start beside another (exit 9). **The operator must run one runner per
  daemon.** Another runner is recognised only while it has a container or a network on the daemon, or holds the lock; two runners with the
  same id (one configuration copied to two machines on one daemon) are not told apart. The lock closes the window of two different runners
  that start in the same moment. Unique names, and with them more runners on one daemon, are a later step. The hosted version sets no id and is
  unchanged.
- **Snapshot and stored session.** Resume works on customer runners (#879, "Resume on customer runners"): the runner sends `PUT .../session` and `GET .../resume-session` to the runner API's routes when
  the app lists `runner_session_snapshot`. Against an app that does not list it (an older release) a turn on a runner takes **no snapshot** and a follow-up turn continues from the summary of the earlier ones
  (the fallback of the plan).
- **SIGTERM during the self-test** (N4) comes before the signal handlers are installed and ends the process at once; nothing is claimed.
- **No warning for a `config.json` that is too open** (N5): the file is written 0600 in a 0700 folder, but a mode changed later is not noticed.
- **`proven` under `runc`** (N6): the name of the sandbox proof says only that the self-test passed; under `runc` there is no Sysbox wall (see the security notes).
- **No proxy for the app client** (N7): the runner talks to the app directly (`HTTPS_PROXY` is not read). The release documents of an update
  (manifest, signature) are fetched through the proxy of the environment (`https_proxy`, `no_proxy`) as the installer's `curl` does; the pull of
  the image is the daemon's, with the daemon's own proxy settings.
- **`register --force`** (N8) replaces the local file and leaves the old runner in the app's list: revoke it there.
- **The credential file** is as safe as the machine: whoever reads it is the runner. Revoke the runner in the app if the machine is lost.
- **The page's command** shows `factory-runner register --token ...` without an address; the command goes to `https://code-review.com`.
  `--url` is for another app.

## Claude Code with your subscription

This is for the person who runs a runner and wants jobs of the harness **Claude Code** to use **their own Claude subscription**. The technical
parts are in "Claude Code, R3" below.

### What runs where

- **On your device:** the runner, Docker, and for each job a container with Claude Code in it. Claude Code is **Anthropic's program, unmodified**.
  We do not ship it: the first start of the runner builds a layer on your agent image that installs the pinned version (2.1.311) from the npm
  registry and accepts it only with the SHA-512 digests pinned in the runner, for both the npm package and the platform program (linux x64 and
  arm64). The model traffic goes **from your device straight to `api.anthropic.com`**, on your subscription. It does not pass through our servers.
- **At code-review.com:** the job (which repository and branch, the instruction, the profile), the live view of the steps, the result, the usage
  numbers and the cost estimate. The app learns that your runner has Claude Code ready (a word in the runner's manifest); it never learns the
  login.
- **Your login** is a token you make with `claude setup-token` and keep on the device: in a file `claude-code-token` in the runner's home
  (`$FACTORY_RUNNER_HOME`), or the file named by `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`, or in `CLAUDE_CODE_OAUTH_TOKEN` of the runner's
  environment. A file must be a plain file (no link) that only its owner can read (mode 0600). The token **is never stored in our app or
  database, never sent to the app and never written to a log** (the runner's log masks it). It is handed to Claude Code's process in the job's
  container for the length of the job, and to nothing else.
- Set it up, then look: `factory-runner selftest` shows the login, the layer and the version without calling a model;
  `factory-runner selftest --with-claude-code` runs one tiny real turn on your subscription (a few cents) so that you know the login works.

### What the guards do, and what they do not

The agent is **free inside its container** (no list of allowed tools): it can read files, run commands and edit the repository. Claude Code
needs the token in its environment, so **the agent's own commands can read the token**. We do not pretend otherwise. The guards are at the exits:

| Guard | What it does | What it does not do |
| ----- | ------------ | ------------------- |
| Network rule | The container's only way out is a door that lets through `api.anthropic.com` on port 443 and nothing else (no other host, no IP address, not port 80). An environment that allows more refuses the job. | It cannot tell what is said to Anthropic. |
| Push guard | Before a branch is pushed, the runner reads what it adds (files, names, commit messages, the branch name) for the token and its plain, URL-quoted and base64 forms. A branch with a hit is not pushed; one it could not read to the end is not pushed either. | **It is a net, not a wall.** It does not find a token that was hex-encoded, compressed (gzip, tar, zip), rot13, reversed or split over several lines or files. An agent that is told to hide the token can. |
| Redaction | The token and the job's other secrets are taken out of the step records, the answer text and the report before they leave the runner. | The same limit: exact forms only. |
| Container | No new privileges, an unprivileged user, memory and CPU limits, a budget per message (`--max-budget-usd`) and the job's clock. | A budget is checked when a message ends: it is a brake, not an exact limit. |

Treat the token like any key on that machine: the runner's host should be one you trust, repositories you let it work on are repositories you
let an agent act on, and a revoked or rotated token (`claude setup-token` again) ends the exposure. If you suspect a leak, revoke the token at Anthropic.

### What it costs

Claude Code reports a price at API list prices for each turn. The app shows it as **"≈ $0.42 through a subscription"** (or "no estimate,
through a subscription" when Claude Code could not price every model): an estimate, **never billed by us, never added to a total** of
the usage. A workflow's budget counts the estimate (so a run can still stop at its limit). What the subscription itself costs, and its usage
limits, are between you and Anthropic: when the subscription's limit is reached the job ends with `llm_quota`. The minutes of a run on your
runner are counted as for any other run today; whether runs on your own subscription and device should be free of them is not decided,
and this page will say when it is.

### Anthropic's terms

Using Claude Code with your subscription is subject to **Anthropic's terms**, and they are yours to read and keep: the **Consumer Terms of
Service** (for Free, Pro and Max accounts, https://www.anthropic.com/legal/consumer-terms), the **Commercial Terms of Service** (for Team,
Enterprise and API use, https://www.anthropic.com/legal/commercial-terms), the **Usage Policy** (https://www.anthropic.com/legal/aup) and
Claude Code's own "Legal and compliance" page in Anthropic's documentation. They decide, among other things, what you may do with a
subscription token and how automated use is counted. **We do not claim that Anthropic has approved unattended or automated runs on a
subscription**; that question is open with Anthropic, and until it is answered you use your subscription this way on your own responsibility.
Use of your own credentials on your own device is the design (we never hold or resell a login), but it does not replace reading the terms.

## Claude Code, R3 (#856)

R3 adds Claude Code as a harness that a runner announces when its device has a login for it. **The first slice was the adapter core**:
the pieces that start Claude Code headless in the agent's container, read what it prints and announce it. **The second slice wires it
into a job** (section "Wiring into a job"): a profile names the harness, the claim routes by it, the runner runs it on the device's
login behind the gates; "What is left" says what remains.
The code is [`runner/src/code_reviewer_runner/implementer/claude_code/`](../runner/src/code_reviewer_runner/implementer/claude_code).

### Rules it keeps (owner, 2026-11-05)

- Claude Code is used **unmodified, with each user's own credentials, on the customer's device** (our runner). No resale. The login is
  a token the customer makes with `claude setup-token`; it is **never stored in our app or its database, never sent to the app, never
  logged**, and there is no Claude login in our app. The operator key never goes to a runner.
- **The agent is free inside the sandbox**: `--permission-mode bypassPermissions`, no `--allowedTools` (a closed list of tools). Only
  money, key and exits are guarded.
- **Not as root, and not on `IS_SANDBOX=1`.** Bypass mode refuses to run as root unless `IS_SANDBOX=1`, which Anthropic does not
  document; it is not relied on. Claude Code runs as the unprivileged user `agent` (uid 10201) of the install layer; root stays for the
  set-up (the runner hands `/work/repo` and `/work/result` to that user before the first turn). What the agent loses against the hosted
  OpenCode agent (root, `apt`) is the price of this rule; the reader that takes the repository after the turn already copes with files
  of another uid (`reader.py`).
- **Cost** of a subscription turn is an estimate: Claude Code's `total_cost_usd` is the list price of the usage, and the adapter takes
  it only when Claude Code priced **every** model of the turn from its list (`costBasis: list`); otherwise it is unknown, never a number.
  The display is "≈ <amount> through a subscription", never billed, never added to our totals. The app books it for the budget of a
  workflow run (below, "Cost").

### The parts

| Part | File | What it does |
| ---- | ---- | ------------ |
| Events | `events.py` | `LineSplitter` (whole JSON lines out of chunks, bounded), `ClaudeEvents` (each `stream-json` event becomes the engine-shaped event the unchanged `StepConverter` reads, so the bounds, the redaction and "a tool's output is never recorded" stay where they are: a failing tool is recorded as the word `failed`, only the finish tool's refusal keeps its text; a finished tool, message and block is forgotten), `parse_result` (the `result` event: how the turn ended, the text, the session, the estimate: only a finite, non-negative, list-priced figure, otherwise unknown). Failures are told from structured fields only (`errors`, `subtype`, the `error` of the assistant message, `api_error_status`), never from the text of a result. |
| Command | `command.py` | `claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions --setting-sources user --strict-mcp-config [--model m] (--session-id id \| --resume id) [--max-budget-usd n] [--append-system-prompt text] [--mcp-config json]`. The prompt is the standard input, the login is in the environment, never in the argument list. `--setting-sources user` and `--strict-mcp-config` keep the repository's settings (hooks, permissions) and `.mcp.json` out: what the repository holds is data. `ENABLE_TOOL_SEARCH=false` puts the finish tool's schema in the first request; telemetry, updates and error reports are off. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is **not** set: it exists in 2.1.311 but forces the permission mode to `default` and wants bubblewrap (see "What is left", 7). |
| Login | `login.py` | The token from `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`, else `claude-code-token` in the runner's home, else `CLAUDE_CODE_OAUTH_TOKEN` in the runner's environment. A file must be a plain file, not a link, readable only by its owner (0600), one token on one line. A problem is described in words, never with the value. |
| Layer | `layer.py` | The install layer, **built on the device** on top of the agent image through the Engine API (`DockerApi.build_image`) and cached under `code-reviewer-agent-claude-code:<version>-sha512-<digest prefix>-<base id>` (verified) or `...:<version>-unverified-<base id>`; the tag **and** the labels (`com.code-reviewer.claude-code`, `.integrity`) say which, and `find_layer` compares both, so an unverified layer is never taken for the pinned one. The pinned version (2.1.311, the npm `stable` of the R0 spike): its **npm package, which is only a stub**, and the **platform package that holds the program** (`@anthropic-ai/claude-code-linux-x64` or `-arm64`, the glibc builds; the agent image is Debian) are each fetched as a tarball by `npm pack` and **accepted only with their own pinned SHA-512** (`CLAUDE_CODE_INTEGRITY`, `PLATFORM_INTEGRITY`), checked with `sha512sum -c` under `set -e` so a changed digest fails the build; then both are installed from the two files with `npm install --offline`, so npm resolves nothing from the registry on its own. The architecture is the one of the daemon's machine (`uname -m`); a machine of another architecture or libc has no pinned program and cannot build the pinned layer. The layer's labels carry a fingerprint of the platform digests (`com.code-reviewer.claude-code.platform`) and the tag a short form of it, so a layer built when only the stub was pinned is not taken for the pinned one and is built again. The program must report the version, and the user `agent` is made. The device may choose another exact version (`FACTORY_RUNNER_CLAUDE_CODE_VERSION`; no digest to compare then, for neither package; the pinned version named there keeps its digest checks). We never publish or ship Claude Code. |
| Agent | `agent.py` | `ClaudeCodeAgent`: the surface of `ImplementerAgent` (`start`, `turn`, `stop`, `steps`, `session_id`, `resume`, `step_notes`) for a process-per-message engine. A turn is `claude -p` as an exec in the agent's container (`AgentContainer.run_streaming`), the lines go to the step feeder as they come, the end is the `result` event. A second message is `--resume <id>` in the same container. An empty session volume ("No conversation found", said in `errors`, with no model call) starts a fresh session under the same id and reports `summary_only`. Failures: budget exhausted = `cost_limit_reached`, no login or an expired or revoked token (the `authentication_failed` error, status 401) = `llm_auth`, the subscription's usage limit (`rate_limit`, `billing_error`, status 429 or 402) = `llm_quota`, no result = `implementer_engine_unavailable` with the exit code. |
| Finish tool | `agent.py`, `result_channel.py` | The same stdio shim as OpenCode's (`factory-submit mcp`), written into the container with the schema, named to Claude Code as the MCP server `finish` (tool `mcp__finish__submit_result`). The server validates; Claude Code does not. |
| Manifest | `readiness.py`, `factory_runner/prepare.py` | `claude-code` is announced when the device has a login for it: `ready: true` when the token is usable and the layer is on the daemon (a start builds a missing one, the `selftest` command only looks), `ready: false` with a note in the log when not. A device with no login says nothing. It is added beside OpenCode, never instead, and only on a machine whose base holds. |

### Verified

- **Unit** (`tests/unit/test_claude_code_*.py`, `test_docker_api_build.py`, the streamed-command cases of `test_agent_container.py`):
  every rule above, with doubles for the container and the daemon.
- **Engine** (`tests/engine/test_engine_claude_code.py`, in the engine suite, no network): the **real, pinned Claude Code** started
  with the adapter's own command line and environment against the strict fake provider of `fakes/wire` behind a made-up key. A turn
  with a thought, a read, a command and a closing text, whose events make the records of the live view and whose result is priced; the
  finish tool through Claude Code's real MCP client (a wrong result refused with its reason, a right one accepted, the first request
  carries the schema); a second message that resumes the session and sends the whole history; a session that does not exist; no
  login; a budget that ends the turn; the finding that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the default permission mode (so it is not set); and a repository whose `.claude/settings.json` hook and `.mcp.json` server **do not run** (with
  a control that shows they do under the other setting sources). `scripts/fetch_claude_code.py` installs the pinned version with npm
  and accepts the npm stub and the platform program tarball of the host (linux x64 or arm64, glibc) only with their pinned digests, installs them from the files with `--offline`, and reuses a cached install only with both verified tarballs kept beside it (another host is refused); CI caches it. The engine tests were run locally against Claude Code 2.1.304 and
  against the pinned 2.1.311; the first run against the real program found that "No conversation found" is in `errors`, not in
  `result`, and that a device that is not logged in answers `subtype: success` with `is_error: true`.
- **Not run here** (this host has no Docker daemon): building the layer, a turn inside the container as the user `agent`, the ownership
  of what that user writes into the repository volume, and a run under Sysbox. They need the Docker lane.

### Wiring into a job (second slice of #856)

A profile version can name the harness `claude-code`; a turn started with it is run by a runner that announces the harness as **ready**,
on the login of that runner's device. Everything below is tested at the lowest level that can prove it; what only a Docker daemon can
show is the lane (CI).

**The harness on the profile.** `profile_versions.harness` and `implementer_turns.profile_harness` (migration `20261105210000`, expand
only, null reads as `opencode`). The model of such a profile is `{"provider": "claude-code", "model": "<name Claude Code reads>"}` (for
example `sonnet`, `claude-sonnet-5-5`): no catalog entry, no key of the workspace and no price stand behind it, so the model check of
the catalog is skipped and the provider name `claude-code` is refused on any other harness. Starting a task with such a profile in an
environment that is not a runner's is refused before anything is written (`IMPLEMENTER_HARNESS_NEEDS_RUNNER`, 422); the workflow check
`harness_needs_runner` says the same for a workflow.

**Routing.** The claim of a customer's runner takes a turn only when the harness of its profile is one of the harnesses the runner
announced as ready (`jobs-claim.ts`: `coalesce(profile_harness, 'opencode') = any(harnesses)`); the Dispatcher's and the shared token's
claim never take a turn on `claude-code`. A runner whose `claude-code` is not ready, or that does not announce it, leaves the turn
queued for one that does.

**The job.** A turn on `claude-code` is handed to the runner as a job without `llm`, without `implementer.cost` and without
`implementer.modelEntry`; it carries `implementer.subscription` (`{model?, maxBudgetUsd}`) and `implementer.profile.harness`
(`contracts/runner-api.v1.json`; the schema and the runner's parser refuse a job that mixes the two shapes). The app chooses no model,
reads no key and records no selection for it; `maxBudgetUsd` is the smaller of the profile's cost limit and the operator's maximum, in
dollars, and becomes `--max-budget-usd`: with no model door there is no ledger, so the budget and the job's clock are the only brakes.
Claude Code counts the flag per process and every message of a turn is another process (the instruction, the extra message for a dirty
tree, the reminder for a result), so the agent passes each message **what the earlier messages left** of the budget (the cap less their
estimate, `ClaudeCodeAgent._budget_left`); a spent budget sends no further message (the extra messages are skipped, the first one
cannot be). If an earlier message was not priced, the leftover is unknown and the turn sends one extra message at most (two messages
in all, each with the whole cap).
The login is never in a job: the job process reads it from the file the runner hands it by **path** (`FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`,
resolved from the runner's own configuration; a login that only the runner's environment holds is handed on in
`CLAUDE_CODE_OAUTH_TOKEN`, and the runner's log masks it).

**Cost.** The usage of such a turn has `costUsd: null`, `costBasis: "subscription"` and `estimatedCostUsd` (null when Claude Code did
not price every model): an estimate, never billed. A turn a member cancels reports the same (the job host keeps the usage the process
printed). The app keeps both fields (`parseUsage`); the AI price of the run is nothing (`costUsd` is null, so the run is settled as
"AI cost unknown": only the minutes, never the AI price). The budget of a workflow run counts the estimate at API prices (0 when there
is none) with the step cost basis `subscription` ("estimated, not billed" on the run page), not the cap with the basis `limit`; the
`costUsd` fact of the step is that estimate. A turn of the harness that left no usage at all (killed) is booked at 0 as well. The
estimate is never a charge and enters no total of billing.

**Gates** (the token is visible inside the agent's container; the decision of the lead, which the owner may revise, is to accept that
and to guard the exits):

| Gate | Where | What |
| ---- | ----- | ---- |
| Push guard | `implementer/push_guard.py`, `GitWorkspace._login_secret_in` | Before a branch is pushed the runner reads what it adds beyond where the turn started (`git rev-list --objects` and `git cat-file --batch` in the mirror: commits, trees with their names, blobs, and the name of the branch) for the token and its spellings (`redaction.secret_forms`: as it is, URL-quoted, and base64 and base64url, with and without padding, at each of the three alignments the token can have inside a larger base64 text). Found: the branch gets the reason `login_secret` and is not pushed; the task's branch ends the turn `push_rejected`. Not read to the end (too large, a failed git, a timeout): `unchecked`, not pushed (it fails closed). Bounds: 300 s per read, a 64 MiB object list, 4 GiB of content. **It is a net, not a wall**: it finds the token and the spellings above, in plain text. It does not find the token hex-encoded, compressed (gzip, tar, a packed or zipped file), rot13 or otherwise shifted, reversed, or split over several lines or files. An agent that is told to hide the login can; the guard stops the accident and the lazy case, and the decision to accept the login in the agent's environment (follow-up 5) stands on the network gate, the owner's own device and the owner's own subscription. **Time**: the final push keeps 40 % of its seconds for the guard (`GUARD_SHARE`: 10 of the 25 s of a stop, 40 of the 100 s of a normal end); the fetch of a branch, the question to the lease and the push stop before that slice, and what the guard does not use goes back to the push of the last branch. So a stop (a cancelled run, a stopped Worker) or a slow fetch cannot leave the guard a second and turn committed work into `unchecked`. |
| Redaction | `claude_code/agent.py`, `job_run.result_of` | The agent's `Redactor` knows the login: the step records, the turn's text and note are redacted in the agent; the job's secrets (the login included) are taken out of every text of the report (branch names, commit subjects, paths, the summary) and of the log line. Exact forms only for the facts of the report: a commit subject "fix authorization header" is not a secret. No snapshot export and no transcript volume exist for this harness yet (design: "Resume across containers"), so there is nothing else to scrub; the design redacts the transcript with the login too and scans it again before it is stored. |
| Network | `claude_code/gates.py`, `session._start_network`, `job_run.production_setup` | A subscription turn is forced onto the network door with the rule `list` and exactly `api.anthropic.com` (an exact name, no suffix). An environment that is `open`, or lists any other host, refuses the turn (`implementer_config_invalid`, detail starting `subscription_network_open` or `subscription_network_hosts`), free, before the container exists. The door dials ports 80 and 443 only (`netdoor/proxy.py`), and a listed host has both in every rule; **the entry of a subscription turn has 443 only**: the runner's `NetworkRule` has an optional `ports` (a subset of the door's two, a list only; empty = both), it travels in the door's start document (`parse_door_rule`) and not in the contract (a job's or an environment's rule is still exactly `mode` and `hosts`, so no app change), and the door refuses port 80 for it with `port_not_allowed` (CONNECT and plain HTTP alike). The door container's own firewall table still lets 80 and 443 out; the proxy is what narrows it, so the narrowing is the proxy's word, not the kernel's. The rule applies to all hosts of its list (the subscription rule has one). **The model network.** A turn on this harness has no model door, and the model door is what otherwise makes the model network that the network door and the agent's container join; the unit tests had always made the network by hand, so this path never ran against a daemon that did not have it. The network door now makes it when it is missing (`netdoor_launcher._ensure_network`, the same document and labels as the model door's, so the runner's sweep finds a leftover) and removes it with itself only when it made it; beside a model door nothing changes. Proven against the fake daemon (`test_netdoor_launcher.py`) and, on a real one, by the lane test `test_network_door_alone.py` (CI). |
| Readiness per job | `claude_code/readiness.ready_harness`, `job_run.run_implementer_job` | The manifest said ready at the start; the job looks again (the login file, the layer on the daemon; nothing is built). A device that cannot refuses the job (`implementer_engine_unavailable`, detail starting `harness_not_ready`) and never falls back to OpenCode. |
| No new privileges | `agent_container.agent_document(no_new_privileges=True)` | The container of the Claude Code agent is made with `no-new-privileges`; the hosted OpenCode agent is root and free and keeps its container as it was. |

**A limit.** A turn on `claude-code` cannot run in an environment with a setup script yet (`subscription_setup_script`): the layer is built on
the golden image, and the image a script leaves is not that. A runner environment has no script of the app's anyway (`copyEnvironment`
copies its labels only); the combination can only come from a hand-made job.

### What is left of R3 (follow-ups of #856)

1. **Resume across thrown-away containers** (designed, not built; see "Resume across containers: design" below). Until then a follow-up
   turn on this harness continues from the summary of the earlier turns (`summary_only`, reason `no_snapshot`). The adapter already
   resumes within a container and falls back to a fresh session when the volume is empty.
2. **Cost in the app** (done: the Runs page and the workflow run page say "≈ <amount> through a subscription", a subscription record is
   no unknown cost and no total; see "Cost in the app" below). Left: a per-workflow switch that lets a budget ignore the estimate. **Owner question**: should a subscription turn on a customer runner be
   free of infra minutes and of the balance check at claim? Today it is not (the minutes are billed as for every job and the claim checks
   the balance).
3. **The self-test for Claude Code** (done in the fourth slice, "Claude Code in the self-test" above: readiness by default, one real tiny
   turn only with `--with-claude-code`). Left: a canned Anthropic provider inside the container, so that "ready" could mean "ran a turn" without
   the user's login and without a cent, and a lane test that builds the layer and runs a turn as the user `agent` behind the door.
4. **Docs for customers, including Anthropic's terms** (done: "Claude Code with your subscription" above). **Open with the owner**: plan S3, the
   written question to Anthropic whether unattended runs with a subscription token are allowed; the docs say plainly that we do not claim they are.
5. **The login is in the environment of the agent's tools** (decided for now: accept it and guard the exits, above). Claude Code needs it
   there, and a command the agent runs (`env`) can print it; the output is not recorded in the step records, but it is in the agent's own
   session and in anything the agent writes. The switch that would scrub it, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (measured on 2.1.311 with
   the real program), **forces the permission mode to `default`** ("Declare allowedTools explicitly") and requires bubblewrap, so every
   tool waits for an approval in a headless run; it contradicts "the agent is free inside the sandbox" unless the owner accepts an
   explicit tool list (`--allowedTools`). Options for the owner: (a) an explicit, complete list of Claude Code's tools and the switch,
   with bubblewrap and a user namespace in the container (not available under default seccomp), (b) hand the token in through a file
   descriptor (`CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` exists in 2.1.311; not measured: whether the tools inherit the descriptor, and
   `docker exec` can only pass the standard streams), (c) what this PR does.
6. **Pin the platform tarball with its own digest** (done in the fourth slice: layer and `fetch_claude_code.py`; the musl builds and other systems are not pinned).
7. **Layer cleanup and a non-blocking build at start** (a start builds a missing layer synchronously; old layers stay on the daemon).
8. **A port in the network rule** (done in the fourth slice: `NetworkRule.ports`, 443 for the subscription rule; the app's environment rule has no ports). Left: a dedicated error code for
   the refusals above instead of `implementer_config_invalid` with a reason word.
9. **An environment with a setup script on this harness** (the layer on top of the image the script leaves).

### Cost in the app (#856, third slice)

A subscription turn reports `costUsd: null`, `costBasis: "subscription"` and `estimatedCostUsd` (null = Claude Code gave none).

- **Runs page** (Implementer run detail, also the admin portal's job view): the Cost row reads "≈ $0.42 through a subscription" with the line
  "Estimate at API prices, not billed", or "No estimate, through a subscription"; never "Not available". The figure is the job result's
  `usage.estimatedCostUsd` (`readStoredUsage`), kept only for the one basis the app knows.
- **Workflow run page**: a subscription step reads "Cost ≈ $0.42 through a subscription" ("no estimate, through a subscription" for a
  booked 0). A cost basis a version does not know (a value a newer release wrote, read after a rollback) shows the neutral label
  "basis not known" with the figure as stored; it never throws.
- **Usage and billing**: the usage record of such a turn is settled with its tokens, no cost and `usage_records.cost_basis =
  'subscription'` (migration `20261106012000_add_usage_record_cost_basis`, expand only, null for every older record). It adds
  nothing to a cost sum, is not an unknown cost (no #361 log line, not in `unknownCostCount`, not in the operator feed of unknown
  costs) and is not charged as AI cost. The minutes of the device and the balance check at claim are unchanged (owner question below).
  The workflow budget still counts the estimate (decision 12 of the plan); the engine no longer logs "cost not reported" for it.
- **Who may say it**: the basis in a report is the runner's word and is never taken on its own. The app keeps it in the stored result
  (`withoutUntrustedCostBasis`) and in the usage record (`trustOfJob`) only for a turn of the Implementer whose profile has the harness
  `claude-code` and that a runner of the workspace held (`jobs.runner_id` is `runner:<id>` of a row in `runners`); the workflow budget
  reads the harness of the step's profile (`subscriptionCost`). For any other job (OpenCode, managed key, Diff, Dynamic, a hosted
  Worker) the word is dropped and the usage is booked as before, so an unknown cost stays visible. The Runs page reads the copy only
  beside no cost, and the database refuses a record with a cost and the basis (`usage_records_cost_basis_check`).

### Resume across containers: design

**What exists.** The adapter runs `claude -p --resume <id>` and falls back to a fresh session when Claude Code says "No conversation found".
The conversation is one file, `$CLAUDE_CONFIG_DIR/projects/-work-repo/<session-id>.jsonl` (`/home/agent/.claude/...`; 254 KB after a
turn, +5 KB per turn, R0). The transcripts are filed by the working directory, so the agent's path stays `/work/repo`. OpenCode resumes
through the snapshot channel: the job process exports the session over the engine's HTTP API, redacts it, gzips it (cap 8 MiB), hands it
to the job host over `RUNNER_SNAPSHOT_FD`, the host uploads it in parts (`PUT .../session`), the app keeps ONE row per session
(`implementer_session_snapshots`, replaced by each turn; offered only when written by the directly preceding turn), and the next turn's
host downloads it (`GET .../resume-session`) and puts `resume-session.gz` in the process's directory.

**Why it was not built in this slice.** Every layer of that channel names the OpenCode export: the header carries the engine version
(`opencode_version` column, `VERSION_CHANGED` reason), `resume_session.py` checks the shape of the engine's JSON and its session id, the
export is an HTTP walk of the engine, and the import is the engine's `import` call. It cannot be tested here (no Docker daemon; the lane
test needs one), and a wrong redaction would store the login. So it is one slice of its own.

**The design.**
1. **Kind of snapshot.** A header word `harness` (`opencode` | `claude-code`) in the snapshot header line and a nullable column
   `implementer_session_snapshots.harness` (expand only, null = `opencode`; the existing `opencode_version` column carries the Claude Code
   version for the other kind). The app offers a snapshot only to a turn of the same harness; any other pairing is `no_snapshot` and the
   turn continues from the summary. The new feature word `claude_session_snapshot` in the runner API version lets an older app and an
   older runner agree.
2. **Export (job process, before the container is stopped).** One `docker exec` as `agent` that writes a tar of exactly
   `projects/-work-repo/<session-id>.jsonl` to its standard output (never the whole config directory: no `.credentials.json`,
   `settings`, `plugins`, `backups`, `todos`, `shell-snapshots`). The runner reads at most `MAX_RAW_BYTES`, within the seconds an export has
   (5, or 2 at a stop), in a daemon thread as the OpenCode export does.
3. **Redaction, line by line.** Each JSONL line is parsed; every string value and key goes through the turn's `Redactor` (login, token
   shapes, the job's secrets and their base64/URL forms), never the JSON text (the lesson of the OpenCode export); a line that is not JSON
   is dropped, not copied. The result is compact JSON lines, gzip without a time, cap 8 MiB gzipped; over the cap there is no snapshot.
   After redaction the whole file is scanned once more with `SecretScanner` on the login's forms; a hit discards the snapshot
   (`login_secret`, fails closed).
4. **Import (next turn, in the fresh container).** After the container is up and before the first message, the process writes the
   verified gz through one `docker exec` (`tar -x` as `agent`, only that one path, owned by `agent`, mode 0600) and calls the adapter with
   `resume_from=<session id>`. The id is the UUID in the header and is checked as a UUID. A "No conversation found" (a bad file) already
   falls back to a fresh session with `import_failed`.
5. **The login is never in a snapshot.** Test: a canned transcript whose lines hold the token raw, URL-quoted, in base64 at each
   alignment and in a key name goes through the exporter; the result contains none of the forms, and a transcript the redactor cannot
   clean is discarded. A second test lists the tar: only the one path. The lane test (CI) runs a turn, exports, throws the container away,
   imports in a new one and checks that the second turn answers from the first one's content.
6. **Customer runner and hosted.** Claude Code runs on customer runners only, so only the `runner_session_snapshot` endpoints
   (`/api/runners/v1/jobs/{id}/session`, `/resume-session`) carry this kind; the hosted Worker API never sees it.
7. **Not stored by us unredacted, and still the customer's data.** The transcript holds the agent's tool output, i.e. repository content.
   It is kept like the OpenCode snapshot (the stored conversation is kept for good, erased with the workspace). The owner should confirm
   that a Claude Code transcript may be stored in our database at all, since Anthropic's terms are about the login, not the transcript;
   the transcript is the customer's session content, redacted, never the login.

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
