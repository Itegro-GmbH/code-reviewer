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
OpenCode agent works in a clone, in a container of its own with its own Docker, and starts on the new branch. Git is free for
the agent inside that clone, and it has no way to push: when the turn ends, **the runner pushes every local branch of the
clone** to GitHub, the new branch among them (section "The git rules"). It does not open a pull request and does not merge.
The person finds the branches on GitHub and the run on the Runs page.

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
2. **Claim.** The Dispatcher claims the job, creates a VM from the golden snapshot (2 vCPU, 4 GB), boots Sysbox on it, makes the
   work volume `/work` in it and starts the Worker container with the Implementer's profile. The Dispatcher never sees a token
   or a key. The Worker is the **Control container** of the turn: it keeps the git token, makes the push and supervises, and
   the profile gives it the VM's Docker socket so that it can start the model door, the agent's container and the reader
   (sections "The model door" and "The agent's container"). Before it touches anything it checks the sandbox gate: the
   snapshot's Sysbox must be proven and the VM must leave the agent's container enough memory (`sandbox_unproven`,
   `sandbox_size_unsupported`, both free).
3. **Fetch.** The Worker asks the App for the job. Here, and only here, the App makes a git token for exactly this repository
   that holds `contents: write` and `metadata: read` and nothing else (no pull requests, no issues, no checks), and the model
   access of the chosen entry or key. The token lives with the turn and is switched off when the turn ends, however it ended.
4. **Prepare.** The runner (root in the container) clones the base branch with depth 1 into a bare mirror that only it can
   enter. It makes the agent's repository in `/work/repo` as a local clone of that mirror, and the reader (a container of its
   own, section "How Control reads the agent's repository") gives it no remote, no credential, the system identity and a new
   branch at the base tip. Nothing else is put into that repository: no hook, no guard, no spool.
5. **Work.** The runner starts the **model door**, a container of its own that holds the model key, and the **agent's container**,
   and OpenCode then runs there as root in `/work/repo` with a configuration the runner wrote. It reads, edits, writes,
   searches and runs shell commands, and starts containers in its own Docker; it cannot fetch web pages, search the web,
   start sub-agents or ask a question, and it has no network but the door.
   The task is the user message. When it ends its turn with uncommitted changes it gets one more message to commit them; what
   is still uncommitted afterwards is committed by the system ("Implementer: uncommitted changes of the turn") on the branch
   the agent is on. Work the agent committed on a detached HEAD, on no branch, is saved first, whether the tree is dirty or
   not: the runner makes a branch `<the task's branch>-leftover-<id>` at HEAD and the push takes it with the others. The
   branch is named in the summary and reported with the other branches.
6. **Push.** Nothing is pushed while the agent works. When the turn ends, the agent's container is killed, and then the
   runner pushes all local branches of the agent's repository, without force, one at a time (below, "The git rules"). Before it lists anything, and again right before each
   `git push`, it asks whether the lease is still held; only `held` allows a push. A lost lease ends the turn `lease_lost`
   with nothing pushed after it.
7. **Report.** The Worker reports the result once: base and head commit and whether the head was pushed (both of the branch
   the form named), **every branch it pushed or tried to push with its outcome**, the commits (at most 200) and the changed
   files (at most 500) of the form's branch, the agent's closing summary (at most 8,192 characters, with known secrets
   removed), the OpenCode ids and the usage. The session becomes idle and the Runs page shows the branches, the commits, the
   files, the summary and the cost.

The repository's own OpenCode files (`opencode.json`, `opencode.jsonc`, `.opencode/`, its instruction files and skills) apply
as they would on a person's machine: the agent is free in its container. What they cannot change is what the model door holds
(section "The model door"): a configuration that names another model, another address or another key gets a refusal from
the door, because the door pins the model, the limit and the key; the cost limit is not an engine setting at all. What they can
do is start programs in the agent's container, which the agent can do anyway.

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
| `out_of_space` | The disk the runner takes branches over to (the reserve disk, section "The disk") had too little room left, or ran out while this one was taken over; nothing was fetched when the room was short beforehand |
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
reads of the report (5 s each), with 10 s for the end of the agent's container (the kill call 5 s at most, then the wait until the daemon says it is gone 5 s at most;
the container is removed only after the push, on a thread of its own, because removing a Sysbox container with its inner Docker can take long and nothing waits for it).
A stop (SIGTERM) commits nothing (it still saves a detached HEAD on a branch); the process leaves itself 55 seconds, and the final push gets 25 of them. A test holds both sums,
with the real constants of the kill and the wait.

