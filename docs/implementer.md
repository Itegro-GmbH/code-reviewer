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
OpenCode agent works in a clone and starts on the new branch. Git is free for the agent inside that clone, and it has no way
to push: when the turn ends, **the runner pushes every local branch of the clone** to GitHub, the new branch among them
(section "The git rules"). It does not open a pull request and does not merge. The person finds the branches on GitHub and
the run on the Runs page.

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
   in it and starts the Worker container with the Implementer's profile. The Dispatcher never sees a token or a key. The Worker
   is the **Control container** of the turn: it keeps the git token, makes the push and supervises, and the profile gives it
   the VM's Docker socket so that it can start the model door (section "The model door").
3. **Fetch.** The Worker asks the App for the job. Here, and only here, the App makes a git token for exactly this repository
   that holds `contents: write` and `metadata: read` and nothing else (no pull requests, no issues, no checks), and the model
   access of the chosen entry or key. The token lives with the turn and is switched off when the turn ends, however it ended.
4. **Prepare.** The runner (root in the container) clones the base branch with depth 1 into a bare mirror that only it can
   enter. The agent gets a local clone of the mirror in `/work/repo` with no remote, no credential, the system identity and a
   new branch at the base tip. Nothing else is put into that repository: no hook, no guard, no spool.
5. **Work.** The runner starts the **model door**, a container of its own that holds the model key, and OpenCode then runs as an
   unprivileged user in `/work/repo` with a configuration the runner wrote. It reads, edits,
   writes, searches and runs shell commands; it cannot fetch web pages, search the web, start sub-agents or ask a question.
   The task is the user message. When it ends its turn with uncommitted changes it gets one more message to commit them; what
   is still uncommitted afterwards is committed by the system ("Implementer: uncommitted changes of the turn") on the branch
   the agent is on. Work the agent committed on a detached HEAD, on no branch, is saved first, whether the tree is dirty or
   not: the runner makes a branch `<the task's branch>-leftover-<id>` at HEAD and the push takes it with the others. The
   branch is named in the summary and reported with the other branches.
6. **Push.** Nothing is pushed while the agent works. When the turn ends, the runner pushes all local branches of the agent's
   repository, without force, one at a time (below, "The git rules"). Before it lists anything, and again right before each
   `git push`, it asks whether the lease is still held; only `held` allows a push. A lost lease ends the turn `lease_lost`
   with nothing pushed after it.
7. **Report.** The Worker reports the result once: base and head commit and whether the head was pushed (both of the branch
   the form named), **every branch it pushed or tried to push with its outcome**, the commits (at most 200) and the changed
   files (at most 500) of the form's branch, the agent's closing summary (at most 8,192 characters, with known secrets
   removed), the OpenCode ids and the usage. The session becomes idle and the Runs page shows the branches, the commits, the
   files, the summary and the cost.

The repository's own `opencode.json`, `opencode.jsonc` and `.opencode/` are not in the agent's working tree, and nothing
executable or configurable comes from the repository: no plugin, no MCP server, no formatter, no setup script, no repository
skill or instruction file. The agent is told when it touched such a name that it is not kept.

## The git rules

The owner's decision of 2026-11-02: inside its workspace the agent may do anything with git, it has no remote and no
credential, and when the turn ends the runner pushes all local branches. There is no check of who committed, what descends
from what, or which branch.

**Inside the workspace.** The agent may commit, amend, rebase, reset, create and switch branches, tag, stash, change the git
configuration and bypass any hook. Nothing is installed in its repository and nothing watches it: no hook, no guard, no spool,
no minimum version of git. It cannot push because it has no remote and no credential; the prompt says so in a few words. Work committed on a detached
HEAD is on no branch, so before the push the runner saves it: a HEAD that is detached and contained in no local branch gets a
branch `<the task's branch>-leftover-<id>` at HEAD, whether the tree is dirty or not, and the summary and the branch list name
it.

**The one push, at the end.** On every end that can still push (the agent finished, the cost limit, the time limit, the agent
gave up, a stop with the lease still held), and never after a lost lease, the runner:

1. asks the lease; a lease the host cannot confirm is asked again every 2 seconds for up to 30 seconds (20 on a stop), then the
   turn ends `lease_lost`;
