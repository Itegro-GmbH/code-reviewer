# The Implementer: operator guide

The Implementer is the part of the Software Factory that carries out a task in a repository: a person describes the
change, an agent works on a new branch in a throw-away VM, and the commits arrive on that branch on GitHub. This guide
says what it does, what it refuses, what it costs and what to look at when it fails. How to switch it on is in
[`factory-bring-up.md`](factory-bring-up.md) (section "Switching on the Implementer"), the live test after the release is
[`implementer-smoke-test.md`](implementer-smoke-test.md), and the code's own notes are in `app/src/implementer/README.md`
and `runner/README.md`.

The Implementer exists in the factory deployment only (the capability `implementer`, [`app/src/capabilities/README.md`](../app/src/capabilities/README.md)).
code-review.com has none of it: no page, no route, no job kind, and its Dispatcher entry never lists the kind.

## What it is

A member of the workspace opens `/w/<slug>/implementer`, picks a repository, a base branch, a **new** branch name, writes
the task, picks a model and, if they want, a lower cost limit. The task becomes one job. A fresh Sandbox VM starts, an
OpenCode agent works in a clone, and its commits are pushed to the new branch. It does not open a pull request, does not
merge and never touches the base branch. The person finds the branch on GitHub and the run on the Runs page.

Every member of a workspace may start a task (the permission `start_implementer_task`, minimum role member; one line in
`app/src/workspaces/permissions.ts` raises it). The App pushes with its own identity whatever GitHub rights the person has, so
this is a decision for internal use: before outside users arrive, move it to Admin and up.

The models are those that serve Dynamic Review: on the operator's key a released catalog entry of that kind, on the workspace's
own key a model of a provider that the models catalog lists and for which a key is saved. The agent is always OpenCode on the
native path; the two registry providers (Anthropic, OpenRouter) are not offered.

## Session and Turn

- A **Session** is one branch of one repository, the saved OpenCode session id and version, the last pushed commit and a
  summary. Per repository one session holds a branch name (a unique index), and it holds it even if the branch never reached GitHub:
  a turn that failed before it started keeps its name. A name that exists on GitHub already is refused at submit.
- A **Turn** is one instruction. In this slice a session has exactly one turn; more turns per session come later. A turn is a
  row of `jobs` too, so its status is the status of its job: there is no second state machine.
