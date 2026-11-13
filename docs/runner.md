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
- [Spike: Firecracker sandbox](#spike-firecracker-sandbox-970): the Runner v2 sandbox on Linux (a Firecracker microVM with Docker and Sysbox), measured in CI (#970).
- [VM artifacts](#vm-artifacts-976): the kernel, root file system and Docker data disk of that microVM, built from the golden snapshot recipe, signed and verified (#976).
- [The Firecracker launcher](#the-firecracker-launcher-978): how the local Dispatcher starts a job in such a microVM: slots, disks, limits, the host side of the vsock protocol, ending and clean-up (#978).
- [The Incus launcher](#the-incus-launcher-1007): the one local backend (Runner v2, #1007): two unprivileged Incus instances per job, the inner wall in the trusted one, `narrow` as an unplug, the control channel over a unix socket, the quota, the clean-up by mark.
- [Claude Code on the Incus backend](#claude-code-on-the-incus-backend-1023): the harness installed on the device into the golden image, announced from it, and the local credential of a job on Incus (#1023).
- [The outer wall on a customer's machine](#the-outer-wall-on-a-customers-machine-979): the static nft table (printed in full) and the proxy of the local Dispatcher that is the only way out of a job's VM (#979).
- [Spike: Incus (LXD) backend](#spike-incus-lxd-backend-1005): the same job on a machine without `/dev/kvm`, two unprivileged system containers instead of a microVM, measured on the DevBox (#1005).

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
- **Exchange.** The runner says its name (1 to 80 characters, one line), its **labels** (at most 20, lower case, `[a-z0-9][a-z0-9._:-]{0,39}`; **not** in the namespace `cr:`, which is the platform's, see "Routing"), the **version of
  its base** (`1.4.0`), its **manifest** and its **limits**. The manifest names the **entries** it can run (`harnesses`, see "Harness entries" below: a harness with
  its version, the source of its access and, for an access on the device, the models) and its capabilities such as `agent-docker` (announced only
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

A label in the namespace `cr:` is refused in an environment (field `labels`, code `invalid`): a turn that required `cr:managed` would be the platform
Dispatcher's to take.

The turn copies the kind and the labels with the rest of the environment (`implementer_turns.environment_kind`, `environment_labels`), so editing or
deleting the environment touches no turn, and the claim routes by the turn's own row.

### Harness entries (#973)

The app needs to know **what** a dispatcher can run, never the names of its credentials. `manifest.harnesses` is a list of entries, one for each harness and source of
access (`contracts/runner-registration.v1.json`, `HarnessAccess`):

```json
"harnesses": [
  { "harness": "claude-code", "version": "2.1.311", "auth": "subscription", "models": ["sonnet", "opus", "haiku"] },
  { "harness": "opencode",    "version": "1.19.0",   "auth": "app-key" }
]
```

| `auth` | Meaning | Who may announce it | `models` |
|---|---|---|---|
| `managed` | The platform's own keys | the platform identity only | not allowed |
| `app-key` | A key the workspace keeps in the app, handed to the Worker through the Worker API | a customer's runner | not allowed (the app's catalog decides) |
| `local-key` | An API key that exists only on the dispatcher's device | a customer's runner | optional: the models the key allows; left out: any |
| `subscription` | A login that exists only on the device (`claude setup-token`) | a customer's runner | optional: the models the login allows; left out: any |

- **`managed` is refused for a customer's runner**: `422 RUNNER_ACCESS_RESERVED` (`fields`: `manifest.harnesses[<i>].auth`, code `reserved`), at `POST /register` and `PUT /self`,
  and nothing is stored. It is the identity that decides, as for `cr:` labels. This replaces the special rule `runner_needs_own_key` in the routing: a turn that asks for the platform's
  keys cannot match any customer's runner. (The validator and the start of a task still say `runner_needs_own_key` for the combination, because that is the text a person can act on.)
- **An entry is announced only while the dispatcher can run it.** There is no `ready` flag any more: a dispatcher that cannot run an entry for a while (all its subscriptions are rate
  limited, the login is gone) leaves it out of its next announcement. `PUT /self` replaces what the app holds, so the last announcement is the one the matching uses. A manifest without
  an `opencode` entry (the base of every runner) gets no job.
- **The same harness and auth twice** is `400`; models of an entry are unique and sorted; at most 16 entries and 64 models for each.
- **The old map form stays readable**: `{ "<harness>": { "version", "ready" } }` is read as one entry for each harness that is `ready` (`claude-code` as `subscription`, any other harness,
  OpenCode included, as `app-key`); an entry that is not ready is left out. The app stores the list form (migration `20261110180000`), so a stored row is always a list.
- **The platform's own dispatcher** is not announced over `PUT /self`: its manifest is `PLATFORM_ACCESS` in `app/src/runner-identity/access.ts` (OpenCode with `managed` and `app-key`), and
  the same matching code applies to it.

**What a job asks for** is derived from what the job already carries (the profile is not changed): the **harness** of the turn's profile (`implementer_turns.profile_harness`, OpenCode when
null), the **auth** (a harness that runs on a login, `claude-code`, asks for `subscription`; a model that is an entry of the catalog asks for `managed`; a model of the workspace's own key asks
for `app-key`) and, for a subscription, the **model** the turn was started with. A dispatcher takes the job when an entry has the harness, the auth and, when the turn names a model, a model
the entry allows (an entry without `models` allows any). A job with no turn (a review) asks for no harness here.

**Aliases and ids (#980).** A runner announces the models of its subscription as its owner gave them when adding the credential (`sonnet`, `opus`, `haiku` by default, or ids such as
`claude-opus-5-5`), and a turn carries the model its profile names, an alias or an id. They match when they are equal, or when one is an alias and the other an id it stands for
(`claude-opus-5-5` is `opus`; `claude-opus-5-4` is not `claude-opus-5-5`; `sonnet[1m]` is nobody's alias). The map is the contract `contracts/claude-model-aliases.v1.json`, which holds the
patterns and the test vectors; the app keeps a typed copy (`app/src/runner-identity/model-aliases.ts`; `accessRule` writes the same rule for the database from those patterns), the runner another
(`implementer/claude_code/model_names.py`, used to pick the credential that allows a job's model), and a test on each side compares its copy with the file and runs the vectors (the
database runs them in `access.integration.test.ts`). The alternative, announcing ids, would have meant a list that changes with every release of a model; the alias is what a person types.

There is **one rule**: `accessRule` (`app/src/runner-identity/access.ts`) is the SQL condition both the claim (`jobs-claim.ts`) and the pairing of the rings
(`runner-dispatches-repository.ts`) use, and `accessMatches` is the same rule in memory, for the validator; `access.integration.test.ts` runs every manifest against every turn through both
and demands the same answer.

There is also **one reading** of the stored manifest: the claim and the pairing of the rings both read `runners.manifest` with `manifestFromText` (the list form and the old
map form; a text that is none reads as no entry) and pass it through `customerAccess`, which drops any `managed` entry (the platform's keys are the platform identity's alone, whatever
a stored row says). The database only matches the entries it is given. A row that is not JSON, in `runners.manifest` or in a turn's `model_choice` (read through `json_or_null`),
matches nothing and never fails the query for the other jobs.

### Routing

One rule routes every job to every dispatcher (Runner v2, #971, [ADR 0005](decisions/0005-runner-v2-one-dispatcher-contract.md)): **a job requires labels
and a dispatcher takes it only when it has all of them.** There is no special case for hosted jobs or for runner turns; the two that existed
(a hosted job never goes to a customer's runner, a runner turn never goes to the Dispatcher) are this rule.

| Who claims | Its labels | Takes |
|---|---|---|
| The **platform identity**: the shared `RUNNER_TOKEN` (the hosted Dispatcher, the poll mode) | `cr:managed` and one `cr:size-<vCPUs>` for each size of `contracts/environment-sizes.v1.json` (1, 2, 4, 6, 8); entries: OpenCode with `managed` and `app-key` | The jobs whose labels are all of those and that its entries can run: every hosted review and every hosted turn, never a turn that asks for a subscription |
| A **customer's runner** (`crc_` credential) | the labels it announced, never one in `cr:`; the entries it announced, never `managed` | The turns of its own workspace whose environment labels it has all of and whose harness, auth and model an entry of it has |

- **What a job requires** (`jobs.required_labels`, written when the job is enqueued). A hosted review: `cr:managed` and `cr:size-1`. A hosted turn of the
  Implementer: `cr:managed` and the size of its environment (`cr:size-2` for a task without one). A turn of a runner environment: the labels of the
  environment, copied with it. A job written before the column (null) is read as a runner turn requiring the labels of its environment, and any other
  job as requiring `cr:managed`, so a queued job is routed exactly as before the migration.
- **The reserved namespace `cr:`.** Only the platform identity carries a `cr:` label, and the identity decides, never the text. A customer's runner that
  announces one in `POST /register` or `PUT /self` is refused with **`422 RUNNER_LABEL_RESERVED`** (`fields`: each label by position, code `reserved`) and
  nothing is stored; a malformed body keeps its `400`. A runner that stored such a label before this release is claimed without it: the claim drops the
  reserved labels of a customer's runner. An environment cannot name one either (see above).
- **The claim without a job id** returns the oldest due job the caller matches: its labels, its workspace (a customer's runner), the kind its engines run
  and an entry of its manifest for the harness, the auth and the model of the turn (#973). With a `jobId` it works as before (the hosted Dispatcher is still woken by id and claims that job), under the same rule:
  a job the caller does not match is `204`. Business limits stay in the app (the pool cap, `maxRunning`, answers `204`); technical capacity stays with the
  dispatcher, which claims only with room for the job.
- **The claim answer of a customer's dispatcher (#974)** is the same `SplitClaimResponse` and never the job: the id and the credential, the `labels` the job required and, for a turn of the Implementer, `access` (the harness, the
  auth and the model it asks of the device); no `sizeLabel` (a size label is the platform's). See "The service loop".
- **The size in the claim answer.** The answer to a Dispatcher (`SplitClaimResponse`) names the size label the job requires in `sizeLabel`; `vcpus` keeps
  its value (only for a turn with an environment). The label does not choose the VM size (a turn without an environment starts with the operator's configured size), and the Dispatcher gives a
  job back unlaunched (`launch_failed`, log code `size_not_offered`) when the label names a size the platform does not offer.
- **Who takes a runner turn.** Only a runner of the **same workspace** that has **every label** of the environment, has an **entry** of its manifest for what the turn asks for
  (the harness of the profile, the auth and the model: "Harness entries" above) and is not below the minimum base version. A runner that does not announce OpenCode gets
  nothing; one below the minimum gets `426 RUNNER_UPDATE_NEEDED`. The runner claims with its credential and takes the engine `implementer` only: not a
  review, not a split claim, not a job by id. The claim is the ordinary claim of a turn (the same input, the key and the model entry as the Dispatcher's
  Worker gets them), so a runner's turn is built exactly like a hosted one. Its calls about the job (`heartbeat`, `complete`, `release`, `steps`, and the two snapshot calls below) take the
  credential too, for a job of its own workspace only (`404 RUNNER_JOB_NOT_FOUND` for any other); the Dispatcher's calls (`vm`, the job state) take the
  shared token alone.
- **Why hosted and runner never meet.** A hosted job requires `cr:managed`, which no customer's runner has; a runner turn requires labels of a customer,
  which the platform identity does not have. The platform's dispatch (the signed wake-up call, its rows, its listings and its sweep) skips runner turns, so the
  Dispatcher is not woken for a job it cannot take; a customer's dispatcher that announced a webhook is rung for them (next section).
- **Waiting.** A turn that waits for a runner shows **"Waiting for a runner with labels gpu, linux"** on the run page. After `RUNNER_WAIT_DEADLINE_MINUTES`
  (default 30) without a claim it ends **cancelled with `no_runner_available`**, free: no attempt, no credential, no charge, and it is not run again by
  itself. This pass runs wherever the queue expires jobs (every claim, the sweep), so it works in poll mode too. A busy pool of other runners does not
  delay it: the wait is for _these labels_.
- **No operator key on a runner** (decision 2). A runner environment needs a model of the workspace's **own key**. Starting a task with a managed model
  (a catalog entry) in a runner environment is refused with `IMPLEMENTER_RUNNER_NEEDS_OWN_KEY` (422) before a session, a turn or a job exists; a workspace
  without its own key for the model's provider is refused by the rule every task meets. The claim holds the same line: a runner turn whose selection would
  be managed ends `runner_needs_own_key` before a key or a credential exists.

### Delivery: poll or webhook (#972)

A dispatcher chooses how it learns of a job and **announces** it (`delivery` of `contracts/runner-registration.v1.json`, in `POST /register` and in `PUT /self`).
The claim stays the only way to a job; the delivery only says what makes a dispatcher claim.

| Delivery | What makes it claim | What the app does |
|---|---|---|
| `poll` (the default, also when `delivery` is left out) | its own timer (`POST /claim`, every 30 s for the Factory-Runner) | nothing: it is never rung |
| `webhook` with its own **https URL** | the **doorbell**, and a slot that frees on its side | rings it |

- **The doorbell is the signed wake-up call of `contracts/dispatch-webhook.v1.json`** (`POST <url>`, body `job.ready`, no job data, no key, no repository data).
  It goes to **every** webhook dispatcher that matches the job: the same workspace, every label the job requires, an entry of its manifest the job's turn can run on (the claim's rule, #973), not below the minimum base.
  Whoever claims first wins; the claim of the others finds the job running and answers `204`. A dispatcher claims the **next matching job**, it does not need the
  `jobId` the doorbell names (the hosted Dispatcher still claims by it for now).
- **A signing secret for each dispatcher.** The app makes it (`crw_` and 43 characters), **shows it once**, in the answer of the call that made it (`delivery.secret`), and
  keeps it **encrypted** (the key derives from `APP_SECRET`, bound to the runner row, so it opens nowhere else). The first announcement of `webhook` makes it; announcing
  the same mode again keeps it and shows nothing; a new address keeps it; `rotateSecret: true` makes a new one (the old one stops working at once); announcing `poll`
  drops it. `delivery.keyId` names it in `X-Dispatch-Key-Id`. A doorbell signed with another dispatcher's secret is refused by the receiver (`bad_signature`, or
  `unknown_key` under another key id): `contracts/dispatch-signing-vectors.json` has a vector for each (`otherDispatcher`).
- **The address is the dispatcher's, so it is checked.** https without credentials to a public host. An address that names a private, loopback, link-local (the metadata
  service), shared or reserved IP address (in any spelling: decimal, octal, hexadecimal, a trailing dot), an IPv6 address that is no global unicast one (6to4 `2002::/16`,
  Teredo `2001::/32`, documentation `2001:db8::/32`, the IPv4-mapped and -compatible forms are refused), or a name that only means something inside a network (`.local`,
  `.internal`, a name with no dot) is refused with `400 RUNNER_REQUEST_INVALID`, field `delivery.url`. That check is of the text; a name that looks public can still
  resolve to the app's own network, so **every connection to a customer's dispatcher resolves the name once and refuses it when any of its addresses is internal**, and
  connects to an address that was checked (`src/dispatch/guarded-fetch.ts`, an undici agent with its own `lookup`: no gap for a DNS rebinding). That holds for the doorbell and for
  `POST /stop`; the platform's own `RUNNER_WEBHOOK_URL` is the operator's setting and is called as before. **Loopback and plain http are for the fakes only**: an app that runs with
  `RUNNER_DELIVERY_ALLOW_LOOPBACK=1` (the E2E, local development; **never in production**, where it is unset) also takes an address on this machine, with http. No redirect is ever
  followed, the body of the answer is read only for the small `ignored` body, and nothing of an answer or of an error is stored or logged.
- **`RUNNER_WEBHOOK_URL` is the delivery of the platform's own dispatcher.** The hosted Dispatcher has no row of its own: its address and its signing key are the settings the app
  already had (`RUNNER_WEBHOOK_URL`, `RUNNER_WEBHOOK_SECRET`), so a deployment keeps working with nothing more than those. Its rows are `job_dispatches` as before.
- **A dispatcher that is full answers `200 ignored` with `reason: "busy"`** and forgets the bell. It claims by itself when a slot frees (a serverless one learns that
  from `POST /stop`). The app does not ring it again for that job on a timer: **not until an event or the sweep**.
- **The app rings again on events**, bounded and idempotent in the row of each (job, dispatcher) pair (`job_rings`; the same compare-and-set, back-off and acknowledgement
  timeout as the platform's `job_dispatches`):
  - a **job is enqueued** (the hook of the queue, after the response);
  - a **lapsed lease puts a job back in the queue** (also a revoked runner, or a holder that gives a turn back before it started: `onRequeued`): the job is rung at once on every
    dispatcher that can take it, the one that held it included, and the group it was in is rung as below. The claim did not end for good, so `onClaimsEnded` does not name it;
  - the **claim of a job ends** (a result, a failure, a cancel, a lapsed lease that fails the job, a timeout: `onClaimsEnded`): the waiting jobs that the group of that job can take (the labels it
    required and the labels of the runner that held it) are rung again, those whose last ring was answered "not now" (a busy dispatcher among them). At most 20 pairs a
    reaction, a pair no sooner than 9 seconds after its last call, and a dispatcher that answers busy or cannot be reached is asked once in a reaction, not once for each of its jobs;
  - the **sweep**, the rare safety net (the cron runs **every 2 hours**, `app/vercel.json`), and the repair work of the requests that touch the database: the pairs with no row yet or whose row is due.
- **A dispatcher whose endpoint is down is left alone for a minute.** When the last call to a dispatcher ended in a network error or a timeout (the last attempt of its pairs in
  `job_rings`, so every instance and every run sees it), none of its pairs is rung for the next minute: a dead endpoint with many jobs is rung once, not once for each. After the
  minute it is asked again (an answer of any kind, a `503` included, says the endpoint is up).
- **With more than 20 matching dispatchers, the first 20 are rung first.** A reaction rings at most 20 pairs, oldest job first and, for one job, the dispatchers in the order of their
  ids; the others hear of it by their own claim, by a later event or by the sweep. This is by design: the bell is a nudge, the claim decides.
- **`POST /stop` goes to the webhook dispatcher that holds the job** (the runner of its claim), signed with its own secret, when the claim ends. A polling dispatcher learns it
  from its worker ending and from the job state call.
- **Only while the deployment runs the dispatch webhook** (`RUNNER_DISPATCH=webhook`, the hosted one). In poll mode the app makes no outgoing call, so a webhook delivery is stored but never rung.

### Resume on customer runners (#879, #974)

A follow-up turn continues the conversation of the earlier turns: the engine's session is taken as a file at the end of every turn (the session snapshot, [`implementer.md`](implementer.md#the-session-snapshot-839))
and imported into the engine of the next turn, which may run on another machine ([`implementer.md`](implementer.md#follow-up-turns-resume-in-the-runner-840)). **Since #974 a customer's runner moves the file
the way the hosted Worker does**: the Worker the local dispatcher starts holds the per-job credential (`crj_`) and calls `PUT /api/workers/v1/jobs/{id}/session` and `GET .../resume-session`
(`contracts/worker-api.v1.json`: `SessionPartQuery`, `SessionPartResponse`, `ResumeSessionQuery`, `ResumeSessionHeaders`). The two routes of the runner API that #879 added for a runner credential and a
lease token (`/api/runners/v1/jobs/{id}/session`, `/resume-session`), their contract definitions (`Runner*`) and the app feature `runner_session_snapshot` are **removed**; no runner image is published
(`runner/release-channel.json` is empty), so nothing calls them and there is no deprecation window.

- **The same calls, one logic.** The handlers are the Worker API's (`storeSnapshotPart`, `readResumeSessionPart`): the same parts of exactly 3 MiB (at most three), the same description of the whole file in the
  query or in the headers, the same digest and size checks, the same replacement of the session's snapshot once the last part is in, the same reading of the earlier turns' snapshot of the job's own session and of
  no other. Neither call extends the lease.
- **The switch** is the Worker's, as hosted: the Worker asks `GET /api/runners/v1/version?jobId=...` with its credential and uploads a snapshot (and the host downloads the stored session) when the app lists
  `implementer_snapshot`. The claim needs no feature for it: the job says with `implementer.resume.snapshot` whether there is a file to read.
- **Which machine ran the earlier turns does not matter:** the snapshot belongs to the session ([`implementer.md`](implementer.md#follow-up-turns-resume-in-the-runner-840)).
- **Tests.** `app/src/runner-api/snapshot.integration.test.ts` and `resume-session.integration.test.ts` (the Worker routes), `runner/tests/contract/test_snapshot_contract.py` (the contract on both sides) and, in
  `runner/tests/integration/test_factory_runner_loopback.py`, two turns through the dispatcher and a real Worker in which turn 2 reads the snapshot turn 1 stored, and an app that does not list
  `implementer_snapshot`, which gets no channel.

### Validator rules

The validator of workflows (`POST .../workflows/validate`, and every save) knows the kind of each environment and, for each profile version it runs, whether
its model is managed and which harness it runs with. Since #919 the environment is part of the profile, so the same two rules are checked when a **profile** is saved
(`POST .../profiles`, at `/environment`), and again for a step at its `/profile` (at its `/environment` for a profile version saved before #919, whose step names the environment):

| Code                   | When                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_needs_own_key` | A profile (or an agent step) runs a **managed model** in an environment of the kind `runner`. Managed models run on platform VMs only. |
| `harness_needs_runner` | A profile (or an agent step) has a **harness other than OpenCode** in an environment that is not a runner's.                            |
| `no_runner_announces`  | A profile (or an agent step) in a runner environment asks for a harness, auth and model that **no online runner of the workspace with the environment's labels announces** (#973). A **warning**, not an error (`severity: "warning"`, listed in `warnings`; the save goes through): a runner that is asleep, or that leaves an entry out for a while (a rate limit), must never block a save. With no such runner online nothing is said: the turn waits for one. |

A profile names its harness (`opencode` or `claude-code`, [`profiles.md`](profiles.md)); a harness other than OpenCode runs only on a runner.

The validator says which combinations no online runner of the workspace announces (#973, as a warning that never stops a save): it asks the runners that are online (heard from within two minutes, base at the minimum) and have
every label of the environment whether one has an entry for the profile's harness, auth and model (the claim's rule, `accessMatches`). A managed model is `runner_needs_own_key` and is not
reported a second time; a model of the workspace's own key is announced by every runner with OpenCode.

The environment of a profile or of a step is also refused when a label of its `labels` is in the reserved namespace `cr:` (`invalid`, #971).

### Known limits and follow-ups

- **Harness filter in the claim.** Done by #856 and #973: the claim and the pairing of the rings both match the turn's harness, auth and model against the entries of the
  runner's manifest ("Harness entries"). Harness and model still come from the profile; whether they belong there is open (owner, later).
- **Waiting turn and a workflow step.** A workflow step that runs in a runner environment waits like any turn, up to `RUNNER_WAIT_DEADLINE_MINUTES`; if no
  runner takes it, the step fails with `no_runner_available` and a text, at no cost, and the run fails with `step_failed`.

## The Factory-Runner (R1b, #854)

The runner is the Implementer's Control, packaged to run on a customer's Linux machine: **the same code as the hosted Control**
(the job host, the model door with the key out of the agent, the cost ledger, the step records, the finish tool, the session
snapshot, the git rules: no remote in the agent, the runner pushes every local branch, never force). Since #974 (Runner v2, [ADR 0005](decisions/0005-runner-v2-one-dispatcher-contract.md))
it is two things, as everywhere: a **local dispatcher** (the `factory-runner` service: registration, announce, renewal of its credential, claim, slots, the start and the stop of the sandbox) and
the **Worker** it starts (`factory_runner/local_worker.py`: the hosted Worker, unchanged in what it does). The dispatcher claims like every dispatcher and holds **none of a job's secrets**: the
claim answers with the job's id and the credential of its Worker and nothing else; the Worker fetches the job itself over the Worker API and the git token and the key of the workspace are only ever in the
Worker and the containers it starts. The code is
[`runner/src/code_reviewer_runner/factory_runner/`](../runner/src/code_reviewer_runner/factory_runner); the command is
`factory-runner`.

```
machine (Linux, KVM, systemd; no Docker)
├─ factory-runner.service  (the service user, Delegate=yes; the program is root's and read-only): the local dispatcher
│    ├─ announce (PUT /self): labels, base version, manifest {harness entries, capabilities}, limits
│    ├─ claim (POST /claim, every 30 s or so; it is also the heartbeat of the runner): the job id and the credential of its Worker (crj_), nothing secret
│    ├─ per claim, in a free slot: a TAP device (fctapN) and a job disk (a copy-on-write copy of the base disk), a cgroup, a Firecracker microVM (the launcher below)
│    │    with {appUrl, jobId, credential} (and, if the job asks for it, the one credential of this device) on vsock: never through the app
│    ├─ watch it: the local reaper (GET /jobs/{id} with the runner's credential), the claim given back when the VM could not start or ended without a result (POST /jobs/{id}/release)
│    └─ in the VM (the hosted VM's content): vm-init → Control (the Worker image): the job host, the model door, the agent in its own Docker with Sysbox, delivery
├─ the outer wall: a static nft table on the TAP devices and the dispatcher's proxy (the VM reaches the proxy and nothing else)
└─ factory-runner-update.timer (root): stages a signed release; the service switches to it between two jobs
```


### What is the same as hosted, and what is not

*(The table describes the Worker as the loop's tests run it, a process on a Docker daemon. On an installed machine, since #982, the same code runs in a VM whose content is the hosted VM's: the agent is a container of the VM's own Docker under Sysbox, `agent-docker` is always there, and the sizing is the VM's, see "The Firecracker launcher".)*

| Part                                     | On a runner                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model door, key, cost ledger             | As hosted. The key is the workspace's **own** key (BYOK): the Worker fetches it over the Worker API (`app-key`; the dispatcher never sees it), it lives in the door's container, the agent only holds a worthless bearer. A managed model never reaches a runner. |
| Steps, finish tool, result, git rules    | As hosted (same code).                                                                                                                                |
| Agent's container                        | The same image, the same fixed address on the same internal model network, memory without swap, no host mount, no socket, **but** the runtime is `sysbox-runc` only where the self-test proved it; otherwise the daemon's default (`runc`), with an init that only says "ready". |
| The agent's own Docker                   | **Not part of the base** (decision 3, S2). The capability `agent-docker` is announced only when the self-test ran a container in a Docker inside Sysbox. A job whose setup needs Docker is for a runner that announces it. |
| Lease, heartbeat, result                 | As hosted: the Worker API (`/api/workers/v1/jobs/{id}`, `/heartbeat`, `/result`, `/steps`) with the credential of the claim (#974). The runner's own credential is for the dispatcher's calls only (registration, announcement, claim, the state of a job, the release of a claim). |
| Session snapshot and stored session      | As hosted: `PUT /api/workers/v1/jobs/{id}/session` and `GET .../resume-session` (see "Resume on customer runners"). |
| Sizing                                   | The configured memory and CPUs, not the VM size the Dispatcher computes. One run at a time.                                                           |

### Install (a machine with KVM, #982)

For a Linux machine with **KVM** (`/dev/kvm`), **systemd 247 or newer** with cgroup v2, and x86_64. **Docker is not needed and is never touched**: the
runner starts every job in a Firecracker microVM ([the launcher](#the-firecracker-launcher-978)) and the VM has the Docker. Create a
registration token in the app (Owner or Admin: Runners, "Add a runner"; it is valid for an hour and works once), then, as root. **The installer
asks for the token on the terminal** (the input is hidden; nothing of it is in the process list, the shell history or the log of `sudo`):

```sh
curl -fsSL https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh | sudo sh
# settings go behind `-s --`:   ... | sudo sh -s -- --labels linux,gpu --parallel-runs 2 --disk-gb 50
```

or from a file that only root can read (save the script first: under `curl | sh` the standard input *is* the script, so `--token-file -`
cannot read the token from it):

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/Itegro-GmbH/code-reviewer/main/runner/install/install.sh
sudo sh install.sh --token-file /root/runner-token --labels linux,gpu
```

`FACTORY_RUNNER_TOKEN=crt_... sudo sh install.sh` also works, but **only use it on a machine where that does not matter**: the token is
then in your shell history, in the log of `sudo` and, while the command starts, in the process list. The installer prints that warning when
the token came from the environment. A token is never an argument (`--token` is refused).

**The old mode is gone.** There is no install on the host's Docker socket, no runner image (its Dockerfile and its CI
build are deleted, and so is the file with the agent image's reference it carried), no Sysbox step on the host (Sysbox is in the VM), no image-based update and no Worker-as-a-process fallback in the program
(`factory-runner run` ends with exit code 6 unless `FACTORY_RUNNER_SANDBOX=firecracker`, which the unit sets). No runner was ever published, so
there is **no migration window**: an older, Docker-based install is not recognised, and the installer stops when it finds its unit.

**What it checks first, and where it stops.** Nothing is changed until all of this has passed (every stop says "nothing was changed"):

| Check | When it fails |
|---|---|
| Linux, x86_64, root | stops (macOS and arm64 come with their own backends) |
| **`/dev/kvm` exists** | stops and explains: a physical machine needs virtualization enabled in the firmware and the `kvm` modules; **a cloud VM needs nested virtualization** (a bare-metal type or a VM family that exposes `/dev/kvm`); a container has none |
| `/dev/kvm` can be opened by root; the group `kvm` exists | stops (the service user opens the device through the group; a device owned by another group gets a warning and the proof after the user is made: a try as that user) |
| `/dev/net/tun` exists | stops (`modprobe tun`): the TAP devices of the VMs need it |
| systemd ≥ 247, `/run/systemd/system`, cgroup v2 at `/sys/fs/cgroup` | stops (delegation and the sandboxing options of the unit; the VM limits are cgroup v2) |
| `nft`, `ip`, `curl`, `openssl`, `jq`, `zstd`, `tar`, `flock`, `runuser`, `useradd`, `userdel`, `resize2fs`, `e2fsck`, `sha256sum`, `base64` | stops and names the package |
| **an install exists** (`/etc/code-reviewer/install.state`) | stops: update it with `sudo factory-runner update`, or run the installer over it with `--refresh`. **A second dispatcher on one machine is refused**: the launcher takes a lock on its state directory (a second one ends with exit code 9), and the installer reuses nothing it did not make |
| a unit `factory-runner.service` (or its `-update` / `-wall` units), the command `/usr/local/bin/factory-runner`, the user `factory-runner`, a non-empty `/var/lib/code-reviewer` (an empty one, with or without `lost+found`, is a volume of the operator's: it stays), `/opt/code-reviewer`, **`/etc/code-reviewer`, `/var/lib/factory-runner`**, the table `code_reviewer_wall` or a TAP device `fctapN` that this installer did not make | stops: **what the install makes is what the uninstall (and a failed install) removes, so nothing of it may exist before; `install.state` is the record, and a machine without it is never touched by an uninstall** |
| **the network of the slots**: the first of a list of `/24` networks (`10.250.0.0` to `10.255.0.0`, `10.240.0.0` to `10.249.0.0`, `192.168.250.0` to `192.168.254.0`) that overlaps **no address and no route** of the machine (`ip -4 -o addr show`, `ip -4 route show table all`, so a VPN's or Docker's routes count) | stops when none is free and says how to name one (`--slot-network 10.77.5.0/24`, a `/24` inside `10.0.0.0/8` or `192.168.0.0/16`, which is checked the same way). Never `172.16.0.0/12` (Docker's address pools; the default VPC of AWS is `172.31.0.0/16`, whose Amazon DNS is `172.31.0.2`) and never `100.64.0.0/10` (Tailscale). The choice is kept in `install.state` and in `runner.env` (`FACTORY_RUNNER_SLOT_NETWORK`); a `--refresh` keeps it |
| the state directory is not on a file system with **reflinks** (XFS with `reflink=1`, btrfs) | **warns, goes on**: the job's disk is a copy-on-write copy of the 6 GiB base disk (34 ms); without reflinks it is a full copy for every job. Put `/var/lib/code-reviewer` on such a volume (a probe `cp --reflink=always` decides, not the file system's name) |
| the **two release channels** are filled in, the manifests download and **verify**, the **program** is downloaded, verified and unpacked **in the work directory** and its **table passes `nft -c -f` on this kernel** (rendered for the chosen network), the disk has room | stops ("no program release is published yet" while a channel is empty: the owner fills it) |

**Then, in this order** (the first failure removes what a fresh install made, so nothing is left behind):

1. the user `factory-runner` (a system user, no shell, no login) as a member of `kvm`, and a **try**: the user opens `/dev/kvm` for reading and writing;
2. the directories (below), the **VM artifacts** (the program was staged before step 1) downloaded by the names and **digests of the signed manifest**, verified
   and unpacked into a staging directory and moved into place in a short step under the switch lock together with the program; the artifacts end up **owned by root and read-only for the service**;
3. **one TAP device per slot** (`--parallel-runs`, 1 to 64, default 1: the number of jobs at once), owned by the service user, with the `/30` of the slot in the chosen network. The number of devices is written to
   `install.state` **before the first one is made**, so an install that is interrupted or fails half way removes exactly what it made;
4. the **static nft table** of [the outer wall](#the-outer-wall-on-a-customers-machine-979), rendered for the network of the slots, loaded, and **listed again with `nft list table inet code_reviewer_wall`**; if that fails the install fails;
5. only then the units (`FACTORY_RUNNER_OUTER_WALL=proxy` is in the unit **only because the table was listed**; the service checks again before every start, below) and the command;
6. the **registration** with the token (a token that is refused leaves the install in place and says how to register by hand);
7. the update timer and the wall timer, the service enabled and **started**.

**Interrupted.** A signal (Ctrl-C, hang-up, `kill`) ends the script like a failure: what a fresh install made is removed and the work directory goes. A `kill -9` cannot be caught: run
`sudo sh install.sh --uninstall` (it reads `install.state`, which is written before the first change).

**Where things are.** Nothing the service can write is code, and nothing it can read of the kernel and the root file system can be changed by it:

| Path | Owner, mode | Content |
|---|---|---|
| `/opt/code-reviewer/releases/<N>/`, `current`, `previous` | root, read-only | the program: `bin/factory-runner`, `bin/firecracker`, `share/outer-wall.nft`, `libexec/host.sh` (this script) and the Python runtime |
| `/var/lib/code-reviewer/artifact-releases/<R>/`, `artifacts`, `artifacts-previous` | root, files `0644`, directory `0755` | `vmlinux`, `rootfs.ext4`, `dockerdata.ext4`, a copy of the manifest and its signature, `vm.env` (the Worker image's id); `artifacts` is the link the launcher reads |
| `/var/lib/code-reviewer/vms/`, `dispatcher.lock` | the service user | the VMs' directories, the lock of the one dispatcher |
| `/var/lib/code-reviewer/pending`, `update.lock`, `switch.lock`, `staging/`, `outer-wall.nft` | root | the marker of a staged release (`program=N`, `vm=M`, `pair=1`), the locks, the downloads in progress, the table as it was loaded (rendered for the slots' network) |
| `/var/lib/factory-runner/` | the service user, `0700` | `config.json` (with the credential), the Claude Code credentials of the device |
| `/etc/code-reviewer/` | root | `install.state` (what the installer made, for the uninstall: the user, the number of TAP devices, the slots' network, whether the state directory was there), `channel-program.json`, `channel-vm.json`, `runner.env` (settings, no secret), `rejected-program`, `rejected-vm`, `download.curlrc` |
| `/etc/systemd/system/factory-runner.service`, `factory-runner-update.service` and `.timer`, `factory-runner-wall.service` and `.timer`, `/usr/local/bin/factory-runner` | root | the units and the command |

**The unit** (`factory-runner.service`) runs as `User=factory-runner` with `SupplementaryGroups=kvm` and `Delegate=yes`. The options and why:

| Option | Why |
|---|---|
| `ExecStartPre=+…/libexec/host.sh prestart` | as root (the `+`): switches to a staged release, makes the TAP devices a restart of the machine took, loads the table and **fails the start unless `nft list table inet code_reviewer_wall` answers**. The service is a normal user and cannot read nft state, so this is the only check, and it runs at every start, not only at install |
| `After=` and `PartOf=nftables.service` | a reload of the machine's rules (`nftables.service`) flushes our table with the rest: a restart of that service restarts this one, and the start loads the table again. A machine without that unit ignores both lines. A flush by anything else is what the wall timer catches ([below](#the-outer-wall-is-checked-while-the-service-runs)) |
| `Environment=FACTORY_RUNNER_SANDBOX=firecracker`, `FACTORY_RUNNER_OUTER_WALL=proxy` | `proxy` is written only after the table was listed; the program's own default stays `refuse` |
| `LimitNOFILE=8192 + 64 × slots` | the vsock listeners (2 per VM, 4 connections each), the VMs' files, the proxy's 256 connections of two descriptors each and the app's connections, with room |
| `TasksMax=300 × slots + 256` | Firecracker's threads: every VM's cgroup has `pids.max` 256, and the unit's limit covers all of them |
| `Restart=always`, `RestartPreventExitStatus=4 6 9` | exit code 10 (a staged release) restarts it; revoked (4), configuration (6) and "another dispatcher" (9) are not made better by a restart |
| `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=` (`vms/`, `dispatcher.lock`, the home), `ProtectHome`, `PrivateTmp` | the service writes only its own files; the program and the artifacts are read-only for it |
| `CapabilityBoundingSet=`, `AmbientCapabilities=` (empty) | Firecracker has no capability (measured in the spike); KVM and the TAP are opened through group and owner |
| `DevicePolicy=closed`, `DeviceAllow=/dev/kvm rw`, `/dev/net/tun rw` | the only devices a VM needs |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, `SystemCallArchitectures=native`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`, `ProtectHostname`, `UMask=0077` | what a dispatcher and its VMM never need. vsock is Firecracker's Unix socket, so no `AF_VSOCK` |

**Deliberately not set** (each would stop something this service does, or has not been tried): `PrivateDevices` (hides `/dev/kvm` and `/dev/net/tun`),
`ProtectControlGroups` and `ProtectKernelTunables` (make `/sys/fs/cgroup`, where the service makes one cgroup per VM, read-only; to try on a real host, see the checklist),
`SystemCallFilter` (Firecracker has its own seccomp filter; a unit filter has to be built from a measured list), `MemoryDenyWriteExecute` (the Python runtime),
and **one unit or one user per VM** (decided against in the launcher: it needs a root helper at runtime). A VMM that escaped lands in the service user, which owns the other
VMs' disks: the user owns nothing else on the machine, and cannot change the kernel or the root file system every later VM boots from.

**The command.** `/usr/local/bin/factory-runner` hands `update`, `rollback`, `status` and `uninstall` to the root script and everything else
(`register`, `config`, `credential`, `selftest`) to the service user (`sudo factory-runner config show`): the configuration and the credential belong to that user.

**Two release channels, no host in the script.** The program and the VM artifacts are each a **signed manifest** at an address the channel names:
[`runner/release-channel.json`](../runner/release-channel.json) (the program) and [`docker/vm/release-channel.json`](../docker/vm/release-channel.json) (the VM artifacts, the file the release workflow
also reads):

```json
{ "version": 2, "baseUrl": "", "manifestAsset": "runner-manifest.json", "signatureAsset": "runner-manifest.sig", "publicKey": "" }
```

`baseUrl` is an `https` directory: the manifest, its signature and every file the manifest names are at `<baseUrl><name>`. **The VM channel's `baseUrl` may hold `{release}`**: the installer
replaces it with the number of the VM artifacts release a program names ("The pair", under "Updates"), so each release has an address of its own and an older one than the newest is still there to be fetched
(`https://github.com/Itegro-GmbH/code-reviewer/releases/download/vm-artifacts-v{release}/` is the GitHub form; `https://storage.example/vm/{release}/` a protected one). Without `{release}` the directory holds
one release at a time, the newest, and serves a program only if that is the release it names. The program channel has no placeholder: the newest program is the one that is taken. **Where that is is the owner's decision**
(a public GitHub release, or protected storage; see "The program release", "For the owner", under "Updates"); the installer hard-codes only where the channel files
are (the repository's `main`) and `--program-channel-file` / `--vm-channel-file` read another file. Both stay **empty** until the owner fills them: then the installer stops with
"no program release is published yet" and changes nothing. A release address that needs a login (protected storage) takes a curl configuration, `--curl-config FILE`
(`header = "Authorization: Bearer …"`, or a client certificate), which the installer keeps for the updates in `/etc/code-reviewer/download.curlrc`, readable by root only (written under `umask 077`, so it is never readable by others, not even for an instant). **A configuration given on the command line wins over the one kept**, for the first fetches too, and replaces it once the manifests have verified with it. **While one is in use a redirect is followed only within the same host**: curl sends custom headers to wherever a redirect points, so a redirect to another host is refused (and says so) rather than followed; without a configuration redirects (a release asset on a CDN) are followed, https only.
`publicKey` is the base64 of the DER of an ECDSA P-256 public key; the manifest's signature (ECDSA, SHA-256, DER) is checked with `openssl` over exactly its bytes
before one field of it is read. The installer stores a copy of each channel in `/etc/code-reviewer/`, so **a setting on the device cannot redirect an update**; a new key is a new channel file
and the installer run again (`--refresh`).

**A download is bounded by what its manifest says.** Every download and every unpacking runs under a limit on the size of any file the process writes (`ulimit -f`, the size of the manifest plus a block), so a server that sends more than it said (no `Content-Length`, an endless body) or a compressed file that expands to more cannot fill the disk; `curl --max-filesize` only trusts a header. The size and the digest are checked afterwards as before.

**A download that is cut off changes nothing.** Under `curl | sh` the shell runs the file while it receives it. All of the script is functions; the last line, `{ main "$@"; }`, is the
only command that does anything, and a run that does not print `install: done` did not finish.

**Safe to run again (`--refresh`).** The install steps are idempotent: the user, the directories, the TAP devices and the table are kept or made again, the settings are applied (`config set`),
the units are rewritten, and a release newer than the one installed is **staged** (never taken by the installer itself while the service runs). A running service is **never restarted**. `--parallel-runs` changes the number of TAP devices
(a smaller number removes the ones above). The installer never installs an older or a rolled-back release.

`--dry-run` says what it would do and changes nothing.

What the script cannot know: whether a real systemd, a real `nft` and a real kernel behave as its tests assume. The first install on a machine is the test of that
([First install on a real host](#first-install-on-a-real-host-the-live-test)), and the installer lane of CI installs it on a real systemd with a stand-in program.

### Developer, one machine

The program is Python (`uv`): `uv --directory runner run factory-runner --help`, `uv --directory runner run pytest -m unit`. A job in a VM needs KVM and the release's artifacts: the **KVM lane**
(`runner/tests/kvm`, `.github/workflows/vm-artifacts.yml`) runs on GitHub's runners, and a developer machine with `/dev/kvm` installs like any other, with channel files of its own
(`--program-channel-file`, `--vm-channel-file`, `--curl-config`). The installer's tests run it against a fake root: `FACTORY_RUNNER_ROOT=<dir>` puts every path below that directory (for the tests, not for a real machine).
There is no image to build: the runner image and the Docker socket install of R2 are gone (#982).

### The command

| Command                        | What it does                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `register [--token-file F \| --token T] [--name N] [--labels a,b] [--url U] [--cpus] [--memory-mb] [--disk-gb] [--force]` | Exchanges the token for the runner's credential (read from `--token-file`, `-`, `FACTORY_RUNNER_TOKEN` or `--token`, see above) and writes the configuration (file mode 0600, directory 0700). If the app accepted the token but the file cannot be written, it says `runner registered, but its credential could not be saved: revoke it in the app and register again` and ends with exit code 8: the credential is shown once and is lost. Refuses to replace a registration without `--force`. `--runtime` and `--agent-image` of the Docker-based runner are **refused** with a message (every job runs in a Firecracker VM, whose runtime and agent image are part of the signed VM artifacts). Without `--url` it goes to `https://code-review.com`. The manifest of the registration is empty: `run` announces what the self-test proved. |
| `run`                          | The service loop (below).                                                                                                                  |
| `run --once [--wait SECONDS]`  | Takes **one** job and ends with its exit code. With no job within `--wait` (default 600) it ends with **exit code 0** and the line `no job for the labels of this runner within Ns: nothing to do`. |
| `selftest [--json] [--with-claude-code]` | Proves the base (below). On a device with a Claude Code login it also looks at Claude Code (no model call); with `--with-claude-code`, by hand, it runs one tiny real turn on that login (a few cents of your subscription, see "Claude Code with your subscription"). Exit code 0 when it holds, 5 when it does not. Needs no registration. It only looks: it pulls and names no image, so a missing or not pinned agent image is reported as not ready (a starting `run` pulls it). It may run beside a service; its throwaway container is one more on the daemon for the seconds it takes. |
| `config show`                  | The configuration as the runner sees it (file and environment), the credential only as `set` / `not set`.                                  |
| `config set [--name N] [--labels a,b] [--cpus N\|none] [--memory-mb N\|none] [--disk-gb N\|none] [--parallel N] [--auto-update on\|off]` | Changes the file **on the device** (labels, limits, parallelism, name, automatic updates; `--runtime` and `--agent-image` are refused with a message, as for `register`). Every value goes through the check of `register`; one wrong value changes nothing. `none` removes a limit. The credential and everything not named stay as they are, and the environment is never written into the file; when a variable overrides a setting that was changed, it says so. A running service reads the file when it starts: restart it after its job. `--parallel` accepts 1: this runner takes one job at a time. |
| `credential show`              | `credential: set (from the file)` or `not set`, and how old it is. Never the value.                                                         |
| `credential renew`             | Asks the app for a new credential and saves it **before** anything uses it (the app keeps the old one valid until the new one was used once, so a failed write loses nothing). Not for a credential from the environment. Exit code 4 when the runner was revoked. |
| `update`, `rollback [--now]`, `status`, `uninstall` | **The root script's, not the program's** (#982): `/usr/local/bin/factory-runner` hands them to `libexec/host.sh` of the current release. See "Updates" and "Uninstall". |

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
| 9    | Another dispatcher holds the lock of this machine (`dispatcher.lock` in the state directory, "One dispatcher per machine"); the runner announced nothing and claimed nothing |
| 10   | The service ended between two jobs because a release is staged (`pending`); systemd (`Restart=always`) starts it again and the start switches to the new release (see "Updates") |

### Configuration

The file is `$FACTORY_RUNNER_HOME/config.json` (`~/.factory-runner`; `/var/lib/factory-runner` on an installed machine). **Every value can come
from the environment instead, and the environment wins**, which is how a VM that runs one job gets its credential without a file:

| Variable                                 | Meaning                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `FACTORY_RUNNER_URL`                     | The app (`https://...`; `http://` only for loopback, or with `FACTORY_RUNNER_ALLOW_HTTP=1`)  |
| `FACTORY_RUNNER_CREDENTIAL`              | The runner's credential (`crc_...`), a secret                                                |
| `FACTORY_RUNNER_NAME`, `FACTORY_RUNNER_LABELS` | The name, and the labels (comma separated, lower case)                                 |
| `FACTORY_RUNNER_CPUS`, `_MEMORY_MB`, `_DISK_GB` | The limits (below)                                                                    |
| `FACTORY_RUNNER_AGENT_IMAGE`, `FACTORY_RUNNER_RUNTIME` | Process mode of the tests only (the Docker self-test): the agent image to pull; `auto` (default), `runc` or `sysbox-runc`. Not settings of an installed machine |
| `FACTORY_RUNNER_AUTO_UPDATE`             | `1` (default) or `0`: the update timer looks for a release (see "Updates"); `sudo factory-runner update` works either way |
| `FACTORY_RUNNER_TOKEN`                   | `register` only: the registration token, an alternative to `--token-file` (not read by `run`) |

A wrong value is refused with the name of the field and never its value (the file holds a secret). The credential is **renewed**
(`POST /credential`) between jobs when it is older than seven days and **was read from the file**; the new one is written before it
is used, because the app keeps the old one valid until the new one is used once. Only the credential and its time are written, into
the file as it is on disk: what the environment overrides (address, name, labels, limits) never ends up in it. A credential from the
**environment** belongs to whoever set it (a VM that runs one job; a secret store) and is **never renewed**, even when a file with an
older credential exists. A renewal whose file cannot be written is dropped: the old credential stays in use and the next job asks again.

### The service loop

*(#982: this section describes the loop as its tests run it, with the Worker as a process on a Docker daemon (`ProcessSandbox`: the lock container, the tidy, the disk budget). **An installed machine does not run
that mode:** the program refuses it, the sandbox is the Firecracker launcher (one VM per slot, no Docker on the host, nothing to tidy), and exit code 9 means another dispatcher holds the machine's lock. The
code of the process mode is kept for the tests of the loop and is a follow-up to delete.)*

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
2. **Announce** (`PUT /api/runners/v1/self`): labels, base version, the manifest (an entry for `opencode` with the version the runner pins and `auth: app-key`, one for `claude-code` with `auth: subscription` when the device has a
   login; `capabilities` such as `agent-docker`) and the limits it works within. A runner whose base is not proven announces no OpenCode entry
   and takes no job (exit code 5; the failed check is in the log).
3. **Tidy**, before the first claim and again whenever a job has ended: every container and network with the labels `code-reviewer.role`
   and `code-reviewer.runner=<this runner's id>` is removed (what a killed runner left, the door with the workspace's key above all),
   then `/work/reserve`, `/work/repo` and `/work/result` are emptied (a turn refuses to start on leftovers: `setup_failed ... exists
   already`). The work volume is left alone when a container could not be removed (it may still mount it), and so is a folder with a
   mount point below it (another device than `/work`): both are problems, so no claim. Rights are changed through opened folders
   (`O_NOFOLLOW`, `fchmod`), never by path. The same runs right after each
   job. A runner that cannot tidy takes **no job** (it says why in the log, `run --once` ends with exit code 1, `run` tries again after a
   minute): a job it took would fail in its set-up.
4. **Claim**, every 30 seconds with a little jitter. The claim is the runner's heartbeat: the list shows it online for two minutes after.
   A claim names the engine `implementer` and the feature `worker_credential` (#974): the answer is the **split** one, `{ job: { id, credential, ... } }` with the credential of the
   job's Worker (`crj_`), optionally the labels the job required and what it asks of this device (`access`: harness, auth, model), and **nothing secret**: no job input, no git token, no key
   of the workspace, no lease token. The dispatcher never holds any of them; an answer that carries a job input is refused and never read further.
5. **Start the Worker** (`sandbox.py`) with `{appUrl, jobId, credential}` on its standard input. Today the Worker is a process of this container, started with an environment of its own (the plain
   variables and the ones that say how its containers are made, never the runner's credential): `python -m code_reviewer_runner.factory_runner.local_worker`. The sandbox is a seam: the Firecracker
   launcher (#978) will start the same Worker in a VM. **The one credential of this device a job needs** (a Claude Code subscription, when `access.auth` is `subscription`; `local-key` is not built) is **chosen
   for this job** by the dispatcher among the credentials of the device ("Claude Code with your subscription" below: not rate limited, not refused, a list of models that allows the job's model) and handed
   over in the same start document as `localCredential: {"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": ...}` (#980: **one shape** for a Worker that is a process, as here, and for Control in a VM, where
   vm-init writes the same object to Control's standard input; **one allow-list of names**, `LOCAL_CREDENTIAL_NAMES` in `job_loop/local_credential.py`, which the host checks before the start and the
   Worker checks again before it puts a value anywhere, so a name such as `PATH` or `LD_PRELOAD` is refused with an input error that names the field and never the value). It never goes through the app
   and never to a Worker whose job does not ask for it, and only that one credential goes: a Worker never sees the others. The Worker puts it into the environment of the job process
   and into its masker; it is not in an argument or in the Worker's own environment. The Worker is the hosted one: it fetches the job over the Worker API with its credential (`GET /api/workers/v1/jobs/{id}`:
   the git token and the key of the workspace are made here and reach only the Worker), runs it through the job host (the job process gets the job on its stdin and a minimal environment, never a
   credential), keeps the heartbeat, sends the steps and the snapshot and delivers the result. The disk budget (below) ends a job from inside the Worker, as it did when the loop ran the job.
   A SIGTERM or SIGINT of the dispatcher is passed on to the Worker, which gives its job back (`runner_shutdown`) within its grace (135 s) and ends; the loop ends after it.
   **When a claim is given back:** the Worker could not be started (`launch_failed`), or it ended with an error code (`worker_exited`); the dispatcher calls
   `POST /api/runners/v1/jobs/{id}/release` with the credential of the job in the body and its own credential in `Authorization`. The app answers `ended` for a job that already has its result (nothing
   changes) and counts a lost attempt otherwise. **The local reaper:** while a Worker runs, the dispatcher asks the app every minute for the job's state (`GET /api/runners/v1/jobs/{id}` with the runner's
   credential, for a job of its own workspace; `404` for any other) and ends a Worker that is still there 45 s after the job stopped being `running` (a hung Worker no heartbeat reaches).
   **What the end of the job says about the credential (#980).** A job that the subscription refused ends with a stable code in the app (`subscription_auth`: the token was refused, a 401;
   `subscription_limit`: the usage limit; `subscription_model_refused`: the subscription does not allow the model; all three **free**, with a sentence of their own in the app) and, for the dispatcher,
   with an exit code of the Worker that says the same (`WorkerExit` 20, 21, 22: the dispatcher cannot read the result, and the exit code is what reaches it through a process and through a VM alike).
   **All three are hints that expire, never verdicts.** The exit code is derived from the job's `result` event on Claude Code's standard output, and the agent inside the job's sandbox can forge it: it runs as the
   same user (`agent`, uid 10201) as Claude Code and so, as far as we can tell (not tried), can open `/proc/<pid>/fd/1` of Claude Code and write a `result` line into the pipe, or ptrace it (what the host's kernel allows).
   So a forged "401" must not withdraw the device for good. On 21 the
   credential is put aside for **one hour** (`LIMIT_COOLDOWN_SECONDS`), on 20 for **six hours** (`AUTH_COOLDOWN_SECONDS`), and on 22 **that one model** leaves the credential's offer for **six hours**
   (`MODEL_COOLDOWN_SECONDS`); then they are tried again, and a credential that is really expired or limited simply fails the next job once more. `FACTORY_RUNNER_CREDENTIAL_LIMIT_COOLDOWN_SECONDS`,
   `..._AUTH_COOLDOWN_SECONDS` and `..._MODEL_COOLDOWN_SECONDS` change them (a positive number of seconds; a bad value keeps the default and is said in the log). `factory-runner credential retry NAME` ends all
   three at once. The list of models you gave is **never shrunk** by a refusal: only an entry equal to the refused id is left out for its time; an alias such as `opus` is not left out by one refusal (other
   `opus` ids may be allowed) and only once two different ids it covers are set aside at the same time. The impact of a forgery is limited to **your own credentials on your own device, for hours**; nothing is
   lost and nothing leaves the device. The state is kept in the credential store, so a restart remembers it.
   **A job that hits the limit fails (free); it does not move to another credential in the middle of its run.** A turn is Claude Code's session on one login: the next job gets another credential, this one ends
   `subscription_limit` and may be run again (the app's retry), then on a credential that is not limited.
   **The entry in the manifest follows (#980).** Before each claim the dispatcher compares what it would announce with what it announced, and announces again (`PUT /self`) when the entry of Claude Code changed:
   its `models` are those of the credentials that can be used now, and **the entry is left out while none can** (all rate limited, all refused, none with a model, **or none whose secret can be read**: a file
   that others can read, a failed `systemd-creds` decrypt), so the app stops offering it jobs; it comes back, with the models, as soon as one credential is usable again (a hint ran out, a credential was
   added or replaced). The readiness of the start looks at the **layer alone**: a service that started before the first `credential add` offers Claude Code as soon as the credential is there, with no restart.
   A claim that still returns a job that no credential can serve (the app picked it before the new announcement) is given back unstarted (`launch_failed`) **and backs the next claim off** like a Worker that cannot
   start (10 s, doubled to five minutes; the app counts an attempt for every release, so a store that cannot serve must not spend one of every queued job); no Worker is started for a job it could only fail. Nothing but the harness, `auth: subscription` and
   the models goes to the app: not a name, not a count, not a reason. A device without Claude Code (no layer) announces once, as before.
6. What a claim's failure means: `401` the runner is **revoked**, stop for good (exit 4); `426` **update needed**, say so, wait five
   minutes (`--once`: exit 3); the app unreachable, wait 5 s, 10 s, ... up to five minutes.

**Revoking** a runner in the app ends the job it is running at once (the app cuts the lease; the Worker's next call is `409 RUNNER_JOB_ENDED`, its host ends the process, nothing more is sent) and the
dispatcher's next call is a `401`, which stops the service.

What the runner meets of the routing above (R1a part 2): it is offered a turn only when the turn's environment labels are all among its
own, its workspace is the turn's and an entry of its manifest has what the turn asks for (it announces OpenCode); below `RUNNER_MIN_BASE_VERSION` the claim is the `426` it
reads as "update needed". A revoked runner's turn ends in the app as `runner_revoked` (the Worker learns it from the `409` of its
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

*(#982: this section is about the process mode on a Docker daemon, which an installed machine does not run; see "The Firecracker launcher": the VM's quota is the size of its disk file, and `prepare_firecracker` checks the host.)*

`factory-runner selftest` is the proof of the base (decision 3) and runs at the start of every `run`. In order, each with a stable
name: `docker` (the daemon answers and has the chosen runtime), `work-volume` (`/work` is a Docker volume of this container),
`memory` (the agent gets at least 1024 MB: 60% of the machine up to 16 GiB unless `memoryMb` is set), `agent-image` (below),
`agent-container` (the agent's container starts under the runtime with the limits, no network, and is ready), `opencode` (it reports
the pinned version), `canned-turn` and, as a capability that may fail without costing the base, `agent-docker`.

**The agent image is held to the pin.** The runner names the image it starts agents from `code-reviewer-agent:golden`, and a daemon
may already have an image of that name from an earlier version. When the reference the runner was given (`FACTORY_RUNNER_AGENT_IMAGE`; on an installed machine the agent
image is part of the VM artifacts and its id is in the signed manifest) names its image **by digest**, the digest is compared with the ones the daemon knows the image by; a
different one is replaced (pulled and named again) and the check says `replaced`. With a **tag** nothing can be compared, so the check
passes with a **warning** (`the image behind a tag can change`) and the engine decides: if `opencode --version` in the container is not
the version this runner pins, the image is pulled once and the check repeated; if it is still wrong, the runner is **not ready** and
the log says which version was found, which is pinned and what to set. The VM artifacts pin the agent image by its id in the signed manifest.

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

*(#982: this section is about the process mode on a Docker daemon, which an installed machine does not run; see "The Firecracker launcher": the VM's quota is the size of its disk file, and `prepare_firecracker` checks the host.)*

Enforced through the host's Docker (`limits.py`, `disk_budget.py`):

| Limit                | Setting                  | What is enforced                                                                                                                                                                                                                         |
| -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory               | `memoryMb`               | `Memory` = `MemorySwap` of the **agent's container, which is also the setup script's container** (#855, #1009; below 1024 MB the runner is not ready). The default is 60% of the machine up to 16 GiB.                                                              |
| CPUs                 | `cpus`                   | `NanoCpus` of the **agent's container and of the setup container** (#855: the container that runs the environment's script is as free as the agent, so it had no business being the one that ran without a limit).                            |
| Jobs at a time       | `parallelRuns`           | One. A second would collide on the fixed names and the fixed model network. With the Firecracker sandbox (`FACTORY_RUNNER_SANDBOX=firecracker`, #978) every job has a VM of its own and `parallelRuns` is the number of slots (up to 64).                                                                                                                                                |
| **Disk**             | `diskGb`                 | A **budget per job**, below.                                                                                                                                                                                                             |

**The disk budget** (#855). `diskGb` is what one job may hold on the machine's disk. While a job runs (every 20 seconds) the runner measures
what the job made: the folders of the turn in `/work` (`reserve`, `repo`, `result`, by the allocated blocks of their files, a file with
several links once, links not followed), the **writable layer of every container of this runner** (the agent's, which since #1009 is also
the container the environment's setup script ran in and holds what the script installed outside its own Docker, and the door's: this
is where what an agent writes into its container, its session files among it, is) and, for a container under **Sysbox**, the **data of its inner
Docker** (`/var/lib/docker` in it: the images the script pulled or built, the containers and volumes of that Docker), measured by `du -sx` in the
container. That data is **not** in the writable layer: Sysbox backs the directory with one of its own on the host (`/var/lib/sysbox`) and mounts it
in, and the daemon's size figure for the container is the size of its own layer. A container that takes no exec (frozen for the moment, between the setup
script and the agent) counts for its layer alone at that look. Before #1009 the setup result was committed as an image
(`code-reviewer-agent:environment`) and its added layer was counted instead of the setup container's; nothing is committed any more. The
Docker images of the runner itself and the images and containers of other things on the daemon are not the job's and not counted. When the measure passes the budget:

1. the job process is ended the way a shutdown ends it (the Worker's `JobHost`, the `guard`), and the job is **reported as failed** by the Worker, not given back (it
   would fill the disk again): error code `runner_error`, error reason `disk_budget_exceeded`, and a text that names the budget and what
   was in use;
2. the cleaning that follows every job removes everything it made: the containers and networks of this runner, the folders of `/work`
   and, for a machine updated from an earlier version, the environment image (the name `code-reviewer-agent:environment`, which the setup used to
   commit, so the daemon frees its layers). A hosted VM loses all of this with the VM; a machine would keep it.

**The budget is an emergency brake, not a quota.** The measure is taken every 20 seconds, so a job can write more than the budget
between two looks (the job is ended at the next one, and what it wrote is removed); and some things are **not measured**: **container logs**
(the unit rotates its own; the logs of the job's containers are not counted), what the inner Docker's containers hold in **volumes outside**
`/var/lib/docker` of their container (a bind of the repository is the repository's, measured above), and anything outside the folders, layers and
inner data above. (Until #1009 the inner Docker's data was not measured at all; the measure is a `du` of the data directory in the
container, **not yet proven against a real Sysbox container** in a lane: CI has Sysbox only in the KVM lane, which does not run the process mode
this budget belongs to. The `du` is ended in the container after 50 s, and a measure that does not answer keeps the last size measured;
it runs in a container the job is root of, so a job can make it lie: measuring from the host side is a follow-up.) The budget stops a job that fills the disk; it does not
promise that a job stays below the number, and it is no replacement for keeping free space on the machine.

Without `diskGb` there is no budget and the machine's disk is the limit; the app still shows the free space of `/work` as the disk of the
runner. Choose the budget for the largest job you accept, and keep the rest of the machine's disk free for the images of the runner
(`docker system df` shows them). A measure that fails (a daemon that does not answer) counts for nothing and never ends a job.

What is **still not limited** (a follow-up): the CPU of the model door, the reader, the rule helpers and the runner's own git processes (they
have a memory limit and are small and short), and more than one run at a time.

### Updates (#982)

A runner updates **between two jobs**, never during one, and **never from the app** (decision 9): the app may require a minimum base version
(the claim's `426`; the service says so in its log and switches at once if a release is staged), and that is all it says. Two things are
separate, because the program and the VM artifacts are **root's and read-only for the service** (a VMM that escaped must not be able to change what
every later VM boots from): a **root script stages** a release, and the **service's own restart switches** to it.

```
timer (root, every 6 h) or `sudo factory-runner update`
   └─ the program's manifest ─▶ download the program by name and digest ─▶ verify ─▶ unpack, read share/release.json: which VM artifacts release M it names
      ─▶ the manifest of THAT release M (not the newest) ─▶ download the VM artifacts by name and digest ─▶ verify ─▶ unpack     (no lock held: minutes)
      then, under the switch lock for a few renames: move into releases/<N> and artifact-releases/<M>, ONE write of  pending  (the pair)
service (between two jobs: no job runs, `pending` exists)  ─▶ ends with exit code 10
systemd restarts it ─▶ ExecStartPre=+ host.sh prestart: smoke test ─▶ atomic switch of the links ─▶ table, TAPs ─▶ service starts on the new release
```

**What is checked** (`runner/install/install.sh`, `update`; the same steps as the installer's):

1. the manifest and its signature are fetched (https only, at most 64 KiB for the program and 256 KiB for the VM artifacts); the signature must verify with the channel's key,
   which must be an ECDSA P-256 key, **before one field of the manifest is read**;
2. the program's release number must be **higher** than the installed one, than a staged one, **and than the release a rollback left** (`/etc/code-reviewer/rejected-program`): a signed older
   manifest that somebody serves again is no way back, and **nothing is downloaded for it**. The VM artifacts have no such rule of their own: the program names their release (below);
3. every file is downloaded by the name the manifest gives (a name with a separator, a leading dot or an odd character is refused), its **size and sha256** checked, and a packed file's
   **unpacked size and sha256** too: what `dispatcher/src/vm-artifacts/verify.ts` checks, including that the staging directory holds **exactly** what the manifest names (`--exact-dir`);
   the program tarball is listed before it is unpacked (no absolute path, no `..`, no odd character), and a device, a socket or a link out of its tree is refused;
4. the new table must pass `nft -c -f` on this kernel; the program must carry `bin/factory-runner`, `bin/firecracker`, `libexec/host.sh`, `share/outer-wall.nft` and `share/release.json`;
5. **the pair is the program's statement, not "the newest of both".** `share/release.json` of the verified program names the VM artifacts release it needs, `vmArtifacts`, **exactly**: the installer takes that release with it and no other.
   - It is the VM artifacts that are installed (or staged) already: only the program is staged; a staged VM release of an earlier pair that is not the one named is dropped.
   - Otherwise the manifest of **that release** is fetched (at `<baseUrl>` with `{release}` replaced: "Two release channels") and must verify with the VM channel's key and be that release; the files are downloaded and verified as in 3.
     **A program whose VM release is not published, does not verify or is not the one the address holds is not taken, with nothing changed** (`update` fails and says so; the timer tries again). The owner publishes the VM release first.
   - A program that names an **older** VM release than the installed one is not taken (an update never goes back: that is `factory-runner rollback`), and one that names a release **a rollback left** (or a lower one) waits for a program that names a higher one.
   - **A VM release alone is never taken.** The program names one release, exactly (not a minimum), so a newer VM release changes nothing on a machine until a program that names it is released (a program release is cheap: raise `vmArtifactsRelease` and tag).
   - Only when **both** parts are downloaded and verified are they moved into place (`releases/<N>`, `artifact-releases/<M>`) and `pending` written, **as a pair** (`program=N`, `vm=M`, `pair=1`) in one write.
     A failed stage of the VM artifacts leaves no program staged, and the other way round. A pair is switched together: **a program that fails its smoke test takes the VM artifacts that came with it along** (both are dropped and rejected).

**The locks.** `update.lock` keeps two updaters from staging at once (the timer's and one by hand: the second says "another update is running"). The **switch lock** guards the files that say what is current, previous and
pending; it is held **only for the renames and the one write of `pending`, never for a download**, so a start of the service, `factory-runner rollback` and `factory-runner status` never wait behind a slow or large download of the VM
artifacts, and the service goes on taking jobs meanwhile. The commit asks again, under the lock, whether the release is still one to take (a rollback may have come in during the download: its rejected release is not staged).

**The switch** is the start of the service (`prestart`, as root): for the program, `bin/factory-runner --version` and `bin/firecracker --version` must run as the service user (a release that does not run is
**dropped and rejected**, the current one stays); then `current` and `artifacts` are repointed in one atomic step each (`ln -s` and `mv -T`), the release before becomes `previous`, and releases other than current,
previous and a waiting one are deleted. The unit starts the service through `libexec/host.sh run-service`, which resolves `current` **once** and runs from that directory, so a link that moves later never
changes what a running process imports. Because the script runs from the release, **an update of the program also updates the updater**, and all of it is signed.

**Between jobs.** The service ends with exit code **10** before its next claim when `pending` exists and no job runs (a job in `--once` mode never ends it); the unit restarts it
(`Restart=always`; the app sees a runner that was away for the seconds of a restart). A job that is running is never touched. `factory-runner config set --auto-update off` stops the **timer's** look
(`update --scheduled` reads the setting); `sudo factory-runner update` works either way. Under constant load the service is never between jobs: the release waits (and `systemctl restart factory-runner`
switches now and gives the running jobs back to the queue).

**On the device.**

| Command | What it does |
|---|---|
| `sudo factory-runner update` | stages the newest verified release (both parts) and says so |
| `sudo factory-runner rollback [--now]` | goes back to the release before; the release it leaves is written to `rejected-program` / `rejected-vm`, so neither the timer nor `update` nor the installer takes it or an older one again, and the next **higher** one is taken as usual. It goes back between two jobs; `--now` restarts the service. **With a release staged and not taken yet it cancels that one instead** (and rejects it). After a rollback there is no `previous`: a second rollback says so and does not go forward |
| `sudo factory-runner status` | the current, the previous, the staged and the rejected release of both parts |

**A new release that does not run: the way back.** The smoke test at the switch stops a program that cannot even say its version. A program that starts and then fails is tried again by systemd
(`Restart=always`, `RestartSec=10`; exit code 5 waits five minutes first) and **there is no automatic watchdog** that rolls it back (a follow-up): `sudo factory-runner rollback --now`. If the service
is in a restart loop the next start switches at once, because `rollback` wrote `pending`.

### The program release (#1002)

The program has a release pipeline next to the VM artifacts': `runner-program.yml` builds the tarball, `runner-program-release.yml` signs it and makes a **draft** release. Nothing is published by a workflow: where the files go for the
installers to find them is the owner's decision ("For the owner" below), and until `runner/release-channel.json` has a `baseUrl` and a `publicKey` no runner can install or update itself.

**The tarball** `factory-runner-<N>-x86_64.tar.zst`, a tar in zstd of a relocatable tree (`runner/release/build_program.py`; the tree is what `install.sh` takes, see "What is checked" above):

| Path | Content |
|---|---|
| `bin/factory-runner` | a shell script that finds its own directory with `readlink -f` (the unit starts it through the `current` link) and starts the bundled Python from there: `python/bin/python3 -I -B -c 'from code_reviewer_runner.factory_runner.cli import entry_point; entry_point()'`. `-I`: no `PYTHON*` variable, no user site, no current directory is read; `-B`: the release is read-only and nothing is written next to it |
| `bin/firecracker` | the Firecracker of `docker/vm/pins.env` (the pin the VM artifacts' smoke boot uses too), checked by its sha256; its `LICENSE`, `NOTICE` and `THIRD-PARTY` are in `share/licenses/firecracker/` (Apache-2.0). The jailer and the other tools of the archive are not shipped |
| `share/outer-wall.nft` | `docker/vm/host/outer-wall.nft` of the commit, with `@SLOT_NETWORK@` still in it (the installer renders it) |
| `libexec/host.sh` | `runner/install/install.sh` of the same commit: an update of the program also updates the updater |
| `share/release.json`, `share/licenses/NOTICE.txt` | what this release is: number, commit, **the VM artifacts release it needs, which the installer takes with it** (`vmArtifacts`), the pins (Python, Firecracker, every package with its sha256) and the glibc it needs; and where the licence texts are |
| `share/licenses/third-party/` | the licence texts of the libraries the Python and the `cryptography` wheel are built with (OpenSSL, libffi, zlib, bzip2, xz, SQLite, expat, mpdecimal, libedit, ncurses, libuuid, Berkeley DB), copied out of the archives they came from (`runner/release/licenses/SOURCES.md`) and checked against pinned sha256 by the build |
| `python/` | the standalone Python, `site-packages` with the program and its one dependency |

**How Python ships, and why.** The machine needs no Python, and it must not depend on the one it has.

- **The interpreter** is a standalone CPython (python-build-standalone, `install_only_stripped`, x86_64 glibc; `runner/release/pins.env` pins the version, the release tag, the URL and the **sha256**, compared with the publisher's `SHA256SUMS`). It has its own libpython and OpenSSL built in and needs glibc 2.17 or newer (the oldest tag the wheels below allow; the installer's own floor,
  systemd 247, is higher; it is not for musl, so not Alpine). Its archive holds no licence files of the libraries it is built with: their texts are in `runner/release/licenses/` (copied from the full archive of the same build and, for the OpenSSL the `cryptography` wheel links, from OpenSSL's own source archive that the wheel's SBOM names) and ship in `share/licenses/third-party/`. What the program never runs is taken out: headers, man pages, Tcl/Tk, `tkinter`, `idlelib`, `turtledemo`, `ensurepip`, `pip`, the shared libpython and the test modules.
  Nothing installs into the tree at the machine: no `pip`, no network.
- **The dependencies are `cryptography`, `cffi` and `pycparser`, and nothing else.** The host program is the Dispatcher (the loop, the launcher, the proxy of the outer wall); PR-Agent and the Worker's other dependencies run in the VM's image, never on the host. `cryptography` is the one third-party import (the proxy makes certificates for the setup phase); it brings `cffi` and `pycparser`.
  `build_program.py` reads version and **sha256 of every wheel from `runner/uv.lock`**, takes the wheel for CPython 3.13 on x86_64 glibc that needs the oldest glibc, downloads it, checks the hash and unpacks it (a wheel with a `.data` directory fails the build). **The closure of `cryptography` in the lock must be exactly these three packages**: a new package in the host program is a decision, and the build fails until it is made.
  A unit test holds the command's import closure to the standard library, the package and these three, so an `import httpx` in the Dispatcher fails a test, not the first machine.
- **The program is the package's files at the tagged commit** (`git ls-files runner/src/code_reviewer_runner`), plus a minimal `.dist-info` (so `importlib.metadata` answers the version `--version` prints). It is **not a wheel**: a wheel build asks for `hatchling` unpinned, so two builds of one commit could differ.
- **Byte code is compiled at build time** (hash-checked `.pyc` of the whole library, with a fixed hash seed): the release is read-only, so an interpreter that finds none would compile in memory at every start, and a timestamp-based one would not survive the fixed mtimes.
- **Reproducible tar, tarball for one `zstd` version.** Sorted names, owner root, one mtime for every entry (the commit's time), directories 0755 and files 0755 or 0644 by their execute bit. The same commit and release number give the same **tar** bytes; a new release number or commit is a new tarball (`share/release.json` is in it). The tarball is that tar in `zstd -19` on one thread, which gives the same bytes only for the same `zstd` version (another version may encode the same tar differently). To check a rebuild of a tag against a release, compare the **uncompressed tar** of both: `zstd -dc factory-runner-<N>-x86_64.tar.zst | sha256sum`. Comparing the tarball with the signed manifest's sha256 works too when the rebuild uses the `zstd` version of the release job (the runner image's). The lane builds release 1 twice on one machine (one `zstd`) and compares both.
- **Measured** (the pins of 2026-11-11): the tarball is **22.4 MB**, 83 MB unpacked (the interpreter 31 MB, the standard library and byte code 24 MB, `site-packages` 25 MB of which `cryptography` 16 MB and the package 7 MB, Firecracker 3.7 MB); `factory-runner --version` takes 0.4 s from a read-only tree with an empty environment; building takes under a minute on a development machine. A tarball over 100 MiB fails the lane.

**The manifest and its signature** are the format of "What is checked": `{"version": 1, "release": N, "arch": "x86_64", "file": {"name", "size", "sha256"}}`, signed (`openssl dgst -sha256 -sign`, ECDSA P-256, DER) with the key of the channel. `runner/release/verify-release.sh` checks a release the way a customer's machine does, with the same tools (`openssl`, `jq`, `zstd`, `tar`,
`sha256sum`) and nothing to install: the signature with the channel's key, the manifest's shape, the file's size and digest, the names the installer accepts, no device, socket or link out of the tree, the four parts, the template in `share/outer-wall.nft`, and that `share/release.json` is this number and this commit and names a VM artifacts release (`--vm N`: the one of the pair). The release job runs it on what it is about to publish (`--min-release`, `--exact-dir`).

**The pair is an installer rule.** The installer stages the program and **the VM artifacts release it names** together and switches them together (what is checked: "Updates", item 5). `runner/release/pair.json` (`{"vmArtifactsRelease": M}`) is where the repository says which release that is: the build writes it into `share/release.json` as `vmArtifacts` (the signed tarball carries it, so a signature covers the pair), the verifier checks it, and the notes of the draft say so. **Exact, not a minimum**: a program names one VM release and no other; a minimum would let a VM release the program was never tested with be installed, and would need the order of two numbers to be decided on every machine; the cost of exact (a new VM release reaches machines only with a program that names it) is a program release, which is cheap.
The release job refuses a program whose `vm-artifacts-vM` release does not exist (a draft counts: the owner publishes both), whose manifest does not verify with the key of `docker/vm/release-channel.json`, whose `share/release.json` does not name that release (checked **before** the signature), or that was built from a commit that is not in this commit's history. **Raise `vmArtifactsRelease` in the pull request that needs a newer VM release** (a change of the vm-init or environment-control protocol, of the launcher's expectations of the disks).

**What a release does** (`runner-program-release.yml`, started only by a tag `factory-runner-v<N>`; the same protections as the VM artifacts' release, which was reviewed hard):

1. `number`: the tag is `factory-runner-v<N>` with N a whole number from 1.
2. `guard`: by the API (no checkout), the tagged commit must be **on `main`** (`identical` or `behind`), before anything is built or any key is asked for. The guard stops a mistake; the environment's reviewers and the tag ruleset are the protection.
3. `build` (`runner-program.yml` with `for_release: true`): checks that the tree is the commit, builds the tarball once. **No key, no environment, a read-only token.** The files reach `release` through the **Actions cache** under `program-release-files-<run id>`, never as an artifact (an artifact of a public repository can be downloaded by anybody who is signed in, and a release is not public before the owner says so); the cache is deleted when the draft exists.
4. `release` (environment `runner-program-release`, which waits for its required reviewers): **installs nothing and runs no third-party code**: its steps are `actions/checkout`, the cache's restore and shell on what the runner image has (`gh`, `jq`, `openssl`, `zstd`, `tar`). It checks that the channel names a key and the asset names `runner-manifest.json` and `runner-manifest.sig`,
   that the release number is **higher than that of every other `factory-runner-v*` release** (drafts included), that the VM artifacts release of the pair exists, verifies and is older, **that `manifest.json` and the tarball's `share/release.json` are this tag's release of this commit and name the VM release of the pair** (`commit` is `$GITHUB_SHA`, `release` the tag's number, `vmArtifacts` the pair's), **signs**, verifies what it is about to publish and makes a **draft** release with the tarball, `runner-manifest.json` and `runner-manifest.sig`. The key is the secret `RUNNER_PROGRAM_SIGNING_KEY` of the environment, read in one step that runs with `PATH=/usr/bin:/bin` and the system's `openssl`, `jq` and `base64` by their full path (the one cache the job restores is the build's output, into a fresh directory that is not on `PATH`, so nothing it holds can stand in front of them); the job refuses a key that is not the channel's, and removes the key file after the signature and once more at the end.
   `app/src/ci/runner-program-workflow.test.ts` pins all of this.

**For a pull request**, CI runs the **lane** (`runner/release/lane.sh`, job `runner-program` of `ci.yml`, only for a change to the release tooling, the installer, the pins, the lock, the nft table, the package's command or the workflow): it builds release 1 twice (the bytes must be equal, on one machine with one `zstd`), release 2 (which names the next VM release) and release 3 (which names one that is never published), signs them with a key made for the run, verifies them with `verify-release.sh`, and lets the real `install.sh`
(as root on a GitHub runner with a real systemd and `nft`, https on the loopback with a throwaway CA given through `--curl-config`) install release 1, **stage release 2 as a pair with the stand-in VM artifacts release it names while a much newer VM release exists and is not taken, switch to it (the installer's smoke test runs the real `bin/factory-runner --version` and `bin/firecracker --version` as the service user)**, roll back, refuse to take the release the rollback left, refuse release 3 because its VM artifacts are not published, and uninstall. The stand-in VM artifacts are signed by the tarball's own Python (it carries `cryptography`): the lane fetches nothing from a package index; `nft` is an OS package of the runner image, installed from the distribution's mirror only if the image lacks it. The real program is also run as the service user with an empty environment
and shown not to be able to write its own tree. It installs with no token, so the service is not started (it would need an app to register with and VM artifacts that boot): the installer lane of `vm-artifacts.yml` runs the service with a stand-in program, the launcher lane boots real VMs, and the first install on a real host (below) is the proof of all of it together.

**For the owner** (not in this repository, and not done by this change). Items 1 to 4 are **mandatory** before the first tag; without them the key is protected by nothing but the guard:

1. **Environment `runner-program-release`** (Settings, Environments): **required reviewers** (at least one person who is not the one who pushes the tag), "Prevent self-review", and the **deployment policy "Selected branches and tags" with the tag rule `factory-runner-v*` only** (no branch).
2. **A tag ruleset on `factory-runner-v*`** (Settings, Rules): creating, updating and deleting those tags restricted to the admins / the release owner, no force pushes.
3. **The key.** `openssl ecparam -genkey -name prime256v1 -noout -out runner-program-key.pem`, keep it secret, derive the public half with `openssl pkey -in runner-program-key.pem -pubout -outform DER | base64 -w0`, and put the PEM in the **environment secret `RUNNER_PROGRAM_SIGNING_KEY`** of `runner-program-release`.
   **One key or two** is your decision: one key for both channels means the same PEM in `RUNNER_PROGRAM_SIGNING_KEY` and in `VM_ARTIFACTS_SIGNING_KEY` and the same `publicKey` in both channel files; the cost is that a leak of it lets its holder announce both a program and VM artifacts (the program is the more dangerous of the two: it runs as root at the next start). Two keys cost one more secret and are what the lead recommends.
4. **`publicKey` in `runner/release-channel.json`** (by a reviewed pull request that reaches `main`): the release job refuses a channel without a key. A change of the key is a change of this file, **and every installed runner must run the installer again** (`--refresh`) to take it (see "Known limits").
5. **`baseUrl` in `runner/release-channel.json`**, and **where the files are published** (your decision, with the VM artifacts'): the installer downloads `<baseUrl>runner-manifest.json`, its signature and the tarball, https only, and hard-codes no host.
   - **Protected storage** (the lead's recommendation, and the only choice for the VM artifacts' data disk, which holds the Worker image): any https directory that takes a login the installer can send (`--curl-config`: a header or a client certificate). Copy the **tarball first and the manifest last** (a manifest that names a file not there yet makes an update fail, never install something unverified).
   - **For the VM artifacts' channel** (`docker/vm/release-channel.json`) the address has `{release}` (above): with GitHub, `https://github.com/Itegro-GmbH/code-reviewer/releases/download/vm-artifacts-v{release}/`, each release's own published release, which is stable because the program names the exact number; with protected storage, one directory per release.
   - **A GitHub release has no stable address for the program channel.** `.../releases/latest/download/` is the latest release of the **repository**, which both the VM artifacts and the program share, and `.../releases/download/factory-runner-v<N>/` changes with every release while an installed runner keeps its channel file. If GitHub is used for the program, make **one release for the channel with a fixed tag** (say `factory-runner-channel`, a published release) and replace its assets at every release with the files of the draft:
     `gh release upload factory-runner-channel factory-runner-<N>-x86_64.tar.zst --clobber`, then `runner-manifest.json` and `runner-manifest.sig` last; `baseUrl` is then `https://github.com/Itegro-GmbH/code-reviewer/releases/download/factory-runner-channel/`. The numbered draft stays as the record. The tarball holds only public source and public binaries (Python, Firecracker, `cryptography`), so a public release is no leak of it; it is for the VM artifacts that the question is serious.
6. **The order of every release, the first one included: the VM release first, the program second, the manifest last.**
   1. The VM artifacts release `vm-artifacts-v<M>` (the one `runner/release/pair.json` names) is made and **published at its address** (`docker/vm/release-channel.json` `baseUrl` with `{release}`; see "VM artifacts"): files first, its manifest last.
      The installer fetches exactly that release for the program that names it, so it must be reachable **before** any program that names it is: a program published first is refused by every machine ("not taken") until it is.
   2. A pull request that has `publicKey` and `baseUrl` of both channels reach `main` (the first release only); the tag `factory-runner-v<N>` on a commit of `main`; approve the job in the environment; read the draft (`share/release.json` is in the tarball and says which VM release it names:
      `tar --zstd -xOf factory-runner-<N>-x86_64.tar.zst share/release.json`).
   3. Put the program's files at the program channel's `baseUrl`: the tarball first, `runner-manifest.json` and `runner-manifest.sig` **last** (the manifest is what announces the release). Then the live test below.
   **Raise the numbers only upward**: a program release must be higher than the last (the job checks), and `runner/release/pair.json` names the VM release it needs, which the program's tarball carries.

**Decisions only the owner can make** (also on the checklist of #969): where the files are published (above), one key or two (above), and whether the Worker image's copyleft packages may be handed to customers (`THIRD_PARTY_LICENSES.md`, "Copyleft and distribution", for the VM artifacts). The signing key is the one new secret: losing it stops updates (a runner keeps working); leaking it lets whoever holds it announce a release, so keep it where the other release secrets are.

### Uninstall

`sudo factory-runner uninstall` (or `sudo sh install.sh --uninstall`, and `--dry-run` to read what it would remove), then revoke the runner in the app (its credential keeps working until then). It removes
**everything the installer made and nothing else**, in this order: the service and its update timer (a stop gives a running job back to the queue and kills its VM), the nft table
`code_reviewer_wall`, the TAP devices `fctap0`… of the recorded number, the units and the command, `/opt/code-reviewer`, `/var/lib/code-reviewer` (the VM artifacts), `/var/lib/factory-runner` (**the
configuration and the credential**), `/etc/code-reviewer`, and the user `factory-runner` **only if the installer made it** (`install.state`). A directory that is a mount point keeps its mount and loses its contents.
Another directory in `/opt`, another user, another nft table and the group `kvm` are not touched.

### Tests

Unit (`tests/unit/test_factory_runner_*.py`, `test_runner_profile.py`, `test_install_script.py`): configuration, command, the dispatcher with doubles (the Worker it starts, the claim it gives back, the reaper, the credential of the
device, no secret of a job in its state or its log: `test_factory_runner_dispatcher.py`), the Worker's entry (`test_factory_runner_local_worker.py`), once mode, the loop with a double sandbox (`test_factory_runner_service.py`; its
update cases cover the marker of a staged release: switch between jobs only, never during one, never in `--once`, never for a runner the unit did not start), the self-test with a double daemon, limits, the cleaning between jobs,
and the credential's source. Contract (`tests/contract/test_factory_runner_contract.py`): the runner's real client against a fake App. Integration (`tests/integration/test_factory_runner_loopback.py`): register, announce,
claim, start a real Worker, report. Lane (`tests/lane/…`): the Worker-as-a-process mode on a real daemon (the tests' sandbox of the loop, not an installable mode).

**The installer** (#982, `tests/unit/test_install_script.py` with `host_install_support.py`): `install.sh` runs against stand-ins for every command that needs root (`useradd`, `userdel`, `ip`, `nft`, `systemctl`,
`runuser`, `chown`, `curl`) in a directory that plays the machine's root, with the real `openssl`, `jq`, `zstd`, `tar` and `sha256sum` verifying releases that the test signs with a real ECDSA P-256 key. The cases:
T01 a preflight without `/dev/kvm` stops with the documented message and changes nothing (the tree of the machine is equal, no command ran), and the other stops (no `nft`, systemd 245, cgroup v1, not root, no group `kvm`,
a second dispatcher's unit, user, directory, table or TAP); T02 install, then uninstall, leaves no table, no TAP, no user and no file (the tree equals the one before, other things in `/opt`, `/etc` and other users survive);
T03 an update with a bad signature (program or VM) is refused and the running release stays; T04 a rollback returns to the previous release and the one it left is not taken again, a staged release is cancelled by it, a
rollback without a predecessor says so. Also: the order of the install (check, load, **list**, then the unit and the start), a failed listing fails the install and leaves nothing, the unit's options, `LimitNOFILE` and
`TasksMax` by slots, the artifacts' owner and mode, the token only on standard input, a manifest or file that does not match, a tarball with a path out of its tree or a link out of it, an empty channel, a channel that is not
https, `--refresh` (never restarts a running service, never registers twice, fewer slots remove TAPs), the switch with its smoke test, the pruning of old releases, `prestart` failing without the table and making missing
TAPs, `run-service` with the artifacts' image id, the command's split of root and service user, the scheduled update that honours `--auto-update off`, a script cut off anywhere, and the hidden prompt on a pseudo-terminal.
A sample manifest (`dispatcher/src/vm-artifacts/fixtures/sample-manifest.json`) is parsed by the TypeScript verifier's own schema (`channel.test.ts`) and compared by shape to the manifest of the tests, so the two sides
cannot drift. CI also runs `shellcheck` on the installer.

**The installer lane** (`runner/tests/kvm/installer/lane.sh`, the job `installer` of `.github/workflows/vm-artifacts.yml`, only for a change to the installer or what the VM artifacts are made from): the
real `install.sh`, as root on a GitHub runner, with a **real systemd, a real `nft` and real `ip tuntap`**, a stand-in program (`lane-runner.sh`) and small releases signed with a throwaway key and served over
https on the loopback (`serve.py`; the throwaway certificate reaches the installer's `curl` through `--curl-config`, as a protected release address would). It proves: T01 on the real machine
(a copy of the installer that looks for a device that is not there stops with the nested-virtualization message and changes nothing); that systemd accepts the unit (`systemd-analyze verify`); that **inside the
unit's sandbox, as the service user, the stand-in opens `/dev/kvm`, attaches to its TAP device, makes a cgroup per VM with `cpu.max`, `memory.max` and `pids.max` under its own delegated subtree, writes `vms/` and its home,
cannot write the artifacts, the state directory, the program or `/etc`, has no capability and `NoNewPrivs`, has the file-descriptor limit, and sees the environment the unit sets** (`lane_service.py`: the
result is read from `vms/lane-probe.json`); that a deleted table and a missing TAP device are made again at the next start; an update staged by root (`pending`), the service ending with exit code 10 between jobs and the
start switching to release 2; a rollback with `--now`; a refusal of a bad signature with the release left running; and the uninstall, after which no table, TAP device, user, unit or file is left. No VM boots
there: the launcher lane (the `build` job) has the artifacts and boots them; the first install on a machine of ours remains the proof of the two together.

**The program release** (#1002, `tests/unit/test_program_release.py`, `app/src/ci/runner-program-workflow.test.ts`, the lane `runner/release/lane.sh`): the downloads of the pins are replaced by small stand-in archives in the unit tests (the real pins, a real build and the real installer are the lane), and everything else is real code. T01 the manifest a build makes verifies with the channel's key
(`openssl`, the way the installer does), names the tarball by size and sha256 and has the shape of the installer tests' manifest; another key, other bytes, a key that is not P-256, a changed byte or size, a number that does not grow, a commit that is not the build's and a stray file in the directory are refused. T02 the tarball lists only names the installer accepts and holds no device, socket
or link out of its tree (the build refuses such a tree, and the verifier refuses such a tarball, each tested with a forged one); the four parts are the repository's files; the launcher starts the bundled interpreter; the build's tar is reproducible (and a new number or commit is a new tarball); every entry has owner root, one mtime and a normalised mode. T03 the unchanged installer
installs, updates and rolls back the programs the build made (a fake machine), and the lane does the same on a real systemd. T21 the pair is the installer's rule: a program is staged with the VM artifacts release it names, not the newest, and a program whose VM release is not published, does not verify or is the wrong one is not taken (`test_install_script.py`); the verifier and the build hold `vmArtifacts`; the workflow checks the manifest and `share/release.json` before the signature and signs with the system's `PATH`. T22 the licence texts of the bundled libraries are the pinned copies, ship in `share/licenses/third-party/`, and are listed in both copies of `THIRD_PARTY_LICENSES.md`. Also: the command's imports are the standard library, the package and `cryptography`; the wheels come from the lock with its hashes and the oldest glibc; a new dependency of `cryptography` is refused; the pins carry a checksum and a wrong one is refused. The TypeScript test pins the workflows: the key in
one step of one environment, a draft only, nothing installed in the job that holds the key, the pair check before the signature, the guard, the cache and not an artifact.

### First install on a real host (the live test)

What the unit tests cannot know and the first install must check (the installer lane of CI covers what a stand-in program can show; a real VM needs the released artifacts):

1. **Preflight on a machine without KVM** (a cloud VM without nested virtualization): the installer stops with the message about nested virtualization and `ls /etc/code-reviewer` is empty.
2. **The install on a terminal:** `curl … | sudo sh` asks for the token with the input hidden. Afterwards `systemctl status factory-runner`, `nft list table inet code_reviewer_wall`, `ip -br link show type tun`
   (one `fctapN` per slot, in state UP with the `/30` address), `ls -l /var/lib/code-reviewer/artifacts/` (`root root`, `-rw-r--r--`), `id factory-runner` (group `kvm`).
3. **The unit's sandbox with real Firecracker.** `journalctl -u factory-runner` shows the service ready (the host checks of `prepare_firecracker`: kernel, root file system, base disk, `firecracker`, `/dev/kvm`, the
   delegated cgroup with `cpu memory pids`, the TAP devices). Then one real job: a VM boots (the launcher opens `/dev/kvm` and `/dev/net/tun` under `DevicePolicy=closed`, makes `vm-<slot>-<id>` cgroups
   under the unit's own subtree with `ProtectSystem=strict`, writes `vms/`) and ends, and `systemd-cgls` shows nothing of it left. **If a sandboxing option is wrong the service fails at the first VM, and the log says
   which write was denied**: remove the option from `write_units` and say so. Try `ProtectControlGroups=yes` and `ProtectKernelTunables=yes` on the real host and report whether the delegated subtree stays writable.
4. **The outer wall at every start:** `sudo nft delete table inet code_reviewer_wall && sudo systemctl restart factory-runner` loads it again; with `nft` removed from the path the start fails with "is not loaded" and the
   service does not run. After a restart of the machine the TAP devices and the table are back before the service (`prestart`).
5. **Limits:** `systemctl show factory-runner -p LimitNOFILE -p TasksMax` and, with the slots busy, `ls /proc/$(pidof -s python3)/fd | wc -l` stays well below the limit.
6. **A real update and rollback:** publish two releases, `sudo factory-runner update`, check `pending`, let the service end between jobs (or `systemctl restart`), `factory-runner status` shows the new current and the old
   previous; `sudo factory-runner rollback --now`, wait past the first timer run: `current` stays on the earlier release; announce a third and watch it taken. A bad signature (sign with another key) must be refused with `current` unchanged.
7. **A program that does not start** (a release whose `bin/factory-runner` fails): `status` after the switch shows it dropped and rejected, the old one still current.
8. **`reflink`:** on an XFS volume with `reflink=1` no warning, and `cp --reflink=always` of the base disk takes tens of milliseconds; on ext4 the warning appears.
9. **Uninstall:** afterwards `nft list tables`, `ip link`, `getent passwd factory-runner`, `ls /opt /var/lib /etc/code-reviewer` hold nothing of the runner.

### Security notes

- **Every job runs in its own Firecracker microVM** with its own kernel; the agent's Docker, Sysbox and the setup container are inside it. The host has **no Docker** for the runner: no socket to hand out, nothing for a container escape to reach on
  the machine's own daemon. The VM's network is the **outer wall**: its TAP can reach only the dispatcher's proxy ([The outer wall on a customer's machine](#the-outer-wall-on-a-customers-machine-979)); the host's other ports, the LAN,
  the metadata address and IPv6 are dropped by a static table the installer loads and the service re-checks before every start.
- **Without the jailer a VMM that escaped lands in the service user.** What is done is Firecracker's own seccomp filter and no capability (measured), a directory per VM made `0700`, an empty environment, one cgroup per VM that kills its whole tree,
  and the unit's sandbox (above). The service user owns the other jobs' disks and the credentials of the device: **run the runner on a machine that holds nothing you cannot lose**, and keep the user for the runner alone (the installer refuses an
  existing one). **The kernel and the root file system every later VM boots from are root's and read-only for that user**, as is the program: an escaped VMM cannot plant itself in the next VM.
- **What the root script trusts.** The installer and the updater verify a **signature over the exact bytes of a manifest with the channel's key (ECDSA P-256), then every file's size and sha256** before anything is unpacked or made current; the channel files are
  copied into root-owned `/etc/code-reviewer/` so a setting on the device cannot redirect an update; the tarball is checked for paths and links out of its tree. The first run trusts the installer script and the two channel files fetched from the repository over
  https (as any `curl | sh` does): **read it first, or save it and read it** (it is one POSIX file). Everything after that is signed: the script that runs as root later is the one in the signed program release. A stolen signing key lets its holder announce a release; the
  rollback memory and the "never an older release" rule limit a replayed manifest to a freeze (a manifest has no expiry yet: a follow-up).
- **The token** is never an argument and never in a file of the installer; the credential of the runner is in `/var/lib/factory-runner` (`0700`, the service user's): revoke the runner in the app if the machine is lost. A download login (`--curl-config`) is in `/etc/code-reviewer/download.curlrc`, `0600`, root's.
- **The download credentials of a protected release address** are used by root only (the timer's update), never by the service.
- **The host's firewall.** Only our table `inet code_reviewer_wall` is added, and only rules on `fctap*`: no other table of the machine, no `ip_forward` change and no Docker rule is made, and the uninstall deletes the table.

### Known limits

- **The network of the slots is chosen from what the machine knows.** The installer sees the addresses and routes the machine has; a `/24` inside a larger range that the machine reaches only through its default route
  (an AWS VPC whose subnets are not in the route table, a LAN behind a gateway) cannot be seen, and the candidates are ranges such networks rarely use. If a VM's traffic to the proxy fails or a host in the chosen range
  is unreachable from the machine, name another network with `--slot-network` on an `--uninstall` and a new install (the network is part of the install, not a setting to change later).
- **The outer wall is gone between two checks.** The wall timer looks every 10 seconds; between a flush of the rules and the restart a VM that is running has no table between it and the host's network for up to those 10 seconds
  and the time of a stop. A missing **rule** never opens the wall (the last rule of each chain drops what is ours and the file loads in one transaction); only a missing **table** does.
- **No watchdog for a bad update.** A release that passes the smoke test at the switch and then fails is tried again by systemd every few minutes, and the operator rolls back by hand
  (`sudo factory-runner rollback --now`, see "Updates"); rolling back by itself and rejecting the release when the new program ends with an error within N minutes is a follow-up.
- **The manifest has no expiry (freeze attack).** The signature proves that a manifest is ours, not that it is the newest: whoever controls the
  address can keep serving an older signed manifest (a runner never goes below the installed release, so this only *freezes* it, and the
  app's minimum base version still forces an update where it matters). A signed `expires` date in the manifest, checked by the installer, would close it; it is a follow-up.
- **Rotating the release key** is a new channel file and the installer run again (`--refresh`): a runner whose stored channel has the old key cannot verify a manifest signed with the new one, and so does not
  update until its operator runs the installer (the channel lives in `/etc/code-reviewer/`, outside the release, so that a release cannot redirect its own updates). A fleet needs a channel file inside the
  signed release that the switch takes over: a follow-up.
- **The installed script is the release's.** `libexec/host.sh` runs as root and comes from the signed program; the installer that is run first (`curl | sh`) is the only unsigned step (see the security notes).
- **No resume of a half download.** A download that fails starts the file again at the next run; the staging directory is removed. Two releases of the VM artifacts (current and previous) take about twice their size on disk.
- **`--parallel-runs` is fixed at install** (`--refresh` changes it; `factory-runner config set --parallel` still refuses more than one). A change takes effect when the service next starts (`prestart` makes the TAP devices).
- **The disk budget is an emergency brake** (measured every 20 seconds; the inner Docker of Sysbox is counted by a `du` in the container, container logs are not; see "Limits").
- **One dispatcher per machine.** The launcher takes a lock on `/var/lib/code-reviewer/dispatcher.lock` (a second dispatcher, `run --once` included, ends with exit code 9) and the installer refuses a second install. The
  host has no Docker for the runner, so there is no daemon to share (the fixed container names and the one-runner-per-daemon rule of R2 belong to the process mode of the tests).
- **Snapshot and stored session.** Resume works on customer runners (#879, #974, "Resume on customer runners"): the Worker sends `PUT .../session` and `GET .../resume-session` to the Worker API when
  the app lists `implementer_snapshot`. Against an app that does not list it a turn on a runner takes **no snapshot** and a follow-up turn continues from the summary of the earlier ones
  (the fallback of the plan).
- **SIGTERM during the self-test** (N4) comes before the signal handlers are installed and ends the process at once; nothing is claimed.
- **No warning for a `config.json` that is too open** (N5): the file is written 0600 in a 0700 folder, but a mode changed later is not noticed.
- **`proven` under `runc`** (N6, the process mode of the tests only): on an installed machine the agent is in a VM with Sysbox, and the self-test is the host checks of `prepare_firecracker`.
- **No proxy for the app client** (N7): the runner talks to the app directly (`HTTPS_PROXY` is not read). The installer and the updater's `curl` use the proxy of the environment (`https_proxy`, `no_proxy`; `sudo` may drop them: `sudo -E`).
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
- **Your login** is a token you make with `claude setup-token` and keep on the device, in the **credential store** of the runner (below). Older ways
  still work **only while the store is empty** (one source for the self-test, the readiness and the jobs: once the store holds a credential the others are not read): a file `claude-code-token` in the runner's home (`$FACTORY_RUNNER_HOME`), or the file named by
  `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`, or `CLAUDE_CODE_OAUTH_TOKEN` in the runner's environment. **Only the dispatcher reads these places**, once per job
  that asks for the login; the Worker and the job process never get `FACTORY_RUNNER_HOME` or the file's name (their environment is made by
  `prepare.job_environment`, a test holds it), so there is no second token file to take precedence: the one credential travels on the Worker's standard input
  (`localCredential`, the same shape in a process and in a VM), and the Worker takes **only** `CLAUDE_CODE_OAUTH_TOKEN` from it. A file must be a plain file (no link) that only its owner can read (mode 0600). The token **is never stored in our app or
  database, never sent to the app and never written to a log** (the runner's log masks it). It is handed to Claude Code's process in the job's
  container for the length of the job, and to nothing else.
- Add it, then look: `factory-runner selftest` shows the login, the layer and the version without calling a model;
  `factory-runner selftest --with-claude-code` runs one tiny real turn on your subscription (a few cents) so that you know the login works.

### Credentials (#980)

Make a token on any machine where you are signed in to Claude, with `claude setup-token`, and give it to the runner **from the standard input** (there is no option that takes it as an argument, so it is
in no process list and no shell history):

```sh
claude setup-token                                            # prints the token once; copy it
factory-runner credential add claude --name work              # paste it, then Enter (the input is hidden at a terminal)
factory-runner credential add claude --name spare --models opus,sonnet < token-file    # or from a file or a pipe
factory-runner credential list
factory-runner credential remove spare
factory-runner credential add claude --name work --replace    # exchange the token of a name (after a 401, or a new one); the models stay as you gave them
factory-runner credential retry work                          # let go of everything held against it (limited, refused, models set aside) and use it now
```

| What | How it is |
|---|---|
| Name | Only on this device (log, `credential list`). Never in the app, never in an announcement. |
| Models | The models its subscription allows, given with `--models` when you add it (`sonnet`, `opus`, `haiku` by default; ids such as `claude-opus-5-5` too). An alias covers the ids it stands for. Announced to the app so that a job asks only for what you can run. |
| Several | Add as many as you have. A job gets **one**, the one that is not rate limited, not refused and allows the job's model, the one unused longest first; the others never leave the store. |
| Where | `<runner home>/credentials/` (mode 0700): `index.json` (names, creation time, the models as you gave them, the hints; **no value**) and one `<name>.secret` file each (mode 0600, owned by the service user; a file that others can read, or a link, is refused). A reader takes a shared lock on `.lock` (a link in its place is refused) so that a `credential add --replace` in the middle of a read is seen whole. |
| At rest | **Sealed with `systemd-creds`** (`systemd-creds --user encrypt`, the token on its standard input, bound to its name) **when that works for this user**; otherwise the token is a **plain file that only its owner can read**, like an SSH key, and `credential list` says `plain`. `FACTORY_RUNNER_CREDENTIAL_STORAGE` is `auto` (the default: seal when possible), `systemd-creds` (refuse to fall back to a plain file) or `plain` (never ask `systemd-creds`). The key of the user's own `systemd-creds` is systemd 256 and later; on an older systemd (Ubuntu 24.04 ships 255) every credential is a plain file today. **What the seal is, and is not:** it protects the file **at rest** (a copied disk, a backup, a stray read of the file by another account). The dispatcher decrypts without a passphrase, so **any code that runs as the service user can decrypt it too**; it is not a defence against that user, and the sealed path has **never been run against a real systemd 256 or later** (only against a fake: follow-up #997). |
| Never | Sent to the app, written to a log (the dispatcher's masker knows it from the moment it is chosen), put in an argument, or copied from `~/.claude/.credentials.json`: that file refreshes itself against Anthropic's endpoint, and the host and a VM would invalidate each other's copy. |

**What the dispatcher does with them** (it reads the store before every claim, so adding, replacing or removing needs no restart):

- **The app learns only the entry**: `claude-code`, `auth: subscription`, the models of the credentials that can be used now. Never a name.
- **What a job's end says is a hint that expires** (below, why): none of the three is held for good, `credential retry NAME` lets go of all of them, and your list of models is never changed by them.
- **Rate limited** (the subscription's usage limit ended a job): that credential is put aside for **one hour** and tried again after it; the job that met the limit ends `subscription_limit` (**it fails, free; it
  does not move to another credential in the middle of its run**). With another credential the next job simply gets that one. **When every credential is rate limited the entry is withdrawn from the manifest**,
  so the app stops offering the device Claude Code jobs, and **it comes back by itself** when one credential is usable again. `credential list` shows `rate limited until <date> HH:MM`.
- **Refused** (a 401: the token expired or was revoked): the job ends `subscription_auth`, that credential is put aside for **six hours** and then tried again (a token that is really dead fails one more job and
  is put aside again). To end it for good, replace the token (`credential add claude --name NAME --replace`: the hints are forgotten and the models stay as you gave them); to try it now,
  `credential retry NAME`. The entry is withdrawn while no other credential is usable.
- **A model the subscription does not allow**: the job ends `subscription_model_refused` and **that model id** is left out of the credential's offer and of the announcement for **six hours**, then comes back.
  The list you gave stays as it is: an entry is left out only when it equals the refused id; an alias such as `opus` is not left out by one refusal of `claude-opus-5-5` (other ids of the family may be allowed),
  but is once two different ids it covers are refused at the same time. The listing says which models are set aside and until when. A job for a set-aside id that still reaches the device is given back
  unstarted (and backs the claims off, above). *How Claude Code reports it has not been measured against the real program* (the status 404 and the sentence "issue with the selected model" in Claude Code's own
  `errors` are what is read; a different answer ends the job as an engine failure and nothing is set aside; follow-up #996).
- All three are **free** for you: nothing of ours was used and nothing is billed for a subscription.
- **Why hints and not verdicts.** The verdict reaches the dispatcher as the Worker's exit code, which comes from the `result` event on Claude Code's standard output. The agent's commands run as the same user
  as Claude Code inside the container, so they can, as far as we can tell (not tried), write a `result` line into its pipe or ptrace it: **the verdict can be forged from inside the sandbox.** Nothing cheap prevents it. What holds: the forged
  exit code can only be 20, 21 or 22 (the Worker maps nothing else), it never carries a value, and the dispatcher's reaction is bounded as above. What does not hold: a different user for the tool processes
  than for Claude Code (the tools are Claude Code's children), `no-new-privileges` (it does not stop a same-user ptrace) and a read-only `/proc` (the same user still opens its own process' descriptors). So the damage a
  forgery does is to put **your own** credential aside for hours; it cannot reach another credential, the app or another user.
- **The agent still gets the token in its environment**, as in R3 (Claude Code needs it there, and its tool processes inherit it and can read `/proc/<pid>/environ`). What limits what it can do with it is the
  outer wall (#979: the sandbox's one connection goes through the host proxy); until that wall is in, a job on this device can send the token anywhere the sandbox can reach. The token is an inference-only token
  of your own subscription (`claude setup-token`), not a login with account rights.

**Running `claude setup-token` in a throwaway sandbox** (so that the host needs no Claude installation; follow-up #995) is **not built here, on purpose**: the command is interactive (it prints an address, you sign in with
Anthropic in a browser and paste a code back), and the VM of #978 has no interactive channel (vm-init takes one start and reports one end over vsock; there is no terminal and no way to type the code into
it) and no outer wall yet (#979) to give it the one connection it would need. Doing it properly means a new request type of vm-init (a pseudo-terminal over vsock) and a wide-for-the-sign-in rule of the
proxy; that is a follow-up of #979 and #978. Until then: run `claude setup-token` anywhere you are signed in (your laptop is fine) and paste the token into `credential add`.

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
limits, are between you and Anthropic: when the subscription's limit is reached the job ends with `subscription_limit` and the dispatcher puts that credential aside (see "Credentials"). The minutes of a run on your
runner are counted as for any other run today; whether runs on your own subscription and device should be free of them is not decided,
and this page will say when it is.

### Anthropic's terms

Using Claude Code with your subscription is subject to **Anthropic's terms**, and they are yours to read and keep: the **Consumer Terms of
Service** (for Free, Pro and Max accounts, https://www.anthropic.com/legal/consumer-terms), the **Commercial Terms of Service** (for Team,
Enterprise and API use, https://www.anthropic.com/legal/commercial-terms), the **Usage Policy** (https://www.anthropic.com/legal/aup) and
Claude Code's own "Legal and compliance" page in Anthropic's documentation. They decide, among other things, what you may do with a
subscription token and how automated use is counted. **We do not claim that Anthropic has approved unattended or automated runs on a
subscription** (plan question S3, "ordinary use": a runner that takes jobs by itself, day and night, is unattended use); that question is open with Anthropic, and until it is answered you
use your subscription this way on your own responsibility. What the design does hold to: the token lives only on your device (sealed with `systemd-creds` where possible), is made by Anthropic's own
`claude setup-token` flow, is never collected, stored or passed on by our app or its database (the terms forbid developers to "collect, store, or intermediate Claude.ai credentials or session
tokens"; that is why subscriptions are only for a runner on your own machine and never for the hosted dispatcher), and several credentials are for the **same person's** subscriptions, spread
so that one does not hit its limit first: sharing one login among people, or reselling one, is against the terms and is not what this is for.
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
| Login | `login.py` | The first usable credential of the store (`credentials.py`, #980) as soon as the store holds one, and then no other source; while it is empty: the token from `FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`, else `claude-code-token` in the runner's home, else `CLAUDE_CODE_OAUTH_TOKEN` in the runner's environment. A file must be a plain file, not a link, readable only by its owner (0600), one token on one line. A problem is described in words, never with the value. |
| Layer | `layer.py` | The install layer, **built on the device** on top of the agent image through the Engine API (`DockerApi.build_image`) and cached under `code-reviewer-agent-claude-code:<version>-sha512-<digest prefix>-<base id>` (verified) or `...:<version>-unverified-<base id>`; the tag **and** the labels (`com.code-reviewer.claude-code`, `.integrity`) say which, and `find_layer` compares both, so an unverified layer is never taken for the pinned one. The pinned version (2.1.311, the npm `stable` of the R0 spike): its **npm package, which is only a stub**, and the **platform package that holds the program** (`@anthropic-ai/claude-code-linux-x64` or `-arm64`, the glibc builds; the agent image is Debian) are each fetched as a tarball by `npm pack` and **accepted only with their own pinned SHA-512** (`CLAUDE_CODE_INTEGRITY`, `PLATFORM_INTEGRITY`), checked with `sha512sum -c` under `set -e` so a changed digest fails the build; then both are installed from the two files with `npm install --offline`, so npm resolves nothing from the registry on its own. The architecture is the one of the daemon's machine (`uname -m`); a machine of another architecture or libc has no pinned program and cannot build the pinned layer. The layer's labels carry a fingerprint of the platform digests (`com.code-reviewer.claude-code.platform`) and the tag a short form of it, so a layer built when only the stub was pinned is not taken for the pinned one and is built again. The program must report the version, and the user `agent` is made. The device may choose another exact version (`FACTORY_RUNNER_CLAUDE_CODE_VERSION`; no digest to compare then, for neither package; the pinned version named there keeps its digest checks). We never publish or ship Claude Code. |
| Agent | `agent.py` | `ClaudeCodeAgent`: the surface of `ImplementerAgent` (`start`, `turn`, `stop`, `steps`, `session_id`, `resume`, `step_notes`) for a process-per-message engine. A turn is `claude -p` as an exec in the agent's container (`AgentContainer.run_streaming`), the lines go to the step feeder as they come, the end is the `result` event. A second message is `--resume <id>` in the same container. An empty session volume ("No conversation found", said in `errors`, with no model call) starts a fresh session under the same id and reports `summary_only`. Failures: budget exhausted = `cost_limit_reached`, no login or an expired or revoked token (the `authentication_failed` error, status 401) = `llm_auth`, the subscription's usage limit (`rate_limit`, `billing_error`, status 429 or 402) = `llm_quota`, no result = `implementer_engine_unavailable` with the exit code. |
| Finish tool | `agent.py`, `result_channel.py` | The same stdio shim as OpenCode's (`factory-submit mcp`), written into the container with the schema, named to Claude Code as the MCP server `finish` (tool `mcp__finish__submit_result`). The server validates; Claude Code does not. |
| Manifest | `readiness.py`, `factory_runner/prepare.py` | `claude-code` is announced, with `auth: subscription`, when the layer is on the daemon (a start builds a missing one, the `selftest` command only looks) **and** the dispatcher's pool finds a credential that can be used (#980: readiness is decided from the layer alone, the pool decides the entry before every claim, so a credential added after the start is offered with no restart); when not it is left out of the announcement, with a note in the log (#973: an entry exists only while it can run). A device with no credential yet is ready by its layer, builds it at its start and says in its log that it has no login. It is added beside OpenCode (`auth: app-key`), never instead, and only on a machine whose base holds. |

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

**Routing.** The claim of a customer's runner takes a turn only when an entry of its manifest has the harness of the turn's profile, the auth (`claude-code` asks for
`subscription`) and the model (#973: `accessRule` in `app/src/runner-identity/access.ts`, which replaced the harness test of #856); the platform's claim has no subscription entry, so
it never takes a turn on `claude-code`. A runner that does not announce `claude-code` as a `subscription` (or whose entry does not list the model), because its login is gone or it
withdrew the entry, leaves the turn queued for one that does.

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
4. **Docs for customers, including Anthropic's terms** (done: "Claude Code with your subscription" above; credentials in #980). **Open with the owner**: plan S3, the
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
9. **An environment with a setup script on this harness** (still refused with `subscription_setup_script`; since #1009 the script would run in the harness's own container, which the agent keeps, so there is no longer an image to put a layer on).

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
6. **Customer runner and hosted.** Claude Code runs on customer runners only; since #974 their Worker uses the Worker API's snapshot calls (`/api/workers/v1/jobs/{id}/session`, `/resume-session`)
   like any Worker, and the hosted Dispatcher never claims a turn on this harness (it asks for a `subscription`, which only a customer's runner announces).
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

## Spike: Firecracker sandbox (#970)

Runner v2 (epic #969) runs the **same VM content as hosted** on a customer's Linux machine: a Firecracker microVM with our kernel
and root file system, and inside it dockerd, Sysbox 0.7.1 and the unchanged Worker image. This spike proves that it works and
measures it, before #975 to #979 build it. **All seven questions of the issue are answered below with numbers; none is blocked.**
The decisions that follow from it are at the end ("What the build issues must do differently").

**Where it was measured.** A throwaway workflow on the branch `spike-970-firecracker` (never merged; this server has no
`/dev/kvm`): GitHub-hosted `ubuntu-24.04` runners, 4 vCPU (AMD EPYC 9V45) and 16 GB RAM, which expose `/dev/kvm` through nested
virtualization on Azure (host kernel 7.0.0-azure, systemd 255, cgroup v2). Every number comes from there: **nested
virtualization is slower than bare metal and the runner VMs differ from run to run**, so times are given as median (min to max) of
five boots in one run, plus the spread over the six runs of this work where it matters. The final run, with the logs of every
test case: [run 42876336293](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293) (job
[Experiments on a KVM runner](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714), steps named after the test
cases); its artifacts hold the console log of every VM, the JSON of every check and the nft counters. Scripts, workflow and the
kernel fragment: [`spike/firecracker/`](https://github.com/Itegro-GmbH/code-reviewer/tree/spike-970-firecracker/spike/firecracker)
on the branch, commit `a9e0964f1fd06f04df3e14c28f1e7a62a4d76e14`; the pins are in `versions.env`.

### What was built

| Part | Content |
|---|---|
| Firecracker | **1.17.0**, release tarball, no `jailer`, started as the user `fcuser` (group `kvm`) |
| Guest kernel | **Linux 6.18.62** (the hosted VMs run 6.18.56), Firecracker's recommended `microvm-kernel-ci-x86_64-6.18.config` of the same tag plus our fragment (below); everything built in, no modules; `vmlinux` 26.5 MiB, **566 s** to build on 4 cores |
| Root file system | read-only ext4 (632 MiB, 170 MB as zstd) of **Ubuntu Base 26.04.1** (the golden snapshot's base) with Docker **29.1.3** (static bundle), Sysbox **0.7.1** (the golden snapshot's package and checksum), and `docker/sandbox/vm-prepare.sh` and `sysbox-prepare.sh` **unchanged** |
| Job disk | ext4 with Docker's data root and the images (busybox, hello-world, `docker:29.1.3-dind`: 752 MiB file system, 463 MiB allocated), made per job by a copy of the base |
| Guest init | PID 1 is `docker-init` (tini, from the Docker bundle) running a 40 line shell script; the vsock agent is a Python script (the real `vm-init` is #977) |
| Pins | every download is pinned by version **and** sha256 in `versions.env` (Firecracker, its guest config, the kernel source, Ubuntu Base, Docker, Sysbox, moby's `check-config.sh`, the three images by digest); the scripts refuse a file with another checksum |

### Test cases

| Case | What | Result | Log |
|---|---|---|---|
| T01 | Sysbox container with an inner `docker run hello-world` inside a Firecracker VM, a plain `runc` container next to it | passes (11 of 11 checks); inner dockerd ready 1.5 s after `docker run` | [step 10 "T01"](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714#step:10:1) |
| T02 | the guest cannot reach the host's own address, an RFC1918 address or `169.254.169.254`, and can reach the proxy port | passes: 16 probes blocked that the control reached, the proxy reachable | [step 12 "T02 control"](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714#step:12:1), [step 13 "T02 wall"](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714#step:13:1), the table in [step 18 "Report"](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714#step:18:1) |
| T03 | a vsock round trip host → guest → host | passes (7 of 7 checks); 0.6 ms median per request | [step 11 "T03"](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42876336293/job/130041033714#step:11:1) |

### Q1: the guest kernel

Firecracker's recommended 6.18 config already has most of what Docker and Sysbox need: user namespaces, overlayfs, cgroup v2 with
BPF device control, veth, bridge, nf_tables with `nft_compat`, vsock, FUSE, TUN, seccomp. The build **merges the fragment below
and fails when an option did not end up with the requested value** (a dropped option, an unmet dependency, is the usual way a
hand-written fragment fails: `BRIDGE_VLAN_FILTERING` was caught like that on its first try). 23 options differ from Firecracker's
base, and the first one is the one that mattered:

| Option | Why |
|---|---|
| `RT_GROUP_SCHED=n` (**Firecracker's config has `y`**) | with it, the `cpu` controller **cannot be enabled for child cgroups** (EINVAL) while a real-time kernel thread (`migration/N`, `ksoftirqd`) sits in the root cgroup. `vm-prepare.sh` then fails (`cgroup_root_busy ... Invalid argument`), no Docker, no Sysbox. Found by the first boot with Docker; the hosted kernel presumably has it off, as the hosted VM runs the same script |
| `IKCONFIG`, `IKCONFIG_PROC` | `/proc/config.gz`: moby's `check-config.sh` and Sysbox read it |
| `NF_TABLES_INET`, `NF_TABLES_NETDEV`, `NFT_MASQ`, `NFT_REDIR`, `NFT_REJECT`, `NFT_LOG`, `NFT_LIMIT`, `NFT_FIB`, `NFT_FIB_INET`, `NFT_FIB_IPV4`, `NFT_FIB_IPV6` | an nftables that can express what iptables-nft (Docker's firewall in the guest) and the host-style `inet` rules need. The inner Docker in the Sysbox container ran on `iptables-nft` (`iptables v1.8.11 (nf_tables)`). **Docker 29's own nftables backend was not switched on**: the options are there, the backend is unproven |
| `NETFILTER_XT_MATCH_COMMENT`, `_MULTIPORT`, `_MARK`, `_STATE` | matches the iptables rules of Docker and the inner Docker use |
| `IP_NF_RAW`, `IP6_NF_RAW` | listed as "generally necessary" by `check-config.sh` for Docker 29 (the `raw` table) |
| `DUMMY`, `MACVLAN`, `CGROUP_MISC` | Docker's macvlan driver, the `misc` cgroup controller; added as cheap precautions, **nothing measured depends on them** |

The rest of the fragment lists what the base already had (namespaces, `USER_NS`, cgroups and their controllers, `CGROUP_BPF`, seccomp
filter, overlayfs, ext4, FUSE, veth, bridge, conntrack, NAT, masquerade, vsock, virtio): the verification keeps it from silently
dropping out when the base config or the kernel version changes.

After that, `check-config.sh` (moby, pinned) in the guest reports every "generally necessary" option enabled except `NETFILTER_XT_MATCH_IPVS` (it belongs to IPVS, Docker's
Swarm load balancing, not built), and as missing only optional ones: IPVS, SCTP, AppArmor, the encrypted overlay network's crypto, `ipvlan`, FTP/TFTP connection
tracking, btrfs, zfs.
**Idmapped mounts** (what Sysbox 0.7.1 uses on a kernel ≥ 5.12; shiftfs is the alternative) work: sysbox-mgr logs `ID-mapped
mounts supported by kernel: yes`, `Overlayfs on ID-mapped mounts supported by kernel: yes`, `Shiftfs module found in kernel: no`.
The kernel needs no option for it; 6.18 has it. Nothing needs modules: there is no `/lib/modules` in the guest, and Sysbox only warns that it has no kernel headers and no modules to mount into containers.

The fragment, verbatim (`spike/firecracker/kernel/config.fragment`):

```
## Spike #970: what the Firecracker guest kernel (6.18 LTS) needs on top of Firecracker's recommended
## microvm config (microvm-kernel-ci-x86_64-6.18.config, tag v1.17.0) for Docker, Sysbox 0.7.1 and the VM's job.
## Lines starting with "##" are explanations. kernel/build.sh merges this file with `merge_config.sh`, runs
## `make olddefconfig` and FAILS when one option below did not end up with the value given here (a silently
## dropped option is the usual failure of a hand-written fragment: an unmet dependency).

## --- introspection: Sysbox and Docker's check-config.sh read /proc/config.gz
CONFIG_IKCONFIG=y
CONFIG_IKCONFIG_PROC=y

## --- namespaces and cgroup v2 (runc, Docker, Sysbox's nested containers)
CONFIG_NAMESPACES=y
CONFIG_TIME_NS=y
CONFIG_PROC_CHILDREN=y
CONFIG_UTS_NS=y
CONFIG_IPC_NS=y
CONFIG_PID_NS=y
CONFIG_NET_NS=y
CONFIG_USER_NS=y
CONFIG_CGROUPS=y
CONFIG_MEMCG=y
CONFIG_CGROUP_PIDS=y
CONFIG_CGROUP_SCHED=y
CONFIG_FAIR_GROUP_SCHED=y
## MUST be off: Firecracker's recommended config has RT_GROUP_SCHED=y, and with it enabling the `cpu` controller for child cgroups
## fails with EINVAL as long as a real-time kernel thread (migration/N, ksoftirqd) sits in the root cgroup. vm-prepare.sh (the
## hosted VM's cgroup script) then fails: "cgroup_root_busy ... Invalid argument", Docker never starts, Sysbox cannot start.
CONFIG_RT_GROUP_SCHED=n
CONFIG_CFS_BANDWIDTH=y
CONFIG_CGROUP_CPUACCT=y
CONFIG_CPUSETS=y
CONFIG_CGROUP_DEVICE=y
CONFIG_CGROUP_FREEZER=y
CONFIG_CGROUP_BPF=y
CONFIG_BPF_SYSCALL=y
CONFIG_BLK_CGROUP=y
CONFIG_CGROUP_MISC=y
## runc on cgroup v2 limits devices with a BPF program; sysbox-runc and runc need these
CONFIG_SECCOMP=y
CONFIG_SECCOMP_FILTER=y
## Sysbox intercepts mount, umount, chown, ... with the seccomp "user notification" (SECCOMP_FILTER, 5.0+)
CONFIG_CHECKPOINT_RESTORE=y
CONFIG_KEYS=y
CONFIG_POSIX_MQUEUE=y
CONFIG_BINFMT_MISC=y
CONFIG_PROC_FS=y
CONFIG_PROC_SYSCTL=y
CONFIG_SYSFS=y
CONFIG_INOTIFY_USER=y
CONFIG_FHANDLE=y
CONFIG_EVENTFD=y
CONFIG_TMPFS=y
CONFIG_TMPFS_POSIX_ACL=y
CONFIG_TMPFS_XATTR=y
CONFIG_DEVTMPFS=y
CONFIG_DEVTMPFS_MOUNT=y

## --- file systems: overlayfs (Docker's overlay2, also inside a Sysbox container), ext4 for the disks, FUSE for sysbox-fs
CONFIG_OVERLAY_FS=y
CONFIG_EXT4_FS=y
CONFIG_EXT4_FS_POSIX_ACL=y
CONFIG_EXT4_FS_SECURITY=y
CONFIG_FS_POSIX_ACL=y
CONFIG_FUSE_FS=y
## sysbox-fs is a FUSE file system that emulates /proc and /sys inside the container: /dev/fuse is a must
CONFIG_BLK_DEV_LOOP=y
CONFIG_SQUASHFS=y
CONFIG_XFS_FS=y

## --- network: veth, bridge, tun, netfilter (Docker's bridge network with NAT, Docker 29's nftables backend, iptables-nft)
CONFIG_VETH=y
CONFIG_BRIDGE=y
CONFIG_BRIDGE_NETFILTER=y
CONFIG_TUN=y
CONFIG_DUMMY=y
CONFIG_VXLAN=y
CONFIG_MACVLAN=y
CONFIG_INET=y
CONFIG_IPV6=y
CONFIG_NETFILTER=y
CONFIG_NETFILTER_ADVANCED=y
CONFIG_NF_CONNTRACK=y
CONFIG_NF_NAT=y
CONFIG_NF_TABLES=y
CONFIG_NF_TABLES_INET=y
CONFIG_NF_TABLES_NETDEV=y
CONFIG_NFT_CT=y
CONFIG_NFT_NAT=y
CONFIG_NFT_MASQ=y
CONFIG_NFT_REDIR=y
CONFIG_NFT_REJECT=y
CONFIG_NFT_COMPAT=y
CONFIG_NFT_LOG=y
CONFIG_NFT_LIMIT=y
CONFIG_NFT_FIB=y
CONFIG_NFT_FIB_INET=y
CONFIG_NFT_FIB_IPV4=y
CONFIG_NFT_FIB_IPV6=y
CONFIG_NETFILTER_XTABLES=y
CONFIG_NETFILTER_XT_MARK=y
CONFIG_NETFILTER_XT_NAT=y
CONFIG_NETFILTER_XT_TARGET_MASQUERADE=y
CONFIG_NETFILTER_XT_TARGET_REDIRECT=y
CONFIG_NETFILTER_XT_MATCH_ADDRTYPE=y
CONFIG_NETFILTER_XT_MATCH_CONNTRACK=y
CONFIG_NETFILTER_XT_MATCH_COMMENT=y
CONFIG_NETFILTER_XT_MATCH_MULTIPORT=y
CONFIG_NETFILTER_XT_MATCH_MARK=y
CONFIG_NETFILTER_XT_MATCH_STATE=y
CONFIG_IP_NF_RAW=y
CONFIG_IP6_NF_RAW=y
CONFIG_IP_NF_IPTABLES=y
CONFIG_IP_NF_FILTER=y
CONFIG_IP_NF_NAT=y
CONFIG_IP_NF_TARGET_MASQUERADE=y
CONFIG_IP_NF_TARGET_REJECT=y
CONFIG_IP6_NF_IPTABLES=y
CONFIG_IP6_NF_FILTER=y
CONFIG_IP6_NF_NAT=y
CONFIG_IP6_NF_TARGET_MASQUERADE=y

## --- host <-> guest: vsock (the start payload and the exit report), virtio devices (Firecracker has no PCI)
CONFIG_VSOCKETS=y
CONFIG_VIRTIO_VSOCKETS=y
CONFIG_VIRTIO=y
CONFIG_VIRTIO_MMIO=y
CONFIG_VIRTIO_BLK=y
CONFIG_VIRTIO_NET=y
CONFIG_VIRTIO_BALLOON=y
CONFIG_HW_RANDOM_VIRTIO=y
```

### Q2: Sysbox inside the guest

T01 runs the agent's case and Control's case in one VM, started the way the hosted VM is: `vm-prepare.sh` (cgroup layout, dockerd), then
`sysbox-prepare.sh` (the Sysbox daemons), both **unchanged**.

- **Agent's case:** `docker run --runtime=sysbox-runc` of `docker:29.1.3-dind`, with the image's `dockerd` as the container's init, becomes
  an inner Docker 29.1.3 (overlayfs, cgroup v2) that loads an image from a file and prints `Hello from Docker!` for `docker run
  hello-world`. The container is not privileged (`privileged=false`), its root maps to host uid 100000 (`uid_map 0 100000 65536`),
  and a second one starts next to it (0.8 s). Inner dockerd ready **1.5 s** (median of five, 1.44 to 1.73 s) after `docker run`.
- **Control's case:** `docker run --runtime=runc` of busybox with the payload on stdin: 309 ms; a runc container also runs **next to**
  the running Sysbox container.
- **Through the proxy:** in the wall phase (Q6) a Sysbox container with `HTTPS_PROXY` set pulls `hello-world` from a registry and runs it:
  2 s, and the proxy log shows only `CONNECT public.ecr.aws:443` and the CDN. A plain container without the variable gets nowhere.

What it took, each a line of the plan:

1. **`vm-prepare.sh` assumes the layout of the platform's init.** It starts by disabling `cpuset cpu pids` in the root's
   `subtree_control`, which is EINVAL on a kernel that enabled none. The guest init enables `cpuset cpu io memory pids` first; the script is untouched.
2. **A read-only root needs three writable places for Sysbox:** `/var/lib/sysbox` (on the job disk), and `/var/lib/sysboxfs` (a tmpfs). Without
   the second the container fails with `failed to pre-register with sysbox-fs ... FuseServer with invalid mountpoint`.
3. **Docker 29's containerd image store ignores `data-root`.** Its images live under `/var/lib/containerd` (a second Docker on the build machine
   quietly used the machine's own containerd and wrote 180 KiB under the data root for 508 MiB of images). The spike uses the classic overlay2
   store (`"features": {"containerd-snapshotter": false}`) for the guest and the base-disk builder; the alternative is a bind mount of
   `/var/lib/containerd` from the job disk, which the init also does. **#976 must decide which store the golden recipe uses**, the hosted one is the default (containerd store).
4. **The Sysbox package's `config` script runs `docker ps -a` and refuses to continue unless it sees the header line**, and calls
   `systemctl`: the build puts two stubs on the PATH for that one install, as the golden snapshot does for `systemctl`.
5. **The `dind` image's own entrypoint costs 15 s**: it binds `tcp://0.0.0.0:2375` and dockerd 29 delays such a start by 15 s on purpose
   (`Startup is intentionally delayed`, in the container log). 17 s ready time with the entrypoint, 1.2 s with `--entrypoint dockerd --host=unix://...`.
   Not a Sysbox cost, but the agent image's init (#981) must not bind TCP.

### Q3: the disk

The base is a file system image; a job gets its own copy, so the unprivileged service needs **no mount, no loop device and no root** at
runtime: Firecracker takes the file as a block device. The root file system is shared by all VMs as a read-only drive; a write
to it fails (`touch: Read-only file system`), everything writable is a tmpfs or the job disk. Copies were made by `fcuser`
on a volume it owns.

| Copy of | File system | `cp --reflink` | plain copy `cp` | plain copy + sync | File system space used |
|---|---|---|---|---|---|
| 752 MiB base (463 MiB allocated) | XFS (`reflink=1`) | **34 ms** | 1.27 s | 2.3 s | 0 against 520 MiB |
| 752 MiB base | btrfs | **33 ms** | 942 ms | 2.1 s | 0 against 464 MiB |
| 4 GiB (random data) | XFS | **33 ms** | 15.2 s | 21.2 s | 0 against 4096 MiB |
| 4 GiB (random data) | btrfs | **1.1 s** (0.4 to 1.2 s over the runs) | 16.8 s | 20.6 s | 16 MiB against 4096 MiB |

Median of five copies each (page cache dropped before every copy). A reflink copy is constant time on XFS and shares the
extents; its price comes later: **overwriting 256 MiB inside a reflinked copy took 0.56 s and used 256 MiB of new space** (the copy
diverges as the job writes; 0.65 s and 28 MiB in a plain copy, which paid for it before the start). XFS and btrfs are equal for a base of this size; XFS is
flat for the big file, btrfs took 0.4 to 1.2 s (not investigated why). Recommendation: **XFS with reflink** on the host
(the installer checks `reflink=1`), with a plain-copy fallback on other file systems and the numbers above as its cost.

**The quota is the size of the job's file.** A 3 GiB job disk was made from the 752 MiB base by `truncate` and then `resize2fs` **on the file, by the
unprivileged service, before the VM starts: 20 ms, no root, no mount** (the file system then shows 2936 MiB). The guest sees `No space left on device` at the quota (the check
writes 4 GiB of zeros into the 3 GiB disk), and the file occupied 3030 MiB of its 3072 MiB on the host at that point. **The online resize in the guest did not work as
I called it** (`resize2fs /dev/vdb` at boot: `open: Device or resource busy while opening /dev/vdb`, the file system stayed at its old size); not pursued, because the host-side
resize is simpler and needs nothing in the guest. The host then needs `e2fsprogs` (`resize2fs`), as any Linux machine has.

### Q4: the unprivileged host side

Everything the runtime does ran as the normal user `fcuser` (uid 1002, groups `fcuser` and `kvm`) in a transient systemd service with
`Delegate=yes`, the unit the plan's installer would write. Firecracker **without the jailer** starts, boots a guest and has no capability
(`CapEff` 0000000000000000), `NoNewPrivs` 1 and Firecracker's own **seccomp filter** (mode 2).

| Needed once, as root, at install | Why |
|---|---|
| the group `kvm` and the udev rule `KERNEL=="kvm", GROUP="kvm", MODE="0660"` | `/dev/kvm` is opened through the group; `nobody` cannot read it (control) |
| the user and its membership in `kvm` | |
| TAP devices, `ip tuntap add dev fctapN mode tap user fcuser group fcuser` (with their addresses) | Firecracker may attach to a TAP **its user owns**: attaching to a TAP owned by root fails (`TapOpen ... Operation not permitted`), creating a TAP as `fcuser` fails (`TUNSETIFF: Operation not permitted`) |
| the static nft table (Q6) | `fcuser` cannot change nftables (control) |
| the systemd unit with `Delegate=yes` | the cgroup subtree belongs to the user |
| the reflink volume, owned by the user | mounts are root's (control: `fcuser` cannot mount) |

**At runtime nothing needed root**: reflink copy, cgroup per VM, Firecracker, the vsock sockets, the proxy, `resize2fs` on a file, stopping
a VM (the guest reboots itself, `reboot=k` ends the process). A pool of pre-created TAPs is therefore **a set number of concurrent jobs**; more
slots means a root step (a helper or a bigger pool at install).

**Limits through the delegated cgroup hold.** The service made a leaf for itself (a cgroup with processes cannot enable controllers for
children), enabled `cpu memory pids io` and made one cgroup per VM (the Firecracker process only; the host page cache of the disk files is
charged to it too: `memory.current` was 123, 825 and 1599 MiB at the three stages of Q7 against 123, 344 and 573 MiB of resident memory, so a `memory.max` must leave room for the cache). `cpu.max` at 50 % with a guest running two
busy loops on two vCPUs: the VM used **3.06 CPU-seconds in 6.5 s (0.47 CPU)**, 61 periods throttled. `memory.max` of 700 MiB for a guest with 2 GiB that touches
1.4 GiB: **the cgroup OOM-killed the Firecracker process** (`oom_kill 1`), the host and the service were untouched. `io.max` was not tried.

**Without the jailer the VMM is not in a chroot, a PID or mount namespace**; it runs as the service's own user. A VMM escape lands in
the user that also holds the other jobs' state. The seccomp filter and zero capabilities are measured; the rest (a unit per VM with
`PrivateTmp`, `ProtectSystem`, a user per slot, or the jailer's setup) is **not tried**.

### Q5: vsock

Firecracker's vsock device exposes the guest as a Unix socket on the host: the host connects to `v.sock`, sends `CONNECT 5000` and
gets `OK`; the guest connects to the host's CID 2, which Firecracker forwards to `v.sock_<port>` (the host listens on it before the VM starts).
T03: the start payload (`{appUrl, jobId, crj_..., unicode, nested}`) goes host → guest and is acknowledged with its sha256 in **2.4 ms** (the first request,
which includes the guest's first Python import); the guest process writes it to a file (identical), then reports `{"type":"exit","code":0}`
guest → host, carrying the same digest. A 1 MiB payload takes 22 ms. 200 new connections with a request and a reply each: **p50 0.63 ms, p95 0.72
ms, max 0.98 ms** (p50 0.3 to 0.6 ms over the runs). The same channel carried every command of the other tests (`exec`), so it is the channel vm-init (#977) needs; what the spike's
agent does not have is a framing beyond one JSON line per connection, no authentication (vsock is point to point), and no reconnect.

### Q6: the network

The VM has one NIC on a TAP; the host side of the TAP is `172.31.0.1/30` (and `fd00:fc:0::1/64`), and a proxy listens on `:3128` as the service's
user. The **static nft table** (`spike/firecracker/host/wall.nft`, loaded once as root, matching the TAPs by name `fctap*`): input from a TAP accepts
established traffic and TCP to port 3128 of a **local** address (`fib daddr type local`), drops everything else addressed to the host
(including ICMP and UDP) and any source address outside `172.31.0.0/16`; forward drops everything from and to a TAP; output to a TAP
drops everything but answers. It hooks at priority -150, before Docker's iptables. The host **forwards on purpose** (`ip_forward=1`, as
the runner does for its own Docker), so the table, not the absence of routing, is what stops traffic.

**Every probe has a control**, because "blocked" proves nothing from a probe that could never say "reachable": the same 19 probes ran first with the
table removed and NAT on (all but one reach their target), then with the table loaded. Targets sit on the host (TAP address, eth0 address:
TCP, UDP, ping), behind it in a network namespace reached **through the forward path** (10.77.0.2, 172.16.77.2, 192.168.77.2, a link-local
169.254.169.253, IPv6 fd00:77::2), the real Azure metadata endpoint `169.254.169.254:80`, the internet (1.1.1.1:443, 8.8.8.8 DNS over UDP) and a second VM.

| Probe | Control (no table) | Table loaded |
|---|---|---|
| proxy, TAP address `:3128` and eth0 address `:3128` | connected | **connected** |
| host TAP address `:9999`, UDP `:9999`, ping; host eth0 address `:9999` | connected / answered | blocked |
| RFC1918 10.77.0.2, 172.16.77.2, 192.168.77.2 (TCP), 10.77.0.2 (UDP) | connected / answered | blocked |
| link-local 169.254.169.253 (fixture), **169.254.169.254:80 (Azure)** | connected | blocked |
| internet 1.1.1.1:443, 8.8.8.8:53/udp | connected / answered | blocked |
| IPv6: host TAP address (TCP, ping), forwarded fd00:77::2 | connected / answered | blocked |
| the other VM (172.31.0.6:9999) | connected | blocked |
| ping 1.1.1.1 | blocked (Azure drops ICMP) | the control proves nothing, reported as such |

The nft counters after the run (`wall-counters.txt`) show the table doing it: 2 packets accepted to the proxy port, 24 forwarded packets dropped,
11 packets to other host ports dropped, 8 host-initiated packets to a TAP dropped. Not blocked and worth knowing: **the guest can also reach the
proxy through the host's other addresses** (eth0 address :3128, in the table above), because the rule says "a local address"; one proxy listening on the TAP
addresses only makes that moot, and a proxy per TAP is how the dispatcher tells jobs apart by source address anyway. The proxy sees the VM's address, so it
can apply a per-job rule. By its rule (not tested) the wall lets a guest send from **another slot's address** inside `172.31.0.0/16`, so the per-job proxy must not trust the source address as an identity
without a per-TAP rule (`iifname fctapN ip saddr != <its /30>`, generated at install).

### Q7: timing and memory

Boot to a state, measured on the host from the start of the Firecracker process (median of five boots, min to max; the final run), with the guest's serial console
on (Firecracker's recommended boot arguments):

| Milestone | Time |
|---|---|
| process start to the guest's init up (kernel boot included) | 944 ms (922 to 967) |
| job disk mounted | 999 ms (981 to 1025) |
| `docker_ready` (`vm-prepare.sh`: cgroup layout, dockerd answers) | **1.90 s** (1.87 to 2.23) |
| `sysbox_ready` (`sysbox-prepare.sh`: the two daemons) | 2.25 s (2.23 to 2.60) |
| init finished (`boot_done`) | 2.29 s (2.26 to 2.63) |
| **"Control could start"**: first `docker run --runtime=runc busybox true` has returned | **2.61 s** (2.61 to 2.97), the container itself 0.31 to 0.35 s |
| agent container with its own dockerd ready (Q2), after `docker run` | +1.51 s (1.44 to 1.73) |

The six runs of this work, on six runner VMs, gave `boot_done` medians of **1.70 to 2.33 s** (1.70, 1.70, 1.86, 1.88, 2.29, 2.33) and `docker_ready` of 1.37 to 1.91 s: the
runner hosts differ by a third. **A VM without Docker** (the kernel, the init and the agent) is up in 0.77 to 1.05 s with the serial console on and in **0.45 to 0.65 s**
with `quiet loglevel=0` (final run: 1.05 s and 0.63 s, guest uptime 0.71 s and 0.54 s): **the serial console costs 0.3 to 0.4 s of every boot**, so the launcher should
not give the guest a console it does not read.

**Memory.** Firecracker takes the guest's RAM lazily; resident memory of the process (guest 2 GiB, final run):

| State | Firecracker RSS | Guest "used" (MemTotal - MemAvailable) | Guest touched (MemTotal - MemFree) |
|---|---|---|---|
| kernel, init and agent only | 123 MiB | 126 MiB | 67 MiB |
| dockerd, Sysbox daemons, one runc container run | 344 MiB | 211 MiB | 293 MiB |
| plus a Sysbox container with its own running dockerd | 573 MiB | 242 MiB | 519 MiB |

The fixed cost of a VM, resident memory minus what the guest touched, is **about 50 to 56 MiB** at every stage (the VMM, the kernel image's pages, the device buffers); the rest is
the guest's own memory, which stays resident after the guest frees it (no balloon was tried). The host page cache for the disk files is charged to the VM's cgroup
as well: 482 MiB of `file` after the first container, 1025 MiB with the Sysbox container (the cgroup's `memory.current` is 1599 MiB then). dockerd and the two Sysbox daemons idle within the 211 MiB above.

### Rerun

On a repository checkout of the branch, the workflow `spike-970-firecracker.yml` runs on every push of `spike-970-firecracker` (a `workflow_dispatch` trigger exists but
GitHub only offers it for workflow files on the default branch). It builds the kernel (a cache keyed by the fragment and the pins), the root file system, then installs as
root (`host/setup.sh`) and runs the tests as `fcuser` through `host/as-fcuser.sh`; `host/report.py` writes the summary and fails when the table of T02 is not as required.

### What was not proven

- **Anything on real hardware, or on a customer's distribution:** one nested-virtualization environment (Azure, AMD). No Debian, no Ubuntu 22.04, no
  AppArmor on the host, no kernel older than 6.18 on the host, no ARM.
- **The jailer's isolation without the jailer:** only seccomp and zero capabilities are measured (Q4); a unit with systemd sandboxing per VM is not tried.
- **The online resize2fs in the guest** (failed with EBUSY, not pursued; the host-side one is measured), **Docker 29's nftables firewall backend,** `io.max` on the job disk, a balloon, memory returned to the host, snapshot/restore, several VMs at the same time under load (two ran at once for
  the cross-VM probe only).
- **Update and rollback of kernel and root file system,** signing (#976): the artifacts are pinned, not signed.
- **The hosted VM's `/etc/subuid` range:** Sysbox mapped container root to host uid 100000 here; the golden snapshot's doc says 165536. Not compared.
- **A job's real Worker image:** busybox and `docker:dind` stood in for Control and the agent. Sizes and times of the Worker image (1.5 GB+) are #976's to measure, the copy
  times above scale with allocated size (reflink does not).

### What the build issues must do differently

- **#976 (VM artifacts).** The kernel is Firecracker's recommended 6.18 config plus the fragment above, verified at build time; `RT_GROUP_SCHED=n` is not optional. The root file
  system is built from the golden recipe's two scripts as they are, plus: the cgroup controllers enabled by the init before `vm-prepare.sh`, `/var/lib/sysbox` on the job disk and a
  tmpfs on `/var/lib/sysboxfs`, stubs for `systemctl` **and** `docker ps` during the Sysbox package install, and **one decision on the image store** (containerd store with
  `/var/lib/containerd` on the job disk, or overlay2; the spike ran overlay2). Image init must not start a `dockerd` that binds TCP (15 s). Size and time to plan for: `vmlinux` 26.5 MiB,
  566 s to build on 4 cores (cache it by fragment and pins), root file system 632 MiB (170 MB compressed) without the Worker image.
- **#977 (vm-init).** PID 1 can be `docker-init`; the channel is vsock with Firecracker's host side (a Unix socket, `CONNECT <port>` for host → guest, `<uds>_<port>` listeners for
  guest → host, opened **before** the VM starts). Requests take 0.3 to 0.6 ms, so a call per step is cheap. Report milestones as events (the spike's `init_up`, `docker_ready`,
  `sysbox_ready`). End the VM from the guest with a reboot (`reboot=k`); give it no serial console it does not read (0.3 to 0.4 s of boot).
- **#978 (launcher).** Per job: reflink copy of the base disk, `resize2fs` on the file (20 ms) to the quota, a cgroup under the unit's delegated subtree (own leaf first, then one per VM; `memory.max`
  must leave room for the page cache of the disk files), Firecracker as the service's user on a pre-created TAP, `--no-api --config-file`. The number of pre-created TAPs is the number of concurrent
  jobs. A unit hardening per VM (instead of the jailer) is **to be decided**; only seccomp and zero capabilities are proven.
- **#979 (outer wall).** `host/wall.nft` and `host/open.nft` plus `rootfs/probe.py` are the acceptance test as built: every blocked probe needs a control that reached the same target with the
  table removed; the proxy listens on the TAP addresses only and tells jobs apart by TAP; the install generates the per-TAP source-address rule.
- **#982 (install), as built:** see "Install (a machine with KVM, #982)". As the spike planned it: The root steps are exactly the table in Q4. The installer checks `/dev/kvm`, `reflink=1` on the work volume (XFS), `e2fsprogs` and a delegating systemd. No Docker is needed on the
  customer's host: nothing of the runtime used one (the spike's base-disk builder ran a second dockerd on the **build** machine, which is the release pipeline's job).

## VM artifacts (#976)

What a customer's Linux machine boots a job in (Runner v2, epic #969; the sandbox of the spike above): a guest kernel, a read-only root file system and a
prepared Docker data disk, **built from the golden snapshot's recipe** and described by a **signed manifest**. A Vercel snapshot cannot be exported and
Vercel cannot boot our own disk, so the one recipe has two outputs: the hosted snapshot (`dispatcher/src/snapshot`) and these files.

| File | What | Size (x86_64) |
|---|---|---|
| `vmlinux` | the guest kernel: Linux 6.18.62, Firecracker's recommended 6.18 configuration plus our fragment | about 27 MiB |
| `rootfs.ext4.zst` | the read-only root file system: Ubuntu Base 26.04.1, Docker, Sysbox, the prepare scripts, `vm-init` | about 0.2 GB packed |
| `dockerdata.ext4.zst` | the base of the per-job copy-on-write Docker disk: the Worker image and the agent image loaded into the guest's own Docker | 1.26 GB packed |
| `kernel.config`, `fc-base.config`, `config.fragment`, `linux-<version>.tar.xz` | the **GPL source offer** of the kernel: the final configuration, its two inputs and the unmodified source | |
| `packages.txt` | every package of the root file system with the source package and version it was built from | |
| `vm-artifacts-manifest.json`, `vm-artifacts-manifest.sig` | the manifest (below) and its detached signature | |

Only x86_64 is built; arm64 comes with the macOS backend.

### One recipe, two outputs

`dispatcher/src/vm-artifacts/recipe.ts` writes the scripts of the golden snapshot pipeline (`installDockerScript`, `installSysboxScript`, the daemon
configuration, `installHostScriptsScript`) and its pins as data, and `docker/vm/rootfs/build.sh` runs **those scripts, unchanged**, in a chroot of
Ubuntu Base, in the pipeline's order and with its files staged at its paths. So there is no second copy of a version or a command: the pins
(`dockerVersion`, `buildxVersion`, `sysboxVersion` and its sha256) are `DEFAULT_CONFIG` of the pipeline, `daemon.json` is `daemonConfigJson()`, and
`vm-prepare.sh` and `sysbox-prepare.sh` are the files of `docker/sandbox/`. A test pins that the emitted scripts equal the pipeline's, byte for
byte (`recipe.test.ts`); a bump of the hosted pin is a bump of the local build, and the hosted snapshot's tests are untouched.

What is local to this output, and why:

- **The packages Ubuntu Base lacks** (`docker/vm/rootfs/packages.txt`): the hosted base image (Vercel's Ubuntu 26.04.1) already has them. Ubuntu's signed archive, not
  version pinned (the hosted recipe pins only `docker.io`, `docker-buildx` and Sysbox either); `packages.txt` of the release records what was installed.
- **A stand-in `docker`** while the Sysbox package installs, because its configuration script wants the header of `docker ps -a` and there is no daemon in a chroot. It is removed again.
- **`vm-init`**, the placeholder of #977: mounts, the job disk, the cgroup controllers, then `vm-prepare.sh` and `sysbox-prepare.sh` as the hosted VM runs them. It reports
  milestones on the console (`VMINIT <name> uptime=<s> ...`); #977 replaces it and reports the same milestones over vsock. PID 1 is `docker-init` (tini).
- **Every download is pinned by version and sha256**: the kernel source, Firecracker and its base configuration, Ubuntu Base (`docker/vm/pins.env`, each compared with its
  publisher's own list), and the Sysbox package (checked by the pipeline's own script). The two images come from the digest-pinned bases of `runner/Dockerfile`.

### The Docker image store: the containerd store, as hosted

The hosted default is Docker 29's containerd image store, and **the local VM uses it too**: the same `daemon.json`, no `features` override. The spike found
that this store ignores `data-root` (its images live under `/var/lib/containerd`) and used overlay2 to get around it; the build here does not need that. `vm-init` mounts
the job disk and **bind-mounts its three directories over the places the daemons use**: `/jobdisk/docker` on `/var/lib/docker`, `/jobdisk/containerd` on
`/var/lib/containerd` and `/jobdisk/sysbox` on `/var/lib/sysbox`. Everything Docker, containerd and Sysbox write is then on the per-job disk, and the guest's configuration
is byte-identical to the hosted one, so a behaviour that differs between the two is not a difference of image store. `/var/lib/sysboxfs` is a tmpfs (sysbox-fs needs a writable
mount point on a read-only root). The smoke boot reports the store the guest runs (`store driver=... snapshotter=...`), and the data disk is made by the guest's own dockerd, so
a store that did not write to the disk would not leave images there.

### The kernel

`docker/vm/kernel`: the pinned source, Firecracker's recommended 6.18 configuration (tag v1.17.0) and `config.fragment` (the 23 options the spike found, plus the whole list of what
Docker, Sysbox and the VM need, so that a change of the base cannot drop one silently) are merged with `merge_config.sh` and `make olddefconfig`. **`verify-config.sh` fails when one
option of the fragment did not end up with the requested value** (an unmet dependency drops an option silently, which is how a hand-written fragment fails), and when `RT_GROUP_SCHED` is on: with it the `cpu` controller cannot be enabled
for child cgroups and `vm-prepare.sh` fails (`cgroup_root_busy`); and when IA32 or X32 emulation is on (`IA32_EMULATION=n`, `X86_X32_ABI=n`,
from the review of #977): Docker's default seccomp profile, which the agent's container gets, allows `socketcall` and denies AF_VSOCK only
as an argument of `socket`, so with 32-bit system calls the agent could open a vsock socket to the host's ports. The check runs on every build, in seconds, and again on the `.config` of the kernel that is published, so a kernel restored from the CI cache is held to
the same rule. The build is cached by the fragment and the pins (about 10 minutes on 4 cores without the cache).

**No serial console in a release.** The console costs 0.3 to 0.4 s of every boot (spike Q7). The kernel keeps the 8250 driver (the build and the smoke boot read the guest's events from the console), and the release's command line,
`kernel.bootArgs` of the manifest, says `8250.nr_uarts=0 quiet loglevel=0`; the smoke boot adds `console=ttyS0`. `kernel.initCommand` is PID 1 and its arguments (`docker-init -- vm-init`); the launcher (#978) puts a job's own
parameters before the `--`.

**GPL source offer.** Every release publishes the exact source tarball, the final `.config`, Firecracker's base configuration and the fragment next to `vmlinux`, all named in the signed manifest (`THIRD_PARTY_LICENSES.md`,
"Local VM artifacts"). `packages.txt` lists the source package and version of every package of the root file system, and the notes of each release point at the sources on **Ubuntu's snapshot service as of the
build date** (`https://snapshot.ubuntu.com/ubuntu/<manifest builtAt as YYYYMMDDTHHMMSSZ>/`), a stable address; the archive's own `deb-src` moves on and drops superseded sources.

### The data disk

`docker/vm/data/build.sh` boots a guest in `seed` mode with the image archive (`docker save` of the two images the pipeline builds: `runner/Dockerfile`, targets `sandbox` and `agent`, tags `code-reviewer-worker:golden` and
`code-reviewer-agent:golden`) on a read-only third drive. `vm-init` loads it with `docker load`, reports the image ids, stops dockerd the way the pipeline stops it before it snapshots (SIGTERM, wait for dockerd and containerd to be gone) **and the two Sysbox
daemons** (`sysbox-fs`, then `sysbox-mgr`, which keep state under `/var/lib/sysbox`), then unmounts the seed drive, the directories bound from the job disk and the job disk, **checking every unmount**: a daemon that is
left or an unmount that fails reports `seed_failed` and powers off without `seed_done`, and the build refuses a seed boot without it. The disk is then checked read-only (`e2fsck -fn`: it must be clean as the guest left it, nothing is repaired quietly) and shrunk to its minimum (`resize2fs -M`). The launcher copies it per job (a reflink copy on XFS), grows the copy to the quota with `resize2fs` on the file (`docker/vm/data/grow.sh`, 20 ms in the spike) and
attaches it as `/dev/vdb`. The image ids in the manifest (`images`) are what the guest's Docker reports for the disk's images, and the smoke boot fails when the guest reports another one.

### The manifest and its signature

`vm-artifacts-manifest.json` (`dispatcher/src/vm-artifacts/manifest.ts`) holds: a `release` number that only grows, the commit, every file with its **size and sha256** (a compressed file also what it unpacks to), the kernel's inputs, the versions
the root file system reports as installed (`dockerd`, `buildx`, `sysbox`, the Sysbox package's checksum, Ubuntu Base) and the image ids. The detached signature is made over exactly its bytes, **the way the runner's release channel is signed**: ECDSA over
P-256 with SHA-256, a DER signature, the public key as base64 of the DER SubjectPublicKeyInfo. The key is in the channel file `docker/vm/release-channel.json` (empty in this repository until the owner sets it, like `runner/release-channel.json`); the private key is
never in the repository.

**The verifier** (`dispatcher/src/vm-artifacts/verify.ts`, used by the build and the release; the host's install and update (#982) do the same checks in the shell with `openssl`, `jq`, `zstd` and `sha256sum`, because a customer's machine has no Node: the
signature format, the order of the checks and the manifest's schema are the same, and `fixtures/sample-manifest.json` is parsed by this verifier and compared by shape with the manifest of the installer's tests) needs nothing but `node:crypto`. Its order: the key must be ECDSA P-256 (`key_invalid` otherwise); the signature must verify over the manifest bytes
(`signature_invalid`); only then is the manifest read (`manifest_invalid`, `manifest_too_large`: 256 KiB); the release must be higher than the one in use or left by a rollback (`release_not_newer`, the rule of the runner's channel); then each file: present, size, sha256
(`file_missing`, `size_mismatch`, `digest_mismatch`). `--min-release N` (`minRelease`) must be a whole number from 0 and the manifest's release must be **higher** than it: anything else, `abc` or `NaN` included, is an error (`min_release_invalid`, exit status 2 on
the command line), never "no limit". `--exact-dir` (`exactDir`) also refuses a directory that holds anything the manifest does not name (`unexpected_file`; the manifest and the signature file are allowed when they are in it): what was verified is all there is. No file is read before the signature has verified. `node dispatcher/src/vm-artifacts/verify-main.ts --dir <dir> --manifest ... --signature ... --channel docker/vm/release-channel.json` does it from a shell.

**The version check against the hosted snapshot** (`compare.ts`, `compare-main.ts`; #976-T02): the same dockerd, buildx and Sysbox (version and package checksum) as the hosted pipeline pins, the same image tags, and the image ids against the hosted record
(`golden-snapshot-record`). The release job runs it against the newest golden snapshot of `main` (the step "Compare this commit's recipe with the newest golden snapshot record of main": it compares what **this commit** builds) and fails on a different version. **Image ids are reported, not enforced:** the hosted pipeline builds the images inside its builder VM and the local build builds them in CI, and
two builds of the same Dockerfile are not the same digest (the Dockerfile's Debian packages are not version pinned). The ids agree once both outputs load **one** build of the images (a registry or an OCI archive the pipeline loads); that changes the hosted
pipeline and is a follow-up (`--require-images` turns the check on). Whether to enforce them then is the owner's decision (below).

### When it runs, and the release

- **Pull request:** `.github/workflows/vm-artifacts.yml`, called by the `vm-artifacts` job of `ci.yml`, **only** when a file of `docker/vm/`, `docker/sandbox/`, `dispatcher/src/vm-artifacts/`, the pipeline's config, scripts and probe flags, or the workflow changed (the `vm` path filter;
  nothing else pays for a KVM job). The `kernel` job builds the kernel or restores it from the cache and always verifies the configuration; the `build` job makes the root file system, builds the two images, makes the data disk, **boots the result** and builds the manifest. The smoke boot
  (`boot-main.ts`, `console.ts`) fails unless dockerd is ready within the budget (`docker_ready` 10 s after the start of Firecracker; the spike measured 1.4 to 1.9 s on the same kind of runner), Sysbox is ready, the guest's two images are the data disk's, a `runc` container and a `sysbox-runc` container run,
  the root file system is read-only and the golden snapshot's own Worker self-check (`probe`) passes. It ends with `selftest-signing.sh`: a throwaway key signs the real manifest, the verifier accepts it and then refuses a changed byte of the kernel, a changed byte of the manifest and another key.
- **Release:** a tag `vm-artifacts-v<N>` (N the release number; it only grows) runs `vm-artifacts-release.yml`. Its jobs, in this order:
  1. `number`: the tag is `vm-artifacts-v<N>` with N a whole number from 1.
  2. `guard`: **the tagged commit must be an ancestor of `main`** (the compare API says `identical` or `behind`; no checkout, no code of the tag runs for it). `main` is chosen because it is what was reviewed, merged and released; a commit that is only on `development` has to be released first. Change the one word in the job to take `development`.
     The guard stops a mistake and tells a reviewer something; it is **not** the protection: a tag can point at a commit whose workflow file has no guard, which is why the environment's required reviewers and the tag ruleset below are mandatory.
  3. `build` (`vm-artifacts.yml` with `for_release: true`): **no kernel cache**: a release always builds the kernel from the pinned source (a cache is for pull requests only), then the root file system, the images, the data disk, the smoke boot and the manifest. This job has no key, no environment and a read-only token.
  4. `release` (environment `vm-artifacts-release`, which waits for its required reviewers): installs with **`pnpm install --frozen-lockfile --ignore-scripts`**, so no lifecycle script of a dependency runs in the job that holds the key, and builds nothing. It restores the release's files, checks that the channel file names a key, **this repository** and the asset names and that the manifest is this tag's,
     checks that the release number is **higher than that of every other release** of the repository (drafts included), compares this commit's recipe with the hosted snapshot's record, signs, verifies what it is about to publish with the verifier and the channel's key (`--min-release` the highest other release, `--exact-dir`) and makes a **draft** release with every file.
     The key is the secret `VM_ARTIFACTS_SIGNING_KEY` of the environment, read in one step; the job refuses a key that is not the channel's. Nothing is public until the owner publishes the draft.
- **No workflow artifact holds the data disk.** The repository is public and an artifact of a public repository can be downloaded by anybody who is signed in to GitHub; the data disk holds the Worker image (proprietary code, copyleft packages) and must not become downloadable before the owner decides to publish it. So the release's files go from `build` to `release` **through the Actions cache**
  (`actions/cache/save` under `vm-release-files-<run id>`, `restore` with `fail-on-cache-miss`): GitHub offers no download of a cache's content to a person, only a workflow of this repository restores it, and `release` verifies every file against the manifest it signs, so other bytes in the cache would fail there before anything is published. The cache is deleted when the draft exists (and expires after 7 days otherwise).
  A pull request run uploads only the kernel (`vm-kernel`, `retention-days: 1`, needed by its own next job; the kernel and its sources are GPL) and the logs of the guests (`retention-days: 3`); no run uploads the root file system or the data disk. This is pinned by `app/src/ci/vm-artifacts-workflow.test.ts`.

**What the owner does once** (not in this repository, and not done by this change). Items 1 to 4 are **mandatory** before the first tag; without them the key is protected by nothing but the guard:

1. **Environment `vm-artifacts-release`** (Settings, Environments): **required reviewers** (at least one person who is not the one who pushes the tag; mandatory: the job waits for them and they see the commit it runs), "Prevent self-review", and the **deployment policy "Selected branches and tags" with the tag rule `vm-artifacts-v*` only** (no branch).
2. **A tag ruleset on `vm-artifacts-v*`** (Settings, Rules): creating, updating and deleting those tags restricted to the admins / the release owner (bypass list), no force pushes. Whoever can create the tag can start the workflow; the reviewers are the second lock.
3. Make the key: `openssl ecparam -genkey -name prime256v1 -noout -out vm-artifacts-key.pem`, keep it secret (a password manager, not a file on a shared disk), derive the public half with `openssl pkey -in vm-artifacts-key.pem -pubout -outform DER | base64 -w0`, and put the PEM in the **environment secret** `VM_ARTIFACTS_SIGNING_KEY` (not a repository secret: only the environment's job may read it).
4. Put the public half and the repository in `docker/vm/release-channel.json` (`publicKey`, `repository`, by a reviewed pull request that reaches `main`): the release job refuses a channel without a key or with another repository, and a change of the key is a change of this file.
5. **Decide whether the data disk may be published** (it holds the Worker image: `THIRD_PARTY_LICENSES.md`, "Copyleft and distribution"), then publish the draft. The release is a draft until you do.
6. **Decide whether the image ids must equal the hosted ones.** Today they are reported and do not fail the comparison (above); enforcing them (`compare-main.ts --require-images`) needs both outputs to load one build of the images, which changes the hosted pipeline (a follow-up). Nothing is enforced until you say so.
7. **Decide where the files are published, and put the address in `baseUrl` of the channel** (#982: `docker/vm/release-channel.json` for these files, `runner/release-channel.json` for the program). **Put `{release}` in the VM channel's address**
   (`.../releases/download/vm-artifacts-v{release}/` or one directory per release): the program names its VM release exactly (#1002), so every release must stay reachable at an address of its own, and **this release is published before the program that names it**. The installer downloads
   `<baseUrl><name>` for the manifest, its signature and every file it names, over https only, and verifies each by the signed manifest and its digests; **it hard-codes no host**. A public GitHub release is downloadable by anybody (the data
   disk holds the Worker image); protected storage needs a login that the installer takes as a curl configuration (`--curl-config`, kept for updates in a root-only file). Without a `baseUrl` and a `publicKey` the installer stops with "no release is published yet".

### Measured

On GitHub's `ubuntu-24.04` runners (4 vCPU, nested virtualization; the same kind as the spike), run [42890853746](https://github.com/Itegro-GmbH/code-reviewer/actions/runs/42890853746) of the pull request (#986):

| What | Value |
|---|---|
| kernel build, no cache | about 10 minutes (the spike: 566 s); with the cache the job takes 1 minute |
| `vmlinux` | 27.7 MB |
| root file system | 604 MiB tree, 788 MiB image, `rootfs.ext4.zst` 187 MB |
| data disk | 5,901 MiB file system, `dockerdata.ext4.zst` 1,262 MB (under the 2 GiB of a release asset; the Worker and agent images are 3.4 GB of it) |
| loading the two images into the guest (`docker load`, seed boot) | about 40 s |
| `docker_ready` after the start of Firecracker (smoke boot, 2 vCPU, 4 GiB, serial console on) | **3.2 s** (2.6 s in the seed boot; the budget is 10 s). The spike measured 1.9 s with the overlay2 store and the static Docker bundle: the Ubuntu `docker.io` with the containerd store starts a second slower |
| `sysbox_ready` | 3.7 s |
| the checks of the smoke mode (root file system read-only, a `runc` container, a `sysbox-runc` container, the Worker image's `probe`) | all passed, done 8.3 s after the start |
| the Worker's `probe` | `{"version":1,"engines":["pr-agent","opencode"],"reasons":[]}` |
| whole `build` job (root file system, two images from the cache, data disk, smoke, manifest, signing self-test) | 7 minutes |
| image store the guest runs | `driver=overlayfs snapshotter=io.containerd.snapshotter.v1`: the containerd store |
| image ids of two builds of the same commit | different (`817449f0...` against `e971f782...` for the Worker image): the ids are not reproducible, see "The manifest" |
| the signing self-test | the verifier accepted the signed manifest and refused one changed byte of the kernel (`digest_mismatch`), one changed byte of the manifest and another key (`signature_invalid`) |

### Not proven, and follow-ups

- Image ids equal to the hosted ones (above). Bare metal, other distributions, arm64. The online file system growth is the host's (`resize2fs` on the file); nothing was changed about that.
- A release asset can hold 2 GiB: the build fails when a file is larger. A data disk that grows past it needs splitting (a manifest entry per part).
- The Debian packages of the Worker image are not version pinned (the Dockerfile says so); only its bases are digest pinned.

## The Firecracker launcher (#978)

> **Superseded as the local backend by [the Incus launcher](#the-incus-launcher-1007) (#1007)**; this code and the KVM lane stay until #1012 retires them.

The local Dispatcher's `WorkerSandbox` for a machine with KVM (Runner v2, epic #969, [ADR 0005](decisions/0005-runner-v2-one-dispatcher-contract.md)):
every job runs in a Firecracker microVM of the release ([VM artifacts](#vm-artifacts-976)), started by the dispatcher as a normal user.
Code: [`runner/src/code_reviewer_runner/factory_runner/firecracker/`](../runner/src/code_reviewer_runner/factory_runner/firecracker). The Worker
in the VM is the hosted one, started by [vm-init](../runner/vm-init/README.md); this section is the **host** side. The old mode (the Worker as
a process of the runner's container, on the host's Docker) is **removed from the program since #982**: `factory-runner run` ends with exit code 6 unless
`FACTORY_RUNNER_SANDBOX=firecracker`, which the installer's unit sets (the process sandbox stays in the code only for the tests of the loop). `run` prepares with the host's checks (`prepare_firecracker`: kernel, root file system, base
disk, `firecracker`, `/dev/kvm`, the delegated cgroup, one TAP device per slot) instead of the Docker self-test, and touches the host's
Docker never (no lock, no tidying). **The installer (#982) does the root steps below**; see "Install (a machine with KVM, #982)".

### What a job does

```
claim ─▶ slot (TAP fctapN) ─▶ job disk ─▶ token ─▶ listen on _5100 and _5101 ─▶ cgroup ─▶ firecracker ─▶ CONNECT 5000, start, ack
                                                                                                               │
 end: first exit report (token) | VMM gone without one | wall clock ──▶ kill VMM and cgroup ─▶ delete disk ─▶ free the slot
```

1. **Slot.** The number of slots is `parallelRuns` (`FACTORY_RUNNER_PARALLEL_RUNS` or `limits.parallelRuns`; 1 to 64). The dispatcher claims
   only while the sandbox has a free slot (`sandbox.free`: a slot whose VMM would not die is out of use until the service restarts, and
   with none free the dispatcher claims nothing and logs it) and runs jobs beside each other (`run --once` is still one job).
   **A start that fails** (the disk is full, `/dev/kvm` or a TAP is gone, a cgroup fails: a fault of this machine, not of the job) gives
   the claim back (`launch_failed`) and the **next claim waits** 10 s, doubled with every start that fails in a row up to 300 s, and
   starts over after one that works. The app counts an attempt for every claim that is given back and has no release that does not
   (three attempts, then the job fails): without the pause, a machine that cannot start any VM would spend an attempt of every job of the
   queue within a minute. A TAP device per slot was made at install (root);
   slot *N* is `fctapN` with the /30 network at offset *N*×4 of the slots' network (`FACTORY_RUNNER_SLOT_NETWORK`, a /24 the installer chose; the tests use `172.31.0.0/16`): the host's side is its first address, the guest's the
   second (given to the guest on the kernel command line, `vm.ip` and `vm.gw`).
2. **Job disk.** The base disk (`dockerdata.ext4`, the Worker and agent images in the guest's own Docker) is copied to `disk.ext4`: a
   reflink (`FICLONE`, XFS with `reflink=1` or btrfs, 34 ms for 752 MiB in the spike) or a plain sparse `cp` where the file system has none,
   then `truncate` and `resize2fs` on the file (20 ms, no root, no mount; `e2fsck -fy` first only if `resize2fs` asks for it). **The
   quota is the size of the file** (`diskGb`, default 16, at least 8): the guest sees `No space left on device` at it. The work volume's
   reserve disk is an eighth of it. The disk is deleted with the VM.
3. **Token and listeners.** A random per-VM token (`tokens.py`) and **both vsock listeners before the VM exists**: Firecracker maps the
   VM's connections to the host (CID 2) port 5100 to the Unix socket `vsock.sock_5100` and port 5101 to `_5101`; the host connects the
   other way to `vsock.sock` with `CONNECT 5000`.
4. **Cgroup and Firecracker.** One cgroup `vm-<slot>-<random>` under the subtree systemd delegated (`Delegate=yes`): `cpu.max` = vCPUs,
   `memory.max` = the guest's memory + 384 MiB (the VMM and what the disk files cost in the page cache), `memory.swap.max` 0,
   `memory.oom.group` 1, `pids.max` 256. The service moves only itself into a leaf (`service`) and enables `cpu memory pids` below its own
   cgroup (the "no internal process" rule). Firecracker (**no jailer**, `--no-api --config-file`) starts **inside** the cgroup (the child
   writes itself into `cgroup.procs` before `exec`), as the service's user, with an **empty environment**, in the VM's directory. Its
   stdout and stderr go through a pipe the service reads into `firecracker.log`, **never more than 4 MiB** of it (past that the file is
   cut and its last 16 KiB written again; a VMM that loops on an error or a serial console cannot fill the disk), and the outcome carries
   the last 6,000 bytes, read by seeking to them. VM size: `FACTORY_RUNNER_VM_VCPUS` (2, 4, 6 or 8; 2 GB per vCPU as hosted; the agent's memory is the
   hosted table's, `agentMemoryMb` of the template).
5. **Start.** The start document is made and **checked before anything exists** (vm-init's own parser, `parse_start`: the job id and the
   URL against the contract's patterns, no credential in an argument): a job the VM would refuse costs no slot, no disk copy and no VMM.
   The start of `contracts/vm-init.v1.json`: `{appUrl, jobId, credential}`, the token, the image check (`code-reviewer-worker:golden`
   and the id from the verified manifest, `FACTORY_RUNNER_VM_IMAGE_ID`), Control's `docker run` and the work volume, and for a job that
   asks for it the one local credential (`localCredential`: **only `CLAUDE_CODE_OAUTH_TOKEN`**, the allow-list `LOCAL_CREDENTIAL_NAMES` that the Worker's own check in Control shares, #980: vm-init
   checks the shape of the object and not the name, so Control is the one that refuses a name it does not know before it puts the value into an environment; the host's per-VM `controlToken`
   in the same document is for the environment control and is never given to the agent) and, with `FACTORY_RUNNER_OUTER_WALL=proxy`, the slot's proxy
   (`outerProxy`: the host's address on the slot's TAP and the port 3128; the VM's clients dial through it,
   [every client in the VM goes through the proxy](#every-client-in-the-vm-goes-through-the-proxy-994)). The host waits for vm-init's `ack`
   (up to 120 s: the daemon's start comes before it). A refused or unanswered start, a VMM that ends first or a report before the `ack`
   fails the start: the claim is given back (`launch_failed`) and nothing is left.

**Control's `docker run`** comes from one renderer: `dispatcher/src/launchers/local-control.ts` (`renderLocalControl`, the hosted
rendering plus `RUNNER_ENVIRONMENT_CONTROL=vsock` and the seccomp profile that allows AF_VSOCK for Control alone). The Python launcher does
not render it again: it fills `control-run.template.json`, **generated by that renderer** (`node dispatcher/src/launchers/local-control-template-main.ts`)
with four markers (job id, image id, timeout, the agent's memory). A test of the Dispatcher holds the file equal to what the renderer
generates and proves that filling it gives what the renderer renders for real values; a test of the runner fills it for the golden job
and compares to `docker-run.local-control.golden.json`, the file vm-init's tests feed to the guest unchanged.

### The host side of the vsock protocol

Every connection is one request and one reply (a frame: four bytes of length, one JSON object, at most 64 KiB; any byte after the frame,
a field the contract does not have, a version other than 1 is a protocol error and the connection is closed, a frame not whole in 10 s
is closed). **Each listener serves at most 4 connections at a time** and closes every other one the moment it is accepted, so whatever
opens connections in a loop holds a few file descriptors of the service, not all of them, and never those of another VM's listeners.
The service's unit has a `LimitNOFILE` that covers its slots (the installer sets it, #982: 2 listeners × 4 connections × slots,
the VMs' files and the app's connections, and the outer wall's proxy: a budget of 256 connections of two descriptors each, with room; 8192).

| Port | Message | The host |
|---|---|---|
| 5100 | `narrow`, `end` (Control) | **requires the VM's token** (`verify_control_message`; missing or wrong are answered alike, `refused` `invalid_request`) and a start that has an `ack`. `end` is acknowledged and noted (the exit report is the authority). `narrow` is answered only after the **outer wall** holds the rule (below); the same request again gets the same answer, another one after the first is `invalid_request` |
| 5101 | exit report (vm-init) | **takes the first** report that passes `verify_exit_report` and answers every later one with the same `ack` (vm-init repeats a report whose `ack` did not come); a report **without a token is accepted only while the start has no `ack`** (`start_timeout`, `start_invalid`: no job and no agent exists yet), otherwise it is closed without an answer |

The token's check has a twin in TypeScript (`dispatcher/src/launchers/control-token.ts`); both read `contracts/control-token-vectors.json`.
The token is in the start, in Control's stdin and in the messages; never in an argument, the environment, a file or a log.

**`narrow` and the outer wall.** The hook is `OuterWall` (`outer_wall.py`: `admit(vm)` before the VMM exists, `narrow(vm, message)`
and `forget(vm)`, the VM identified by its slot and TAP and the host and port of its app). `FACTORY_RUNNER_OUTER_WALL` chooses it:
**`refuse` (the default)** answers `refused` `unavailable`, so the Worker ends the job `environment_control_failed` before an agent
exists; **`proxy`** is the real wall, [the outer wall on a customer's machine](#the-outer-wall-on-a-customers-machine-979), `narrow`
answered `ack` only once the proxy holds the job's rule; `inner-only` answers `ack` and logs a warning for every VM that nothing was
narrowed (the agent's network is then the inner wall, the network door, only). **`proxy` is never the default:** the dispatcher is a
normal user and cannot read nft state, so it cannot know that the table is loaded, and a machine without the table has no outer wall.
The installer (#982) writes `proxy` into the unit explicitly, and only after `nft list table inet code_reviewer_wall` succeeds; in `proxy` mode the
dispatcher logs a warning at startup that it cannot verify the table itself. The two other modes are the operator's **explicit**
choices, never a silent `ack`. **A wall that raises or does not answer** (`narrow` is given 10 s at the wall) is answered `refused`
`unavailable` and logged with the kind of the error, never by dropping the connection: the Worker would wait for its own 30 s with the
failure unexplained in the host's log.

### Ending a VM

A VM's worker ends with the **first** of: an exit report (`worker_exited`, `docker_failed`, `prepare_failed`, `image_missing`,
`image_mismatch`, `start_invalid`, `start_timeout`; the status is the Worker's), the end of the VMM **without** a report (an unknown
outcome: exit code 1, the dispatcher gives the claim back as `worker_exited`) or the **wall clock** of the VM (exit code -9). The wall
clock is the host's, from the start of the VMM: **the job's timeout + Control's stop timeout (150 s) + the preparation (300 s)**, 4,050 s
for the default 3,600 s. A VM that reported is given 5 s to power itself off (the guest's `reboot=k` ends Firecracker), then it is killed.
Whatever ends it, before the worker returns: the VMM and its cgroup are killed (`cgroup.kill`), the listeners closed, the outer wall told
(`forget`), the **job disk and the VM's directory deleted** and the slot free. A VMM that will not die keeps its slot out of use (its TAP
may be busy) **and its cgroup stays** (it is not removed with a process in it) and the log says so; the next start of the service removes
both. The cgroup is removed off the event loop: it may take seconds for a killed process to leave it, and the other VMs' listeners are
served by the same loop.

The dispatcher's **stop** (a signal) kills the VM at once: the Worker inside cannot be asked to give its job back from outside, so the
dispatcher gives the claim back itself (`worker_exited`). The **local reaper** (`GET /jobs/{id}` every 60 s, 45 s of grace) stops the VM
of a job the app ended, as it did the process: it is the same code, per worker, so every slot is watched.

**One dispatcher per machine.** `setup` first takes an exclusive `flock` on `<state dir>/dispatcher.lock` (the kernel drops it when the
process ends, whatever way), before it touches the cgroup tree or removes anything: two dispatchers on one state directory would reap
each other's running VMs and share the slots and the TAPs. A second one, `run --once` included, ends with exit code 9 and says so. (The
Docker mode keeps its own guard, the lock container.)

**At every start of the service**, before the first claim (`setup`): the cgroup tree is made usable and **what an earlier service left is
removed**: each `vms/vm-*` directory (its process is the one whose command line is the **configured Firecracker binary** with
`--config-file <directory>/firecracker.json`, never a remembered pid and never a process that merely names a file of the directory, such
as a `tail -f` on its log; killed with its cgroup, the directory and its disk deleted) and every cgroup named like a VM's.

### Files under `/var/lib/code-reviewer/`

| Path | Content |
|---|---|
| `artifacts/vmlinux`, `rootfs.ext4`, `dockerdata.ext4` | the release's kernel, read-only root file system and base disk (the installer makes `artifacts` a link to the release's directory, #982; `FACTORY_RUNNER_VM_KERNEL`, `_ROOTFS`, `_BASE_DISK` move them) |
| `vms/vm-<slot>-<random>/` | one directory per running VM (0700), made before it starts and deleted when it is gone: `disk.ext4` (the job disk), `vsock.sock`, `vsock.sock_5100`, `vsock.sock_5101`, `firecracker.json`, `firecracker.log`, `vm.json` (VM, slot, job id: no secret) |

`FACTORY_RUNNER_VM_STATE_DIR` moves the state directory; keep it on XFS with `reflink=1` (the installer checks) for the 34 ms copy.

### What the machine needs (what the installer makes, #982)

Root, once: the group `kvm` and `/dev/kvm` for it; the service user in it; **one TAP device per slot** owned by that user
(`ip tuntap add dev fctapN mode tap user <user> group <user>`, with the /30 address above); the static nft table of #979; a systemd unit with
`Delegate=yes` and `User=`; `e2fsprogs` (`resize2fs`), `cp`. At runtime nothing needs root (spike #970): only the start of the service, `ExecStartPre=+`, runs as root, to switch releases, make the TAP devices
a restart took and check the table. `FACTORY_RUNNER_VM_CGROUP_ROOT` names a
delegated cgroup that is not the service's own (tests).

**Hardening without the jailer** (the open point of the spike; decided in #982): what is done is Firecracker's own seccomp filter and no capability (measured in #970), a directory per VM made 0700, an empty environment, one cgroup per VM that
kills the whole tree, no Docker or other service on the host, and **the unit's sandbox** (`ProtectSystem=strict` with only `vms/`, `dispatcher.lock` and the home writable, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, an empty
`CapabilityBoundingSet=`, `DevicePolicy=closed` with `/dev/kvm` and `/dev/net/tun`, the address families and the other restrictions listed under "Install", `LimitNOFILE`, `TasksMax`), and **the kernel, the root file system and the base disk
owned by root and read-only for the service**. **One unit per VM** (so that an escaped VMM does not see the other jobs' files) is not tried and costs a root-owned helper that starts transient units, which the "nothing needs root at runtime"
decision rules out; a user per slot would need root at install and a TAP owner per user. A VMM escape lands in the service user, which also owns the other VMs' disks: the installer makes a user that owns nothing else and refuses an existing one.
The options are checked against a real systemd by the installer lane and against real Firecracker by the first install (the checklist).

### Tests

Unit (`runner/tests/unit/test_firecracker_*.py`): the launcher against a **fake Firecracker** (a process that is a VM with vm-init in
it over the real Unix sockets, framing, session and token checks), slots, disks, cgroups on plain directories, the leftovers, the
template against the golden file, the settings, the service with a sandbox that has slots. The **KVM lane** (`runner/tests/kvm`,
the `Launcher lane` step of `.github/workflows/vm-artifacts.yml`, only for a change to its paths): T05 a real job (the Worker image
fetches a job from the fake App through the TAP, delivers its result) with the VM's cgroup limits read while it runs, nothing left
after it, the wall clock killing a real VM, **two jobs at once in two slots**, and **a VM left by a dispatcher that "crashed" found and
removed by the next one** (the real VMM killed by its command line, its directory and cgroup gone). The smoke boot of the same workflow proves that a container of the agent **cannot open a
vsock socket**: `vsock_denied_agent` (Docker's default profile, under Sysbox), its control `vsock_allowed_control` (Control's profile
allows it: the probe can see a socket), and `ia32_unavailable` (a 32-bit `int 0x80` / `socketcall`, which would bypass the profile's
argument filter, does not work on the guest kernel; on a kernel with IA32 emulation the same probe sees `EINVAL`).

### Not done here, follow-ups

- ~~The install, the update and the rollback~~ (done in #982: "Install", "Updates"); the `config set --parallel` command still refuses more than one (the installer writes `parallelRuns` through
  `--parallel-runs`); the no-Docker `selftest` (a VM boot as the self-test).
- A stop that asks the Worker in the VM to give its job back (`runner_shutdown`) before the VM is killed needs a channel to Control that
  vm-init does not have (a `stop` message over the start connection).
- The first measurement of "Control could start" with vm-init in the path and of the interpreter's start in a real guest (the lane prints
  the time to vm-init's `ack`).

## The Incus launcher (#1007)

The local Dispatcher's `WorkerSandbox` on **Incus** (Runner v2, epic #969, spike [#1005](#spike-incus-lxd-backend-1005),
"Spike: Incus (LXD) backend"): the one local backend, the same behaviour on every Linux machine, KVM or not. It **replaces the
[Firecracker launcher](#the-firecracker-launcher-978)** as the backend of the Linux dispatcher; that code stays until #1012 retires it, and `FACTORY_RUNNER_SANDBOX=firecracker` is still accepted
until then (the installer of #982 writes it). The program is selected with `FACTORY_RUNNER_SANDBOX=incus`.
Code: [`runner/src/code_reviewer_runner/factory_runner/incus/`](../runner/src/code_reviewer_runner/factory_runner/incus). **The dispatcher's `WorkerSandbox` interface is unchanged**: the service,
the claim loop, the reaper and the credential pool do not know which backend they run on.

```
                      the host (this dispatcher, a user of incus-admin)
 job socket ctl.sock  ◀──── incusd (proxy device) ◀──── A: Control, model door, network door, inner wall (nft)
 proxy 10.99.0.<8n+1>:3128 ◀── outer bridge <prefix>-<owner>-o<n> ◀── A eth0 (.2) │ eth1 10.98.0.2
                                              ◀── B eth1 (.3), unplugged at narrow │
                                                                                   │ inner bridge <prefix>-<owner>-i<n> (no address on the host)
                                                                  B: setup, then agent ── eth0 10.98.0.3  ──▶ only A:8080 and A:8081
```

### What a job does

1. **Slot.** `parallelRuns` slots (1 to 32). Slot *n* has two bridges, made once by `provision.py` (the installer, #1011): the **outer bridge**
   `<prefix>-<owner>-o<n>` (a /29 of the slots' network: the host's address first, where the outer wall's proxy listens, A's second, B's third; no DHCP, no NAT, no
   routing, no IPv6, no DNS from the bridge's dnsmasq, an ACL that lets a TCP connection to the proxy through and drops the rest) and the **inner bridge** `<prefix>-<owner>-i<n>` (no address at all: the host is not on it).
   **The owner** is four hex digits of a hash of the user and the state directory (`owner_id`): it is in the name of every instance, network and ACL and in the mark `user.cr.owner`, so two dispatchers on one Incus daemon
   (two users of `incus-admin`, as Luca and Vincent on the DevBox) never reap or reuse each other's objects. Two owners need **two slot networks** (the host's address of an outer bridge is on the host); a network's name is an interface name (15 characters: the prefix is short, `validated()` refuses a longer one).
   The dispatcher claims only while a slot is free; a job whose instances could not be deleted keeps its slot out of use until the service restarts.
2. **Token, socket, wall.** The start document is built and **checked first** (by vm-init's own parser: no credential in an argument, a job id and URL of the contract), so a start that would be refused costs
   no slot and no instance. A random per-job token; the job's directory `<state>/jobs/job-<slot>-<random>/` (0700) and **the listener on its `ctl.sock` before any instance exists**; the outer
   wall admits the job (the wide rule of the setup).
3. **Two instances** (`incus init`, **no profile**: the `default` profile and `incusbr0` are never applied), from the golden image on the pool, marked `user.cr.job`, `user.cr.slot`, `user.cr.role`, `user.cr.owner`:

   | | A (trusted) | B (untrusted) |
   |---|---|---|
   | content | Control (the Worker image in A's own Docker), the model door, the network door | the setup, **then the agent, in the same instance** |
   | `limits.cpu` / `limits.memory` | 2 / 2 GiB (`a_cpus`, `FACTORY_RUNNER_INCUS_A_MEMORY_MB`) | `vcpus` / `2 GiB × vcpus` (hosted table) |
   | root disk `size` (the quota) | `FACTORY_RUNNER_INCUS_A_DISK_GB`, default 8 GiB | `diskGb`, default 16 GiB |
   | `limits.processes` | 4096 | 4096 |
   | NICs | `eth0` outer, `eth1` inner; the `ctl` proxy device | `eth0` inner; `eth1` outer **until `narrow`** |

   Every instance: `security.privileged=false`, `security.nesting=true`, `security.idmap.isolated=true` (its own id range), `limits.memory.swap=false`, `boot.autostart=false`, `security.guestapi=false` (the guest API `/dev/incus`, once devlxd: the host's API for an instance, is nothing the setup or the agent needs: the launcher uses `incus exec` and a `proxy` device, not it).
   **The quota counts what the instance shares with its image** (referenced size on btrfs), so it must leave the job room; the write that passes it fails with `Disk quota exceeded` (EDQUOT, not "No space left"),
   and a full quota also stops Docker's own bookkeeping in that instance (it ends at the wall clock or by `end` and is deleted; **A's quota is its own, not a slice of B's**).
   Outer NICs have a **static address**, `security.ipv4_filtering` and `security.mac_filtering` (a packet must come from the NIC's address and MAC) and **`security.port_isolation`** (an isolated port reaches only the bridge's own address:
   A and B cannot reach each other there). The addresses come from **files pushed before the instance starts** (`/etc/systemd/network/05-code-reviewer-*.network`, applied by the image's systemd-networkd, no gateway and no
   route: nothing is routed): a NIC change re-creates the interface, and an address set by hand is gone.
4. **Start A, load the inner wall, start B**, wait until their addresses are applied and `docker info` answers in both (`ready_seconds`, 120), then **read the wall back** (`nft list table inet cr_inner` in A: every rule of the loaded ruleset, the drops especially, must be there; an absent or reduced table fails the start and everything is cleaned up: `nft -f` ending well is not proof). The wall is an nft table **inside A**, loaded before B runs
   (`walls.py`, printed by `inner_wall_ruleset()`): from B's NIC only a TCP connection from B's address to A's two door ports (8080, 8081) and the answers to what A asked; every other packet from B, and anything forwarded to or from B,
   is dropped; A's outer NIC takes nothing in but answers. Incus's own ACLs do **not** do this between two ports of one bridge (they need `br_netfilter`), which is why the table is ours; B cannot change it (another instance,
   another network namespace), A's root can, and A is the trusted side.
5. **Check, volume, Control.** In A: the Worker image's id must be the verified one (`image_missing`, `image_mismatch`), the work volume is made, and **Control runs with `incus exec`**: `docker run …` with the job document
   (`{appUrl, jobId, credential, controlToken[, localCredential][, outerProxy]}`, the one vm-init wrote) **on its stdin and nowhere else**. The arguments are the renderer's (`local-control.ts`) with three changes held by a test
   (`control_run.py`): `RUNNER_ENVIRONMENT_CONTROL=unix`, no vsock seccomp profile, `/ctl.sock` bind-mounted. `incus` is started with **stdin closed** (`/dev/null`) for everything that has no input: `incus init` and `launch` wait for the end of a
   stdin that is not a terminal and hang on a pipe that never closes (found in #1005). Its environment is `PATH`, `HOME` and the locale, plus `INCUS_CONF` (a **private directory**, `<state>/incus-conf`: no remote, no project) and `INCUS_PROJECT=default`, so the operator's own `~/.config/incus` (a personal remote, a switched project) is never what the launcher talks to; no argument holds a secret.
   A call that is cancelled kills and reaps its `incus` process.

### The environment control: a unix socket through a proxy device

Control connects to the Unix socket **`/ctl.sock`** (not under `/run`, which the instance's init hides under a tmpfs) with the frames, the token and the replies of
[`contracts/environment-control.v1.json`](../contracts/environment-control.v1.json) (new: `RUNNER_ENVIRONMENT_CONTROL=unix`, `ControlSocketPath`; the Worker's client is the vsock one with another connect). A **`proxy` device on A**
(`listen=unix:/ctl.sock connect=unix:<job dir>/ctl.sock bind=instance mode=0600`) makes the socket in A and connects every connection to the dispatcher's own socket of that job, so the connection is the job's own
(the check of the token and the first-wins rules are the vsock transport's: `VmSession`). The socket is on the service user's volume: **`incusd` does not see `/tmp`**. The round trip is 0.3 ms (p50, spike #1005).

**`narrow`** is answered `ack` only after the outer wall holds the job's rule **and B's outer NIC is hot-unplugged** (`JobWall`, 0.1 to 0.35 s): B has no way to the host from then on, and what the setup started in B (files, containers, **processes**) keeps running
(the same instance). A wall that refuses leaves the NIC in place and the Worker ends the job `environment_control_failed` before an agent exists; **an unplug that fails** (B keeps its way to the host) is refused too and **the launcher ends the job itself** (Control killed, `wait()` returns a stopped job with the reason, both instances deleted). A live change of `security.*` on a running NIC does **not** apply on Incus 7.6, which is why
`narrow` is an unplug and a changed rule would be a re-plug.

### The outer wall

Unchanged in kind: the proxy of this dispatcher (`firecracker/proxy_wall.py`, #979) listens on the host's address of each slot's outer bridge and serves **A's and B's addresses of that slot** (`SlotAddresses.also`) and no other source; `FACTORY_RUNNER_OUTER_WALL=proxy` as before. What the host's static nft
table adds (port 53 of host-local addresses, which Incus leaves open to an instance; the per-slot rules) is **#1008**; until it is installed an instance can still reach port 53 of an address of the host.

### Ending a job, clean-up

A job ends with the **first** of: the end of Control's `docker run` (its exit status is the Worker's, as vm-init's exit report was; **`EXIT_DISK_QUOTA` (122, EDQUOT) when it failed with the disk's quota**, the log tail starting `disk_quota_exceeded:`) or the **wall clock** (the job's timeout + Control's stop timeout + the
preparation, exit code −9). `stop()` kills Control's `exec` at once. Whatever ends it, **both instances are deleted** (`incus delete --force`, 0.3 to 4 s), the listener closed, the wall told (`forget`), the directory deleted and the slot given back before `wait()` returns.
**After a crash** the next service finds the instances **by their mark**: `user.cr.job`, **its own** `user.cr.owner` **and** a name `<prefix>-<owner>-a-…` or `<prefix>-<owner>-b-…`; an instance without the mark, with another prefix, of another owner (another dispatcher on the same daemon) or the machine owner's is never touched.
`setup` also takes the **lock** of the state directory (one dispatcher per machine) and **checks** that the pool, the image and both bridges of every slot exist **and are configured as the launcher needs** (`IncusNotReady` names what is missing or what differs): the inner bridge without IPv4/IPv6 addresses, the outer bridge with its ACL, `ipv4.nat=false`, `ipv4.routing=false`, no DHCP, `raw.dnsmasq=port=0`, and the ACL with exactly its one rule. A bridge that is there with another configuration is a foreign or drifted object: it is **never reconfigured**, the check (and `provision.ensure_objects`) fails and says which setting.

### Settings (`FACTORY_RUNNER_*`) and what the machine needs

| Variable | Meaning |
|---|---|
| `INCUS_POOL` (required) | the btrfs storage pool of the jobs (a copy-on-write pool: a job's disk is a snapshot, **0.2 s**, and the quota is enforced) |
| `INCUS_IMAGE` | the golden image's alias (default `code-reviewer-golden`) |
| `VM_IMAGE_ID` (required) | the Worker image's id the launcher checks in A |
| `INCUS_PREFIX` | the prefix of every object (default `cr`; the owner id follows it in every name) |
| `SLOT_NETWORK` | the slots' network, a /24 for up to 32 slots, chosen at install |
| `OUTER_WALL`, `VM_VCPUS`, `VM_STATE_DIR` | as for the Firecracker launcher |
| `INCUS_A_DISK_GB`, `INCUS_A_MEMORY_MB`, `INCUS` | A's quota, A's memory, the path of the `incus` program |

The service user is a member of **`incus-admin`, which is root-equivalent** (a member can create a privileged instance with the host's disks): the installer (#1011) creates a user that owns nothing else, and the service's unit is sandboxed as the
Firecracker service's is. The restricted per-user `incus-user` socket cannot set the options the instances need. **Root is needed at install only** (the group, the pool, the image and one throwaway instance so that
the first job does not pay the ≈ 21 s unpack of the image, the bridges and ACLs of `provision.py`, the host's nft table of #1008); `provision.py` creates only objects of the prefix, idempotently, and never touches the `default` pool or profile, `incusbr0`, or the host's Docker.

### Control drives B's Docker (#1017)

Placement is `implementer/placement.py`; the launcher tells Control with three variables in its `docker run` (`RUNNER_ENVIRONMENT_DOCKER=split`, `RUNNER_ENVIRONMENT_DOCKER_SOCKET=/b-docker.sock`, `RUNNER_ENVIRONMENT_DOOR_ADDRESS=10.98.0.2`, part of `control_run.unix_arguments`, held by a test). Unset, everything is as hosted.

| | hosted / Firecracker | Incus (`split`) |
|---|---|---|
| Control, the two doors | the VM's Docker | **A's** Docker; the doors run with **`--network host`** and listen on A's inner address only (`--bind 10.98.0.2:8080` and `:8081`, the wall's two ports): the inner wall's input chain matches traffic delivered to A, whereas a Docker-published port is DNATed and dropped by `forward … iifname eth1 drop` (by design). No model network, no connect, no door-side nft table (A has no default route, its outer NIC leads to the proxy of the host, the wall holds the inner side) |
| setup/agent container, readers | the VM's Docker, Sysbox | **B's** Docker, `runc`, the container privileged (it runs its own Docker; no Sysbox in an Incus instance: B's user namespace, cgroup and the inner wall confine it, as the spike measured). The readers run from the agent's golden image |
| how Control reaches that Docker | the VM's socket | a unix socket `/b-docker.sock` in A, from **two `proxy` devices**: B's (`bind=host`, listens on a file in the job's directory that only `incusd` reaches, connects to B's `/var/run/docker.sock`) and A's (`bind=instance`, listens at `/b-docker.sock`, connects to that file); mode 0600. A dials B. **B has no connection of any kind to A through it; no Docker API on a TCP port exists anywhere.** The launcher checks that B's Docker answers through A's socket before Control starts |
| networks | setup network (nft rules of ours), model network (`--internal`) | both are plain bridges of **B's** Docker (`code-reviewer-setup`, `code-reviewer-model`), the setup with the proxy variables of the outer wall; the setup's rules of ours are not installed (`install_rules=False`): the walls are the NICs (outer proxy for the wide rule, B's outer NIC unplugged at `narrow`, the inner wall in A) |
| hand-over of #1009 | leave setup network → pause (fail-closed) → Control reads the repo → model network → unpause | the same code, against B's daemon. **B's daemon is untrusted, so the pause is not a security boundary here** (a root process of B cannot influence Control: Control pulls what it reads through the checked fetch below) |
| the repository | one volume, Control, the readers and the agent mount it | the mirror and Control's checkout stay in **A's** volume. B has **its own volume** (`code-reviewer-work`: `repo/`, `result/`). **A→B, once:** a tar of the checkout Control made from its mirror (links stored as links, never followed) is put into a container that is made and never started (`PUT /containers/<c>/archive`). **B→A:** only `git upload-pack` in a reader, piped to Control's `git fetch` whose objects the mirror's git checks (`fsckObjects`); the list of branches is capped and every name validated, as hosted. No shared mount, no socket |
| memory guard | `MemoryGuard` reads the VM's `/proc/meminfo` | none: B's memory is its cgroup (`limits.memory`); a guard that reads B's memory is a follow-up |

Everything B's daemon says is data from the untrusted side: parsed with bounds, never put into a request to A's Docker (A's Docker only ever gets bodies made from constants and A's own identifiers).

**A connection through a `proxy` device cannot be half-closed (found by the whole-job lane, #1020).** The device ends the *whole* connection, the daemon's answer included, when one side shuts down its half. Every `docker exec` of the runner said "no more input" with `shutdown(SHUT_WR)` right after attaching, so every command in B
(`git rev-parse`, the readers, the setup script's write) came back with **empty output and exit status 0** (measured by hand with a client that did and did not half-close, through the same two devices). B's API is therefore `DockerApi(half_close=False)` (`Placement.environment_api`): `close_write` does nothing, a command without input attaches none (`AttachStdin: false`), and a command with input
reads exactly its length (`head -c <n> | <command>`, `exec_run.framed_argv`: the end of its input is the end of the `n` bytes; the exit status is the command's). The one streamed command, `git upload-pack` of the agent's repository, ends only when its input ends in protocol 2, so a split job fetches the agent's branches with **protocol 0**
(`RepoAccess.protocol_version`: the upload-pack ends by itself after the pack; the cost is an advertisement of every ref of the agent's repository instead of the one asked for, read through the pipe).

**Tests** (no Incus, no Docker): `tests/unit/test_split_docker.py` (two fake engines, A's and B's: where each thing is made, the doors' documents, the agent's definition and its seal check, the seed and the readers, the pipe's socket option, the profile), `test_incus_launcher.py` (the two devices, the variables, B's Docker not answering, the clean-up) and `test_incus_parts.py` (the arguments).

### Start budget

Nothing to the first container ≈ **4.5 s** at a moderate load (spike #1005 on btrfs: `incus init` 0.14 to 0.46 s, `start` 0.3 s, dockerd answers 2 s later, the first container 2 s), against the Firecracker launcher's 2.6 s.

With the real golden image (Docker, the Worker image, the agent image) `start()` took **6.7 to 10.3 s, median 7.5 s**, on the DevBox at a load of 4 to 8 ([#1020](#a-whole-job-on-incus-1020)).

### Tests

- **Unit** (`runner/tests/unit/test_incus_*.py`, **no Incus**): the launcher against a fake Incus (`incus_support.py`: instances, devices, files, `exec` from a table), the client against a stand-in `incus` program (`fake_incus.py`: its command lines, **stdin closed**, a bare environment,
  the limits of time), slots, settings, the walls, Control's arguments, the objects and the checks.
- **The Incus lane** (`runner/tests/incus`, `-m incus --force-enable-socket`, deselected by default): a real Incus, the launcher's real client, **stand-ins for the Worker image and Docker** (the host's `nft` and a `docker` that is Control, `fake_docker.py`), the proxy wall on the real bridge.
  Variables: `CR_INCUS_LANE_POOL`, `CR_INCUS_LANE_IMAGE` (an alias of an Ubuntu 24.04 image), `CR_INCUS_LANE_STATE` (a directory `incusd` can see), `CR_INCUS_LANE_PREFIX`, `CR_INCUS_LANE_NETWORK`.

**What the lane showed on the DevBox** (2026-11-11, Incus 7.6 Zabbly, btrfs pool `crpool`, kernel 6.8, as `luca`, a shared host at a load of 8 to 30; a stock Ubuntu 24.04 image plus the stand-ins; one job set of two instances of 2 CPUs and 2 GiB at a time; everything made carried the prefix `cr1007` and was removed again):

| Case | Observed |
|---|---|
| T01 limits | in both instances `nproc` 2, `/sys/fs/cgroup/memory.max` 2147483648, `pids.max` 4096; the root of an instance is a host id ≥ 65536 (`uid_map`), the mark `user.cr.job` on both; both deleted at the end, and the job directory gone |
| T01 crash | a job left running by a "crashed" dispatcher (its lock released): the next `setup` deleted exactly its two instances by their mark |
| T02 `narrow` | before: from B the proxy of the host `:3128` reached, the host's `:22` did not, `eth1` there; the unix-socket `narrow` from Control returned `ack`; after: `eth1` gone, no route to the host, `:3128` unreachable from B |
| T03 inner wall | from B with the wall: A's doors `:8080` and `:8081` reached; `:9000` (secrets), `:2375` (a "Docker API"), ICMP and `1.1.1.1:443` through A **not**; with the table deleted (the control) all four reached and ICMP answered; reloaded: as before |
| T04 quota | a write in B past its 3 GiB quota (the image counts: 633 MiB) failed with `Disk quota exceeded` after 2.6 GB; a 10 MB write (the control) worked; Control's own write past A's quota ended the job with `EXIT_DISK_QUOTA` (122) and the log tail `disk_quota_exceeded:` |
| start budget | `start()` (both instances, boot, addresses, wall, readiness, image check, Control launched; the stand-in `docker` answers at once): **4.6 s and 6.8 s** at a load of 13 to 30 |

The lane found two defects the unit tests could not: **`incus config device add` takes the device type as a word of its own** (`… eth0 nic network=…`), not as `type=nic`; and **Docker (or any readiness command) can answer before systemd-networkd has applied the pushed addresses**, so the launcher now also
waits until both instances show their addresses (`ip -4 -o addr show`; the golden image needs `iproute2`), which turned two flaky lane failures into none.
**What the lane does not prove**: Docker inside B and the agent's own containers (so "from the agent's Docker" of the walls is the spike's measurement, not this lane's), the real Worker image and the golden image, the host's static nft table (#1008), AppArmor and the real hardening flags.

### A whole job on Incus (#1020)

`runner/tests/incus/test_incus_whole_job.py` runs the job of the KVM lane's `test_whole_job.py` (#999) on this backend, on the DevBox: a real job claimed from the `FakeRunnerApp` over the runner API, started by the real `IncusSandbox` in **two real instances of the golden image**, with the launcher's own client (no stand-ins: Docker, `nft` and the images are the image's), the real proxy wall (`FACTORY_RUNNER_OUTER_WALL=proxy`)
and the same fakes behind public-looking names (`runner/tests/kvm/lane_internet.py`, a test CA that **only the lane's copy of the Worker image trusts**, the scripted model of `fakes/wire`). What runs for real: Control and the two doors in A's Docker, the inner wall as an nft table in A, the setup script in B's Docker through the proxy (wide rule), the hand-over (leave the setup network, pause, Control reads the
repository, model network, unpause), the real `narrow` over the unix socket (rule held, B's outer NIC unplugged), OpenCode in the agent's container in B calling the model through A's door and the proxy, the agent's commit fetched back through the checked fetch, the push over https through the proxy, the end report, and the deletion of both instances.

| Case | What it asserts |
|---|---|
| T01 | exit 0, the app got `ok`, the branch is on the lane's git endpoint with the agent's commit (both of its files), the job `succeeded` |
| T02 | the setup's fetch (before `narrow`) and the agent's fetch (after it) are in the commit, in that order around the acknowledgement of `narrow` |
| T03 | `narrow` carried the job's rule and the provider; the host only the setup may reach was reached by the setup and refused to the agent; the whole job's traffic is by name on 80 and 443; the report says `narrowed` |
| T04 | the provider got the real key (the agent in B has only the dummy) and the scripted turns, through the door and the proxy |
| T05 | no instance of the job is left, and `start()` takes under 90 s |
| T06 | a clone the proxy refuses ends `clone_failed`, pushes nothing, dials nothing else |

**Measured on the DevBox** (2026-11-13, Incus 7.6, btrfs pool `crpool` in a loop file, kernel 6.8, a shared host at a load of 4 to 8; A and B 2 vCPU and 2 GiB each; the image below): `start()` (two instances from the image, boot, addresses, wall, readiness of both Dockers, the image check, Control launched) **6.7 to 10.3 s over seven runs, median 7.5 s**; the whole job (setup container 5 s to start, script 1 s, hand-over under 1 s, two model calls, commit, fetch, push) **48 s**, the six cases **71 s**. The image: **1.6 GiB** in the image store (zstd), **4.4 GiB** unpacked in the pool (Worker image 1.9 GB and agent image 1.5 GB as Docker counts them, containerd store); an instance of it is a btrfs snapshot.
What the lane does **not** prove: the host's static nft table (#1008: the host's port 53, the drop counters), the freeze of a setup process under `docker pause` (#1009-T48 has no twin here yet: the setup container is a privileged runc container with its own dockerd, a follow-up), a real provider, a real git host, and a machine other than the DevBox.

**Variables.** The pool, state directory, prefix and slot network of the lane above, and `CR_INCUS_JOB_IMAGE` (the golden image's alias), `CR_INCUS_JOB_IMAGE_ID` (the Worker image's id) and `CR_INCUS_JOB_PKI` (the lane's CA): without them the lane is skipped. Run it as a member of `incus-admin`:
`sg incus-admin -c '. env; uv run pytest -m incus --force-enable-socket tests/incus/test_incus_whole_job.py -s'` in `runner/`. The state directory is under the user's home, never `/tmp` (`incusd` does not see it), and every object it makes carries the lane's prefix.

**The golden image and how to rebuild it.** `docker/incus/build-golden.sh` is the recipe (the product's, not the lane's): Ubuntu 24.04, the static Docker bundle of the golden snapshot's version (29.1.3) and buildx (`docker/incus/pins.env`, sha256-checked), `iproute2`, `nftables`, `iptables`, `git`, `docker.service` (`dockerd` starts and manages **its own containerd**, the spike's lesson: two units made the loaded images depend on which started first) and `daemon.json`; the Worker image and the agent image are streamed into its `docker load`
(no archive on any disk), it **restarts the build instance and checks that both images are there with the same ids**, publishes the image as the alias (`code-reviewer-golden` by default), starts one throwaway instance so that the first job does not pay the unpack, and prints `FACTORY_RUNNER_INCUS_IMAGE` and **`FACTORY_RUNNER_VM_IMAGE_ID`** (the Worker image's id, which the launcher checks in A). It makes and removes only objects of its prefix
(`<prefix>-bld`: a bridge and an instance); the build instance has **no way out but `docker/incus/build-proxy.py`**, a forward proxy on the host's address of the build bridge that reaches the Ubuntu archive only (and, for Claude Code, the npm registry: [#1023](#claude-code-on-the-incus-backend-1023)) (on the DevBox, whose Docker belongs to other users, a NATed Incus bridge does not leave the host: the same finding as the spike, which used a proxy too). The recipe takes the images from the caller's Docker
(`--worker`/`--agent` tags) or from a command that prints an archive (`--worker-command`/`--agent-command`, for a machine without room for the images twice). The lane's variant is `runner/tests/incus/build-lane-image.sh <pki dir> --pool crpool --prefix crlane` (heavy: `flock /tmp/cr-heavy.lock`): it builds `runner/Dockerfile` (`sandbox` with one more stage that appends the lane's CA to the bundle, and `agent`) and streams both into the recipe as `crlane-golden`, and prints the three variables above.
Rebuild it after **every change of the runner's code**: the Worker image in the image is the code the job runs (the whole-job lane found three defects because it ran the real image).

**What the lane found** (each fixed in #1020 with a test of its own; none was visible to the unit tests or the stand-in lane):

1. `disk_space()` read **btrfs's inode count (always 0) as a full inode table**: every job on the Incus pool ended `clone_failed: the repository leaves too little room on the disk` on an empty disk. A file system that reports no inodes (`f_files` 0) has no inode limit now (`tests/unit/test_disk_space.py`).
2. **Half-close through a `proxy` device** (above): every command in B returned empty output, which first showed as `setup_failed: the agent repository is not at the start tip`.
3. **The adopted agent container's tools got the hosted doors' addresses** (`10.213.77.x`, `proxy_environment` without the placement in `_exec_environment`): OpenCode in B sent its model calls to the network door's *hosted* address as a proxy, and every call ended `APIError`. The tools get A's doors on the inner bridge now.

### Claude Code on the Incus backend (#1023)

A runner on this backend announced only `opencode` (and, in the app, "opencode 0 (app-key)"): `prepare_incus` ran no harness check, so a job with `harness claude-code` / `auth subscription` never reached it. It does now, and **Claude Code is never shipped by us** (R3's rule, [#981](https://github.com/Itegro-GmbH/code-reviewer/issues/981) stays open for the question of shipping it in the image): the golden image is built **on the device** by `docker/incus/build-golden.sh`, and that script installs Claude Code there itself, exactly as the Docker mode builds its layer (R3, [Claude Code, R3](#claude-code-r3-856)). Our releases, images and repository contain no Claude Code.

| Step | Where | What |
|---|---|---|
| build | the device, `build-golden.sh` | after the two images are loaded into the build instance's Docker, `runner/scripts/build_claude_layer.py` hands the script **R3's own recipe** (`implementer/claude_code/layer.py`: the pinned version, the SHA-512 of the stub's npm tarball and of the platform program's, both checked with `sha512sum -c` under `set -e` before anything is installed, the program unmodified, its version checked after). There is **one pin**, no second copy. The layer is built on the agent image in the instance (`docker build` of the context the layer module prints, the packages through the build proxy, which now also reaches `registry.npmjs.org`, and nothing else) and kept under R3's tag (`code-reviewer-agent-claude-code:<version>-sha512-<digest>-<agent image id>`). A digest that does not match fails the build; a reboot of the build instance must show the same layer id, as for the two images. `--no-claude-code` leaves it out. |
| record | the image | what the programs themselves report (`opencode --version`, `claude --version`) is recorded as **image properties** (`code-reviewer.opencode`, `code-reviewer.claude-code`, `code-reviewer.claude-code.layer`, `code-reviewer.agent-image`); `build-golden.sh` prints `opencode <v>, claude-code <v>` at the end. |
| announce | `prepare_incus` (`incus/harnesses.py`) | a runner boots no instance to announce itself: it reads the image's properties (`CliIncusClient.image_properties`, one `incus image list`) and announces **OpenCode with its real version** and **Claude Code `ready` with auth `subscription`** when the layer in the image is **exactly the one this runner would build** (same tag: version, digests, base image id). A runner whose pin moved on, or an image built `--no-claude-code` or before the properties existed, announces no Claude Code and logs why and what to do (`build the golden image again with docker/incus/build-golden.sh`); an image that cannot be read costs the harnesses, not the machine. As for the Docker mode, whether the entry is **offered** is the dispatcher's pool's to say from the credentials the device holds at that moment (`credential_pool.py`, #980): a `credential add` after the start is offered without a restart. |
| job | Control in A, the agent in B | the look at the device that decides a job (`job_run.device_harness`) asks **B's Docker** (the layer and the agent image are in the image's Docker, which Control reaches through `/b-docker.sock`, `placement.environment_api()`), not the VM's default socket, and it reads no runner home (there is none in A): the login is the **local credential** the dispatcher chose for the job (#980, `job_loop/local_credential.py`). The launcher hands it to Control on its standard input in the start document (`build_control(local=…)`: one shape, one allow-list, never an argument), Control's job process has it as `CLAUDE_CODE_OAUTH_TOKEN`, `load_login` finds it there, and it is handed to the agent's container in B for the turn only. A layer or a login that is not there is `harness_not_ready: …` in words (never the value), and the job is never run with another harness. |

**Self-update is off by configuration**, as in R3: the agent's environment carries `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (`claude_code/command.py`), and the agent's container has no way to the internet but the network door's one rule (`api.anthropic.com`).

**Tests.** Unit, no Incus (`tests/unit/`): `test_incus_golden_build.py` (the script's structure: the pin comes from the layer module and nowhere else, the digests are checked before the install, `--no-claude-code`, the proxy's allowed hosts, the properties), `test_incus_harnesses.py` (what an image says and what a runner announces from it, including a layer that is not the pinned one), `test_incus_client.py` (`image_properties`), `test_device_harness.py` (B's Docker for the split placement, the local credential, the words of a refusal). The lane (`tests/incus/test_incus_golden_harnesses.py`, on the DevBox) reads the properties of the **real** golden image the way the runner does and runs `claude --version` and `opencode --version` in the layer and the agent image in an instance's own Docker.
A whole Claude Code job against a fake endpoint is **not** in the lane yet: the subscription path ends at `api.anthropic.com` through the network door, a name that the lane's test CA (one domain, a critical name constraint) does not sign for and that the agent's container, whose adapter sets no CA of its own, would not trust.

**On the DevBox.** Rebuild the golden image with `/home/luca/factory-runner/logs/build.sh` (the same command as before; it now also builds the layer and needs the machine's internet for the npm registry through the build proxy; it adds about two minutes and about 0.3 GB to the image), add the credential once (`factory-runner credential add claude --name NAME`, the token of `claude setup-token`), and restart the service. The log of the start names `claude-code` as offered when the credential is usable.

### Not done here, follow-ups

- **The Worker's use of the two instances** is [#1017](#control-drives-bs-docker-1017); the full job with the real engine on this backend is [#1020](#a-whole-job-on-incus-1020) (above), run on the DevBox, not in CI.
- **The golden Incus image's release artifact** (signed, with a manifest, as the VM artifacts are: #1012, #1011); the recipe is `docker/incus/` (#1020, above). The first start of an image in a pool unpacks it, which the installer pays once (the recipe does it with one throwaway instance).
- **A CI lane with Incus** on `ubuntu-24.04` (needs the golden image and root for Incus's own install); the lanes here run on the DevBox. The twin of the freeze test (#1009-T48) and a **quiet-host re-measure** of the start budget are open; so is a **protocol 2 fetch** for B (the advertisement of every ref is read with protocol 0) and a guard that reads B's memory.
- **The host's nft table** (#1008), the installer and updater (#1011), conformance suite (#1010), removal of the Firecracker code, the kernel/rootfs release artifacts, the KVM lane and vm-init's vsock side (#1012).

## The outer wall on a customer's machine (#979)

Hosted, a job's VM sits in Vercel's internet and Vercel's network policy is the outer wall. On a customer's machine the VM sits next to the
host, its LAN, internal services and the cloud metadata address, and a NAT is no policy (Runner v2, epic #969,
[ADR 0005](decisions/0005-runner-v2-one-dispatcher-contract.md), decision 7). So **the VM has no direct internet**: a static nft table lets
its TAP reach only a proxy of the local Dispatcher, which enforces the rule of the job. The inner wall (the network door inside the VM) is
unchanged. Code: [`proxy_wall.py`](../runner/src/code_reviewer_runner/factory_runner/firecracker/proxy_wall.py) (the proxy and the wall),
[`outer_rule.py`](../runner/src/code_reviewer_runner/factory_runner/firecracker/outer_rule.py) (the rule),
[`docker/vm/host/outer-wall.nft`](../docker/vm/host/outer-wall.nft) (the table).

```
 VM ──TAP fctapN──▶ [ nft: code_reviewer_wall ] ──only TCP :3128 to the slot's address──▶ proxy (the service, a normal user)
      everything else (host, LAN, RFC1918,                                                   │ wide rule while the setup runs
      169.254.0.0/16 and the metadata address,                                               │ the job's rule after an acked `narrow`
      UDP and DNS, ICMP, the other VMs,                                                      ▼
      the internet, IPv6) is dropped                                          the internet, to an address that was checked
```

### The nft table, in full

One table of its own, loaded once at install as root (`nft -f docker/vm/host/outer-wall.nft`; the installer is #982) and never changed
while VMs come and go: changing a job's rule never touches nft. **Every rule names our TAP devices (`fctap*`), so the host's own traffic
and every other table of the machine, Docker's included, are untouched**; the file never names another tool's table. It hooks at
priority -150, before other firewalls' filter hooks at priority 0, and its chains accept what is not ours. Loading it again replaces
what an earlier load made (`table`, `delete table`, `table`). The file, exactly as it is checked in (a test holds this page to it):

```
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The outer wall of a customer's machine (#979, Runner v2, ADR 0005, decision 7): a static nft table, loaded once at
# install as root (the installer, #982, renders this template and runs `nft -f` on the result) and never changed while
# VMs come and go. `@SLOT_NETWORK@` is the network of the slots, chosen at install so that it overlaps no address or
# route of the machine (`FACTORY_RUNNER_SLOT_NETWORK`); the installer replaces it and nothing else. It is a table
# of its own and every rule of it names our TAP devices (`fctap*`, one per slot), so the host's own traffic and every
# other table of the machine are untouched. A VM may do exactly one thing: open a TCP connection to the proxy of the
# local Dispatcher (port 3128) on a slot's address of @SLOT_NETWORK@ (the proxy listens on those addresses only, and
# only the slot's own VM is served), and receive the answers. Everything else a VM sends is dropped: the host's other
# ports, addresses, ICMP and UDP (DNS included: the proxy resolves names), the LAN, RFC1918, link-local and the cloud
# metadata address (169.254.169.254), the other VMs, the internet, and IPv6 altogether. A packet must come from the
# address of the slot whose TAP it arrives on (a reverse-path check): a VM cannot send another slot's source address.
# The VM has no way out but the proxy, which enforces the rule of the job (wide for the setup, narrowed after
# `narrow`): changing it never touches this table. Priority -150 runs before the filter hooks of other firewalls at
# priority 0. A rule that is missing never opens anything: the last rule of each chain drops all that is of ours, and
# `nft -f` loads the file in one transaction. Only the table itself being gone opens the wall: the service checks it at
# every start and as root while it runs (`factory-runner check-wall`, docs/runner.md, "The outer wall is checked").
table inet code_reviewer_wall
delete table inet code_reviewer_wall
table inet code_reviewer_wall {
  chain input {
    type filter hook input priority -150; policy accept;
    iifname "fctap*" meta nfproto ipv6 counter drop comment "no IPv6"
    iifname "fctap*" ip saddr != @SLOT_NETWORK@ counter drop comment "not an address of a slot"
    iifname "fctap*" meta nfproto ipv4 fib saddr . iif oif missing counter drop comment "source not routed back to this TAP (reverse path)"
    iifname "fctap*" ct state established,related counter accept comment "answers"
    iifname "fctap*" tcp dport 3128 ip daddr @SLOT_NETWORK@ fib daddr type local counter accept comment "the proxy"
    iifname "fctap*" counter drop comment "everything else addressed to the host"
  }
  chain forward {
    type filter hook forward priority -150; policy accept;
    iifname "fctap*" counter drop comment "a VM forwards to nothing"
    oifname "fctap*" counter drop comment "nothing forwards to a VM"
  }
  chain output {
    type filter hook output priority -150; policy accept;
    oifname "fctap*" ct state established,related counter accept comment "answers to the VM's connections"
    oifname "fctap*" counter drop comment "the host opens no connection to a VM (vsock is the channel)"
  }
}
```

What each rule does:

| Chain | Rule | Why |
|---|---|---|
| input | from a TAP: IPv6, drop | the guest has no IPv6 and the proxy none; nothing of IPv6 is allowed anywhere |
| input | from a TAP: source not in the slots' network (`@SLOT_NETWORK@`, rendered by the installer), drop | a slot's addresses are in that network (`slots.py`); anything else is a spoof |
| input | from a TAP: IPv4 whose source is not routed back to this TAP (`fib saddr . iif oif missing`), drop | the reverse-path check: the table lets any address of the slots' network in, so without it a VM could send **another slot's source address** (and the answers of the proxy to it would go to the real owner); with it a packet is accepted only from the address of the slot whose TAP it arrives on |
| input | from a TAP: established or related, accept | the answers of the proxy |
| input | from a TAP: TCP to port 3128 of a local address in the slots' network, accept | **the one thing a VM may open**: a connection to the proxy, on a slot's address (the proxy binds those and no other) |
| input | from a TAP: everything else, drop | the host's other ports, ICMP, UDP (a guest's DNS included: the proxy resolves), the host's other addresses |
| forward | from or to a TAP, drop | a VM forwards to nothing (LAN, RFC1918, 169.254.0.0/16 and `169.254.169.254`, the other VMs, the internet) and nothing forwards to a VM. The host may forward for others; the table, not the absence of routing, is what stops a VM |
| output | to a TAP: established or related, accept; everything else drop | the host opens no connection to a VM (vsock is the channel) |

The table lets a TAP reach the proxy port of **any** slot's address (the slots' network), because the table is static and a slot's address is
derived from its number; the proxy therefore **closes unanswered any connection whose source is not its own slot's guest** (a VM
that connects to another slot's proxy). **The reverse-path rule** (`fib saddr . iif oif missing`) is what stops a VM from sending
another slot's source address in the first place: a packet is accepted only when the route back to its source leaves by the TAP it
arrived on, which is the case for the source of the slot that TAP belongs to and for no other (the proxy's own check stays, the two
are independent). The lane checks the file with `nft -c -f` and then loads it. Port 3128 is a constant of the code too (`PROXY_PORT`); a test holds the file to it, to `fctap*` and to the slots' network (`@SLOT_NETWORK@`, the placeholder the installer fills in).

### The outer wall is checked while the service runs

The table is loaded at install and again by `prestart` at every start of the service, which fails the start unless `nft list table inet code_reviewer_wall` answers. That is a check **at the start**: a
flush of the machine's rules afterwards (a reload of `nftables.service`, a firewall tool, a person) would leave a running service without its wall. So two things more, neither of which needs the service to read nft (the service user cannot):

- the unit is `After=` and `PartOf=nftables.service`: a restart of `nftables.service` restarts the service, whose `prestart` loads the table again;
- **`factory-runner-wall.timer`** (root, every 10 seconds) runs `libexec/host.sh check-wall`: when the service is active and the table is gone it **restarts the service**. The stop kills the VMs (their jobs go back to the queue), and the
  start loads the table again or, when it cannot, **does not start the service**. The installer lane flushes the whole ruleset while the service runs and requires the table back and the service restarted within 40 seconds.

A **missing rule** never opens the wall: the last rule of each chain drops what is ours, and `nft -f` loads the file in one transaction. Only the table being gone opens it; that window (up to the timer's period and the time of
a stop) is in "Known limits".

### The slots' network

The table, the TAP devices, the proxy, the launcher and vm-init no longer share a built-in `172.31.0.0/16` (the default VPC of AWS, with the Amazon DNS at `172.31.0.2`, and Docker's address pools overlap it). The network is **chosen at install**
([Install](#install-a-machine-with-kvm-982): the first `/24` that overlaps nothing the machine has), kept in `install.state`, and passed on as `FACTORY_RUNNER_SLOT_NETWORK` in `runner.env`. The table in the program is a template
(`@SLOT_NETWORK@`, the one thing the installer fills in; the file above is printed as the program carries it) and the installer renders it, checks it with `nft -c -f`, loads it and lists it again. The launcher (`slots.py`: slot *N*
owns the `/30` at offset *N*×4 of that network) and the proxy read the same setting, and vm-init accepts any **private** IPv4 address (`10/8`, `172.16/12`, `192.168/16`) for `outerProxy`, since a VM does not know the
network and the table is what lets it reach exactly its slot's address. `DEFAULT_SLOT_NETWORK` (`172.31.0.0/16`) is for the tests and the KVM lanes.

### The proxy

Part of the local dispatcher, the service's own user, no root. `ProxyOuterWall` is the `OuterWall` of `FACTORY_RUNNER_OUTER_WALL=proxy`,
started by the launcher's `setup` (after the lock of the machine) and stopped by its `close`; a proxy that cannot listen ends the start of
the service and says which TAP and address (the usual cause: the TAP was not made or has no address, #982). **At startup it logs a warning
that it cannot verify the nft table** (it has no way to read nft state as a normal user): `proxy` is set by the installer after it has
verified the table, never assumed.

* **It listens on each slot's TAP address and on nothing else** (the first address of slot *N*'s /30 in the slots' network, port 3128). The spike (#970)
  found that a guest could also reach a proxy on the host's other addresses (eth0, loopback); a proxy bound to the host's side of each TAP
  cannot be reached there whatever a table says, and the listener, not the source address, says which VM a connection is from.
* **A rule per VM, swapped without touching nft.** `admit` (called before the VMM exists) gives the VM the **wide rule** of the setup: any
  public name on ports 80 and 443. `narrow` replaces it by the **job's rule** and returns, so the host answers `ack`, only when the proxy
  holds it; it also ends the connections the setup left open (a tunnel opened under the wide rule must not outlive it). `forget` takes the
  VM's rule away (it never takes the rule of a newer VM of the same slot). A slot with no VM serves nobody (`no_job`).
* **A tunnel ends as a whole.** Ending the setup's connections (at `narrow` and `forget`) shuts **both halves of each tunnel**, the guest's
  and the origin's: an origin that says nothing and never closes would otherwise keep the handler (and the slot's permit) until the idle
  timeout. The handler returns at once and the permit is given back (tested with a silent origin that never closes).
* **A decision belongs to the rule it was made under.** Every `narrow` and `forget` makes a new *generation* of the slot's rule, and a
  decision carries the generation it was made under. A request that was decided under the wide rule (a slow resolver, a slow connect)
  is dropped (`403 rule_changed`) once the `narrow` is acked: the generation is checked before the connection is made and again before
  the first byte is sent (the bytes of the request that were already read are never sent under a rule that is gone). Without it a name
  looked up under the wide rule could be connected after the acked `narrow`.
* **Limits of the process.** Each slot serves at most 128 connections; **all slots share one budget of 256** (`TOTAL_CONNECTIONS`: a
  connection holds two descriptors, the guest's and the origin's), so busy slots cannot use up the descriptors of the dispatcher. A
  connection over the budget gets `503 too_many_connections` without a thread. A listener that meets `EMFILE` (or `ENFILE`, `ENOBUFS`,
  `ENOMEM`) **backs off** (0.2 s) and logs a warning at most every ten seconds, instead of spinning on its readable socket. The unit
  needs a `LimitNOFILE` that covers the budget (8192 is ample; the installer sets it, #982: see the note on `LimitNOFILE` above).
* **The host's own addresses are refused too.** A name that resolves to an address of the machine the proxy runs on (its public one, on a
  machine that has one) is public by range; the proxy refuses it (`private_address`) and a name with one such address among public ones as a
  whole. The addresses are every IPv4 address of the host, from the kernel's table (`/proc/net/fib_trie`: no command, no privilege), read
  at startup (a host that cannot list them has no wall: the start fails and says so) and again when older than 30 s, so an address the
  host gains later is refused after the next read; a read that fails keeps the last list. **The in-VM network door has the same gap**
  (a name that resolves to the machine the door runs on; a VM has only private addresses, but the door also runs as a process of a
  machine): the shared decision has the hook (`Decider(excluded=...)`, off by default so the door and hosted decide as before), and the
  door's use of it is a follow-up (#998).
* **The job's rule is the hosted second wall's**: GitHub (`github.com`, `api.github.com`), the model provider's host (`modelHost` of the
  `narrow`), the host of the app (the job's `appUrl`) and the rule's own hosts, a `*.suffix` as itself (strictly below the suffix, as the
  door matches); a rule that is `open` is not narrowed, as hosted. It is **`policyFor` of `dispatcher/src/network/rule.ts`** without the
  Dispatcher's own host (a local machine has none), and a test holds the two to **one examples file**,
  [`contracts/network-rule-examples.json`](../contracts/network-rule-examples.json): which rule documents are rules
  (`dispatcher/src/network/network-examples.test.ts` with the hosted schema, `runner/tests/unit/test_firecracker_outer_rule.py` with the
  runner's), which names the narrowed list holds, and the verdict on a set of names and ports. **What runs hosted code on each side:** the
  TypeScript suite runs the hosted schema (`NetworkRuleSchema`) for the rule documents and the hosted `policyFor` for the lists; **its
  verdict half (T03's last test) runs a small matching helper of the test file**, not the hosted matching, which is Vercel's network
  policy and cannot run in a unit test. The runner's suite runs the runner's own parser, list and decision (`Decider`) for all three. A
  model or app host that is not a name a rule can hold (an address, a host of one label) is a **refused `narrow` (`unavailable`) that says
  so**, not a rule that cannot work. **So is an app on another port than 80 and 443** (`http://localhost:3000`, a staging on 8443): the proxy
  dials 80 and 443 for every name and the wall does not make an exception to the port rule for one name (a second decision the hosted rule
  code does not make), so the `narrow` of such a job is refused with the port in the log (`OuterRuleError`), not acknowledged with a rule
  the Worker cannot use. The port comes from the job's `appUrl` (the URL's own, else the scheme's); a customer whose app is not on a web
  port needs a decision of its own, not a silent widening of the port rule (#994 wired the software in the VM to the proxy: the app's
  calls now go through it, so the app must be on a web port; with the proxy wall the launcher **refuses such a job before it takes a slot, a disk or a VMM** (`StartFailed`: the claim goes back, #999), instead of booting a VM that ends at its first call).
* **DNS is the proxy's.** A guest asks for `CONNECT name:443` (or an absolute-form HTTP request) and the proxy looks the name up; the guest has
  no name server it can reach (UDP is dropped). The decision is **the network door's own code** (`implementer/netdoor/proxy.py`), so the two
  walls cannot drift: an IP address is never a name (`ip_literal`, in every spelling a resolver reads), only ports 80 and 443, the rule must
  list the name **before** anything is looked up, **every address of the name must be public** (private, loopback, link-local, the metadata
  address, shared, special-purpose and reserved ranges are refused, a name with one public and one private address as a whole), and the proxy
  **connects to an address it checked, never to the name again**, so a resolver that answers differently the second time changes nothing. IPv4
  only. A refusal is a `403` whose body says `outer wall: <reason>`; a setup tool that fails says why.
* **No test network.** The door's `NETDOOR_TEST_PUBLIC_CIDR` seam is not used: no setting can open a private range for a VM.
* **What the host's log keeps** is a count and the kind of an error: at the end of a VM `outer wall: N connections allowed, M refused`; the
  slot's record (`log_of`: host, port, allowed or refused, reason word, bytes; never a path or a header) is what the lane reads.

The settings: `FACTORY_RUNNER_OUTER_WALL` is `refuse` (the default), `proxy` (set by the installer after it verified the table) or
`inner-only` (see above); the port is not a setting (the table names it).

### Every client in the VM goes through the proxy (#994)

With the table loaded nothing leaves a VM but a connection to the proxy of its slot, so every client in the VM that dials the internet has
to use it. The proxy's address is **the host's, never the job's**: the launcher puts it in the start (`outerProxy`, the host's address on
the slot's TAP and the port 3128; only with `FACTORY_RUNNER_OUTER_WALL=proxy`), vm-init validates it (a private IPv4 address in its
canonical spelling, since the slots' network is the installer's choice for each machine, and a port; a start with anything else is refused) and writes it into Control's stdin document, and
Control hands it on. No job document, no container environment and no flag of a rendered `docker run` carries it (the local Control spec,
its template and its golden file are the same with and without the wall; the hosted specs and goldens never mention a proxy, and a test
holds that). Code: [`outer_proxy.py`](../runner/src/code_reviewer_runner/outer_proxy.py) (the address, the variable, the tunnel).

```
 start (launcher) ──outerProxy──▶ vm-init ──Control's stdin──▶ Control ──RUNNER_OUTER_PROXY (the job process only, set by Control)──▶ job process
 Control's Worker API calls ───────────────────────────────────────────────┐                                                       │
 git (clone, fetch, push; https only) ◀────────────────────────────────────┼───────────────────────────────────────────────────────┤
 model door (upstream CONNECT name:443, TLS through it) ◀──────────────────┼── its start document carries outerProxy ◀─────────────┤
 agent ─▶ network door ─(CONNECT name:port)─▶ ... ─────────────────────────┼── its start document carries outerProxy ◀─────────────┤
 Setup container (HTTP(S)_PROXY, its dockerd too) ◀────────────────────────┴── the container's own Env, its table lets only the proxy out
                                              └──────────────────▶ the outer wall's proxy on the slot's address ──▶ the internet
```

| Client | How it uses the proxy | Fails closed because |
|---|---|---|
| Control's calls to the app (`HttpWorkerApi`) | the opener's one handler is the proxy (`job_loop/http.py`): `http` as an absolute-form request, `https` as `CONNECT`, **no bypass** (urllib's own handler skips a host the environment's `no_proxy` names, this one never does) | a refusal is a status the Worker API reads as a refusal, an `https` refusal and a proxy that is not there are `ApiUnavailable`; nothing dials the app |
| `git` (the mirror's clone and fetch, the final push) | `http.proxy` in the one process's `GIT_CONFIG_*` (`git_process.token_environment`), beside the token header; `GIT_ALLOW_PROTOCOL` stays `https`; the closed environment has no `no_proxy` and no other proxy variable | git does not retry a refused tunnel directly; the proxy sees `CONNECT host:443` and never the token |
| the model door's upstream (`HttpsUpstream`) | `CONNECT <name>:443` to the proxy, then TLS to the name through the tunnel (certificate and name verified as before); the door does no lookup and connects to no address of its own (the proxy decides every address with the same code) | a refusal is `address_refused` (403) or `unreachable`, a call that never left and sent no key (**a base URL that is an IP literal always fails this way**: the proxy never serves an address, so a provider reached by address, `https://203.0.113.9/v1`, does not work on a local machine; give it a name, which is what the catalog's own rule asks for too); the door's **firewall** (`door_launcher.egress_rules`) lets it dial the proxy's address and port and nothing else (no DNS, no port 443, the model network shut) |
| the network door (agent → door → proxy) | after the door's rule and port decision it asks the proxy for `CONNECT <name>:<port>` and relays (plain `http://` too: a tunnel to port 80 and the request in origin form); an IP literal, a port other than 80 and 443 and a name outside the rule are refused by the door before the proxy is asked | a refusal or a missing proxy is the `502 upstream_failed` the agent gets for a host that does not answer; the door's firewall (`netdoor_launcher.egress_rules`) allows the proxy and drops the rest, the test network's seam included |
| the container of the script (wide phase; the agent's own container since #1009, before it narrows) | `HTTP_PROXY`, `HTTPS_PROXY` (and lower case) and a loopback `NO_PROXY` in its definition, so the script's package managers, `git`, `curl` and its Docker daemon (which reads them for pulls) go through the proxy, which applies the wide rule; the seal check allows exactly those variables | the VM's table for the Setup bridge (`setup_container.egress_rules`) lets it reach the proxy's address and port and **drops everything else** (no DNS, no other address, no other port): a tool that ignores the variables finds no way out. **What the variables do not reach: a container the script starts itself** (`docker run`, `docker build`, a `RUN npm ci` of a Dockerfile). The Docker *client* gives a container the proxy variables only from its own config (`~/.docker/config.json`, `proxies`) or from the command line, so such a container has no proxy, the bridge's table drops its traffic, and its tool fails to connect. Pass them: `docker run -e HTTP_PROXY -e HTTPS_PROXY ...`, `docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY ...` (the script's environment holds them; an argument without a value takes the script's). Only the proxy's address is reachable from the bridge, so this is the whole recipe |

The **inner wall is unchanged**: the agent still reaches only its doors, and the doors are the only things that dial for it. The network
door's decision (rule, port, IP literal) is the same code in both walls, so the outer wall repeats it with the proxy's own lookup and
public-address check; a name that the door's rule lists and the job's outer rule does not is refused at the proxy and reaches the agent as a
`502`. Hosted is unchanged: no proxy is set, every client dials as before, and each of the code paths above keeps its hosted behaviour when
`outerProxy` is absent (tests hold the hosted rules, documents and goldens byte for byte).

**The setup and the agent are one environment (#1009, [ADR 0005](decisions/0005-runner-v2-one-dispatcher-contract.md), 3j).** The behaviour contract's item 9 reads: the setup runs with its own Docker and the wide rule and no secret; **what it leaves, files, images, containers, volumes and running processes, is what the agent has; its processes keep running after the hand-over; nothing is reset at `narrow`** (the agent can use, stop and start them). The container of the script is the agent's container, made once on the setup network; when the script ends it leaves that network (so the proxy variables above are the setup phase's only, and the setup's open connections are cut before `narrow`), is frozen while Control reads the repository and goes on the model network, and the agent's tools get the network door's variables instead of the proxy's (`docs/implementer.md`, "One container, two phases"). On this Firecracker path nothing else changed: the VM, the outer wall and `narrow` are as described above, and the Incus launcher (#1007) has one instance for both phases by construction.

**What a job on a local machine needs to know.** The app must be on port 80 or 443 and a name (see the rule bullet above): the Worker's first
call goes through the proxy under the wide rule, and the proxy dials 80 and 443 only. A setup script's tool that does not read the proxy
variables (a raw socket, a tool that sets its own) cannot reach the internet; that is the wall working. A model provider or app host that
the proxy cannot resolve (it is the proxy's lookup, IPv4 only) fails the same way a host that does not answer does.

### What the lane proves (and what it cannot)

`tests/kvm/test_outer_wall.py`, the `Outer wall lane` step of `.github/workflows/vm-artifacts.yml` (a real VM, run twice):

* **T01.** From the VM: the host's TAP address, RFC1918 addresses (10/8, 172.16/12, 192.168/16), a link-local address, **the real cloud
  metadata address `169.254.169.254:80`**, an address of the internet and an IPv6 address are unreachable with the table loaded, and the host's
  own listeners saw no connection. **Every probe has a control:** the first run has **no table** and NAT on, and every probe (but IPv6) must
  *reach* its target and the host's listeners must see the connection arrive; a probe that says "blocked" proves nothing unless the same probe
  reached its target without the wall (the spike's lesson). The workflow also checks the file with `nft -c -f` and prints the table's counters
  after the run.
* **T02.** A setup-only host (`example.com`) is reachable through the proxy before `narrow` and refused after, with a **real `narrow` over
  vsock carrying the VM's token**: the Worker's own client (`VsockControl`) in the VM, the host's real session and the real wall. A `narrow`
  without the token from the same container is refused, GitHub stays reachable, and the metadata address is refused even as a name the proxy
  was asked for.

* **The clients (#994, `tests/kvm/test_clients_through_proxy.py`, the `Clients lane` step, the table loaded).** A real VM runs
  `tests/kvm/clients_probe.py` in Control's own container with the proxy wall (`FACTORY_RUNNER_OUTER_WALL=proxy`): the start carries the
  slot's `outerProxy`, vm-init writes it into Control's stdin, and the probe **reads it from there** and uses the product's own clients from
  the Worker image: the Worker API's opener (a call to `http://example.com` and `https://example.com`, certificate verified through the
  tunnel), `git ls-remote https://github.com/octocat/Hello-World.git` as the workspace runs git, the model door's `HttpsUpstream` to
  `api.anthropic.com`, and a network door (the real `ProxyServer` with a chained `Decider`) in front of the same proxy. It runs them before
  and after a real `narrow` (the Worker's own client, over vsock, with the VM's token): before, the wide rule lets them all through and
  `example.org` too; after, the app, GitHub and the provider still go through, `example.org` is refused (at the proxy for the opener,
  through the chained door as a `502`), a direct connection to `1.1.1.1:443` is unreachable both times, and a client whose proxy is not
  there fails. The host's own record of the proxy (`log_of`: name, port, allowed or refused, reason) is checked too. The probe runs here
  first against loopback stand-ins and the real proxy wall (`tests/unit/test_firecracker_clients_probe.py`: everything but TLS to a real
  host and git against GitHub).

**What the lane chose, and why.** A job clones its repository over https before it narrows the network and a lane has no https git host, so
no job of the lane gets as far as `narrow`. Instead of a fake git endpoint, the lane runs **a probe in Control's own container** (the same
`docker run` flags, the token on stdin, the seccomp profile that allows AF_VSOCK; the Worker image's interpreter as entry point), because the
`narrow` is then the Worker's own client over the real vsock with the real token, and everything the proxy decides is on the real path.
vm-init drops a container's output and the exit status holds eight bits, so the probe **reports through the path under test**: a
`CONNECT r<bits>.report.invalid:443`, which the proxy refuses and logs with the host name it was asked for, where the lane reads it. The probe
runs in the unit suite too, against loopback stand-ins and the real proxy, session and client
(`tests/unit/test_firecracker_wall_probe.py`), so a mistake in it does not cost a half-hour run of CI.

**IPv6 has no control.** The VM's containers have IPv6 switched off (Control's flags) and the guest has no IPv6 route, so an IPv6 probe is
unreachable with or without the table. The table's IPv6 rules are checked as a file (`nft -c`, a unit test of its rules) and not
exercised by a packet; the lane says no more than that.

**What the clients lane does not do.** It does not run a whole job: the outer wall's `narrow` is still the probe's, the clone is a
`git ls-remote` of a public repository and not the Worker's clone of a customer's repository, and the Setup container and the agent are not
started in Sysbox with the table loaded. That is the whole-job lane below.

### A whole job in the lane (#999)

`tests/kvm/test_whole_job.py`, the `Whole-job lane` step (20 minutes at most) and the `Whole-job lane, the drop counters` step (always) of `.github/workflows/vm-artifacts.yml` (a real VM, the table loaded, `FACTORY_RUNNER_OUTER_WALL=proxy`).
One real Implementer job, from the claim to the push:

```
 fake App ◀──claim (runner API, loopback)── the lane's dispatcher side ──start {http://app.lane.example.com, jobId, crj_}──▶ launcher ──▶ VM
 fake App ◀──Worker API ◀─proxy◀── Control (Worker image) ── clone / push ──▶ proxy ──▶ https://git.lane.example.com/acme/widgets.git   (a git endpoint, TLS)
                                    Setup container (python3, http_proxy) ─────▶ proxy ──▶ http://files.lane.example.com, http://mirror.lane.example.com
                                    real `narrow` over vsock (VM's token): the job's rule replaces the wide rule
                                    agent ─▶ network door ─▶ proxy ──▶ http://files.lane.example.com/agent          (after the narrowing)
                                    model door ─(CONNECT)─▶ proxy ──▶ https://models.lane.example.com/v1            (a fake provider, TLS, scripted)
```

**What is real:** KVM, Firecracker, the kernel, vm-init, dockerd, Sysbox, the Worker image and the agent image, the vsock, the TAP, the nft table
(rendered for the slots' network as the installer does, then loaded), the proxy wall of the launcher, the clone and the push of the git workspace, the
reader, the Setup container under its table, the real `narrow` with the VM's token, the network door and the model door under their tables **in the guest's
kernel**, and OpenCode in the agent's container. **What is a double:** the internet (below), the certificates (below), and the model (the scripted fake of
`fakes/wire`, the one the Docker lane uses). No real network or model call is made.

**The names, and why the wall is not weaker for them.** The fakes listen on the host's loopback behind **public-looking names** below
`lane.example.com` (`example.com` is reserved: nothing below it resolves). The proxy refuses private addresses by design and has no test network
(the door's `NETDOOR_TEST_PUBLIC_CIDR` seam is not used), so the lane gives `ProxyOuterWall` the two seams its unit tests use (`tests/kvm/lane_internet.py`):
a resolver (a lane name answers a public-looking address, `151.101.1.x`; any other name is an error: no real DNS) and a connector (a connection to such an
address and port is made to the fake's port on the loopback; any other address or port is refused). **The decision stays real:** the rule lists the name
before anything is looked up, every address must be public, only 80 and 443, the connection goes to the address that was checked. The Worker's app URL is
`http://app.lane.example.com` (port 80, a name), so the Worker's first call goes through the proxy under the wide rule, as on a customer's machine.

**A certificate the Worker image trusts, and how it stays out of releases.** The Worker clones over https only (`GIT_ALLOW_PROTOCOL=https`, closed
environment) and its model door verifies the provider's certificate, so the git endpoint and the provider need certificates the **image's** trust store
holds. The lane chose a **lane-only copy of the Worker image** over a public repository (a public repository would need the token, which the lane must not
have, and no provider has a public name the lane may call):

1. the workflow makes a CA for this run (`runner/tests/kvm/lane_pki.py ca`): EC P-256, three days, and a **critical name constraint** that lets it sign for
   DNS names `lane.example.com` and below and nothing else (the permitted subtree is that one domain; IPv4 `0.0.0.0/0` and IPv6 `::/0` are excluded, so it cannot sign an IP
   address either, and no email or URI name is permitted); its key stays on the runner (`$VM_WORK/lane-pki`, mode 0600, never an artifact, never committed, `*.key` and `*.crt`
   made here are not in the repository);
2. the workflow derives `code-reviewer-worker:golden` from the release's image in the runner's Docker (`docker buildx build --builder default`; `USER 0:0`, the CA appended
   to `/etc/ssl/certs/ca-certificates.crt`, the image's own `USER` back), under **the same tag**, and saves the images **a second time** (`images-lane.tar`) after the
   release's own `images.tar`;
3. the data disk recipe runs **a second time** on that archive (`data-lane-out/`: its own `dockerdata.ext4` and `images.json`, whose image id is the lane's);
4. the whole-job lane starts its VMs from that disk (`KVM_VM_BASE_DISK`, `KVM_VM_IMAGES`) and nothing else does. The release's `data-out/` (the disk the manifest
   describes, the signature, the published files) is the one made before the derivation and is never touched; `assemble.sh` reads it and the lane's directory never.

The test CA is therefore in **no release image, disk or manifest**, and the lane's disk is deleted with the runner. If the derivation failed to take (the CA not
in the bundle), the clone fails with a certificate error in the Worker's log and the lane fails; `tests/unit/test_whole_job_lane_support.py` holds the other
half on this machine (a client that does not hold the CA does not trust the endpoint, a certificate of the CA for a name outside its domain is refused).

**The job.** The contract's example job with the lane's repository (`https://git.lane.example.com/acme/widgets.git`, a bare repository served by
`git http-backend` behind TLS and the token's header), the provider `lane-provider` (a provider of the catalog: the key goes to the entry's address, here
`https://models.lane.example.com/v1`), and an environment: a setup script that fetches a file from a plain host and from a host the job's rule does not list, and
a `list` rule with the git host and the files host. The scripted model uses what the setup left, fetches a file through its network door and commits both. The
checks: the job is delivered `ok` with `pushed: true`; the branch on the lane's git endpoint is at the head commit and holds both files with the bytes the fake
hosts served; the setup's request came **before** the narrowing was acknowledged and the agent's **after** it; the narrowing carried the job's rule and the provider's
host; the proxy's record shows the app, the git host (clone and push), the provider and the files host allowed on 80 and 443 and the setup-only host allowed under the
wide rule, and no address and no other port; the provider saw the real key; the Worker's report says the VM's policy was narrowed. The tree's file names are the commit the
agent made, so the outer wall and the doors carried the whole path.

**Fail closed, for a whole job.** A second job runs with the git host left without a name: the proxy cannot clone for it, the Worker ends the job `clone_failed`
(a stable code) with nothing pushed, and the proxy's record shows no provider call. And the **negative side of every positive check** is the table's own counters:
the workflow reads the drop counters of `code_reviewer_wall` (`nft -j list table`, as root) before and after the job and `tests/kvm/wall_counters.py none` fails
the step when any drop rule counted a packet, except two rules that are IPv6 noise and never a client's traffic: "no IPv6" (the guest kernel may send a router
solicitation whatever a client does; a client has no IPv6 route whether or not it is dropped) and "the host opens no connection to a VM" (the *host's* own packets toward
the TAP: the first run showed ten of 88 bytes, the size of an IPv6 multicast listener report, at the interface's coming up; nothing a VM sends is counted in that chain). A client that dialled directly, fell back to the proxy and let the job pass would show in "everything else addressed to the host" or
"a VM forwards to nothing". **The control** is the outer wall lane's own run: the same program, `wall_counters.py some`, requires its probes' direct dials to
have moved a drop rule **other than those two** ("everything else addressed to the host", "a VM forwards to nothing", ...): the noise moves in every run, so a control
that counted it would pass for a table that never counts a direct dial, and "nothing moved" would be the answer of a table that counts nothing.

**The three in-VM rulesets** (the model door's, the network door's and the Setup bridge's with the proxy) are loaded for real by this job in the guest's kernel, and
checked as files before it: `runner/tests/kvm/render_rulesets.py` writes them from the launchers' own `egress_rules` and the `In-VM rulesets (nft -c)` step runs
`nft -c -f` on each, so a rule `nft` does not accept fails there and not on a customer's machine.

**What it still does not prove.** The service loop of the local dispatcher (its configured URL is both the host's and the VM's, and the lane's name has no
address on the host) is not run: the lane's side claims from the fake App over the runner API and starts the VM through the launcher, as the earlier lanes do
(the loop is covered by the loopback tests of `test_factory_runner_loopback.py`). IPv6 has no control (above). A real GitHub, a real provider and a bare-metal
machine are not exercised; the model's cost is the scripted usage.

### Not done here, follow-ups

* **The software in the VM goes through the proxy** (#994, above). A whole job with the table loaded in the lane is in the lane since #999 (above).
* The installer loads the table and makes the TAPs with their addresses (#982); the service cannot read nft state as a normal user, so it
  cannot check that the table is loaded (a machine without it has no outer wall: the install **fails** without it, and the unit's `ExecStartPre=+` fails the start of the service at every start without it). That is why
  `refuse` is the default: **the installer writes `FACTORY_RUNNER_OUTER_WALL=proxy` into the unit only after `nft list table inet code_reviewer_wall`
  succeeds**, and sets `LimitNOFILE` (8192 and 64 per slot) in the unit.
* IPv4 only (the table drops IPv6, the proxy resolves IPv4); a name with only an AAAA record is unreachable.
* Docker's nftables backend on the host next to this table is not proven (the spike did not either); the table is its own and runs at
  priority -150.

## Spike: Incus (LXD) backend (#1005)

The owner's own machine is a Hetzner Cloud VM **without `/dev/kvm`**, so the Firecracker launcher ([#978](#the-firecracker-launcher-978)) cannot run there, and the line is: one
local backend, the same behaviour everywhere. This spike asks whether **Incus** (the LXD fork, from Ubuntu's apt, no snap) can be that backend: the Docker of the VM content
([Spike: Firecracker sandbox](#spike-firecracker-sandbox-970)) inside unprivileged system containers, the inner wall, the outer wall, limits and clean-up, with numbers. **Everything
below was measured on the DevBox, as the user `luca`** (a member of `incus-admin`), by commands of [`spike/incus/`](https://github.com/Itegro-GmbH/code-reviewer/tree/spike-1005-incus/spike/incus) on the
branch `spike-1005-incus` (commit `327f9070eae604c1f01a597d46a5feddf86b765e`, both runs' scripts in one commit; **not product code, not merged**; the machine's own public addresses are placeholders there). Questions 1 to 6 of the issue are answered; **two answers are "does not work as
asked" (the disk quota, and the outer wall by Incus alone)** and several things need root at install, as the Firecracker backend's do. The recommendation is in the pull request.
**Re-measured afterwards on Incus 7.6 (Zabbly) with a btrfs pool, see [Re-measured on Incus 7.6 + btrfs](#re-measured-on-incus-76--btrfs): the AppArmor workaround, the `dir` pool's start time and missing disk quota, and the setup-to-agent hand-over below are superseded there; Q1 to Q6 stay as they were measured on 6.0.0 and the `dir` pool.**

**Where it was measured.** Ubuntu 24.04.3, kernel 6.8.0-147-generic, cgroup v2, 4 vCPU and 7.7 GB RAM **shared with other users and agents** (load average 1.4 to 3.3 during the timings, 12 for a while
during the memory test), **no `/dev/kvm`**, a rootful Docker of other users running on the host (so Docker's iptables rules and `FORWARD` policy are real). Incus **6.0.0-1ubuntu0.3** from the Ubuntu archive
(liblxc 5.0.3, firewall driver `nftables`), user `luca` not root, no sudo. In the instances: Docker **29.1.3** (the static bundle of the Firecracker spike, containerd image store, overlayfs, runc 1.3.4), compose
2.40.3, buildx 0.30.1, Ubuntu 24.04 images from `images.linuxcontainers.org`. Storage: a pool of the driver `dir` in `/home/luca` (the user's own volume, never `/`). One job-sized set of instances at a time,
each limited to 2 CPUs and 2 GiB. Everything it created was removed ("Clean-up of the spike" at the end).

### The answers

| # | Question | Answer | Numbers |
|---|---|---|---|
| 1 | dockerd with the containerd store and overlayfs in an unprivileged Incus container; `docker run`, `build`, `compose up` | **Yes, with one workaround:** Ubuntu's Incus 6.0.0 needs the container's AppArmor profile switched off (`raw.lxc: lxc.apparmor.profile=unconfined`), because runc's CVE-2025-52881 patch writes `net.ipv4.ip_unprivileged_port_start` through a reopened `/proc` descriptor that Incus's profile denies; upstream fixed the profile (lxc/incus PR 2624), the archive's 6.0.0 has not | dockerd answers 2.5 to 3.1 s after `incus start` (systemd unit); `docker run hello-world` 0.85 s, build of three layers 1.0 s, `compose up` 3.9 s (3 s of it the service's `sleep`) |
| 2 | Setup and agent with their own Docker; Sysbox inside Incus?; Postgres by the setup usable and stoppable by the agent | **Sysbox does not run in Incus.** Privileged DinD confined to the Incus container works. Same inner daemon: yes. Through `docker commit`: **no** | privileged `docker:29.1.3-dind` ready 1.30 s after `docker run`; Postgres answers 3.4 s after its `docker run` (pull 7.8 s through the proxy) |
| 3 | Inner wall: two instances per job, the agent reaches nothing but the doors | **Yes, but the wall is an nft table inside the Control instance**, not an Incus ACL (Incus ACLs do not filter inside a bridge on this host) | B reaches the two door ports; Control's secret endpoint, its Docker API on TCP, ICMP and routing through A are blocked, each with a control that reached before the wall |
| 4 | Outer wall: only the proxy of the host; coexistence with Docker's firewall | **Almost, with Incus alone:** an ACL plus port isolation plus address filtering leave the proxy as the only reachable service of the host **except port 53 of any host-local address** (Incus's implicit DNS accept). A static nft table of our own (as #979) is needed, and could **not** be loaded here without root | 15 targets from both instances, controls for each; coexistence with the host's Docker shown for the input path; forwarded traffic is dropped on this host whatever Incus does |
| 5 | Limits and clean-up | CPU, PIDs: enforced. Memory: enforced by throttling (`memory.high`), no quick OOM kill seen. **Disk quota: not enforced on a `dir` pool** (silently accepted). Clean-up and crash: clean, by a mark on the instance | 4.0 to 4.6 s to delete a running set; 169 of 400 forks with `pids.max` 200; a 4 GiB write went through a 3 GiB "quota" |
| 6 | Operations, start time, memory, speed | Unattended upgrades are on and cover the Incus package; the daemon restart does not stop containers (documented behaviour, not tried); `incus-admin` is root-equivalent. **Start time is the problem on the `dir` pool**: 19 s for each instance of a 1.3 GB image | whole set from nothing to nothing 72.7 s, instance creation 37.9 s of it; idle memory of an instance with Docker 42 to 65 MiB anonymous; CPU speed equals the host |

### Q1: Docker inside an unprivileged Incus container

The profile of every instance (`spike/incus/setup.sh`): `security.privileged=false`, `security.nesting=true`, `security.idmap.isolated=true`, `limits.cpu=2`, `limits.memory=2GiB`, `limits.processes=4096`, and the AppArmor line below.
The container's root is **host uid 1065536** (`uid_map  0 1065536 65536`, an own range of 65,536 ids taken from root's 1,000,000,000 in `/etc/subuid`; the next instance got 1131072), `Seccomp: 2` (Incus's default filter), no
`NoNewPrivs`, capabilities complete **inside** the user namespace. `docker info`: `Storage Driver: overlayfs`, `driver-type: io.containerd.snapshotter.v1`, `Cgroup Version: 2`, `Cgroup Driver: systemd`.

**What failed first, and the workaround.** With the default profile dockerd starts, pulls and builds, but every `docker run` ends with
`runc create failed: ... open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied`: also with `--sysctl`, `--privileged` and `--security-opt apparmor=unconfined` (only `--net=host`, which sets no sysctl, ran).
Setting the container's `linux.sysctl.net.ipv4.ip_unprivileged_port_start=0` did not help (Docker writes it anyway). With `raw.lxc: lxc.apparmor.profile=unconfined` on the profile everything works. The cause is known upstream: runc and containerd
reopen the sysctl through a detached procfs handle, which Incus's generated AppArmor profile reads as a `/sys` path and denies; the fix (the profile skips those denials for `security.nesting=true`, lxc/incus PR 2624) is not in the
archive's 6.0.0. **What the workaround costs:** the Incus container has **no AppArmor profile**; what confines it is the isolated user namespace, the cgroup, Incus's seccomp filter and the capability set of a user namespace.
A newer Incus (the upstream packages, the owner's choice of source) would keep AppArmor; **the runner must test for the symptom at install** (`docker run` in a probe container) instead of trusting a version number.

The battery (`spike/incus/q1-docker-in-incus.sh`, in the container): `docker run hello-world` prints "Hello from Docker!" in 0.85 s; `docker run busybox` (uid 0, `uid_map 0 1065536 65536`, so the same range) 0.78 s; `docker build` of three layers (a 50 MB file) 0.99 s,
`docker run` of the result prints its content; `docker compose up --abort-on-container-exit` of one service 3.92 s; `docker pull` through the proxy: hello-world 2.8 s, busybox 2.4 s, `docker:29.1.3-dind` 9.2 s (508 MB), `postgres:17-alpine` 7.8 s.

### Q2: the agent's own Docker

**Sysbox (0.7.1, the pinned package, sha256 `9d6d5484…261c5`)** installs in the container (its post-install script fails on `systemctl restart docker`, as without systemd) but **cannot run**: `sysbox-mgr` ends with
`ID-mapping check failed: failed to check kernel ID-mapping support: create mapped mount: Failed to set mount attr: operation not permitted` (it needs a mount privilege of the initial namespace) and `sysbox-fs` with
`Unable to determine the host UUID value`. Sysbox is therefore out in an Incus container; it needs the host.

**Privileged DinD, confined to the Incus container** works: `docker run -d --privileged --entrypoint dockerd docker:29.1.3-dind --host=unix:///var/run/docker.sock` inside the instance, with the proxy variables in its environment. The inner dockerd is ready **1.30 s** after the
`docker run`, `docker info` shows overlayfs and cgroup v2, and a `postgres:17-alpine` run inside it answers `select 6*7` (42) 3.4 s after its `docker run` (7.8 s to pull it). **What "privileged" reaches:** the instance's own root only. Inside the privileged container the
agent has all capabilities of the *instance's* user namespace, `/dev` holds only `core fd full fuse mqueue net null ptmx pts random shm stderr stdin stdout tty urandom zero` (no block device), `mount /dev/sda1` answers `permission denied`, and its root is host uid 1131072 (an
unprivileged id of the host). The Firecracker spike's "rootful DinD, `--privileged`: the agent mounted the host's root disk" does **not** repeat, because the instance, not the host, is the privileged container's host.

**What the setup starts is still there for the agent, with a condition.** With the setup and the agent in **the same inner daemon** (the agent's `docker exec` into the container the setup started its Postgres in): the agent sees the running `pg`,
creates and reads a table through it (`7`), **stops it** (`pg  Exited (0)`), starts it again and reads the row (`7`). With the **`docker commit` hand-over of today** (setup container, `docker commit`, agent container from the committed image) it does **not** work as
it stands: a DinD container whose Docker data lives in the container's own file system cannot start an overlayfs inside it (`failed to mount ... overlay ... err: invalid argument`, overlay on overlay), and one whose data is in the image's `VOLUME` is not captured by `commit`.
This is Docker's behaviour, not Incus's, and the Sysbox variant avoids it by other means (not re-measured). **Incus offers another hand-over: the whole instance** (stop B after the setup, copy it, start the copy: the images, the volume of Postgres and the
files are on B's disk, the processes are gone); **not tried**, and on the `dir` pool a copy costs as much as an `incus init` (19 s). The contract item "the agent starts from a fresh container" and "what the setup started" must be decided with that in view (see the pull request).

### Q3: the inner wall, two instances per job

```
 A  (Control stand-in, model door, network door; own dockerd)         B  (setup, then agent; own dockerd, the agent a privileged DinD container)
   eth0 ── spkout ── host proxy 10.99.0.1:3128 (only)                   eth0 ── spkin ──┐
   eth1 ── spkin  ◀────────────────── doors 10.98.0.2:8080, :8081 ──────┘                  (eth1 on spkout only during the setup)
```

`spkin` has **no address on the host** (`ipv4.address=none ipv6.address=none`), so the host is not on it. A holds the fake secrets (`git-token`, `model-key`, served on `0.0.0.0:9000` as the worst case) and its own **Docker API on `tcp://0.0.0.0:2375` without TLS**
(the worst case: whoever reaches it owns A's Docker, which is where Control's socket would be; a real dockerd in the hand-run test, a listener standing in for it in `jobset.sh`). The doors are the proxy of the spike chained to the host proxy (`:8080`) and a plain server (`:8081`).

| Probe from B (and, last two rows, from inside the agent's privileged DinD container, through B's NAT) | Control: no wall | Wall |
|---|---|---|
| A `:9000` (secrets) | REACHED (`curl` returned `FAKE-GIT-TOKEN…` and `FAKE-MODEL-KEY…`) | **BLOCKED** |
| A `:2375` (Docker API) | REACHED (`DOCKER_HOST=tcp://10.98.0.2:2375 docker info`: "controls A dockerd") | **BLOCKED** |
| A `:8080` network door, `:8081` model door | REACHED | **REACHED** (the doors work: `model-door-ok`) |
| A `:22` | REFUSED (reachable host, closed port) | BLOCKED |
| ICMP to A | answered | lost (100 % loss) |
| the host proxy `10.99.0.1:3128` and A's outer address `:22`, `:9000`, `1.1.1.1:443` through A as a router (`ip route add default via 10.98.0.2`; A has `ip_forward=1` because Docker set it) | not tried | BLOCKED, `Network is unreachable` or timeout |
| inside the agent container: `10.98.0.2:8080`, `:8081` | | REACHED |
| inside the agent container: `:9000`, `:2375`, `10.99.0.1:3128` | | BLOCKED |

**What the wall is.** `spike/incus/inner-wall.nft`, loaded **inside A** (`nft -f`, A's own network namespace, priority -10, table `inet spk_inner`): from `eth1` accept established, accept `ip saddr 10.98.0.3 tcp dport { 8080, 8081 }`, drop everything else; forward from and to `eth1` is dropped.
B cannot change it (a different container, a different network namespace); A's root can, and A is the trusted side, as Control's VM is today. **Incus's own ACLs do not do this here:** an ACL on `spkin` (egress and ingress, default drop, `spk-inner`) left every probe REACHED, because the ACL of a bridge network is applied by
nftables' `inet`/`bridge` hooks and traffic between two ports of one bridge needs `br_netfilter`, which this host has not loaded (`/proc/modules`; no root to load it). On a host with the module the ACL might work, which is not the same
thing as holding it. L2 separation inside a bridge without netfilter: **`security.port_isolation=true`** on a NIC (the kernel's bridge port isolation: an isolated port reaches only non-isolated ports, the host's bridge address included).

**A second path found by the test, closed:** during the setup, B's second NIC is on the **outer** bridge `spkout`, the bridge of A's `eth0`, where A's inner wall (`iifname eth1`) does not apply: B reached A's secrets and Docker API on A's outer address (`10.99.0.240:9000`, `:2375`, `curl` returned the token).
With `security.port_isolation=true` on both outer NICs it is `BLOCKED`; with the setting off again on B (the control) it is `REACHED`, on again `BLOCKED`, and the host proxy stays reachable from both (the proxy is the bridge's own address, not a port). **Every instance of a job needs
port isolation on its outer NIC**; A's own firewall should also drop everything that comes in on `eth0`.

### Q4: the outer wall

`spkout`: `ipv4.address=10.99.0.1/24 ipv4.nat=false ipv4.routing=false ipv4.dhcp=false ipv6.address=none dns.mode=none raw.dnsmasq=port=0`, `security.acls=spk-outer`, default egress and ingress action `drop`. The ACL (`spike/incus/acl-outer.yaml`): egress
`allow tcp 10.99.0.1/32 port 3128`. The instances' NICs on it: **static addresses** (`ipv4.address=`), `security.ipv4_filtering=true`, `security.mac_filtering=true`, `security.port_isolation=true`. The proxy (`spike/incus/proxy.py`, a stand-in for #979's, run as `luca` and listening on `10.99.0.1` only,
never a wildcard) refuses addresses, ports other than 80 and 443 and names with a non-public address. A decoy (`decoy.py`) listens on `[::]:9999` of the host (dual stack), so that a probe has something to reach on every host address.

| Target (probed from A, and again from B's setup NIC: identical) | Control: no ACL | ACL, isolation, filtering |
|---|---|---|
| the proxy `10.99.0.1:3128` | REACHED | **REACHED** (and `curl -x` through it fetched `https://example.com/`: 200) |
| host `10.99.0.1:22` (sshd), `:9999` (decoy) | REACHED, the decoy logged the instance's address | BLOCKED |
| host public address `<the host's public IPv4>:22`, `:9999` | REACHED | BLOCKED |
| host Docker bridge `172.17.0.1:9999` | REACHED | BLOCKED |
| host `10.99.0.1:53` (Incus's dnsmasq) | REACHED | **REFUSED** (reachable: no listener since `port=0`, the RST came back) |
| the owner's `incusbr0` address `10.206.108.1:53` (its dnsmasq) | REACHED | **REACHED** |
| LAN gateway `172.31.1.1:80`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, metadata `169.254.169.254:80`, `1.1.1.1:443` | REFUSED (Incus's `routing=false` rejects) | BLOCKED (timeout) |
| IPv6 `[<the host's public IPv6>]:9999` | no route | no route |
| another slot's source address (`10.99.0.202` while declared `10.99.0.201`) | REACHED (filtering off) | **BLOCKED** (filtering on, `security.ipv4_filtering`) |

**Read the table with its limits.** (1) The targets are real: the host itself reached `169.254.169.254:80` and `1.1.1.1:443` and (as expected) not `172.31.1.1:80`. (2) **Forwarded targets have no usable control through Incus.** With `ipv4.routing=false` Incus rejects forwarded
packets itself, and a **second network with NAT and routing** (`spkctl`, removed again) gave `BLOCKED` for `1.1.1.1:443`, `169.254.169.254:80` and `172.31.1.1` **while the host's own address on that bridge was reached** (`10.97.0.1:9999`): on this host the forward path drops
Incus's traffic, which is what Docker's `FORWARD` policy `DROP` does (the tables could not be read as a normal user, so this is the observed behaviour, not a read of the rules). **A design that needs no forwarding at all is immune; the outer wall of #979 does not forward.** (3) **IPv6 has no control**: the bridge has no IPv6 address
and the instances no IPv6 route, with or without the ACL; the same as the Firecracker lane's ("IPv6 has no control"). (4) **Port 53 is open to every host-local address.** An explicit ACL rule `drop tcp/udp 53` ahead of the allow rule changed nothing; `ipv4.firewall=false`, `ipv6.firewall=false` changed nothing; so the accept
is Incus's own implicit one for DNS/DHCP of an ACL-protected bridge, ahead of the user rules. It matters only because the host has listeners on port 53 on addresses the instance can reach (`10.206.108.1`, and any dnsmasq or resolver on a routable address of the host); it
would let an instance resolve names, and tunnel through the resolver. **`dns.mode=none` does not stop the bridge's own dnsmasq from answering** (`raw.dnsmasq=port=0` does).

**Coexistence with Docker and Incus's own firewall.** Incus uses nftables (`inet incus`), the host's Docker iptables-nft; both were loaded the whole time and neither disturbed the other for the **input** path (the proxy was reachable, the decoy ports were not; Docker's bridges, `172.17.0.1`, were probed). A design that lets the instances
reach only an address of the host needs no forwarding, so Docker's `FORWARD` policy never comes into it, and **no Docker setting was touched**. What the spike could **not** do is load a static nft table of our own (as the installer of #979 does): `luca` has no root and Incus rejects the way round it
(`raw.lxc: lxc.net.0.type=none` is refused, and sharing the host's network namespace by other means would be using the group's root equivalence against the guard, so it was not done). That table is what closes port 53, and it is **not proven here**; the mechanism (a table of our own at priority -150 that names
the bridge, `iifname "spkout"`) is the Firecracker backend's, proven on its TAP devices.

**Hot-plug as `narrow`.** The setup phase gives B a second NIC on `spkout` (`incus config device add B eth1 nic network=spkout …`, 0.09 s) and `narrow` removes it (`device remove`, **0.12 to 0.17 s**); afterwards B has only `eth0` and the host proxy answers `Network is unreachable`. A NIC change re-creates the interface:
**the addresses and routes set by hand are gone** (twice the probe said `Network is unreachable` until they were set again), so the launcher must configure the NIC from a file in the image, not by `ip addr` at start.

### Q5: limits and clean-up

| Limit | Setting | Result |
|---|---|---|
| CPUs | `limits.cpu=2` (a cpuset of 2 of the 4 host CPUs) | `nproc` 2, cpuset `2-3`; two busy loops for 6 s used **1.91 CPUs**. `limits.cpu.allowance=50%` on top left `cpu.max` at `max 100000`: **a fractional quota needs `limits.cpu` unset** (not tried) |
| Memory | `limits.memory=1GiB`, `limits.memory.swap=false` | `memory.max` 1073741824, **`memory.high` 966365184 (90 %)**, `memory.swap.max` 0. A process asking for 1.6 GiB was held at **926 MB** resident in state `D` (throttled by `memory.high`), `oom_kill 0` for the minutes it ran before the limit was raised; host load rose to 12 (shared host). **Exhaustion throttles, it does not kill quickly**: the job ends at its wall clock, not by an OOM kill (Firecracker's cgroup killed the VMM). Not tried: `limits.memory.enforce` |
| PIDs | `limits.processes=200` (`pids.max`) | a loop of 400 forks: **169 started, 231 `EAGAIN`** |
| Disk | `incus config device set <B> root size=3GiB` on the `dir` pool | **accepted without an error and not enforced:** `dd` of 4,000 MB went through (`df` inside shows the host volume, 67 G, 44 G used afterwards); the file was removed. Incus's `dir` driver enforces a quota only on a file system with project quotas, which `/home/luca` (ext4 on LVM) is not mounted with. **A btrfs, ZFS or LVM pool would; none could be created without root** (a loop file is made by root; `source=<file>` is refused for btrfs) |

**Clean-up.** `incus delete -f A B` of a **running** set (dockerd, containerd, a dind with Postgres, 80 processes) took **4.0 s** (4.57 s in the other run); afterwards `incus list`, the pool's `containers/` directory (4 KiB) and the volume list were empty, no device, no network left over. Everything a job
owns is one instance each plus a hot-plugged NIC and a `proxy` device, all deleted with the instance; the two bridges, the ACL and the profile are per machine, not per job.
**After a dispatcher crash** (the host proxy and the control endpoint killed, as a crash would) both instances **kept running** (`incus list`: RUNNING) and the proxy answered nothing; they are found by a **mark on the instance**, `user.cr.job` set at `incus init`
(`spike/incus/reap.sh`: `incus list --format json`, every instance with that key, `incus delete -f`; instances without the key, the owner's and other users', are never touched), and the next start of the service does what #978's `setup` does for VMs. `boot.autostart` is unset (false): no instance comes
back after a reboot of the host. The wall clock of a job is the dispatcher's, as with VMs. **Not tried:** a restart of the Incus daemon (root), a reboot, a kill of one instance's dockerd.

### Q6: operations, start time, memory, speed

**Updates.** There is no snap, so no refresh. The host runs **unattended-upgrades** (`APT::Periodic::Unattended-Upgrade "1"`, origins `noble` and `noble-security`; the package `incus 6.0.0-1ubuntu0.3` comes from `noble-updates`/`noble-security`). The package's maintainer script
restarts `incus.service` and `incus-user.service` on upgrade, not `incus-startup.service`, and the unit has `KillMode=process`: **a daemon restart is documented not to stop running containers** (not tried here: it needs root). The runner's installer should still **hold the package** (`apt-mark hold incus`) and
update it between jobs, as the Firecracker design updates only between jobs. Packages that Docker's runc depends on (here the bundle: runc 1.3.4) are the image's, not the host's.
**`incus-admin` is root-equivalent:** a member can create a privileged instance with the host's disks (the documented behaviour; **not shown on this shared server**). The service user of the Incus backend would hold that group, which the Firecracker backend's user (`kvm` only, TAPs it owns) does not. The
restricted alternative, the per-user `incus-user` socket with a restricted project, cannot set `raw.lxc` (the AppArmor workaround), privileged flags or networks (from the documentation, **not tried**).
**The image store defaults to `/`** (`/var/lib/incus/images`): the first image of 940 MB moved `/` from 69 % to 72 % until `storage.images_volume=spike/images` pointed it at the pool (a **server-wide** Incus setting; set back at the end). The installer must set it, and the pool, before the first image.

**Start time, whole set (`spike/incus/jobset.sh`, the quiet run, load ≈ 1.4):**

| Step | Time (cumulative) |
|---|---|
| two instances created (`incus init` ×2 from the golden image, 802 MiB compressed, 1.3 GB on disk with Docker, dind and Postgres images pre-pulled; devices added) | **37.9 s** (19.5 s and 19.6 s for one, with `security.idmap.isolated` true and false: the idmap is not the cost; 20.7 s for another; 43.5 s for the pair in the first full run at load 3) |
| started, addresses set, A's wall and doors loaded, A's dockerd answers | 42.7 s (`incus start` itself 0.27 to 0.38 s; dockerd answers **2.5 to 3.1 s** after the start in the three timed starts) |
| B's dockerd answers | 43.4 s |
| setup: B's outer NIC, privileged dind started, `postgres:17-alpine` pulled through the proxy, Postgres answers | 56.6 s (13.2 s; 15 s and 21 s in the loaded runs) |
| `narrow` (NIC removed) | 0.15 s |
| agent phase (probes, a query through the setup's Postgres, `docker stop pg`) | 68.7 s |
| both instances deleted | 72.7 s |

**The cost is `incus init`: the image is copied into the pool file by file** (the `dir` driver; an Ubuntu image of 135 MiB takes 3.5 s, the same with Docker's data 19 s), against the Firecracker backend's reflink of the Docker data disk, **34 ms for 752 MiB**. A copy-on-write pool (btrfs, ZFS, LVM thin) makes it a snapshot and also
brings the quota; **neither was possible without root and none was measured here**. The installer (root) must create such a pool, on a block device or a loop file of its own (on the user's volume: `incus storage create <pool> btrfs size=… source=<loop file or device>`; **not tried**). A real Worker image of 1.5 GB or more in A's Docker would
add to the copy on a `dir` pool.

**Memory.** Instance with systemd, containerd and dockerd idle, after boot: anonymous **42 MiB (B) to 65 MiB (A)**, kernel 5 to 9 MiB, plus the `lxc monitor` process **6.2 to 6.7 MiB** resident, plus page cache (`memory.current` 123 and 229 MiB). After the whole job set (dind and Postgres run and stopped): A anonymous 74 MiB, B 150 MiB, kernel 11 and 34 MiB, **file cache 286 and 881 MiB**
(it counts against `limits.memory` and is reclaimable). The Firecracker VM: 123 MiB resident with nothing in it, 344 MiB with dockerd and a runc container, 573 MiB with the dind agent (the fixed cost of the VMM 50 to 56 MiB). An Incus container has **no guest kernel, no VMM**.

**Speed.** `spike/incus/bench.sh` on the host and in an instance (3 runs): SHA-256 of 1 GiB from `/dev/zero` **1.02 to 1.17 s in the instance, 1.10 to 1.18 s on the host** (no difference); a 1 GiB write with `fdatasync` 5.9, 10.9 and 5.9 s in the instance against 4.2 to 4.7 s on the host (the `dir` pool on the shared volume, noisy); `docker build` of three layers
(150 MB urandom plus gzip, md5, tar) 6.6 s the first time and 1.3 and 0.9 s after in the instance. **The host's own Docker (`luca`'s, rootless) took 39 to 42 s for the same build and is no reference.** The Firecracker section has **no build or test speed figures** (it measured boot, copy and memory), so there is nothing of it to put beside these; boot to a working Docker:

| | Firecracker (CI, nested virtualization) | Incus (`dir` pool) |
|---|---|---|
| per-job disk | reflink 34 ms (752 MiB), `resize2fs` 20 ms | `incus init` 19 s (1.3 GB), 3.5 s (a plain Ubuntu image) |
| start to Docker answering | 1.90 s (`docker_ready`), 2.61 s "Control could start" | 2.5 to 3.1 s after `incus start` (0.3 s) |
| the agent's own Docker ready | 1.51 s (Sysbox) | 1.30 s (privileged DinD) |
| fixed memory | 50 to 56 MiB VMM, 123 MiB of an empty guest | 6 MiB monitor + 42 to 65 MiB with systemd and dockerd |
| the control channel's round trip | vsock 0.63 ms (p50) | `proxy` device, a unix socket host to instance: **0.28 ms (p50), 0.41 ms (p95)**, 200 requests; the socket must be on the user's volume (`incusd` does not see `/tmp`) |
| stop and clean up | the VMM killed with its cgroup | 4.0 to 4.6 s |
| a limit by file size (disk) | yes | **no on `dir`** |

### Re-measured on Incus 7.6 + btrfs

The spike's three open gates (a copy-on-write pool, Docker in Incus on the package we would install, the setup-to-agent hand-over) were re-run after the owner changed the DevBox as root: **Incus 7.6 from the Zabbly stable repository** (`1:7.6-ubuntu24.04-202611072126`, liblxc 7.0.0 and lxcfs in `/opt/incus`, firewall driver `nftables`; the Ubuntu 6.0.0 is gone) and **a btrfs pool `crpool`** (a 25 GB loop file on `luca`'s own volume, mounted by Incus at `/var/lib/incus-crpool`). Same user (`luca`, `incus-admin`), same kernel (6.8.0-147), same rules (one set at a time, 2 CPUs and 2 GiB per instance, `crpool` only, nothing of the owner's touched). The scripts are the spike's, changed where this run needed it (`spike/incus/`, `SPIKE_POOL=crpool setup.sh`, and the new `same-instance.sh`; the branch is `spike-1005-incus`).
**Read every time with the host's load:** the DevBox was busy with other agents, **load average 5 to 20 on 4 vCPUs** (the first spike's quiet runs: about 1.4), so the absolute times of anything that computes are 2 to 5 times worse than a quiet host would give; the times that do not compute (the instance's creation, the NIC hot-plug) are not. Where it matters the load is given.

| # | Question | Answer on Incus 7.6 + btrfs |
|---|---|---|
| 1 | Docker in Incus **without** `raw.lxc: lxc.apparmor.profile=unconfined` | **Yes. The workaround is gone.** The default AppArmor profile stays on (`/proc/<pid 1>/attr/current` of the instance, read from the host: `incus-<name>_</var/lib/incus>//&:…:unconfined (enforce)`, the profile enforcing, the instance's own namespace inside it), containerd store and overlayfs as before, and `docker run`, `build`, `compose up`, `--privileged`, a privileged DinD with a pull, a build and a run inside it all work. The `open sysctl net.ipv4.ip_unprivileged_port_start … reopen fd: permission denied` of 6.0.0 does not appear |
| 2 | Start time on btrfs | **`incus init` 0.14 to 0.46 s** (the first one per image and pool **20.8 s**, once), `incus start` 0.23 to 0.33 s, dockerd answers **1.95 to 2.18 s** later at load 5 (3.8 to 5.0 s at load 10). Nothing to first container run **4.4 to 4.7 s** at load 5. Against the `dir` pool's 19 s + 0.3 + 2.5 to 3.1 s and Firecracker's 34 ms + 1.90 s `docker_ready` / **2.61 s** "Control could start" |
| 3 | `size` of the root disk | **Enforced on btrfs**: a write past it ends `Disk quota exceeded` (EDQUOT, **not** "No space left"), also from a container of the nested Docker, and with the quota lifted the same write passes. A full quota also stops Docker's own bookkeeping (see below) |
| 4 | Sysbox in Incus 7.6 (one attempt: `dpkg -i` of the pinned 0.7.1 package in an instance, `sysbox-mgr` read) | **Still fails, with the same message**: `sysbox-mgr` exits with `ID-mapping check failed: failed to check kernel ID-mapping support: create mapped mount: Failed to set mount attr: operation not permitted`. Sysbox stays out |
| 5 | Inner and outer wall, once more | **No regression**, each probe with a control that reached (tables below). Port 53 of host-local addresses is **still open** (`10.206.108.1:53` REACHED with the ACL): the static nft table is still needed. One new thing about the controls (a live change of `security.*` does not reach a running NIC) |
| 6 | Setup and agent in the **same instance** | **Works, and the contract problem of the `docker commit` hand-over disappears**: Postgres, a service and a file made by the setup are still there for the agent, which uses and stops them; the inner wall still separates that instance from Control's (tables below) |

#### Docker in the instance, AppArmor on (question 1)

The profile is the spike's without the `raw.lxc` line (`spike/incus/setup.sh`: `SPIKE_APPARMOR_OFF` adds it back). `docker info`: `overlayfs`, `io.containerd.snapshotter.v1`, cgroup v2 with the `systemd` driver, Docker 29.1.3; root of the instance `uid_map 0 1065536 65536`, `Seccomp: 2`. The battery of `q1-docker-in-incus.sh` (images pre-pulled, load 12 to 15): `docker run hello-world` 2.1 s and 2.7 s, `run busybox` 2.4 to 2.6 s, `build` of three layers (a 50 MB file) 9.2 to 9.3 s, `compose up` 6.0 to 6.3 s (3 s of it the service's `sleep`). **These are 2.5 to 9 times the first spike's (0.85, 0.78, 0.99, 3.92 s at load 1.4) and the cause was not isolated**: AppArmor is not it (the same instance with `raw.lxc` unconfined: `docker run busybox true` 1.8 to 2.1 s against 2.0 to 2.7 s with the profile on), nor is Docker's cgroup driver (`cgroupfs`: 1.8 to 2.4 s), nor the options of `docker run` (`--network none`, `--privileged`, seccomp off, host namespaces: 1.6 to 2.0 s each); `docker create` and `rm` take 0.2 s, `start` 0.65 s and `wait` 0.41 s (and each `incus exec` adds its own 0.2 to 0.4 s at this load). A quiet-host re-measure is a follow-up.
**The bench's three-layer build is not comparable to the first spike's** (6.6, 1.3 and 0.9 s) **and those figures should be treated as doubtful**: it now takes 48 to 61 s in the instance, of which 36 s is Docker exporting the image (gzip of about 700 MB; `gzip` of 300 MB of random data costs 10.8 s in the instance and 14.2 s on the host at that load, so it is CPU, not the storage), and the bench discards the build's output, so a failed build looks like a fast one.

**Privileged DinD** (the agent): ready 8.4 s after `docker run` at load 15 (5.6 to 5.9 s at a load of about 6; 1.30 s at load 1.4 in the first spike), `postgres:17-alpine` pulled through the proxy and run inside it (`select 6*7` = 42), `docker run hello-world` and a `docker build` inside it work. What "privileged" reaches is unchanged: `/dev` holds no block device (`mount /dev/sda1` answers `No such file or directory`; 6.0.0 said `permission denied`), `uid_map 0 1065536 65536`, all capabilities of the instance's user namespace only, and the AppArmor namespace of the instance around it.
**A mistake of this run, worth knowing:** the first golden image lost its pre-pulled images (`docker run` pulled them again) because the spike's own `containerd.service` and Docker's managed containerd raced at the image build; the instance's `dockerd` used the other one at the next boot. The unit is gone from `build-image.sh` (dockerd manages its containerd); an image recipe must test for the pre-pulled images, not assume them.
**The package's source matters for updates:** the host's `unattended-upgrades` allows only the Ubuntu origins (`noble`, `noble-security`, ESM), **so the Zabbly package is not updated automatically** (the Ubuntu 6.0.0 was). The installer or the updater owns the Incus version (a pin, an update between jobs).

#### Start time (question 2)

Per instance, one set of timed starts of the 1.3 GB golden image (800 MiB compressed; Docker, dind and Postgres images pre-pulled), `time-start.sh` and the same by hand:

| | `incus init` | `incus start` | dockerd answers (after start) | first `docker run busybox true` (+) | nothing to first container |
|---|---|---|---|---|---|
| **cold**, the first instance of an image in the pool (unpacks the image into a btrfs image volume) | **20.8 s** | 0.68 s | 4.3 s | | 25.8 s |
| warm, load 9 to 12, five instances | 0.18 to 0.46 s | 0.31 to 0.33 s | 3.8 to 5.0 s | | 4.3 to 5.5 s |
| warm, load 5, five instances | 0.14 to 0.17 s (0.84 s the first) | 0.23 to 0.31 s (0.51 the first) | 1.95 to 2.18 s (4.7 the first) | 1.90 to 2.23 s | **4.35 to 4.68 s** (8.25 s the first) |

Both **cold** (20.8 s and about 22 s) times are the image volume's unpacking: **once per image and pool, at the first instance**, and the volume stays after the instance is gone; the installer must create and delete one instance after importing an image so that no job pays it. Against the first spike's `dir` pool (19 s **per instance** + 0.3 s + 2.5 to 3.1 s) and the Firecracker backend's 34 ms reflink + `docker_ready` 1.90 s (process start, kernel boot included) and "Control could start" 2.61 s: **a job's own disk is now cheap (0.2 s, a snapshot)**, and what remains is the 2 s that dockerd needs to answer plus 2 s for the first container, **about 4.5 s against 2.6 s** at a load of 5. Whole job set with `jobset.sh` as it is (load 12): **70.4 s** (72.7 s before), of which the two instances' creation **0.95 s** (37.9 s before); the rest is the setup's pull of Postgres through the proxy and the probes. `incus delete -f` of a running pair 0.3 to 3.6 s; **btrfs gives the space back after a delay** (the pool showed 2.65 GiB used for about 30 s after everything was deleted, 8.6 MiB after 50 s).
**Two traps found on the way.** (1) `incus init` and `incus launch` **read an instance config from stdin when it is not a terminal and wait for its end**: a pipe that never closes hangs them forever (twice here, for 9 and 4 minutes, with no operation and no instance on the server; the client was waiting). A dispatcher must start them with stdin closed (`</dev/null`; `lib.sh` does), or use the API. (2) A `proxy` device that listens on `/run/…` makes a socket that systemd's `/run` tmpfs hides in 7.6 (the 6.0.0 run worked): put the control socket elsewhere (`/ctl.sock`; p50 **0.28 to 0.36 ms**, p95 0.53 to 0.59 ms, 200 requests, unchanged).

#### The disk quota on btrfs (question 3)

`incus config device override <i> root size=3GiB` (and `device set … size=` on a running instance, effective at once; no restart). A 3.5 GB `dd` in the instance stopped at **587 MiB** (616 MB) with `dd: error writing '/blob': Disk quota exceeded`: the instance had already used the rest of its 3 GiB (the image's 1.3 GB, the images pulled into Docker, the dind's). The same in a container of the privileged DinD, **and** in a container of the instance's own Docker: `Disk quota exceeded`, each. **Control:** with the quota lifted to 20 GiB the same 3.5 GB write went through (3.4 GiB, 340 MB/s). The quota counts the instance's whole file system, **including the data it shares with the image** (referenced size), so a quota must be at least the image plus the job's room.
**What a full quota does to Docker:** with the instance at its quota `docker rm` and `docker system prune` fail themselves (`write …/meta.db: disk quota exceeded`, `failed to prune build cache`), the daemon stays up (`docker info` answers) and the dead containers stay until the quota is raised. For a job that is fine (the instance ends at the wall clock or by `end` and is deleted), but a Control that wants to clean up inside an instance at its quota cannot; **Control's reserve is its own instance's quota** (A and B have separate quotas), not a slice of B's. The error is `EDQUOT`; the contract's "No space left" must say "a write fails" and name both. Not measured: the speed of btrfs with quotas (qgroups) under many small files, the loop file's own limit (25 GB here, a pool of several instances at once), a recovery of Docker after the quota was raised again.

#### The walls, once more (question 5, `same-instance.sh`, each probe with a control)

Inner wall, probes from B (a REACHED in the control column proves the probe can reach):

| Probe from B | No wall (A's table not loaded) | Wall (`inner-wall.nft` in A) | After `narrow`, from the **agent container** and from **a container of the agent's own Docker** (NAT through two layers) |
|---|---|---|---|
| A `:9000` (secrets), `:2375` (Docker API stand-in) | REACHED, REACHED | **BLOCKED**, **BLOCKED** | BLOCKED, BLOCKED (both) |
| A `:8080`, `:8081` (the two doors) | REACHED | **REACHED** | REACHED (both); `curl -x 10.98.0.2:8080 https://example.com/` through the network door to the host proxy: HTTP 200, the model door: `model-door-ok` |
| A `:22`, ICMP to A | REFUSED, answered | BLOCKED, 100 % lost | |
| through A as a router (`1.1.1.1:443`, the host proxy, A's outer address `:9000`) | | BLOCKED, BLOCKED, BLOCKED | |
| the host proxy `10.99.0.1:3128` after `narrow` | | `Network is unreachable` | BLOCKED (both) |

Outer wall, the same 15 targets from A and from B's setup NIC (**identical rows for both**); control = the ACL unset on `spkout` and B's NIC **re-plugged** without isolation, address filtering and MAC filtering:

| Target | Control, no wall | Wall (ACL, port isolation, address and MAC filtering) |
|---|---|---|
| the proxy `10.99.0.1:3128` | REACHED | **REACHED** |
| host `10.99.0.1:22`, `:9999` (decoy) | REACHED, REACHED (the decoy logged the instance's address) | **BLOCKED**, BLOCKED |
| the host's public IPv4 `:22`, `:9999` | REACHED, REACHED | **BLOCKED**, BLOCKED |
| `10.99.0.1:53` (no listener, `port=0`) | REFUSED | REFUSED |
| the owner's `incusbr0` address `10.206.108.1:53` (its dnsmasq) | REACHED | **REACHED**: port 53 of a host-local address is still open on 7.6 |
| `172.17.0.1:9999`, LAN gateway `172.31.1.1:80`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, metadata `169.254.169.254:80`, `1.1.1.1:443` | REFUSED | **REFUSED** (immediately, where 6.0.0 timed out): the wall's answer and the control's are the same, so these rows prove nothing about the ACL: **no usable control for forwarded targets**, as before |
| IPv6 `[<the host's public IPv6>]:9999` | no route | no route (no control possible) |
| B to A's outer address `:9000`, `:2375` | REACHED, REACHED | **BLOCKED** (timeout; `No route to host` for the second, port isolation) |
| another slot's source address `10.99.0.202` while declared `10.99.0.112` | REACHED | **BLOCKED** (timeout) |

**What changed in the host:** `docker0` and the two other Docker bridges are `linkdown` now (no container of the other users runs), so `172.17.0.1` is no longer a host-local address that answers and the Docker-bridge row has lost its control; the **coexistence with the host's Docker was not shown again** (no container runs there now and the rules cannot be read as a normal user); no Docker setting was touched.
**A control must re-plug the NIC:** `incus config device set <i> eth1 security.port_isolation=false security.ipv4_filtering=false …` on a **running** NIC did **not** take effect on 7.6 (B still could not reach A, the foreign source address stayed blocked; the 6.0.0 run's live toggle did take effect). The wall is applied when the NIC is made, so `narrow` as a hot-**unplug** (0.20 to 0.35 s, unchanged) is fine, and a changed rule is a re-plug. A static address on a bridge without DHCP is refused by Incus unless `security.ipv4_filtering=true`.

#### Setup and agent in the same instance (question 6)

One instance B for both, as the owner decided; A (Control, the doors, the inner wall, the host's proxy through the outer NIC) as before. `same-instance.sh` in order: B gets its outer NIC (wide rule); **the setup** runs in B with **B's own Docker**: `postgres:17-alpine` (`--restart unless-stopped`, ready when it answers on **TCP**: the image's first, temporary server answers `pg_isready` on its socket and is then shut down, which made the first run's `psql` end with `terminating connection due to administrator command`), a table with one row, a service (`systemd-run python3 -m http.server`, a unit of the instance), a file; **`narrow`** (B's outer NIC is hot-unplugged, 0.20 s); then **the agent** starts, in the same instance: a privileged DinD container (own Docker, B's socket mounted).

| Step | Result |
|---|---|
| after `narrow`, from B | the host proxy `Network is unreachable`; `pg` still `Up 24 seconds`, the service unit `active`, the file there: **nothing the setup started stops at `narrow`** |
| the agent's DinD | ready 5.6 to 5.9 s (load of about 6); the images it needs come from B's Docker, **with no network**: `docker save postgres:17-alpine busybox \| docker exec -i agent docker load` 18 to 25 s |
| the agent uses the setup's Postgres | a container of the **agent's own** Docker (`psql`, `--network host`) reads the row the setup wrote (`7`), inserts one (`8`), counts 2; the setup's service answers on B's `docker0` address |
| the agent's own Docker | `docker run busybox` and `docker build` + `run` inside it work |
| the agent stops the setup's Postgres | through B's socket: `docker stop pg` (`Exited (0)`), `docker start pg`, ready, `select string_agg(v::text, ',')` = `7,8`: **stopped and started again, the data is there** |
| inner wall afterwards, from B, the agent container and a container of the agent's Docker | the table above: the doors reached, the secrets and the Docker API blocked, the proxy blocked |

So **the hand-over is "the same instance"** and it is trivial in Incus: what the setup left (files, images, containers, volumes, **processes**) is what the agent has; nothing of it is reset at `narrow`. **The contract item 9 must say so** (the setup's processes keep running after the hand-over) and hosted, which today hands the setup's result over by image, must match: its setup runs in the same VM as the agent. The agent is root of B and of a privileged container in it, with B's Docker socket in reach if the spec mounts it (this run did, to show stop and start); that is inside the wall, which is between B and A, not inside B. What was **not** tried: what the Worker's real hardening flags do in DinD (read-only root, memory and PID limits of the inner container), the real Worker image, and several sets at once.

#### What changed in the recommendation

**It holds and is firmer: Incus as the one local backend, behind one gate.** Of the three things the first spike said had to be proven as root, **two are now answered, positively**: (1) a **copy-on-write pool**: btrfs on a loop file gives a job's disk in 0.2 s (once per image 21 s) and **an enforced disk quota** (EDQUOT); (3) **Docker in Incus on the package we install**: the Zabbly 7.6 package keeps AppArmor on and needs no workaround; **keep the install-time probe** (`docker run` in a probe instance) as the gate rather than a version check, and decide who updates the package (the host's unattended-upgrades does not cover Zabbly). **The third is still open: the static host nft table** (closes port 53, which 7.6 still leaves open to host-local addresses; per-slot rules; read next to Docker's and Incus's tables): needs root, and a GitHub `ubuntu-24.04` runner is the place to prove it. New or changed: **start is about 4.5 s to the first container instead of 2.6 s** (the budget for #978's successor; most of it is dockerd and the first container, not the disk), **a full quota ends in `Disk quota exceeded` and stops Docker's own bookkeeping**, **a rule change on a NIC is a re-plug**, `incus init` needs stdin closed, and the bench numbers of the first spike for `docker build` are not to be quoted. Sysbox stays out; the agent stays a privileged DinD in an unprivileged instance on the host's kernel (the risk the first spike's recommendation names is unchanged). The same-instance decision removes the `docker commit` redesign from the follow-ups.

#### Clean-up of the re-measure

At the end: no instance, no image (the golden image and the Ubuntu base), no network (`spkin`, `spkout`), no ACL, no profile, **no volume** (the `images` volume), `storage.images_volume` unset again (the server config is `{}`), the host proxy, the decoy and the control endpoint stopped, the downloads and the scratch files deleted; **`crpool` is kept** (empty: 8.6 MiB used) and the `default` pool, `default` profile and `incusbr0` were never touched. `/` is at 71 % as before (27 G; nothing of the spike was on it: `storage.images_volume` pointed the image store at `crpool` before the first image).

### What was not proven

- **A copy-on-write pool, the real start time and the quota:** needs root (btrfs, ZFS or LVM on a device or a loop file the installer makes). The 19 s is the `dir` pool's. **Answered in the re-measure (btrfs on a loop file: 0.2 s, quota enforced).**
- **The static host nft table** (closing port 53, the per-slot rules) and a read of the host's Docker and Incus tables: no root, and the guard against the way round. **IPv6 refusal** (no control possible here).
- **A kernel with `br_netfilter` or the nft `bridge` family**, where Incus ACLs might filter inside a bridge. **Incus ≥ the upstream fix** (AppArmor kept on): not installed on the first run; `raw.lxc` unconfined is what ran. **Answered in the re-measure (7.6: AppArmor on, no workaround).**
- **The real Worker image, the real hardened `docker run` of Control, the doors' real firewalls and `vm-init`**: stand-ins (python servers, `docker:dind`, busybox, a fake secret file). Nothing was called that needs a model, a key or a token; no real secret exists in any instance.
- **Hand-over of the setup to the agent** other than "the same inner daemon" (an Incus copy of the stopped instance, or an image made from it): not tried; **the same instance was shown in the re-measure** (the owner's decision). **Sysbox-like hardening flags** of the agent's container (read-only root, memory and PID limits of the inner container) were not run in DinD.
- **Several sets at once** (one set at a time by the rule), **a restart of the Incus daemon, a host reboot, the daemon's own upgrade**, an OOM kill, a CPU quota, `limits.memory.enforce`.
- **Escape resistance.** The agent is root of a privileged container inside an instance whose only confinement is the user namespace, seccomp and cgroups (AppArmor off on the first run, on in the re-measure). **The kernel is shared with the host**; a kernel flaw is a host flaw, which a microVM does not share. Not assessed beyond what is written under Q2.
- Other distributions, other kernels, Debian's or the upstream Incus package, ARM.

### Clean-up of the spike

At the end: no instance, no image (the two, `spike-docker` and the Ubuntu base), no network (`spkin`, `spkout`; a third, `spkctl`, was deleted at once), no ACL, no profile, no storage volume, the pool `spike` deleted and its directory removed, `storage.images_volume` unset (the server's config is `{}` again), the
host proxy, the decoy and the control endpoint stopped, the downloads and the exported image (840 MB) deleted. The owner's `default` pool, the profile `default` and `incusbr0` were never changed. `/` is at 69 % as before. **A mistake of the spike:** a first timing loop that went to the background after its tool call timed out kept starting `incus init` jobs for a quarter of an hour; its two
extra timings (16.7 and 18.4 s) overlapped another init and are not used for the headline; the quiet runs are.