2. lists the local branches of the agent's repository and drops names that are not branch names (a name git itself refuses,
   or one that starts with `-` or `+`, holds a control character, a space or one of `~^:?*[\`); they are counted and never
   shown or given to git;
3. for each branch, the task's branch first: fetches it into a numbered scratch ref of the mirror (`refs/runner/in/<n>`, with
   the objects checked), skips it when it is still at the base commit, asks the lease once more, and pushes that one ref from
   the mirror to `refs/heads/<name>` with the installation token: **one refspec per command, no `+`, no force, no `--mirror`,
   `--all`, `--tags` or `--delete`**. Only branches: no tag and no note is pushed, and nothing on GitHub is ever deleted;
4. reports each branch as `pushed` or `rejected` with a reason word. One rejected branch does not stop the others.

| Reason | What happened |
|---|---|
| `non_fast_forward` | The branch is on GitHub with other history (a rewrite of a branch that is already there, or a branch someone made after the submit check). The runner never forces |
| `remote_rejected` | GitHub refused the update (a protection rule, a hook) |
| `workflows_not_allowed` | The branch changes a file under `.github/workflows/`; the App never has the `workflows` permission, so GitHub refuses it |
| `provider_refused` | GitHub refused the access (a 401, 403 or 404) |
| `provider_error` | GitHub answered with another client error (for example a 413, a push that is too large, or a 422); it is not a refusal of the access and is not tried again |
| `provider_unavailable` | GitHub could not be reached or did not take the push (a 5xx, a reset, a request timeout, 429), after one more try |
| `timed_out` | A git command of the runner was killed at its time limit, so nothing is known of what it did: the push may or may not have reached GitHub (look at the branch there) |
| `unreadable` | The branch could not be taken over from the agent's repository (a broken repository, objects git refuses) |
| `not_a_commit` | The branch points at a tree or a tag, not a commit |
| `out_of_time` | The time for the final push ran out before this branch |
| `excluded` | The branch is in `PUSH_EXCLUDED_BRANCHES` (below) |

A branch whose tip is the base commit is not listed. At most 50 branches are reported, the task's branch first and then the
others in alphabetical order (a name in `PUSH_EXCLUDED_BRANCHES` is an entry too and counts toward the 50); local branches that
are in no entry are counted in the result as `branchesDropped` (`invalid`: the name cannot be pushed, `overflow`: valid names
beyond the 50), the Runs page says how many, and the prompt tells the agent the limit and the name rules. The turn **succeeds
when the task's branch arrived, or when the task's branch is verifiably empty (it is at the base commit) and another branch
arrived**. It ends `push_rejected` when the task's branch was not taken (rejected for any reason, among them `unreadable`,
`not_a_commit` and `timed_out`, or gone from the repository) whatever else was pushed, when no branch arrived although some had
commits, or when the agent's repository, or its list of branches (read up to 4 MiB), could not be read at all; it ends
`agent_gave_up` when no branch has anything new. A rejected branch of the report is not an error of the turn by itself.

**One place for a later rule.** `PUSH_EXCLUDED_BRANCHES` in `runner/src/code_reviewer_runner/implementer/push_policy.py` is
empty. A rule such as "only the branch the form named" goes into `select_branches` in the same file and nowhere else.

**Nothing is pushed during the turn.** The agent may rewrite history, so a push mid-turn would only conflict with the one at
the end. The cost is that **a VM that dies before the end of the turn loses the work**: there is no periodic push to fall back
on. The watch still asks the lease every 30 seconds while the agent works, so a turn that is no longer ours stops paying for
the model.

**Time.** The runner keeps the last 180 seconds of the time limit for the end: the look at the tree (10 s at most), the rescue
of a detached HEAD (three git commands of 3 s at most), the commit of what is left (40 s), the final push (100 s) and the two
reads of the report (5 s each), with 5 s for the end of the engine. A stop (SIGTERM) commits nothing (it still saves a
detached HEAD on a branch); the process leaves itself 55 seconds, and the final push gets 30 of them. A test holds both sums.

**How the root process stays safe from the agent's repository.** The runner is root in the container and the agent controls
every file of its repository, so root never opens it:

- Root never runs git with the agent's repository as its directory or git directory, so the hooks, `core.fsmonitor`,
  `core.hooksPath`, filters, aliases, `core.pager` and `safe.directory` entries of that repository are never read by a root
  process. No `safe.directory` is set for root.
- The list of local branches is made by `git for-each-ref` run as the engine user in its repository. Its output is read as a
  stream and **capped at 4 MiB** (about 40,000 branches); its error output is dropped. Over the cap git is ended and the turn
  ends `push_rejected` with a sentence that says the list is too long, and nothing is pushed. The runner never holds more of
  an agent-controlled list than the cap.
- The mirror reads the agent's branches through `git upload-pack`, named on the command line (`--upload-pack`) and run by
  `setpriv` as the engine user with `no_new_privs`, over protocol version 2 (so that the advertisement the runner reads is for
  the one ref it asks for, and does not grow with the refs the agent made). That process reads the repository's config with
  the agent's own rights; whatever that config makes it run, it runs as the engine user. The config of the repository does
  not choose this command.
- What comes back is an object stream, checked (`fetch.fsckObjects`, `transfer.fsckObjects`) and stored in a bare repository
  that root alone owns (mode 0700) and whose config is the runner's (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, a
  template-less `git init`, no automatic gc). Nothing is checked out there, so no filter, attribute or hook runs.
- From the listing only the names are taken, and each is validated before it is put in a refspec. The local ref the branch is
  fetched into is numbered, never built from the name. The tip is read from the mirror, never from what the listing printed.
- `git status`, the rescue of a detached HEAD and the commit of what is left run as the engine user, with the agent's hooks
  off (`core.hooksPath=/dev/null`, `--no-verify`). These commands and the upload-pack of each fetch run **after** the engine
  was stopped and its user's processes swept, and a repository's config can make them leave a process behind. So the
  runner ends every process of the engine user **once more right before each `git push`**. If the first sweep (after the
  engine) cannot end every process, nothing is run as that user for a leftover commit or a rescue, and the summary says that
  changes in the working tree were not looked for. If the sweep before a push fails, the push still goes ahead and the count
  is noted: a process of the engine user cannot read the environment of the root `git push` (`e2e` journey E09 and the
  privileged tests check that).
- The token is in the environment of the one `git push` (and the clone) of the runner and in no argument, file, URL or process
  of the agent. `e2e` journey E09 looks through the engine's directories, the repository, the mirror and `/run` for it.

**What a hostile agent can and cannot do.**

| It can | It cannot |
|---|---|
| Rewrite, reset or delete anything in its own clone, with any identity, and bypass any hook | Push: it has no remote and no credential |
| **Move any branch forward, including the default branch**, and **create new branches**, which the end of the turn pushes | Overwrite or delete a branch that is already on GitHub: the runner never forces and never deletes, and a rewrite is a rejected branch |
| Name a branch anything git accepts | Make a name become an option, a force, a second ref or a command: a name that is not a plain branch name is dropped, the rest is used as one refspec argument |
| Configure its repository to run programs on `git status`, `git fetch` or `git upload-pack` | Make root run them: only the engine user reads that config |
| Fill the disk, burn CPU and run for the whole time limit | Keep working after the time limit or after the cost limit is used up |
| Read everything it can reach in the VM | Read a credential: the git token is in the environment of one git process of the runner and in no file, argument or URL; the model key is in the model door, a container the agent has no route to except its one port, and the agent has a bearer for it that is worth nothing anywhere else |
| Reach the registries on the allowlist | Become root (no sudo), switch the rules of the network off, or reach any other host |

**The risk, plainly.** With no rule about branches, the agent can move **any** branch forward, including the default branch, and
may push new branches. The installation token holds `contents: write` on exactly this repository, so the only thing between a
task and the default branch is what GitHub itself enforces: **protect the default branch** (a required pull request) on every
repository a task runs on. Workflow files are the exception, because the App has no `workflows` permission.

The commits that arrive carry whatever author and committer the agent chose; by default the system identity (the product's name
and "Implementer"). Who started the task is not in the commits: it is in the run (the session's `created_by`, shown on the Runs
page).

## The model door

The model key, the model pin, the cost limit and the output cap are not in the Worker any more (#745, step 3 of
`plans/implementer-sandbox.md`). They are in the **model door**, a container of its own on the VM's Docker that runs the same proxy
the Worker used to run (the checks are the same code: the destination of the key, the cost policy, the admission of every
request, the output cap). The Worker image is the door's image too (one image in the snapshot and one to verify), started
with another entry point: `python -m code_reviewer_runner.implementer.door`. Reviews keep the proxy in the Worker, as before.

**How Control starts it.** Over the Docker Engine API on the VM's socket (`implementer/docker_api.py`), not through a
`docker` command: a request is a JSON document, so nothing that comes from a job, from the agent or from the repository can
become an option of a command line, and every body is made from constants and from identifiers the daemon itself gave
(`implementer/door_launcher.py`). It makes the **model network** (`--internal` with
`com.docker.network.bridge.gateway_mode_ipv4=isolated`, range `10.213.77.0/29`: no exit and no route to the VM), joins it, makes
the door's container, joins it to the model network at `10.213.77.2` and to the VM's default bridge (its only way to the
provider), attaches to its standard streams, starts it and writes the **start document to its stdin**.

**What the door is.** Non-root (the image's `runner` user), read-only root file system, every capability dropped,
`no-new-privileges`, 256 MB without swap, 128 processes, a 16 MB `noexec` `/tmp`, no mount, no published port, IPv6 off, and
**no environment variable of its own** (only what the image sets: `PATH` and the like, no secret). It holds the key and nothing else: no git token, no repository, no job text beyond the model access. A
test (`runner/tests/unit/test_model_door_launcher.py`) builds the container's definition and fails when it is weakened, and
fails when the key or the bearer is in any request to the daemon.

**How the key gets there.** On the door's stdin, once. It is in no argument, no environment variable and no file of the
container, and `docker inspect` shows none of it. The door parses it by the rules the job itself was parsed by
(`parse_model_access`), builds the ledger and the proxy, serves them on `10.213.77.2:10180` and answers `ready`. When Control
is gone (stdin closes) the door ends itself, and with it the key. Control itself still holds the key in memory while it
runs (it reads the job from the App), so it keeps scrubbing it from every output; what changed is that the agent's side
of the VM no longer has a process that holds it and answers for it.

**How cost and usage reach Control.** On the door's stdout, as JSON lines (`implementer/door/protocol.py`): the ledger as the door counts
it (tokens, cost, whether a call is open, what stopped the turn), whenever it changes, and a last one with the model calls of the trace when the door stops.
That pipe is a channel between the Docker daemon and the process that started the door; no port and no file of it exists, so the
agent can neither read nor forge the ledger, and **the door never calls Control**. Control keeps its own ledger for what only it sees (the
clock of the turn and the tool calls of the agent) and reads the rest from the door (`implementer/door_ledger.py`). The cost
limit is enforced at the door: a call that would pass it is refused there, before the provider is asked, and Control reads the
reason (`cost_limit_reached`).

**How the agent reaches it.** The agent still runs in the Worker container (it moves to a container of its own in step 4). The
engine user's static network rules (installed once at start, `NET_ADMIN` dropped afterwards) allow it one more destination
beside the two loopback ports: `10.213.77.2` on the proxy port, on any interface. The Worker has no port the agent can reach other than
what it always had: nothing listens for it. In step 4 the agent container sits on the model network, which is internal and has no
exit, and reaches the door at the same address; that is why the address is fixed and the network is the one the plan names.

**Without the variable.** A container that is not given `RUNNER_IMPLEMENTER_MODEL_DOOR=docker` (an older Dispatcher, a test lane
without Docker) runs the proxy in the Worker as before step 3. The Dispatcher sets it for every Implementer container, and the
start-up check refuses to advertise `implementer` (`implementer_docker_unavailable`) when the variable is set and the VM's Docker does
not answer.

**Its only way out is the provider.** The door sits on the VM's default bridge, which routes to the internet and to the VM itself (its
Docker gateway, its control port). So Control, before it tells the door anything, starts a one-shot container that shares the door's
network namespace, holds `NET_ADMIN` (the door holds no capability) and installs an `ip` table (`EGRESS_RULES` in `door_launcher.py`):
the model network, loopback, replies and DNS (port 53) are open, every private, link-local, shared and special range is dropped (the VM,
its neighbours, other containers, the platform's services), the rest of the internet is open on port 443 only, and everything else is
dropped. A door whose rules did not go in is taken away and the key is never written to it (`setup_failed`, free). Measured on a VM:
from the door, port 443 of the provider answers, port 80 and the VM's services (`172.17.0.1:23456`, `169.254.0.1`) do not. Port 443
is open to every public address because a provider behind a CDN has no stable address; the code of the door dials only the one
destination of the entry (`HttpsUpstream`), and narrowing 443 to the provider by name is the second wall of the plan, the VM's
network policy (step 7). Port 53 is open to every address, a channel for a compromised door only.

**The Docker socket makes Control effectively root on the VM.** The Engine API can start a privileged container. That is
accepted because the agent never reaches it: the socket is root's inside the container, the agent is another user (and from step 4
another container), and the runner puts nothing of a job or of the agent's output into a request. A test of the container spec keeps the
mount to exactly this socket, read-only, in this profile and no other.

**When the door does not work.** A door that cannot be started (the daemon refuses a step, no `ready` in 30 seconds, the door ends first) ends
the turn `setup_failed` with `model_door_unavailable` in the log: free, the model was never used. A door that refuses the model access of the job
(an entry the proxy cannot serve) is `implementer_config_invalid`, free. A door that **dies during the turn** (killed, out of memory,
the daemon gone) fails the turn with the sentence "the model door ended during the turn" and its exit code: `runner_error`, free, when no call was
billed or open, and `agent_gave_up`, charged, when one was (the same rule the proxy in the Worker had: a turn that cost money never
ends free). A call that was open when the door died leaves the cost **unknown** in the report (it is not made up: the usage carries no cost). What was committed is still pushed.

## Network in the agent phase

The agent's user has no route to the internet. The firewall of the container (nftables, keyed on that user) allows two
loopback ports only: the model proxy and, when the container's `RUNNER_IMPLEMENTER_NETWORK` is `registries`, the egress proxy.
Where the model proxy is the door, the loopback port is replaced by the door's address (above). `none` starts no proxy and the
agent has no network at all. The runner itself talks to GitHub as root, for the clone and the push.

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
- **Nothing points at an environment.** A task copies size and script when it starts (the next part of #818), so changing or
  deleting an environment never touches a running or a past task.

Routes (all `Cache-Control: no-store`, errors `{ "error": <code> }` with the codes of `app/src/implementer/environments/errors.ts`):
`GET /api/w/<slug>/environments` (every member; `?view=picker` is the list for the task form's picker, without the scripts), `POST` the same path, `PUT` and `DELETE /api/w/<slug>/environments/<id>` (Owner or
Admin).

## Limits

| Limit | Value | Where it is decided |
|---|---|---|
| Cost of a turn | The operator's maximum per turn: 5.00 USD once the owner has set it in the factory's admin portal (General, Limits, "Maximum cost per review"); the default is 1.00 USD until then, which is too low for a task. A person may ask for a lower limit on the form (never above that maximum or 100 USD). Without one, the maximum applies | Claim, and the proxy of the Worker: it refuses the next model call once the calls so far cost that much, so a turn can end slightly above it by the last call |
| Steps of the agent | None. There is no step limit, no plan, no approach rule: the cost limit is the brake | |
| Time of a turn | 3600 seconds. The runner keeps the last 180 seconds for the commit of what is left and the final push of all branches (a third of a short limit; the split is in "The git rules"). The Dispatcher stops the Worker at 3600 seconds (`DISPATCHER_WORKER_CONFIG`, `implementer.timeoutSeconds`, 60 to 21600) and the App fails a turn still running after 70 minutes with `timeout`; the App cannot read the Dispatcher's setting, so change the constants with it (`docs/dispatcher.md`). The runner holds a turn to the smaller of its time limit and `RUNNER_JOB_TIMEOUT_SECONDS` | Dispatcher, runner, App |
| Stop | On SIGTERM the engine is ended at once, all committed branches are pushed (if the lease is still held; nothing uncommitted is committed) and the turn ends `runner_shutdown`. The job process gets a grace of 60 seconds, ends itself after 55 (the final push gets 30 of them), and the container's stop timeout is 90 seconds; each lease question (before the listing and before each push) is retried for 30 seconds at a normal end and 20 on a stop, and
never beyond the time that is left of the final push | Runner, container spec |
| Task text | 20,000 characters | Form and route |
| Branch name | At most 200 characters, each part between slashes at most 240 bytes, git's rules, not the base branch | Form and route |
| Base branches offered | 100 names, default first; a base beyond that can be typed | Route |
| Result | 200 commits and 500 files (of the task's branch), 50 branches, 8,192 characters of summary, the whole report under 4 MB (Vercel cuts a body at 4.5 MB) | Contract and runner |
| VM and container | 2 vCPU and 4 GB for the VM, 3 GB for the Worker container without swap, 2048 processes, `/work` mounted `nosuid,nodev`, exec allowed; the model door 256 MB beside it, and the Dispatcher refuses a size that leaves the VM no room for the OS, dockerd and the door | Dispatcher (`DISPATCHER_WORKER_CONFIG` can override the sizes) |
| Parallel work | `RUNNER_DISPATCH_MAX_RUNNING` (2) for all kinds together, and one running turn per session | App and Dispatcher |

**Billing.** Turns are billed at the Dynamic rate for now: the billing code treats the kind as `dynamic` (`projectKindOf`),
so the minute rate of Dynamic applies and the model cost is passed on as for a Dynamic Review. The factory has billing off
(`PRODUCT_CAPABILITIES` without `billing`), so nothing is charged yet. Who pays when a turn fails is in the next table.

## When a task fails

The Runs page shows one sentence per code. Plain words, with who pays (free: the run is not billed; charged: the model was
used):

| Code | What happened | Billed | What to do |
|---|---|---|---|
| `branch_exists` | **No longer produced.** Until the git model of 2026-11-02 it was raised at the first push. Now a branch that exists on GitHub with other history is a rejected branch (`non_fast_forward`) of the report and the turn ends `push_rejected`. Old runs keep the code and its class | free | Choose a new branch name and start again |
| `base_branch_not_found` | The base branch was not on GitHub when the runner cloned | free | Check the name; it may have been deleted since the submit |
| `clone_failed` | The repository could not be downloaded | free | Try again; look at the installation if it persists |
| `setup_failed` | The runner could not prepare the workplace before the turn started: git missing, the mirror could not be made, a port of the slot was taken, the model door could not be started (`model_door_unavailable` in the log). It is the free code of a turn that never started: once the model was used, the same trouble shows as `agent_gave_up`. The Runs-page sentence says "the repository's own set-up steps", which is not what happens: no repository script is ever run | free | Look at the Worker log of the job; it is the image or the VM |
| `agent_gave_up` | The agent ended with no new commit on any branch and nothing to commit, or its engine died, or the model door went away ("the model door ended during the turn"), after the model had been used (what it had committed is pushed when possible). The summary also says when files the agent wrote could not be kept, such as `opencode.json` | charged | Read its summary; try again with a clearer or smaller task |
| `push_rejected` | The task's branch did not arrive (the branch exists with other history, a rule, a permission, a change of `.github/workflows/` which is never allowed, or GitHub could not be reached), no branch arrived although some had commits, or the agent's repository could not be read at the end. The Runs page lists every branch with its reason; branches that were pushed stay on GitHub | charged | Read the reasons, check the branches, then start again |
| `branch_violation` | **No longer produced** (there are no rules inside the workspace to violate). Old runs keep the code and its class | charged | Look at the branch |
| `cost_limit_reached` | The calls so far cost the limit, so the next call was refused. What was committed is pushed when possible: check the branch | charged | Raise the limit within the maximum, or make the task smaller |
| `time_limit_reached` | The turn ran into its time limit. What was committed was pushed when possible (nothing is pushed earlier, so a VM that dies first loses the work) | charged | Check the branches for what reached GitHub |
| `git_write_not_granted` | The installation has not accepted Contents write | free | Accept the new permission on GitHub ([`github-app.md`](github-app.md), "Update an existing App") |
| `implementer_engine_unavailable` | The Worker did not advertise the engine (its start-up checks failed, or the container is not the Implementer's profile), the claim carried no cost limit, or the capability is off in the App | free | The Worker log names the stable reason (`implementer_setpriv_missing`, `implementer_work_dir_not_exec` and others); see the rollout |
| `implementer_config_invalid` | The turn's settings cannot be used: a model entry the proxy cannot serve, the clone address, a turn without its record, or a job that reached the runner with neither `maxCostUsd` nor `operatorMaxCostUsd` | free | Look at the job log for the reason word |
| `no_capable_runner` | Nobody that can run tasks claimed the turn within 30 minutes (3 hours while a Worker was busy with others of the kind). Here: the Dispatcher's entry for the factory does not list `implementer`, so the Launcher does not advertise it; or, until 2026-11-01, a slow listing of the platform's VMs (next row) | free | Rollout step 2, and the next row |
| `fleet_list_failed` (a Dispatcher log line, not a code of the run) | With two or more Apps the Dispatcher lists the platform's VMs, at most once in five seconds, to count what each App occupies. A listing that gives no answer within 4 seconds counts as failed (the line carries its `ms`); the last good one is used for up to a minute, and after that the Dispatcher counts by its own launches and the claim goes on: the cap is a soft limit, the platform's concurrency limit the hard one. A failed listing no longer stops claims (it did on 2026-11-01, when 283 stopped VMs made the listing take 5.1 s and jobs ended `no_capable_runner`). Every listing that answers logs `fleet_listed` with its `ms` and `count`; the reaper deletes ended VMs after one day, 50 per run | free | A `fleet_list_failed` is a warning, not a cause of a task that does not start. Compare `ms` and `count` of the `fleet_listed` lines with the 4 seconds; if `count` grows, look at the reaper's `reap_done` (`deleted`, `deleteFailed`, `deleteKept`, `deleteNotTried`) |
| `dispatch_unavailable` | Nothing claimed the turn within `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default); the Dispatcher is down, protected or full ([`deployment-vercel.md`](deployment-vercel.md), 5.3) | free | Look at the App's sweep log and the Dispatcher's |
| `timeout` | The turn was still running 70 minutes after it started, so the app failed it. The Worker normally ends it before at its 3600 seconds | free | Check the branch for what was pushed |
| `lease_lost`, `lease_expired` | The Worker no longer held the turn when it was ready, or stopped reporting, or the lease could not be confirmed before the final push; the result was not saved and nothing is pushed after the loss. Nothing is pushed during the turn, so a lost lease means no work reached GitHub | free | Start again |
| `runner_shutdown` | The Worker was told to stop (SIGTERM) while it worked: the engine was ended, all committed branches were pushed if the lease was still held. A turn of the Implementer is never run twice, so the app gives it back and it ends here, as its last attempt. The usage of a stopped turn is not recorded yet (#799) | free | Check the branch for what was pushed; start again with a new branch name |
| `runner_error` | The runner failed unexpectedly before any model call, or the model door went away during the turn before any call was billed or open ("the model door ended during the turn" with its exit code, and "killed for its memory" when the kernel did it) | free | Read the Worker log; start again |
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
  rejects that branch (`workflows_not_allowed`) while the others arrive; a task whose own branch is the one rejected ends
  `push_rejected`. Change workflow files by hand ([`github-app.md`](github-app.md)).
- Opening or merging a pull request, a second turn on the same branch, a task on an existing branch, forks, other platforms
  than GitHub.

## What is accepted, and until when

These are decisions of the owner, not oversights.

- **The Control container is effectively root on the VM** (#745, step 3). It has the VM's Docker socket so that it can start the
  model door. The agent never reaches it; the runner puts nothing of a job or of the agent's output into a request to the socket.
  In this step the agent still runs in that container, as another user, behind the socket's permissions; step 4 moves it away.

- **Git is free, and every local branch is pushed.** No rule inside the workspace, none at the push: the agent can move any
  branch forward, including the default branch, and may push new branches (see "The risk, plainly"). Protect the default
  branch on GitHub. What the end of the turn will not do is force or delete.
- **The author and the committer are the agent's.** Nothing on GitHub proves that the system made a commit.
- **The work of a VM that dies is lost.** Nothing is pushed during the turn.
- **A branch created meanwhile.** If someone creates the task's branch after the submit check and before the end of the turn,
  and it points at an ancestor of the agent's tip, GitHub fast-forwards it: the task lands on a branch it did not create, with
  that person's earlier history under it. Any other history is a rejected branch (`non_fast_forward`).
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

Open issues at the time of this change (2026-11-02):

- **#745**, the epic of the first vertical slice, and **#768**, the operator guide and the live smoke test: the smoke test
  ([`implementer-smoke-test.md`](implementer-smoke-test.md)) is the first run of the whole path on the platform and has not
  been run for this git model.
- **#784**: read-only registry access, before external users (above).
- **#797**: a failed proof of the Implementer blocks code-review.com. The Dispatcher is shared, the deploy canary requires
  `implementer` as soon as the factory's entry names the kind, and the promotions of everything staged in that run wait for the
  canary. There is no switch that waives the proof; the way back is in the rollout, step 2.
- **#799**: the usage of a turn that was stopped (`runner_shutdown`) is not recorded.
- **#794**, **#786**, **#775**: the follow-ups listed under "What is accepted".
- Which branches may be pushed (`PUSH_EXCLUDED_BRANCHES`) is the owner's open question; the list is empty.