**How the root process stays safe from the agent's repository.** The agent controls every file of its repository, so Control
(root, with the token) never opens it:

- Root never runs git with the agent's repository as its directory or git directory, and never opens a path in it, so the
  hooks, `core.fsmonitor`, `core.hooksPath`, filters, aliases and `core.pager` of that repository are never read by a
  process of Control. Everything that has to look inside it runs in the **reader**, a container of its own with the repository
  and nothing else (section "How Control reads the agent's repository"). Whatever a hostile config makes git run, it runs
  there, with no network, no token and no way out.
- The list of local branches is made by `git for-each-ref` in the reader. Its output is read as a stream and **capped at
  4 MiB** (about 40,000 branches); over the cap the read is ended and the turn ends `push_rejected` with a sentence that says
  the list is too long, and nothing is pushed. The runner never holds more of an agent-controlled list than the cap.
- The mirror reads the agent's branches through `git upload-pack`, named on the command line (`--upload-pack`) and run in the
  reader through the Docker daemon (`exec_pipe`, a command that takes no path and no option from its caller), over protocol
  version 2 (so that the advertisement the runner reads is for the one ref it asks for, and does not grow with the refs the
  agent made).
- What comes back is an object stream, checked (`fetch.fsckObjects`, `transfer.fsckObjects`) and stored in a bare repository
  that root alone owns (mode 0700) and whose config is the runner's (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, a
  template-less `git init`, no automatic gc). Nothing is checked out there, so no filter, attribute or hook runs. The agent
  never sees the mirror: its container mounts the `repo` directory of the work volume and nothing else of it.
- From the listing only the names are taken, and each is validated before it is put in a refspec. The local ref the branch is
  fetched into is numbered, never built from the name. The tip is read from the mirror, never from what the listing printed.
