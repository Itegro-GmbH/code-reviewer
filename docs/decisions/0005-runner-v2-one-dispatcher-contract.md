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
- **Events, bounded:** an enqueue, a job that a lapsed lease (or a revoked runner, or a holder giving a turn back before it started) put back in the queue (`onRequeued`: the job itself
  on every dispatcher that can take it, then its group), and the end of any claim (`onClaimsEnded`: a result, a failure, a cancel, a lapsed lease that fails the job, a timeout) ring the
  waiting jobs of the group (the labels the ended job required and the labels of the runner that held it). At most 20 pairs, no pair twice within 9 seconds, a dispatcher that is full or
  unreachable once per reaction, and a dispatcher whose last call ended in a network error or a timeout is not asked again for a minute, for any job (remembered in `job_rings`, so it
  holds across runs and instances). **With more than 20 matching dispatchers, the first 20 in the order of the query (oldest job, then runner id) are rung first; this is by design:**
  the bell is a nudge, the others hear of the job by their own claim, a later event or the sweep, and the claim decides who gets it.
  The sweep (every 2 hours; the comments that said once a minute are fixed) stays the safety net.
- **The address is checked twice, and loopback is for the fakes only.** The announced address must be https to a public host (no private, loopback, link-local, reserved or non-global IPv6
  address, in any spelling; no `.internal` or dotless name; a trailing dot is no way round). A name that looks public can still resolve to the app's own network, so every connection to
  a customer's dispatcher (the doorbell and the stop call) resolves the name once and refuses it when any address is internal, and connects to an address that was checked (an undici agent with
  its own `lookup`): no gap for a DNS rebinding. Loopback and plain http are accepted only where `RUNNER_DELIVERY_ALLOW_LOOPBACK=1` is set (the fakes and the E2E), never by default and never in
  production. The platform's own `RUNNER_WEBHOOK_URL` is the operator's setting and is called as before.
- **Stop** goes to the webhook dispatcher that holds the job (`jobs.runner_id`), signed with its own secret; a polling dispatcher learns from its worker ending.
- **Only with the dispatch webhook on** (`RUNNER_DISPATCH=webhook`, hosted): in poll mode the app makes no outgoing call.
- **Not done here:** the hosted Dispatcher still claims by the `jobId` of the doorbell and still answers a full pool with `429`; a UI to show the secret once and to rotate it.

## 3c. Details of #973

