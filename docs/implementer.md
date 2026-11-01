# The Implementer: operator guide

The Implementer is the part of the Software Factory that carries out a task in a repository: a person describes the
change, an agent works on a new branch in a throw-away VM, and the commits arrive on that branch on GitHub. This guide
says what it does, what it refuses, what it costs and what to look at when it fails. How to switch it on is in
[`factory-bring-up.md`](factory-bring-up.md) (section "Switching on the Implementer"), the live test after the release is
[`implementer-smoke-test.md`](implementer-smoke-test.md), and the code's own notes are in `app/src/implementer/README.md`
and `runner/README.md`.

The Implementer exists in the factory deployment only (the capability `implementer`, [`app/src/capabilities/README.md`](../app/src/capabilities/README.md)).
code-review.com has none of it: no page, no route, no job kind, and its Dispatcher entry never lists the kind.

## State of the code when this guide was written

Everything below describes the merged code. Three things were still open and decide when the first task can run; whoever
merges the last of them removes this section.

| Open | What is missing until it is merged |
|---|---|
| Runner job (#765) | The Worker does not yet take an `implementer` job from the queue to the end: no dispatch of the kind to the agent session, no advertisement of the engine after its self-check, no stop on SIGTERM that pushes first, no `implementer_engine_unavailable` from a Worker that did not advertise. The pieces it joins (clone and push, agent session, network, image) are merged |
| The Launcher advertises the engine (#765) | In the merged code the Sandbox Launcher advertises `pr-agent` and `opencode` only, so the Dispatcher answers a wake-up call for the kind with `ignored` and `not_capable` and the app stops resending it. #765, being built, makes the Launcher advertise `implementer` only when `DISPATCHER_APPS` names the kind, and `POST /probe` then requires the canary report to name it (`docs/dispatcher.md`, "The kind `implementer`"). The first deploy after the kind is set is therefore the first real proof of the engine, and it can block the release (rollout, step 2) |
| End to end journey (#767) | The whole path has not run in the privileged lane yet; the live smoke test is the first run of it on the platform |

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
   120 seconds, and once more at the end (below, "The git rules").
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

## Limits

| Limit | Value | Where it is decided |
|---|---|---|
| Cost of a turn | The operator's maximum per turn, 5.00 USD by default, set in the factory's admin portal (General, Limits, "Maximum cost per review"; the product default of 1.00 USD is too low). A person may ask for a lower limit on the form (never above that maximum or 100 USD). Without one, the maximum applies | Claim, and the proxy of the Worker: it refuses the next model call once the calls so far cost that much, so a turn can end slightly above it by the last call |
| Steps of the agent | None. There is no step limit, no plan, no approach rule: the cost limit is the brake | |
| Time of a turn | 3600 seconds. The runner keeps the last 180 seconds for the commit of what is left and the final push (a third of a short limit). The Dispatcher stops the Worker at 3600 seconds (`DISPATCHER_WORKER_CONFIG`, `implementer.timeoutSeconds`, 60 to 21600) and the App fails a turn still running after 70 minutes with `timeout`; the App cannot read the Dispatcher's setting, so change the constants with it (`docs/dispatcher.md`) | Dispatcher, runner, App |
| Task text | 20,000 characters | Form and route |
| Branch name | At most 200 characters, each part between slashes at most 240 bytes, git's rules, not the base branch | Form and route |
| Base branches offered | 100 names, default first; a base beyond that can be typed | Route |
| Result | 200 commits, 500 files, 8,192 characters of summary, the whole report under 4 MB (Vercel cuts a body at 4.5 MB) | Contract and runner |
| VM and container | 2 vCPU and 4 GB for the VM, 3 GB for the container without swap, 2048 processes, `/work` mounted `nosuid,nodev`, exec allowed | Dispatcher (`DISPATCHER_WORKER_CONFIG` can override the sizes) |
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
| `setup_failed` | The runner could not prepare the workplace: git too old, a guard file missing, the guard's self-test failed, the mirror could not be made, a port of the slot was taken. The Runs-page sentence says "the repository's own set-up steps", which is not what happens: no repository script is ever run | free | Look at the Worker log of the job; it is the image or the VM |
| `agent_gave_up` | The agent ended without a commit and nothing to commit, or its engine died after the model had been used | charged | Read its summary; try again with a clearer or smaller task |
| `push_rejected` | GitHub did not take the push: the repository's rules refused it, a push of `.github/workflows/` (never allowed), or GitHub was unreachable. Work pushed earlier stays on the branch | charged | Check the branch, then start again |
| `branch_violation` | The branch was rewritten below what was pushed, a commit has a committer that is not the system, or the repository could not be committed or checked after the agent ran. Commits pushed before stay; nothing after was saved | charged | Look at the branch; the agent did something it was told not to |
| `cost_limit_reached` | The calls so far cost the limit, so the next call was refused. Work pushed before stays | charged | Raise the limit within the maximum, or make the task smaller |
| `time_limit_reached` | The turn ran into its time limit. What was committed was pushed when possible | charged | Check the branch for what reached it |
| `git_write_not_granted` | The installation has not accepted Contents write | free | Accept the new permission on GitHub ([`github-app.md`](github-app.md), "Update an existing App") |
| `implementer_engine_unavailable` | No Worker that answered can run tasks, or the claim carried no cost limit | free | See "State of the code" above, and the rollout |
| `implementer_config_invalid` | The turn's settings cannot be used: the model entry or the clone address | free | Look at the job log for the reason word |
| `no_capable_runner` | Nobody that can run tasks claimed the turn within 30 minutes (3 hours while a Worker was busy with others of the kind). Here: the Dispatcher's entry for the factory does not list `implementer`, or the Launcher does not advertise it | free | Rollout step 2, and "State of the code" |
| `dispatch_unavailable` | Nothing claimed the turn within `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default); the Dispatcher is down, protected or full ([`deployment-vercel.md`](deployment-vercel.md), 5.3) | free | Look at the App's sweep log and the Dispatcher's |
| `timeout` | The turn was still running 70 minutes after it started, so the app failed it. The Worker normally ends it before at its 3600 seconds | free | Check the branch for what was pushed |
| `lease_lost`, `lease_expired` | The Worker no longer held the turn when it was ready, or stopped reporting; the result was not saved. Work pushed before stays on the branch | free | Start again if the branch lacks the work |
| `runner_error`, `runner_shutdown` | The runner failed unexpectedly, or was shut down while it worked | free | Read the Worker log; start again |
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

- **Setup scripts.** The repository's own install and set-up steps are not run for the agent; it installs what it needs
  through the registries and may run what it finds.
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
