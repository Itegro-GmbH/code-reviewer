# Dynamic Review: operating it

Dynamic Review is the second review kind next to Diff Review (PR-Agent): an agent reads the pull
request's code in a sanitised, read-only export and returns structured findings that the runner
publishes as one persistent summary comment. The decisions are in epic
[#193](https://github.com/Itegro-GmbH/code-reviewer/issues/193), the research in
`docs/spike/85-opencode-dynamic-review.md`, and the short deployment record is
[`docs/decisions/0002-dynamic-review-deployment.md`](decisions/0002-dynamic-review-deployment.md).

> **Status: shippable, off by default.** The engine is in the Dynamic runner image, the runner proves
> its isolation at start and advertises `opencode` only when the proof passes, and the instance admin
> has a switch for the rollout gate. Nothing turns Dynamic Review on by itself: the gate is off in
> every shipped configuration, and the Worker image holds the engine. The steps to switch it on are under "Activation, step by step"; whether and when to do it
> on an instance is the operator's decision. Read "Known limitations and residual risks" first.

## What exists, and what does not

| Part                                                                                                                                                                                                                                                                                                                                                                         | State                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Project setting `review_kind` (Diff or Dynamic), editable skill, default model `deepseek/deepseek-v4.1-flash`                                                                                                                                                                                                                                                                | Shipped (#194, #200)                                                                                                                  |
| Rollout gate `dynamic_review` (instance setting, default off), admin control                                                                                                                                                                                                                                                                                                 | Shipped (#195, #202)                                                                                                                  |
| Job tag, capability matching, `no_capable_runner`, `dynamic_review_disabled`                                                                                                                                                                                                                                                                                                 | Shipped (#195)                                                                                                                        |
| Sanitised read-only checkout of the pull request head                                                                                                                                                                                                                                                                                                                        | Shipped (#196)                                                                                                                        |
| Fixed review core and the editable skill                                                                                                                                                                                                                                                                                                                                     | Shipped (#198)                                                                                                                        |
| Repository skills: the agent lists, loads and reads the skills of the head checkout with OpenCode's own `skill` tool (manifests rewritten, no script runs)                                                                                                                                                                                                                   | Shipped (#701), see "Repository skills" in [Dynamic checkout](dynamic-checkout.md#repository-skills-701)                              |
| Engine seam: trusted config, hard limits, per-job model proxy, adapter, process-group cleanup                                                                                                                                                                                                                                                                                | Shipped (#197 part 1, #202 process-group reuse)                                                                                       |
| Summary comment, findings state, reconciliation                                                                                                                                                                                                                                                                                                                              | Shipped (#199)                                                                                                                        |
| Real pinned OpenCode fetch, proxy-side audit, hostile-repository proof; launch as the dedicated engine user, static per-user network rules, `NET_ADMIN` dropped after startup                                                                                                                                                                                                | Shipped (#197 parts 2a and 2b, #244)                                                                                                  |
| The Dynamic runner image: the `dynamic` target of `runner/Dockerfile` with the pinned OpenCode, a pinned `rg`, `nft` and the engine user (**linux-x64 glibc only**: the pins have no other platform. On another platform such as arm64 the image still builds, without an engine, and its runner serves Diff jobs only (#264); an arm64 engine needs its own pinned digests) | Shipped (#202, #264)                                                                                                                  |
| Startup self-check that advertises `opencode` only when everything holds, with a stable logged reason otherwise                                                                                                                                                                                                                                                              | Shipped (#202)                                                                                                                        |
| Deployment: the Worker image (`runner/Dockerfile`, target `sandbox`) in the golden snapshot of the hosted deployment, run in a Vercel Sandbox VM with the flags of the hardened container spec                                                                                                                                                                               | Shipped (#202, #264)                                                                                                                  |
| Provenance audit of the engine binary and `rg` in `make check-licenses` (source commit, licence, the Bun-lock runtime closure of the pinned commit), notices in `NOTICE` and `THIRD_PARTY_LICENSES.md`                                                                                                                                                                       | Shipped (#202)                                                                                                                        |
| Worst-case memory and OOM measurements, the decision to run more than one Dynamic job at a time                                                                                                                                                                                                                                                                              | **Manual step, not done** (needs a real deployment target, see "Capacity")                                                            |
| Full path from a signed webhook to the Run: the pull request title, body and previous-review state in the prompt (#251), the review kind proved for every entry point and the model and usage in Runs (#252), and the privileged `e2e-dynamic` journey with the real pinned OpenCode that publishes the summary (#253)                                                       | Shipped (#251, #252, #253)                                                                                                            |
| Recovery when a run wrote the summary and then ended failed                                                                                                                                                                                                                                                                                                                  | Shipped (#255, #257): the claim names the heads of earlier unsuccessful runs and says when that list was cut, see "Known limitations" |
| A short failure note in the summary comment when a run fails (not `lease_lost`, not a refused token)                                                                                                                                                                                                                                                                         | Shipped (#299)                                                                                                                        |
| Finalization above the wire for native providers: the review as plain JSON text, one repair, wrap-up by message, the final call after a refusal, the tool-result audit on the adapter side (`DynamicEngine(plain_final=True)`)                                                                                                                                               | Shipped (#552), see "Finalization above the wire"                                                                                     |
| The wiring of the native path: the claim carries the model entry and the cost policy, the runner starts the passthrough proxy and the plain-final engine with them, behind the app's switch `NATIVE_OPENCODE_PROVIDERS` (default off)                                                                                                                                        | Shipped (#578), see "The native path of a job"                                                                                        |
| Hosted activation                                                                                                                                                                                                                                                                                                                                                            | Needs the hosted egress gate (#82)                                                                                                    |

## How a Dynamic job reaches an engine

1. A project set to Dynamic Review enqueues a job tagged `review_kind: dynamic`, **only while the
   instance gate is on**. With the gate off the run is created `failed` with
   `dynamic_review_disabled`; it is never reviewed as a Diff. The kind comes from the project's
   stored settings, resolved by the queue inside the enqueue transaction, so it is the same for an
   automatic review, an authorized `/review` and a review started by hand with the play button in the project list. Nothing a pull request or a
   comment says (title, body, `/review` text) can select or change the kind, model, budget or skill.
   The Run's detail page shows the actual kind, model, tokens, model calls and cost. For Dynamic
   the cost is the `usage.cost` that OpenRouter reports with each answer, i.e. the credits it charged
   the account for that call, and the run sums them. With OpenRouter's bring-your-own-key
   (BYOK) routing, the charge of the upstream provider can differ from `usage.cost` (OpenRouter
   reports it separately); `costUsd` is always the `usage.cost` figure, not the upstream charge. If
   any call has no reported cost, the run's cost is unknown ("Not available") rather than a partial
   sum. It is never computed from a price table or from token counts. A run that **fails after at
   least one model call** (the budget or the clock ran out, the answer was refused, the summary
   could not be published, the lease was lost, the watchdog ended it) still reports that usage in its
   failed result (#273): the counters of its ledger, and the cost only when every call was priced.
   A run that fails before its first model call reports none. The app counts both kinds of run
   alike; a job that ends with no result at all from a runner that held it is counted with an unknown
   cost (`src/usage/README.md`).
2. A runner claims a Dynamic job only if it advertises `opencode` in the claim. The runner
   advertises it only after its startup self-check proved the dedicated engine user, the read-only
   export and proxy-only egress (`runner/src/code_reviewer_runner/dynamic_review/self_check.py`, see
   "The startup self-check"). A runner that fails it, and every PR-Agent-only runner, serves Diff
   jobs only.
3. A Dynamic job that no capable runner claims waits, without an attempt being counted, and is
   **cancelled with `no_capable_runner`** after `RUNNER_NO_CAPABLE_TIMEOUT_SECONDS` (app setting,
   default 30 minutes), counted from the last time a runner ran a Dynamic job: while one runs, or finished one itself within that time, the
   job keeps waiting, and it is cancelled at 3 hours at the latest whatever the runners do. A job the app ended because a runner stopped
   (`lease_expired`, `timeout`) is no sign of a working runner. It is visible in Runs; it never waits forever and never falls back to Diff.
4. The runner prepares the export (#196), starts one engine per job behind its own model proxy (the
   workspace key never reaches the engine), enforces the hard limits below and removes the job's
   temporary files and process group. Only after the engine has ended successfully, its findings
   passed validation and the export is released, the supervisor publishes (#199, wired in #253): the
   one persistent summary comment of the pull request, created on the first run and **edited in
   place** by every later run (a person's comment that merely quotes the marker is never edited). It
   writes with the job's own installation token; the engine never sees it. A failed run writes
   nothing, a failed write fails the run with its own stable code, and the Run links the comment.
   Right before the write the process asks the Worker whether the job is still its own (#260): the
   loop beats the heart once and answers from the app (a lost lease and a cancelled job are both
   409; a 5xx, a reset or a timeout is tried again up to three times within 40 seconds, and a 200
   counts only as the contract's heartbeat answer for this job). Anything but a clear yes ends the
   run with `lease_lost` and writes nothing, and so does a Dynamic job that was not handed the
   channel at all.

PR-Agent-only runners keep processing Diff jobs unchanged. A Dynamic-capable runner also serves Diff
jobs.

## The engine boundary

The container, not a sandbox, is the boundary (lead decision of 2026-10-12): no bubblewrap, no user
namespaces, no host kernel setting beyond the `nf_tables` support every current kernel has.

- **Two users in one container.** The job process is the **supervisor** and runs as root with exactly
  the capabilities of the hardened container spec, `contracts/worker-container.v1.json` (`SETUID`, `SETGID`, `KILL`, `CHOWN`,
  `DAC_OVERRIDE`, `FOWNER` for its whole life; `NET_ADMIN` and `SETPCAP` for container startup only,
  see below; everything else dropped, `no-new-privileges` on). It holds
  every credential and the model proxy. The **engine** runs as the dedicated unprivileged user
  `10101:10101` of the image, with no capability, no supplementary group, a closed environment, its
  own home and temporary directories, and a config file only it can read. It is started with
  `setuid()` in the child process: no `sudo`, no setuid helper, so `no-new-privileges` can stay.
- **Why those capabilities.** `SETUID`/`SETGID` start the engine as the other user; `KILL` signals
  its process group and its leftovers; `CHOWN` seals the read-only export (#196); `DAC_OVERRIDE` and
  `FOWNER` remove the sealed export and the tree the engine user may have filled (sticky and
  unreadable directories included). `SYS_ADMIN`,
  `SYS_PTRACE` and `NET_RAW` are deliberately absent. Diff jobs on the same loop are dropped to uid
  10001 (`RUNNER_DIFF_JOB_USER`) and hold none of these.
- **Network: one user, one proxy.** The runner installs `nftables` output rules keyed on the socket
  owner **once, when the container starts**, for the single slot's fixed ports
  (`RUNNER_DYNAMIC_PROXY_PORT`, default 10180; `RUNNER_DYNAMIC_ENGINE_PORT`, default 10181). The
  engine user may open new connections only to the job's proxy port and its own server port on
  `127.0.0.1`; everything else it tries (another job's loopback service, any other
  address, IPv6, UDP, a flow that someone else opened and closed) is rejected at once (the full
  ruleset; some kernels get the fallback below, #345). Only the
  replies of the engine's own server pass as tracked traffic. A per-job network namespace would need `SYS_ADMIN`, and a
  container-level egress rule cannot tell the supervisor (GitHub, the model upstream) from the engine
  in the same container. The rules are proven before every engine starts, by a probe running as the
  engine user against sentinel listeners (without `NET_ADMIN` not even the supervisor can list the
  ruleset, so the probe is how a job verifies them); any other result is
  `dynamic_isolation_self_check_failed` and no engine is started. The hosted egress gate (#82) is
  still a separate requirement.
- **Implementer container: a third port, the egress proxy (#763).** An Implementer container
  (`RUNNER_IMPLEMENTER_NETWORK=registries`, `RUNNER_IMPLEMENTER_EGRESS_PORT`, default 10182) gets
  one more accepted loopback port in the same rules. Behind it the root supervisor runs a CONNECT
  proxy (`implementer/egress_proxy.py`): only `CONNECT host:443` to the built-in registry allowlist
  (npm, yarn, PyPI, crates), the name is resolved by the proxy, every address it resolves to must be
  public (the model proxy's rule), and the tunnel goes to an address it judged. GitHub, the
  Dispatcher, the App and cloud metadata are not on the list, and neither is the Go module proxy:
  Go is not a stack of this slice, and that proxy fetches any host named in its path for the client,
  which would be a way out without a token. The allowlist is code, not configuration. The agent's
  tools find the proxy through `HTTPS_PROXY` and the npm/pip variables; a tool that ignores them has
  no network. `none` starts no proxy and opens no port. The job log gets one line at the end with
  the tunnels per host (never paths or content).
  **What the allowlist does not stop.** The proxy sees only the CONNECT name. After its 200 the
  bytes are the client's: any SNI and any `Host` go inside the tunnel, so other tenants on a
  registry's CDN addresses may be reachable under the registry's name. And `registry.npmjs.org` is
  writable: a prompt injection that brings an attacker's npm token can publish any file the agent
  can read. This is accepted for internal use on our own repositories; issue #784 (read-only
  registry access) closes it before external users run an Implementer.
- **Two rulesets, one policy (#345).** The kernel decides which one the runner installs, at start,
  before it drops `NET_ADMIN`. It asks the kernel by installing and removing a throw-away
  `table inet` with a `reject` rule (it matches no process).

  |                               | Full ruleset                                                                             | Fallback ruleset                                                                                                                   |
  | ----------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | Chosen when                   | the kernel accepts `table inet` and `reject` (every ordinary Linux host and Docker host) | `inet` or `reject` is refused. Some VM kernels, for example the ones of hosted sandbox VMs, only support the nf_tables `ip` family |
  | nft table                     | `table inet code_reviewer_engine_<uid>`                                                  | `table ip code_reviewer_engine_<uid>`                                                                                              |
  | Last rule for the engine user | `reject with icmpx type admin-prohibited`: refused at once                               | `drop`: no answer, a connection attempt times out                                                                                  |
  | IPv4                          | proxy port and engine port on `127.0.0.1`, the engine's replies, nothing else            | the same three accepts, nothing else                                                                                               |
  | IPv6                          | covered by the same table (every packet of the user is rejected)                         | **not covered by an `ip` table**: switched off, and proven off (below)                                                             |
  | Startup log line              | `egress rules: full (inet)`                                                              | `egress rules: fallback (ip, ipv6 disabled)`                                                                                       |

  The policy is the same in both: the engine user reaches the job's model proxy and its own server
  port on loopback and nothing else; a refused attempt and a dropped one are both "not reached".
  Nothing about a host that has `inet` changes: it gets the full ruleset, byte for byte as before.

  **IPv6 in fallback mode.** The startup step (after the rules are installed) writes `1` to
  `net.ipv6.conf.{default,all,<each interface>}.disable_ipv6` as far as the container lets it. A
  container's `/proc/sys` is normally read-only, so the container spec of such a host must set
  `net.ipv6.conf.all.disable_ipv6=1` and `net.ipv6.conf.default.disable_ipv6=1` itself (for Docker
  `--sysctl`); the runner does not fail on a refused write but on the
  proof, which it takes from the kernel and from the engine user: every `disable_ipv6` reads `1`,
  `/proc/net/if_inet6` is empty, `/proc/net/ipv6_route` has no route that can carry a packet (the
  kernel's always-present "unreachable" entries do not count), `::1` cannot be bound, and as the
  engine user an IPv6 `connect` and `sendto` to `::1` and to a documentation address end in
  `ENETUNREACH`, `EADDRNOTAVAIL` or `EAFNOSUPPORT` (a refusal or a timeout is no proof: a working
  loopback refuses a closed port and a dropped packet times out). The proof is part of the startup
  self-check (`ipv6_not_disabled`, below) and runs again before every engine of a job. A dual-stack
  socket's `::ffff:a.b.c.d` traffic is IPv4 on the wire and meets the table like any other.
  If it cannot be proven, `opencode` is not advertised and the log says what to set.

  **How a test forces the fallback.** On a complete kernel the fallback is never chosen, so the
  privileged suite passes a `detect` argument to the startup step (`secure_startup(..., detect=...)`),
  the same kind of seam as its `install` and `drop` arguments. It is a Python argument, not an
  environment variable, a setting or a job field: nothing in the runner passes it (a unit test scans
  the sources for that) and the Worker never reads the mode from its environment. The Worker hands the
  mode it found to the Dynamic job process (`RUNNER_EGRESS_MODE`, set by the Worker alone and
  dropped from the container's own environment), which proves the properties of that mode again; a
  missing value means the full mode and an unknown one stops the job. The suite's fallback pass sets
  its own harness variable (`CR_PRIVILEGED_EGRESS_MODE`) that only the test files read. The tests of
  the rules run for both rulesets, and the full ruleset's assertion of an immediate refusal is kept
  as it was; the fallback accepts a refusal or a timeout there.

- **Cleanup.** At the end of a job, on SIGTERM (the Worker's way to end a job on lease loss,
  shutdown and timeout) and in the watchdog, the supervisor kills the engine's process group and then
  every process of the engine user, also helpers that left the group with `setsid()`, removes the
  user's processes and deletes the job directory (the rules are static and stay; the lease on the user and its group is released with the
  process). A job that was killed without a chance to clean up (SIGKILL, an OOM kill) leaves its
  engine user's processes behind; the Worker (root) sweeps the user after every Dynamic job process
  has ended, and every job sweeps it again as its first step after taking the lease. If a sweep cannot
  finish, the next job does not start (`dynamic_isolation_self_check_failed`).
  A second Dynamic job on the same user is refused by the lease with the same code: run one Dynamic
  job at a time per engine user.
- **`NET_ADMIN` is held during startup only (#244).** The container is created with `NET_ADMIN` and
  `SETPCAP` because the capabilities of a container are fixed at start. The runner's entry point
  installs the static rules, then drops both from the bounding set and from its own sets, before its
  event loop and before any other thread exists (a runner that cannot confirm the drop does not
  start). From then on the Worker, every job process, the supervisor and the engine have a bounding set
  without them: `nft` fails for all of them, root included, and no process can add or remove a rule
  for the life of the container. It is per container, not forever: a new container starts
  with `NET_ADMIN` again, so what a restart runs must not be
  changeable by a compromised root supervisor. That is what the read-only root filesystem is for
  (next item, #249).
  If the rules cannot be installed (no `nft`, no `nf_tables` at all) the capabilities are dropped anyway and
  every Dynamic job fails with `dynamic_isolation_self_check_failed` while Diff jobs keep running.
  The fixed slot ports are checked at startup against the kernel's ephemeral port range
  (`/proc/sys/net/ipv4/ip_local_port_range`); a port inside it, or a range that cannot be read,
  means the rules are not installed and every Dynamic job fails closed. Keep the defaults (10180, 10181) or other ports below the range.
  Only PID 1 (`tini`) keeps them. Do not run the container with `seccomp=unconfined`.
- **Read-only root filesystem (#249).** the hardened container spec runs the container with
  `--read-only`: nothing in the image can be written, not even by root with `DAC_OVERRIDE`, so
  `nft`, `tini`, the pinned tools and pins, and the runner source stay as built and a restart cannot
  run altered code with `NET_ADMIN`. The only writable paths are three private `tmpfs`, all
  `noexec,nosuid,nodev`, empty again after every restart: `/tmp` (512 MiB, world-writable with the
  sticky bit as before: job working directories, the per-job export, the engine's HOME, XDG and
  TMPDIR), `/run` (1 MiB, root only: the identity leases) and `/home/runner` (64 MiB, owned by the
  Diff job user 10001, mode 0700: its HOME). The engine user (10101) has **no new write path**: `/tmp`
  is what it could write before, `/run` and `/home/runner` are closed to it, and the rest of the
  filesystem is read-only (besides Docker's own `/dev/shm`, as before); the image smoke test checks
  this against the same image without the layout. The three files Docker binds into `/etc`
  (`hosts`, `hostname`, `resolv.conf`) are read-only too under `read_only`, which the image smoke
  test checks. Because a tmpfs is
  charged to the container's memory limit, `/tmp` counts against the 2 GiB (see "Capacity"): a
  repository export is limited to 64 MiB, a preparation to 256 MiB and a download to 256 MiB (#296), but a runaway engine that
  fills `/tmp` takes memory, not disk, and ends in the OOM kill of the job, bounded at 512 MiB. Do
  not add `volumes` or widen the tmpfs; the file test pins them. Every Worker, Diff or Dynamic, runs in it.
- **Nothing mounted, nothing shared.** Besides those three tmpfs, the spec has no
  `volumes`, `network_mode`, `pid`, `ipc` or Docker socket (a file test fails otherwise); do not add any. The rules do not cover
  AF_UNIX, and this is what keeps that gap empty. The privileged suite reads `/proc/net/unix` as the
  engine user and asserts that no listener other than its own exists and that no Docker socket is
  present.
- **What it does not give.** The engine can still reach a service on `127.0.0.1` that belongs to the
  engine user itself, a Unix socket (abstract or on a path) of the container's network namespace if
  one is ever added (none exists, see above) and anything the supervisor deliberately exposes
  there. The two ports are fixed, so a stranger holding one makes the job fail closed. With a concurrency above one the users and groups are leased
  per job (the image would need one pair per slot); the default is one slot.
- **Proof.** `runner/tests/privileged` runs as root with exactly the capability list above, in a
  startup phase (the container's created-with set) and a job phase (after the production startup
  step) (TESTING.md, "Privileged suite"); its CI step is part of the engine workflow.

## The Worker image

`runner/Dockerfile` builds one image, the `sandbox` target, the Worker image of the hosted deployment (the golden
snapshot builds it). Besides PR-Agent it holds:

| Part                                                                                  | Where                                                                                           | How it is pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock OpenCode v1.19.0 (about 186 MB, 60 MB compressed), unmodified                   | `/usr/local/bin/opencode`, owned by root, mode 0755                                             | `runner/opencode-pin.json`: release asset, source commit, size and SHA-256 of the archive and of the executable. The build downloads through `runner/scripts/fetch_opencode.py`, which accepts only the pinned bytes and checks that the executable reports the pinned version                                                                                                                                                                                                                                                           |
| ripgrep 14.1.1 (static musl release)                                                  | `/usr/local/bin/rg`, owned by root, mode 0755                                                   | `runner/ripgrep-pin.json`, same checks (`runner/scripts/fetch_ripgrep.py`). The engine's grep and glob need it; without one the stock engine would download it at run time, which the runner never allows                                                                                                                                                                                                                                                                                                                                |
| `nft`                                                                                 | Debian's signed `nftables` package                                                              | Not pinned, by decision: `apt` installs the version Debian's repository has at build time (like `tini`), so it does not follow the base image digest and two builds on different days can differ. An exact `nftables=<version>` would not be reproducible either, because the Debian mirrors drop superseded versions and the build would break at the next point release. The package is signed, root-owned and has no setuid file (the smoke test measures that). It installs the engine user's network rules once, at container start |
| The engine user `engine` (uid and gid 10101, no home, no login shell, no other group) | `/etc/passwd` of the image                                                                      | Fixed numeric ids, distinct from the Diff job user 10001                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| git 2.53.0, built from the pinned source (the Implementer's agent, #761)              | `/usr/local/bin/git`, `/usr/local/libexec/git-core`, owned by root                              | `runner/git-pin.json`: source tarball, size and SHA-256, `scripts/fetch_toolchain.py`. Built in its own stage because Debian's git is older than the 2.53 the branch guard needs; Debian's `git` is never installed                                                                                                                                                                                                                                                                                                                      |
| Node.js 24.22.2 and pnpm 10.17.0 (#761)                                               | `/opt/node`, `/opt/pnpm`, linked into `/usr/local/bin`, owned by root                           | `runner/node-pin.json`, `runner/pnpm-pin.json`, same checks; the installed `node` and `pnpm.cjs` equal the pinned executable digests (image smoke test)                                                                                                                                                                                                                                                                                                                                                                                  |
| uv, `gcc`, `g++`, `make`, `jq`, `unzip` (#761)                                        | `/usr/local/bin/uv`, Debian's packages                                                          | uv from the digest-pinned uv image; the Debian tools are not version-pinned, like `nft`. No `build-essential` (its `dpkg-dev` and Perl add about 50 MB nobody needs here)                                                                                                                                                                                                                                                                                                                                                                |
| The branch guard (#761)                                                               | `/opt/code-reviewer/guard/` (`reference-transaction`, `guard_matrix.sh`), root-owned, mode 0755 | Nothing baked in: no `core.hooksPath` in any config of the image. The Worker sets it per job through `GIT_CONFIG_SYSTEM` (root file system read-only); the image smoke test runs the matrix as the engine user                                                                                                                                                                                                                                                                                                                           |
| Both pin files                                                                        | `/opt/code-reviewer/pins/`, owned by root                                                       | The runner's self-check compares the installed files with them                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**The toolchain layer (#761) and what it costs the reviewer.** The Implementer's agent builds repositories inside the Worker container, so
the same image now also holds git, Node.js, pnpm, uv and a compiler. It grew from 999 MB to 1,489 MB of layers (+490 MB; compressed content
264 MB to 436 MB, +172 MB), of which Debian's compilers are 254 MB, Node.js 148 MB, git 22 MB, uv 45 MB and pnpm 22 MB. That is below the
budget of 600 MB (tightened from the issue's 900 MB after the first measurement: 471 MB in CI, 490 MB locally); the image smoke test prints the growth and fails above it, and the answer to a failure is a per-kind image,
not a heavier shared one. Diff and Dynamic jobs use none of it and start the same way: the size matters for the golden snapshot, not for the
container start (`docs/golden-snapshot.md`).

**One image for both engines.** The engine adds about 186 MB, and `nft`, `rg`, a second user and a deployment shape that needs root and eight capabilities are what a Dynamic job needs; a Diff job runs in the same image (as the Diff job user 10001, never as root) so that the snapshot holds one image. The Worker advertises `opencode` only when its startup self-check passes, and its smoke test asserts the tools, the users and the pins. The image starts as the unprivileged user 10001 and becomes a root supervisor only through the container spec (`user: "0:0"` plus the capability list).

**What is trusted.** The build downloads from GitHub release URLs and accepts the bytes only if they
equal the pinned size and SHA-256; at start the runner hashes the installed files again. Nothing at
run time downloads anything (no `curl`, no package manager, no model-catalog fetch, no repository
plugin discovery). The checksums say the files are the ones that were pinned, not that upstream is
free of defects. `make check-licenses` audits the licences of the two binaries and of the runtime
dependency closure of OpenCode's Bun lock at the pinned commit (`runner/opencode-bundled-licenses.json`);
that closure is an upper bound of what Bun's bundler embedded, because the embedded set cannot be
read from the binary offline.

## The startup self-check

When the Dynamic runner starts it first installs the engine user's static network rules and drops
`NET_ADMIN` and `SETPCAP` for good (ADR 0003), then runs this check **before its first claim**, and
only then does it send `opencode` in the claim. Every failure is "not advertised": the runner logs a
stable reason (never a value) and keeps serving Diff jobs.

| Reason (in the log)                                            | What did not hold                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_a_dynamic_runner`                                         | No engine user is configured: this is the default runner (information, not a warning)                                                                                                                                                                                                                                                                         |
| `not_root_supervisor`                                          | The process is not root; the container spec sets `user: "0:0"`                                                                                                                                                                                                                                                                                                |
| `engine_user_invalid`                                          | The engine user does not exist with its own group, or is root. Image users are 10101; do not change `RUNNER_DYNAMIC_ENGINE_UID`/`GID` without a matching image                                                                                                                                                                                                |
| `network_rules_not_installed`                                  | `nft` could not install the rules: no `NET_ADMIN` at container creation, no `nf_tables` in the host kernel (a kernel with only the `ip` family gets the fallback ruleset instead, #345), no `nft`, or a slot port inside the kernel's ephemeral range                                                                                                         |
| `capabilities_not_dropped`                                     | The process still holds `NET_ADMIN` or `SETPCAP`                                                                                                                                                                                                                                                                                                              |
| `root_filesystem_writable`                                     | Only the entry modes `worker-once` and `probe` (#324) ask for it: the root filesystem is not read-only, so this is no container made from the hardened container spec. The legacy loop does not check it                                                                                                                                                      |
| `ipv6_not_disabled`                                            | Only with the fallback ruleset (#345): IPv6 is not proven off for the engine user (a `disable_ipv6` setting is not `1`, an IPv6 address or a usable route exists, `::1` can be bound, or the engine user's IPv6 attempt did not end in a "no IPv6" error). Set `net.ipv6.conf.all.disable_ipv6=1` and `net.ipv6.conf.default.disable_ipv6=1` on the container |
| `pin_unreadable`                                               | A pin file in `/opt/code-reviewer/pins/` is missing (or a directory above it is), malformed or has no entry for this platform (an x64 image started on arm64)                                                                                                                                                                                                 |
| `pin_untrusted`                                                | A pin file, or a directory above it up to `/`, is a link, is not owned by root or can be written by group or others                                                                                                                                                                                                                                           |
| `engine_binary_missing`, `ripgrep_missing`                     | The file (or a directory above it) is absent, the file is a link, or not executable. This is also what an image **built on arm64** reports: the build installs no engine where there is no pin (#264), so the image builds and the runner serves Diff jobs only                                                                                               |
| `engine_binary_untrusted`, `ripgrep_untrusted`                 | The file, or a directory above it up to `/`, is not owned by root, is a link (directories) or can be written by group or others                                                                                                                                                                                                                               |
| `engine_binary_checksum_mismatch`, `ripgrep_checksum_mismatch` | Size or SHA-256 differ from the pin                                                                                                                                                                                                                                                                                                                           |
| `engine_version_mismatch`                                      | Run offline as the engine user, the engine does not report the pinned version                                                                                                                                                                                                                                                                                 |
| `network_probe_failed`                                         | A probe run as the engine user could not reach the slot's proxy port, or could reach something else (another loopback service, another address, UDP). Also: a stranger holds the proxy port                                                                                                                                                                   |

The full log line is `Dynamic Review: opencode is not advertised, this runner serves Diff jobs only
(dynamic_isolation_self_check_failed: <reason>)`; a passing check logs `Dynamic Review: opencode is
advertised, the startup self-check passed (egress rules: full)` (or `fallback`, #345). A successful `--version` is one item of the list and
proves nothing about isolation; what cannot be known at start (the sealed read-only export, the
unreadable private state, the network again) is proven for every job before its engine starts, and a
failure there ends that job with `dynamic_isolation_self_check_failed`.

The Worker hands the job process of a Dynamic job the engines it advertised, the verified engine
command, the verified `rg` (the engine runs exactly that file, first on its `PATH`) and the
operator's `RUNNER_DYNAMIC_CAPABILITIES` (a ceiling for the descriptor the job brings, #279); nothing an operator sets under `RUNNER_OPENCODE_COMMAND`,
`RUNNER_DYNAMIC_RIPGREP` or `RUNNER_ADVERTISED_ENGINES` reaches a job. A Dynamic job that arrives at
a runner without `opencode` in that list is refused with `dynamic_engine_unavailable`.

## The passthrough proxy of native providers (#550)

The legacy proxy (`proxy.py`, `anthropic_wire.py`, `provider_wire.py`) speaks OpenAI Chat to the engine and
translates to the provider (OpenRouter, Anthropic). A **native job** is different: the engine speaks its own wire
family to a loopback proxy and the proxy only authenticates, swaps the key, relays and counts
(`dynamic_review/passthrough/`, design #544, decisions of 2026-10-19). The legacy path stays the production path
until #556 removes it; a job with a per-job model entry (`contracts/job-model-entry.v1.json`, #548) is native, any
other job is unchanged (`passthrough/transport.py`). Key isolation is as today: the real key lives in the
supervisor; the engine holds a random per-job capability and cannot reach the upstream (own uid, nftables).

What the proxy decides, before a byte is reserved or forwarded (`passthrough/admission.py`; the engine is the
untrusted side):

- **Who.** The job's capability in the one header of the family (`authorization: Bearer`, `x-api-key`,
  `x-goog-api-key`), exactly once, constant-time. Otherwise 401 and nothing else is looked at.
- **What.** One method and one path per family, compared as plain text: `POST /v1/chat/completions`,
  `/v1/responses`, `/v1/messages`, and for Google `/v1beta/models/<the job's model>:streamGenerateContent?alt=sse`.
  No other query (`?key=` included), no `..`, `;`, second `?` or absolute URL, no `GET`. Anything else is a 403
  `request_not_allowed`, a Google path for another model is `model_not_allowed`.
- **How.** Request headers are built from an allow-list (`accept`, `content-type`, `user-agent`, the three
  `x-*session*` headers; for Messages `anthropic-version` and `anthropic-beta`, whose values must be on a list: the two
  the pinned OpenCode sends). Every credential, cookie and proxy header is dropped; the proxy sets the one key header
  of the family, `content-type: application/json` (the engine's is checked, then dropped, so no parameter of its choosing
  reaches the provider), `accept-encoding: identity` (the tee cannot read a compressed answer) and the length itself. The
  body length must be measurable before it is read (a chunked body is a 411, one above `max_request_bytes` a 413).
- **The body.** Read as JSON and walked against a **closed schema per family** (`passthrough/body_schema.py`): the
  keys the pinned OpenCode sends (`fakes/wire/engine_requests.json` is one captured body per family), compared
  case-sensitively, and nothing else, also inside messages, tools and options. `model` must be the job's (else 403
  `model_not_allowed`); exactly one spelling of the output cap, within `min(limit.output, 32000)` (the cap the engine
  really sends, spike #546), and a second spelling (`max_tokens` with `max_completion_tokens`, a snake-case
  `generation_config`) is refused whatever its value. Tools are function tools only (Chat/Responses `type: function`,
  Messages none or `custom`, Google `functionDeclarations`); no web search, code execution, MCP, computer use,
  `mcp_servers` or `container`. Content parts are text, the tool exchange of the family and the engine's reasoning
  blocks; **no image, audio, file or document part at all** (the model entries are text-only; a part that can carry a
  URL is a part the provider can fetch). `stream` is present and `true` (the engine always streams; a non-stream call is refused), `n` and `candidateCount` are 1, `store` is `false`, a number is finite and no larger than 2^53, Google's `thinkingBudget` is within the allowance, `cache_control` has no `ttl` (a 1-hour write needs its own price, #553); no `service_tier`,
  `background`, `previous_response_id`, `cachedContent`, `metadata`, `response_format` or OpenRouter routing. A key
  given twice and a non-object are refused. The walk only checks: the bytes that go out are the bytes that came in.
  What the engine sends for a provider that no capture has covered fails closed as `request_not_allowed`, and its key
  joins the set once a live capture shows it is the engine's (spike section 7). The schema lets numeric sampling
  options through (`temperature`, `top_p`, `top_k`, Google's `generationConfig` twins), which `ProviderTransform`
  sets for some model ids; they are not in the captures and are an item of the live checklist (L12).
- **One call at a time.** The engine's calls are serial. A second request while one is in flight is a 429
  `call_in_flight` with `retry-after: 1`, answered before anything is reserved or sent: not a call, no reason to end
  the run (it comes after the capability check, so a stranger only ever sees 401). It is refused and not queued: a
  queue is something a hostile engine can fill, the engine retries a 429 by itself, and a refusal needs no thread to
  wait and no deadline to track.

The refusal codes are the engine's answer (`capability_invalid`, `request_not_allowed`, `model_not_allowed`,
`request_too_large`, `length_required`, and `call_in_flight`, which ends nothing); the run records `dynamic_policy_violation` (a 413: `dynamic_budget_exceeded`),
except for a 401, which is not the engine of this job and ends nothing.

**The destination** (`address.py`, `upstream.py`). One trusted `https` base URL per job, port 443 only, no
credentials or query; it follows the SDKs' convention (the root they use as `baseURL`, for example
`https://api.openai.com/v1`) and the route of the family is appended. Every call opens its own connection, resolves
the name, refuses it when **one** address is not public (loopback, private, link-local, CGNAT, multicast, reserved,
documentation and special-purpose ranges, NAT64, 6to4; an IPv4-mapped address by its IPv4) and connects to an address
it checked, never to the name again. A redirect is a status: it is not followed and ends the run.

_Address rules._ They are those of `app/src/billing/public-url.ts` (the edges of every range are in
`test_passthrough_destination.py`), with one deliberate difference: the app judges NAT64 `64:ff9b::/96` and 6to4
`2002::/16` by the IPv4 address inside them, this guard refuses them whatever it is. A provider is not behind either,
and a translator routes to whatever its prefix says, so the check of the embedded address would only be a way to be
wrong. Everything the app refuses is refused here too.

_Waits._ Every wait is bounded by the budget of the call (the smaller of 120 s and the time the job has left; a call
with none makes no lookup and no connection): the name lookup runs in a thread that is given up on (`getaddrinfo` has
no timeout; at most one call is in flight, so a hanging resolver costs one idle thread), each connection attempt gets
what is left of the budget after the attempts before it, the TLS handshake what is left after the connection, then
the socket timeout is set again before **every** read of the answer (the call's budget or what the job has left,
whichever is less; the body of an error and a document included). On the engine's side of the loopback socket (`server.py`) a connection that says nothing is
closed after 5 s (one that has been served may idle for 30 s), reading a body and writing an answer each wait at most 60 s and never longer than the job has left
(a timeout there is an engine that went away), and no more than 16 connections are served at once; one over is closed
at once.

**Ledger.** `budget.py` is reused as it is: every upstream call reserves from the bytes of the body and what the run
has shown (realistic guard, #540/#542), the final-call exemption and "never without a review" rules unchanged. The
engine's retries (429, 5xx, a stream cut, an error event inside a 200 stream) are calls of their own. How a call is
settled:

| What happened                                                                                                                                                                                                                                                                                                      | Settled as                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a complete answer with usage and a price                                                                                                                                                                                                                                                                           | the provider's usage and the price (`settle_call`; a usage above the reservation is **booked first**, then the run stops)                                                                                                                                                                      |
| the provider refused with a 4xx (not 408), a 429, or a **500, 502, 503 or 529 that is only a status** (all of: the status line came within 15 s of the request, the content type is not `text/event-stream`, and the bounded body, read whole, states no usage object), a redirect, a connection that never opened | unbilled: the reservation is released (`settle_unbilled`)                                                                                                                                                                                                                                      |
| 408, 504, 524, a status below 200, any other status, a 500/502/503/529 that fails one of the three conditions, every error **after** the first byte of a stream or body (a cut stream, an error event in a 200), a timeout after the request went out, an encoded body                                             | **unknown**: counted in `unknown_calls`. Managed key: booked at its **worst case** (`settle_unknown`) and the run ends (`dynamic_accounting_failed`). Own key: booked at what it was **expected to cost** and its expected tokens, and the run goes on (see "The cost policy of a native job") |
| a complete answer without a readable usage (none stated, a bad value, a stream that stopped before its usage event)                                                                                                                                                                                                | the call is unknown, and the run ends for **every** key: with no tokens to count, the token cap cannot apply                                                                                                                                                                                   |
| a usage that lists a field nobody can price (`unknown_fields`: an unknown field that holds something, `server_tool_use`, audio, a `service_tier` other than the standard one, a second choice) or that cannot be priced from the book                                                                              | managed key: **unknown** as above and the run ends. Own key: the tokens the provider stated are booked against the cap, the cost of the call is unknown, the run goes on and `price_risk` (a count, with the names of the fields, never a value) is logged                                     |

The worst case of a call is the bytes of its request, each as a token at the dearest input price (the byte count bounds
the tokens), plus the whole output cap at the output price (`BudgetLedger.worst_case_cost`). An engine that can make
a call's usage unreadable must not make the call free, so a call that may have been billed and was not read ends a
managed run (an own key goes on, see "The cost policy of a native job"). _Why a 500/502/503/529 status is not such a call:_ it arrives as a status line before any byte of an
answer, so the provider failed the request before it generated anything, and the providers do not bill that (a
transient overload is the commonest event of a long run, and the engine retries it as a call of its own). It is
trusted only while it looks like that: a status line that took more than 15 s, an event-stream content type, or a body
that states a usage (JSON with a `usage`/`usageMetadata` object anywhere, or, for a body that does not parse, the word
`usage`; a body longer than the bound or cut counts too) means the provider may have been generating. A timeout
status (408, 504, 524) and anything after the first byte of a stream or body say the provider may have been generating,
so they stay unknown. The assumption is unproven for real providers and is item L13 of the live checklist. The hook
of the cost policy is `PassthroughProxy(unknown_cost_ends_run=)`, set from the claim's `dynamic.cost` (`cost_policy.py`, below). The
whole-run cost stays unknown after any unknown call (`usage.cost_usd` is `None`), never a partial sum.

**A hang-up does not hide a cost.** When the engine disconnects mid-stream, the call to the provider is **not**
cancelled at once: the proxy stops forwarding but keeps reading the stream into the tap to the end of the answer (bounded by the
byte bound, the deadline and the per-read timeout), and then settles the call normally. Cancelling at once would let a hostile engine
turn any call into an unknown (or free) one by hanging up after the first event, and an unknown call is booked at its
worst case and ends a managed run. If the usage still cannot be read, the call is unknown as above.

**Relay and tee.** The answer is passed through byte for byte: a stream one whole event at a time as it arrives
(`sse.py`), while the usage tap (`usage.py`, hardened in #551, see "The usage parsers" below) reads the same bytes.
The bound of a stream is the larger of `max_stream_bytes` (1 MiB) and **256 bytes per output token the request asks
for**, up to 8 MB for the 32000-token cap: an event per token costs about 100 bytes of framing. An answer that is not
an SSE stream is a document: it is read whole up to `max_response_bytes` (256 KiB), settled, then sent with its length
(a long-lived non-SSE stream such as JSON lines is therefore not streamed; none of the four families answers a
streaming request that way, and one that does is cut at 256 KiB and ends the run). Response headers of a successful
answer are filtered to a few (`content-type`, `retry-after`, `retry-after-ms`, `x-should-retry`, the request id).

_What the engine is told about an error, and why redaction is not used on content._ If the proxy cut the key out of
what the provider answers, an engine that writes guesses of the key into its output would see the cut where a guess is
right: the proxy would be an oracle, one character run at a time. So **a successful answer is never changed**.
Redaction (`redact.py`: the key and any run of eight or more characters of it) is used only on what no model writes:
the headers of a successful answer. An error event inside a 200 stream (an `error` event, or JSON with an `error` key,
`type: error` or `response.failed`: decided by the provider's structure, never by the model's words) is **replaced by a
fixed event of ours** (`fixed_error_event`, one per family, the shapes of the fakes), and a 200 document that is an
error by a fixed document: nothing the provider wrote is passed on, so an event cannot be an oracle either. The tap still
reads the original bytes, so the call is settled as unknown. The engine retries a fixed chat event as it did the
provider's (engine test); the types in the fixed events of the other families are what a live capture (L7) has
to confirm. For a non-2xx answer the provider's body is read locally (to tell a too-long request from other refusals,
and to see whether it states a usage) and **not passed on at all**: the engine gets the status, a code and a sentence
of the proxy's own, and the plain-number `retry-after` and `retry-after-ms`, nothing else.

_An exception after the request was sent._ Whatever breaks while an answer is relayed (a bug, an unreadable shape) the
call may have been billed: it is booked as unknown (once: the ledger settles a reservation a single time, so an error
handler after the normal path books nothing twice), the engine's connection is dropped, and the run ends with
`dynamic_accounting_failed` and not with a generic `runner_error`. Neither code is retried by the app (only
`runner_shutdown` is given back to the queue; both are free of charge for the member), but the first says in the run's
copy that the usage could not be accounted for. An event nested deeper than the JSON parser goes is unreadable, not a
crash.

**The usage parsers (#551).** One parser per family behind the tap, each for a whole document and for a stream,
each returning the same typed `CallUsage` (`call_usage.py`: prompt, completion, cache read, cache write 5-minute and
1-hour, reasoning, the charge the provider states, `unknown_fields`, `complete`). The prompt counts the cache and the
completion counts the reasoning. Where the usage sits: Chat, the last data chunk with `usage` (OpenRouter's `cost` and
`cost_details`, DeepSeek's `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`); Responses, `response.completed`;
Messages, `message_start.usage` plus `message_delta.usage` (the output of `message_start` is a placeholder, so a
stream that stops without a `message_delta` that states `output_tokens` is not complete); Google, `usageMetadata` of
the last chunk or cumulative on every chunk (the last one, never a sum, and it must be at or after the chunk that
finishes). Only the structure of the answer counts: the usage is read from that one
place and never from a value the model wrote (text and tool arguments are JSON strings or sit below a key no usage is
read from), and an event of a kind that carries no usage is not looked at for one (`#551-T13`).

Fail closed, all of it (`usage_normalize.py`):

- A count the family must state (prompt, completion) that is missing, negative, boolean, fractional, textual or above
  10^12 makes the usage unreadable: no usage, never zero. A count the provider may leave out as a zero (cache, reasoning)
  is zero when absent; a bad one, one above what it is part of (a cache above the prompt, reasoning above the
  completion) or a split that disagrees with its total (the Messages `cache_creation` against
  `cache_creation_input_tokens`, DeepSeek's hit and miss against the prompt) puts the field in `unknown_fields`.
- A field the parser does not know whose value holds something (anything but null, false, zero, empty text, list or
  object) is in `unknown_fields`: it could carry a price. A zero of a kind we do not price costs nothing, so OpenAI's
  `audio_tokens: 0` is harmless. Known and harmless: totals, OpenRouter's `cost_details`, a `service_tier` of
  `standard` or `default` (any other, priority, flex, batch, is unknown), the legacy cost rule's Anthropic fields
  (`speed`, `inference_geo`, `server_tool_use` and `iterations` when empty or zero, as in `anthropic_cost.py`), and
  Google's per-modality breakdowns when only text carries tokens. Names are logged (`usage_report.py`), values never.
- **A usage only grows, and a call has one** (review of PR #569). Chat states its usage once, in the finish chunk or
  after it: one before it, or a second one (whatever it says), is unknown (S1, S2). Responses has one terminal event
  (`response.completed` or `incomplete`); a second one, also a `failed`, is unknown. Messages has `message_start` first
  and exactly once, `message_delta` only after it, and nothing but a `ping` after `message_stop`; a repeated or
  misplaced event is unknown. Whatever a later statement of the same call (a Messages delta, a Google chunk) states
  less of than an earlier one, or, for Google, leaves out of a count that was there, is unknown: a usage that goes
  backwards is not the usage of one call. The unknown fields and the service tier of **every** statement count, the
  union over the stream; a later event cannot overwrite what an earlier one revealed. These marks are named
  `usage_events` and `usage_backwards` in `unknown_fields`.
- A **total** the provider states (`total_tokens`, `totalTokenCount`) must be the sum of the counts of the family
  (Chat and Responses: prompt + completion; Google: prompt + candidates + thoughts + tool use), else the counts are not
  what the provider bills and the call is unknown (S5). xAI's reasoning tokens on top of the completion
  (`total_tokens` above prompt + completion) are exactly this case. Extra fields of the chat providers of the catalog
  that are harmless but not zero (xAI `prompt_tokens_details.text_tokens`, Groq's `queue_time`, `prompt_time`,
  `completion_time`, `total_time`) are **not** on the list of known fields: no official documentation of them is
  at hand (Groq shows them only in an example response), so they stay unknown until the live test (L14) shows them.
- The tap never fails the relay: nothing in it recurses over what the provider sent (a value nested thousands deep
  is read iteratively; JSON nested deeper than the parser goes is unreadable), and a normalizer that did raise
  `RecursionError` would make the call "no usage".
- More than one choice (`choices[1]`, a second candidate, an `index` that is not 0) is a usage the proxy cannot
  attribute to the request: unknown, never summed.
- `error: null` (some providers send it in every chunk) is not an error; an object, or text or a count that says
  something, is. A Chat choice that finishes with `error` is an error.
- An answer that was cut, failed, or never stated its usage is `complete = false` or has no usage, and the call is booked
  at its worst case (the ledger's `unknown_calls`), never free.

Pricing is `pricing.py`, from a price book in the form of #549 (`price_book.py` reads the JSON that
`service.availability` hands out, as strictly as the app does: `fakes/fixtures/price-books.json` is read by both
readers' tests). Prices are whole micro-USD per million tokens as Python ints, the cost is an exact `Decimal` (counts
times a price is a whole number of 10^-12 USD; no float and no rounding), and a call that needs a price the book lacks
has no cost, and a call without a cost is **unknown**: booked at its worst case, counted in `unknown_calls`, a managed
run ends (an unpriced 1-hour write, a tier without the price of a write, two tiers of one size that disagree; S3). A
tier applies to a prompt strictly above its size with that level's own prices (the older
`context_over_200k` is the tier of 200,000); reasoning tokens cost the reasoning price, or the output price when there
is none; a cache read without a read price costs the input price (an upper bound), a cache write without a price of
its kind (5-minute or 1-hour; a tier states no 1-hour price) has no cost. A charge the provider states (OpenRouter's `usage.cost`) is
held against the price the book expects for the same call, and **the dearer of the two is booked** (S4); beyond 1 % (and
1 micro-USD) either way it is counted as `price_drift` (`PassthroughProxy.price_drift_calls`, logged as a count). A
stated amount **more than 10 times below** the book's price (zero, `1e-300`, anything that is not a price for that
many tokens) is not believed and not booked: the call is unknown. A call the book cannot price is unknown even when a
charge is stated, since there is nothing to hold it against. The worst case of an unknown call (`worst_case_cost`) is
priced from the book too (N8): every byte of the request as a token of the dearest kind of input (plain, a cache read,
either write), every output token at the dearer of output and reasoning, at the dearest tier the request can reach
(a tier may be cheaper than the level below it, so the base counts as well). A native job prices from the book its claim carries (#553, below); until the
wiring runs a job that way, the proxy reads a per-job `UnitCosts` as a one-level book (a price finer than a micro-USD is rounded up,
never down; `cache_write_1h_usd_per_mtok` is new). Every shape of the book is table-tested against an independent calculator
(`runner/tests/usage_calc.py`).

What a real answer may still show differently is **unconfirmed** and marked in the code (`UNCONFIRMED`) and as item L14
of the live checklist in `docs/spike/544-passthrough.md`.

**Stable codes the caller branches on.** A provider status maps by the table of the legacy path (`llm_auth`,
`llm_rate_limit`, `llm_unavailable`, `llm_timeout`, `llm_context_length_exceeded`, `llm_bad_request`); a 404, and the
engine's own "500 `UnknownError` with no call upstream" for a model its config does not offer
(`engine_errors.model_not_found_for_turn`), is `model_unknown`. Status that the engine retries itself (408, 409, 429,
5xx) do not end the run by themselves (a 408/504/524 is an unknown call, see the ledger); the code is kept in `PassthroughProxy.last_upstream_error` for the adapter to name when the
engine gives up. Everything else ends the run with its code, the text of the provider in none of it.

**Not in this change** (follow-ups): the audit of tool results in a request (it is chat-shaped; since #552 the adapter counts
them from the engine's own event stream), how a final call is told to answer without rewriting the request (done in #552, see
"Finalization above the wire") and the live capture that replaces the assumed usage shapes (L14). Reading a job's entry from
the claim and starting the engine with the native config is the wiring of #578, see "The native path of a job".

### The native path of a job (#578)

`dynamic_review/native_job.py` joins the pieces above for one job; `runner.py` keeps its own flow (the same checks before, the
same conclusion after, `_conclude_dynamic_job`). A job is **native** when its claim carries `dynamic.modelEntry` (the
`JobModelEntry` of `contracts/job-model-entry.v1.json`) next to `dynamic.cost`; the runner has no switch of its own, it follows
the claim. Both are read strictly (`job.py`): an entry without a cost policy, an entry whose model is not `dynamic.model`, or
whose provider is not the provider of `llm.provider` (the underscore of a slug is the hyphen of the id; the key goes to the
entry's address, so the two must agree) is a refused job. A cost policy without an entry is refused as before (#553). A job with
neither is a job of today and runs through `ModelProxy` exactly as before.

**Where the key goes.** The key of a provider the runner's registry has (`llm_providers.py`: `anthropic`, `openrouter`) is that
provider's own, and the legacy path always sent it to the registry's `default_api_base`. The native path reads the address from the
entry, so it is pinned: `entry.upstreamBaseUrl` must equal the registry's address (a trailing slash aside, nothing else), else the
job is refused before any key is used, in `parse_job` (`invalid_job`, "dynamic.modelEntry.upstreamBaseUrl is not the address of the
provider") and again in `build_native_job` (`dynamic_config_invalid`, before an upstream is made). The app refuses the same case
at the claim (`entryFor`: `upstream_not_registry`, `reason=entry_upstream_not_registry` in the log; `managed_model_unavailable` on
the operator's key, `dynamic_model_features_unsupported` on an own key), against the addresses of its own registry
(`app/src/native-cost/registry-addresses.ts`).

A provider the registry has no entry for (the BYOK providers of #555, any provider of the models.dev catalog the pinned engine can
drive with a static key) has no address in the code. Its key goes to the address the app's catalog **trusts** for it (#548) and
to none a workspace could type: the claim carries that address in the entry, and the app refuses to build an entry from a
provider that is not trusted (`url_changed`, `rejected`) or whose stored address is not a plain public https address in one exact
spelling (`upstream_invalid`). The runner re-checks what it can see (`passthrough/destination.py`, `key_destination`, in
`parse_job` and again in `build_native_job`): the entry is of the provider the key is for, the address is a plain public https
address (port 443, no credentials, no query, a public name or IP, a plain path) **in exactly that spelling**, so the string the app
judged is the string it connects to; the job then carries no `llm.baseUrl`, `llm.requireParameters` or `llm.fallbackModels`. Every
connection resolves the name, judges every address, connects to the one it judged and follows no redirect. App and runner are held
to the same verdicts by `contracts/key-destination-vectors.json`. The runner cannot tell a trusted public name from another public
name; that is the catalog's trust record, and the residual risk is #548's trust on first use
(`app/src/native-cost/README.md`, "Where the key goes").

**The address a selection is pinned to (#588; needs a security review).** The catalog's address is trusted on first sight, with no
committed list per provider. But the address a workspace's project saw when it selected the catalog provider is written once into
that project's settings (`dynamicProviderAddress`, set by the server, never by a request) and stays fixed: every later claim sends
the key to exactly that address, and if the catalog trusts another address by then (an admin confirmed a change, #548) the job is
refused before any key is loaded (`provider_address_changed`, free, with a notice on the Runs page for an Owner or Admin to confirm
the new address in the review settings of the project; only the roles that manage the workspace's LLM key may write or move a pin; the "Test key" is held to the pins of every project of the workspace for the provider, whatever its kind or state). The limit is trust on first use: a Member can clear the pins while they equal the trusted address and pin again after the catalog moved it, which is a first sight at the moved address (#614; `app/src/native-cost/README.md`, "The limit of the pin"). The runner needs nothing new: the entry it receives carries the pinned
address, which the app has just checked equals the trusted one, so its verdicts are the shared vectors' as before. The two registry
providers (`anthropic`, `openrouter`) get no such pin: their address is a constant in the code of the app and of the runner, which
is stronger than a per-selection copy and cannot go stale.

1. `build_native_job`, before anything is prepared: `target_from_entry`, the production `HttpsUpstream` on the entry's address
   (an address the guard refuses ends the job `dynamic_config_invalid` before the engine exists, naming neither the address nor
   the reason), a fresh capability, and the ledger and the proxy from the claim's policy (`build_native_run`, with the window
   and the output bound from the entry, `reasoning` from the entry, the operator's `RUNNER_DYNAMIC_MAX_COST_USD` and the
   deadline). The capability descriptor of the legacy path (`RUNNER_DYNAMIC_CAPABILITIES`) is not read.
2. `run_native_engine`, inside the preparation: the loopback server on the slot's port, the engine configuration
   (`native_provider_config` for the entry, `build_native_engine_config`: one provider, one model, the capability as its key,
   no real key and no upstream address), `DynamicEngine(plain_final=True, ...)`, and, when the run ends, the server is stopped
   (a superseded run drains first).
3. The usage is booked by the proxy's parsers into the ledger; the result carries `ledger.usage(...)` as for any Dynamic run.
   The cost policy decides what an unknown cost does (managed: the run ends `dynamic_accounting_failed`; own key: the token cap
   binds and `costUsd` is null).
4. **One finalization line** is added to the log of the result (and to the facts of a failure that got that far):
   `finalization first=<ok|problem> repaired=<true|false> second=<none|ok|problem> wrap_up=<cost_limit|project_cost_limit|time_limit|token_limit|none>
final_call=<normal|exempt> final_tokens=<in>/<out>/<cache read> repair_tokens=<in>/<out>/<cache read> finish=<finish of the
call that wrote the review> prev_prompt_tokens=<prompt of the call before>`. The finish is the one the provider's answer states
   (the usage tap reads it: Chat `finish_reason`, Messages `stop_reason`, Responses `status` and `incomplete_details.reason`, Google
   `finishReason`), in the four words of the call trace (`stop`, `tool_calls`, `length`, `content_filter`; any other is `other`).
   Stable names and numbers only
   (`finalization_log.py`); the tokens come from the call trace and are `-` when the trace was cut or is missing. A run whose log
   has no such line did not take the native path.

Nothing about the engine changed for this: no step limit, no steering, no `cache_control` set by us (caching comes from the
engine), the cost limit is the only brake and the final-call exemption makes a run end with a review.

**The switch.** In the app, the environment variable `NATIVE_OPENCODE_PROVIDERS` (`1`, `true` or `on`; anything else, or unset, is
off; `app/src/native-cost/switch.ts`). Off, `catalogRefOf` names no registry provider, so every claim is the claim of today. On, a
**Dynamic** job on `openrouter` or `anthropic` takes the native path: the claim checks the price (managed key) or reads the
catalog's price and the token cap (own key), builds the entry of the chosen model from the stored catalog and sends both. A
Diff job is never native. A managed model that is not enabled with a confirmed price ends `managed_model_unavailable`; a model
the catalog does not have ends `managed_model_unavailable` (managed), `dynamic_model_features_unsupported` (own key, a registry
provider) or `llm_model_unavailable` / `llm_provider_unsupported` (own key, a catalog provider, #555), before any key or token exists. The variable is read at every claim, so turning it off again takes effect on the next claim; a runner or
Worker image that does not know `dynamic.modelEntry` must not be in the fleet while it is on (the cost policy already needs the
claim feature `dynamic_cost_policy`, which gates both).

### The cost policy of a native job (#553)

Whose key pays decides what an unknown cost means. The claim hands the runner `dynamic.cost` (`contracts/runner-api.v1.json`,
`DynamicCostPolicy`; `passthrough/cost_policy.py` reads it as strictly as the app writes it), only to a runner that named the claim
feature `dynamic_cost_policy`, and only for a **native** job (`app/src/native-cost/README.md` says which selection is one). A job
without it is a job of today; a job with it that would reach the legacy wire is refused (`dynamic_config_invalid`).

|                                                                                                        | managed key (we pay)                                                                                                  | own key (the user pays the provider)                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| model                                                                                                  | refused at claim (`managed_model_unavailable`) unless enabled with a **confirmed** price, before any key, token or VM | free choice                                                                                                                                                                                                                                |
| price source                                                                                           | the confirmed book of the claim, nothing else: never the engine's `cost`, never models.dev                            | the confirmed book, else the catalog's price, else none                                                                                                                                                                                    |
| an unknown cost (a call whose usage was not read, one the book cannot price, a field nobody can price) | worst case booked, the run ends `dynamic_accounting_failed` (free)                                                    | the run goes on; the call books its tokens (or its expected cost and tokens when its usage was not read)                                                                                                                                   |
| bound                                                                                                  | the dollar limit of #540                                                                                              | the dollar limit of #540 while every call is priced, with `maxTotalTokens` (instance setting, default 4,000,000: prompt, cache and completion tokens in all) as a ceiling over it; with no price or an unknown call, the cap and the clock |
| result                                                                                                 | `costUsd` known; the app refuses a native managed success with a null cost (stored as `dynamic_accounting_failed`)    | `costUsd: null` when any call is unpriced; billing charges minutes only                                                                                                                                                                    |
| a call with no usage at all                                                                            | fails the run                                                                                                         | fails the run (the cap cannot count it)                                                                                                                                                                                                    |

`build_native_run(policy, limits, ..., target, upstream, ...)` (`native_run.py`) makes the ledger and the proxy of one policy, so the
two cannot disagree about whose key it is; `build_native_ledger(policy, limits, window_tokens, output_tokens, reasoning)` makes the ledger: no book means no dollar is counted
(`priced=False`), the output of a call is held to `min(limit.output, 32000)` (what the engine really sends, spike #546), and a model
the catalog marks `reasoning` reserves at least `REASONING_OUTPUT_FLOOR_TOKENS` (8,192) of output for every call and the p95 of its
own completions after that, since its thinking is output nobody can predict (#548: the flag changes the request, so it changes the
reservation). The whole 32,000-token cap is not reserved: at 15 USD per million tokens that alone would make the first call of a
1 USD run the final call. The token cap binds like the cost limit, and above the wire it is answered the same way: a normal call is
admitted
only while the tokens used, the tokens held for calls in flight and this call's expected tokens fit; a call that settles over the cap
is delivered and ends the agent phase; the run is wrapped up first when a further call and a final one would not fit, with the
reason `token_limit` (`stoppedEarly`), which the summary and the check run say in words. Above the wire (#552) the cap's refusal is a
`RefusedForFinal` with `refusal_reason` `token_limit`, `wrap_up_due` announces the answer before it, `arm_final` and `begin_recovery`
consult the cap, a marked call skips it, and an unknown call that takes the tokens over the cap (or its worst case over the cost limit)
ends the agent phase without ending the review. The unit costs a reservation is made with
are the book's base level (an expectation: what a call costs is always the book applied to its usage, so a model with tiers can
settle above its reservation, which the final-call exemption already bounds).

The book of a claim is read with `strict_cache_read` (`price_book.py`): a cache read without a read price is **not** priced as input
(N4 of the review of PR #569). "Selectable" on the managed key includes complete cache prices (`availability()`: every level states a
cache read; the Messages family also a 5-minute write); if a read slips past, the call is unpriced and the run ends
`dynamic_accounting_failed`, which is free. The token cap books a call at the largest of its counts, its stated total and reasoning
on top of the completion, and an unknown call at the estimate of its input plus the whole output allowance. `cache_control.ttl` stays out of the request schema: the pinned engine never sends one, and a 1-hour write is a price the
book states but nothing asks for.

## Finalization above the wire (native providers, #552)

The legacy path finishes a review through the engine's `StructuredOutput` tool with a forced `tool_choice` and lets
the proxy rewrite the last request (`wrap_up.py`). A passthrough proxy cannot do that, and many models reject a forced
choice. On the native path the finish is decided **in the adapter**, the same for every model, and the engine runs with
`read` / `grep` / `glob`, tool choice `auto`, no `format`, no `StructuredOutput` and no `response_format`. Switch:
`DynamicEngine(plain_final=True, engine_config=<build_native_engine_config>, provider_id=...)`; the default is the legacy
path, unchanged until #556 deletes it. (A claim's model entry builds those arguments since #578, see "The native path of a job".)

**The answer** is the visible text of the _last_ assistant message and nothing else: not reasoning, not a tool result, not
`info.structured`, not an earlier message (`final_json.extract_final_json`). It is accepted when the whole text is one JSON
object, or one Markdown fence (` ```json `, any case, `\n` or `\r\n`) around the whole text. Text around the object, two
objects, trailing commas, single quotes, comments, a cut-off tail and `NaN` are **not guessed into an answer**: each is a
named `Problem` class. A nesting that exhausts the parser (`RecursionError`) is `invalid_json` with a fixed text. The object
then goes through the existing envelope check (`parse_dynamic_findings`; the runner sets `schemaVersion` and `reviewedSha`
itself, #530) and the job's finding bound (more findings than the job allows is repairable). Hostile pull request text cannot
change the rule: it is code, and the schema decides.

**One repair.** An answer that is not the review gets exactly one more user message in the same session
(`final_messages.repair_message`): the `<runner-wrap-up>` tag, the class of the problem, field names of the validator, never
what the model or the pull request wrote. That includes a field name the model chose: an unknown field is named "an unknown
field". Findings that are all invalid are an answer that is not the review, repaired like an invalid envelope. A second
failure ends the run with the codes of today (`dynamic_policy_violation` for an invalid envelope, `llm_output_invalid`
otherwise). The engine's own error (`info.error`) is not an answer and is not repaired. The run never shows the engine's error
text: only its name, when it is one of the names the pinned engine has (otherwise `other`), and the stable code the ledger recorded (`ledger.failure`), or the proxy's
`last_upstream_error` for a provider that failed (`provider_error=`). That code is the last call's: a call that went through
clears it.

**Wrap-up by message, not by rewrite.** While a turn runs, the adapter's watch asks the ledger whether the answer is due
(`wrap_up_due`, read only: the cost arithmetic of the wrap-up, and for the clock 1.4 times the reserve) and, once, adds a
user message to the running turn (`POST /session/{id}/prompt_async`, the "finish now, answer as JSON" text). The tools, the
tool choice and the system prompt are untouched, so the provider's cache prefix and the binding of thinking blocks stay valid.
The announcement is best effort: an engine that cannot take it, or does not answer within its timeout (10 s), leaves the model
unasked, which is not a failure of the run (the guard's refusal follows if the model keeps calling tools). The reason is kept
as `stoppedEarly` (`cost_limit` / `project_cost_limit` / `time_limit`) only where the adapter acts: for an announcement the engine took while the turn
ran, and for a refusal it answers with the final call; not for a refusal nobody acts on (a stray retry after a review) and not
for an announcement the engine took only after the turn had ended. The end of a turn waits for a running announcement, so none
can reach the engine after the abort and the mark, and when one was taken and no refusal followed, the adapter aborts the
session and waits for the proxy to be idle before it reads the review, so nothing of that turn is left running (an
announcement the engine takes while the model call that writes the review is in flight can still make it take one more step
inside the same turn; that call is accounted like any other). If the final call cannot be marked the run ends with the cause
in the ledger's words: a failure it recorded, a model call of the aborted turn still running after 30 s
(`dynamic_engine_unavailable`), the deadline, or both marks used (`dynamic_budget_exceeded`).

**A run never ends without a review because of the cost guard** (#540, #542). A model that ignores the message meets the
ledger's refusal of its next call. With `enable_final_above_wire()` (called by the engine) that refusal is a
`RefusedForFinal`, which is **not** the run's failure but a counted signal (`refusals`; the adapter takes the count when a
turn starts and reacts only to an increase, so a refusal between two turns is nobody's): the turn ends, the adapter aborts
the session, waits (bounded by the deadline) until the proxy and the ledger have nothing in flight, **marks the next call as
final** (`arm_final`) and sends one "answer now" message. The ledger admits that call under the final-call exemption of #542
although the limit is passed, and the passthrough proxy relays it as it relays any call (one call in flight, the closed
schema, nothing rewritten, the body byte for byte). The message of the final call and of the repair carries a random token of its own
(`<runner-wrap-up id="…">`; the announcement carries none). The mark belongs to the request that holds that exact text, holds
the token once in the whole body **and in its last user message** (the proxy reads the parsed body, `passthrough/last_user.py`;
the system prompt, a tool result, assistant text or an earlier message holding it does not count), and is no larger than the
history the run had plus the message, where the tool results the audit saw since the last call are frozen when the mark is
armed (see the ledger's "The mark"); any other request is a normal call that must fit, and the mark stays. A marked call that the provider turns away unbilled (429, 5xx) gives its mark back, at most twice per
mark. A call booked at its worst case because its usage was never seen (an own key goes on after one) that passes the limit
ends the agent phase like a call that settled over it, and the final call is still admitted. If the turn ends with the mark unused (the engine made no call: the session was still winding down), the message goes
out once more, and only once. A second mark exists only for the one repair (no third). A refusal after the final call is a
tool call when the audit saw the model ask for a tool in that turn (class `tool_call`), and otherwise its own class
(`final_call_refused`: the engine asked the model again, e.g. a retry, and the guard refused); either is followed by the one
repair, not by a silent failure. A valid review in the last message wins over a refusal of the same turn. The clock works the
same way: once less than the wrap-up reserve is left (150 s of 600 s, one provider call) a normal call is refused for the
answer, and the final call is admitted inside it. The reserve is measured when a call is admitted, not when it ends: a normal
call admitted just before it can still run into it, and only the deadline itself is never passed.

**The bound** is #542's: the cost limit, plus the excess of the last normal call, plus the final call, plus the one repair.
The ledger also admits no call at all after a recorded failure on this path.

**The tool-result audit** moved to the adapter for this path (the passthrough proxy counts none of it). The adapter reads
the engine's own event stream (`GET /event`, `engine_events.py`) and `tool_part_audit.py` counts every tool call at first
sight, and every result once per call id when its part is complete: 64 KiB per result and 4 MiB cumulative (`add_result_bytes`),
the files read, and the call trace. The reader is bounded and fails closed: opening the stream has a 10 s timeout of its own;
one event (the sum of its `data:` lines) is at most 8 MiB; the audit holds at most 10,000 tool parts (call ids of at most 256
characters) and the ledger at most 100,000 distinct files (paths of at most 4,096 characters); a stream that stays open and
says nothing for 35 s is dead (the pinned engine beats every 10 s with `server.heartbeat`; a version bump must keep that
beat); stopping the reader shuts the socket down, so a reader waiting on a quiet stream is released at once; and what the reader
records while it is being stopped is still the run's result. A stream that does not connect, ends while the run goes on, or
holds an event it cannot read or hold is the run's failure (`dynamic_engine_unavailable` / `dynamic_accounting_failed`); a
bound is `dynamic_budget_exceeded`. This audit is **detective**: an event arrives when a tool has finished and the next request
may already be on its way; the proxy's request byte bound (4 MiB per request, so no history can carry more) and the ledger's
refusal of every call after a recorded failure are what bound a hostile or mistaken engine regardless. An engine that
reports nothing is bounded by the request byte bound alone. (A count the proxy makes itself from the history the engine
resends, which an engine cannot forge, is the follow-up that replaces the detective audit for these bounds.)

_Not changed:_ the legacy path (`ModelProxy`, `StructuredOutput`, `required`, the steering, `wrap_up.py`, `recovery`) is
untouched and still runs the providers of today; #556 deletes it. The prompt core is unchanged (it already says "one JSON
object and nothing else"); the adapter adds one fixed runner line at the end of the first user message, outside every
untrusted block, that carries the job's finding bound (`final_messages.final_answer_line`).

## The model

Dynamic Review is model- and provider-agnostic. The default model is `deepseek/deepseek-v4.1-flash`,
the id OpenRouter serves (the name is sent to the provider as it is). It is a default, not an
allow-list, and there is no provider routing or fallback. The workspace's existing encrypted BYOK
credential is used (no new key variable, no per-project key).

**On the operator's key the model is a catalog entry's, not the project's (#432).** A workspace whose key mode is
`managed` never sees a model. Its project selects an entry of the operator's model catalog (else the instance default
entry for Dynamic Review), and at claim the resolver (`resolveModelSelection`) takes the entry's provider and model and the
operator's key of that provider; the project's own model is not used. The model has to support tool calls: the catalog
checks it when an entry is released, and the capabilities below are read for the entry's model at claim. Without a usable
entry the job ends with `managed_model_unavailable` instead of moving to another entry or model. The model reaches the
runner and nothing a workspace can read. A workspace on its own key keeps the provider and model it chose. See
`app/src/model-catalog/README.md` and `app/src/runner-api/README.md`. The quality tiers (`low`, `medium`, `high`) that
#280 introduced are gone; #434 turned them into catalog entries.

**The app describes the model for every job (#279).** When a Dynamic job is claimed, the app reads
OpenRouter's public metadata of the job's model (`GET /models/{author}/{slug}/endpoints`, no
credential, the same read the settings save does) and sends the result in `dynamic.capabilities` of
the job: whether a required tool choice and structured output (through tool calling) are supported,
the context window, the output allowance, and the unit prices per million tokens. So **any tool-capable
OpenRouter model runs without the operator describing it**. The values are read at the bound a
reservation needs, over the endpoints that can serve the run (those that list `tools` and
`tool_choice` and do not say they cannot force a tool choice): the smallest window and output limit, the
highest prices. The output allowance is at most 32,768 tokens for a model whose highest output price is
4 USD per million tokens or less (the app's `DYNAMIC_LARGE_OUTPUT_ALLOWANCE_TOKENS`, and the allowance
of the built-in default model), and 8,192 for a dearer or unpriced one; a larger limit of the model is
not an invitation, since the cost limit reserves the output the run has shown, never more than the
allowance (#540, see "How the cost is bounded"). Why (#309): a review of up to 30 findings plus the reasoning tokens, which
count against `max_tokens`, does not fit 8,192, and a turn cut off there ends without an answer. A model
that cannot run without thinking (the Claude models of #533) gets 32,768 at any price, and the runner reserves
at most 8,192 of it against the cost limit (`runner/README.md`, "Output allowance with thinking"). The
source for the default model: OpenRouter's `/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints`,
read on 2026-10-14, where the model's top provider states `max_completion_tokens` 943718 and the
smallest endpoint limit is 131072, so 32,768 is below every limit; the smallest limit of the endpoints
still wins when it is lower. The descriptor comes from the app, never from the repository, the pull request or the
model, and it only goes to a runner that said it reads it (`features: ["dynamic_capabilities"]` in its
claim; an older runner never receives the field, see `contracts/README.md`).

**Precedence, from the runner's side** (`capabilities_for_job` in `proxy.py`):

| Job descriptor | `RUNNER_DYNAMIC_CAPABILITIES` | Result                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| absent         | unset or empty                | the built-in description, for exactly the default model `deepseek/deepseek-v4.1-flash`; any other model fails with `dynamic_model_features_unsupported` (today's behavior)                                                                                              |
| absent         | set                           | the operator's value, as before                                                                                                                                                                                                                                         |
| present        | unset or empty                | the job's. A model whose metadata had no unit prices fails with `dynamic_config_invalid` (the default model keeps its built-in prices)                                                                                                                                  |
| present        | set                           | **the intersection: the operator's value is a ceiling.** Both must support the features, the smaller output limit wins, the smaller window wins when the operator names one, the higher unit price wins. The job can narrow what the operator allows and never widen it |

The built-in description is a fallback, never a ceiling. An operator value that is set but unusable
fails the run whatever the job says. The runner fails closed on prices: no unit prices from the job,
the operator or (for the default model only) the built-in description means `dynamic_config_invalid`,
because a cost that cannot be priced cannot be bounded before it is spent. No price is written into the
code beyond the built-in description of the default model.

**When the metadata is read.** At claim time, through a short in-memory cache (five minutes, positive
answers only), not at save time: the settings save also checks the model, but a stored snapshot would
go stale (prices and providers change) and would need a migration. A model whose metadata says it has
no tool calling or no required tool choice ends the job at claim, before any credential is created,
with `dynamic_model_features_unsupported`. **If OpenRouter cannot be asked** (unreachable, an answer
that cannot be used, a model it does not list, no stated or oversized window) nothing is invented: the job is
claimed without `dynamic.capabilities`, the claim log says `model capabilities not read (...)`, and
the runner uses its own description as before, so a provider outage fails only models the operator did
not describe. A claim waits at most five seconds for the metadata.

**Variants.** A `:variant` suffix (`:free`, `:nitro`, ...) is dropped for the metadata lookup, because
OpenRouter lists endpoints per base model. The descriptor of a variant is therefore the base model's:
the prices can only be higher than the variant's real ones (a safe reservation), the window lower, and
a variant that routes to endpoints without tool support is still caught at run time by the required
parameters on every request (#270), which ends the run with `dynamic_model_features_unsupported`.

`RUNNER_DYNAMIC_CAPABILITIES` is therefore optional for every model and is **a ceiling and an
override** for the operator who wants one, in JSON:

```json
{
  "tool_choice_required": true,
  "structured_output": true,
  "max_output_tokens": 32768,
  "context_window_tokens": 1048576,
  "input_usd_per_mtok": 0.5,
  "output_usd_per_mtok": 2
}
```

`input_usd_per_mtok` and `output_usd_per_mtok` are what a million input and output tokens cost in
USD, used only to reserve the cost of a call before it is sent (see "Hard limits").
`context_window_tokens` is the model's context window (what a request and its output allowance must
fit). **Without a job descriptor the unit costs are required for every model other than the built-in
default**: a descriptor without them (or any descriptor that is set for the default model, since it
replaces the built-in one) ends the job with `dynamic_config_invalid`. The window is optional: without
it the conservative default of 128,000 tokens applies when the operator's value is used alone. A window
that is not a positive integer larger than `max_output_tokens`, or only one of the two unit costs, or an
unusable unit cost, fails the run with `dynamic_model_features_unsupported`. The built-in description
of the default model carries the window that OpenRouter's public model list gives for it (1,048,576
tokens, read on 2026-10-14, `https://openrouter.ai/api/v1/models`) and the unit costs of that list
(`runner/src/code_reviewer_runner/dynamic_review/proxy.py`).

A job whose model has no description at all (no job descriptor, unset variable, another model), a value
that is not JSON, or one that lacks a required feature fails with `dynamic_model_features_unsupported`.
There is no silent fallback to another model or to a Diff review.

## Hard limits

The limits are fixed in the code (`runner/src/code_reviewer_runner/dynamic_review/budget.py`) or are
trusted runner configuration; no project setting or pull request text widens them, and the
wall-clock limit is the minimum of 600 seconds and what is left of the runner's job timeout, which
counts from the first line of `main()` of the job process (#387), so the watchdog cannot overtake the run's own deadline.

**The one budget is money (#290).** A Dynamic run is bounded by an operator cost limit in USD, not by
tokens, model calls, tool calls or files: a tool loop sends its whole history again with every call,
so those counts say little about what a run costs, and a count tight enough to protect an operator
stopped normal reviews of a medium repository. The tokens, calls, tool calls and files are still
counted and shown in the Run; they just stop nothing.

| Limit                                     | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Kind                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cost of one run                           | 1.00 USD; the operator sets it in the admin portal ("Maximum cost per review", General, Limits; #689; the app sends it with the job as `llm.operatorMaxCostUsd`, up to 100 USD, one value for Diff and Dynamic Review). `RUNNER_DYNAMIC_MAX_COST_USD` is only the fallback for a job from an app that does not send it (a plain decimal number above 0, up to the ceiling of 20 USD in the code; anything else fails the job with `dynamic_config_invalid`) | budget                                                                                                                                     |
| Wall clock                                | 600 s (lower when `RUNNER_JOB_TIMEOUT_SECONDS` is lower)                                                                                                                                                                                                                                                                                                                                                                                                    | technical: the lease and the runner's capacity depend on it                                                                                |
| One tool result                           | 64 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                                      | technical                                                                                                                                  |
| All tool results together                 | 4 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                                       | technical                                                                                                                                  |
| Untrusted input to the engine             | 2 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                                       | technical                                                                                                                                  |
| One model request, one answer, one stream | 4 MiB, 256 KiB, 1 MiB                                                                                                                                                                                                                                                                                                                                                                                                                                       | technical                                                                                                                                  |
| Findings                                  | 30                                                                                                                                                                                                                                                                                                                                                                                                                                                          | output size: the summary comment, GitHub's comment limit and the persisted review state are bounded by it (the project setting is 1 to 30) |

The cost of one run is the smaller of the operator's limit and the project's own (#666): the claim sends the project's limit as
`llm.maxCostUsd` (a whole number of cents, 1 cent to 100 USD, only to a runner that named the claim feature `cost_limit`), and
`effective_cost_limit` in `budget.py` takes the smaller. A run the project's limit stops is wrapped up exactly like one the
operator's limit stops, and reports `stoppedEarly: project_cost_limit` instead of `cost_limit`. The notice in the summary comment, the
check run and the Run say that it reached the cost limit set for the project, and where to change it (`docs/billing.md`, "The cost
limit of a project"). The project's limit never widens the operator's.

Removed in #290: 30 model calls, 120,000 total tokens, 200 tool calls and 100 distinct files. If one
of the technical limits blocks a normal review of a medium repository, report it with evidence
instead of raising it.

**How the cost is bounded.** Before every call the ledger reserves what the call is **expected** to
cost (#540), from what the run itself has shown, at the unit costs of the model's description (a model
without unit costs does not run, see above). The call is refused (`dynamic_budget_exceeded`, before
the provider sees it) when what is spent, what is reserved for calls in flight and this reservation
would together pass the limit; the final call is the exception (see "The bound" below). After the call the reservation is replaced by the `usage.cost` the
provider reported (the credits it charged, #286). **A call that reports no cost ends the run with
`dynamic_accounting_failed`**: without it the run cannot be bounded by money, and a missing cost is
never read as zero. A cost of 0 (a free model) is a cost. A call that failed or was retried keeps
its reservation (it may still have been billed), so many provider retries can use up the limit
without spending. With OpenRouter's bring-your-own-key routing `usage.cost` may exclude the upstream
provider's charge. Repository and pull request input never set any of this.

_The expected cost of a call._ Before #540 the guard priced the whole prompt at the uncached input
price, reserved the full output allowance and, for the final call, 128 KiB of extra history: about
16 times what a Sonnet 5 tool loop cost per call, so a 55-call run that cost 0.70 USD was wrapped up
at about 0.55 USD of a 1.00 USD limit. Now:

- **Prompt.** The part of the prompt the previous call left in the provider's cache (its reported
  cache reads plus writes) is priced at the cache-read price when that call reported cache reads;
  the rest (the growth since, taken from the bytes the request added over the observed density) at
  the cache-write price while the cache is in use, else at the input price. The cache prices come
  from the runner's own list of the provider (Anthropic's), never from the job or the repository.
  A provider that reports no cache tokens, or has no such list (an OpenRouter model), is priced at
  the uncached input price throughout.
- **Output.** The p95 of the run's own completions so far (nearest rank), not below 1,024 tokens
  (4,096 for the call that writes the review: the final call, the recovery and a retry of either),
  and not above the allowance or the cap the model's wire names (8,192 for a model that cannot run
  without thinking, #533). The allowance itself (`max_tokens`) stays the hard cap: an answer above
  it is `dynamic_accounting_failed`.
- **The final call after a normal call** (the wrap-up test, below) is priced the same way: the next
  prompt plus one round of growth (the p95 of the rounds seen, at least 4,096 tokens), with the cached
  prefix and a review-sized output. The wrap-up test multiplies this call and the final call by
  1.25.

**The bound.** A run must never end without a review because of the cost guard (#540), so there are
two rules and no failure mode between them:

1. A **normal call** is admitted only while `spent + held + its expected cost <= limit`.
2. The **final call** (the wrap-up, the recovery and the retries of either) is the last chance of a
   review. It is admitted whenever `spent + held <= limit`, **even when its expected cost no longer
   fits**, and it is delivered whatever it costs.

A normal call can still cost more than expected: a cache miss (the entry expired because a tool
took long, or the prefix changed) re-writes the whole prompt at the write price, an answer can be
unusually long, a tool result can be 64 KiB, a dense input has up to 3 times more tokens than the
byte estimate, and a price list can have changed after it was read. If such a call **settles over
the limit it is delivered, not failed**; it ends the agent phase at once. The next request that can be
rewritten into a final call (the one that offers the structured-output tool) is the final call,
admitted by rule 2 although the spend is over the limit (`stoppedEarly` is `cost_limit`). After the
first overshoot no normal call is admitted again; a request that cannot be a final call (a title
call, for example) is refused with `dynamic_budget_exceeded`, and so is anything after the final
call. If the final call returns no structured answer, the retries within the limit are made as
before (#312, each is a final call too) and, once the spend is over the limit, **one** retry more.

**The settled total is therefore at most the limit, plus the excess of the last normal call (its real
cost minus its reservation, at most its real cost), plus the cost of the final call.** The final
call costs at most its input plus `allowance x output price`: it reserves the cap the model's wire
names (`reserved_output_tokens`, which is the allowance unless the wire says a call rarely uses it
all) rather than a tool call's output, so the wrap-up decision leaves room for the worst case of a
review. If the final call answers in prose while the spend is over the limit, the one retry past
the limit is one final call more. The result reports by how much the limit was passed as
`usage.limitExceededBy` (USD, absent when it was not, `contracts/runner-api.v1.json`) and the job log
says it, so the bound can be watched on real runs.

_Billing (#498, #605)._ While billing is on, nothing is held for a Dynamic job: it starts whenever the balance of its workspace is above zero (`src/billing/README.md`,
"Start, settle"), and the settlement charges the **real** cost, also when the run passed its limit by this excess: the balance may go below zero and the
next claim of the workspace is then refused (`balance_negative`). Billing never shortens a run, never changes the final-call exemption and takes
nothing from a run that ended without a review: it prices what the run reported.

_Serial calls._ The engine's model calls are serial: one agent (`review`), the permission block denies
every tool but `read`, `grep`, `glob`, `skill` and `StructuredOutput` (so no subagent runs in parallel), and a
step waits for its tool results. The ledger still holds the reservation of every call in flight; if
requests ever overlapped, the bound above would be the sum of the excesses over the calls in flight,
and a final call is refused when `spent + held` already passes the limit (that case is not the
exemption's). A failure of an unrelated kind (the provider, the clock, `dynamic_accounting_failed`
for a call without a cost) still ends the run: the guard does not hide them.

**The input estimate.** Bytes divided by 3 (real text has about 3 to 4 bytes per token), tightened
to what the provider settled on the previous call when that was denser (only from requests of 4 KiB
up), and never below the last settled prompt. It is the conservative estimate that sizes the window
backstop and the byte bound; the price of a reservation uses the last settled prompt plus the added
bytes over the same density. The provider's reported usage replaces the estimate after the call. It
is accepted up to the proven byte bound (a token is never fewer than one byte); above that it is an
accounting failure (`dynamic_accounting_failed`).

**The window is a backstop.** The window of a run is the model's, from its description
(`context_window_tokens`). The runner refuses a request before it is sent (`dynamic_budget_exceeded`)
only when it cannot fit even at 6 bytes per token, a density no natural text reaches (text has 3
to 4.5), so it never refuses what the provider would accept; that is a choice against the
production symptom, where an estimate that was too high refused a request the provider would have
taken. Every other case is the provider's: its "context length exceeded" answer (read from the
answer's `error.code` and `error.message` only, never from text elsewhere in the body) ends the run
with `llm_context_length_exceeded`. The conservative estimate (bytes over 3) is used for the cost
reservation only. The Diff Review
token budget (`llm.maxTokens`, which the app decides for every job since #689 and no setting names any more) is **ignored** by
Dynamic Review: it is another concept (the size PR-Agent gives a diff), and using it as the window is what refused real
reviews. It is neither a window nor an extra cap.

A run whose limit is hit ends with `dynamic_budget_exceeded` (see "Wrap-up" for the run that is
wrapped up before), a run whose usage or cost cannot be established with `dynamic_accounting_failed`. The previous summary comment is preserved in both
cases. The tool, file and result-byte checks are enforced at the model proxy, before the request is
forwarded (#197 part 2a): a model request whose history exceeds one of them never reaches the
provider.

## Wrap-up: a review at its limit is finished, not thrown away (#293)

A run that is about to reach its cost limit or the end of its wall clock does not just stop. The
model is given one last call in which it can only return its answer, and the review it produces is
published.

- **When.** The ledger decides, per model request, from its own cost and clock (never from the
  content of the request): the request becomes the _final call_ when a further normal call could
  not be followed by a final one inside the cost limit (what is spent, what is held for calls in
  flight, this call, and a final call after it, with the margin above, #540), or when less wall clock is left than one provider call needs (150 s of the 600 s; a
  quarter of a shorter deadline). The final call is admitted whenever the spend is within the cost limit,
  even when it no longer fits (#540, "The bound"): a refusal here would end the run without a review.
- **What changes in that call.** The model proxy, which is trusted runner code, rewrites the request
  before it is forwarded: every tool except the engine's `StructuredOutput` return tool is removed,
  `tool_choice` is forced to `required` (with one tool this forces that tool; `required` is the
  capability every Dynamic model must have, and `provider.require_parameters` still holds), and a
  runner-written instruction is appended as the last message: _the limit set for this review is used
  up, do not call any more tools, return the complete review now with the findings you have so
  far_. The rest of the request is as the engine sent it. A request that does not offer the return
  tool (a title call, for example) is never rewritten and keeps the plain rule.
- **One final call.** After it is granted every other request is refused with
  `dynamic_budget_exceeded`. If the final call fails, the run ends with the stable code of that
  failure (the provider's or the transport's), and the engine's retry is refused.
- **Result.** The review is validated like any other, published, and its summary starts with a
  neutral notice that the review stopped early because it reached the cost limit set for a review (or
  its time limit) and may be incomplete. The notice is one of two constants and is not part of the
  stored review state, so the next complete run does not carry it. The runner result carries
  `usage.stoppedEarly` (`cost_limit`, `project_cost_limit` or `time_limit`; absent for a complete run) and the Run's
  detail page shows "Stopped early".
- **Security.** The instruction is trusted runner text. Repository content can neither trigger the
  wrap-up nor prevent it: the decision is made from the ledger's own state, and a request that sets
  its own `tool_choice` or tools is rewritten all the same. Nothing in the repository can imitate the
  instruction: it is a user-role message appended after all of the history, and the `<runner-wrap-up>`
  tag that wraps it is escaped, like `<system-reminder>`, in tool results, in the pull request text
  and in the prior review state (`tagescape.py`). Compaction is off (below), so the return tool is
  always still registered with the engine when the final call is made; a test pins that assumption.
- **Checked against the pinned OpenCode v1.19.0.** The tool the model calls in the final answer is
  the engine's own `StructuredOutput`, which the engine registers for the whole turn because the
  structured format lives on the turn's user message. Rewriting what the proxy forwards does not
  touch that registry: the engine captures the structured answer and ends the turn as it does after
  any last call (the real binary runs both wrap-up scenarios in `tests/engine`).
- **Reasoning tokens.** OpenRouter's documentation says reasoning tokens count against `max_tokens`
  (the limit "applies to reasoning and visible output combined"), are billed as output tokens, and
  are a subset of `completion_tokens`. The proxy sets `max_tokens` to the output allowance of the
  model's description, so the reservation of every call (priced at the output cost) already covers
  them. A provider that reports more completion tokens than the allowance, reasoning included, ends
  the run with `dynamic_accounting_failed` instead of being paid for it.

### How long a turn may take

The engine's turn is one blocking `POST /session/{id}/message` that returns only when the whole
agentic turn is done, with nothing on the socket meanwhile. Its socket timeout is therefore **the
time left to the whole-job deadline plus a 5 s margin**, never a fixed cap: a cap of 300 s once
ended a normal review turn as `dynamic_engine_unavailable: the engine is not reachable` (a
production run of this repository's own pull request, after about 339 s), before the wrap-up at
deadline minus 150 s could act. The run's own watch (the ledger's deadline, the proxy's recorded
limits, the engine process) ends a turn; the socket never does.

A failed engine call says why at the start of its detail, all with the code
`dynamic_engine_unavailable`: `engine_turn_timeout` (the turn ran into the client timeout before the
deadline, which the margin makes a defect to report), `engine_exited` (the engine process ended
during its turn), `engine_unreachable` (it runs but cannot be reached, e.g. a refused connection),
`engine_timeout` (another call did not answer in time). A failure at the deadline is
`dynamic_budget_exceeded`. The result log names how long each engine message call took
(`engine message call: 339.2 s`, numbers only), after a success and after a failure.

`prompt_async` (an immediate `204`, present in v1.19.0) was considered and not used: the result of
the turn would have to be read back through the session's message list, which answers HTTP 400 once
a JSON-schema format is stored (the defect of #85, pinned by an engine test), or through the
`/event` stream, which needs an event reader of its own. That is a follow-up if turns ever need to
outlive one connection.

## Recovery: a turn that ends without an answer gets one more chance (#309)

The pinned OpenCode ends a turn, and fails it with "Model did not produce structured output", as
soon as a model step finishes with any reason but `tool-calls` while no `StructuredOutput` call was
captured (`session/prompt.ts` of v1.19.0). That happens when the model answers in prose although
the tool choice is `required`, when its output is cut off at the allowance (`length`, mid tool call),
and when a provider says `stop` for a step that asked for tools. A production run died this way after
a 257 s turn with `llm_output_invalid: the engine returned no structured answer`, far from the cost
limit and the clock, so the wrap-up above never acted. The engine config has no step limit
(`agent.steps` is unset, so the engine's own maximum is infinite), and `tool_choice: required` is
sent on every request and forwarded by the proxy (both checked against the real binary).

- **Tool steps are tool steps.** The proxy reports a step with tool calls to the engine as
  `tool_calls` even if the provider called it `stop`, so that case no longer ends the turn.
- **One recovery.** When a turn ends without a structured answer, the adapter asks the ledger
  (`begin_recovery`). The ledger says yes only if no final call was granted yet, a model call was
  made, more than the wrap-up's clock reserve is left (150 s of 600 s, a quarter of a shorter
  deadline: the recovery call writes a whole review) and the spend is within the cost limit (the
  recovery call is a final call: it is admitted although it no longer fits, #540). Only
  the engine's own missing-answer error (`StructuredOutputError`, or a turn that ended with no error
  at all) is recovered; another error of the engine (`APIError`, an abort, a content filter, ...) is
  its own failure and ends the run as before, with the error name in the detail. The adapter then sends a second message to the same session with the runner's fixed
  prompt (`Return the complete review now.`, no tag) and the same structured format. The first model
  call of that turn is granted as the run's final call: reserved like any call, rewritten by the
  proxy exactly like the wrap-up call (return tool alone, `tool_choice: required`, the instruction
  last), and after it every other request is refused. The instruction says that the previous turn
  ended without the review and that its last answer is not shown, and asks for the review based on
  what the model examined, concise (at most 10 findings, short descriptions), so a cut-off at the
  output allowance is less likely to repeat. The pinned engine does not replay the message that
  ended the turn (a prose answer, a cut-off return call): the history of the recovery call holds the
  task and the tool steps with their results, but not that answer (checked against the real binary,
  #312). Left like that, the model had to write the whole review again from the raw tool results,
  which is what the first recovery in production did not manage in 16 s. The adapter therefore
  hands the dropped text back: the visible text parts of the message that ended the turn (never the
  reasoning) become one `previous-answer` block of the recovery message, escaped like a tool result
  (it cannot pose as the runner's instruction), fenced like any untrusted block and cut at 48 KiB
  without splitting a character. The recovery is then a transcription, not a second review. The
  instruction uses the `<runner-wrap-up>` tag, so every escape that protects the wrap-up
  instruction covers it, and it says the message before it may quote the answer.
- **No second recovery turn.** A run has at most one final call: the recovery or the wrap-up, not
  both. If the recovery also yields nothing the run fails with `llm_output_invalid` as before; if the
  wrap-up's final call came back without the answer there is no recovery either.
- **The final call is enforced in the proxy, not hoped for (#312).** The pinned engine accepts
  whatever JSON the return tool is called with and ends the turn on any other reply, and the
  provider may ignore a forced tool choice (a prose or empty reply is `finish=stop` with no tool
  call). The proxy, which is trusted runner code, therefore checks the reply of every final call
  before the engine sees it:
  - a reply with no tool call whose whole text (or a ```json fence of it) is one JSON object with a
    `findings` key becomes the `StructuredOutput` tool call it should have been;
  - a reply is the answer when it calls `StructuredOutput` with arguments that parse as JSON and that
    the runner's own parser (`dynamic_findings`) accepts;
  - otherwise the proxy asks again, with the same final request, the model's reply as an assistant
    message (text only, escaped) and a `<runner-wrap-up>` message naming the concrete problem (`the
reply did not call the StructuredOutput tool`, `the arguments ... are not valid JSON (Expecting
',' delimiter at position 120)`, `the review is not valid: priority must be one of P0, P1, P2,
P3`; field names and parser positions, never a value);
  - at most `FINAL_ATTEMPTS` (3) requests per final call, each reserved and settled like any model
    call, and only while the clock and the cost limit have room (`try_reserve_final_retry`); no room
    means the last reply is what the engine gets;
  - what the engine gets is the last reply, valid or not. A reply that stays unfit is the model's
    failure, with the runner's validation naming the field (`dynamic_policy_violation`) or the
    missing answer (`llm_output_invalid`) as before. Normal calls are never checked or retried.
- **F3 of #301.** A final call (wrap-up or recovery) that answered without the return tool makes
  every later request fail with `llm_output_invalid`, not `dynamic_budget_exceeded`.
- **What is recorded.** A recovered review is complete as far as the model is concerned, so it is
  published without a notice and `usage.stoppedEarly` stays empty. The result log says
  `recovered after a turn without an answer (finish=stop, error=StructuredOutputError)` and names the
  duration of both message calls (`engine message call: 257.3 s, 12.1 s`). A failure says
  `the engine returned no structured answer (after one recovery; the first turn: finish=length)` or
  `(the first turn: ...; no recovery was possible)` or `(the first turn: ...; the engine's own
error, not recovered)`. A failure of the recovery call itself (the provider refused it, the final
  call answered with a stray tool call, the deadline) keeps its own code and ends with
  `(during the recovery; the first turn: finish=..., error=...)`. The note holds only a finish reason and an error
  name that are plain identifiers; engine text is never copied.
- **What a failure says about itself (#312).** The engine reports a prose answer, an empty step and a
  broken tool call alike as `finish=stop, error=StructuredOutputError`. The failure detail (and so the
  Runs view) therefore also names, for the first turn and the recovery: the engine's own sentence for
  that error (`Model did not produce structured output`, copied only for that error and only while
  it is plain short words), the size of the visible text and of the reasoning of the last step, and
  the tools it called. And it ends with `last model calls: ...`, the last three provider answers as
  the proxy saw them: finish reason (and the provider's native one), the tools called (the return
  tool marked `(args not json)` when its arguments do not parse), the sizes of the text and of the
  reasoning, the output tokens, and `final call` for the wrap-up or recovery call. Sizes and plain
  identifiers only; no diff, no model text, no tool argument.
- **A review with one bad finding is still a review (#312).** The pinned engine does not validate the
  return tool's arguments against the schema (it only parses JSON), so the runner is where a
  malformed finding is found. A finding that is invalid next to at least one valid one (a swapped line
  range, a confidence of 85, an unknown field, an unsafe path, another head) is dropped and counted,
  and the log says `dropped N finding(s): finding_invalid (<field problems>)`; a finding that points
  outside the export is dropped as before. Fail closed: when there are findings and none is valid, or
  the envelope itself is invalid (`schemaVersion`, `reviewedSha`, `resolvedIds`, the finding bound),
  the run fails with the first problem as before, because nothing in such an answer can stand for
  "no findings".
- **Not covered (#301 F4).** The final call's history names tools that the call no longer offers. The
  pinned engine and the fakes accept that; if a provider behind OpenRouter rejects it (400, shown as
  `llm_bad_request`), the fallback is to keep the original tool definitions in that call and rely on
  `tool_choice`.

## The call trace: what each call was, without content (#541)

A run that stops at its cost limit or costs more than expected has to be explainable afterwards, and the totals of its
usage do not say what 55 calls did. The runner therefore records a **trace** and sends it in `usage.callTrace` of the result
(`contracts/runner-api.v1.json`, `RunnerCallTrace`, additive and optional):

- **Per model call:** `index`, `tMs` (milliseconds since the run started, at the start of the call), `promptTokens`,
  `cacheRead`, `cacheWrite`, `completionTokens`, `costUsd`, `finishReason`, `final` (the wrap-up or recovery call) and
  the tools the answer asked for with counts. A call the provider refused, never answered, answered without usage or with more
  bytes than the protocol allows is in it with `null`s (a finish reason too, where the answer had none).
- **Per tool call:** the tool, `resultBytes` (what the model was shown) and `isRepeat` (the same tool with the same
  normalised arguments, a path spelled absolute or relative being one file, already ran in this job).
- **Never content:** no path, no argument, no tool result, no model text. A tool name that is none of the engine's
  (`read`, `grep`, `glob`, `StructuredOutput`; the `skill` loader is one of the `other`) is stored as `other`; a finish reason outside the protocol's too. Whether a
  call repeats an earlier one is decided from a digest in memory that is never written out. The trace does not steer
  the run: nothing reads it back, and the agent is not told about it.
- **Bounded:** the first 100 model calls and the first 100 tool calls; `truncated` says that more happened. A full trace
  is about 30 KB, inside the 48 KiB body the runner sends; when the whole body is too large the runner drops the trace
  first, and only then shortens the log. The bare verdict it falls back to when the app refuses a result has no trace.
  The app drops a trace that is not the contract's and keeps the usage and the verdict (observability, never a reason to
  lose a result).
- **Shown** in the Runs detail of a workspace (the cost and the cache columns only where the run's provider may be known, so
  not for a managed quality level: whether a provider reports cache writes says which one it is) and in the instance admin's run view (`/admin/runs`, `/admin/runs/<id>`: the newest runs of every
  workspace, and one run with its facts, usage and the two tables). A run from a runner that sends no trace shows no
  section in the workspace and a note in the admin view.

## Context window and compaction

OpenCode can compact a long session itself (`compaction.auto`, with the model's `limit.context` and
`limit.output` in the provider config, and `compaction.prune`). Both stay **off** (decision of #290,
re-check with every engine pin), because of a defect found against the real pinned v1.19.0 binary:

- After an automatic compaction the engine's next requests to the model no longer offer the
  `StructuredOutput` tool and no longer force a tool choice (`tool_choice` is `auto`). The
  structured-output format lives on the user message that started the turn; compaction replaces that
  message with a summary and a synthetic "continue" message that carries no format
  (`session/prompt.ts` and `session/compaction.ts` at the pinned commit). The model then answers in
  prose and the run ends without a typed answer (`dynamic_policy_violation: the findings are not
valid JSON`). A run cannot finish after a compaction.
- The same lost format would defeat any later "answer now" step.
- What the model sees after a compaction also changes in trust: the review task (the pull request
  title, body and the diff, which are untrusted input) is replaced by a summary the model wrote, in
  an assistant-role message. Text from the repository can be carried into that summary and then reads
  like the model's own earlier words. The engine's permissions, the read-only tool set, the proxy's
  audits and the typed findings validation do not depend on that text, so this cannot widen what
  the engine can do, but it can make injected text more persuasive. The trusted system prompt (the
  fixed core and the skill) is the agent's own prompt and is sent again with every request, also
  after a compaction; the compaction request itself goes through the proxy like any other call, so it
  is counted and priced.

A compaction therefore needs either the engine to keep the format (an upstream fix) or a way for the
runner to keep it that is not a workaround of the proxy's rules; that is a follow-up. Until then the
run is bounded by the cost limit and the model's window.

## A failed run leaves a short note on the pull request (#299)

A run that fails used to leave the pull request silent: the reason was only in the Runs view. Now a
failure that a developer can understand or act on writes one short note into the run's own summary
comment (the comment of the publisher, the one a successful review is in), so there is never a
second comment.

**What the note says.** That the Dynamic Review did not complete for a named commit, one fixed
sentence for the failure, the stable error code and, where the run has one, the stable reason (for
example `checkout_incomplete` / `budget_preparation`). The sentences are a table in the code
(`FAILURE_SENTENCES` in `runner/src/code_reviewer_runner/dynamic_review/failure_note.py`): the code
is translated to words, never the other way round, like the Runs view.

**What it never holds.** Only the fixed text, the code, the reason and the head SHA. No path, file
name, diff text, log line, model output, provider message or secret: none of them is an input of the
note. A reason that is not a known stable name is left out (the code stays), and the diagnostic
detail the Runs view shows for a failure (the log, the checkout counters) is not in the note.

**Which failures.** The codes with a sentence: `checkout_incomplete`, `dynamic_budget_exceeded`,
`dynamic_model_features_unsupported`, the model provider failures (`llm_auth`, `llm_rate_limit`,
`llm_timeout`, `llm_unavailable`, `llm_bad_request`, `llm_quota`, `llm_context_length_exceeded`,
`llm_output_invalid`, `model_unknown`) and `timeout`. Everything else writes nothing and stays visible
in the Runs view only: `lease_lost`, `git_auth`, `git_forbidden` (the runner cannot write safely),
and the failures of the job's own setup or of the runner. A unit test classifies every `ErrorCode`
as one or the other, so a new code cannot be added without that decision. A job that is no longer
held by its runner writes no note either, as it writes no review.

**Update, do not spam.** The note lives in the same persistent summary comment:

- the same failure on the same head, or a different failure, replaces the note: there is one note;
- a later successful run replaces it with the review;
- a failure after an earlier successful review keeps that review's findings, resolved history and
  review state exactly as they are and shows the note on top of them (the failed head is not recorded
  as reviewed), also when that review found nothing; a pull request that was never reviewed shows the
  note alone, not "0 active findings" (a hidden mark in the comment says so, because its state looks
  like that of a clean review);
- the state of the comment is validated as for a review: a comment that is not the bot's is never
  edited, and a failure whose head the comment cannot account for (a newer review is there) writes
  nothing. A state that a review would reset is not dropped for a note;
- the first failure creates the comment with a review state that holds no findings and the failed
  head, a head the app reports as attempted (#255), so the next run, of any runner version, reads it
  like any other summary.

**Fail closed.** If writing the note fails (GitHub unreachable, a permission, anything), the run keeps
its original error code and reason; the note never changes the verdict. The result log says
`failure note: written` or `failure note: not written (<code>)`, a stable code and never the text of
the failure.

**Not covered.** The process watchdog that ends a job whose runner did not stop in time writes no
note: it cannot write safely while the job is being killed. That failure is in the Runs view.

## A newer push replaces a running review (#396, #397)

A push to a pull request whose automatic Dynamic Review is still running supersedes that run (the
Runs view shows "Superseded"). The review of the new head starts at once; the old one stops
without publishing:

- The Worker learns of it at its next heartbeat (at most 60 s later), the job process is told,
  and the model proxy refuses every further request with the code `superseded`. The engine's turn
  ends at the signal. A model request that was already sent is waited for (at most 120 s, the
  longest request), so its cost is measured and the run reports it.
- Nothing is published after the signal: the summary, the reconciliation of findings and the note
  of a failure each check right before the one write they make. A run that had already published
  before it heard of it keeps its review (it ends as a success).
- The run is not a quota run; its measured cost is usage with the reason `superseded` (the spend
  limits still count it), and a cost that is not known is never billed.
- The numbers and why they fit: [`runner/README.md`](../runner/README.md), "How long it takes";
  they are stated in `contracts/runner-api.v1.json` (`SupersedeTiming`).
- Only a Worker that names the feature `supersede` is told; an earlier Worker finishes and
  publishes as before.

## Errors an operator sees

| Code                                                                               | Meaning                                                                                                                                                                                                                                                                                                                               | What to check                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dynamic_review_disabled`                                                          | The instance gate is off                                                                                                                                                                                                                                                                                                              | Turn the gate on (below) when the rollout is ready                                                                                                                                                                                  |
| `no_capable_runner`                                                                | No runner advertised `opencode` within the timeout                                                                                                                                                                                                                                                                                    | Did the Worker's self-check pass? (the deploy canary, `dispatcher/README.md`)                                                                                                                                                       |
| `dynamic_engine_unavailable`                                                       | The runner (on hosted: the Worker) got a Dynamic job but its startup self-check did not pass, so it has no engine; nothing was run                                                                                                                                                                                                    | The Dispatcher runs no probe, so this is how a container that cannot be hardened shows. Run the deploy canary on the live deployment, read the reason, and redeploy through the pipeline (`docs/deployment-vercel.md`, section 5.3) |
| `dynamic_isolation_self_check_failed`                                              | The startup self-check did not prove user, export and network                                                                                                                                                                                                                                                                         | The runner logs the failed property, never a value                                                                                                                                                                                  |
| `dynamic_model_features_unsupported`                                               | The model's metadata (or the operator's description) says it lacks tool choice or structured output, or no provider supports the parameters                                                                                                                                                                                           | The model (OpenRouter's page lists the supported parameters); `RUNNER_DYNAMIC_CAPABILITIES` if you set one, since it is a ceiling                                                                                                   |
| `lease_lost`                                                                       | Right before the summary would have been written the job was no longer held by this runner (lease lost, job cancelled), or the app could not be asked; nothing was written                                                                                                                                                            | Normal after a requeue or a cancel. Often: the app was unreachable at that moment; the next push reviews again                                                                                                                      |
| `dynamic_config_invalid`                                                           | Model, skill or limits of the job are unusable; or no description of the model has unit costs (the provider's metadata stated none and the operator named none); or `RUNNER_DYNAMIC_MAX_COST_USD` is not a number up to the ceiling                                                                                                   | The project's settings page; `RUNNER_DYNAMIC_CAPABILITIES` (`input_usd_per_mtok`, `output_usd_per_mtok`)                                                                                                                            |
| `cost_limit_reached`                                                               | A **Diff** Review sent no further model request because its calls had cost as much as the cost limit of its project (#666)                                                                                                                                                                                                            | The project's Limits setting, or, when `usage.stoppedEarly` says `cost_limit`, the maximum cost per review of code-review.com (not a project setting)                                                                               |
| `dynamic_budget_exceeded`, `dynamic_accounting_failed`, `dynamic_policy_violation` | A hard limit or rule stopped the run. Accounting also fails when a call reports no cost                                                                                                                                                                                                                                               | The Runs page; `RUNNER_DYNAMIC_MAX_COST_USD`                                                                                                                                                                                        |
| `llm_output_invalid`                                                               | The engine finished without a structured answer, and so did its one recovery (or none was possible); the detail says how the first turn and the recovery ended (the engine's `finish=stop` covers prose, silence and a broken tool call alike; `last model calls: ...` tells which; `finish=length`: cut off at the output allowance) | The model (does it follow a required tool choice?), the output allowance in `RUNNER_DYNAMIC_CAPABILITIES`                                                                                                                           |
| `llm_context_length_exceeded`                                                      | The provider said the request is larger than the model's context                                                                                                                                                                                                                                                                      | The model's context window (its metadata, or `context_window_tokens` in `RUNNER_DYNAMIC_CAPABILITIES`); a smaller pull request                                                                                                      |

Switching a project from Dynamic to Diff (or back) starts a fresh summary comment; findings are not
carried across kinds (lead decision of 2026-10-13, see #199). Cancelling a run kills its engine's
whole process group and removes its temporary directory.

## The Worker for Dynamic Review

Every Worker is a container of the Worker image, started by the Sandbox-Launcher in a fresh Vercel Sandbox VM with the
flags of the hardened container spec (`contracts/worker-container.v1.json`). There is no separate Dynamic deployment:
the Dispatcher serves Dynamic jobs when `opencode` is among its `DISPATCHER_ENGINES` (the default) and the snapshot pair
is set, and the deploy canary proves the container's hardening before a deployment is promoted
(`docs/deployment-vercel.md`, section 5.1; `dispatcher/README.md`, "The canary probe").

| Setting (the Worker's environment) | Default | Why                                                                                                                                                                                                            |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_DYNAMIC_MAX_COST_USD`      | empty   | Fallback (#689): the most one run may cost, in USD, when the app sends no maximum with the job; empty is 1.00; up to 20 (see "Hard limits")                                                                    |
| `RUNNER_DYNAMIC_CAPABILITIES`      | empty   | Optional ceiling and override of the model description (see "The model"). Empty: the description the app sends with the job applies, or, without one, the one built into the runner for the default model only |

The memory limit and the VM size per Worker kind are the Dispatcher's `DISPATCHER_WORKER_CONFIG`
(`docs/deployment-vercel.md`, section 6). The container runs the supervisor as root with only the capabilities of "The
engine boundary", sets `no-new-privileges`, bounds its process count and has no swap, so a memory peak shows up as an
OOM kill of the job rather than as a slow host. It publishes no port and reaches only the app. The slot's proxy and
engine ports are fixed (10180, 10181); they, the engine user and the Diff job user belong to the image and the spec, not
to settings. Do not set `RUNNER_OPENCODE_COMMAND` by hand: the Worker ignores it.

## Activation, step by step

This is the order to follow; every step can be stopped and rolled back.

**Deploy order.** `base.attemptedShas` (#255) is only sent when it is not empty and
`base.attemptedShasTruncated` (#257) only when it is true; a Worker from before the respective issue
rejects the key (its job contract is closed). A release deploys the App before the Dispatcher and the snapshot, so the
live App can meet an older Worker for a few minutes; a newer Worker with an older app is safe: an absent key means none
and false.

**Before you start.** A hosted deployment (`docs/deployment-vercel.md`) whose last deploy canary passed, with the
workspace's LLM key entered (Settings, LLM; Dynamic Review reuses it, there is no other key); and, for the model you
choose, the knowledge of what it supports (tool choice "required" and structured output).

1. **Upgrade every app instance** to the version that routes by `review_kind`
   (`contracts/README.md`, "Rolling out Dynamic Review"). A previous-release app on the same database
   could hand a Dynamic row to a Worker as an untagged Diff job. Do not continue until all instances
   are upgraded.
2. **Describe the model** only if you want to narrow what the app reads from the provider's metadata
   ("The model"): `RUNNER_DYNAMIC_CAPABILITIES={"tool_choice_required": true, "structured_output": true,
"max_output_tokens": 32768, "input_usd_per_mtok": 0.5, "output_usd_per_mtok": 2}` is a ceiling for every
   Dynamic job. Nothing is needed for the default model or for any tool-capable OpenRouter
   model whose metadata states its window and prices.
3. **Verify the self-check.** The deploy canary (`pnpm --dir dispatcher probe:canary`, workflow
   `dispatcher-canary.yml`) must report `opencode` among the engines. If it does not, the reason is in the same
   verdict: see the table in "The startup self-check". Fix it and redeploy. Do not go on while it is not advertised. Diff
   jobs are unaffected either way.
4. **Turn the gate on.** As instance admin open **Admin, Setup, Instance, Dynamic Review**, tick _Allow
   Dynamic Review on this instance_, confirm that step 1 is done and save. The control is server side
   and admin only; it uses the instance settings setter (lock, then cancellation), never raw SQL.
   Nothing changes for existing projects: all are Diff until step 5.
5. **Choose one project to try it on:** set its review kind to Dynamic on its settings page. Open a
   pull request (or press the play button of the project in the project list and pick one) and look at the Run: the kind, the model and a result URL are
   visible, and the previous successful summary stays in place if a run fails.

**Rollback** (the full procedure and its reasons are in `contracts/README.md`):

1. Switch the gate off in the same admin card. That stops new Dynamic jobs and cancels the waiting ones
   with `dynamic_review_disabled`; **running jobs finish** on their leases. Projects set to Dynamic
   get a visibly failed run, never a silent Diff review.
2. To stop Dynamic work at the Dispatcher too, remove `opencode` from `DISPATCHER_ENGINES`
   (`docs/deployment-vercel.md`, section 5.4).
3. Before any **downgrade of the app**, check that no Dynamic job is `queued` or `running`, as
   `contracts/README.md` says. Switching a project from Dynamic back to Diff starts a fresh summary comment.

## Capacity: slots, memory and what is not measured

Every Worker runs exactly one job in a VM of its own, so a Diff job never occupies a Dynamic job's slot; what the
Dispatcher's pool cap (`DISPATCHER_MAX_RUNNING`) limits is the number of VMs.

The shipped defaults are **one Dynamic job per VM** and a **container limit of 1536m of a 2 GB VM with no swap** (`DISPATCHER_WORKER_CONFIG`, `docs/deployment-vercel.md`, section 6): at least 1 GiB per slot plus the runner and proxy reserve. That is the
spike's conservative proposal, not a measurement. The spike's stock trace (11 model calls, 5.8 s,
596.57 MiB peak RSS of the engine process with fake model answers) is **not** a capacity figure: it
excludes the export's page cache, the proxy, the runner and helper processes, and it used a tiny
repository. Do not run more than one Dynamic job in a VM, and do not lower the limit below 1 GiB per slot plus the
reserve, until the following has been measured on your deployment target. The read-only root
filesystem (#249) puts the job working directories in a 512 MiB `tmpfs` (`/tmp`), which is charged
to this limit like any other memory: it is part of the figure to measure, not extra.

**What an out-of-memory kill does.** With no swap, a peak above the limit makes the kernel kill
processes of the container. If the engine or the job process is killed, the Worker ends the job, the
job's engine-user processes are swept (also before the next job starts), the job directory is removed
by the Worker, and the run fails; the previous summary comment is untouched. If the kernel kills the
Worker or PID 1, the VM's container ends, the lease on the job
expires and the job is taken back or fails per the normal rules.

**Manual measurement (not part of CI; it needs a real host).** Record the host, the kernel, Docker's
version, the cgroup version and the image digest with the result.

1. Start a Worker container as in the deploy canary on a test VM with a test repository at
   the size you want to support (the checkout limits are in `docs/dynamic-checkout.md`) and a model
   endpoint you control.
2. Run a worst-case job: the largest export and the largest tool-result envelope the limits above
   allow. Read the container's cgroup peak, not process RSS: with cgroup v2,
   `docker exec <worker> cat /sys/fs/cgroup/memory.peak` and `memory.events` (`oom_kill`);
   with v1, `memory.max_usage_in_bytes`. `docker stats` is a coarse cross-check.
3. Measure one slot only. The shipped image has one engine user and one pair of ports, so a second
   concurrent Dynamic job is refused by the lease (`dynamic_isolation_self_check_failed`);
   concurrency above one needs a pair of ports, an engine user and a ruleset per slot, which is not
   shipped.
4. Inject an OOM kill and an engine kill (`docker kill --signal=SIGKILL` of the engine's process, or a
   deliberately small container memory limit in `DISPATCHER_WORKER_CONFIG`) and check that the previous comment is preserved,
   no process of the engine user and no job directory survives (`docker exec <worker> ps -eo
user,pid,cmd`, `ls /tmp`).
5. Write the measured peaks, the host and the recommended concurrency per GiB into this page. Until
   then no recommendation beyond the defaults exists. The byte-to-token calibration of the token cap
   (#235) uses the same runs.

No prices, quality or latency claim is made here; the offline benchmark plan is in the spike
write-up and needs a separately authorised run.

## Known limitations and residual risks

These are known and accepted for the switch-on decision, or tracked in an issue. They are not hidden
by the defaults.

- **A run that wrote the summary and then ended without success (#255).** The publisher refuses a
  comment whose recorded head it cannot account for, with `review_not_published` (fail-closed on
  purpose, #199). A run can edit the comment and then fail (the watchdog or `SIGTERM` fires after the
  write, the lease is lost, the completion report is lost): the comment says head A while the app has
  no succeeded review of A. The claim therefore carries `base.attemptedShas`: the heads of the
  pull request's earlier jobs of the same kind that _ran_ and did not succeed (`failed`, or at least
  one lost attempt; a job cancelled or superseded while still waiting never ran and is not counted, while a
  superseded job that did run counts, #397),
  created after the last succeeded job and before the claimed one (newest first, at most 20, the key
  is left out when there are none). The publisher accepts such a head next to the job's own head and
  `previousReviewedSha`, reconciles from that state and edits the same comment; the next success
  makes it the previous review again. A head the app never attempted (foreign, tampered, newer) is
  still refused.
- **The attempted-heads list is bounded, so a truncated claim recovers with a full review (#257).**
  After more than 20 distinct heads that ran and failed _without_ a success in between, an older head
  of the summary comment can fall out of the list. The app then also sends `base.attemptedShasTruncated:
true` (left out otherwise), and a state head the job cannot account for on the **bot-owned** summary
  (author and exact identity marker, and a valid state) no longer ends in `review_not_published`: the
  run is a full review (the checkout is full whatever `comparison` the claim declares), the old state
  is dropped (nothing of it is carried over as active or resolved, nothing is resolved by inference)
  and the same comment is rewritten. The history of resolved findings restarts **and the active
  findings are re-derived from scratch too**: a finding of the earlier summary is only on the pull
  request again if this run finds it. The rewritten summary says so in a one-shot notice ("Full
  review after a state reset: ..."), its footer no longer claims the previous state is kept, and the
  result log of the run carries `state_reset_attempted_shas_truncated` (visible in Runs). The notice
  is not part of the state, so the next normal run renders without it. A comment that is not the bot's, a corrupt state and a claim that was not
  truncated stay fail-closed. Residual risk: on a truncated claim a late result of an older run can no
  longer be told from a lost head and may overwrite a newer review; the next push reviews again.
  Since #260 the run asks for its lease right before it writes (see "How a Dynamic job reaches an
  engine"), so only a run that loses the lease _after_ that check and before its write lands (a few
  requests of GitHub) can still overwrite; the check is not a lock and the write is not fenced by the
  app. The check also makes a run on a plain (not truncated) claim publish nothing as a zombie.
  A lost edit response is recognised by re-reading the comment (it must hold exactly the body sent).
- **Hidden Unicode tag characters in repository files reach the model untouched (#247).** An attacker
  who controls repository text can hide instructions in tag characters.
- **A restarted container runs with `NET_ADMIN` again, by design (#249).** The capability is dropped
  per container lifetime. Because the root filesystem is read-only, a compromised root supervisor
  that crashes the container cannot have changed `nft`, `tini` or the runner source for the restart;
  what it can still do is bounded by the three tmpfs, which are empty after the restart. PID 1
  (`tini`) still holds the two capabilities, and the supervisor's startup is the same code as before.
- **The byte-to-token estimate of the token cap is uncalibrated (#235).** The cap is preventive and
  conservative, but its calibration against real tokenizers is open.
- **Nested `AGENTS.md` and similar files** in the repository can influence the model. The core marks
  repository content as untrusted data and the engine has no write, execute or general-network
  capability, but there is no guarantee of model resistance.
- **Repository skills can steer a review (#701).** The agent can load the skills of the repository
  (`.claude/skills`, `.agents/skills`, `.opencode/skill(s)` at the root of the head checkout), and a
  pull request can ship or change one: its description is listed in the system prompt and its body
  is read when the agent loads it. This is the same class as a nested `AGENTS.md` and is accepted
  by the owner: a skill is a document, the core ranks it below the fixed rules, and the agent has no
  tool that writes, runs a script or fetches, so a skill can change what the review says and not
  what the engine can do. The exposure is bounded: at most 50 skills and 8 KiB of names and
  descriptions are exported (a description is cut at 300 characters). The `SKILL.md` frontmatter is
  rewritten by the runner because the engine parses it with `gray-matter`, which evaluates a
  `---js` block. See "Repository skills" in
  [Dynamic checkout](dynamic-checkout.md#repository-skills-701).
- **The boundary is the container, not a sandbox.** The engine user's network is confined by nft rules
  that cover TCP, UDP and IPv6 (with the fallback ruleset: IPv6 by switching it off, #345) but not AF_UNIX (kept empty by mounting and sharing nothing), and the
  supervisor is a root process that parses untrusted Git objects and HTTP. See ADR 0003.
- **Supported hosts.** Linux/amd64 (x86_64) glibc images only, on a Docker host whose kernel has
  `nf_tables` (the `ip` family is enough: see the fallback ruleset). **Dynamic Review needs x86_64.** The image build fails on another platform (the pins have no other platform, #264), so there is no arm64 Worker. Nothing is tested on
  rootless Docker, user-namespace remapping or Podman.
- **Capacity beyond one slot is unknown** (see above).
- **Hosted activation needs the egress gate (#82).**

## Not covered

- The firewall of hosted runners (#82) is a separate gate for hosted activation.
- Running repository code (build, tests) is out of scope (#130 and #82).
- Guarantees about model behaviour: see "Known limitations and residual risks".