- Two turns of one session never run at once; sessions of one repository run in parallel (the factory's
  `RUNNER_DISPATCH_MAX_RUNNING` is 2 for all kinds together, and a turn can take an hour, so reviews wait behind tasks when two
  are running; raise it and the Dispatcher entry's `maxRunning` together).

## The data flow

1. **Submit.** The form posts to `/api/w/<slug>/implementer/tasks`. In this order, and nothing is written before the last
   step: the body is valid; the repository is the workspace's and active; the installation accepted Contents write; the base
   branch exists and the new one does not (and is not a folder of an existing branch or the other way round); the model is
   allowed; the cost limit is at most the operator's maximum. Then session, turn and job are written in one transaction and
   the Dispatcher is woken. The same client request id sends the same task back and writes nothing.
2. **Claim.** The Dispatcher claims the job, creates a VM from the golden snapshot (2 vCPU, 4 GB), makes the work volume `/work`
   in it and starts the Worker container with the Implementer's profile. The Dispatcher never sees a token or a key.
3. **Fetch.** The Worker asks the App for the job. Here, and only here, the App makes a git token for exactly this repository
   that holds `contents: write` and `metadata: read` and nothing else (no pull requests, no issues, no checks), and the model
   access of the chosen entry or key. The token lives with the turn and is switched off when the turn ends, however it ended.
4. **Prepare.** The runner (root in the container) clones the base branch with depth 1 into a bare mirror that only it can
   enter. The agent gets a local clone of the mirror in `/work/repo` with no remote, no credential, the system identity and a
   new branch at the base tip.
5. **Work.** OpenCode runs as an unprivileged user in `/work/repo` with a configuration the runner wrote. It reads, edits,
   writes, searches and runs shell commands; it cannot fetch web pages, search the web, start sub-agents or ask a question.
   The task is the user message. When it ends its turn with uncommitted changes it gets one more message to commit them; what
   is still uncommitted afterwards is committed by the system ("Implementer: uncommitted changes of the turn").
6. **Push.** While the agent works, the runner looks at its branch and pushes new commits from the mirror, at most every
   120 seconds, and once more at the end (below, "The git rules"). Before every push, and once more right before `git push`
   itself, it asks whether the lease is still held; only `held` allows the push. A lost lease ends the turn `lease_lost` with
   nothing pushed after it.
7. **Report.** The Worker reports the result once: base and head commit, whether the head was pushed, the commits (at most
   200), the changed files (at most 500), the agent's closing summary (at most 8,192 characters, with known secrets removed),
   the OpenCode ids and the usage. The session becomes idle and the Runs page shows branch, commits, files, summary and cost.

The repository's own `opencode.json`, `opencode.jsonc` and `.opencode/` are not in the agent's working tree, and nothing
executable or configurable comes from the repository: no plugin, no MCP server, no formatter, no setup script, no repository
skill or instruction file. The agent is told when it touched such a name that it is not kept.

## The git rules

Two layers, and only the second is a guarantee.

**The accident guard.** A `reference-transaction` hook, root-owned and read-only in the image, keeps a well-meaning agent on
its branch: the branch may only move forward and must contain the start commit, `HEAD` may only follow it, no other branch, tag
or ref may be created or changed, the branch cannot be deleted, so amend, reset, rebase, a branch switch or a new branch are
refused with a message the agent sees. It needs git 2.53 or newer (older git does not run the hook for a change of `HEAD`);
the runner runs the guard's own test matrix at the start of each turn and the turn fails (`setup_failed`) if it does not hold.
The hook also writes every tip update to a spool that tells the runner to look. It is a hint, not evidence.

**The push check.** The runner never runs git inside a directory the agent controls. To push, it fetches the agent's branch
into a scratch ref of the mirror (a failed or refused fetch is not guessed at), and checks, from exit statuses and objects
and never from what git printed: the tip contains the start commit; it descends from the tip verified before; every commit
since the start has exactly one author and one committer line, and **the committer is the system identity**. This last check
catches accidents (a changed `user.name`, a commit made by a tool with another identity); it is not a proof of who made a
commit, because the agent is handed that identity in its environment. Only then is the
mirror's branch moved (compare and swap) and pushed to GitHub without force. A branch that was rewritten below what is pushed
ends the turn `branch_violation`; GitHub keeps the last good tip.

**What a hostile agent can and cannot do.**

| It can | It cannot |
|---|---|
| Bypass the hook (`git -c core.hooksPath=/dev/null`, a hand-written ref file, `git config` in its clone) and rewrite its own branch | Get a rewrite onto GitHub: the push check refuses it and the turn ends `branch_violation` |
| Write commits with any author and, since it knows the system identity, with that identity as committer too, so the committer check passes. Only the committer is checked on purpose, because `cherry-pick`, `am` and a merge keep the author of a legitimate commit | Make the check mean more than "no accident": it cannot tell the agent's honest commit from a forged one |
| Fill the disk, burn CPU and run for the whole time limit | Keep working after the time limit or after the cost limit is used up: the runner ends the engine and the proxy refuses the next model call |
| Read everything it can reach in the VM, including the repository and the files it installed | Read a credential: the git token is in the environment of one git process of the runner and in no file, argument or URL; the model key stays in the App, the agent has a loopback proxy and a job capability |
| Reach the registries on the allowlist | Become root (no sudo), switch the rules of the network off, or reach any other host |

The commits that pass carry one committer, the system identity (the product's name and "Implementer"). Who started the task
is not in the commits: it is in the run (the session's `created_by`, shown on the Runs page). On GitHub the committer therefore
says "an Implementer task", not who asked for it, and not that the system made the commit.

## Network in the agent phase

The agent's user has no route to the internet. The firewall of the container (nftables, keyed on that user) allows two
loopback ports only: the model proxy and, when the container's `RUNNER_IMPLEMENTER_NETWORK` is `registries`, the egress proxy.
`none` starts no proxy and the agent has no network at all. The runner itself talks to GitHub as root, for the clone and the
push.

The egress proxy tunnels HTTPS `CONNECT host:443` to an **allowlist of package registries** and nothing else:

| Name | For |
|---|---|
| `registry.npmjs.org`, `registry.yarnpkg.com` | npm, pnpm, yarn |
| `pypi.org`, `files.pythonhosted.org` | pip, uv |
| `index.crates.io`, `static.crates.io` | cargo |

There is no Go module proxy: it fetches from any host named in the path and would be a way out. The list is a constant of the
runner; no job, repository, tool or variable can add to it. The proxy refuses an address that is an IP literal in any
spelling, a name with user information, any port other than 443, and a name that resolves to even one loopback, private,
link-local or otherwise special address. It holds at most 32 tunnels and 64 connections and cuts a silent tunnel after 120
seconds. A tool that ignores the proxy variables has no network at all, which fails closed.

## Environments

An environment is a start configuration for a task: a **name**, a **size** and a **setup script**. They are kept per workspace on
the page `/w/<slug>/environments` (navigation entry "Environments", between Implementer and Runs; only in a deployment with the
capability `implementer`, anywhere else the path is a 404 like an unknown one).

- **Who:** every member sees the list and the scripts, because every member may use one. Owners and Admins create, change and
  delete (`manage_implementer_environments`). A workspace holds at most 50.
- **Sizes** are the platform's: 1, 2, 4, 6 and 8 vCPU with 2 GB per vCPU (2, 4, 8, 12, 16 GB), the range of the Pro plan. The list
  is `contracts/environment-sizes.v1.json`; the app and the Dispatcher (`SANDBOX_VCPUS`) are both held to it by a test. A task without an environment
  keeps the standard, 2 vCPU and no script.
- **The script** is text of at most 64 KB (UTF-8), literal data, stored exactly as written: no trimming, no changed line ends, no
  checking of what it says. Only what cannot be stored as text (a NUL byte, half of a character) is refused. It has no secrets
  field and the page says so. **Setup scripts do not run yet** (the runner part of #818 is not built): the text is saved and nothing is
  done with it when a task starts, and the page says so.
- **Names** are unique within a workspace, whatever the case.
- **The form** has an optional picker "Environment". It lists the standard first and then the environments with their size. A task
  that names none is the task of before.
- **The task keeps its own copy.** When the task is sent, its turn copies the environment's name, size and script (`implementer_turns.environment_*`, no foreign key).
  Changing or deleting the environment later touches no running or past task, and sending the same request again after the environment
  was deleted still gives the first task back. The Runs page shows which environment and size a task used.

Routes (all `Cache-Control: no-store`, errors `{ "error": <code> }` with the codes of `app/src/implementer/environments/errors.ts`):
`GET /api/w/<slug>/environments` (every member; `?view=picker` is the list for the task form's picker, without the scripts), `POST` the same path, `PUT` and `DELETE /api/w/<slug>/environments/<id>` (Owner or
Admin).

### How the size reaches the VM

The Dispatcher creates the VM when it claims the job, before any Worker exists, so the size comes from the App's answer to the claim and from nothing else:

1. The claim answer (`SplitClaimResponse`, authenticated with the Dispatcher's credential) carries `job.vcpus` for a turn that has an environment, and for nothing else. Neither the name nor the script is in it.
2. The core of the Dispatcher believes the number for the kind `implementer` only. A review job's answer may say anything: the field is dropped, so a review can never name a size.
3. The Launcher accepts only the sizes of `SANDBOX_VCPUS` (1, 2, 4, 6, 8). Any other number fails the launch with the code `sandbox_size_unsupported` (not retryable, nothing created); a size the platform itself refuses at the create reaches the usual codes (`sandbox_rejected`, `sandbox_quota_exceeded`).
4. **Precedence** of the size of an Implementer VM: the turn's environment, then `DISPATCHER_WORKER_CONFIG.implementer.launcher.vcpus`, then the default of the kind (2). The container's memory follows the size when the job names one (the operator's `container.memory` for the kind applies to the jobs that name none): 1 vCPU gets 1536 MB (the 1.5 GB a review runs in), n >= 2 vCPU get `2048 n - 1024` MB (3, 7, 11 and 15 GB), the reservation 512 MB below (256 MB for 1 vCPU), no swap.
5. The Dispatcher reports the VM's size with the VM (`vcpus` in `VmStartRequest`) for an Implementer job only (an App of the release before refuses a field it does not know, and a refused report only costs the measuring of the minutes), and the App keeps it in `job_vm_runs.vcpus`, so that minutes can be priced per size later. Billing is off in the factory; nothing is charged by size today.

What does not depend on the size: the work volume is a directory of the VM's disk (64 GB on the Pro plan, whatever the vCPUs), `pids` stays 2048, the steps of the volume and `IMPLEMENTER_PROBE_EXTRA_SECONDS` are per command, the canary runs at the configured default size and proves the image, Docker and the hardening, not a size, and a VM lives `timeoutSeconds` plus the margin (at most 6 hours, under the platform's 24 hours per session) whatever its size, so the reaper and the stop route recognise it by its name. In the privileged lane `/work` is a tmpfs of 3 GB.

The setup script itself is not run by this part of #818: the claim path carries it (`implementer.environment`, only to a Worker that names the claim feature `implementer_environment`, otherwise the task ends `implementer_engine_unavailable`, free), and the runner part follows. `environment_setup_failed` (the code of a script that fails or runs out of time before the model is called, free) and the `setup` block of a result (the end of its scrubbed output, shown in Runs) are in the contract and in the Runs page already.

## Limits

| Limit | Value | Where it is decided |
|---|---|---|
| Cost of a turn | The operator's maximum per turn: 5.00 USD once the owner has set it in the factory's admin portal (General, Limits, "Maximum cost per review"); the default is 1.00 USD until then, which is too low for a task. A person may ask for a lower limit on the form (never above that maximum or 100 USD). Without one, the maximum applies | Claim, and the proxy of the Worker: it refuses the next model call once the calls so far cost that much, so a turn can end slightly above it by the last call |
| Steps of the agent | None. There is no step limit, no plan, no approach rule: the cost limit is the brake | |
| Time of a turn | 3600 seconds. The runner keeps the last 180 seconds for the commit of what is left and the final push (a third of a short limit). The Dispatcher stops the Worker at 3600 seconds (`DISPATCHER_WORKER_CONFIG`, `implementer.timeoutSeconds`, 60 to 21600) and the App fails a turn still running after 70 minutes with `timeout`; the App cannot read the Dispatcher's setting, so change the constants with it (`docs/dispatcher.md`). The runner holds a turn to the smaller of its time limit and `RUNNER_JOB_TIMEOUT_SECONDS` | Dispatcher, runner, App |
| Stop | On SIGTERM the engine is ended at once, what is committed is pushed (if the lease is still held) and the turn ends `runner_shutdown`. The job process gets a grace of 60 seconds, ends itself after 55, and the container's stop timeout is 90 seconds; one question about the lease is bounded to 25 seconds at a normal end and 10 on a stop | Runner, container spec |
| Task text | 20,000 characters | Form and route |
| Branch name | At most 200 characters, each part between slashes at most 240 bytes, git's rules, not the base branch | Form and route |
| Base branches offered | 100 names, default first; a base beyond that can be typed | Route |
| Result | 200 commits, 500 files, 8,192 characters of summary, the whole report under 4 MB (Vercel cuts a body at 4.5 MB) | Contract and runner |
| VM and container | By default 2 vCPU and 4 GB for the VM, 3 GB for the container without swap, 2048 processes, `/work` mounted `nosuid,nodev`, exec allowed. A task whose environment names a size gets that VM (1 to 8 vCPU, 2 GB each) and a container memory that follows it ("How the size reaches the VM") | Dispatcher (`DISPATCHER_WORKER_CONFIG` can override the default sizes) |
| Parallel work | `RUNNER_DISPATCH_MAX_RUNNING` (2) for all kinds together, and one running turn per session | App and Dispatcher |

**Billing.** Turns are billed at the Dynamic rate for now: the billing code treats the kind as `dynamic` (`projectKindOf`),
so the minute rate of Dynamic applies and the model cost is passed on as for a Dynamic Review. The factory has billing off
(`PRODUCT_CAPABILITIES` without `billing`), so nothing is charged yet. Who pays when a turn fails is in the next table.

## When a task fails

The Runs page shows one sentence per code. Plain words, with who pays (free: the run is not billed; charged: the model was
used):

| Code | What happened | Billed | What to do |
|---|---|---|---|
| `branch_exists` | Raised only at the first push, which is the first batch after the agent's first commit or the final push, when GitHub answers `[rejected]` because the branch exists with other history (someone made it after the submit check). The agent has worked by then, so the model was used, and the run is still not billed. Nothing was pushed and the agent's work is lost | free | Choose a new branch name and start again |
| `base_branch_not_found` | The base branch was not on GitHub when the runner cloned | free | Check the name; it may have been deleted since the submit |
| `clone_failed` | The repository could not be downloaded | free | Try again; look at the installation if it persists |
| `environment_setup_failed` | The setup script of the task's environment failed (a non-zero exit) or ran out of its time limit, before the model was called, so nothing was used. The code and the page that shows it exist; the runner that reports it is the next part of #818, so no task ends with it yet. The Runs page shows the exit status, the time and the end of the output (scrubbed of known secrets) | free | Fix the script in Environments and send the task again |
| `setup_failed` | The runner could not prepare the workplace before the turn started: git too old, a guard file missing, the guard's self-test failed, the mirror could not be made, a port of the slot was taken. It is the free code of a turn that never started: once the model was used, the same trouble shows as `branch_violation`, and an unexpected error as `agent_gave_up`. The Runs-page sentence says "the repository's own set-up steps", which is not what happens: no repository script is ever run | free | Look at the Worker log of the job; it is the image or the VM |
| `agent_gave_up` | The agent ended without a commit and nothing to commit, or its engine died after the model had been used (what it had committed is pushed when possible). The summary also says when files the agent wrote could not be kept, such as `opencode.json` | charged | Read its summary; try again with a clearer or smaller task |
| `push_rejected` | The repository did not accept the pushed work (a rule, a permission, a push of `.github/workflows/` which is never allowed), or the final push could not reach GitHub. Work pushed earlier stays on the branch | charged | Check the branch, then start again |
| `branch_violation` | The branch was rewritten below what was pushed, a commit has a committer that is not the system, or the repository could not be committed or checked after the agent ran. Commits pushed before stay; nothing after was saved | charged | Look at the branch; the agent did something it was told not to |
| `cost_limit_reached` | The calls so far cost the limit, so the next call was refused. What was committed is pushed when possible: check the branch | charged | Raise the limit within the maximum, or make the task smaller |
| `time_limit_reached` | The turn ran into its time limit. What was committed was pushed when possible | charged | Check the branch for what reached it |
| `git_write_not_granted` | The installation has not accepted Contents write | free | Accept the new permission on GitHub ([`github-app.md`](github-app.md), "Update an existing App") |
| `implementer_engine_unavailable` | The Worker did not advertise the engine (its start-up checks failed, or the container is not the Implementer's profile), the claim carried no cost limit, or the capability is off in the App | free | The Worker log names the stable reason (`implementer_git_too_old`, `implementer_work_dir_not_exec` and others); see the rollout |
| `implementer_config_invalid` | The turn's settings cannot be used: a model entry the proxy cannot serve, the clone address, a turn without its record, or a job that reached the runner with neither `maxCostUsd` nor `operatorMaxCostUsd` | free | Look at the job log for the reason word |
| `no_capable_runner` | Nobody that can run tasks claimed the turn within 30 minutes (3 hours while a Worker was busy with others of the kind). Here: the Dispatcher's entry for the factory does not list `implementer`, so the Launcher does not advertise it; or, until 2026-11-01, a slow listing of the platform's VMs (next row) | free | Rollout step 2, and the next row |
| `fleet_list_failed` (a Dispatcher log line, not a code of the run) | With two or more Apps the Dispatcher lists the platform's VMs, at most once in five seconds, to count what each App occupies. A listing that gives no answer within 4 seconds counts as failed (the line carries its `ms`); the last good one is used for up to a minute, and after that the Dispatcher counts by its own launches and the claim goes on: the cap is a soft limit, the platform's concurrency limit the hard one. A failed listing no longer stops claims (it did on 2026-11-01, when 283 stopped VMs made the listing take 5.1 s and jobs ended `no_capable_runner`). Every listing that answers logs `fleet_listed` with its `ms` and `count`; the reaper deletes ended VMs after one day, 50 per run | free | A `fleet_list_failed` is a warning, not a cause of a task that does not start. Compare `ms` and `count` of the `fleet_listed` lines with the 4 seconds; if `count` grows, look at the reaper's `reap_done` (`deleted`, `deleteFailed`, `deleteKept`, `deleteNotTried`) |
| `dispatch_unavailable` | Nothing claimed the turn within `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default); the Dispatcher is down, protected or full ([`deployment-vercel.md`](deployment-vercel.md), 5.3) | free | Look at the App's sweep log and the Dispatcher's |
| `timeout` | The turn was still running 70 minutes after it started, so the app failed it. The Worker normally ends it before at its 3600 seconds | free | Check the branch for what was pushed |
| `lease_lost`, `lease_expired` | The Worker no longer held the turn when it was ready, or stopped reporting, or the lease could not be confirmed before a push; the result was not saved and nothing is pushed after the loss. Work pushed before stays on the branch | free | Start again if the branch lacks the work |
| `runner_shutdown` | The Worker was told to stop (SIGTERM) while it worked: the engine was ended, what is committed was pushed if the lease was still held. A turn of the Implementer is never run twice, so the app gives it back and it ends here, as its last attempt. The usage of a stopped turn is not recorded yet (#799) | free | Check the branch for what was pushed; start again with a new branch name |
| `runner_error` | The runner failed unexpectedly before any model call | free | Read the Worker log; start again |
| `dynamic_accounting_failed` | The model usage could not be accounted for, so the turn ended and its cost is not known. The work may be done: check the branch | free | Check the branch |
| `llm_auth`, `llm_quota`, `llm_rate_limit`, `llm_timeout`, `llm_unavailable` | The model provider refused the key, has no credit, limits requests, is slow or is down. On the operator's key these are the operator's to fix and are not billed to the workspace; on the workspace's own key they are the workspace's | free on the operator's key, charged on the workspace's own | The key or the provider, then start again |

Every other code is a sentence of the Runs page with a billing class in `app/src/billing/outcome.ts`, which decides who pays
and fails its test when a code has no class. The table above is what a task is likely to meet.

Before the job exists the form refuses with its own codes (`IMPLEMENTER_BRANCH_EXISTS`, `IMPLEMENTER_WRITE_NOT_GRANTED`,
`IMPLEMENTER_MODEL_NOT_ALLOWED`, `EXCEEDS_OPERATOR_MAXIMUM` and the others of `app/src/implementer/errors.ts`), each with a
sentence of its own. A turn that fails before it starts keeps its branch name: the session holds it, so the retry with the
same name is `IMPLEMENTER_BRANCH_EXISTS` and the form asks for a new name. Where a turn stopped, the Runs page shows the commits
that were pushed first. A Worker that is stopped while it works (`runner_shutdown`) is free.

## Out of scope

- **The repository's own setup scripts.** The repository's own install and set-up steps are not run for the agent; it installs what it needs
  through the registries and may run what it finds. A setup script is the workspace's choice, in an environment (above).
- **Docker.** There is no Docker, no sudo and no system package installs. A repository whose tests need containers cannot be
  tested here.
- **Secrets for tests.** No credential of any kind reaches the agent: tests that need an API key or a database URL cannot run.
- **Pushes that touch `.github/workflows/`.** The App has no `workflows` permission and never asks for it for this; GitHub
  rejects such a push and the task ends `push_rejected`. Change workflow files by hand ([`github-app.md`](github-app.md)).
- Opening or merging a pull request, a second turn on the same branch, a task on an existing branch, forks, other platforms
  than GitHub.

## What is accepted, and until when

These are decisions of the owner, not oversights.

- **Hooks are an accident guard.** A hostile agent can rewrite its own clone; it cannot rewrite GitHub (table above).
- **The committer check is an accident check.** The agent knows the system identity, so a hostile agent can write any author
  and the system committer. Nothing on GitHub proves that the system made a commit.
- **A branch created meanwhile.** If someone creates the branch after the submit check and before the first push, and it
  points at the base tip or at an ancestor of the agent's tip, GitHub fast-forwards it: the task lands on a branch it did not
  create, with that person's earlier history under it. Any other history ends the turn `branch_exists`. The window is the
  time between the submit check and the first push, which can be most of a turn.
- **Exfiltration through a registry.** The egress rule looks at the name of the tunnel and nothing inside it. `registry.npmjs.org`
  accepts uploads, so an agent that holds an npm token (from the repository, or from prompt-injection text) can `npm publish`
  any file it can read, and the registry names sit on CDN addresses that other tenants share, so another endpoint behind the
  same addresses may be reachable. This is accepted for **internal use, on own repositories** only. **#784 must be closed before
  external users** or a repository that is not ours: a read-only caching registry mirror (GET of metadata and tarballs only)
  or an intercepting proxy with a method allowlist, so that the agent has no tunnel to a public registry at all.
- **Any member may start a task.** See "What it is". Move to Admin and up before outside users.
- **No Go registry** (above) and **no `.github/workflows` pushes**.
- **Turns are billed at the Dynamic rate** until the Implementer has a rate of its own.
- **A turn that fails before it starts keeps its branch name** (#785).
- **Follow-ups that do not block the first release:** the retry batch of write tokens and the wording for a provider pin
  (#794), the lint of the image's package managers and the OpenSSL wording (#786), remaining QA wording (#775).

## Open points

- **#767**, the end to end journey of the whole path in the privileged lane, is not merged. The live smoke test is the first
  run of the whole path on the platform.
- **#797**: a failed proof of the Implementer blocks code-review.com. The Dispatcher is shared, the deploy canary requires
  `implementer` as soon as the factory's entry names the kind, and the promotions of everything staged in that run wait for the
  canary. There is no switch that waives the proof; the way back is in the rollout, step 2.
- **#799**: the usage of a turn that was stopped (`runner_shutdown`) is not recorded.
- **#784**: read-only registry access, before external users (above).
