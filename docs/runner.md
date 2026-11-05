# The Factory-Runner: spikes and decisions

The Factory-Runner is the Implementer's Control, packaged to run on a customer's Linux machine and take the jobs of its
workspace (the plan is the owner's `plans/customer-runner.md`, milestones R0 to R4, epic #852). The runner itself does not
exist yet; its app side (registration, the list, routing) is built in R1a. This document holds what was **measured** before it
was built and what the app does for it; it grows with the milestones.

- [Registration and routing](#registration-and-routing-r1a-854): how a machine becomes a runner of a workspace (R1a).
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
  `401 RUNNER_UNAUTHORIZED`, the answer for any credential the app does not know. The same holds for every report about the job it was running (`heartbeat`, `complete`, `release`, `steps`; the session snapshot is the Worker API's and takes the per-job credential alone). Revoking also **ends the runner's running jobs at once**: their leases are cut to now and the queue's expiry runs, so a turn (one attempt) fails with `lease_expired` and its write token and record are dealt with as for any lost lease. What it already pushed stays on the branch.
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
  Worker gets them), so a runner's turn is built exactly like a hosted one. Its calls about the job (`heartbeat`, `complete`, `release`, `steps`) take the
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

### Validator rules

The validator of workflows (`POST .../workflows/validate`, and every save) knows the kind of each environment and, for each profile version it runs, whether
its model is managed and which harness it runs with:

| Code                   | When                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `runner_needs_own_key` | An agent step runs a profile with a **managed model** in an environment of the kind `runner`. Managed models run on platform VMs only. |
| `harness_needs_runner` | An agent step runs a profile whose **harness is not OpenCode** in an environment that is not a runner's.                               |

Profiles know only OpenCode today. The field `harness` is accepted in a profile document (`"opencode"` and nothing else: no other value is a harness a profile
can name), nothing is stored for it, and the second rule is prepared for the first harness a runner announces; this change adds none.

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
