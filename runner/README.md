# Code Reviewer runner

Python code that runs one review job with [PR-Agent](https://github.com/qodo-ai/pr-agent) or the Dynamic Review engine.
`code-reviewer-runner worker-once` is the **Worker**: it runs in the Worker image inside a fresh Sandbox VM, fetches
exactly one job from the app with a per-job credential and starts `code-reviewer-run-job`, the entry point of one job,
as a process of its own. See the repository `README.md` for setup and `TESTING.md` for the tests.

## The Worker's settings

`code-reviewer-runner worker-once` (the container's command in the Sandbox VM) and `code-reviewer-runner probe` read
these environment variables. The app address, the job id and the per-job credential are not settings: they come on stdin
(see "The Worker" below).

| Variable | Meaning | Default |
|---|---|---|
| `RUNNER_JOB_TIMEOUT_SECONDS` | Hard timeout of one job, see below | 1200 (20 minutes) |
| `PR_AGENT_COMMAND` | The command that runs one job, split like a shell would. Only for test stacks that replace PR-Agent with a fake | `python -m code_reviewer_runner.runner` |
| `RUNNER_OPENCODE_COMMAND` | #197: the pinned stock engine that runs one Dynamic job, split like a shell would (the adapter appends `serve --hostname 127.0.0.1 --port <job port>`). The executable is the one `scripts/fetch_opencode.py` verified against `opencode-pin.json`. Unset means a Dynamic job is refused with `dynamic_engine_unavailable`; never falls back to PR-Agent. The engine also needs a trusted `rg` (ripgrep) on its `PATH`, or it is not started | unset |
| `RUNNER_DYNAMIC_MAX_COST_USD` | #290: the most one Dynamic run may cost, in USD, a plain decimal number above 0 up to 20. Unset or empty: 1.00. Anything else ends the job with `dynamic_config_invalid`. Trusted operator configuration; nothing in a claim can set it. Since #689 the operator sets the maximum per review in the admin portal and the app sends it with every job (`llm.operatorMaxCostUsd`); a job that carries it ignores this variable, which stays only the fallback for a job from an app that does not send it | unset |
| `RUNNER_DYNAMIC_CAPABILITIES` | #197, #279: trusted JSON descriptor of the selected model/destination: `{"tool_choice_required": true, "structured_output": true, "max_output_tokens": 32768}`, with `input_usd_per_mtok` and `output_usd_per_mtok`, optionally with `context_window_tokens` (#290). **A ceiling, and optional (#279):** the app sends the descriptor it read from OpenRouter's model metadata in `dynamic.capabilities` of the job, and the runner intersects it with this value (both must support the features, the smaller output limit and window win, the higher unit price wins), so a job can only narrow it. Unset or empty: the job's descriptor applies; without one, the descriptor built into the runner for exactly the shipped default model `deepseek/deepseek-v4.1-flash` (#264); for any other model the job ends with `dynamic_model_features_unsupported`, no fallback. A model with no unit prices anywhere ends with `dynamic_config_invalid`. A value that is set but unusable fails the job | unset |
| `RUNNER_DYNAMIC_ENGINE_UID`, `RUNNER_DYNAMIC_ENGINE_GID` | #197: the numeric dedicated unprivileged user (and its own group) the engine runs as; it must exist in the image and be neither root nor the runner's own user. The Dynamic job process is the root supervisor that starts the engine as this user | `10101` and `10101` |
| `RUNNER_DYNAMIC_PROXY_PORT`, `RUNNER_DYNAMIC_ENGINE_PORT` | #244: the two fixed loopback ports of the single Dynamic slot (model proxy, engine server), 1024 to 32767 and different. The engine user's static nft rules, installed once at container start, name exactly these; a stranger holding one makes the job fail closed | `10180` and `10181` |
| `RUNNER_DIFF_JOB_USER` | #197: `uid:gid` the Worker drops every non-Dynamic job process to, with no other group, in a working directory it owns. Set only on a Worker that runs as root (the hardened container spec), so PR-Agent never runs as root; unset runs jobs as the Worker's own user | unset |
| `RUNNER_DYNAMIC_NODE_BIN` | #197: directory of the Node runtime the engine needs, if it is not on the runner's own `PATH` | unset |

**The Dynamic job process is the supervisor (#197 part 2b).** It runs as root with only the
capabilities of that file (`SETUID`, `SETGID`, `KILL`, `CHOWN`, `DAC_OVERRIDE`, `FOWNER`;
`no-new-privileges` stays on). **At container start only**, before the event loop and any thread
exists, `job_loop.service.prepare_dynamic_runtime` (`dynamic_review/static_isolation.py`, #244)
installs the static nft rules for the single slot (new connections of the engine user only to the
fixed proxy port `RUNNER_DYNAMIC_PROXY_PORT`, default 10180, and the engine's own port
`RUNNER_DYNAMIC_ENGINE_PORT`, default 10181, on `127.0.0.1`) and then drops `NET_ADMIN` and `SETPCAP`
from the bounding set and from its own sets: the container is created with them (`cap_add`), but the
Worker host, every job process and the engine never hold them, so `nft` fails for all of them. If the drop
cannot be confirmed the runner does not start; if the rules cannot be installed the capabilities are
dropped anyway and every Dynamic job fails with `dynamic_isolation_self_check_failed`. The ruleset is
the full one (`table inet`, `reject`) wherever the kernel supports it; on a kernel with only the
nf_tables `ip` family the startup step installs an `ip` + `drop` fallback and switches IPv6 off, which
the self-check proves (`ipv6_off.py`, reason `ipv6_not_disabled`; #345, `docs/dynamic-review.md`). Per job it (1)
prepares and seals the read-only export for the dedicated engine user
(`export_isolation.prepared_checkout`, which also leases that user and its group exclusively), (2)
checks that its own process holds neither capability and proves the static rules with a probe run as
that user before the engine exists (`netguard.py`, `engine_user.py`; a failure is
`dynamic_isolation_self_check_failed` and no engine), (3) starts the engine with `setuid` in the child, no supplementary group and a closed
environment, with its config file readable (not writable) by that user only, and checks that the user, and nobody
else, listens on the engine's port (`engine_user.py`), and (4) at the end, on SIGTERM (lease loss,
shutdown, timeout) and in the watchdog, kills the engine's process group and then every process of
that user, including helpers that left the group, and removes the job's files (the rules are static
and stay). The Worker host (root) sweeps that user after every Dynamic job process, and every job sweeps it
right after taking the lease; a sweep that fails makes the next job refuse to start. Without root
(or without the user) the production preparation refuses with `dynamic_isolation_self_check_failed`:
the engine never runs unconfined. The proofs need root and live in `tests/privileged` (below).

Rules (the CR-29 decisions, kept by the Worker host `job_loop/host.py`; tests in `tests/unit/test_job_loop*.py` and `tests/integration/test_job_loop*.py`):

- **One process per job.** The job (with the git token and the LLM key) goes to the process on
  **stdin**, never in the arguments and never in the environment. The process gets a minimal
  environment (`PATH`, `HOME`, locale, proxy and certificate settings, the tiktoken cache and its
  timeout), so it does not see the per-job credential or the job of another process, and its own working
  directory (empty, removed afterwards: PR-Agent reads a `pyproject.toml` there). It leads its own
  process group, so ending a job ends everything it started. The group is only signalled while the
  leader is still unreaped (`process_group.py`; the process is a `Popen` whose pipes are read through
  asyncio, because asyncio's own subprocess reaps the child at once), so a reused group id can never
  be signalled (#233).
- **The engines the Worker advertises (#195).** `pr-agent` always, `opencode` only after the startup self-check passed
  (#202): root supervisor, engine user, static network rules installed, `NET_ADMIN`/`SETPCAP` dropped, pinned and
  trusted engine and `rg`, and a probe run as the engine user (`dynamic_review/self_check.py`, run by
  `job_loop/service.py` after the network setup and before the job is fetched). A failure logs a stable reason and
  leaves `pr-agent` only; a Worker without an engine user never passes. The Worker gives the job process of a Dynamic
  job the advertised engines, the verified engine command and `RUNNER_DYNAMIC_CAPABILITIES`; a Diff job process gets
  none of them. The Worker reads from a Dynamic job the model descriptor (#279), `dynamic.cost` (the price book of the
  managed key, the token cap of an own key; `dynamic_review/passthrough/cost_policy.py`, #553) and, next to it,
  `dynamic.modelEntry` (#578): a job with both is native and runs through the passthrough proxy and the plain-final
  engine path (`dynamic_review/native_job.py`, `docs/dynamic-review.md`, "The native path of a job"); a job that carries
  a cost policy but no entry would reach the legacy wire and is refused with `dynamic_config_invalid`. It reads
  `llm.maxCostUsd` too (#666, the cost limit of the project) and holds a Dynamic run to the smaller of that and
  `RUNNER_DYNAMIC_MAX_COST_USD` (`stoppedEarly: project_cost_limit` when the project's is the smaller), and a Diff run
  sends no further model request once its calls cost that much (`diff_cost.py`, the result code
  `cost_limit_reached`). It reads `llm.operatorMaxCostUsd` as well (#689), the most one review may cost as the
  operator set it in the admin portal, and holds a review of either kind to the smaller of that and `llm.maxCostUsd`; a
  job that carries it ignores `RUNNER_DYNAMIC_MAX_COST_USD`. A Dynamic job that arrives at a Worker that cannot run it
  is refused locally and never run by PR-Agent.
- **Refused jobs start nothing.** The input is validated with the runner's own `parse_job` before a
  process is started: an unknown command (`invalid_command`) or platform and any other invalid input
  (`invalid_job`) are delivered at once. The platforms are the table in
  `platforms.py` (`git.provider` to PR-Agent settings; `github` only in the MVP).
- **Heartbeat** every `heartbeatIntervalSeconds` (30) while the process runs, none after it ends. A
  `409` means the lease is lost: the process is ended and nothing is reported. Other failed heartbeats
  are tried again at the next beat.
- **Hard timeout.** The process gets `RUNNER_JOB_TIMEOUT_SECONDS` as its own limit and reports `timeout`
  with its log when it hits it. A process that does not stop (or a blocked one) is ended by the Worker
  10 seconds later: `SIGTERM` to its process group, `SIGKILL` 5 seconds after that, and the job is
  reported as `timeout`. So the effective limit is the timeout plus 10 seconds.
- **The result** is the last line the process printed on stdout, checked against the contract. A
  process that ends without a usable line (crash, signal, no output) is reported as `runner_error` with
  the end of its stderr. The log tail is redacted again with the secrets of the job, the per-job credential
  and the lease tokens, and cut to 4 KB; the body of the result stays under 48 KB (the app refuses 64 KiB).
  Only the newest 256 KB of stdout and 64 KB of stderr are kept, however much the process writes.
- **The result is delivered with repeats** with growing pauses while the app cannot be reached, for up to 10
  minutes (the lease is 2 minutes, so the app has taken the job back by then). While the result is being resent the
  Worker keeps sending heartbeats, so the lease cannot lapse and no other Worker can take the job a second time; a
  lost lease (409) stops the attempts. A `400` or `413` is answered once with the bare verdict (no log). An answer
  that is not HTTP (garbage, a cut-off body) counts as the app being unavailable. The answer
  `status: "queued"` (after a shutdown report) is accepted.
- **Shutdown.** `SIGTERM` or `SIGINT` while a job runs: the job is ended and reported as `failed` with
  `runner_shutdown`, which the app gives back to the queue; there is no grace period. Exit code 0.
- **No secrets in logs.** The Worker logs ids, codes and counts, never the input of a job. Every line
  passes a masker that knows the per-job credential, the lease tokens and the credentials of the running job.
- **The image.** The entry point is `tini` (PID 1) in front of the Worker, so the helpers of a
  killed job are reaped and a stop of the container reaches the Worker as SIGTERM. `PR_AGENT_COMMAND` must never be
  set in a real deployment: the job, with its credentials, would go to that command. Only test stacks set it.
- The codes the Worker adds to the ones of the table below: `runner_shutdown`. `timeout` and
  `runner_error` are also reported by the Worker itself.

### The Worker: `code-reviewer-worker --once` (#323)

The hosted deployment (#316) runs every job in a Worker that knows nothing but the app URL, the job id and a
**per-job credential**. `code-reviewer-worker --once` is that Worker: it reads one JSON document from **stdin**,
`{"appUrl": "...", "jobId": "<uuid>", "credential": "crj_..."}` (never the arguments or the environment; other
keys are ignored), fetches the job over the Worker API (`contracts/worker-api.v1.json`, `/api/workers/v1`), runs it
through the job host (`job_loop/host.py`: the same job process, heartbeats, hard timeout, lease check
before the Dynamic summary, masking, delivery with retry and engine-user sweep), delivers the result and exits.

| Exit | Meaning |
|---|---|
| 0 | the job succeeded, or it was given back to the queue (SIGTERM/SIGINT during the job: `runner_shutdown` is delivered, there is no grace period) |
| 1 | the job failed, the app no longer held it (409 on a heartbeat: the process group is ended and nothing is delivered), or the result could not be delivered |
| 2 | the Worker could not start the job; the log line names a stable code (`worker_input_invalid`, `worker_settings_invalid`, `worker_app_unsupported`, `worker_app_unreachable`, `worker_credential_invalid`, `worker_job_ended`, `worker_job_given_back`, `worker_fetch_refused`) |

- **Settings** are the variables of the table above (`RUNNER_JOB_TIMEOUT_SECONDS`,
  `PR_AGENT_COMMAND` for test stacks, `RUNNER_DIFF_JOB_USER` and the Dynamic slot's variables), and the startup
  self-check decides whether `opencode` is advertised. There is no `RUNNER_TOKEN` and no `RUNNER_API_URL`.
- **An app without the Worker API is refused** before anything is fetched or started: a `GET /api/runners/v1/version?jobId=<its job>` (the App accepts the job credential there only with the job id, #322)
  that lists no `worker_api`, or a Worker API route that answers with something other than the contract's error body
  (an app from before the hosted deployment), ends with `worker_app_unsupported`. The Worker holds the job credential,
  not the dispatcher credential, so a `401` on `/version` is not a refusal; the details call decides.
- **A Dynamic job whose engine is not advertised** is not started: `dynamic_engine_unavailable` is delivered.
- **The fetch** is tried at most three times, the number the contract allows per claim (pauses of 1 and 2 seconds, at least the app's `Retry-After`). A
  credential the app does not accept, a job the app ended, and a `503` that gave the job back are final.
- **The credential** is in memory only. It is a secret of the masker from the first log line, so no log line or result
  holds it, and it is never given to the job process: that gets the job (with the git token and the model key) on stdin
  and a minimal environment, as in every job process. A usage error does not echo the arguments.


### Entry modes of the image, the engines file and `worker-reap` (#324)

One image, one entry point, two modes. `code-reviewer-runner <mode>` takes the mode as its required argument (the
Sandbox-Launcher passes it as the container's command). A missing or unknown mode is a usage error (exit 2) that does
not echo what was typed.

| Mode | What it does |
|---|---|
| `worker-once` | One Worker (above): `{appUrl, jobId, credential}` on stdin, one job, exit code 0, 1 or 2. Same as `code-reviewer-worker --once`. |
| `probe` | Runs the startup and prints one line of JSON, the verdict, then exits. No token, URL or credential is read. |

**The startup is the same in every mode** and runs once, first thing in the container, before any thread, job process
or (in `worker-once`) the start document exists: the engine user's network rules, the end of `NET_ADMIN` and
`SETPCAP`, then the self-check that decides whether `opencode` is advertised (`job_loop/service.py`, `run_startup`).
`worker-once`, `probe` and `code-reviewer-worker --once` require the **read-only root filesystem** of the
hardened container spec: on a writable root `opencode` is not advertised (`root_filesystem_writable`). A container
that cannot drop `NET_ADMIN` (no `SETPCAP`) does not start in `worker-once` (exit 2) and answers `probe` with
`capabilities_not_dropped`.

**The verdict** (`probe`'s one line of stdout; logs go to stderr):

```json
{"version":1,"engines":["pr-agent","opencode"],"reasons":[]}
```

`engines` are the engines the container may advertise; when `opencode` is missing `reasons` holds the stable reason
from the list of `docs/dynamic-review.md` ("Startup self-check"), for example `network_rules_not_installed` (no
`NET_ADMIN` or `nft`), `capabilities_not_dropped`, `root_filesystem_writable` or `not_a_dynamic_runner`. It holds no
other text and no value of the environment. The exit status says whether the probe ran, not whether the container
passed: 0 with a verdict (also `pr-agent` only), 2 when the settings are unusable and there is no verdict. A launcher
that wants `opencode` checks that it is in `engines`.

**The engines file.** Every start writes the same verdict to `/run/code-reviewer-engines.json` so that a launcher
inside the container reads the result of the init self-check instead of repeating it, which would need the
capabilities that are gone. It is written only by root on a `/run` that is a tmpfs, with mode 0600 (the three tmpfs of
the hardened container spec make it so), by a temporary file and a rename, so a link planted at the name is replaced
and never followed. The file of an earlier start is removed before the startup runs: a start that fails leaves none.
Not root: no file, and nothing is logged (the default runner is not root and has nothing to hide). A `/run` that is not a tmpfs, or a write that fails: no file, and the reason (`not_on_tmpfs`, `write_failed`) is logged as a warning. The file is
an aid, never a gate.

**`worker-reap`** ends what the engine user still runs. A launcher that kills a Worker from outside ends the group
of the Worker itself, while it still holds the group's leader (never signal a group id that is no longer yours,
`process_group.py`), then runs `worker-reap`: a `kill(-1, SIGKILL)` made as the engine user, the same sweep the Worker
host makes after a Dynamic job. It takes no target (no pid, no group id: the part of the process-group rules that is
a launcher's stays with the launcher), reads the same variables as the Worker, needs the root supervisor and exits
0 (nothing of the engine user runs, or the container has no engine user), 1 (a process survived) or 2 (the sweep could not be made: not root, unusable settings, no `python3`,
`sweep_unavailable`).


**Image.** `runner/Dockerfile` has one target, `sandbox`, the Worker image of the hosted deployment and the only image of
the project: the golden snapshot builds it and every review job runs it in a Vercel Sandbox VM, as `worker-once` or
`probe`, nothing else. It carries no Dispatcher bundle. Since #761 it also carries the toolchain of the Implementer's agent:
git 2.53 or newer (built from its pinned source), Node.js 24, pnpm, Python and uv, `gcc`, `g++`, `make`, `jq` and `unzip`, and
the guard hook with its matrix in `/opt/code-reviewer/guard/` (root-owned, read-only; the image bakes in no `core.hooksPath`,
the Worker sets it per job through `GIT_CONFIG_SYSTEM`). Everything downloaded is pinned and verified (`runner/*-pin.json`,
`scripts/fetch_toolchain.py`). Build:
`docker build -f runner/Dockerfile --target sandbox -t code-reviewer-runner-sandbox .` (`make test-images` builds it and
runs its smoke test).

The sizing of a container (memory per process) is in `docs/spike/cr-13-measurements.md`.

## One job

The job is JSON on stdin (the shape is documented in `src/code_reviewer_runner/job.py`):

| Field | Meaning |
|---|---|
| `prUrl`, `command` | `https://<host>/<owner>/<repo>/pull/<n>` on the host of `git.baseUrl`; `review` (the only command; `/ask`, `/improve` and `/describe` were removed) |
| `args` | legacy field of the removed `/ask`: a previous release may send it; the runner accepts and ignores it and never hands it to PR-Agent |
| `git` | `provider` (`github`), `baseUrl`, `token` (installation token), `botLogin` (`<app slug>[bot]`) |
| `llm` | `provider` (a slug of the provider registry, see "LLM providers"; `openrouter` or `anthropic`), `model`, `apiKey`; optional `baseUrl` (loopback only, for test fakes), `requireParameters` (only with `baseUrl`, for test fakes: see "Required parameters on OpenRouter"), `maxTokens` and `fallbackModels` (see below) |
| `env` | optional options of the PR-Agent tools, as strings; one option per key (`PR_REVIEWER__NUM_MAX_FINDINGS`, never a second `__`). The app sends only `PR_REVIEWER__*`; the removed tools' families (`PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`, `PR_QUESTIONS__*`) are accepted for v1 compatibility and ignored. Nothing else is accepted. See "Settings policy" for how the values are read. |
| `reviewKind`, `dynamic`, `base` | #195: a tagged **Dynamic** job. Absent means a Diff job (the legacy shape). `dynamic` is a closed object `{ model, skill, limits: { maxFindings } }` — model/skill/limits only, the skill is literal data and no field can add a command, a core override, a permission or an endpoint. `base` is `{ repository, baseRef, headSha, previousReviewedSha, comparison }`, the checkout facts; `comparison` is a declared mode, not proof of completeness. `previousReviewedSha` is the head of the last successful review of the same kind (#199), or null; the optional `attemptedShas` (#255) lists the heads of earlier jobs of that pull request that did not succeed (at most 20, distinct; absent means none), and the optional `attemptedShasTruncated` (#257, a boolean the app only sends as `true`) says the list was cut: only then does the publisher rewrite a bot-owned summary whose state head it cannot account for, with a full review (the checkout is full too; earlier findings are not carried over, the summary says so in a one-shot notice and the result log carries `state_reset_attempted_shas_truncated`). The skill is untrusted project data, bounded to 16 KiB of UTF-8 bytes; the runner composes it after its own fixed core (see "Dynamic Review prompts"). |

Checkout preparation (#196) is available through the root-supervised
`dynamic_review.export_isolation.prepared_checkout` lifetime: bounded exact-head acquisition,
sanitized endpoint evidence, exclusive job identities and an actual-uid verified read-only export.
The base-to-head diff is against the merge base of the head and the base ref (a missing merge base
declares a full review of the head); a changed binary, oversized, denied or unsafe file is excluded
and reported as `skipped` (`binary`, `too_large`, `engine_discovery`, `credential_path`,
`unsafe_mode`) instead of failing the run (#296). The documents of a repository skill in
`.claude/skills`, `.agents/skills` or `.opencode/skill(s)` are exported with a rewritten manifest
(#701, `repo_skills.py`). Oversized blobs are never downloaded (a
`filter blob:limit` on the commit want). Every failure carries a stable `CheckoutReason`. It is an integration seam for #197; it does not launch an engine or enable the
capability/gate. The Worker is the root supervisor in the hardened container (#202).
Details, hard bounds, the v1.19.0 discovery deny-list and cleanup obligations:
[Dynamic checkout](../docs/dynamic-checkout.md).

A Dynamic job is never run by PR-Agent. `main` dispatches on `reviewKind` before the process
environment is touched or a process starts: an absent or `diff` kind keeps the PR-Agent path, and a
`dynamic` kind goes to the stock engine (#197, see "Dynamic Review engine"). A Dynamic job without a
configured engine, without a prepared checkout or with an unusable model capability descriptor is
refused with its stable code; the runner never falls back to PR-Agent or to Diff Review. A Diff job is
unchanged. An unknown kind, a Dynamic job without its `dynamic`/`base` fields, or a Diff job that
carries Dynamic options is an `invalid_job`.

`llm.maxTokens` (integer, 1000 to 10,000,000) is the context window the runner gives PR-Agent (the app decides it for every job since #689, from the context window of the model; no setting names it). It
sets `config.custom_model_max_tokens` (used for a model PR-Agent does not know) and
`config.max_model_tokens` (the upper bound PR-Agent applies to every model, default 32,000), both
to the same value; without `maxTokens` PR-Agent's own values stay. The value also applies to the
fallback models PR-Agent does not know, so use the smallest window of the models in the chain.

`llm.fallbackModels` (optional list of at most five model names, same characters as `model`, no
repeats, none equal to `model`) is the chain PR-Agent tries, in order, when the model fails. Every
entry gets the `openrouter/` prefix like `model`. Without the field there is no fallback: PR-Agent's
own default fallback model belongs to another vendor and is never used. An entry that is not a valid
model name, a list that is too long or one with a repeat is an `invalid_job`. A review that needed
a fallback model reports `usage.fallbackUsed`.

The result is exactly one line of JSON on stdout: `ok`, `durationMs`, `commentUrl` (or `null`),
`errorCode` (or `null`), `logTail` (redacted, at most 4 KB), `logTruncated` (true if the runner's log sink, which sees PR-Agent's records at INFO and above,
held more than the tail shows; output on stdout and stderr is not counted) and `usage` (model, tokens, cost).
A failed result carries `usage` too, when the run made at least one model call before it failed (a timeout at
the end, an answer the validator refuses, a publish error, a lost lease, an error nobody expected); a run that
failed before its first model call reports `null`. The cost follows the rule of a successful run: exact, or
`null` when any call was unpriced (the token counters are reported either way), never zero for an unknown
cost. A Dynamic run reads its ledger (`usage_probe.py`, also from the watchdog that ends a run that does not
stop); a Diff run reports the tokens PR-Agent measured and the cost its meter measured ("Cost of a Diff run",
below). Some ends report no usage although the model may have been
used; the app then counts the run with an unknown cost (`settled`, reason `no_result`, `src/usage/README.md`)
and never as void:
- the Diff watchdog ends a command that blocks the event loop (`timeout`, `errorReason`
  `no_result_from_process`) while the meter says a request was sent that the provider did not certainly
  refuse (PR-Agent's own counters live in the blocked loop; the meter is lock guarded and safe to read from the
  watchdog's thread, #363);
- a Diff command fails (it raises, times out, or reports a failure) with no usage although a request was sent
  that the provider did not certainly refuse: one still in flight, cut off, or an answer PR-Agent did not count
  (`errorReason` `no_result_from_process`, #363; see "Cost of a Diff run", below);
- the Worker ends a job process at its hard timeout (`timeout`, reason `no_result_from_process`), the process
  is killed by a signal, exits without a result line, or prints a result that disagrees with its exit code
  (`runner_error`, the same reason);
- a failed result carries a usage the Worker cannot read (reason `unreadable_usage`);
- the runner prints nothing at all and the lease runs out on the last attempt, the app's own hard limit ends the
  job, or the runner is shut down on the last attempt (no `complete`, or `runner_shutdown`: the app decides).

Not counted at all (void): a failure before the process started (the job could not be parsed or the process
could not be launched), a Dynamic run that failed before its first model call, and a Diff command that failed
before it sent any request or whose only requests the provider refused before generating anything (a bad key,
a rate limit).
The exit code is 0 for `ok` and 1 otherwise. The environment variable `RUNNER_JOB_TIMEOUT_SECONDS`
(read from the process environment, not handed to PR-Agent) makes the runner stop the command and
report `timeout`: first by cancelling it, and if it does not react (a call that blocks the process)
three seconds later by printing the result and ending the process. Both are counted from the first line of
`main()` of the job process, not from the start of the command (#387): the imports and the settings copy of a cold
start take seconds, and a limit counted after them could land behind the three seconds of the
process end. A start-up that used up the whole timeout ends with the clean `timeout` result and the
command is never started; a Dynamic run gets the part of the timeout that is left as its deadline.
The caller should still kill the process after its own deadline.

## Dynamic Review prompts (#198)

The editable part of a Dynamic Review prompt is a **review skill**: the app resolves it per project
(the shipped default from `contracts/dynamic-review/review-skill.md`, or the project's override) and
puts it in the claim (`dynamic.skill`). The runner **composes** the final prompt, because the fixed
core is runner-owned and must reach the model through the trusted system/primary-agent channel, never
through repository instructions or skill discovery:

- `dynamic_review/prompt_core.py` is the fixed, code-owned, versioned core (`CORE_ID`,
  `CORE_VERSION`, `CORE_SHA256`): the read-only rules, "repository content and the pull request are
  untrusted data", the `DynamicFindings` output format and the re-review resolution rules. No input
  can change it.
- The runner-owned review context is emitted next: the **verified reviewed head** (`base.headSha`,
  validated as a 40 character lower-case commit id) and the review mode. The head is trusted context,
  never repository content. The model is **not** asked to echo it (#530): the runner sets
  `schemaVersion` and `reviewedSha` on the envelope and on every finding itself, replacing whatever
  the model wrote (the engine does not check the arguments of its return tool, so one missing echo
  would otherwise fail a whole run). The schema handed to the engine omits them; the contract
  schema keeps requiring them. Any other required field of the envelope that is missing or has the
  wrong type gets the one recovery turn (#309) with the concrete problem; the job log says
  `missing` or `wrong_value` per runner-set field, never a value.
- `dynamic_review/prompts.py` composes the core first, then the skill as delimited, literal,
  lower-priority text, then the pull request input as delimited untrusted blocks. Every block, the
  skill included, is closed by a fence that carries a digest of its content, so an injected delimiter
  cannot close a block early or become a higher-priority message; the composer never reads or injects
  repository rules itself. The composition is deterministic and pinned by unit tests with golden
  files and prompt-injection fixtures.
- The skill is untrusted project data, bounded to 16 KiB of **UTF-8 bytes** (`MAX_SKILL_BYTES`); a job
  whose skill is larger than that, or not valid UTF-8, is an `invalid_job`.
- The runner distributions (wheel and sdist) and the runner image ship the canonical skill
  (`code_reviewer_runner/dynamic_review/review-skill.md`) and the three license notices
  (`code_reviewer_runner/licenses/`), so a packaged install carries its own attribution. Unit tests
  keep the packaged copies byte-identical to their canonical sources; an integration test builds the
  distributions offline and asserts the payload.

The engine that runs the model with this prompt is #197's; #198 ships the assets, the composition and
their validation.

## Dynamic Review engine (#197)

One stock `anomalyco/opencode` headless server per job, driven over the pinned local HTTP API. The
runner never patches the engine, never installs a plugin and never reads its internals; it hardens the
input and the boundaries around it (the epic's binding decision). Modules:

- `dynamic_review/config.py` generates the trusted engine config and the closed environment: a
  default-deny `permission` block that allows only `read` (which also supplies directory listing in
  this pin), `grep`, `glob`, the `skill` loader for repository skills (#701) and the non-filesystem
  `StructuredOutput`, one loopback provider (the
  proxy) and the discovery/runtime services switched off. The fixed core (#198) is the runner-defined
  `review` agent's prompt, so it reaches the model through the trusted channel. The flags are defence
  in depth, not a security boundary: #196 strips the discovery inputs from the export.
- `dynamic_review/budget.py` holds the limits and the ledger shared by the proxy and the adapter. The
  one budget is an operator cost limit in USD (#290: default 1.00, `RUNNER_DYNAMIC_MAX_COST_USD`, a
  ceiling of 20 in the code), narrowed by the project's own limit when the job carries one (#666, `effective_cost_limit`); the technical limits stay (600 s, 64 KiB per result, 4 MiB cumulative
  content, the byte caps). Every call is reserved before it is sent (the cost it is expected to have from
  what the run showed: cached prefix, observed output, #540), every tool
  part is counted, and a missing or oversized answer fails closed; a call without `usage.cost` ends
  the run. A normal call is admitted only when its expected cost fits; the final call (wrap-up,
  recovery, retries) is admitted whenever the spend is within the limit, and a normal call that
  settles over the limit ends the agent phase instead of failing the run, so the cost guard never
  ends a run without a review. The settled total is at most the limit plus the excess of the last
  normal call plus the final call's cost (`usage.limitExceededBy` reports it; `docs/dynamic-review.md`, "The bound").
  The input estimate is bytes over 3, tightened by the previous call's real density, and the
  model's window (from its capability descriptor, never the Diff `llm.maxTokens`) is a backstop in
  front of the provider's own limit. Details: `docs/dynamic-review.md`, "Hard limits". Near the cost
  or time limit the ledger makes one call the *final call* (#293): `dynamic_review/wrap_up.py`
  reduces that request to the return tool alone, required, with a runner instruction last; the
  review is published with a notice and the result's `usage.stoppedEarly` says why. A turn that
  ends with no structured answer while nothing is used up gets one recovery turn (#309): the
  ledger's `begin_recovery` arms it, the proxy makes its first call the final call with the
  recovery instruction, and the result log (not the comment) says it was recovered.
- `dynamic_review/proxy.py` is the per-job model proxy on loopback. It holds the workspace credential.
  Every request must carry the job's random capability (256 bit, generated by the runner per job and
  handed to the engine only through the trusted config) as a bearer token, compared in constant time;
  anything else is refused with 401 before the upstream is touched, the capability is never forwarded
  and the workspace key is never accepted from the caller, so another process or job on the host
  cannot spend the credential. It forwards only `POST <base>/chat/completions` (and answers
  `GET <base>/models` from the trusted config), refuses every other path and query, builds the
  upstream body from an allowlist of fields (model, destination and output bound come from trusted
  config; a request that names a route or endpoint is refused), never follows an upstream redirect
  (any 3xx fails closed after the one request to the configured URL), reads at most the response bound
  plus one byte, checks the protocol byte bounds both ways, validates the destination's required
  features and takes usage from the provider as authoritative. `steps` and events are never trusted
  for enforcement.
  The upstream call honours the operator's `HTTP(S)_PROXY` / `NO_PROXY` (the https upstream goes
  through a CONNECT tunnel, so a proxy sees the destination but not the key; an operator proxy that
  terminates TLS with its own CA could read the key, which is the operator's trust decision, as for
  the static PR-Agent path). A transient provider or transport failure ends the Dynamic run at the
  first recorded cause even if the engine would have retried successfully (fail-closed, each retry
  is a paid call), the same as a provider 429/5xx.
- `dynamic_review/audit.py` enforces the tool, file and result-byte bounds **at the proxy**, from the
  model requests themselves: every request carries the whole history, so the tool calls of a provider
  answer are counted before the engine gets the answer (the call over the bound is never handed over,
  so it never runs), and the tool results in the next request are checked against the per-result and
  cumulative byte bounds and the distinct-file bound before the request is forwarded (the content over
  a bound reaches neither the provider nor the model). Each call and result is audited once by its
  call id. Files are counted from the pinned shapes of `read` (the file, not a directory listing),
  `grep` (every file it lists) and `glob`. The engine's session list is never read.
- `dynamic_review/reminders.py` (#232) neutralises `<system-reminder>` text in tool results in the
  same pass, before anything is counted or forwarded. The stock engine appends the text of nearby
  `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` files to a `read` result in such a wrapper (uncapped, and its
  own prompt tells the model the tag is system-added): the wrapper is **dropped** and replaced by a
  short notice, the files stay readable by an explicit `read`. Any other tag text (a file or a grep
  line that contains it) is escaped (`<` becomes `&lt;`), so no `<system-reminder>` tag reaches the
  provider in a tool result. The bounds and the token reservation count the forwarded text.
- `dynamic_review/tagescape.py` (#243) is the escape itself. It matches on a normalised copy of the
  text and rewrites **only the opening bracket** of a match to `&lt;`; everything else stays byte for
  byte. It is linear-time (one `str.translate`, one character-class `sub`, and a match that scans only
  its own bracket's single run of whitespace and slashes or its own name of at most 64 characters;
  the possessive quantifier is a guard, not what keeps it linear; every pattern has a
  50,000-character regression test) and idempotent. It is a bounded
  small filter on purpose, not a list of every wrapper a model might respect: the one tag the
  engine's own prompt blesses, plus closed chat-template control tokens.

  | Spelling | Handled | Why |
  |---|---|---|
  | `<system-reminder>`, `</system-reminder>`, case, whitespace or slashes after `<` | escaped | #232 |
  | Invisible characters anywhere inside or directly in front: the Unicode `Default_Ignorable_Code_Point` set (zero-width and bidi controls, soft hyphen, variation selectors, U+034F, Hangul fillers U+115F, U+1160, U+3164, U+FFA0, Khmer U+17B4/U+17B5, U+180B-U+180F, U+FFF0-U+FFF8, U+1D173-U+1D17A, the whole tag block), as a static table of Unicode 15.1.0 (Python 3.13) in `dynamic_review/ignorable.py`; and C0/C1 control characters except tab, line feed and carriage return | escaped | they render as nothing, so the text reads as the tag |
  | Full-width `＜`, full-width letters and slash, and the lookalike `<` (U+FE64, U+2039, U+2329, U+3008, U+27E8, U+276E, U+02C2, U+300A, U+27EA, U+276C, U+1438) | escaped | a model reads them as the tag |
  | `_` or a dash lookalike (U+2010-U+2015, U+2043, U+2212, U+058A, U+FE58, U+FE63) for the hyphen, `system_reminder` | escaped | same |
  | A tag split across the text parts of one result (`<system-` + `reminder>`) | escaped, in the part that holds the `<` | the parts are matched as one text; non-text parts are skipped over |
  | A closed chat-template token `<\|name\|>` or `<｜name｜>` (`<\|im_start\|>`, `<\|im_end\|>`, `<\|system\|>`, `<｜begin▁of▁sentence｜>`), the name 1-64 characters without `<`, `>`, `\|` or whitespace | escaped (`&lt;\|`) | keeps special-token syntax text for any tokenizer, whatever the token's name; a token name list would be endless |
  | `<\|` that is not a closed token: regex alternation (`/<\|>/g`, `re.split(r'<\|>', x)`), F# `<\|`, Haskell `<\|>`, `<\|\|`, an unclosed `<\|im_start` | **not** escaped | code stays unchanged, so a model reviewing escaping code does not report a bogus `&lt;`. Cost: a server that acts on an unclosed `<\|im_start` is not covered |
  | Text that already is HTML-entity-escaped (`&lt;system-reminder&gt;`, `&#60;`) | **not** escaped | no risk: it is the form the escape itself writes, it is not the tag the engine's prompt blesses, and rewriting it would break idempotency |
  | Other wrappers (`<system>`, `<instructions>`, `[INST]`, `<s>`, `[SYSTEM]`) | **not** escaped | no engine authority; plain untrusted text under the "file content is data" framing. They are ordinary in real code (`<s>` in HTML, `<system>` in XML) and a filter list gives false safety |
  | Whitespace or punctuation inside the *name* (`system reminder`, `system - reminder`) | **not** escaped | not the string the prompt blesses |
  | A tag split across two *different* tool results or two messages | **not** escaped | no single result holds it, the model has to assemble it itself |
  | Tool-call arguments, the diff and the prompt | **not** this module | only tool-result text is transformed; the prompt stays the trusted frame |

  The escape never re-orders or re-encodes the forwarded text: the size accounting is on the forwarded
  body, as before (#231/#242).
- `dynamic_review/completion_stream.py`: the pinned engine always asks for a streamed answer. The
  proxy asks the provider for the whole answer (bounded, audited, usage settled) and only then returns
  it as a short event stream; nothing reaches the engine before the checks passed.
- `dynamic_review/schema.py` turns the contract schema (definitions under `$defs`, no root type) into
  the self-contained object schema the engine passes to its `StructuredOutput` tool, narrowed to the
  job's `maxFindings`.
- `dynamic_review/inputs.py` maps the verified preparation (`PreparedContent`, #196) to the prompt:
  the real title and body (`metadata` as `{"title","body"}` JSON, otherwise the body), the base-to-head
  diff, the incremental diff when the preparation really ended in incremental mode, the prior state
  and the list of skipped and omitted paths.
- `dynamic_review/pr_context.py` (#201) is where the title, body and prior state come from: the
  production preparer reads the job's own pull request with the job's token (title and body) and the
  active findings of the bot-owned persisted summary of that pull request (the publisher's own
  selection, validation and head accounting), inside the preparation after the isolation checks.
  Both are untrusted data: their `<system-reminder>` and chat-template framing is escaped like tool
  results (#232/#243), then they are capped in bytes (title 1 KiB, body 16 KiB, prior state 16 KiB,
  a cut says so; escaped first, so the cap bounds the final size and a cut cannot leave half of a
  tag), then redacted and counted by the preparation and shown only in the fenced data blocks of
  the user prompt. A finding id that the escape would change is refused by the findings parser, so
  every id in the prior state can be named back in `resolvedIds`. A corrupt or unaccountable state,
  a GitHub failure or a read that takes longer than its own 60 s deadline (all requests together,
  at most 10 s each) ends the job with its stable code (`git_unavailable` for the deadline); an
  empty state is never substituted.
- `dynamic_review/adapter.py` starts the engine in its own process group on a private loopback port
  (no verified ripgrep file, leading the engine `PATH`, is a refusal, because the pinned release would download one),
  waits for a healthy pinned server (short per-request timeouts: before its listening marker the server
  can accept a connection and never answer), opens one session, sends the untrusted input as one
  structured turn (bounded by the input byte limit) and validates the answer with the typed findings
  parser, bounded by the job's `maxFindings`, against the files the export really holds (a finding
  outside it is dropped and counted as `finding_path_not_exported`, not an error). While the message runs, a watch ends the run the moment the
  proxy records a limit, a provider refusal or a transport failure to the provider (timeout →
  `llm_timeout` with a 504, refused or reset connection → `llm_unavailable` with a 502; the
  reservation stays spent; the stable code of the first cause is the result, also if the engine
  still produced an answer), the whole-job deadline passes or the engine dies. The
  reviewed head comes from the validated claim (`base.headSha`), never from repository content. On any
  limit, engine exit or unusable answer the whole process group is killed and the private scratch
  removed. A group is only ever signalled while its leader is still unreaped (`process_group.py`: the
  exit is observed with `waitid(WNOWAIT)`, the group is ended, the leader is reaped last), so a reused
  group id can never be signalled (#202, ADR 0002); `shutdown_engines()` is also called by the entry point's
  watchdog so a timed-out run leaks nothing.

`run_dynamic_job` takes the sanitized export from a `prepare` seam (a context manager yielding
`PreparedContent`): the supervisor that owns the privileges supplies it (#196 `prepared_checkout`, with
the dedicated engine user of part 2b); without one the run ends with `checkout_incomplete`.

The pinned executable: `opencode-pin.json` names the exact release (version, tag, source commit),
and per platform the asset, archive size and SHA-256 and the executable's SHA-256. `scripts/fetch_opencode.py`
downloads it only over https, accepts it only when size and digest equal the pin, unpacks exactly one
regular file and checks that it reports the pinned version; nothing at run time downloads anything.
The `dynamic` target of `Dockerfile` calls the same pin in its own stage and installs the verified
file at `/usr/local/bin/opencode`; `ripgrep-pin.json` and `scripts/fetch_ripgrep.py` do the same for
`rg`, which the engine's grep and glob need. `make test-engine` and the engine CI job fetch the engine
the same way.

The answer's schema is the packaged copy of `contracts/dynamic-review/schema.v1.json`
(`dynamic_review/findings-schema.v1.json`), sent as the engine's `format`, and validated again by
`parse_dynamic_findings`. Publication of the findings is #199 (below). The isolation (dedicated uid and the
static network boundary) is part 2b of #197; whether a runner advertises `opencode` is decided once at
start by the self-check above, and only the Worker image run with the flags of the hardened container spec can pass.
The runner does not rely on the app alone: `run_dynamic_job` refuses a Dynamic job with
`dynamic_engine_unavailable` unless the Worker handed this job process `opencode` among the advertised
engines.

What the real-binary engine suite (`tests/engine/test_engine_opencode.py`) proves today, with the
unmodified pinned release behind the real proxy: a hostile repository (plugins in `.opencode/` and
named by an `opencode.json`, nested config, agents, commands, tools, skills, AGENTS.md, instruction
files) goes through the real #196 export and nothing of it is loaded or executed, while the same tree
unsanitized does execute its plugins (the control); every write, shell, network, task and unknown tool
and every read outside the export is denied; the bounds above stop a run before the content reaches
the model; a provider refusal and a hung provider end the run with their stable code; and the engine
completes with the pinned server's message-list defect in place. It runs as the test user without a
per-job network namespace: the dedicated uid and the proxy-only network proof are not in it yet.

## Dynamic Review publication and re-review (#199)

A Dynamic Review writes **one** persistent summary comment (never inline comments, labels or a
second status comment) and reconciles each run with the earlier ones:

- `dynamic_review/state.py` is the persistent state (active findings, resolved history, reviewed
  head), stored as a base64 marker in the comment and validated like model output: an unknown
  version, an unknown field or a traversal path fails closed with `dynamic_policy_violation`, never
  an empty state that forgets history. Each active finding is checked against the head it was
  raised at (a carried-over finding keeps it). `encode_state` enforces exactly the decoder's caps
  (30 active findings, 500 resolved, 48,000 characters) and re-parses its own output, so what is
  written can always be read back; `fit_state` makes a larger state fit, deterministically: the
  oldest resolved history goes first (no visible note; a trimmed id can only re-open as a new
  finding), then the lowest priority and, within a priority, oldest active findings. Those are
  counted in `omittedFindings` for the current write and shown as "N further findings not shown"
  (cleared when a later write fits); they are never marked resolved. `render_previous_state` is the
  bounded text handed to the model so it can keep ids stable and name resolved ids.
- `dynamic_review/reconcile.py` applies the fixed core's rules to untrusted model output: a finding
  is resolved only when the run names its id (`resolvedIds`), an omitted or unreadable previous
  finding stays active (no resolution by absence), a moved or rephrased finding keeps its id, a
  duplicate is folded, a regression is re-opened, and the resolved history is retained without a cap.
- `dynamic_review/render.py` renders the reader's view (P0–P3 and confidence, a commit-pinned link,
  bounded evidence) with HTML escaping and neutralised mentions, under two independent bounds
  (65,000 characters and 64 KiB of UTF-8). The state is fitted first (see above), so the comment
  stays updatable; a view that cannot fit fails with `review_text_truncated` and the previous
  comment is kept.
- `dynamic_review/github.py` is the narrow client: page the pull request's comments, create one,
  edit one — nothing else. `dynamic_review/publish.py` selects the bot-owned summary by its exact
  hidden identity marker **and** author (the bot login, a `Bot` account and, when GitHub names the
  app, its slug; the claim has no app id, so an id comparison is a follow-up), refuses a stale
  result (a head other than the job's own, its `previousReviewedSha` or one of the app's
  `attemptedShas` (#255: earlier unsuccessful jobs, which may have published before they failed) is
  refused with `review_not_published` and left as it is), redacts the job's secrets from the
  findings before storing them, and re-reads after an ambiguous create or edit instead of
  duplicating a comment or failing a write that landed.

The app supplies `base.previousReviewedSha` from the last successful review of the same kind
(`jobs.previousReviewedSha`), so the checkout and the publisher compare against the head the earlier
review actually saw. The engine that produces the findings is #197's (above); #199 owns the publication.

## Where the result comes from

`PRAgent.handle_request` only returns `True` or `False`, and `True` also happens when nothing was
posted (or when a tool swallowed its own error). So the result does not come from its return value
(decision of CR-12, see `docs/spike/cr-12-run-result.md`). It is assembled from what the runner
observes while the command runs:

- `commentUrl`: the comment recorder wraps the two write paths of PR-Agent's GitHub provider
  (`publish_comment`, `edit_comment`) and picks the review comment
  by its hidden marker only: the marker must be an exact line within the first five lines of the
  comment (or its link-reference form), as PR-Agent itself checks it. The visible heading does not
  count: it is configurable, and the "Standalone PR Review" comment that PR-Agent posts when it
  cannot verify its identity keeps the heading but drops the marker. An edited comment counts, which
  is what a second review does. No GitHub call is made to look the comment up afterwards.
- `ok` and `errorCode`: false if `handle_request` returned `False` or raised, if the tool marked the
  command as failed, or if it posted a "Failed to ..." comment. The code is derived from the
  exception PR-Agent logged (the runner's own log sink reads it off the record), never from text.
- `logTail`: the runner's own redacting sink, newest lines, warnings and errors first, at most 4 KB,
  escape sequences removed, control characters turned into spaces, then redacted.

A review that PR-Agent shortened to fit GitHub's comment limit is a failure too, even though a
comment is on the pull request: see "The review comment size limit" below. Such a result keeps its
`commentUrl` when the comment can be found.

When there is no comment link: `review` reports `ok: false` with `review_not_published` (a review
that posted nothing, or only a standalone comment, is a failure the caller must see). No other
command exists to report otherwise.

## Error codes

Defined once, in `ErrorCode` (`src/code_reviewer_runner/result.py`); a test checks that this list
and the enum agree. Callers branch on the code, never on the text.

| Code | Meaning |
|---|---|
| `invalid_job` | The job is not valid JSON or a field is missing, malformed or not allowed |
| `invalid_command` | The command is not `review` |
| `pr_agent_version_mismatch` | The installed PR-Agent is not the version the runner was written for |
| `identity_patch_failed` | The method the identity patch replaces is missing or has changed |
| `runner_error` | A failure inside the runner itself (also reported by the Worker for a process that ended without a result). For an implementer job (#764) it is what an engine that died or a bound that ended the turn is **before** any model call; after one it is `agent_gave_up` |
| `command_failed` | PR-Agent reported a failure it handled itself (failure comment, failed flag) and nothing more specific is known |
| `review_not_published` | `review` returned normally but no review comment was recorded (for example an identity problem) |
| `review_state_truncated` | `review` hit GitHub's comment size limit and PR-Agent's hidden record of findings no longer fits: it is not advanced any more, so findings are forgotten (the review is posted with the old record, or as a standalone copy). `commentUrl` is set when the review comment can be found |
| `review_text_truncated` | `review` hit GitHub's comment size limit and part of the visible review was cut off; the record of findings still fits. `commentUrl` is set when the review comment can be found |
| `pr_not_found` | GitHub answered 404 for the pull request |
| `git_auth` | GitHub rejected the token (401) |
| `git_forbidden` | GitHub refused the request (403) |
| `git_rate_limit` | GitHub rate limit (429, or 403 with a rate limit message) |
| `git_unavailable` | GitHub could not be reached, timed out or answered 5xx |
| `git_unprocessable` | GitHub answered 422 |
| `git_provider_init` | PR-Agent could not create its GitHub client and no cause is known |
| `llm_auth` | The LLM provider rejected the key (401, 403). Called `llm_auth_failed` in some planning notes; this is the same thing. In a Dynamic Review the engine sees HTTP 403 both for this and for a budget refusal; the cause of the job is the code the ledger recorded, not the engine's HTTP status |
| `llm_quota` | The LLM account has no credit left (402) |
| `llm_rate_limit` | The LLM provider rate limit (429) |
| `llm_timeout` | The LLM provider did not answer in time |
| `llm_unavailable` | The LLM provider could not be reached or answered 5xx |
| `llm_bad_request` | The LLM provider refused the request (400, 422) |
| `llm_context_length_exceeded` | A Dynamic Review request was larger than the model's context window (the provider said so, #290) |
| `llm_output_invalid` | The model answered, but its answer could not be turned into a review |
| `model_unknown` | PR-Agent does not know the model (set `llm.maxTokens`) or the provider has no such model |
| `llm_parameters_unsupported` | The provider answered 404 that no endpoint can handle the requested parameters (OpenRouter after `provider.require_parameters`, #270): the model exists, but not for this request. Before #477 this was `model_unknown`. The runner no longer sends `temperature` to the Claude (4.7 on) and GPT-6 models that do not take it (`temperature_patch.py`) |
| `dynamic_engine_unavailable` | A Dynamic Review job arrived but no engine is available to run it; the runner never falls back to PR-Agent |
| `dynamic_isolation_self_check_failed` | The Dynamic engine's startup self-check did not prove the dedicated user, read-only export and proxy-only egress, so the engine is not advertised or launched |
| `dynamic_config_invalid` | The Dynamic options of a job are missing or unusable (model, skill or limits) |
| `checkout_incomplete` | The checkout for a Dynamic Review could not be prepared completely. The result carries a stable `errorReason` (a `CheckoutReason`, listed in `contracts/runner-api.v1.json` as `KnownCheckoutReason`), the log tail starts with `checkout_incomplete [<reason>]` and the runner's `finished:` line names it |
| `dynamic_policy_violation` | The Dynamic Review would have broken a hard policy (a tool, a path or an output rule) and was stopped |
| `dynamic_budget_exceeded` | The Dynamic Review used more than its allowed budget |
| `cost_limit_reached` | A Diff Review sent no further model request because what its calls cost had reached the cost limit of its project (#666, `llm.maxCostUsd`); usage and cost are reported as usual |
| `dynamic_accounting_failed` | The Dynamic Review's model usage could not be established or accounted for (an answer without usage, or a call the provider's price list cannot price, #511) |
| `dynamic_model_features_unsupported` | The configured model does not support the tool calling or structured output Dynamic Review requires (a forced tool choice, #511), or OpenRouter found no provider that supports every parameter of a request (404, #270); there is no fallback model or provider |
| `lease_lost` | A Dynamic job was no longer held by this runner (lease lost, job cancelled) or could not be confirmed as held right before it would have written its summary; nothing was written (#260) |
| `superseded` | A newer push replaced this run while it was running (#396): it finished the model requests in flight, sent no more, published nothing and reports what it used. Not a failure of the job ("A superseded run", below) |
| `branch_exists` | An implementer job (#746): the branch the turn should create is already on the remote; nothing was changed |
| `base_branch_not_found` | An implementer job (#746): the base branch the turn should start from does not exist on the remote |
| `clone_failed` | An implementer job (#746): the repository could not be cloned |
| `setup_failed` | An implementer job (#746): the repository's own set-up steps did not complete |
| `agent_gave_up` | An implementer job (#746): the agent ended without a result it stands behind. Also (#764) a turn whose engine died, or that a bound of the audit ended, **after** the model was called: the turn cost money, so it is this charged code and not the free `runner_error`; commits made before are pushed and reported |
| `push_rejected` | An implementer job (#746): the remote refused the push of the branch, or (#764) did not take the final push after the loop's retries (a 5xx, a reset); a transient failure on the way is retried, not reported |
| `branch_violation` | An implementer job (#746): the work left the branch it was given, so it was stopped and nothing was pushed |
| `time_limit_reached` | An implementer job (#746): the turn ran into its time limit (`implementer.limits.timeLimitSeconds`) |
| `git_write_not_granted` | An implementer job (#746): the token cannot write the contents of the repository |
| `implementer_engine_unavailable` | An implementer job (#746) arrived at a runner with no engine for it (this release has none); it is never run as a Diff or Dynamic job |
| `implementer_config_invalid` | An implementer job (#746): the options of the turn cannot be used |
| `timeout` | The command did not finish within `RUNNER_JOB_TIMEOUT_SECONDS` (also reported by the Worker for a process it had to end) |
| `unknown` | Something failed that no rule recognises |

## A superseded run (#396)

When a new push arrives while an automatic review is running, the app supersedes the running one. A runner or
Worker that names the claim feature `supersede` (`CLAIM_FEATURES`, `WORKER_FEATURES`) is told through its
heartbeat: `job.superseded: true`. The job host then sends the job process `SIGUSR1`, once, to the leader only and
at once (see "The signal" below), keeps beating, and waits for the process to end by itself. The process
(`supersede.py`):

- **lets every model request in flight finish**, so its cost is measured: the Diff meter (`diff_cost.py`) and the
  Dynamic ledger count it as they always do. The Dynamic path also keeps its model proxy up until those requests are
  answered (`ProxyServer.stop(drain_seconds)`), and its watch ends the engine's turn at the signal instead of waiting
  for the next request;
- **refuses every further model request**: the Diff meter raises `SupersededError` before anything is sent, and the
  Dynamic model proxy answers `403` with the code `superseded` (the engine ends; there is no retry);
- **publishes nothing**: every write of PR-Agent's GitHub provider is a no-op from then on (`install_write_guard`,
  installed last so it is outermost: comments, edits, labels, reactions, check runs and the "Failed to ..." notices;
  `test_supersede_guard_complete.py` reads the provider and fails for a write method nobody guarded). The Dynamic path
  checks before its summary, its finding reconciliation and the note of a failure, **and once more right before the one
  write** (`Publisher.may_write`), and the lease check answers `superseded`;
- **ends `superseded`** with the usage it measured (an exact cost when every call was priced, unknown otherwise). A
  run that had published before it heard of it keeps its success. Whatever ended the run after the signal (a failure
  note that found the run replaced, a crash, a kill), the result carries the code `superseded`, not the failure it
  would have been.

The host delivers that result (the same call as any result), ends `SUPERSEDED`, the Worker exits `0` and the Sandbox
or container is torn down. A Worker of an earlier
release never names the feature, so the app never supersedes its jobs and nothing changes for it.

### How long it takes (the drain model)

```
push --(next heartbeat, at most 60 s)--> the host knows and tells the process
     --(the requests in flight finish, each within 120 s)--> the result is reported
```

The numbers are in one place on each side (`supersede_timing.py` here, `app/src/db/supersede-timing.ts` in the app)
and in the contract (`SupersedeTiming` in `contracts/runner-api.v1.json`); a test on each side holds them equal. The
app keeps the claim for 240 s (a heartbeat, the longest model request, a margin), so a result reported inside the
drain always arrives while the claim holds. The host waits for the process at most `SUPERSEDED_DRAIN_SECONDS` (120,
the longest model request: PR-Agent's `ai_timeout` and the proxy's timeout), but ends it `KILL_MARGIN_SECONDS` (20)
before the lease that the heartbeat answer named (`job.leaseExpiresAt`: for a superseded run the app sets it once, at
the push, to the end of the claim, 240 s later, and heartbeats do not extend it), so the result is reported inside the lease even when the push came late in the claim. A process that
is still running then is ended by the host (its group, SIGTERM then SIGKILL) and its result is `superseded` with an
unknown cost (`no_result_from_process`).

### The signal

The host starts the job process with `SIGUSR1` **blocked** (the mask is set around `Popen` in the host's thread and
restored at once; it survives the `exec`). A signal that arrives before the process has installed its handler stays
pending instead of ending the process, and `handling_the_signal` unblocks it after the handler exists. So the host does
not guess an age for the process, and the signal is sent at the first superseded answer. If the signal cannot be sent
(the process is gone), the host logs `SUPERSEDE_SIGNAL_NOT_SENT` and the drain bound still ends the process. The
handler only sets a plain flag (`SupersedeSignal`), never a lock: an `Event` could deadlock a thread that held it when
the signal came.

### What "publishes nothing" can promise

It is best effort at the last step. The Dynamic path re-checks right before the one GitHub call it makes, but the check
and the call are not one atomic step: a signal that arrives in between does not stop that call, and a request that was
already sent to GitHub cannot be taken back. The window is the length of one request to GitHub (milliseconds), against
a run of minutes, and the next review replaces the summary. The Diff path is guarded at the provider method, which is
the same window per write.

## The review comment size limit

PR-Agent keeps one persistent review comment per pull request and hides a record of every finding it
has seen in it (`<!-- pr-agent-review-state ... -->`), so that a later run recognises earlier findings.
GitHub accepts at most 65,536 characters per comment (PR-Agent cuts at 65,000). The record grows with
every run, and in a long-lived pull request it fills the comment. PR-Agent 0.47.0 then keeps going
without failing: it cuts the visible review to make room for the record (no log line), or, when the
record alone does not fit, logs "Persistent review state did not fit the provider comment limit",
stops advancing the record and posts the old record or a "Standalone PR Review" without a marker.

The runner turns this into a result instead of a success (`review_state_watch.py` wraps the one
function that shortens the comment, `comment_recorder.py` notes a body that was longer than the
provider takes):

| What happened | Code | `commentUrl` |
|---|---|---|
| The record did not fit (also when a standalone copy was posted) | `review_state_truncated` | the review comment if it carries the marker, else `null` |
| The visible review was cut so the record fits, or the provider cut the comment | `review_text_truncated` | the review comment if it carries the marker |

Only `review` is checked. A failure comment or a failure of the command takes precedence.

**Bounding the record: not done.** The data of the CR-48 comparison and PR-Agent's code (pinned by `tests/unit/test_review_state_growth.py`) show why it is not safe
as a runner-side change. PR-Agent keeps at most 20 resolved findings (`DEFAULT_MAX_RESOLVED_FINDINGS`,
a default argument of `reconcile_review_findings`, not a setting) but every active finding without
limit, and in the CR-48 comparison all of the 93 records of the full comment were active (about 690
characters each, the record and the visible review list the same text). Dropping active findings would
make the next run treat them as new (the loss CR-11 recognition is meant to prevent) and needs a second
private PR-Agent function patched; shortening stored bodies has the same cost. The levers that exist
today are `pr_reviewer.num_max_findings` (default 3 per run, a project setting) and the fact that a
complete run resolves findings that are gone. Compacting the record is CR-52; the detection above keeps the loss visible until then.

## Settings policy

How a job becomes PR-Agent configuration (`pr_agent_config.py`, `pr_agent_runtime.py`,
`repo_settings_guard.py`):

- **No secret in the process environment.** The installation token (`github.user_token`) and the
  LLM key (`openrouter.key`) are typed settings, set inside the request scope. PR-Agent reads both
  from its settings (verified for its GitHub provider and its LiteLLM handler), so they are not
  environment variables, and a `{env[...]}` reference finds nothing. The environment of the PR-Agent
  process is built from scratch: runtime variables (`PATH`, `HOME`, proxy and certificate settings,
  the tiktoken cache), endpoints (`GITHUB__BASE_URL`, `OPENROUTER__API_BASE`), model names and a
  few switches. Nothing of the parent environment passes on. The values of `job.env` are not in it
  either.
- **Nothing a job or a repository sends is evaluated.** Dynaconf evaluates a text that starts with
  `@format`, `@jinja`, `@get`, `@read_file` and similar markers when the setting is read; such a
  text can read an environment variable or any other setting, a secret included, into the prompt
  and from there into a public comment. Dynaconf only does that while its `AUTO_CAST_FOR_DYNACONF`
  setting is on. It is switched off in three places: in the environment (Dynaconf reads it before
  the first variable, which PR-Agent's own setting of it comes too late for), as the first typed
  setting of each job, and by the settings guard before and after every settings file it lets
  PR-Agent merge. As a safety net the guard turns any value still waiting for evaluation back into
  its text after each merge. A `this.<section>.<key>` reference would still resolve a typed secret
  if evaluation were on, so the switch is what keeps `@jinja {{ this.github.user_token }}` literal.
  It also covers texts PR-Agent stores in its settings itself, such as the body of a linked ticket.
  Tests prove this with PR-Agent's real loaders and `_apply_repo_settings_file`, and by rendering
  PR-Agent's review prompt. The Dynaconf version they were written against is pinned in
  `tests/unit/test_dependency_pin.py`.
- **`job.env` values keep their type.** They are not read as TOML. The type of an option is the
  type of PR-Agent's own default for it (the review tool's options are switches, integers or
  text): a switch takes `true` or `false` (any case), an integer option takes an integer, and
  everything else, instructions above all, stays exactly the text that was sent (`123`, `[1]`,
  `2026-01-01` and `true` in an instructions field are text). A value that does not fit the type of
  its option is an `invalid_job` that names the option, never the value. An option PR-Agent does
  not know is kept as text.
- **Precedence**: PR-Agent's defaults, then the repository's `.pr_agent.toml`, then the options of
  the job. The guard puts the options of the job back after each repository file, so the project
  settings of the app win over the repository file; a repository can only set what the app does not
  manage. The settings that route a request or a credential, select the model, bound the cost or
  switch publishing and callbacks cannot be set by a repository at all: the key list
  `PROTECTED_SETTINGS` (model roles, fallbacks, token and reasoning budgets, endpoints, tokens,
  publishing switches) and the sections in `PROTECTED_SECTIONS`, which are pinned as a whole so a
  key PR-Agent does not declare cannot be added either (`model_routing`, which can swap the model per
  pull request size, `openrouter` provider routing and limits, `litellm`, `openai`, `azure_ad`,
  `aws`, `vertexai` and every provider section PR-Agent reads a key or endpoint from). The key,
  the endpoint and the section of every provider of the registry (`llm_providers.py`) are added to
  both lists when the guard takes its snapshot, so a provider the runner learns to use is pinned
  without touching the guard (`protected_settings`, `protected_sections`). A unit test
  feeds a malicious file with all of these through PR-Agent's own merge function; another compares
  the provider sections with PR-Agent's own list, so a new provider after an upgrade is noticed.
- **The review comment never names the model** (#280). PR-Agent can append the model to the comment it publishes:
  `config.output_run_details` adds the "Agent run details" section with the model, and
  `config.output_relevant_configurations` adds a `config` section with `model`, `model_weak` and `model_reasoning`.
  Both are off by default, but a repository's `.pr_agent.toml` could switch them on. The model of a managed catalog entry is
  operator data that a workspace must not read, so the runner sets both to `false` for every job (all workspaces,
  not only managed ones) and both are in `PROTECTED_SETTINGS`. Pinned by `tests/unit/test_repo_settings_guard.py`,
  `tests/unit/test_pr_agent_config.py` and, with the real PR-Agent against the fake LLM and a repository file that
  tries it, `tests/engine/test_engine_hostile_repo.py`. A review that listed the model in these sections before
  loses them; nothing else in the comment changes.
  A job cannot set the options the runner pins itself (`PR_REVIEWER__FINAL_UPDATE_MESSAGE`,
  `PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY` and `_EFFORT`): `invalid_job`.
- **Where `.pr_agent.toml` comes from.** PR-Agent 0.47.0 reads it from the **default branch** of the
  repository (contents API without a ref), not from the head of the pull request and not from the
  base branch of a pull request into another branch. The author of a pull request therefore cannot
  change how the review is configured by changing the file in that pull request; a change takes
  effect once it is merged into the default branch. The runner keeps it that way: the setting that
  would name another branch (`config.config_branch`, also the environment variable
  `PR_AGENT_CONFIG_BRANCH`, which the minimal environment drops) and per-directory settings files
  (`config.enable_per_directory_settings`) are pinned, so a repository file cannot redirect the
  lookup. The organization-wide settings repository (`<owner>/pr-agent-settings`) is not read
  (`config.use_global_settings_file` is off). The agent rules file `AGENTS.md`
  (`config.repo_context_files`) is read from the default branch as well
  (`config.repo_context_from_default_branch`, pinned to `true`: a repository file could otherwise
  switch it to the branch a pull request targets). Repository settings files stay enabled (single
  tenant, trusted repositories).
- `config.repo_context_files` stays at PR-Agent's default `["AGENTS.md"]` on purpose: the rules a
  project writes down for agents help the review. It costs a few tokens and one extra GitHub call
  per run, and it puts repository text into the prompt, which the repositories of a single tenant
  are trusted to do. Revisit this for a multi-tenant setup.
- `job.env` cannot carry credentials, endpoints or model settings. The only LLM endpoint override
  is `llm.baseUrl`, accepted for loopback addresses.

## LLM providers (#424)

`llm_providers.py` is the registry of the providers the runner can talk to, keyed by the slug a job
names in `llm.provider` (ADR 0005, 2.4). Adding a provider is one entry; no other module names a
provider. An entry holds:

| Field | OpenRouter | Anthropic (#511) | Read by |
|---|---|---|---|
| `litellm_prefix` | `openrouter/` | `anthropic/` | `pr_agent_config.py` (the model roles and the fallbacks), `job.py` (the fallback comparison) |
| `default_api_base`, `api_base_variable`, `litellm_api_base` | `https://openrouter.ai/api/v1`, `OPENROUTER__API_BASE`, as it is | `https://api.anthropic.com/v1`, `ANTHROPIC_API_BASE`, without the trailing `/v1` (LiteLLM adds `/v1/messages`) | `pr_agent_config.py`, `runner.py` (the Dynamic upstream) |
| `key_setting`, `api_base_setting` | `openrouter.key`, `openrouter.api_base` | `anthropic.key`, `anthropic.api_base` | `pr_agent_config.py` (the secret), `repo_settings_guard.py` (pinned, with the section) |
| `require_parameters` | method `_apply_openrouter_request_controls`, body `provider: {require_parameters: true}` | none | `require_parameters_patch.py`, the Dynamic proxy |
| `no_endpoint_for_parameters` | the 404 texts of "Required parameters on OpenRouter" | never | the Dynamic proxy |
| `cost_extractor(model, usage)` | `usage.cost` as an exact decimal | the usage priced with the model's list prices (`anthropic_cost.py`) | the Diff meter (`diff_cost.py`) and the Dynamic proxy |
| `supports_temperature(model)` | no opinion: the name rules of `temperature_patch.py` | the flag of the model in the list; a model that is not listed gets none | `temperature_patch.py` |
| `diff_output_tokens(model)`, `context_window(model)` | none | 16000 (at most the model's output), the model's window | `pr_agent_config.py` (`config.max_output_tokens`, `config.custom_model_max_tokens`) |
| `wire(model)` | the chat protocol as it is (`provider_wire.OpenAiChatWire`) | the Messages API (`anthropic_wire.py`) | the Dynamic proxy |

- **Jobs.** `parse_job` looks `llm.provider` up in the registry and refuses a slug it has no entry
  for with `invalid_job` (the contract only fixes the form, `^[a-z][a-z0-9_]{1,31}$`). The parsed
  `Job.llm.provider` is what every later module reads; a job of the previous release names
  `openrouter` and is configured exactly as before.
- **Advertising.** The runner lists its registry: `llmProviders` in the claim body and
  `llmProviders=<slugs>` (comma separated, next to `features`) in the Worker's details request. An
  app of the previous release ignores both; an app that gets neither reads it as `["openrouter"]`,
  which is what a runner of the previous release can run. A new app therefore never hands an old
  runner a job it cannot read. Since #432 the app sends a job only to a caller that advertised the
  provider the job runs on.
- **Checks of an entry.** The `require_parameters` field must not be one the Dynamic proxy forwards
  from the engine (`PROXY_FORWARDED_FIELDS`): the proxy sets it after the copy and would overwrite what
  the engine sent, so such an entry cannot be built. The key and the base setting share one section.
  `ModelProxy` and `apply_require_parameters_patch` take the provider as a required argument, with no
  default.
- **Tests.** A second, fake provider (`tests/unit/support.py`, `fake_provider`) is registered for the
  duration of a test to prove that the job parser, the PR-Agent configuration, the patch, the proxy
  and the guard follow the entry. The second real provider is Anthropic (below).

## Anthropic (Claude API, direct; #511)

The managed key buys its tokens from the Claude API. The model list is fixed and curated; it lives in
`anthropic_models.py`, the runner's typed copy of `contracts/anthropic-models.v1.json` (ids, windows,
output limits, the flags that decide which request parameters a model takes, the prices per million
tokens as `Decimal`). A test compares it with the contract file and with the app's list
(`app/src/llm/providers/anthropic/models.ts`). A model that is not in the list is not refused: it gets
no sampling parameter, and its calls cost an unknown amount.

- **Cost (`anthropic_cost.py`).** The API states token counts and no charge, so the cost of a call is
  computed: uncached input, output, cache reads, and cache writes (five minute and one hour, each at its own
  price) times the model's prices, in exact decimals. Haiku 5.5 charges more for a request whose
  prompt (input, cache reads and cache writes together) is over 100000 tokens; each request is priced
  on its own, with every token of the request at the higher tier. The cost is **unknown, never zero**
  for: a model that is not listed; a usage that cannot be read (a missing, negative, fractional or
  boolean count, cache counts that do not fit the prompt, a cache write split that does not add up) or
  that holds no token at all (LiteLLM fills a missing usage with zeros; every real answer has tokens);
  a tier other than the standard one, the fast mode, an inference region other than the default,
  any entry of `server_tool_use` that is not zero (web search, web fetch, code execution, a tool that
  is new), any other usage field that holds something and is not a standard token field (the list is
  deny by default; a cost a layer states itself is ignored), or per-iteration usage, none of which
  the list can price. The wire passes every usage field it does not translate on for that check, and
  sends no text block that is empty or only whitespace (the API answers 400 to one). A cache
  write without a split is priced as a five minute write, the lifetime the runner's requests use.
  The result carries `costUsd` as a JSON number; a cost of a few millionths of a dollar reads back
  exactly. A Dynamic call that cannot be priced stops the run (`dynamic_accounting_failed`), as a call
  without a stated charge does for any provider; a Diff run with one makes `costUsd` null.
- **Diff.** LiteLLM's Anthropic path (`anthropic/<model>`, the key as `anthropic.key`, the address in
  `ANTHROPIC_API_BASE`). The cost meter (`diff_cost.py`) prices every answer by the model its request
  named. The output a run asks for is `config.max_output_tokens` (16000, at most the model's): reasoning
  counts against it and LiteLLM's default of 4096 can be used up before the review is written. A model
  of the list gives PR-Agent its window when the job has no token budget.
- **No unsupported parameter (`temperature_patch.py`).** The Claude API answers a non-default
  `temperature` or `top_p` with a 400 from Opus 4.7 on. For a provider that knows its models the patch
  asks the provider (`supports_temperature`), which answers with the flag of the model in the list; the
  version rules of the model name (#477) apply only to a provider without an opinion. PR-Agent's own answer can
  still say no. `top_p` is never sent by PR-Agent.
- **Dynamic.** The engine speaks the chat protocol to the model proxy; `anthropic_wire.py` translates
  the checked request to a Messages request (system prompt, content blocks, tool results in one user
  turn, `tool_choice`, `stop_sequences`) and the answer back to a chat completion whose `usage` is the
  one the cost rule reads. The Messages API is used and not Anthropic's OpenAI-compatible endpoint, which
  is documented as not meant for production, ignores `response_format`, `strict` and prompt caching and reports
  no cache tokens. What the wire does: sends `temperature`/`top_p` by the model's flags and never both; sets
  `thinking: {"type": "disabled"}` where the model accepts it; marks the prompt for the provider's cache (see "Prompt caching"); refuses, before anything is reserved
  or sent, content that is not text, a response format other than text and a malformed tool call in the
  history (`dynamic_policy_violation`).
- **Steering instead of forcing (#533).** The engine asks for `tool_choice: required` on every call and the
  review has to come back through its `StructuredOutput` tool. Fable 5.1, Opus 5.5 and Sonnet 5.5 answer a
  forced tool choice with a 400, and Fable 5 (like those three) cannot switch thinking off, which a forced
  call would suppress. The wire decides from the flags of the list (`forced_tool_choice`, `thinking_disabled`),
  never from the id: a model without the one or the other is **steered**. A forced choice goes out as
  `tool_choice: auto` (with `disable_parallel_tool_use` when the request asks for it), the return tool is marked
  `strict: true` with its schema reduced to what the strict mode takes (`anthropic_schema.py`: no `pattern`,
  `minLength`, `maxItems` and the like, each limit moved into the field's description; a schema that cannot be
  reduced safely goes out without `strict`), and a constant instruction ends the system text
  (`STEERING_INSTRUCTION`; no tag, the same on every request of a run, so the cache stays valid). What the
  answer is worth is decided as before: the final call is checked by `final_reply_problem` and asked again
  (`FINAL_ATTEMPTS`), a normal turn that ends without the tool gets the one recovery turn (#309), both bounded
  by the cost and time ledger. Every model of the list can serve a Dynamic Review.
- **Thinking blocks (#533).** A model that cannot run without thinking must get its `thinking` and
  `redacted_thinking` blocks back with every tool result. The engine's chat history cannot hold them, so the
  wire keeps them per tool call (`anthropic_thinking.py`, an id is unique per call; a turn without a tool call
  by its text) and puts them back, unchanged and in the order the model had them, into the assistant turn that
  carries the same tool calls on the next request. The engine never sees them. Such a request also names
  `thinking: {type: "adaptive", block_binding: {prefix_mismatch_behavior: "drop_block"}}` with the beta header
  `thinking-binding-controls-2026-08-01`: the proxy's own final call (wrap-up, recovery) changes the tool set,
  and a thinking block is bound to the conversation that produced it, so without this an account created after
  2026-08-31 would answer 400; with it that call loses its reasoning and nothing more. Thinking tokens are a
  part of `usage.output_tokens`, priced with them once: `output_tokens_details.thinking_tokens` travels with the
  usage and the cost rule only checks that it fits the output (#534; a count above it is an unknown cost).
  Not proven against the real API, only against the fakes; that an omitted block is a 400 is an assumption of
  the fake (the documentation does not state the status code for it).
- **The call trace (#541).** `dynamic_review/call_trace.py` records, for each model call, when it started, its
  prompt, cache read, cache write and completion tokens, its cost, why it ended, whether it was the final call and
  which tools it asked for; and for each tool call the tool, the size of the result and whether the same call had run
  before in the job. The model proxy feeds the first, the tool audit the second; `ledger.usage()` puts it into
  `usage.callTrace` of the result. **Nothing from the repository or the model is stored**: no path, argument, result or
  text; a tool that is none of the engine's is `other`, a finish reason outside the protocol's is `other`, and a repeat
  is decided from a digest of the normalised arguments that is never written out. At most 100 entries of each kind are
  kept (`truncated` says more happened). The Worker passes the trace on only when it is exactly the contract's
  shape (`RESULT_CALL_TRACE_INVALID` in the log otherwise, the usage stays) and `fit_request` drops it, whole, before it shrinks
  the log when the body is too large (and `minimal()` has none). A call that ended the run without a usable answer (no
  usage, an answer over the byte bound) is in it with `null`s. Nothing in the run reads it back.
- **Output allowance with thinking (#533).** Thinking counts against `max_tokens`, a hard cap on thinking and
  answer together, so a thinking model can use up 8192 and cut its `StructuredOutput` call off. The job's
  descriptor gives a model that cannot run without thinking 32768 (`app/src/llm/dynamic-capabilities.ts`; the
  models state 128000; Anthropic's "Cost control" section names raising `max_tokens` before lowering
  `effort`, which is only soft guidance and, changed within a run, invalidates the prompt cache). The cost
  limit does not reserve all of it: `reserved_output_tokens` of the wire (`THINKING_RESERVED_OUTPUT_TOKENS`,
  8192) is the most a call holds back, and within it a call reserves the output the run has shown (#540: the
  p95 of its completions, at least 1,024 tokens), so the larger allowance does not make the
  guard stop a run earlier (reserving 32768 at Opus 5.5's 20 USD per million tokens would be 0.66 USD per call,
  and the 1 USD default would wrap every run up at its first call; Fable's price is higher still). The answer
  is still held to the whole allowance, and a call that really uses more than it reserved passes the limit
  by at most that excess; the run then ends (`settle_call`). The first smoke run must show how much thinking a
  review takes.
- **Errors.** The envelope `{"type":"error","error":{"type","message"}}` goes through the same table as
  every provider: 400 "prompt is too long" is `llm_context_length_exceeded`, 401/403 `llm_auth`, 404
  `model_unknown`, 429 `llm_rate_limit`, 5xx and 529 (overloaded) `llm_unavailable`. What the provider
  says never reaches the engine.
- **Tests.** `tests/unit/test_anthropic_models.py`, `test_anthropic_cost.py`,
  `test_anthropic_provider.py`, `test_anthropic_wire.py`, `test_anthropic_wire_steering.py`,
  `test_anthropic_strict_fake.py`, `test_dynamic_review_proxy_anthropic.py`,
  `test_dynamic_review_proxy_anthropic_steering.py`, `test_diff_cost_anthropic.py`,
  `test_temperature_patch_anthropic.py`, `test_pr_agent_config_anthropic.py`,
  `test_anthropic_wire_caching.py` (where the breakpoints go), `test_fake_anthropic_cache.py` (the cache
  rules of the fake);
  `tests/integration/test_dynamic_review_proxy_anthropic_transport.py` (real sockets);
  `tests/engine/test_engine_anthropic.py` (the real PR-Agent and LiteLLM against the fake LLM that speaks the
  Messages API: the temperature of each listed model, the headers, the output, the exact cost) and
  `tests/engine/test_engine_opencode_anthropic.py` (the real pinned OpenCode behind the proxy's Messages wire,
  steered models, thinking blocks and the recovery). The fake enforces Anthropic's 400s
  (the rules module of `fakes/llm/`, by the flags of the contract file).

## Prompt caching (#539)

Caching is on wherever the provider has it, for Diff and for Dynamic. A Dynamic Review is a tool loop
that sends its whole history with every call (the live run that made it visible: 55 calls, 1,968,171
prompt tokens, $0.70 where the same tokens uncached cost about $3.94), so the part a call repeats must
be read from the cache. A cache write costs 1.25x the input price, a read 0.1x (0.05x on Sonnet 5.5 and
Opus 5.5, 0.025x on Fable 5.1), so a prompt that is read only once is dearer cached than not: that is
why the diff of a Diff run is never marked.

| Where | What is marked | Done by |
|---|---|---|
| Dynamic, Anthropic | three explicit breakpoints in the Messages body: the last system block (it covers the tools in front of it; the last tool when there is no system prompt), the end of the latest turn, and the end of the turn before it of the same side (the entry the previous call wrote). Never more than four, never two on one block, no top-level `cache_control` (it takes a slot and marks the last block again) | `anthropic_wire.py` |
| Dynamic, OpenRouter, `anthropic/...` | the two forms OpenRouter documents: a `cache_control` on the text of the system message and the top-level `cache_control` (automatic caching of the last block) | `provider_wire.OpenRouterWire` |
| Dynamic, OpenRouter, any other model | nothing: OpenAI, DeepSeek, Grok, Moonshot, Groq/Kimi, Z.AI and Gemini 2.5 and newer cache by themselves, and a parameter an endpoint does not know next to `provider.require_parameters` would answer "no endpoint found". The prefix stays stable (the runner never reorders or rewrites an earlier turn) and OpenRouter's sticky routing keeps a conversation with the provider that holds its cache | none |
| Diff, a model whose name says `claude` (Anthropic, or `anthropic/claude-*` on OpenRouter) | `litellm.cache_control_injection_points = [{location: message, role: system}]`: the system message, the instructions of the tool, which the calls of a run and the runs of a workspace within five minutes have in common | `pr_agent_config.py` |
| Diff, any other model | nothing | none |

**Lifetime: five minutes**, the provider's default, one constant (`provider_wire.CACHE_CONTROL`). Every
read renews the entry for free and a tool loop calls the model every few seconds (a call is cut off at
120 s), so it never expires inside a run. A one hour write costs 2x instead of 1.25x; the extra 0.75x
per written token pays only if the same entry is read again after more than five minutes, at 1.15x less
per read, which is a 65 % chance of a late read. The prefix of one conversation is never read again
after its last call, so one hour can only lose. The shared system message could win with more than one
job per workspace in five to sixty minutes; that is not the case today and the log line below is how
it would be seen.

**With steering and thinking blocks (#533).** The constant steering instruction is part of the last
system block, so the static prefix stays byte-stable within a run. A thinking block cannot carry a
mark: the breakpoint of a turn goes on its last block that is neither thinking nor a tool result
without content (a tool that returned nothing; the provider refuses a mark there as on an empty
text block, so the mark moves to the previous block of the turn). The wrap-up call changes
the tools (and drops the reasoning of the earlier calls with `drop_block`), so it misses the cache by
design; it is one call. A request without a forced choice has no instruction and non-strict tools, a
different prefix, and caches on its own.

**The engine marks too.** The pinned OpenCode (1.19.0), when the model id contains `claude` or
`anthropic`, puts `cache_control` on the system message, on its last two other messages and on the
tool calls of its history (on the message objects, which the Messages API has no field for: a 400).
Both wires build or clean their messages and drop every mark of the engine, so the breakpoints of a
request are the ones the wire placed, each once. `PROXY_FORWARDED_FIELDS` does not list
`cache_control`, and nothing in a pull request (a diff, a title, a tool result, a repository file)
chooses a mark, a lifetime or a header: the marks come from the structure of the request. For Diff the
setting is in the `litellm` section, which a repository's `.pr_agent.toml` cannot change.

**What it saved, and what it did not.** The Anthropic wire sent a top-level `cache_control` before this
change, so the live run above was already cached. The explicit breakpoints make that deliberate and
tested: the static prefix is marked on its own, and a read never depends on the provider's look-back of
20 positions reaching the last write. Through the cache fake a 55-call run reads 96.6 % of its prompt
from the cache and costs 84.2 % less than the same run without breakpoints
(`test_dynamic_review_proxy_caching.py`). The new part is OpenRouter (a Claude behind it had the
engine's undocumented marks only) and Diff (no caching at all).

**Cost stays exact.** A read is priced at the read price, a five minute write at the write price (the
`cache_creation` split when present, #534), the rest at the input price; every unknown-cost rule of
#534 holds. OpenRouter's `usage.cost` already carries its discount and is read, never computed.

**Observability.** A job logs one line of counts at its end, in the result's log: `prompt cache: 12
calls, 54000 input tokens read from the cache, 3200 written to the cache, 800 not cached`
(`cache_usage.py`; Dynamic: the proxy sees every call, Diff: the cost meter). No text of a prompt, an
answer or a key, and no price. A usage that states counts that do not fit its prompt is counted as paid
in full.

**Fakes.** `fakes/llm/anthropic_cache.py` keeps the rules of the docs (at most four breakpoints, the
model's minimum length, five minute and one hour lifetimes that a read renews, a look-back of 20
positions, a mark on an empty block, an empty tool result, a thinking block or a message object is
a 400; a changed `tool_choice` or `thinking` invalidates the cached messages and a changed tool set
everything after it) and returns the real usage. `fakes/llm/server.ts` has the same rules for the app's and the e2e lanes;
`tests/engine/fake_llm.py` uses the Python ones (`prompt_cache`), also for the OpenRouter shape
(`prompt_tokens_details.cached_tokens`, `cache_write_tokens`, a `usage.cost` with the discount).

## Required parameters on OpenRouter (#270)

OpenRouter may route a request to a provider that silently ignores a parameter it does not support
(`tools`, `tool_choice`, `response_format`). Every request the runner sends to OpenRouter for a job
therefore carries `provider.require_parameters: true`: OpenRouter then routes only to providers that
support every parameter of the request, and answers 404 ("No endpoints found that can handle the
requested parameters", or "...that support tool use") when there is none. The field states a capability requirement. It selects no
provider and expresses no preference, so it is no provider-specific routing (epic #193, decision 6);
`provider.only`, `order` and any other routing field stay forbidden.

- **Dynamic Review:** the model proxy adds the field to the body it forwards
  (`ModelProxy(require_parameters=...)`). The engine still cannot send `provider` or any other
  routing field: such a request stops the run with `dynamic_policy_violation` and never reaches the
  provider. A 404 whose text says that no endpoint "can handle the requested parameters" or "supports tool use" / "the provided 'tool_choice' value" (the wordings seen from OpenRouter; `llm_providers.py`) ends the run with
  `dynamic_model_features_unsupported`; any other 404 (an unknown model, a data policy) stays `model_unknown`. No retry on another
  model or provider.
- **Diff Review:** PR-Agent 0.47.0 has no setting for it (`litellm.extra_body` takes three other
  keys, and `openrouter.provider_only` / `provider_order` are provider selectors). The runner wraps
  `LiteLLMAIHandler._apply_openrouter_request_controls` for the length of the job
  (`require_parameters_patch.py`, the method name and the body field come from the provider's registry entry) and adds the field to the `extra_body` PR-Agent has built; LiteLLM
  sends it verbatim. The patch refuses a handler class whose method has another shape, and
  `PATCHED_FOR_VERSION` (checked at the start of every job) ties it to the pinned PR-Agent. The
  engine suite (`tests/engine/test_engine_require_parameters.py`) reads the request that reaches the
  fake LLM. The same 404 ends the job with `llm_parameters_unsupported` (it was `model_unknown`
  before #477); the job's fallback models (the app sends none) are the only other models PR-Agent
  would try.
- **No `temperature` for a model that does not take it (#477).** OpenRouter lists no
  `temperature` for any Claude model from 4.7 on or any GPT-6 model, so with the field above a
  request that carries it finds no endpoint. PR-Agent 0.47.0 withholds it for a fixed list of families and otherwise asks
  litellm's metadata, which still lists it for Haiku 5.x. The runner wraps
  `LiteLLMAIHandler._litellm_supports_temperature` for the length of the job (`temperature_patch.py`)
  and answers no for every Claude model from 4.7 on and every GPT model from 6 on, and the `latest` aliases of both (`openai/gpt-chat-latest`), by
  version, so a new point release, a `:variant` or a later family needs no list entry (GPT-5 and `gpt-6-astra` are
  PR-Agent's own). A patch that cannot be applied ends the job with `runner_error` and a detail that
  names it. `config.no_temperature_models` would need every id spelled out.
  Every other model is left to PR-Agent. The patch refuses a handler whose method has another shape.
- **Only for OpenRouter.** A job without `llm.baseUrl` talks to OpenRouter and always gets the
  field. A job with `llm.baseUrl` talks to a local fake and gets the request unchanged, unless the
  test double that added the address also sets `llm.requireParameters: true` (the wrapper
  `fakes/pr-agent/run_job_against_fake_llm.py` does; the field is refused without `baseUrl`, so no
  job for the real provider can switch the requirement off).

## Cost of a Diff run (#274)

`usage.costUsd` of a Diff run is exact in the same sense as that of a Dynamic run (#267): the sum, as
decimals, of the cost of every call by the rule of the job's provider: the charge the provider **states**
(`usage.cost` of OpenRouter's answer), or, for a provider that states none, its usage priced with its own
price list (Anthropic, see above), and `null` as soon as one call has no such cost. The result carries a JSON number, so the value
is the nearest double of that exact decimal sum (no more digits than a double holds). It is never LiteLLM's
or PR-Agent's table, and an unknown cost is never zero. It applies to every Diff job, whoever
pays for the key; the tokens and the number of calls stay PR-Agent's own measurement.

**The decision (a spike inside #274).** PR-Agent calls the model itself through LiteLLM, and its own sum
(`RunDetails.total_cost_usd`) is not usable: when an answer states no charge it prices the call from
LiteLLM's table, which can be missing, stale or different from what was charged, and it counts only the calls
PR-Agent accepted. Three ways to measure it were weighed:

1. *Route PR-Agent through the loopback accounting proxy of the Dynamic Review.* Not chosen. The proxy exists
   because the Dynamic engine is untrusted and must not hold the credential; PR-Agent already holds the job's
   key in its own process, so a proxy would add a server, a per-job capability and a second place that holds
   the credential, and it would read the very same `usage.cost` field.
2. *Read the charge from LiteLLM's response object.* **Chosen.** LiteLLM passes OpenRouter's `usage.cost`
   through, for a plain answer and for the last chunk of a stream (verified with LiteLLM 1.103.0), so the
   figure is the provider's, the same one the proxy reads. Reading it needs no new network surface: the request
   path, the destination, the key and `provider.require_parameters` (#270) are untouched.
3. *Look up the generation record of each request id after the run.* Not chosen: one more call to OpenRouter
   per request after the run, which may not be available yet, for a figure that is already in the answer.

**How it works** (`diff_cost.py`). PR-Agent calls LiteLLM through one function, `acompletion` in its handler
module; the runner wraps it for the length of the job (like the other patches, refused when the function is
missing or not a coroutine function, undone afterwards) and sees every answer, also one PR-Agent throws away
afterwards (an empty reply is billed). `config.output_run_cost` is `false`, so PR-Agent prices nothing and
`total_cost_usd` is never read. That flag only controls PR-Agent's own pricing and the "Estimated API cost"
line of the opt-in run-details section (`config.output_run_details`, which the runner now sets to `false`
and pins, see below), and the default review comment is unchanged. The setting is pinned, so a repository
settings file cannot switch it back on. The rules, pinned by `tests/unit/test_diff_cost_meter.py`,
`tests/unit/test_runner.py` and `tests/engine/test_engine_cost.py`:

| Case | Cost |
|---|---|
| Every call states a charge of zero or more | the exact decimal sum (a stated zero is a known zero) |
| A call whose answer states none (no `usage`, no `cost`, a value that is not a finite number of zero or more), also a stream whose last chunk has none | `null`, tokens still reported |
| `response_cost` (LiteLLM's own figure, usage or hidden parameters) | never read |
| An answer PR-Agent rejects afterwards (empty content) and a fallback model answers | both answers are counted |
| A request refused before any generation: status 429, 401, 402, 403, or request validation 400, 404, 422 (the statuses of `_REJECTED_BEFORE_GENERATION`), and a fallback model answers | the failed attempt states no usage and no charge and costs nothing; only the answers count |
| Every other end: any 5xx, 408, a gateway timeout (504, 524), a status nobody knows, an exception without a status of the provider, a request that ended without an answer (timeout, lost connection, cancelled, a stream not read to its end) | `null`: it may have been billed and nobody can say. Some runs with a failed 5xx attempt therefore report `null`; unknown is the safe direction |
| An HTTP 200 answer whose body is an error (LiteLLM raises a 5xx exception for it, with the `usage` it carries unread) | `null`, as every 5xx. LiteLLM raises the same exception for a body that says 429 as for a real 429, so such a body is read as a refusal: the meter cannot tell them apart |
| A call that carries a retry count (`num_retries`, `max_retries`, not zero) | never counted, the cost stays `null`: LiteLLM may send several requests inside one call and only the last answer would be seen. The runner pins `config.num_retries` to 0 (a repository settings file cannot change it), so PR-Agent's own attempts, each passing the meter, are the only retries |
| A stated charge above 1000 USD for one call, or a sum above 100000 USD for a run | `null`: no provider states such a figure, and a huge value must not become an infinite number in the result |
| A call PR-Agent counted that did not go through the wrapped function | `null` |
| Several calls at once (a chunked review) | all counted |
| No answer at all | `null` (not zero) |

A Diff run that fails reports the same cost rule after its calls (#273): a call still in flight when the run
ends makes the cost `null`, which also closes the case of a partly priced sum reported as exact.

**A Diff run that fails while a request is in flight (#363).** PR-Agent counts only the calls that came back
(`num_ai_calls`), so a command that raises, reports a failure or times out while its first request is still in
flight, or whose request the provider accepted and then failed, has no usage. The model may still have worked on
it. The meter already knows which requests are open, so the runner reads that instead of counting on its own
(`DiffCostMeter.may_have_used_the_model`): true when a request is in flight, was cut off or cancelled, ended with
anything but a refusal before generation, or came back (also an answer PR-Agent threw away). A failed Diff result
that has no usage and for which the meter says so carries `errorReason` `no_result_from_process`, the reason the app
already counts as `settled` / `no_result` with unknown cost and tokens (never `void`, never zero). The contract
does not change: the signal is the existing optional `errorReason`.

| Failed Diff run | Result |
|---|---|
| A request is in flight (the command raised, reported a failure or timed out), or an answer came back that PR-Agent did not count | no `usage`, `errorReason` `no_result_from_process` |
| A call came back and another request is in flight | `usage` with the tokens PR-Agent counted and `costUsd` `null`; no reason (the usage settles the run) |
| No request was sent, or the only requests were refused before generation (429, 401, 402, 403, 400, 404, 422) | no `usage`, no reason: the app voids the run |
| Success | unchanged, never a reason |

The watchdog that ends a command blocking the event loop reads the same meter (`main` creates a `MeterSlot` before
it starts the watchdog and hands it to `run_job`, which fills it when the meter is installed; the counters are
read under the meter's lock, with no await or I/O). A loop that blocked before its first request, or before the
meter existed, stays void; one that blocked with a request open reports the reason.

Tests: `tests/unit/test_runner.py`, `tests/unit/test_diff_cost_meter.py`,
`tests/integration/test_diff_cost_litellm.py` (the real LiteLLM against a loopback provider) and
`tests/engine/test_engine_cost.py`.

## Identity patch

An installation token cannot call `GET /user`, so PR-Agent cannot learn which login it posts as and
a second review of the same pull request would fail instead of editing its comment.
`GithubProvider._resolve_user_login` is replaced to return `<slug>[bot]`. The patch is tied to the
exact PR-Agent version (`identity_patch.PATCHED_FOR_VERSION`) and refused for any other.

The patch reaches into a private method, so a PR-Agent upgrade must not slip through. Two layers
protect it:

- At the start of every job the runner checks the installed version, that `_resolve_user_login`
  exists and takes only `self`, and that the chain that asks it for the login is intact
  (`is_comment_authored_by_pr_agent` calls `_agent_login`, which calls `_resolve_user_login`; see
  `identity_funnel.py`). If anything differs, the job is refused before PR-Agent runs, with the
  result code `pr_agent_version_mismatch` or `identity_patch_failed`. The detail names the method,
  the installed version and, for a signature change, the expected and the found signature. The
  runner never falls back to another identity and never posts a duplicate comment instead.
- `tests/unit/test_dependency_pin.py` and `tests/unit/test_identity_funnel.py` run in the runner CI
  job against the real, pinned PR-Agent (no network). They fail when the pin, the lock file, the
  installed package and `PATCHED_FOR_VERSION` disagree, when the methods the patch relies on are
  gone or changed, or when the fingerprint of one of them (a hash of its syntax tree) differs from
  the one recorded for 0.47.0. The same file also records the fingerprint of
  `append_review_state`, the function the review state watch wraps (see "The review comment size
  limit"): read what it cuts and when before updating that fingerprint. A PR that bumps `pr-agent` therefore turns the check
  `All checks passed?` red until someone has read the release diff and updated the recorded
  fingerprints and `PATCHED_FOR_VERSION` together with the pin. The fingerprints are hashes of
  the syntax tree and were recorded on Python 3.13 (the version of `.python-version` and the
  image); on another minor version they differ, so the fingerprint tests first assert the
  interpreter and say so instead of reporting a PR-Agent change that does not exist.

## The Implementer's git workspace (#762)

`code_reviewer_runner/implementer/` is the git side of an Implementer turn (the agent, the egress proxy and the job glue come
later). It is the safety core of the slice; the rules, in short:

| Piece | What it is |
|---|---|
| Mirror `/work/mirror.git` | A bare, `--depth 1` clone of the base branch, root-owned, mode 0700. The provider token is in the environment (`GIT_CONFIG_COUNT`, `http.extraHeader`) of the one git process that clones or pushes: never in argv, a config file, a URL or anything the engine user can read. Redirects are not followed. |
| Agent repository `/work/repo` | A local clone of the mirror (no hard links) owned by the engine user: no remote, system identity, the new branch at the base tip. Root never runs git with it as working directory or git directory; `dirty()` and `commit_all()` run as the engine user. |
| Guard | `/run/code-reviewer/guard.conf` (`BRANCH`, `START`, `SPOOL`, `REPO`, quoted, read by the hook from `CODE_REVIEWER_GUARD_CONF`) and `system.gitconfig` (`GIT_CONFIG_SYSTEM`: `core.hooksPath` = `/opt/code-reviewer/guard`, `safe.directory`), written by root. The hook is the image's (#761). `REPO` limits the hook to the agent's repository (a fixture's `git init` elsewhere is none of its business). The directories `/work` and `/run/code-reviewer` must belong to the runner, be no link and be writable by no one else, or the turn is `setup_failed`. It is an accident guard; `git -c core.hooksPath=/dev/null` gets around it. |
| Spool | A hint, never evidence: a line per tip update, appended by the engine user. The runner also polls the branch every 2 s (`PushLoop.tick`). A forged line costs one verified push attempt. |
| Push (the guarantee) | As root, from the mirror: `fetch` of the agent's branch into a scratch ref (`refs/runner/incoming`, forced: it is the runner's own), then the checks, then the mirror's branch moves to the tip (`update-ref` with the old value) and `push` without force. The checks: the tip is a commit (not a tree or an annotated tag), `merge-base --is-ancestor <start> <tip>` and `--is-ancestor <tip verified before> <tip>` (a rewrite is the second one failing), and the headers of every commit since the start, read as stored (`log --format=raw`): exactly one `author` and one `committer` line, and the committer is the system identity (`%cn`/`%ce` would read the last of two `committer` lines, other parts of git the first). Only the committer is compared, because `git cherry-pick`, `git am` and a merge keep the foreign author of a legitimate commit and a strict author check would abort a legitimate turn; the committer is always the one in the agent's environment (`GIT_COMMITTER_*`), so a forged committer is a `branch_violation` while a forged author stays possible and is visible, since the committer of the same commit shows the system. The fetch reads the agent's repository through a `git upload-pack` run as the engine user (`setpriv`), so the repository's config is never read with root's rights. One push or tip read at a time (a lock). **Decisions come from exit statuses and objects, never from what git printed** (the agent decides what its side of a fetch prints): a failed fetch is a refusal only when the state says so, namely `ls-remote` of the agent's repository lists no branch (gone), or the same fetch works with the object checks off and fails with them on (`fetch.fsckObjects`); a timeout, an unreadable repository or any other failure is `PushUnverified` (`runner_error`), poisons nothing and is tried again by `PushLoop.tick` after a back-off (10 s, doubling to 120 s). Stale `.lock` files of a killed fetch are removed before each push, and a timeout kills git's whole process group; every git on the mirror runs with `gc.auto=0` and `maintenance.auto=false`, so no background gc outlives that kill or touches a lock. Tip reads time out after 20 s. A rewrite, a non-commit, a bad object, a missing start commit, a gone branch or a commit by a foreign committer is a `branch_violation`: the provider keeps the last good tip, the mirror's branch never holds the refused tip, and nothing is pushed afterwards. The final push does not wait: a look that still fails ends the turn with `RepositoryUnusable`, as does a failed `dirty()` or `commit_all()`. That exception carries `branch_violation`, the wire code the app's class table already has as charged (the model was used); no new wire code was added. `commit_all()` runs git as the engine user with `-c core.hooksPath=<image hook directory>`, which beats the agent's own `core.hooksPath` (so its `pre-commit` neither runs nor speaks) and keeps the guard. What git prints about the agent's repository never reaches an error: `agent_detail` maps a guard denial to one of a few fixed texts. A branch that exists on the provider: `branch_exists`; any other refusal (workflow file, permission, network): `push_rejected`. |
| Self-test | `GitWorkspace.self_test()` runs `guard_matrix.sh` as the engine user (and needs git 2.53 or newer, where the hook sees a branch switch): any failure is `setup_failed`, never a turn without a guard. |

The tests need git 2.53 or newer first on `PATH` and the guard files of the image change (`runner/guard/`, `runner/scripts/guard_matrix.sh`);
without them they fail with the reason and never skip. The user separation (uids, what the engine user can read) is proven by
`tests/privileged/test_implementer_git_users.py`.

### The three names are not the agent's to change

`dirty()` and `commit_all()` leave `.opencode`, `opencode.json` and `opencode.jsonc` at the root out of their commands (`:(exclude,top)`
pathspecs). They never count as a change, never trigger the extra message and never block the commit of the rest: git refuses
`git add -A` for a new path outside the sparse definition (exit 1), and an edit of a tracked one is invisible to it, so without this one
such file made the whole turn fail charged after everything else was pushed. The instruction text tells the agent they are not
available. When the agent created or changed one anyway, `engine_inputs_present()` finds it (an `lstat` of the three names) and the
summary ends with a sentence of the runner's, "[Not made: the agent created or changed ...]", after the agent's text (the agent's text is
cut to make room, never the sentence), and the job log notes it. A turn that did nothing else is `agent_gave_up` with that sentence.

### Two bounds of the push (#764)

Both came out of the third review of #782 and are fixed where the push loop is wired:

- **The back-off is measured from the end of a failed look**, not from before it: a fetch that hangs for 30 s and then fails used to
  retry at once, because the clock had been read before the attempt. `PushLoop.tick` reads it again after the failure (and after a
  good push for the interval). Tests drive a clock that advances during `push()`.
- **A commit message is never read as a whole.** The check of the committers streams `log -z --format=raw` through
  `commit_headers.CommitHeaderReader`, which keeps the header block of the entry it is in and drops the message as it goes by, so the
  runner's memory is bounded by `MAX_HEADER_BYTES` (256 KiB, a larger header block is a `branch_violation`) whatever the messages hold
  (a 100 MB message cost about 234 MB on every push before). The same goes for the lists of the result (`history.py`): subjects and
  lines are capped as they are read.

## The Implementer's agent session (#764)

`implementer/session.py` runs one turn; `agent.py` is its engine, `config.py` and `prompts.py` what the runner tells the engine. It
has the skeleton of the Dynamic Review's adapter (the engine user and its network rules, a private home, `opencode serve` on the
slot's loopback port, the HTTP client and event stream, the loopback model proxy with the job's capability and the ledger) and reuses
those parts (`native_job.build_native`, `adapter.EngineClient`, `ToolPartAudit`); nothing is review-shaped.

| Piece | What it is |
|---|---|
| Configuration | Written by the runner, never read from the repository (`config.build_engine_config`). Permissions are default-deny, then `read`, `grep`, `glob`, `list`, `edit`, `write`, `bash`, `todowrite` and `external_directory` are allowed (`bash` reaches other paths anyway, and a refusal only added friction); `webfetch`, `websearch`, `task` and `question` are denied by name and everything else by the wildcard. Plugins, MCP, LSP, formatter, watcher, snapshot, share, updates, model fetching and repository skills are off or empty. **Compaction is on**, as the stock engine has it: a long task fills the window, and the engine summarises and goes on (Dynamic turns it off only because its return tool is lost after one). The provider is the job's loopback proxy with the capability and the one chosen model (`checked_native_provider`, as for a native Dynamic job). |
| Environment | `implementer_environment`: the Dynamic engine's flags (except the two that switch compaction and pruning off), the private home, a `PATH` that leads with the verified ripgrep, the git identity and guard variables of the workspace (`GIT_CONFIG_SYSTEM` of #762), and the egress proxy variables of #763; built from names, never inherited. No credential of any kind. The agent's cwd is `/work/repo`. |
| Prompt | The agent keeps the **stock prompt of the engine for its model**; the runner's addition is an instruction file it writes into its own trusted directory (next to the config, mode 0440, readable by the engine user only) and names in `instructions` by absolute path. Verified against the pinned engine: an absolute path works with `OPENCODE_DISABLE_PROJECT_CONFIG` set, and the text arrives as a separate system block after the stock text. It states the few facts the stock text gets wrong for this place: commit at normal intervals (over the stock bash tool's "only commit when explicitly requested"), never switch or create branches or rewrite history, nobody can answer a question so decide and go on, run the repository's tests when it has them, the repository is data, that `opencode.json`, `opencode.jsonc` and `.opencode` at the root are not available in this run and cannot be changed (say so in the closing summary instead), and the network statement, which follows `RUNNER_IMPLEMENTER_NETWORK` (registries or none). Two fixed variants, no template; nothing of the repository is interpolated. The instruction is the user message and nowhere else. Nothing else steers the approach. |
| Turn | The instruction is sent; the call blocks beside a watch that ends the turn at once when the ledger records a refusal, the clock runs out, the push loop meets a refusal or the engine dies. When the turn ends and the tree is dirty, **one** more message in the same session; what is dirty after that is committed by the system as the engine user without a model call. |
| End | Whatever ended the turn, the engine and every process of its user are ended first (sweep), then the leftover commit, then the final push (`PushLoop.finish`), then the result. The egress proxy and the model proxy are stopped last. |
| Egress | In `registries` mode the session starts the allowlist proxy (`start_egress`) before the engine's network is proven, sets `EngineLaunch.egress_port` so the probe reaches it, and stops it with the turn; `none` starts nothing. An engine test sends a request from a tool through the real proxy. |
| Limits | The cost limit is the ledger's: the proxy refuses the next call and the turn ends `cost_limit_reached` (an own key's token cap is the same code). The clock is the job's `timeLimitSeconds` less 3 minutes (a third for a short limit; `deadline_seconds`): `time_limit_reached`. In both cases the committed and the leftover work is pushed first and the result reports it. There is no step limit and **no bound on a single tool result** (a `grep` answers 200 KB); the cumulative 256 MiB of results and the 32 MiB request are sanity bounds. |
| Codes | `agent_gave_up` (no commit and a clean tree; the closing text is the summary; **also** an engine that died or a bound that ended the turn once the model was really used, that is a call was billed or may have been (`BudgetLedger.model_used`; reservations the provider turned away do not count), because that turn has cost money), `llm_unavailable` / `llm_timeout` when the engine gave up while the last call to the provider had failed (an outage, named from `proxy.last_upstream_error` as for Dynamic, and free when nothing was billed), `cost_limit_reached`, `time_limit_reached`, the codes of the git layer (`branch_violation`, `push_rejected`, `branch_exists`, `setup_failed`), `implementer_config_invalid` for a model entry the proxy cannot serve, and `runner_error`, free, for the same failures **before** any model call (the wire has no `internal_error`). |
| Push errors | A push that failed with no refusal (a 5xx, a reset, a timeout, no route, a 429, a local error such as a permission problem on the mirror, or GitHub's `! [remote rejected] (internal error)` / `(failed to update ref)`) is `PushTransient`, a `PushUnverified`: the loop backs off and tries again, and the final push runs once more. Only a refusal ends the turn: a `!` line of the porcelain, or an HTTP client error other than 408/425/429 (or git reporting that credentials were refused; only the remote's own words count, a local "Permission denied" does not). A final push that the provider never took is `push_rejected`. |
| Result | `TurnResult.implementer_block()` is the contract's `ImplementerResult`: the commits and changed files (read as the engine user, bounded by `history.py`), the closing text as the summary (secrets redacted, 8 192 characters), the OpenCode session id and the pinned version. The usage is the ledger's, with the call trace as for Dynamic (numbers and the names `read`, `grep`, `glob`; the contract has no name yet for `write` and `bash`, which count as `other`). |
| Prompt caching | Whatever the stock engine and the passthrough proxy do for Dynamic; nothing here sets, removes or rewrites a cache marker. `test_engine_implementer.py` checks for **each** wire family (Anthropic messages, OpenAI chat, OpenAI responses, Google) that every request extends the one before it (the prefix a provider caches, automatically or by mark), that the engine's marks reach the provider where the model takes them, that the Anthropic requests replayed through the cache rules of the fakes read their own prefix from the second call on, and that the ledger counts and prices what the provider states. |

### Nothing executable or configurable comes from the repository

The flags `OPENCODE_PURE` and `OPENCODE_DISABLE_PROJECT_CONFIG` are not enough in the pinned 1.19.0, and this was shown, not assumed
(`test_nothing_executable_or_configurable_is_loaded_from_the_repository`, which fails without the fix). The engine has two
configuration services. The older one honours the flag. The newer one (`@opencode/v2/Config`, which loads plugins, commands and
agents) looks for `.opencode`, `opencode.json` and `opencode.jsonc` from its working directory up to the project root with **no
check of any flag**, so a repository's `.opencode/plugin/*.js`, `.opencode/plugins/*.js`, a `plugin` entry of its `opencode.json`
and its `.opencode/command` and `agent` files were loaded and executed at the first request. There is no environment variable that
stops it, and running the engine in another directory would take the agent out of the repository.

The mechanism is the agent's working tree: `create_agent_repository` makes it a **sparse checkout** that leaves out `.opencode`,
`opencode.json` and `opencode.jsonc` at the root (`ENGINE_INPUTS`). They stay in every commit, so a push never deletes them, and they
are never on disk for the engine to find. A name that is a file or a link is left out too. Nested `.opencode` directories are not
reached by the engine's search (it stops at the project root). Known limits: a task that must change those files cannot commit them
(`git add` refuses a path outside the sparse definition), and an agent can undo the sparse checkout with its own bash, but then it
runs code it chose itself, which it can anyway.

### Two bounds of the push (#764)

Both came out of the third review of #782 and are fixed where the push loop is wired:

- **The back-off is measured from the end of a failed look**, not from before it: a fetch that hangs for 30 s and then fails used to
  retry at once, because the clock had been read before the attempt. `PushLoop.tick` reads it again after the failure (and after a
  good push for the interval). Tests drive a clock that advances during `push()`.
- **A commit message is never read as a whole.** The check of the committers streams `log -z --format=raw` through
  `commit_headers.CommitHeaderReader`, which keeps the header block of the entry it is in and drops the message as it goes by, so the
  runner's memory is bounded by `MAX_HEADER_BYTES` (256 KiB, a larger header block is a `branch_violation`) whatever the messages hold
  (a 100 MB message cost about 234 MB on every push before). `dirty()` looks at the first byte of `git status` only, and the lists of
  the result (`history.py`) are capped as they are read.

The tests: `tests/unit/test_implementer_config.py`, `test_implementer_prompts.py` and `test_implementer_session_parts.py`,
`tests/integration/test_implementer_history.py` (and the push and workspace tests), and `tests/engine/test_engine_implementer.py`
(the real pinned OpenCode against a scripted model; the shard `opencode`).

## Engine tests

`tests/engine/` runs the real, pinned PR-Agent through `code-reviewer-run-job` (one process per job)
against a fake GitHub and a fake OpenAI-compatible LLM on loopback ports, with no real network and no
real model: `uv run python scripts/prime_tiktoken_cache.py` once (the only step that needs the
internet), then `uv run pytest -m engine` (about 4 minutes; CI runs it in a network namespace for pull requests that change
the runner and nightly). The suite pins down the review command, the second review that edits the
first comment, the error codes for a rate limited, silent, wrong or unreachable model or GitHub, that
no credential is found in any output, what a hostile `.pr_agent.toml` cannot do, and what happens with
a comment at GitHub's length limit. See TESTING.md for the design.

## Measuring memory and duration

`scripts/measure_runs.py` starts one or several runner processes against the sandbox pull requests
(small, medium, large) and reports the peak memory (`ru_maxrss` of each process) and the duration of
each, with minimum, median and maximum over repeats. It runs on the host or inside the runner image
with a memory limit (`--docker IMAGE --memory 2g`), where it also reads the peak memory and the OOM
kills of the whole container. `--fake-llm` replaces the model with a canned local answer and puts a
dummy key into the job, so a run costs nothing; but every run, fake or real, posts or edits the real
review comment of the sandbox pull request, and the canned finding overwrites it. The script exits
with 1 if a child failed or was killed, and limits repeats and processes to 10. The results and the numbers derived from them (memory per job process) are in `docs/spike/cr-13-measurements.md`. Like the manual run it needs `--yes`.

## Manual run

`scripts/manual_review.py` runs a real review against the sandbox repository; see its docstring.
It needs `--yes`, posts a real comment and costs a few cents.
`--no-identity-patch` starts the runner without the identity patch, as a control for the spike
(CR-11). The report of that spike is `docs/spike/cr-11-second-run.md`; the reports of the
other spike tickets are added to the same folder.
With `--record-dir DIR --label NAME` it also saves the result JSON and the text of the review comment
right after the run (the next run edits the comment in place); nothing is saved if a secret shows up in
either. The model comparison of CR-44 (`docs/spike/cr-44-model-comparison.md`) was made this way.