- `git status`, the rescue of a detached HEAD and the commit of what is left run in the reader, **after** the agent's
  container was killed. The container is killed first (SIGKILL to its init, which takes every process of it with it, the
  agent's `dockerd` and anything it left running), so nothing of the agent can change the repository or call the door while the
  runner reads it. If the container cannot be confirmed gone, nothing is committed or rescued and the summary says that
  changes in the working tree were not looked for.
- The token is in the environment of the one `git push` (and the clone) of the runner and in no argument, file, URL or process
  of the agent's side. The reader holds no token; the push runs in Control, from the mirror.

**What a hostile agent can and cannot do.**

| It can | It cannot |
|---|---|
| Rewrite, reset or delete anything in its own clone, with any identity, and bypass any hook | Push: it has no remote and no credential |
| **Move any branch forward, including the default branch**, and **create new branches**, which the end of the turn pushes | Overwrite or delete a branch that is already on GitHub: the runner never forces and never deletes, and a rewrite is a rejected branch |
| Name a branch anything git accepts | Make a name become an option, a force, a second ref or a command: a name that is not a plain branch name is dropped, the rest is used as one refspec argument |
| Configure its repository to run programs on `git status`, `git fetch` or `git upload-pack`, and be root in its container with its own Docker | Make Control run them: only the reader reads that config, a container with no network and no token |
| Fill the disk, burn CPU and run for the whole time limit | Keep working after the time limit or after the cost limit is used up |
| Read everything in its own container, start containers of its own, install what it can reach | Read a credential: the git token is in the environment of one git process of Control, the model key is in the model door, and the agent's container holds neither (it has a bearer for the door that is worth nothing anywhere else) |
| Reach the model door on its network | Reach Control, the VM, its control port 23456, a neighbour, the internet or a name server: the model network has no exit (section "The agent's container") |

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
is gone (stdin closes) the door ends itself, and with it the key. Control drops its copy of the hand-off once the door has the
key (the job's `model_access`, emptied together with the `llm` section of the job document it shares). It still holds the key
in `job.llm.api_key` on purpose, to scrub it from every output of the turn, and the text the job was read from and the
interpreter's memory are not wiped (Python cannot wipe a string). So Control is not key-free: what changed is that the agent's
side of the VM no longer has a process that holds the key and answers for it, and nothing the agent can reach reads Control's memory.

**How cost and usage reach Control.** On the door's stdout, as JSON lines (`implementer/door/protocol.py`): the ledger as the door counts
it (tokens, cost, whether a call is open, what stopped the turn), whenever it changes, and a last one with the model calls of the trace when the door stops.
That pipe is a channel between the Docker daemon and the process that started the door; no port and no file of it exists, so the
agent can neither read nor forge the ledger, and **the door never calls Control**. Control keeps its own ledger for what only it sees (the
clock of the turn and the tool calls of the agent) and reads the rest from the door (`implementer/door_ledger.py`). The cost
limit is enforced at the door: a call that would pass it is refused there, before the provider is asked, and Control reads the
reason (`cost_limit_reached`).

**How the agent reaches it.** The agent's container is on the model network, which is internal and has no exit, and reaches the
door at its fixed address (`10.213.77.2`, the container's own `10.213.77.4`; a name does not resolve in the containers the agent
starts, so they use the address). Control is not on that network: it talks to the door over the door's standard streams, and
the door never calls Control.

**Without the Docker socket.** A container that is not given `RUNNER_IMPLEMENTER_MODEL_DOOR=docker` is not an Implementer container:
the proxy no longer runs in the Worker, so the start-up check refuses to advertise `implementer` (`implementer_docker_unavailable`)
when the VM's Docker does not answer, (`implementer_sysbox_missing`) when it has no Sysbox runtime, (`implementer_agent_image_missing`)
when the agent image of the snapshot is not in the VM, and (`implementer_docker_socket_open`) when the engine user, probed as that
user at every start, can open the socket. Only a refusal for its permission (or a missing socket) counts as "cannot open": a timeout or
any other error counts as "can", so the check fails closed. Reviews are not touched by any of it: the container keeps `opencode` and
the review engines, only `implementer` is left out.

**Its only way out is the provider.** The door sits on the VM's default bridge, which routes to the internet and to the VM itself (its
Docker gateway, its control port). So Control, before it tells the door anything, starts a one-shot container that shares the door's
network namespace, holds `NET_ADMIN` (the door holds no capability) and installs an `ip` table (`EGRESS_RULES` in `door_launcher.py`):
loopback, replies and DNS (port 53) are open, a new connection into the model network is dropped (the door answers the agent and opens none towards it, Control's address included), every private, link-local, shared and special range is dropped (the VM,
its neighbours, other containers, the platform's services), the rest of the internet is open on port 443 only, and everything else is
dropped. A door whose rules did not go in is taken away and the key is never written to it (`setup_failed`, free). Measured on a VM:
from the door, port 443 of the provider answers, port 80 and the VM's services (`172.17.0.1:23456`, `169.254.0.1`) do not. Port 443
is open to every public address because a provider behind a CDN has no stable address; the code of the door dials only the one
destination of the entry (`HttpsUpstream`), and narrowing 443 to the provider by name is the second wall of the plan, the VM's
network policy (step 7). Port 53 is open to every address, a channel for a compromised door only.

**The Docker socket makes Control effectively root on the VM.** The Engine API can start a privileged container. That is
accepted because the agent never reaches it: the agent's container has no socket (its own `/var/run/docker.sock` is the one of its
inner Docker), and the runner puts nothing of a job or of the agent's output into a request. A test of the container spec keeps the
mount to exactly this socket, read-only, in this profile and no other.

**When the door does not work.** A door that cannot be started (the daemon refuses a step, no `ready` in 30 seconds, the door ends first) ends
the turn `setup_failed` with `model_door_unavailable` in the log: free, the model was never used. A door that refuses the model access of the job
(an entry the proxy cannot serve) is `implementer_config_invalid`, free. A door that **dies during the turn** (killed, out of memory,
the daemon gone) fails the turn with the sentence "the model door ended during the turn" and its exit code: `runner_error`, free, when no call was
billed or open, and `agent_gave_up`, charged, when one was (the same rule the proxy in the Worker had: a turn that cost money never
ends free). A call that was open when the door died leaves the cost **unknown** in the report (it is not made up: the usage carries no cost). What was committed is still pushed.

**An oversized request body can end the turn.** The door has 256 MB and reads one request body at a time (up to 32 MiB, the
provider's own limit); a body of very many tiny JSON blocks needs several times its size to parse, so such a body can get the door killed
for its memory (exit code 137). Only the agent's own turn ends: the key stays in the door and the cost limit holds, so no limit on the
size of a body is set (the owner's rule: guard money, key and exits). The outcome says so: "the container was killed for its memory (exit code 137);
a request body too large for the door's memory ends the turn this way".

## The agent's container

From #745 step 4 the agent no longer runs in the Control container. It runs in a container of its own, under the **Sysbox**
runtime (`sysbox-runc`): root of the container is an unprivileged user of the VM (uid 165536, measured), and the container runs
its own `dockerd`, so the agent can `docker run` a database, build an image or start whatever its tests need, without a socket of
the VM's. There are no rules inside it: sudo, apt, Docker and install scripts are the agent's to use. What guards money, key and
exits is outside (`implementer/agent_container.py`):

| Part | What it is |
|---|---|
| Image | `code-reviewer-agent:golden`, the second target (`agent`) of `runner/Dockerfile`, built into the golden snapshot next to the Worker image. OpenCode (the pinned, verified binary), the Docker binaries of the digest-pinned `docker:29.9.2-dind` image (dockerd, the CLI, buildx, compose, runc), git 2.53, Node.js 24 and pnpm, uv, Python 3.13, `gcc`, `g++`, `make`, `jq`, `unzip`, `nc`, `ping`. Root, no secret, no credential, no key: it carries no environment variable named like one. It is also the base the Setup container of step 5 starts from (`docker commit`). |
| Size | The image is 1.54 GB on the snapshot's disk (398 MB compressed), next to the Worker image (1.9 GB). The snapshot build takes about 3 minutes longer (the build of the second target is mostly cached); a VM restored from it has the same 64 GB disk and starts as fast, because a job VM does not read the layers it does not run. The Worker image and the path of reviews are untouched. |
| Network | The **model network**, internal, `gateway_mode_ipv4=isolated`, range `10.213.77.0/29`: the agent at `10.213.77.4`, the door at `10.213.77.2`, and nothing else. No exit, no route to the VM or its control port `23456`, no name server, no neighbour; Control is not on it. The containers the agent starts through its own Docker reach the door too (through the agent) and nothing else. |
| Repository | The `repo` directory of the work volume, mounted as `/work/repo` (the volume's `Subpath`): the agent sees the repository and nothing of the mirror. The mount is idmapped by Sysbox, so the files the agent's root writes belong to the VM's root (measured), and its container uid 0 is host uid 165536 for processes only. |
| Memory | The VM's memory (2,048 MB per vCPU) less the limits of everything else on it, each counted in full: the OS and the Sysbox daemons (512 MB, measured), Control (768 MB), the door (256 MB) and the reader (256 MB, it runs while the agent runs) are 1,792 MB. No swap: 256 MB at 1 vCPU, 2,304 at 2, 6,400 at 4, 10,496 at 6 and 14,592 at 8 (an earlier sum left the agent 2,560 at 2 vCPU and did not count the reader: the limits of all containers and the OS came to more than the 4,096 MB of the VM). Less than 1,024 MB is `sandbox_size_unsupported`, so 1 vCPU stays refused. A test holds that the limits add up to the VM at every size. |
| Limits | 16,384 processes. The time limit and the cost limit are Control's and the door's. |
| Docker options | Constants only. No job, repository name, branch or output of the agent is in any request to the daemon: they are JSON bodies made from the runner's constants and identifiers the daemon gave, and the exec commands have fixed arguments. After the container is made, Control reads it back from the daemon and refuses to start the engine if it shows a privileged container, a bind, a device, another runtime, another network or a mount besides the repository. |

**How Control drives it, only outward.** Control starts OpenCode with an exec, writes the engine's configuration with an exec that
copies its standard input to a path (the archive call of the Engine API, `docker cp`, puts its files where a Sysbox container does not
see them), and reaches the engine's HTTP port through a loopback listener of its own: every connection opens an exec that runs a relay
to the engine's port in the container. The agent has no address of Control's, no route to it and no port of it to connect to; the Docker
daemon is the only thing that joins the two. This was chosen over a port in the agent container that Control connects to, because that
needs Control and the agent on a common network, from which the agent could connect back. Nothing in the agent opens a connection to
Control.

**How Control reads the agent's repository.** In the **reader**: a container of the Worker image (which has git), `NetworkMode: none`, no token and no
secret, a read-only root file system, `no-new-privileges`, three capabilities to read and write files of any owner (the files the
agent's root made are owned by the VM's root, and it may chown them), and the repository as its only mount. Control runs `git` in it
through exec for `status`, the leftover commit, the rescue of a detached HEAD and the list of branches, and the fetch of the final push
reads `git upload-pack` in it, piped to Control's `git fetch` (`exec_pipe`). A hostile repository (hooks, config, symlinks, alternates)
can only run things there, where there is nothing to reach. Control never opens a path in the repository.

**When the container ends before the turn does.** A container that is killed (out of memory, a crash, the daemon) or whose engine process
dies is named in the outcome ("the agent's container ended during the turn: the container was killed (a signal: most likely the memory
limit or a crash) (exit code 137)", or "the engine process ended during its turn"). The turn is `runner_error`, free, when no model call
was billed or open, and `agent_gave_up`, charged, when one was. The final push does not depend on the container: it is killed before the
repository is read, and a container that is already dead leaves the repository as it was. Measured on a VM (2026-11-02): with the
container killed in the middle of a turn after two commits, both branches arrived and the turn ended `agent_gave_up` with that sentence.

**The gate on the snapshot's Sysbox.** The golden snapshot's record says `sysbox` `proven` or `unproven`. The proof now runs the agent
image itself (a container under Sysbox with its own Docker, an inner container, and the network checks with their controls), so it
proves what the Implementer ships and needs no pull. The Dispatcher hands the verdict to the Control container
(`RUNNER_IMPLEMENTER_SANDBOX_PROOF`); an `unproven` snapshot ends the turn `sandbox_unproven`, free, before anything is cloned, and
reviews never read the variable, so it cannot hold them back (nor the deploy canary: the start-up check does not ask for the proof).
The verdict is the **fourth member of the snapshot pair** (`SANDBOX_SYSBOX_PROOF` next to `SANDBOX_SNAPSHOT_ID`,
`SANDBOX_IMAGE_DIGEST` and `SANDBOX_SNAPSHOT_COMMIT`): the golden snapshot workflow outputs it, `vercel-stage.yml` sets it on the
staged deployment as a variable and as meta, and `snapshot:ops persist` writes it to Infisical, cleared to `unproven` before the
other three and set to its real value last, so that a stale `proven` cannot stay behind a newer snapshot id. **Only `proven` lets a
turn start**: an `unproven` verdict, a Dispatcher that was never told one, and any other value all end it `sandbox_unproven`, free.
The deploy canary passes the Dispatcher's own verdict to the Implementer's probe, which does not read it; it never makes up a `proven`.

**Measured on real VMs (2026-11-02, `spike-` VMs from a snapshot built from the branch, 2 vCPU and 4 GB unless said).** Boot of Sysbox
0.27 s after `vm-prepare.sh` (0.73 s). The agent's container is made, started and has its inner Docker ready 1.5 to 1.8 s after the call;
OpenCode answers its health check about 1.2 s later. A whole turn against the strict scripted provider of `fakes/wire` (the real door,
ledger and checks; only the provider hop is a fake) with the real OpenCode 1.19.0: six model calls, two commits on two branches,
`git push` refused ("No configured push destination"), the agent's own Docker started and ran postgres (`select 6*7` answered 42), both
branches arrived at a bare repository standing in for GitHub, 13 to 15 s in all. Peak memory: Control 46 MB, the door 24 MB, the
reader 1 MB, the agent's container 510 to 570 MB (OpenCode alone about 550 MB resident, its `dockerd` 85 MB, postgres 30 MB). From the
agent and from a container the agent starts: the internet (`1.1.1.1:443`), a name, the VM's gateway and its control port `23456`, the
platform's `169.254.0.1`, Control, a neighbour container on the default bridge and the model network's gateway were all blocked, the
door was reached; the same probes from a plain container on the VM all got through (the control that says "blocked" means something).
With the agent's container killed after two commits the turn ended `agent_gave_up` with both branches pushed; with only the engine
process killed, the same code with "the engine process ended during its turn". On a 1 vCPU VM (2,287 MB) the gate refuses with
`sandbox_size_unsupported` in 0 s; with the check lowered by hand, the same scripted turn ran inside 768 MB (peak 500 MB), which says
that a 1 vCPU VM cannot host a real repository's tests, not that the stack cannot start.

## Network in the agent phase

The agent has the model door and nothing else. The agent's container is on an internal Docker network with no exit
(`gateway_mode_ipv4=isolated`), so there is no route to the internet, to the VM or its services, or to a neighbour, and no name
server; the containers it starts through its own Docker are behind it and reach the door only. The firewall rules of the Control
container that used to confine the agent's user, and the allowlist proxy of package registries (`registry.npmjs.org`,
`pypi.org`, `index.crates.io` and the others), are gone.

**What this breaks until step 7 (the network door).** `npm install`, `pnpm install`, `pip install`, `apt-get`, `cargo`, `go get` and `docker pull`
all need a registry and now fail ("lookup registry-1.docker.io ... server misbehaving", measured). Whatever a task needs must already
be in the image: the toolchain of the agent image is there, and from step 5 the Setup container (full internet, no secrets, its result
becomes the agent image with `docker commit`) installs the rest. Until then a repository whose dependencies are not in the image can be read
and edited but not built or tested here.

There is no Go module proxy and there never was one.

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
| VM and containers | 2 vCPU and 4 GB for the VM; the Control container 768 MB without swap and 2048 processes, `/work` mounted `nosuid,nodev`; the model door 256 MB; the reader 256 MB; the agent's container the rest after 512 MB for the OS and the daemons (2,304 MB at 2 vCPU, section "The agent's container" for the other sizes), no swap. The Dispatcher refuses a size that leaves the VM no room for Control, the door, the reader and the OS (`sandbox_config_invalid`); a size that leaves the agent less than 1,024 MB (1 vCPU) is `sandbox_size_unsupported`, free, from the Worker | Dispatcher (`DISPATCHER_WORKER_CONFIG` can override the sizes), runner |
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
| `setup_failed` | The runner could not prepare the workplace before the turn started: git missing, the mirror could not be made, the model door could not be started (`model_door_unavailable` in the log), the agent's container could not be had (`agent_container_unavailable` in the log: no Sysbox runtime, the agent image missing, the daemon refused a step, the inner Docker did not become ready, or the container was not what was asked for). It is the free code of a turn that never started: once the model was used, the same trouble shows as `agent_gave_up`. The Runs-page sentence says "the repository's own set-up steps", which is not what happens: no repository script is ever run | free | Look at the Worker log of the job; it is the image or the VM |
| `sandbox_unproven` | The golden snapshot's Sysbox is not proven (its build's proof did not pass, or the Dispatcher was told so). The turn ends before the clone | free | Look at the `sysbox` field of the snapshot's record and the log of its build step; rebuild the snapshot |
| `sandbox_size_unsupported` | The VM leaves the agent's container less than 1,024 MB (a 1 vCPU VM does: 512 MB). The turn ends before the clone | free | Choose a size of 2 vCPU or more |
| `agent_gave_up` | The agent ended with no new commit on any branch and nothing to commit, or its engine died, or its container ended ("the agent's container ended during the turn": killed, most likely for its memory), or the model door went away ("the model door ended during the turn"), after the model had been used (what it had committed is pushed when possible). The summary also says when files the agent wrote could not be kept, such as `opencode.json` | charged | Read its summary; try again with a clearer or smaller task |
| `push_rejected` | The task's branch did not arrive (the branch exists with other history, a rule, a permission, a change of `.github/workflows/` which is never allowed, or GitHub could not be reached), no branch arrived although some had commits, or the agent's repository could not be read at the end. The Runs page lists every branch with its reason; branches that were pushed stay on GitHub | charged | Read the reasons, check the branches, then start again |
| `branch_violation` | **No longer produced** (there are no rules inside the workspace to violate). Old runs keep the code and its class | charged | Look at the branch |
| `cost_limit_reached` | The calls so far cost the limit, so the next call was refused. What was committed is pushed when possible: check the branch | charged | Raise the limit within the maximum, or make the task smaller |
| `time_limit_reached` | The turn ran into its time limit. What was committed was pushed when possible (nothing is pushed earlier, so a VM that dies first loses the work) | charged | Check the branches for what reached GitHub |
| `git_write_not_granted` | The installation has not accepted Contents write | free | Accept the new permission on GitHub ([`github-app.md`](github-app.md), "Update an existing App") |
| `implementer_engine_unavailable` | The Worker did not advertise the engine (its start-up checks failed, or the container is not the Implementer's profile), the claim carried no cost limit, or the capability is off in the App | free | The Worker log names the stable reason (`implementer_agent_image_missing`, `implementer_sysbox_missing` and others); see the rollout |
| `implementer_config_invalid` | The turn's settings cannot be used: a model entry the proxy cannot serve, the clone address, a turn without its record, or a job that reached the runner with neither `maxCostUsd` nor `operatorMaxCostUsd` | free | Look at the job log for the reason word |
| `no_capable_runner` | Nobody that can run tasks claimed the turn within 30 minutes (3 hours while a Worker was busy with others of the kind). Here: the Dispatcher's entry for the factory does not list `implementer`, so the Launcher does not advertise it; or, until 2026-11-01, a slow listing of the platform's VMs (next row) | free | Rollout step 2, and the next row |
| `fleet_list_failed` (a Dispatcher log line, not a code of the run) | With two or more Apps the Dispatcher lists the platform's VMs, at most once in five seconds, to count what each App occupies. A listing that gives no answer within 4 seconds counts as failed (the line carries its `ms`); the last good one is used for up to a minute, and after that the Dispatcher counts by its own launches and the claim goes on: the cap is a soft limit, the platform's concurrency limit the hard one. A failed listing no longer stops claims (it did on 2026-11-01, when 283 stopped VMs made the listing take 5.1 s and jobs ended `no_capable_runner`). Every listing that answers logs `fleet_listed` with its `ms` and `count`; the reaper deletes ended VMs after one day, 50 per run | free | A `fleet_list_failed` is a warning, not a cause of a task that does not start. Compare `ms` and `count` of the `fleet_listed` lines with the 4 seconds; if `count` grows, look at the reaper's `reap_done` (`deleted`, `deleteFailed`, `deleteKept`, `deleteNotTried`) |
| `dispatch_unavailable` | Nothing claimed the turn within `RUNNER_DISPATCH_GIVE_UP_SECONDS` (60 minutes by default); the Dispatcher is down, protected or full ([`deployment-vercel.md`](deployment-vercel.md), 5.3) | free | Look at the App's sweep log and the Dispatcher's |
| `timeout` | The turn was still running 70 minutes after it started, so the app failed it. The Worker normally ends it before at its 3600 seconds | free | Check the branch for what was pushed |
| `lease_lost`, `lease_expired` | The Worker no longer held the turn when it was ready, or stopped reporting, or the lease could not be confirmed before the final push; the result was not saved and nothing is pushed after the loss. Nothing is pushed during the turn, so a lost lease means no work reached GitHub | free | Start again |
| `runner_shutdown` | The Worker was told to stop (SIGTERM) while it worked: the engine was ended, all committed branches were pushed if the lease was still held. A turn of the Implementer is never run twice, so the app gives it back and it ends here, as its last attempt. The usage of a stopped turn is not recorded yet (#799) | free | Check the branch for what was pushed; start again with a new branch name |
| `runner_error` | The runner failed unexpectedly before any model call, or the model door or the agent's container went away during the turn before any call was billed or open ("the model door ended during the turn" or "the agent's container ended during the turn", with the exit code, and "killed for its memory" when the kernel did it) | free | Read the Worker log; start again |
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

- **Setup scripts and registries.** The repository's own install and set-up steps are not run, and the agent has no network to
  install anything: the Setup container and the environment's script come with step 5, the network door with step 7. Until then
  a repository whose dependencies are not in the image can be read and edited, not built.
- **Secrets for tests.** No credential of any kind reaches the agent: tests that need an API key or a database URL cannot run
  against a real service (a database in the agent's own Docker is fine).
- **Pushes that touch `.github/workflows/`.** The App has no `workflows` permission and never asks for it for this; GitHub
  rejects that branch (`workflows_not_allowed`) while the others arrive; a task whose own branch is the one rejected ends
  `push_rejected`. Change workflow files by hand ([`github-app.md`](github-app.md)).
- Opening or merging a pull request, a second turn on the same branch, a task on an existing branch, forks, other platforms
  than GitHub.
- **Attacks from inside** (a targeted escape from the container, tampering with the Sysbox daemons, the kernel): step 6 of the plan
  tests them on a real VM. This step proved the connectivity (below) and nothing more.

## What is accepted, and until when

These are decisions of the owner, not oversights.

- **The Control container is effectively root on the VM** (#745, step 3). It has the VM's Docker socket so that it can start the
  model door, the agent's container and the reader. The agent never reaches it: its container has no socket and no route to Control,
  and the runner puts nothing of a job or of the agent's output into a request to the socket.
- **The agent shares the VM's kernel.** Sysbox makes root of its container an unprivileged user and gives it its own Docker without
  `--privileged`, but there is no virtual machine around it (no KVM on the platform). A kernel flaw that Sysbox does not stop is an
  escape to the VM, where the key and the token are in other containers. Acceptable for our own repositories, not for strangers' (the
  plan's table of exits); step 6 attacks it on purpose. Sysbox officially supports Ubuntu up to 24.04 and the platform runs 26.04; the
  snapshot's proof is what notices a platform that breaks it.

- **Git is free, and every local branch is pushed.** No rule inside the workspace, none at the push: the agent can move any
  branch forward, including the default branch, and may push new branches (see "The risk, plainly"). Protect the default
  branch on GitHub. What the end of the turn will not do is force or delete.
- **The author and the committer are the agent's.** Nothing on GitHub proves that the system made a commit.
- **The work of a VM that dies is lost.** Nothing is pushed during the turn.
- **A branch created meanwhile.** If someone creates the task's branch after the submit check and before the end of the turn,
  and it points at an ancestor of the agent's tip, GitHub fast-forwards it: the task lands on a branch it did not create, with
  that person's earlier history under it. Any other history is a rejected branch (`non_fast_forward`).
- **Exfiltration through a registry: gone for now, back with step 7.** The agent has no network in this step, so it cannot reach a registry.
  The network door will give it one again (a rule per environment: off, a list, open). The old risk then returns: the egress rule looks at the
  name of the tunnel and nothing inside it, and `registry.npmjs.org` accepts uploads, so an agent that holds an npm token (from the repository, or
  from prompt-injection text) can `npm publish` any file it can read. It is accepted for **internal use, on own repositories** only. **#784 must
  be closed before external users** or a repository that is not ours: a read-only caching registry mirror (GET of metadata and tarballs only) or
  an intercepting proxy with a method allowlist, so that the agent has no tunnel to a public registry at all.
- **Any member may start a task.** See "What it is". Move to Admin and up before outside users.
- **No registry and no `.github/workflows` pushes.**
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
- **The Sysbox verdict in the deploy** is written and read (the fourth member of the pair), and `unrecorded` is gone: the first release
  after it has no verdict anywhere, so the Implementer is refused (`sandbox_unproven`) until that release has built a snapshot and
  promoted it (the changed image inputs rebuild it by themselves). Production steps: the machine identity's role needs *create* and
  *edit* on `SANDBOX_SYSBOX_PROOF` of `/dispatcher` too (`docs/deployment-vercel.md`, section 2.1).
- **#797**: a failed proof of the Implementer blocks code-review.com. The Dispatcher is shared, the deploy canary requires
  `implementer` as soon as the factory's entry names the kind, and the promotions of everything staged in that run wait for the
  canary. There is no switch that waives the proof; the way back is in the rollout, step 2.
- **#799**: the usage of a turn that was stopped (`runner_shutdown`) is not recorded.
- **#794**, **#786**, **#775**: the follow-ups listed under "What is accepted".
- Which branches may be pushed (`PUSH_EXCLUDED_BRANCHES`) is the owner's open question; the list is empty.