- **The manifest is a list of entries** `{ harness, version, auth, models? }` (`contracts/runner-registration.v1.json`, `HarnessAccess`), one for each harness and source of access: `managed`
  (the platform identity's keys), `app-key`, `local-key`, `subscription`. `models` only for the two accesses that exist on the device; left out, the device allows any. There is no `ready` flag: an entry is
  announced only while the dispatcher can run it, a dispatcher that cannot for a while leaves it out, and the app uses the last announcement. The old map form stays readable (OpenCode as `app-key`,
  Claude Code as `subscription`, not ready as none); the stored text is the list form (migration `20261110180000`).
- **A job's demand is derived, the profile is untouched:** the harness of the turn's profile, the auth (a harness that runs on a login asks for `subscription`; a catalog entry asks for `managed`; a model
  of the workspace's own key asks for `app-key`) and, for a subscription, the model of the turn. A dispatcher takes the job when one entry has all three.
- **`managed` replaces `runner_needs_own_key` in the routing.** Only the platform identity announces it (`RUNNER_ACCESS_RESERVED`, 422, for a customer's runner), so no customer's runner matches a turn that asks for
  the platform's keys; the check is by identity as for `cr:` labels. The platform's own manifest is `PLATFORM_ACCESS` (OpenCode with `managed` and `app-key`), defined once in the app and not announced.
  The start of a task and the validator keep the code `runner_needs_own_key` for the person who can act on it; a managed turn that reached the queue on a runner environment now waits (and ends with
  `no_runner_available`) instead of ending at the claim.
- **One rule.** `accessRule` is the SQL fragment that both the claim and the pairing of the rings use; `accessMatches` is the same rule in memory. A test runs every manifest against every turn through both.
- **The validator says what no online runner announces** (`no_runner_announces`): a warning (`severity: "warning"`), never a refusal, when a runner with the environment's labels is online and none has an entry for the
  profile; with no such runner online nothing is said. A runner that is asleep, or that withdraws an entry for a while (a rate limit), must never block saving a profile or a workflow.

## 3d. Details of #977

- **vm-init** (`runner/src/code_reviewer_runner/vm_init/`, `runner/vm-init/README.md`) is the program in the local VM's root file system that does what the Sandbox API does hosted: it takes the start over vsock, prepares the VM with the
  hosted launcher's steps, checks the image id against the manifest, makes the work volume, runs the Control container and reports how it ended (`contracts/vm-init.v1.json`). **Python, standard library only**: one language for the whole
  job-side path and the lane that already tests it; the interpreter in the root file system is the price (Go and Node were the alternatives, see the README).
- **The `docker run` arguments are rendered once, by the Dispatcher**, from the hosted Implementer spec plus `RUNNER_ENVIRONMENT_CONTROL` and a seccomp profile that allows AF_VSOCK, and sent in the start; vm-init executes them. A
  golden file (`docker-run.local-control.golden.json`) pins them and the runner's tests feed it to the guest unchanged. The hosted spec and its golden file are untouched.
- **No relay: Control connects to the host itself** (CID 2, port 5100, `environment-control.v1.json` unchanged). Only the Control container gets the seccomp profile; the agent's container, the doors and the readers keep Docker's
  default profile, which refuses AF_VSOCK. That denial is **defence in depth**, not what the host trusts (Docker's default profile allows `socketcall`, and a kernel with 32-bit emulation could let a 32-bit call open the socket; the kernel of #976 has none).
  vm-init's own exit report goes to its own port (5101) and is the authority on how the job ended.
- **The host trusts a per-VM token, not the denial.** The host makes a random token for each VM and sends it in the start; vm-init puts it in every exit report after a start, Control receives it on its stdin with its credential and puts
  it in every `narrow` and `end` (`controlToken` of `vm-init.v1.json`, an optional `token` of `environment-control.v1.json`: additive, still version 1). The host refuses a message without it or with another
  (`dispatcher/src/launchers/control-token.ts`, which #978 reuses). A report without a token counts only while the host has no `ack` for the start (a VM that never took one).
- **Trust boundary.** The host owns the VMM, the root file system and the kernel and is trusted; vm-init binds the image of `control.args` to the checked image id and refuses a cheap deny-list of options (`--privileged`, `seccomp=unconfined`,
  host namespaces, `--device`, `--cap-add ALL`, mounts but the work volume and the Docker socket): that catches a bug of the Dispatcher and is no defence against a hostile host. The host owns the job's wall clock (vm-init has none);
  vm-init sets its own `oom_score_adj` to -1000 and always powers the VM off.

## 3e. Details of #974

- **The customer's claim is the split claim, always.** A claim with a runner credential (`crc_`) is answered like the platform's: the job's id, the credential of its Worker (`crj_`), the `labels` the job required (a customer's job has no `sizeLabel`: size labels
  are the platform's) and, for a turn of the Implementer, `access` (`SplitClaimResponse.job.access`: harness, auth, model; never a credential). The app forces the feature `worker_credential` for a customer's runner whatever the claim names, so no
  caller of a customer's credential can be handed a job input, a git token or a key. What needs no secret is still decided at the claim (the label and access rules of #971 and #973, the guard of the project, the entitlements, a managed
  selection refused with `runner_needs_own_key`); the input is made when the Worker fetches the job.
- **The Worker API serves the turns of customer runners.** `GET /api/workers/v1/jobs/{id}` builds the input of any job claimed with a credential, including a turn on the harness `claude-code` (`buildSubscriptionJob`: no model, key or price, the git token of
  exactly this repository, the features the Worker names), answered as `WorkerSubscriptionDetailsResponse` (no `llm`). Heartbeat, result, steps, snapshot and stored session are the Worker routes, as hosted.
- **The local dispatcher holds no job secret.** `factory-runner` is the local dispatcher (registration, announcement, renewal, claim, slots, the start and the stop of the sandbox, the release of a claim, the reaping of a Worker whose job is over) and
  the Worker it starts (`factory_runner/local_worker.py`) is the hosted Worker. The hand-over is `{appUrl, jobId, credential}` on the Worker's standard input, plus `localEnvironment`: the one credential of the device a job asks of it
  (decision 4; a Claude Code subscription, read by the dispatcher from the token file of R3), never through the app. Until the Firecracker launcher (#978) the Worker is a process of the dispatcher's own container on the host's Docker
  (`ProcessSandbox`, the seam is `WorkerSandbox`); a test holds that the dispatcher's fields and its log contain no git token and no model key whatever the app answers.
- **What the dispatcher still calls with its own credential:** registration, announcement, renewal, the claim, `GET /api/runners/v1/jobs/{id}` (the state of a job of its own workspace, `404` for any other: the local reaper) and
  `POST .../release` (the credential of the claim in the body). **Removed** (no runner image is published, `release-channel.json` is empty, so there is no deprecation window): `/api/runners/v1/jobs/{id}/session` and `/resume-session`
  (route files, contract definitions `Runner*`, the app feature `runner_session_snapshot`), and `heartbeat`, `complete` and `steps` for a runner credential (they answer `404 RUNNER_JOB_NOT_FOUND`; the shared token's
  calls of the platform's Dispatcher are unchanged).

## 3f. Details of #979

- **The outer wall on a customer's machine is two parts.** A static nft table (`docker/vm/host/outer-wall.nft`, its own table `inet code_reviewer_wall`, every rule on our TAP devices `fctap*`, never another tool's tables) lets a VM's TAP open a TCP connection to the proxy port of the
  host (3128) on a slot's address and drops everything else (the host's other ports and addresses, UDP and DNS, ICMP, the LAN, RFC1918, link-local and the metadata address, the other VMs, the internet, IPv6). The proxy is part of the local Dispatcher (a normal user): the network door's own
  proxy code (an address is never a name, only 80 and 443, every address of a name must be public, the connection goes to an address that was checked) with a rule **per VM**.
- **The proxy listens on each slot's TAP address and nowhere else** (the spike found that a guest could reach a proxy on the host's other addresses) and serves only the slot's own guest; the table lets a TAP reach any slot's proxy address because it is static, so the proxy closes a connection from another source unanswered.
- **The rule language is the hosted one.** The narrowed list is `policyFor` of `dispatcher/src/network/rule.ts` (GitHub, the model provider, the app, the rule's hosts) without the Dispatcher's own host; `contracts/network-rule-examples.json` is read by both suites (rule documents, the narrowed list, verdicts on names and ports).
  The setup runs under the **wide rule** (any public name, 80 and 443), `narrow` swaps in the job's rule, **acknowledged only once the proxy holds it**, and ends the connections of the setup that are still open.
- **`OuterWall` gained `admit`** (the VM gets the wide rule before the VMM exists) and the proxy wall is a setting (`FACTORY_RUNNER_OUTER_WALL=proxy`), set by the installer (#982) once it has verified the nft table; the default stays `refuse` (the dispatcher cannot see nft state), and `inner-only` is an explicit choice. A wall that raises or does not answer within 10 seconds is answered `refused` `unavailable`, never by dropping the connection.
- **Every client in the VM goes through the proxy (#994).** The slot's proxy address is the host's: the launcher puts it in the start (`outerProxy`, only with the proxy wall), vm-init validates it (a private IPv4 address: the slots' network is the installer's choice for each machine, #982) and writes it into Control's stdin, Control hands it to its job process, and each client that dials the internet uses it and none falls back to a direct connection: Control's Worker API calls (the opener has no bypass), `git` (`http.proxy`, https only), the model door's upstream (`CONNECT name:443`, TLS through the tunnel, no lookup of its own) and the network door's upstream (agent, network door, outer-wall proxy: chained after the door's own rule and port decision), and the Setup container (the usual proxy variables; the VM's table for its bridge lets only the proxy out). The doors' firewalls in the VM let them dial the proxy and nothing else. The inner wall and hosted are unchanged. The local Control spec, its template and its golden file do not change: the address is per slot and travels in the start like the token. See `docs/runner.md`, "Every client in the VM goes through the proxy".
- **Not done:** the installer loads the table (#982); a whole job in the KVM lane with the table loaded is #999.

## 3g. Details of #980

- **One hand-over shape.** The dispatcher hands a job's Worker at most **one** credential of the device, as `localCredential: {name, value}`: on the standard input of a Worker that is a process (`WorkerStart.document`,
  replacing the `localEnvironment` map of §3e) and as the `localCredential` of vm-init's start (`contracts/vm-init.v1.json`, unchanged in shape), which vm-init writes to Control's standard input. There is **one
  allow-list of names** (`LOCAL_CREDENTIAL_NAMES`, today `CLAUDE_CODE_OAUTH_TOKEN`; `job_loop/local_credential.py`) that the host checks before the start, that vm-init does not check (it checks the shape) and that **Control
  checks itself** (`worker_cli`, `parse_local_credential`) before it puts a value into any environment, closing the review of #977: a name such as `PATH` or `LD_PRELOAD` is an input error. The Worker of a process (`local_worker`)
  uses the same parser. Control had read no `localCredential` before this issue; the host's per-VM `controlToken` in the same document goes to the environment control and not to the agent.
- **The store** (`implementer/claude_code/credentials.py`): `<runner home>/credentials/` (0700) with an index without values and one 0600 secret file for each credential, **sealed with `systemd-creds --user`
  when that works** and otherwise a plain 0600 file (`FACTORY_RUNNER_CREDENTIAL_STORAGE`: `auto`, `systemd-creds`, `plain`). Added from the standard input only (`factory-runner credential add claude --name`, `list`,
  `remove`, `retry`, `add --replace`); never mirrored from `~/.claude/.credentials.json`. **One login source:** `load_login` reads the store as soon as it holds a credential (and then ignores the token file and the
  environment variable of R3), so the self-test, the readiness and the jobs agree with the dispatcher's pool; `store_login` returns only a credential that can be used now. The token files of R3 are read only while the store
  is empty. **What the seal is:** `systemd-creds` protects the token **at rest** only. The dispatcher decrypts without a passphrase, so code running as the service user can decrypt it as well; the sealed path was written
  against the documented behaviour and has **not** been run against a real systemd 256 or later (the DevBox has 255) (#997).
- **The manifest** announces `claude-code`, `auth: subscription` and the union of the `models` of the credentials that can be used now (defaults `sonnet`, `opus`, `haiku`), never a name. A credential counts only if its
  secret can be read: an entry no credential can serve is not announced, and a claim that comes anyway is given back **with the start-failure backoff**, so a broken store cannot loop claim and release and spend an attempt
  of every queued job. **Readiness is decided from the layer alone** (`claude_code_status`): the service offers the entry whenever the pool finds a usable credential, also when it started before the first
  `credential add`, so no restart is needed. **Alias or id (settled):** the runner announces what its owner gave and the matching learns the alias-to-id map: `contracts/claude-model-aliases.v1.json` (patterns and vectors),
  a typed copy in the app (`model-aliases.ts`, also written into `accessRule`) and in the runner (`model_names.py`), a test of each side against the file, the vectors run through the SQL rule as well. Announcing ids was rejected:
  it would need a list that changes with every model release.
- **Choice, and what a job's end teaches** (`factory_runner/credential_pool.py`, `service.py`): one credential for a job, the one that is not rate limited, not refused and allows the job's model, the one unused longest
  first. A job the subscription refused ends with `subscription_auth`, `subscription_limit` or `subscription_model_refused` (free; contract, app copy and billing class), and the Worker's exit code (20, 21, 22) tells the
  dispatcher, which cannot read the result. **All three are hints that expire, none is a verdict.** The exit code derives from the job's `result` event on Claude Code's standard output, and the agent in the sandbox runs as
  the same user as Claude Code (`agent`, uid 10201), so it can, as far as we can tell, write that event itself or ptrace the process: the verdict is **forgeable from inside the sandbox**, and nothing cheap prevents it
  (the tools are Claude Code's children, `no-new-privileges` does not stop a same-user ptrace, the token is in the same environment anyway). So a 401 puts the credential aside for six hours (`AUTH_COOLDOWN_SECONDS`), a
  refused model leaves the offer for six hours (that one id; an alias is never taken off by one refusal and is set aside once two ids it covers are, `ALIAS_ASIDE_AFTER`), a limit puts it aside for one hour; all three
  are configurable (`FACTORY_RUNNER_CREDENTIAL_{LIMIT,AUTH,MODEL}_COOLDOWN_SECONDS`) and `credential retry` ends them at once. The list the owner gave is never shrunk (`add --replace` without `--models` keeps it).
  The impact of a forgery is limited to the owner's own credentials on the owner's own device, for hours. The entry is withdrawn from the manifest (a new `PUT /self` before the next claim) while no credential is usable,
  and returns by itself. **A job that hits the limit fails (free) and is not moved to another credential in the middle of its run:** a turn is one Claude Code session on one login.
- **The agent still gets the token** in its environment, as in R3 (Claude Code needs it there and the tool processes inherit it); what limits its use of it is the outer wall (#979, §3f), once the clients inside the VM go through its proxy (#994).
- **Not built, on purpose:** running `claude setup-token` in a throwaway VM (#995). It is interactive, and neither vm-init (one start, one report, no terminal) nor the outer wall (#979) before #994 can carry it; a follow-up of
  #978 and #979. Claude Code's answer to a model the subscription does not allow was not measured against the real program (status 404 and its own sentence are read; #996). In Firecracker mode the entry is not
  announced yet: whether the golden image holds Claude Code is #981.

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

Everything of M2 and M3 (the Firecracker launcher and the rest): each is its own issue of epic #969.

## 3h. Details of #982

- **No Docker on the host, and the old mode is gone.** The installer (`runner/install/install.sh`, root once) makes the service user (a member of `kvm`), the TAP devices of `parallelRuns` slots owned by it, the static nft table of #979, a systemd unit with `Delegate=yes` and a sandbox,
  the program and the VM artifacts (kernel, root file system, Docker data disk), each downloaded by the digests of a **signed manifest** and verified with `openssl`, `jq`, `zstd` and `sha256sum` (the same checks as `dispatcher/src/vm-artifacts/verify.ts`; a customer's machine has no Node). The runner image
  (`Dockerfile.factory-runner`), the Docker socket unit, the Sysbox opt-in step and the image-based update are deleted; `factory-runner run` ends with exit code 6 unless `FACTORY_RUNNER_SANDBOX=firecracker`. No runner was published, so there is no migration window.
- **The artifacts are root's.** `artifacts/` is root-owned and read-only for the service (a VMM that escaped must not overwrite the kernel or the root file system every later VM boots from); the service owns `vms/`, `dispatcher.lock` and its home. Updates therefore cannot be done by the dispatcher:
  **a root timer stages** a release (`update`, signed manifest, download by digest, verify, move into `releases/<N>`, write the marker `pending`) and **the service's own restart switches** (`ExecStartPre=+ … prestart`: a smoke test, one atomic link per part, the previous release kept for `factory-runner rollback`). The dispatcher
  only looks for `pending` between two jobs and ends with exit code 10; it downloads nothing and knows no channel. Never triggered from the app.
- **`proxy` is verified at every start.** The unit sets `FACTORY_RUNNER_OUTER_WALL=proxy` only because `nft list table inet code_reviewer_wall` succeeded at install, and `prestart` (root) loads the table and fails the start unless it lists again. The dispatcher still cannot read nft state; the root step is the check.
- **Two release channels, an address that is the owner's.** The program (`runner/release-channel.json`, version 2) and the VM artifacts (`docker/vm/release-channel.json`) each have `baseUrl`, `manifestAsset`, `signatureAsset` and `publicKey`; where the files are (a GitHub release or protected storage, with `--curl-config` for a login) is the owner's decision (#969 checklist).
- **Not done:** an expiry in the manifest, a watchdog that rolls a failing release back, a signed channel file inside the release for key rotation. (The program tarball and its pipeline are 3i.)

## 3i. Details of #1002

- **The program is built by CI from a tag and signed by a job that runs nothing of anybody's.** `runner-program.yml` builds a reproducible tarball (a pinned standalone CPython, the package's files at the commit, `cryptography` and what it needs from `uv.lock`, the pinned Firecracker, the nft table and the installer as `libexec/host.sh`); `runner-program-release.yml` (a tag `factory-runner-v<N>`,
  the commit on `main`, an environment with required reviewers, a draft release) signs it with the key of the channel. The signing job installs nothing and verifies the tarball with shell that copies the installer's checks (`runner/release/verify-release.sh`). It is the design of the VM artifacts' release, reviewed in #976, with the build out of the key's reach.
- **Python ships inside the tarball, and only what the host program imports.** The host program is the Dispatcher; PR-Agent and the Worker's dependencies run in the VM's image. Its one third-party import is `cryptography` (with `cffi` and `pycparser`), so the tarball is 22 MB and the closure of `cryptography` in `uv.lock` must stay exactly those three packages (the build fails otherwise; a test holds the imports to it).
  The package is its files at the commit, not a wheel (an unpinned build backend would make two builds differ).
- **The program is paired with a VM artifacts release by a file in the repository** (`runner/release/pair.json`), checked at release time (exists, verifies with the VM channel's key, built from this commit's history), not by a field of the manifest: the manifest stays the format the installer reads. A future installer may read `share/release.json` to refuse a program without its VM artifacts.
- **A GitHub release is no stable channel address.** The installer reads `<baseUrl><asset>` and keeps the channel file; two channels in one repository cannot both use `releases/latest`, and a per-release address would orphan every installed runner. The owner publishes either to protected storage or to one fixed-tag release per channel whose assets are replaced (the manifest last); the workflow publishes nothing.
- **Not done:** the real release (the owner's decisions: environment, key, `publicKey` and `baseUrl`, where to publish), a signed `expires` in the manifest, a program that checks its own VM artifacts at start, the live test on a real host (`docs/runner.md`, "First install on a real host").
