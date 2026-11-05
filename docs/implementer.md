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

A task may name an **environment** (section "Environments"): a size for the VM and a setup script. The script runs once, before the agent
starts, in a container of its own with full internet access and no secret of any kind (section "The environment's setup script"); what it
leaves behind, installed packages, browsers and the images its Docker pulled, is what the agent starts with. A task without an environment
is the task of before.

Every member of a workspace may start a task (the permission `start_implementer_task`, minimum role member; one line in
`app/src/workspaces/permissions.ts` raises it). The App pushes with its own identity whatever GitHub rights the person has, so
this is a decision for internal use: before outside users arrive, move it to Admin and up.

The models are those that serve Dynamic Review: on the operator's key a released catalog entry of that kind, on the workspace's
own key a model of a provider that the models catalog lists and for which a key is saved. The agent is always OpenCode on the
native path; the two registry providers (Anthropic, OpenRouter) are offered like any other provider of the catalog, and their
keys go through the model door (#807).

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
   branch at the base tip. Nothing else is put into that repository: no hook, no guard, no spool. A follow-up turn (the job
   carries `resume`) starts from the branches the earlier turns left on GitHub instead, taken in one fetch 50 commits deep from every tip (section "A follow-up turn: the workspace with several branches").
5. **Set up** (only when the task's environment has a script). The runner starts the **Setup container** from the agent's image, runs the
   script in it with full internet access, and commits the container as the agent's image; a script that fails ends the turn here, free,
   before the model door exists (section "The environment's setup script"). Without a script nothing happens and nothing changes.
6. **Work.** The runner starts the **model door**, a container of its own that holds the model key, and the **agent's container**,
   and OpenCode then runs there as root in `/work/repo` with a configuration the runner wrote. It reads, edits, writes,
   searches and runs shell commands, and starts containers in its own Docker; it cannot fetch web pages, search the web,
   start sub-agents or ask a question, and it has no network but the model door and, when its environment's rule is not `off`, the
   network door (section "The network door (step 7)").
   The task is the user message. When it ends its turn with uncommitted changes it gets one more message to commit them; what
   is still uncommitted afterwards is committed by the system ("Implementer: uncommitted changes of the turn") on the branch
   the agent is on. Work the agent committed on a detached HEAD, on no branch, is saved first, whether the tree is dirty or
   not: the runner makes a branch `<the task's branch>-leftover-<id>` at HEAD and the push takes it with the others. The
   branch is named in the summary and reported with the other branches.
7. **Push.** Nothing is pushed while the agent works. When the turn ends, the agent's container is killed, and then the
   runner pushes all local branches of the agent's repository, without force, one at a time (below, "The git rules"). Before it lists anything, and again right before each
   `git push`, it asks whether the lease is still held; only `held` allows a push. A lost lease ends the turn `lease_lost`
   with nothing pushed after it.
8. **Report.** The Worker reports the result once: base and head commit and whether the head was pushed (both of the branch
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

**The branch the agent ended on.** The result also says which local branch HEAD was on when the runner read the repository
(`checkedOut`, #837): read in the reader from the `symbolic-ref` that the rescue of a detached HEAD already runs, so it costs no
further call, and set to the `-leftover-` branch when the rescue or the commit of the leftover had to make one. It is `null` when
HEAD was detached and on no branch, when its name is not one the runner pushes (it is never shown), and when the repository was not
read (the agent's container could not be confirmed gone). It names a branch of the agent's repository, which may not have arrived:
`branches` says which did. The app accepts the field (`parseImplementerResult`) and nothing reads it yet; the follow-up turn will start on it.
The runner sends the field only when it names a branch, so a newer runner against an older app still works for `null`; a name needs the app first (the older parser refuses unknown keys). `checkedOut` can name a branch that is not in `branches` (for example the base branch the agent switched back to); a resume then falls back to the session branch (#849 refuses a checkout outside the resume branches). The name is redacted and clipped by the host like the names in `branches`.

**One place for a later rule.** `PUSH_EXCLUDED_BRANCHES` in `runner/src/code_reviewer_runner/implementer/push_policy.py` is
empty. A rule such as "only the branch the form named" goes into `select_branches` in the same file and nowhere else.

**Nothing is pushed during the turn.** The agent may rewrite history, so a push mid-turn would only conflict with the one at
the end. The cost is that **a VM that dies before the end of the turn loses the work**: there is no periodic push to fall back
on. The watch still asks the lease every 30 seconds while the agent works, so a turn that is no longer ours stops paying for
the model.

**Time.** The runner keeps the last 270 seconds (four and a half minutes) of the time limit for the end. Every step is counted at its ceiling, and the sum at a normal end is
227 seconds: the export of the engine's session 5 s (section "The session snapshot"; it comes first, because it is read from the running engine), the end of the agent's container 25 s (the kill call 15 s at most, then the wait until the daemon says it is gone 10 s at most; the container is removed only
after the push, on a thread of its own, because removing a Sysbox container with its inner Docker can take long and nothing waits for it, which is right while one VM runs one turn), the first
reset of the readers 10 s (below), the rescue of a detached HEAD (three git commands of 3 s at most), the look at the tree (10 s at most), the commit of what is left (40 s), the second reset
of the readers 10 s, the final push (100 s), the two reads of the report (5 s each) and the last flush of the live view (8 s, section "Step records"). A stop (SIGTERM) commits nothing (it still saves a detached HEAD on a branch), resets the readers once, and
the process leaves itself 115 seconds, of which the sum is 86 (the last flush gets 5 s there, the export of the session 2 s) and the final push gets 25. A test holds both sums and the slack (a fifth of the grace, a quarter of the 115 s), with the real
constants. **Why the ceilings are what they are.** Measured on a VM (2 vCPU): the kill call of the agent's container took 0.4 s idle, 2.0 s with two inner containers of a 1.5 GB image and 3.9 s
with eight, and the wait after it 0.02 s, so the kill gets 15 s and the wait 10 s (an earlier round had 5 and 5, which a stack of a dozen inner services would have outgrown). The
steps do not take their ceilings together except when the Docker daemon hangs, and then the push fails anyway and the report says what was and was not done; the slack is for the steps that
take their ceiling and then some. The grace of the host after SIGTERM is 120 s and the container's stop timeout 150 s, both above the 115.

**The readers are made quiet before the commit and before the push.** A filter driver of the agent's repository cannot be switched off by name, so it runs in the reader, and a program it starts
with `setsid` outlives the command: `run_exec` on a timeout only closes its socket. A process left like that in a reader that can write could change the repository under the commit or the
fetch of the push. So once the agent's container is gone, and again after the leftover commit (whose `git add` ran the filters in the reader that can write), Control sends `SIGKILL` to the init of each
reader (which takes every process in its PID namespace) and starts it again (`ReaderAccess.reset`, `GitWorkspace.quiet_readers`), within 10 s each time; a reader that cannot be restarted is removed and made
again, and one that cannot be had back is forgotten, so that no command runs in a reader that is not known to be quiet. The reset keeps the same containers (killing and starting needs no room on a
full disk; making one does).

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
- **When each runs.** `git status` (`dirty()`) runs in the read-only reader **while the agent's container is still alive**: its
  answer decides whether the agent gets one more message, so it has to be asked while the agent can answer; an agent that
  changes the tree under it changes that answer and nothing else. The rescue of a detached HEAD and the commit of what is left run in the reader that
  writes, **after** the agent's container was killed and confirmed gone, and so do the list of branches and the fetch of the final push. The
  container is killed first (SIGKILL to its init, which takes every process of it with it, the agent's `dockerd` and anything it left
  running), so nothing of the agent can change the repository or call the door while the runner changes or reads it. If the container
  cannot be confirmed gone, nothing is committed or rescued and the summary says that changes in the working tree were not looked for.
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

### A follow-up turn: the workspace with several branches (#838, part of #745)

A follow-up turn is a job whose `implementer` carries `resume` (`ImplementerResume` of the contract): the number of the turn, the branches the last turn pushed with the tip it pushed (the
session branch first when it is among them, at most 20) and the branch the agent was on when that turn ended. Only a Worker that names the claim feature `implementer_resume` gets one. The
app does not send a `resume` yet (the follow-up API is a later step of #745); this is the runner's side. What the runner does with the stored conversation is "Follow-up turns: resume in the runner" below.

The workspace (`GitWorkspace`) prepares such a turn like this:

- **Names.** The parser refuses (`invalid_job`) a repeat, more than 20 branches, a tip that is not 40 lower-case hex digits, a `checkout` that is neither one of the branches nor the session branch, and a
  branch name of `resume` **or the session branch `branch` (every turn, the first too)** that the final push would refuse (`branch_name_problem` of `push_policy`: the stricter rule, so a name that could never be pushed is not taken at all, and a first turn does not run for nothing and lose its work at the push). The form's rules
  (`checkBranchName`) are at least as strict as that policy, so the Worker refuses no branch the form accepted. A lone surrogate (which JSON allows) in
  `baseBranch`, `branch` or a name of `resume` is refused the same way. Before anything is fetched the workspace checks every name once more as a first turn's names are checked (`git check-ref-format`, not `HEAD`,
  no leading dash, no control character); a name git does not accept ends the turn `implementer_config_invalid`, free. The same code ends the turn when one name is the directory of another (the session branch
  `a` and a branch `a/b`, or the base `main` and `main/x`): both cannot be refs, and the session branch is made at the base tip when the provider never had it.
- **Fetch.** The runner asks the provider which of the branches it has (`git ls-remote --heads`, the same authenticated path as the clone, one call with a ref pattern per branch), then takes the base branch and **all**
  of those that exist **in one** `git fetch --depth=50` (`RESUME_DEPTH`) into the mirror as `refs/heads/<name>`. Git counts the depth from every tip and keeps a commit when any tip reaches it within 50 commits, so
  **what is guaranteed is: every tip (base, session branch, other branches) has at least 50 commits of history where it has that many, whatever the order of `resume.branches` and however the branches lie to each
  other** (a branch 49 commits ahead of the base, or a session branch that forked before the base tip, does not make the base a shallow root). It is not guaranteed that nothing is deeper: a commit that another tip
  reaches within 50 commits is there as well. The agent has no remote to deepen from, and with less history a base branch that moved since the earlier turn could not be merged, rebased or diffed against (`merge-base`
  finds nothing, "refusing to merge unrelated histories"). **The limit that remains:** a merge base further back than 50 commits from the tips is not found. Separate fetches could not give this (a later `--depth`
  fetch moves the shallow boundary, whatever the order), which is why there is one. The branches the provider does not list are left out and recorded (`resume_missing`) from the answer of `ls-remote`, without a fetch
  that fails; a base branch it does not list ends the turn `base_branch_not_found`, a session branch of `resume` it does not list `clone_failed` (free). A first turn keeps the base branch one deep. The `ls-remote` is
  bounded by `FETCH_TIMEOUT` (60 s) and the fetch by what is left of `RESUME_FETCH_SECONDS` (300 s, started before the `ls-remote`: both together); a turn that is not set up by then ends `clone_failed` (free). The token is
  in the environment of those git processes and nowhere else, as for the base. The tip is read from the mirror after the fetch, never from the job or from the `ls-remote` (a branch that moves between the two is taken as
  the fetch has it).
- **What moved.** The tip the provider has now is the start of the turn, whatever the job said: a branch that is not at the tip the earlier turn pushed is taken as it is and recorded
  (`resume_moved`: name, the tip that was, the tip that is) so that the agent can be told. A branch the provider no longer has is left out and recorded (`resume_missing`); the checkout falls back to the session
  branch when that is the one that is gone. A session branch that is in `resume` and gone ends the turn `clone_failed` (free): the app checks it before it starts a turn, so this is a race.
- **The agent's repository.** Made as always from the mirror (a clone that is not `--single-branch`: the mirror holds the base branch and the branches of the session and nothing else under `refs/heads/`), then a
  local branch for every fetched branch at the tip the mirror has (one `update-ref --stdin -z` in the reader), the session branch at the base tip when no earlier turn pushed it, no remote, and the
  branch the agent was on checked out. `resume` with no branches starts from the base like a first turn.
- **One start tip per branch** (`start_tips`). `start_commit` is the start tip of the session branch (the base tip on a first turn), so `baseCommit`, `commits` and `filesChanged` of the report cover what this turn did to the
  session branch. The final push judges every branch against its own start tip: a branch of the session that the agent did not touch is not fetched, not pushed and not reported; a branch the agent made is left alone while it is still at
  some start tip (it holds no commit of its own). The push is as before: every local branch, no force. In the result of a follow-up turn `pushed` and `headCommit` describe the session branch only; the other
  branches the turn pushed are in `branches` (the follow-up that reads them is a later step of #745).
- **After the setup script** the history of the script is undone branch by branch: HEAD back on the branch the agent starts on, every branch of the turn at its start tip, every other branch and tag deleted.

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
| Network | The **model network**, internal, `gateway_mode_ipv4=isolated`, range `10.213.77.0/29`: the agent at `10.213.77.4`, the model door at `10.213.77.2`, the network door at `10.213.77.3` (only for a rule other than `off`), and nothing else. No exit, no route to the VM or its control port `23456`, no name server, no neighbour; Control is not on it. The containers the agent starts through its own Docker reach the doors too (through the agent) and nothing else. What the agent reaches through the network door is the environment's rule (section "The network door (step 7)"). |
| Repository | The `repo` directory of the work volume, mounted as `/work/repo` (the volume's `Subpath`): the agent sees the repository and nothing of the mirror. The mount is idmapped by Sysbox, so the files the agent's root writes belong to the VM's root (measured), and its container uid 0 is host uid 165536 for processes only. |
| Memory | The VM's memory (2,048 MB per vCPU) less the limits of everything else on it, each counted in full: the OS and the Sysbox daemons (512 MB), Control (768 MB), the model door (256 MB), the network door (96 MB, counted for every turn, `off` included) and **both readers** (256 MB each, 512 MB: they exist from the start of the turn, and an earlier sum counted one), **and less the part of the memory guard's floor above 512 MB** (below). No swap: **0 MB at 1 vCPU (refused), 1,952 at 2, 5,904 at 4, 9,672 at 6 and 13,441 at 8** (96 MB less than before the network door: 2,048, 6,000, 9,768 and 13,537). The guard kills the agent's container when the VM has less than max(512 MiB, 8% of its memory) left (512, 656, 984 and 1,311 MB at 2, 4, 6 and 8 vCPU); until fix round 3 of step 6 the sum did not know the floor, so at 6 and 8 vCPU an agent that stayed inside its own limit left the VM less than the guard's floor and was killed for it (the figures were 10,240 and 14,336, and 6,144 at 4 vCPU). The 512 MB of the OS's room is the floor of 2 vCPU, so nothing is taken off there. `contracts/environment-sizes.v1.json` holds the floor (`memoryGuard`) and the figures; the Dispatcher computes `agentMemoryMb` from the same two numbers the runner's `vm_memory.py` uses, and a test of each holds them to the file. Less than 1,024 MB is `sandbox_size_unsupported`, so 1 vCPU stays refused. A test holds that the limits of the agent, Control, the doors and the readers leave the VM at least the guard's floor at every size. Why these figures: "The memory of the readers and the OS" below. |
| Limits | 16,384 processes. The time limit and the cost limit are Control's and the door's. The VM's table of open files is made too big for the agent to fill (`sysbox-prepare.sh`); the agent's and the Setup container's processes start with the highest OOM score (1,000: proven in an exec, from the VM's pid view, and for the engine started the way `start_engine` starts it), which root of the container can lower to -999 but not to -1,000, so Control's guard is what holds the VM's memory: it kills the container, repeatedly until it is gone, when the VM has less than 512 MiB or 8% of its memory left (`vm_memory.py`). Section "The attack test (step 6)". |
| Docker options | Constants only. No job, repository name, branch or output of the agent is in any request to the daemon: they are JSON bodies made from the runner's constants and identifiers the daemon gave, and the exec commands have fixed arguments. After the container is made, Control reads it back from the daemon and refuses to start the engine if it shows a privileged container, a bind, a device, another runtime, another network or a mount besides the repository. |

**How Control drives it, only outward.** Control starts OpenCode with an exec, writes the engine's configuration with an exec that
copies its standard input to a path (the archive call of the Engine API, `docker cp`, puts its files where a Sysbox container does not
see them), and reaches the engine's HTTP port through a loopback listener of its own: every connection opens an exec that runs a relay
to the engine's port in the container. The agent has no address of Control's, no route to it and no port of it to connect to; the Docker
daemon is the only thing that joins the two. This was chosen over a port in the agent container that Control connects to, because that
needs Control and the agent on a common network, from which the agent could connect back. Nothing in the agent opens a connection to
Control.

**How Control reads the agent's repository.** In the **reader**, under the same runtime as the agent: a container of the Worker image (which
has git), `sysbox-runc`, `NetworkMode: none`, no token and no secret, a read-only root file system, `no-new-privileges`, `CapDrop ALL` with `CapAdd DAC_OVERRIDE`, a memory limit (below), and the
repository as its only mount, **read-only** for every look (the list of branches, the status, the `git upload-pack` of the final fetch,
piped to Control's `git fetch` by `exec_pipe`). The steps that change the repository (the set-up before the agent exists, the rescue of a
detached HEAD and the leftover commit after the container is gone) run in a **second reader** with the repository read-write; both are made
before the agent starts (`ReaderAccess.warm`), so that nothing has to be created when the VM's disk may be full. Control runs `git` in them
through exec. **Capabilities.** The first version of the reader ran on plain runc as the VM's root with `DAC_READ_SEARCH` and
`DAC_OVERRIDE`, and the default seccomp profile allows `open_by_handle_at`, so a `core.fsmonitor` planted in the repository could read and
write any file of the VM's root file system. The reader now keeps one capability, `DAC_OVERRIDE` (to read and write what the agent's other
users made: files of mode 600, directories of mode 700, a git directory of another uid), and **measured on a real VM (2026-11-03, 2 vCPU): Sysbox
ignores the container's `CapDrop`**: with `CapDrop: ["ALL"]` the init and every exec of the container still held all 41 capabilities of its user
namespace (`CapEff 000001ffffffffff`, `CAP_SYS_ADMIN` among them), so the old proof of the snapshot (`docker run --cap-drop ALL`) proved nothing about the reader that ships. So the document
says `CapDrop ALL` and `CapAdd DAC_OVERRIDE` (that is what a plain-runc lane gets), and **every command the reader runs starts through `setpriv --bounding-set=-all,+dac_override
--inh-caps=-all --no-new-privs`** (`READER_DROP_CAPABILITIES`): `CapEff` of the command is `0000000000000002`. `DAC_OVERRIDE` is the minimum (measured over a repository with files of mode 400 and 600
owned by uid 1000, a directory of mode 700 owned by uid 999 and a git directory owned by uid 1000: with no capability `status` cannot open the directory and `add` fails on the index; with this one `add -A`, `commit`
and `switch -c` work; `FOWNER` is not needed). **A remount does not make the volume writable, with or without that bounding set**: in the read-only reader `touch` gives "Read-only file
system", `mount -o remount,rw /repo` and `mount -o remount,rw /` give "permission denied", also from a command that holds all 41 capabilities (the mount's flags are locked by the user namespace
that made it); `test_reader_hostile.py` asserts it on a VM and, with the capability missing, under runc. **Proven on a real VM (2026-11-03, 2 vCPU, a `spike-` VM from a snapshot built from the branch):**
that reader configuration, with a planted fsmonitor that calls name_to_handle_at and `open_by_handle_at`, opened a handle for a file, then for the root of
the VM's file system (inode 128 on the XFS), listed it, read `/etc/hostname` and **wrote `/var/lib/cr-escape-marker` on the VM's root**; the same
call under `sysbox-runc` with no added capability returned `EPERM` at both stages and nothing was written (root of the reader is the unprivileged
uid 165536 of the VM, uid_map 0 165536 65536; what it holds as capabilities exists inside its user namespace only). Git is also told not to run what the
repository names where an option can stop it (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, `gc.auto=0`, `maintenance.auto=false`,
`core.untrackedCache=false`): with them the planted fsmonitor does not start at all. A filter driver of the repository cannot be switched
off by name, so it runs, in the reader, and is contained: the container is the wall, not the options. A hostile repository (hooks, config,
filters, symlinks, alternates) can only run things where there is nothing to reach. Control never opens a path in the repository.

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

**Measured on a real VM, round of the review of #824 (2026-11-03, 2 vCPU, 4 GB, `spike-` VMs from snapshots built from the branch, head `3e115264`, `sysbox: proven` with the Subpath volume in the proof).**
The launch steps of the Dispatcher (`SandboxDockerHost` and `workVolumeCommands`, run for real through the Vercel adapter) took 8.0 s in all: the three run-directory steps 0.5 to 0.6 s each (platform round trips),
`vm-prepare.sh` 1.3 s, the image check 0.5 s, `sysbox-prepare.sh` 0.7 s, the eight volume steps 0.5 s each (the work in them is 5 to 40 ms: `fallocate` of 8 GiB 5 ms, `mkfs.ext4` 16 ms, loop mount 15 ms). The whole lane (11 journeys) passes
under `sysbox-runc` in 108 s, and under `runc` in 79 s. Memory: a fresh VM with Docker and the two Sysbox daemons up uses 351 MB (512 are reserved); during a turn the used memory peaked at 1.35 GB of 4.28 GB with the agent
pulling a 1.5 GB image into its own Docker and running two containers in it (the agent's container 612 MiB, the relay 12, the readers under 1 MiB each); so the limits that add up to the VM are a guarantee and not a forecast.
Stop: the kill of the agent's container took 0.4 to 0.5 s idle and **3.5 s** with that inner Docker, the wait until it is gone about 0 s after the kill, the removal 0.3 s (done after the push); the second round measured the kill more widely, see "Time" under "The git rules". The network, from
the agent in a turn: the door's relay at `10.213.77.2` reached; the model network's gateway, the VM's docker0 gateway, the VM's control port `23456`, `1.1.1.1:443`, a name lookup (ping and `getent`) all blocked, and the agent's only routes are the model network and its own inner `docker0`;
a plain container on the VM with the same tools reaches the host listener, `1.1.1.1:443` and resolves `example.com`. The reader attack and the full disk are under "The agent's container" and "The disk".

## Step records (the live view)

While a turn runs, Control converts the events of the engine's stream into **step records**, one per part: what the agent
thinks (`reasoning`), what it answers (`text`), each tool call (`tool`) and the tokens and cost of each model call (`step`)
(`implementer/step_records.py`). They go into a bounded in-memory queue (`implementer/step_feed.py`), a pump of the job process
takes them out every two seconds (`implementer/step_pump.py`), the job host sends them to the app
(`job_loop/step_sender.py`, section "How the records get to the app" below), and the app stores them (`POST
/api/workers/v1/jobs/{id}/steps`). The Runs page shows them (section "What the Runs page shows" below).

- **What is kept.** A record has the part id, a counter, the start and end time and its text. A tool part is reported again when it
  changes (running, then completed or error) with the same part id and a higher counter. Reasoning and answer text are kept
  when the part ends. Whether a model shows its reasoning depends on the provider; a part without text makes no record.
- **What is cut.** Text 16 KiB, a tool input (as JSON text) 4 KiB, an error 4 KiB, a title 512 bytes; always on a character
  boundary, with a `[N bytes cut]` mark and the true size. A turn keeps at most 5,000 records and 2 MiB of text; after that only
  the tool calls go on, as name and status, and the turn is marked as shortened. That is at most 10,000 more records; the end
  (`completed` or `error`) of a tool whose start was seen is still reported once after that, so the page never shows a tool that
  finished as running forever.
- **Reasoning text.** The runner chooses no model variant and sets no reasoning option, so the stock engine decides what a model
  shows. Thinking is shown by: OpenAI `gpt-5` models (the engine asks for a reasoning summary for them by default, except
  `gpt-5-pro` and `gpt-5-chat`), Google models (the engine asks for their thoughts by default) and OpenAI-compatible providers
  that return `reasoning_content`. Anthropic models think only with a variant, so by default they show nothing. Forcing summaries
  for other OpenAI models (the o-series, `gpt-5-pro`) was left out on purpose: an OpenAI organization that is not verified gets a
  400 on `reasoning.summary` and the turn would fail.
- **Sub-agents are not shown.** Only the session of the turn itself is converted; events of any other `sessionID` (a sub-agent
  session) are dropped. The `task` tool is denied today, so there are none.
- **Tool output is not recorded.** The live view shows the call, never what the repository answered. It stays in the engine's session.
- **Secrets.** Every text is redacted with the job's secrets and the door's bearer before it is put in a record, and before it is
  cut. The input of a tool is redacted value by value (and key by key) before it is turned into JSON, because a secret with a
  quote, a backslash or a newline (a PEM key) no longer matches once JSON has escaped it. What the redactor cannot know is the
  repository itself: a `.env` the agent printed is in the agent's text or input if the agent wrote it there. A member who can see a run can read what the agent wrote down.
- **Best effort.** The tool audit is the reader's first feeder and fails closed. The step feeder comes after it and fails open:
  an event it cannot convert, a full queue or a bug is counted and dropped. It never ends a turn, never delays the push and
  never touches the ledger. What it lost (events it could not convert, records pushed out of a full queue) is one line in the
  turn's notes at the end of the turn.

### How the records get to the app

The job process holds neither the lease token nor the Worker's credential, so it does not call the app. The job host (the Worker's
own process, which holds the credential and beats the heart) hands the process **one more descriptor**, a second socket pair
beside the lease question (`RUNNER_STEPS_FD`, `step_wire.py`), and sends what comes over it with the Worker API
(`HttpWorkerApi.steps`, the per-job credential). Only a turn of the Implementer gets the descriptor, and only when the app lists
`implementer_steps` in `GET /api/runners/v1/version`; otherwise the process has no channel, makes no feeder, queues nothing and
sends nothing, with no error and no note. (The Worker is the only runner that runs the Implementer, so there is no second path.)

- **Batches.** The pump drains the queue every 2 s into batches of at most 50 records and at most 48 KiB, **measured on the escaped
  JSON body as it is sent** (a control character is six bytes there, an emoji twelve; the app reads up to 64 KiB). A record that
  is larger than a batch by itself has its longest texts halved until it fits, with a `[cut to fit]` mark; one that cannot be made
  to fit is dropped and counted.
- **Never on the turn's path.** The pump has a thread of its own and bounded writes (1 s; a host that does not read costs one
  write timeout, then the channel is given up). The sender is a task of the host's event loop beside the heartbeat; its call runs on
  a daemon thread of its own (each socket operation 5 s; DNS is not bounded by it, so the sender waits 8 s at most for a call and then treats the app as unavailable), one at a time, never on the executor of the heartbeat and the result. A dead or
  slow app costs the sender its patience and nothing else: the turn, the heartbeat, the lease question, the push and the result
  never wait for it.
- **Failure.** A 409, 404 or 401 (the app does not hold the job for this Worker) stops the sender for good and the host closes its
  end; the pump notices, closes the feeder and gives up the queue. Any other failure backs off (2 s, doubling to 30 s) and the same
  batch is posted again (the call is idempotent: the app keeps the highest `seq` of a part). A batch the app refuses for good (another
  4xx) is dropped and counted. The host keeps at most about a minute of backlog (60 s of age, 40 batches), the oldest dropped first.
- **The last flush.** After the final push, so the push never waits for it, and before the result is made, the process hands over
  what is left and asks the host to say when everything it holds is sent, for at most 8 s (5 s at a stop; the sums above). A finished run then shows all its
  steps. The host answers with the number of records it received and could not send.
- **Notes, counted once.** A record is in exactly one of four places: pushed out of a full queue (the feeder: "dropped N step records
  that were not taken in time"), lost between the pump and the host or left in the queue at the end, lost by the host, or sent. The
  last three are one line, "the live view could not send N step records to the app"; a host that does not answer the flush is "could
  not confirm that its last step records arrived". The first note cannot fire on a healthy turn: the pump drains faster than the
  queue fills, and a feeder whose channel is gone takes nothing more and counts nothing.
- **The network.** The calls go to the same app URL as the heartbeat and the result (`appUrl` of the Worker's start document), from
  the Worker in the VM. The second wall (step 7) narrows the VM's policy to GitHub, the model provider, the App's host (`appHost`,
  the host of the Dispatcher's configured App URL) and the Dispatcher; the steps calls need no host of their own.

### What the Runs page shows

The detail page of a run of the Implementer has a section **What the agent did**, a timeline of the turn, one model call after the
other (`app/src/runs/ui/run-steps.tsx`):

- **Per model call** a header with its number, its tokens (in, out, reasoning, and cached where the page shows a cost), the time it took and, where the page
  shows a cost for the run, its cost. A run on the operator's key shows no cost and no cache count, as everywhere on the page (the
  cache counts say which provider answered). The app does not even store them for such a run, and the route leaves them out again
  when it reads, by the rule of the run detail (the usage record names the operator's key, a catalog entry or a tier), and masks the
  model and provider names in every text of such a run, whatever the stored row holds.
- **Thinking** (the reasoning text, when the provider returned some) is collapsed; click it to read. **What the agent says** is
  visible. **Each tool call is one line**: the tool, the title the engine gave the call, how it went (`waiting`, `running`, `done`, `failed`; any other state is `unknown`) and
  how long it took; the input of the call is in a collapsed block, and the error text of a failed call is shown.
- **Marks.** A text the runner cut shows "cut, N bytes". A turn so long that the runner kept only name and status of the later tool
  calls says "The log was shortened".
- **Plain text only.** Everything is rendered as text: no markdown, no HTML, no link, whatever the agent or the repository wrote.
- **Live.** While the run is waiting or running the section is open and rides on the poll of the run (every 3 s): each new snapshot
  of the run makes one request, `GET /api/w/:workspace/runs/:id/steps?after=<cursor>`, and the run that settles makes one last, after the
  runner's final flush, so a finished run shows all its steps. The page merges the answers by part id: a tool call that was `running` and is
  now `done` replaces its earlier row in place. A **Follow** switch (on while the run is going, off when a settled run is opened later) keeps the
  view at the end; scrolling up lets go of it, and so does "Show earlier steps". A settled run shows a button, and when it is pressed
  the steps are fetched page after page until none is left (a turn at the caps is 80 pages of 200), because no later poll will ask again.
- **Long turns.** The page renders the newest model calls (about 400 parts) and offers "Show earlier steps" for the rest, so a turn at
  the caps does not put thousands of rows in the document. The caps are the app's: at most 16,000 parts a turn. The runner sends
  up to 15,000 records (5,000 in full, and 10,000 more as name and status only once a turn is that long).

**The route.** `GET /api/w/:workspace/runs/:id/steps?after=<seq>&limit=200` (`withWorkspace(…, "view")`: any member of the
workspace in the address). It answers `{ steps, cursor, hasMore }`: the parts that changed after `after` (a part that changed gets
a new `seq` and comes again), at most `limit` (1 to 200, more is read as 200) taken by `seq`, listed in the order the parts began in, and the
`seq` to ask after next. A malformed query is `400 STEPS_QUERY_INVALID`. The id of a run that is not a run of the Implementer of the
workspace (another workspace, another kind, unknown, malformed) is `404 RUN_NOT_FOUND`, so the route does not tell the runs of
other kinds or workspaces apart; a run of the Implementer without steps (an older one, one whose runner did not send) answers an
empty list. The route is in the capability `implementer`, like the other Implementer routes. Only text and numbers of the four known
kinds are passed on, and every text is cleaned of the secrets the app knows again.

**Who can read it.** The same people who can open the run: every member of the workspace (`view`). **A member can read what the
agent read and said.** The runner and the app strip the secrets they know (the model key, the door's bearer, the tokens of the job, anything shaped
like a credential), but they cannot know the repository: a `.env` the agent printed with `cat`, a key in a test fixture or customer
data in a file the agent opened is in the agent's text or the input of its tool call, and so on the page. **The output of a tool is not
shown** (the runner does not record it and the app never gets it), which keeps most of that out; the input of a tool call (a command, a
path, a pattern) and the agent's own words are shown. Steps are kept as long as the run is, for now with no time limit. Before outside users arrive, the
decision to let every member see them moves with the one for starting a task (the note in "What it is").

## Follow-up turns: what was measured on a real VM (#837)

A follow-up turn continues a session in a new VM: the old conversation is exported from the engine before its container is
killed, kept, and imported on the new VM. None of that is built yet. This section is what a real VM said about the plan's
assumptions before it is built; `runner/scripts/follow_up_spike.py` reproduces it (15 of 15 checks passed on the VM below, the lane's 11 tests of `test_implementer_git.py` and `test_implementer_turn.py` too).

**Measured on a real VM (2026-11-04, `spike-837-followup-1`, 2 vCPU, 4 GB, a snapshot built from `development` at `f34a40a1`,
`sysbox: proven`; the agent's container 2,048 MB under `sysbox-runc`; the pinned OpenCode 1.19.0; the strict scripted provider of
`fakes/wire` behind a made-up key, so no model and no real key).** The script runs the lane's whole turn (`ImplementerSession.run()`,
the real door, container, reader and workspace) several times on one VM and puts itself into the flow at three places: a recorder
on the engine's event stream, the export just before `ImplementerAgent.stop()`, and the import just before the engine starts.

| Question | What the VM said |
| --- | --- |
| Is the export by HTTP the CLI's export? | **Yes, equal as parsed JSON**, for 63 and 72 messages, in one call and in pages of 50. `GET /session/<id>` gives `info`; `GET /session/<id>/message` gives the messages. Without `limit` all of them come back in one answer. With `limit=N` the **newest** N come back, oldest first, and the header `x-next-cursor` (also `Link ... rel="next"`) holds the cursor for the next, older page (`before=<cursor>`; a cursor that is not one is a 400). The pages are put back in order by reversing them. A client that sends the runner's `x-opencode-directory` header gets the answer, and so does one that sends none (checked on a local engine). The empty answer of the earlier research was not the engine's. |
| What does the CLI do when its output goes to a pipe? | **It cuts the document at the size of the pipe** (65,536 to 131,072 bytes arrived of 2.7 MB, never valid JSON) and exits 0. Redirected to a file it writes all of it. The CLI is a way to compare, not a way to take the export. |
| Time of the export by HTTP, through the exec tunnel | 2.6 MB (63 messages, 61 tool calls): 0.10 s in one call, 0.2 s in three pages. 18.4 MB (244 messages): 0.24 to 0.29 s in one call, 0.37 to 0.41 s in six pages. The CLI takes 1.2 to 1.3 s, because it is a second OpenCode. |
| Memory of the export by HTTP | Control (Python, joining the pages and parsing them): 7.6 MiB in one call and 10 MiB paged at 2.6 MB, 53 and 70 MiB at 18.4 MB, so three to four times the document. The engine's resident memory moved by less than 25 MB (769 MB before and after at 2.6 MB), and the VM's available memory dipped by at most 66 MiB (1,210 to 1,144 MiB at 18.4 MB). |
| Memory of the CLI's export | A second OpenCode process: **312 MiB** peak at 2.6 MB, 345 MiB at 10 MB. On a transcript of 300 maximal tool calls, with two CLI exports in a row, the VM's guard (`vm_memory.py`, 512 MiB left) killed the agent's container. That is the reason to take the export over HTTP, as the plan says. |
| The whole path of the runner (fetch, parse, redact, dump, gzip) | 0.4 s at 2.6 MB, 1.6 to 1.7 s at 18.4 MB. |
| Redaction | The runner's `Redactor` **on the JSON text breaks the JSON**: its `Bearer ...` shape runs up to a quote, and in JSON text the quote it eats is the backslash of an escaped one (137 bytes changed, invalid JSON, in a transcript of the repository's own code; 15 strings). On the string values (and keys) it leaves valid JSON and takes the same time (0.09 s against 0.10 s at 2.6 MB, 0.62 to 0.74 s against 0.68 to 1.03 s at 18.4 MB). |
| Does `opencode import` work under Sysbox, in a depth-cut clone with another root commit? | **Yes.** The second turn's clone was cut at depth one of the first turn's branch, so its only root commit (`0e4545bf`) was the first turn's tip and not the first turn's (`ea7bed08`). Before the engine started, the snapshot was written to `/etc/code-reviewer/resume.json` (0600, 0.05 s) and `opencode import` ran in the container with the engine's environment: it printed `Imported session: <id>`, kept the session id and the message ids, rewrote the project id to the new root commit and the directory to `/work/repo`. The engine then answered `GET /session/<id>` with 200. |
| Does the imported session continue? | **Yes.** The runner's second user message (and its extra message for a dirty tree) went to the imported session; the first request of the model had 123 messages (1.35 MB) and carried the first turn's instruction, its answer and its tool results; the strict provider accepted the history; the second turn's export holds the 63 messages of the first with the same ids and 9 more. |
| Time and memory of the import | 1.5 to 1.7 s at 2.6 MB with a peak of 306 to 313 MiB (a second OpenCode process; the container's own peak read 288 MiB then). At 18.4 MB: 2.1 to 2.3 s, 378 to 385 MiB (the container's peak 387 to 397 MiB), and the engine served the session. The plan's 60 s box is about 25 times the largest measured. |
| What does a large history cost the first call? | At the lane's $5 limit the first call of a follow-up from the 18.4 MB snapshot was **refused by the door before any model call** (`cost_limit_reached`, no request reached the provider): the door reserves the cost of a call before it is made, and the history alone is more than the limit. The form's hint ("the first call reads all of it again") is the place to say so. |
| Size of a realistic transcript | 61 tool calls over the repository's own source (63 messages, 187 parts): 2.60 MB as compact JSON, **0.62 MB gzipped** (0.24). Tool outputs are 1.26 MB of it, and the tools' metadata another 1.21 MB (a tool repeats its output in its metadata); everything else is 0.07 MB. About 43 KB and 10 KB gzipped per tool call. The CLI's own formatting makes the document 3 % larger. |
| Size of the worst transcript | 240 tool calls that each answer 44 KB of random text (the engine cuts at 50 KB): 244 messages, 18.4 MB, **8.42 MB gzipped** (0.46), which is 33 KB over the plan's 8 MiB. The cap holds for about 235 of the largest tool answers there can be. |
| Can the compacted outputs be left out? | **Yes.** After a later user message the engine's prune marks old tool outputs as compacted (`state.time.compacted`) and sends the model a fixed text in their place. After the second turn 42 of the 61 outputs were marked (1.11 of 1.32 MB). A follow-up from the snapshot with those outputs and the long strings of their metadata emptied sent the model **exactly the same 137 messages** as one from the full snapshot (equal JSON, the same 42 markers), and the snapshot was 1.52 MB against 2.73 MB (0.39 against 0.66 MB gzipped). Emptying the metadata strings of every tool part saved 36 KB more here. Nothing was marked after the first turn (two user messages), so it helps from the snapshot of the second turn on. |
| Can `step-finish` come before a long tool call ends? | **No.** In 68 steps of turn one (61 tool calls), one of which ran a 12 s `bash` beside two quick tools, every `step-finish` part came after all the tools of its step ended: the two quick tools ended 0.1 s after the start, the long one 12.1 s, and the `step-finish` in the same millisecond. A tool part is reported as `running` twice (the second carries its metadata). |
| What does the stream do on abort? | `POST /session/<id>/abort` returned in 0.1 s. The stream then carried `session.error` (`MessageAbortedError`), `session.status` idle and `session.idle`, and 20 ms later the tool part as `completed`, the message as completed with the error, and idle again. **No `step-finish` comes for an aborted step**, and the command (`sleep 60`) was gone. The export shows the aborted assistant message with the error and no finish. A view that groups by step must close an open step on `session.idle` or at the end of the turn. |
| Does the stream say anything about old parts? | In the second turn the stream carried 42 `message.part.updated` events for tool parts of the first turn, as many as the prune marked, so the engine most likely re-sends a part when it marks it. The step feeder keys a record by part id, so they are upserts of rows the page already has; they must not move them. |

**The end of the turn.** The export is cheap, so its budget can be small. The sums of the end (the sum test of `runner/tests/unit/test_implementer_session_parts.py`)
were 222 of 270 s at a normal end (the test holds them to 85 %, 229.5 s) and 84 of 115 s at a stop (75 %, 86.25 s). The 20 s and 8 s of the plan would have made
242 and 92 and failed both limits; the measured path takes 1.7 s at 18.4 MB, so **5 s at a normal end (227 s) and 2 s at a stop (86 s)**, which is what #839 built, fit the sums and are about three
and 1.2 times the largest measurement. The upload of the file goes through the job host before `complete` and is not part of the grace.

**Rerun.** On a `spike-` VM from a snapshot built from the branch (`docs/golden-snapshot.md`, `--skip-retention`), as root, with the repository's
`runner/` and `fakes/` on the VM and `uv sync --frozen` run: `LANE_RUNTIME=sysbox-runc LANE_WORKER_IMAGE=code-reviewer-worker:golden
LANE_AGENT_IMAGE=code-reviewer-agent:golden .venv/bin/python scripts/follow_up_spike.py` (about four minutes; `--skip` takes `two`, `blank`, `abort`, `bulk`,
`bulk-import`; `--bulk-steps` and `--bulk-window` size the worst transcript). It prints one JSON line per check and per fact.

**Not measured.** A real model (what a provider says to a replayed history, or to reasoning parts of another model), the clock of the VM against the first turn's, 4 vCPU,
the narrowed network policy, and the import of a snapshot written by another OpenCode version.

## The session snapshot (#839)

A follow-up turn (#745) continues a session in a new VM, so the engine's conversation has to outlive the VM. At the end of every turn the runner takes the
engine's session as a file and the job host uploads it to the app, which keeps **one snapshot for each session, replaced by each turn, and never deleted but by the erasure
of the workspace** (owner's decision of 2026-11-04). The runner of a follow-up turn reads it back and imports it on the new VM ("Follow-up turns: resume in the runner", #840); the follow-up API and page are another step (PR 9).

**Taking it** (`implementer/session_export.py`, called by `ImplementerSession` right before `ImplementerAgent.stop()`, because it is read from the running engine). Over the
engine's HTTP API only, as the spike measured: `GET /session/<id>` and `GET /session/<id>/message` in pages of 50, newest page first with the cursor in `x-next-cursor`, put back
in order, over one connection (each connection through the exec tunnel costs an exec). Then, in this order: the output of every tool part the engine's prune marked as compacted
and the long strings (over 256 characters) of that part's metadata, at any depth (an edit nests the file before and after in `filediff` and `files`), are emptied (the model is sent a fixed text in their place: the same 137 messages in the spike); the redactor of the
turn is applied to **every string value and key**, never to the JSON text (its `Bearer ...` shape runs up to a quote and broke the document); the result is compact JSON with ASCII
escapes (a lone surrogate cannot be encoded otherwise), gzipped with no time in the header. **Over 8 MiB gzipped there is no snapshot** (a note, `too_large`). The whole path, the hand-over to the job host included, is held to **5 s
at a normal end and 2 s at a stop** (or when the lease or the runner is going away), which is what the sums above count; the measured path takes 1.7 s at 18.4 MB.

**The engine is the agent's to replace, so the export does not trust it.** The engine runs in the agent's container and the agent can put any server on its port. A server that sends its body a byte at a time never trips a
socket timeout (measured with a fake: 1 byte per 1.5 s kept a 3 s budget busy for 93 s), so the whole export (fetch, redaction, blanking, dump, gzip) runs in a **daemon thread that the caller joins for the seconds it was
given**; at the deadline the thread is told to stop, the connection is shut (`shutdown`, which wakes a blocked read) and the export gives up with `out_of_time`: the push never waits behind it. The deadline is not hard: the thread looks at the stop signal between its phases, after every page and at every element of the redaction, but one `json.loads` or `json.dumps` of a large document holds the GIL and can overrun it by a second or two. For a large document the time is the effective cap, not the 64 MiB. What it will take is
bounded before it is built: **at most 64 MiB raw** summed over the pages (the worst transcript of the spike, 18.4 MB, took 70 MiB of memory, about four times its size; an edit-heavy session carries each file three times in the metadata of
its edits before the old ones are emptied) and the reading stops there; **at most 2 M elements**, counted from the commas of a page before it is parsed (an upper bound) and again by the walk of the parsed document (a page of 7.5 M tiny strings in 30 MB took
11 s and 680 MB); **at most 100 levels** of nesting (a transcript has about ten; the parser's own recursion limit is a `bad_answer`). Over any of them: `too_large`; so is a document the fetch had to cut at its limit. The session's own record (`GET /session/<id>`) is held to 1 MiB and counted the same way before it is parsed. A comma inside a string counts as an element too (a known limit): dense data can be `too_large` early (from about 2 MB for pure commas, about 16 MB at one comma per 8 bytes).

**What the redaction costs.** Besides the secrets of the turn, the redactor knows the shapes of secrets (`sk-` and 20 or more characters, `Bearer <token>`), so it also rewrites an ordinary path or word that looks like one. The snapshot is the
model's history, so a follow-up agent may see `[REDACTED]` where an old tool input held such a path or word. That is the price of never storing a secret; the turn itself is redacted the same way. The attachments of a compacted tool
part are kept as the engine wrote them: the spike did not show whether the engine sends them to the model, so they are not touched. A lost lease takes no
export. Best effort: any failure is one note in the turn's notes (`the session was not saved for a follow-up turn: <word>`, the words `engine_unreachable`, `bad_answer`, `out_of_time`,
`too_large`, `export_failed`, or `not handed to the host`) and changes nothing about the outcome, the push or the billing; the next turn then starts from a summary (the plan's fallback).
A turn that ended badly is exported too: the conversation is worth keeping.

**Getting it to the app** (`snapshot_wire.py`, `implementer/snapshot_pump.py`, `job_loop/snapshot_sender.py`, `job_loop/worker_api.py`). The job process holds neither the lease token nor the Worker's
credential, so, like the steps, the file leaves over one more descriptor the host hands it (`RUNNER_SNAPSHOT_FD`, a third socket pair), only when the app lists the feature
`implementer_snapshot` of `GET /api/runners/v1/version`: a header line (`S <size> <rawBytes> <sha256> <version>`) and the bytes. The host never reads a path from the process. It checks the digest
and uploads the file to `PUT /api/workers/v1/jobs/{id}/session` with the Worker's credential, **in parts of exactly 3 MiB** (the last one is what is left). **The decision on the
request size:** a function of the platform refuses a request body over 4.5 MB before the app is called, so a single request cannot carry the 8 MiB cap; 3 MiB leaves room, and the largest
snapshot is three parts. Every part carries the description of the whole file in its query (`part`, `parts`, `bytes`, `rawBytes`, `sha256`, `opencodeVersion`), so a part is judged on its own,
may arrive in any order and may arrive twice. The upload runs **beside the final push and before the result is delivered**: the process handle waits for it after the process has ended, for at most 50 s, and a
dead app costs the sender its own 40 s and nothing else (it is not in the sums of the end of the turn). A lost claim (409, 404, 401) stops it for good, a snapshot the app refuses (another 4xx) is not sent
again, anything else pauses 2 s and tries the same part again. The session therefore is never idle without its snapshot unless the app was away for the whole time.

**Keeping it** (`db/repositories/implementer-snapshots-repository.ts`, scoped; `20261105090000_create_implementer_session_snapshots`). `implementer_session_snapshots` has one row for each session
(its turn, the engine version, the sizes, the digest and the data) and `implementer_session_snapshot_parts` holds an upload until it is whole. The data is **base64 text**: the schema holds
text and integers only (`src/db/README.md`, "Portable schema conventions"), so the plan's `bytea` is not used, and 8 MiB gzipped is at most about 10.7 MB of text, which the database TOASTs out of line and uncompressed (`set storage external`: it is gzip already). When the last part is in, the
parts are put together in the transaction that also proves the claim (the job row is locked `FOR NO KEY UPDATE`, as for the steps), the size and the digest are checked, and the old snapshot is replaced; until then it stays
readable. A snapshot in one part is checked and swapped in without a row in the parts table, and the bytes of the parts are read back only by the part that completes the set. Parts that disagree, or do not make the announced file, are refused (`400`) and nothing of that upload is kept. The parts of an upload that never finished are deleted when the next upload of the session starts (or by the erasure of the workspace), not when the result is delivered: at most one unfinished upload waits for a session, which costs storage and nothing else. The call does not extend the lease,
answers `409 RUNNER_JOB_ENDED` once the job is over, `401` for a credential that is not the job's and `400` for a job that is not a turn of the Implementer.

**Who sees it.** The page never shows the snapshot. What it holds is what the agent read and said, with the secrets the runner knows taken out (the same ones as in the steps) and **tool outputs
included**, which the live view does not show: a committed `.env` the agent printed is in it. The one reader is the resume-session call of the Worker API (#840), with the credential of a job of the same session.

**Tests.** `runner/tests/unit/test_session_export.py` (the document, the redaction, the blanking, the cap and the budget), `test_snapshot_pump.py`, `test_snapshot_sender.py`, `test_process_snapshot_channel.py`,
`test_job_loop_snapshot.py` and the sum test of the end (`test_implementer_session_parts.py`); `tests/integration/test_implementer_job.py` (the export at a normal end and at a stop, a failing export, a host that does not read);
the contract tests of both sides (`app/src/runner-api/snapshot-contract.test.ts`, `runner/tests/contract/test_snapshot_contract.py`); the app's integration tests (`snapshot.integration.test.ts`, the migration, the scoped repository
in `scoping.test.ts` and `scoped-isolation.integration.test.ts`, the erasure); and one test of the lane (`tests/lane/test_implementer_turn.py`, E20): a real turn on a real Docker daemon, the file taken from the real engine through the
tunnel, and **`opencode import` of the pinned engine reading it** in a container with no network. Not measured on a real VM again: the budget at 4 vCPU and the upload from a VM under the narrowed network policy
(release 2's check).

## Follow-up turns: resume in the runner (#840)

A follow-up turn starts in a new VM. This is what the runner does with the conversation the earlier turns stored (PR 8 of #745). The app does not send a `resume` yet (the follow-up API
and form are PR 9), so none of this runs on the factory until then; the tests below run it.

**The order.** The job host fetches the job and, when `implementer.resume.snapshot` is true, **downloads the stored session before it starts the process**: the process holds neither the lease token nor the Worker's credential.
Then the workspace (`GitWorkspace`, the branches of #838), the setup script, the door and the agent's container as before; **`opencode import` runs in the agent's container before the engine starts**, with the engine's environment and
in the agent's repository (the import rewrites the project and the directory to the repository it runs in); the engine starts on the imported database and the turn continues in the session the file names.

**The call.** `GET /api/workers/v1/jobs/{id}/resume-session?part=n` (Worker API; the plan wrote `/api/runners/v1/...` with a lease token, but a Worker holds the per-job credential and the snapshot was put through the Worker API, so the read is there too).
It is the upload turned round. The credential proves the claim and does not extend the lease; the session is found **from the job** (`implementer_turns`), never from anything the caller sends, so a job reads the snapshot of its own session and of no other,
and a repository scoped to the job's workspace reads no other workspace's; only a snapshot of an **earlier** turn counts (the one a failed attempt of this very turn left is not an earlier conversation). A response body is held to 4.5 MB like a request
body, so the file is served in the parts the upload used (3 MiB, at most three): the body is the bytes of the part and the description of the whole file (`x-snapshot-parts`, `-bytes`, `-raw-bytes`, `-sha256`, `-opencode-version`)
is in the headers of every part, so a part is judged alone and may be fetched twice. `204` says the session has no snapshot; `409 RUNNER_JOB_ENDED`, `401` and `400` (a job that is not a turn of the Implementer, a part that is not 0 to 2 or is beyond the last) are as for the other Worker calls.
The client (`HttpWorkerApi.resume_session`) checks every part against the description, the parts against each other, the whole against its size and digest, and everything against a total of 60 s; any other answer is a failed download.

**The hand-over.** The host puts the gzip file into the directory the process starts in (`resume-session.gz`, owner-only, made new and never through a link) and names it in one variable, `RUNNER_RESUME_SESSION`: `file <size> <rawBytes> <sha256> <version>` or
`failed <reason>` (`resume_wire.py`). The process checks it all again with its own hash. `ResumeInput` is what the turn has of its conversation: the checked snapshot or the reason it has none.

**What is checked before the engine sees it** (`resume_session.py`): the size and the digest; the inflation is bounded (the announced raw size, at most the 64 MiB the export reads) and the stream must end exactly there with nothing after it; the document must be an
object with an `info` object and a `messages` list; the session id (`info.id`, read from the file, as the spike advised) must be letters, digits, `_` and `-` of at most 128 characters, because it goes into a URL path. The bytes written into the container
(`/etc/code-reviewer/resume.json`, 0600) are the inflated file as it is, not a re-serialisation.

**The fallback, `summary_only`, for every reason.** A fresh engine session, the preface, and the record of the earlier turns as data. The reason is a stable word of the result (`implementer.resume.reason`, `ImplementerResumeResult`) and a line of the log:

| Reason | When |
| --- | --- |
| `no_snapshot` | the app says there is none (`resume.snapshot` false, or `204`), or the job carried no `snapshot` (the release before) |
| `download_failed` | the download failed in any way, or the host could not hand the file over (an API without the call, no word from the host) |
| `snapshot_unreadable` | the file is not the one that was described: size, digest, gzip, bound, JSON, shape or session id |
| `import_failed` | `opencode import` failed or did not answer, there was too little time left for it, or the engine did not know the session afterwards (`GET /session/<id>` is checked) |
| `version_changed` | the same as `import_failed`, and the engine version that wrote the snapshot is not the one that read it (a bumped pin) |

Import is tried whatever the version is; only a failure of it, after the pin moved, is `version_changed`. None of these fails the turn. The import is boxed at 60 s and at what the ledger of the turn has left; it is paid from the work window, not from the grace kept for the end of
the turn (the sums of `test_implementer_session_parts.py` do not include it; measured 1.5 to 2.3 s, 306 to 385 MiB, the plan's box is about 25 times the largest). The imported session keeps its id: `implementer.opencode.sessionId` of the result is the first turn's.

**The preface** (`preface.py`) is the first part of the first user message, marked `synthetic`, in front of the person's instruction, which is the last part, sent as given. The prompt file (the system prompt) is the same on every turn, so the provider's cache can still serve a follow-up
that starts inside its lifetime (not promised). It is a fixed text. It says that this is a **new sandbox**; that processes, dev servers, databases, containers and images, shell state, files outside the repository and anything installed by hand are gone and only the git repository came back;
whether the earlier conversation is above (imported) or is restored from a record that follows (summary); that the environment's setup script ran again (when the turn has one); **the branches of the repository with their heads and the one that is checked out**; which branches
**moved** on GitHub since the last turn (someone pushed: the agent continues from the new tip) and which are **gone**; to run `git status` and `git branch`, check what runs and **start the dev tools again**; and the owner's decision (10): the agent is **warned, not stopped**, that the commits of earlier turns are
on GitHub and that rewriting them makes the push (always without force) reject the branch.

**Only checked values go into the preface.** A branch name is shown only if it matches letters, digits and `._/-` (one to 100 characters, starting with a letter or a digit); a tip only if it is 40 lower-case hex digits, shown as seven; the turn number is an integer. Any other name or tip
is left out and counted ("N more are here", "the branch that is checked out has a name that is not shown here"), up to 20 branches. A branch name that is a sentence cannot exist (a space is not a name), and a name made of letters is one token in backticks, so nothing the agent, a member or the repository wrote reaches the
preface as text. The record is another matter, and is kept out of it.

**The summary and the digest are data, never instructions.** In the fallback only, `previousSummary` (the last turn's summary, at most 8 KiB) and `digest` (the app's record of the earlier turns, at most 16 KiB; both counted in UTF-8 bytes by the runner) go into a **part of their own** (also `synthetic`), behind a fixed sentence
that says what they are, each inside a fence longer than any run of backticks in the text, so the text cannot close it; control characters other than tab and newline are taken out and line ends are made alike. An imported turn gets no record even if the app sent one.

**The result.** `implementer.resume` is `{"mode": "imported"}` or `{"mode": "summary_only", "reason": <word>}`, present on a follow-up turn that got as far as the engine's start (a turn that failed before it has none, and neither has a first turn). The app takes and keeps it with the rest of the
result (`runner-api/requests.ts`; closed, the reason is one of the five words, `reason` only with `summary_only`). The Runs page does not show it yet (it is in the stored result): that is a follow-up, with the form's hint (PR 9).

**A large history can cost the first call.** The model door reserves the cost of a call before it makes it. A follow-up that imported a history so long that the reservation of its first call alone is over the cost limit is refused **before any call reaches the provider** (measured: 18.4 MB at 5 USD, `cost_limit_reached`).
The turn ends with the code of any cost limit and with the detail "the cost limit of the turn was reached before the first model call: the imported conversation of the earlier turns alone costs more than the limit, because the first call reads all of it again", so the person can tell it from a turn that did work. The hint on the
form (PR 9) is where to say it before the turn starts.

**Tests.** `test_implementer_preface.py` (only checked values; hostile names, tips and records; the parts), `test_implementer_resume_session.py` (every way the file can be wrong, and the state), `test_implementer_resume_agent.py` (the import, its order, its time box, and each reason),
`test_resume_download.py` (the client against a server on loopback), `test_job_loop_resume.py` and `test_process_files.py` (the host and the file in the process's directory), `test_implementer_job.py` (the follow-up turn through the entry point: the parts of the first message, the result, the cost-limit
detail, the old fields only), `test_resume_contract.py`, `resume-session.integration.test.ts` (Postgres: the parts, 204, another session, another workspace, a stale credential, an ended job, the lease not extended, a part that does not exist), `resume-session-contract.test.ts`
and the lane (`tests/lane/test_implementer_turn.py`, E21 to E23): **two turns on a real Docker daemon with the strict scripted provider**. The second turn's first request carries the first turn's instruction, its tool call and its closing text; a corrupt file and a file the real `opencode import` refuses
(a required key of the first message taken out: the pinned engine answers `Missing key`/`Expected Message` and exits 1, checked on the pin) both fall back and finish the turn.

**Not done here.** The follow-up API, the digest and the form (PR 9); the Runs page's line for `resume` and the form's hint about the cost (PR 9, or a follow-up of this one); a real model replaying a history (not measured); the time of the download and the import on a VM under the narrowed network policy
(release 2's check: the app host has to be reachable for the new call as for the steps and the snapshot).

## The memory of the readers and the OS

Measured on `spike-` VMs (2 vCPU, 4 GB, 2026-11-03) with the reader exactly as production starts it (`sysbox-runc`, read-only root, `/tmp` tmpfs of 64 MB, `CapDrop ALL` + `DAC_OVERRIDE`, the Subpath of a named volume, `core.bigFileThreshold=1m`), over three repositories: **this repository with its history** (3,400 files, 28,000 objects, all its branches as local ones, 400 files changed); **3.7 GB of files** (thirty of 100 MB, one of 700 MB, all random, and 200,000 small files); **400,000 tiny files**. The commands are the ones of the end of a turn: `status` (the look at the tree), `add -A` and `commit` (the leftover commit, in the reader that writes), and the `git upload-pack` of the final fetch piped to a `git fetch` with `fsckObjects`.

| | status | `add -A` | `commit` | `upload-pack` |
|---|---|---|---|---|
| this repository, history | under 6 MB | under 10 MB | under 10 MB | 11 MB |
| 3.7 GB of files, 200,000 small | 0 | 39 MB | 26 MB | 46 MB |
| 400,000 tiny files | 1 MB | 78 MB | 49 MB | 67 MB |

(Anonymous memory, the part a limit kills for; the page cache of the file reads is on top of it and is given back under pressure, which is why the cgroup's peak always equals the limit on the big repositories. `Control`'s side of the fetch, `git fetch` with `fsckObjects` into the mirror, took 105 MB at most.) About 0.2 KB per file: the 256 MB limit holds about a million files in a tree.

**The default of git did not hold.** Without `core.bigFileThreshold` the final fetch of the 3.7 GB repository was **killed by the memory limit (`pack-objects died of signal 9`) at 128, 256 and 512 MB**: git reads every blob under its default threshold of 512 MB whole into memory, and the 100 MB files are just under it. With `-c core.bigFileThreshold=1m` among the reader's options (`READER_GIT_OPTIONS`; every blob over 1 MB is streamed and not delta-compressed, so the pack of large binaries is bigger) the same fetch ran at 128 MB. So **the limit stays 256 MB** (three times the measured need of the worst repository above, tmpfs included), and the option is what makes a repository of a few GB work.

**The time of a few GB.** Through the production path (`ReaderAccess` and `GitWorkspace`, the 256 MB reader, an 8 GiB reserve, no kill; 2 vCPU) a tree of 1.2 GB of random files and 50,000 small ones took 78 s to `commit_all`, and 3.0 GB took **200 s** to commit and **137 s** to push (hash, compress, `upload-pack`, `index-pack` with `fsckObjects`, about 20 MB/s each way), with `oom_kill 0` in both readers. `LEFTOVER_SECONDS` is 40 s and the push has 100 s, so what the system has to commit or push beyond about 600 MB (the commit) and 2 GB (the push) of incompressible new data does not fit: the leftover is reported "could not be committed" (the add is killed by the reset of the readers and the commits the agent made itself still arrive), a push that runs out of time says `out_of_time` for the branches it did not reach. Only new objects travel (the base is already in the mirror), so a few GB of fresh data in one turn is the limit, and it is a question of time and not of memory; it is not changed here.

**The OS.** A fresh VM with Docker and the Sysbox daemons up uses 338 to 351 MB. The heaviest scripted turn of the lane (the agent imports a 1.5 GB image into its own Docker and runs two containers in it) peaked at 1,238 MB used on the VM, of which the agent's container 743 MiB, the relay 17, the readers 4: what is left for the OS, the daemons and the test process that stands in for Control is 474 MB, below the 512 reserved. The reserve has to hold 351 MB idle and the two `/run` tmpfs of 64 MB (`/run/docker`, `/run/containerd`, memory, when full) = 479 MB, so it has 33 MB to spare at idle plus the difference above; this is the tightest line of the sum, and the one to raise first if a VM is ever found short.

## How the agent's container is tested

Three places, each with its own limits, and the last one only a VM with Sysbox can fill:

* **Unit and integration tests** (`runner/tests/unit`, `tests/integration`) run the session, the reader, the pipe and the git workspace against the fake Docker Engine of `fakes/docker_engine` and a scripted engine
  (`FakeAgent`, `FakePlace`): the flow of a turn, the budget sums, the leftover, the reasons of the push, what the daemon is asked for. `test_implementer_job.py` is the glue and not the proof that a turn works.
* **The lane** (`runner/tests/lane`, marker `lane`, CI job `implementer-lane`, `make test-lane`) runs **a whole turn on a real Docker daemon**: the real `agent` image with the pinned OpenCode in a container of its own, the real reader
  (git in a container, driven through the Engine API), the real door code (`run_door`, behind a relay container at the door's address on the model network), the production `ImplementerSession` and ledger, and a bare repository standing in for GitHub; the model
  is the strict scripted fake of `fakes/wire`. The journeys are the ones of the plan's table that still mean something with the agent in its own container: E01 (a commit arrives once, at the end), E03 and E04 (a dirty tree gets one more message,
  then the system commits it), E05 (the cost limit), E06 (git is free, every local branch arrives, a push has nowhere to go), E07 (a rewrite of a branch on the remote is `non_fast_forward`, a workflow file is `workflows_not_allowed`, the others arrive), E09 (the
  agent looks for a secret and finds none; none is on the volume or in the definition of a container), E12 (a text-only agent gave up), E15 (a hostile repository against the real reader), and E16 (an agent that fills its disk). E08, E10 and `test_implementer_git_users.py` belonged to the old topology (a proxy
  and an engine user in the Control container) and are gone. The seams are `AgentSeams.runtime`, `.entrypoint` and `.helper_image`, `SetupSeams` (the same, for the Setup container) and `ReaderSeams.runtime` and `.python`; production never sets them.
  **The environment's setup script** (#818, `test_implementer_environment.py`, L01 to L08): a script that leaves a file in the container and a file in the repository and changes a tracked one, and the agent that starts from the committed image and sees the first two and not the third (under Sysbox also an image the script made in its own Docker, without the internet, in the agent's Docker); a script that fails, one that runs out of time, one that fills the disk (Control's reserve is untouched) and a stop of the runner during the script, each ending before any model side exists; the Setup container with no secret in its environment, its pid 1, its mounts or its image; the host-side rules (a service on all addresses of the machine, over IPv4 and over IPv6 with the container's IPv6 switched on, is not reached, and a plain container on the default bridge reaches it); a turn without an environment, which makes no Setup container, network or image. What needs the internet or the platform's network (the script reaches the internet, the VM's control port and the platform's addresses are closed) is in "Measured on a real VM, round of #818".
  **The network door** (#745 step 7, `test_network_door.py`, L10 to L16): the real door container made by `start_network_door` from the Worker's image and an agent-image container on the model network
  with the environment the real agent gets. CI has no internet, so the names of the list resolve, through the door's `/etc/hosts`, to servers of ours (plain HTTP and a real TLS tunnel) on a second Docker network that the
  door treats as public (`CiNetwork`; `NETDOOR_TEST_PUBLIC_CIDR`, honoured only inside `10.213.99.0/24`, set by the lane's seam and never by `door_document`, which has no environment of its own). It proves that a listed name is reached over plain HTTP and
  over a TLS tunnel, a suffix entry covers the names below it and not itself, and that an unlisted name, an IP literal, a port other than 80 and 443, a name with a private address and a name with a private and a public one are each refused with the door's own word and the server sees nothing; that the agent cannot connect to the
  server directly (while a plain container on the server's network can, so the failure means something) and has no name server; that the door's own egress table lets ports 80 and 443 through and drops the private ranges and the model network; that the log of the door holds the counts and the bytes and
  nothing of a path or a body; and that the container is what the launcher describes (read back from the daemon: user, read-only root, no capability, no mount, no variable but the lane's own, the networks). The rule `off` has no door: a unit test holds that the session starts nothing and that the agent's container has no proxy variable
  (`test_implementer_network.py`).
  **CI has no Sysbox**, so the lane runs the containers under `runc`, with an entry point in place of the image's init that skips the inner `dockerd` (it says it is ready), on a bridge network with an exit. It therefore proves the flow of the turn, the reader, the reserve
  disk and the volume, the leftovers and the secrets; it does **not** prove the Sysbox wall (the `open_by_handle_at` refusal there is the missing capability of runc, not the user namespace), the id mapping of the volume, the
  isolated network or the agent's own Docker.
* **A VM with Sysbox** proves those, and the lane runs there too (`LANE_RUNTIME=sysbox-runc`): the same tests, the image's own init with the inner Docker, the production network (`--internal`, isolated gateway) and the reader under Sysbox. The golden snapshot's proof
  (`docs/golden-snapshot.md`) checks the Subpath volume, the id mapping and the network on every build. Results of the run on a `spike-` VM are under "Measured on real VMs" in "The agent's container".

## The attack test (step 6)

Step 6 of the plan attacks the sandbox from inside, on a real `spike-` VM, as an untrusted workload would, and keeps what it found as a check that
can be run again. The owner's rule decides what counts: inside its container the agent is free, so **a finding is something that reaches the key, the
bill, Control, the VM's services or the outside beyond the door**, not something the agent does to its own container.

**What runs, and where.**

* `runner/scripts/sandbox_boundary_check.py` is run as the Control container of the Implementer's profile on a VM with Sysbox (the flags the Launcher renders,
  the Docker socket, the work volume; the script and `boundary_probe.py` mounted read-only at `/driver`, as `model_door_check.py` is, and `contracts/environment-sizes.v1.json` read-only at `/contracts/environment-sizes.v1.json`). It starts what a turn
  starts with the production code (the model door with a made-up key, both readers, the agent's container, the Setup container with a script of its own) and
  prints one JSON line per check and a table. Each check names the **expected denial** and asserts it, and every denial has its control (the same attempt
  reaching what it may reach: the door, the internet from the Setup container, a listener on the default bridge, a link-local address that IPv6 really got).
  `--skip-abuse` leaves out the checks that stress the VM, `--offline` the one call that reaches the real provider. No secret is printed.
  The agent's memory has no default in the script (#827): `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB` when it is set, otherwise the figure of `agentMemoryMb` in
  `contracts/environment-sizes.v1.json` for the VM's vCPU count (`boundary_memory.py`, next to the script; found at `<repository>/contracts` from a checkout and at
  `/contracts` from `/driver`), and otherwise, or for a vCPU count the contract has no figure for, the script stops with a message that names the variable and the file.
* `runner/scripts/boundary_probe.py` is the program that runs **inside** the agent's container, the Setup container and a container of the agent's own Docker.
  It uses the standard library only, makes plain `connect()` calls with short timeouts to addresses of this VM, and prints facts; the expectations are the
  checker's.
* The lane (`runner/tests/lane/test_reader_hostile.py`, CI job `implementer-lane`) proves what a Docker daemon without Sysbox can: the readers' capabilities
  and the agent's container as the daemon made it, and the hostile repository of the next section. On a VM it runs under `sysbox-runc` as well.

**Result, 2026-11-03** (2 vCPU, 4 GB, kernel 6.18.56, Sysbox 0.7.1; snapshot built from the branch; the check on a VM restored from it and prepared the
way the Launcher prepares one): 73 of 73 checks hold after the fixes below; the 17 tests of the hostile-reader file pass under `sysbox-runc` and the whole lane under `runc`.
The 4 vCPU size (8.4 GB, 6,144 MB for the agent; since fix round 3 6,000) ran the same script on a `spike-` VM of its own: 73 of 73. Both ran the round of 2026-11-03 that follows the review of the first one.

**Third fix round, 2026-11-03** (the review of the memory guard; snapshot built from the branch, the final code of the check and of the runner bind-mounted over the Worker image's): the script grew by five checks (the OOM score in the agent and in the Setup
container and as the VM sees it, a legitimate heavy build, one row for the limit of the score) and the memory rows measure more than before. **78 of 78 hold at 2 vCPU (4 GB, 2,048 MB for the agent) and at 8 vCPU (16 GB, the largest size,
13,537 MB for the agent; it was not measured before).** The agent memory per size was then 2,048, 6,000, 9,768 and 13,537 MB (2, 4, 6 and 8 vCPU) because the guard's floor is taken off it; since the network door it is 1,952, 5,904, 9,672 and 13,441 MB (section "The agent's container", row "Memory"). Not run in this round: 4 and 6 vCPU.

| Area | What is proven |
|---|---|
| Containers | Agent: not privileged, no bind, device, host pid, ipc or user namespace, one mount (`/work/repo`), the model network only, `sysbox-runc`, memory and pids as sized, the limits of all containers leave the OS its room. Root maps to host uid 165536 (`0 165536 65536`), every process of the container has that uid on the VM, the agent sees only its own processes, and the capabilities it holds exist in its user namespace only (`clock_settime`, `init_module`, `kexec_load`, `bpf`, `swapoff` all `EPERM`). Readers: `sysbox-runc`, no network, read-only root, `DAC_OVERRIDE` only, `no-new-privileges`, one mount. A command the runner starts in a reader has `CapEff` and `CapBnd` `0x2`, no ambient or inheritable capability, `NoNewPrivs 1` (a plain exec holds all 41, which is why `setpriv` starts every command) |
| `/proc`, `/sys`, devices, cgroup | `/proc/kcore` and `/proc/sysrq-trigger` refuse, `/proc/keys` is empty, `/dev/mem`, `kmem` and `port` are absent, no block device or `kvm`, `mknod` of any of them is `EPERM`. `core_pattern`, `modprobe`, `panic_on_oom`, `randomize_va_space`, `uevent_helper` refuse a write. `kernel.panic`, `printk` and `sysrq` accept one (Sysbox emulates them) and **none of the three changes on the VM**. The agent cannot raise its own `memory.max`, `memory.swap.max` or `pids.max` (`EACCES`) |
| Volume | `/work` holds only `repo`: no reserve disk, no mirror, no `/var/lib/code-reviewer-work`. The agent may leave symlinks (to `/`, `..`, `/work`), a setuid file, a FIFO and a file with a uid it chooses; Control sees the first three as uid 0 and the mount is `nosuid,nodev`; a device node and a hard link out of the volume fail (`EPERM`, `EXDEV`) |
| Sockets | Every unix socket the agent or the Setup container can see that answers as a Docker daemon is its own inner daemon, never the VM's (compared by daemon id) |
| Network, agent | Of the door's address only its port connects (ports 1 to 1024 and 10100 to 10200 scanned). **Nothing else of ours answers**, not even with a reset: every address of the VM on every bridge with every port it listens on and the usual ones (the control port 23456 among them), the model gateway, Control and a listening neighbour on the default bridge, the door's other address, the Setup bridge and a listener of a running Setup container, the metadata address, the platform's `169.254.0.1`, private neighbours, and the internet. No outside DNS (a UDP query to `1.1.1.1` and `8.8.8.8` gets nothing, the embedded resolver answers `SERVFAIL`), no ping. After root adds a default route and host routes through the model gateway, and again after root has taken the inner `docker0` address away (see below), still only the door answers |
| IPv6 | `default.disable_ipv6 = 1`, no IPv6 address on `docker0`, any `br-*` bridge or veth, no forwarding. The agent starts with no IPv6 address on `eth0`; when root switches IPv6 on (control: `eth0` gets a link-local address) `ff02::1` finds no neighbour and no connect to a neighbour's port succeeds; two public IPv6 addresses are not reached |
| Containers of the agent's own Docker | From a container on the inner bridge, and from a `--privileged --network host --pid host -v /:/host` container: only the door answers, root is still the mapped uid, no VM socket, no host device, the sysctl writes still refuse |
| Door | The made-up key is in no environment, command line or readable file of the agent (its processes, `/etc`, `/opt`, the volume) and in no `docker inspect` or `top`. Another capability, another model, an absolute URL, `..`, another path, another method, `CONNECT` and a request for the metadata address are refused at the door and the ledger does not move (nothing reached the provider). A request with another `Host` header is answered by the pinned provider (`401` for the made-up key), never by the host it names. The door's only listening socket (besides Docker's own resolver on loopback) is its port |
| Setup container | The internet (several ports, names resolve, ping) and nothing of ours: the VM's addresses and ports (control port included), the agent's listener, the door, Control, a neighbour, the platform, private ranges; the agent cannot reach the Setup container or its gateway either. Same seal as the agent: no VM socket, mapped root, no host device, no key, no kernel parameter writable; with IPv6 on, no neighbour is found |
| Abuse | A memory hog dies at 1,984 MB of its 2,048 (`OOMKilled`; at 8 vCPU 13,440 of 13,537; at 4 vCPU 6,016 of 6,144 in the earlier round), the VM never goes below 1.7 GB available at 2 vCPU and 2.3 GB at 8 (looked at 50 times a second; the kernel's OOM killer ran once, in the agent's cgroup, and nowhere else). **A legitimate heavy build is not killed:** one process that holds 90% of the agent's limit (1,856 MiB at 2 vCPU, 12,192 MiB at 8) and works on it for 30 s ends with status 0, the memory guard does not fire, the VM keeps at least 2,031 MiB (2 vCPU, floor 512) and 3,973 MiB (8 vCPU, floor 1,331) of free memory and file cache, and the kernel kills nothing. A flood of threads stops at `pids.max` (16,367 and 16,365 started), and the container is killed in 0.5 s. A burn of sixteen processes leaves Control its share (a fixed piece of work took 0.15 s against 0.11 s idle; 0.12 against 0.105 at 4 vCPU). Floods of open objects: twelve (2 vCPU) or twenty-eight (4 vCPU) root processes open timers, epolls, eventfds, socket pairs and `/dev/null`, and in a second flood only timers and epolls, until something stops them; both are past the old table of 437,305 (2.0 and 4.7 million files open at once at 2 vCPU, 13.3 and 22.5 million at 8 vCPU), the agent is what stops (memory cgroup, or Control's guard), the table never fills, no call of Control fails and none takes more than 0.17 s, no kernel OOM kill happens outside the agent's cgroup, and the VM keeps at least **467 MiB at 2 vCPU and 1,141 MiB at 8 vCPU** of free memory and file cache, measured 50 times a second (the first round's "625 MiB" was the guard's own 2 Hz look at the number it acts on, and too high; details under finding 2). The agent fills the VM's disk (50 GB in 10 to 14 s): a command in a reader still runs, the reserve disk takes 256 MB, the agent is killed in 0.4 s, the door and readers stay up and the disk is free again when the container is removed. During all of them one call to the daemon and one command in a reader every half second never failed |

A note on the one address that looked like a finding: the agent's own Docker puts a bridge on `172.17.0.1/16`, which is the VM's `docker0` address, so a connect to
it from the agent or from the Setup container ends in the container's own kernel (`refused`) and says nothing about the VM. The checks leave that address out
and then attack it for real: root flushes the inner bridge, adds a default route through the model gateway and tries the VM's gateway, Control and a neighbour on
the default bridge. Nothing answers.

**The hostile repository (lane).** The agent controls every byte of its repository and the end of the turn reads it, so the lane plants what git reads and
checks the end: `core.worktree` pointed at `/` (the leftover commit fails and nothing of the reader's file system is in what arrived), symlinks to `/etc/passwd`,
`/`, `..` and to a file as `.gitignore` and `.gitattributes` (committed as links, never followed), alternates to `/proc` and `/etc`, symbolic and symlinked
refs, garbage in `packed-refs` and `HEAD`, a linked worktree and a `commondir` that name files of the reader, branch names that would be options or commands
(`--upload-pack=...`, `-fexec`, `+force`, a name with a space, a tab or a line end, `x;touch`, `$(touch)`: none is run, the unusual legal ones arrive as the
plain argument they are), a file of one terabyte (the leftover commit is a named failure inside its time, the commit the agent made arrives), and a FIFO where git
reads its configuration or `HEAD`. None of them leaks a file of the reader, none leaves a process in a reader after the readers were made quiet, and the whole
end of the turn takes at most about 31 s for the two FIFOs and 13 s for the terabyte file (each of these tests has a time limit of 120 s, so that a regression fails and does not hang the job).
What the test asserts per layout was measured: alternates to `/proc` and `/etc`, symlinked refs and a `HEAD` that points nowhere still list the branches and push the commit; garbage in `packed-refs`, a `commondir` and a FIFO as configuration or as `HEAD` end in the one named outcome
`unreadable` (nothing listed, nothing pushed, nothing arrives), after 1 to 2 s and, for the FIFOs, after the 20 s of the listing.
The branch names: the legal odd ones (`x;touch${IFS}...`, `$(touch${IFS}...)`) arrive under exactly their own name, every other one is dropped, and no command runs.

**Findings, and what was done.**

1. **A silent command held the runner for ever (fixed).** `run_exec` ends a command that has run out of time by closing its connection from a timer thread. On
   Linux, `close()` does not wake a thread that is already waiting in `recv()`, so the time limit did not hold for a command that prints nothing and does not end.
   A `.git/config` that is a FIFO, a clean filter that sleeps, or a file of a terabyte made the leftover commit wait for ever (measured: 8 minutes and counting
   inside a call that had 8 seconds); the final push never came, and the work was lost with the VM. The agent could do this on purpose and could do it by accident.
   `AttachedStreams.close()` now shuts the connection down before it closes it (`tests/unit/test_exec_run.py`, red before the fix; the lane's FIFO and terabyte
   tests). Nothing else of the design changes: the budget of the end of the turn counts each step at its ceiling, and that is now true.
2. **The agent could fill the VM's table of open files, and some of its objects cost memory its cgroup does not count (fixed in three parts; `sysbox-prepare.sh` takes effect with the next snapshot).**
   *The table.* `fs.file-max` was 437,305 on a 4 GB VM. Three root processes opened 436,815 files in a few seconds with a tenth of the agent's memory limit, and a call
   of Control failed (a process without `CAP_SYS_ADMIN` of the VM gets `ENFILE` when the table is full, which is Control, the door and the git of every reader). `sysbox-prepare.sh`
   sets `fs.file-max` to 2,147,483,647, so that the memory limit of the agent's container, which counts the files, is what stops it.
   *What an object costs* (kernel 6.18.56, measured as root on the VM, 300,000 objects of a kind, bytes per object):

   | Kind | In the container's cgroup | Outside it |
   |---|---|---|
   | `/dev/null` | 255 | 4 |
   | timerfd, epoll | 455 | 263 |
   | eventfd | 455 | 71 |
   | pipe (two files) | 2,566 | 30 |
   | socket pair (two files) | 4,910 | 119 |

   So the table is not full before the cgroup's limit is (8.4 million `/dev/null` files at 2,048 MB, 25 million at 6,144 MB), but a flood of timers or epolls leaves 260 bytes each outside
   the cgroup. Measured with the fix of the table alone and nothing else (28 processes at 4 vCPU, 12 at 2 vCPU): **at 2 vCPU** the leaky flood ends at the cgroup's limit with 4.9 million
   files and 612 MiB of free memory and file cache left, which is enough; **at 4 vCPU** it took 1 GB of memory a second and **the VM stopped within 12 seconds** (the platform lists it
   as `stopped`, the `exec` connection ends with an EOF). With only the OOM score of the agent raised to 1,000 (below) the VM stood still for 50 seconds and then the kernel's OOM killer
   ran (a global one, with 7.8 GB of slab) and chose the agent's inner `dockerd`, no process of Control. Nothing was measured of this at 6 and 8 vCPU.
   *The fix.* (1) The agent's and the Setup container's containers get `OomScoreAdj` 1,000 (`AGENT_OOM_SCORE_ADJ`): whatever the kernel's OOM killer has to choose, it chooses there first, and
   root of the container can only lower it as far as -999 (measured in the third round; see below). (2) `vm_memory.MemoryGuard` in Control looks ten times a second at the memory the VM has left, **free memory plus the page cache of files, not
   `MemAvailable`** (the kernel counts the `struct file` of every open file as reclaimable slab: `MemAvailable` said 2.2 GB when the OOM killer ran), and kills the agent's container,
   or the Setup container, when less than 512 MiB or 8% of the VM's memory is left, and **again every half second while the memory stays low and the container has not ended** (a kill that failed is logged and tried again; the
   guard of the Setup container watches until the container has ended (a process the script left behind runs until then) and is closed just before the room check and `docker commit`, which need memory of their own (#827: it was closed right after the script, so a background process could flood unguarded while the end script ran; a kill during the end ends the setup `not_saved` with the reason word `vm_memory`, and nothing is committed), and says once in the log when `/proc/meminfo` cannot be read for 5 s). The turn then ends as a turn whose container died: the
   detail starts with the reason word `vm_memory:` ("vm_memory: the agent's container ended during the turn: the container was killed because the VM was running out of memory"; `AgentEnd.vm_memory`, and for the Setup container
   the same word), and the billing class is the one of any container that died. The guard goes on looking after it has fired and keeps the least value it saw (`lowest_left`).
   Measured with both, the same floods (first round, 4 vCPU rows: the guard's own 10 Hz look at its metric, which misses the true minimum):

   | | Flood | Files open at once | Stopped by | Least free memory and file cache (50 Hz) | Least `MemAvailable` | Kernel OOM kills (outside the agent) | Control's worst call | Failures |
   |---|---|---|---|---|---|---|---|---|
   | 2 vCPU | mixed | 2.02 million | memory cgroup | 1,628 MiB | 2,068 MiB | 1 (0) | 0.10 s | 0 |
   | 2 vCPU | timers and epolls, score lowered to -999 | 4.74 million | Control's guard | **467 MiB** (floor 512; the guard saw 501) | 1,103 MiB | 0 (0) | 0.13 s | 0 |
   | 8 vCPU | mixed | 13.27 million | Control's guard | 1,193 MiB (floor 1,331; the guard saw 1,257) | 6,329 MiB | 0 (0) | 0.14 s | 0 |
   | 8 vCPU | timers and epolls, score lowered to -999 | 22.54 million | Control's guard | **1,141 MiB** (floor 1,331; the guard saw 1,167) | 4,863 MiB | 0 (0) | 0.11 s | 0 |
   | 4 vCPU (first round) | mixed | 5.68 million | memory cgroup | 1,655 MiB | | | 0.13 s | 0 |
   | 4 vCPU (first round) | timers and epolls | 11.14 million | Control's guard | 649 MiB (floor 672) | | | 0.10 s | 0 |

   The consumer is about 1 GB a second, so the VM goes 190 MiB (8 vCPU) or 45 MiB (2 vCPU) below the floor before the kill lands; the floor is what pays for that, and the least memory the VM had stayed far above zero. `MemAvailable` (the
   kernel's own figure, read in the same loop) stayed above 1 GB in all of them, which shows why the guard does not use it. "Kernel OOM kills" is the difference of `oom_kill` in `/proc/vmstat` between the start and the end of the
   check; "outside the agent" is the same counter in every cgroup of the VM's tree (read through a helper container with the host's cgroup namespace) except the agent's, the Setup container's and their parents, which must not rise.
   The memory hog and the mixed 2 vCPU flood are stopped by the agent's own cgroup (one OOM kill each, in its cgroup); the guard did not fire in the heavy build.
   Door and readers stayed up and a command in a reader worked afterwards in all of them.
   *Why not a bounded table.* Any bound the agent can reach is `ENFILE` for Control, and nothing would stop the agent (a root process opens a million files in seconds, 16,384 processes are
   allowed). A bound it cannot reach before its cgroup limit has to exceed 8.4 million files at 2 vCPU and 25 million at 4 vCPU, where the leaky objects leave 1.2 GB and 3.7 GB outside
   the cgroup: no value does both on a VM whose agent has 75% of the memory. So the table stays big, and the memory the cgroup cannot count is watched by Control.
   *The OOM score, as measured in the third round.* An exec of the daemon in the agent's container (which is how the engine is started) starts at 1,000, like its children and the container's init; seen from the VM, every process of the container's
   cgroup (init, the inner `dockerd`, the engine stand-in started the way `start_engine` does, a plain exec) is 1,000, and so are those of the Setup container's script. **But root of the container can lower the score of its own processes**: writing 999, 500, 0,
   -1, -500 and -999 to `/proc/self/oom_score_adj` succeeds (the VM sees the new value) and only -1,000 is refused (`EACCES`); `CapEff` is full in the container's user namespace, and a plain `runc` container without the capability to override resource limits refuses every lowering.
   The first round's sentence "root of a user namespace cannot lower it" was an assumption and is wrong under Sysbox 0.7.1. So the score is a preference that helps against a process that does not try to avoid it, and it is not what stops the agent:
   the leaky floods of the check run with the score lowered to -999 by the flood itself, and Control's guard stopped them without a kernel OOM kill. The check pins the limit (a row that passes for "lowers to -999 and no further" or for "refuses every lowering") so
   that a Sysbox that closes it, or one that opens -1,000, is noticed. A way to forbid the write (an AppArmor profile for the agent's container, or a Sysbox that honours the capability drop) was not tried; it is a follow-up, and nothing in the owner's rule needs it while the guard holds.
   **Control's own score (#827).** Because root of the agent's container can lower its processes to -999, and the kernel compares scores, a late guard would have left Control (score 0) a candidate beside an agent at -999. The Implementer's Control container is therefore started with `--oom-score-adj -1000` (`IMPLEMENTER_OOM_SCORE_ADJ` in `dispatcher/src/launchers/container.ts`, rendered only for the profile that has a work volume and the Docker socket; a review's flags are unchanged, and the golden file of `docker run` holds that). The agent can reach -999 but not -1000, so Control is never the kernel's choice while the agent's container is there.
   **-1000 means exempt, not "the lowest".** The kernel does not rank a process with that score last, it takes it out of the choice (`oom_badness` returns the lowest possible value for it). That holds inside Control's own `--memory` limit (768 MiB) too: a Control that grew without a bound (a leak, a hostile line of output it buffers) would not die at its limit with the container's exit code, as it did before this score, and the turn would not end `worker_exited` (free) at once: it would stall at the limit. So Control bounds itself.
   *The watch (`implementer/control_memory.py`, `ControlMemoryWatch`).* The job process of the Implementer (the Control that runs the turn) reads its container's memory cgroup, `memory.stat` and `memory.max`, five times a second, and when what the container holds reaches **90% of the limit on three looks in a row** (0.6 s; one spike that is given back is not a runaway) it ends the turn: the job process prints the result line and exits. The line is `runner_error` with the detail "control_memory: Control held N of M MiB of the memory of its container, so the turn was ended" (`runner._end_for_control_memory`; free, like the old `worker_exited`), or `agent_gave_up` when the model was billed (the class of any unexpected end of a turn that cost money); nothing is pushed and the step records not yet sent are lost too, as at the timeout's watchdog. **It stops no container**: the Implementer registers no engine with `shutdown_engines`, so the agent's container, the doors and the readers run on until the VM is torn down, and the model door's cost cap holds meanwhile. A trip that comes after the turn finished (the watch is closed) prints nothing, checked under the lock of the result line. What the container holds is only what the kernel cannot give back, `anon + shmem + kernel + sock` of `memory.stat`: the file cache, active as well as inactive, is not counted (the `git fetch --fsckObjects` of a big repository fills the cgroup with it up to the limit, see "The memory of the readers and the OS"). Only a `memory.stat` that lacks one of those keys falls back to `memory.current` without `inactive_file`, which still counts the active cache (the log says so once); the three looks are what keeps such a cache from ending a healthy, billed turn. A limit of `max` means nothing is watched (the log says "no limit" once); files that cannot be read leave the watch blind, and the log says so once after 10 s. It covers cgroup v2, which the golden snapshot's VM uses; it is tested with fake cgroup files (`test_control_memory.py`, `test_failed_run_usage.py`), not on a VM. *Not measured (#827):* that Docker accepts `--oom-score-adj -1000` under the VM's setup (the flag is the documented one and needs no capability from a rootful daemon, but no run on a `spike-` VM has shown it), and whether a Control-like container at -1000 that hits its `--memory` limit dies or hangs (the reasoning above is the kernel's rule, not an observation); the watch exists so that the answer does not matter for a runaway Control, and the check stays a follow-up for a `spike-` VM. *Remaining risk:* the 10% below the line and the 0.6 s of three looks are what a single allocation or a very fast leak can still cross; then Control is stuck at the limit as described above, and the turn ends by the lease (two minutes) and the timeout, not at once. The watch sees only the container's own cgroup: a global OOM of the VM, with the agent's container already gone (ended by its limit or by `MemoryGuard`) and the doors out of the way, has nothing to pick but `dockerd` or another host process, and Control's turn ends with the daemon (`worker_exited`).
   *Not measured (#862):* the guard in the Setup container under a real flood (unit test only), 4 and 6 vCPU in the third round, a consumer faster than 1 GB a second (the floor would have to go up), the kernel 6.8 numbers of the
   review (only 6.18 was measured). `docker/sandbox/sysbox-prepare.sh` is an input of the golden snapshot, so the next release builds a new one; the guard and the OOM score are in
   the Worker image.
3. **The door's image has git and a shell (not changed).** The plan's table says "no git, no shell". The image is the Worker image, which has both (a shell, git 2.53).
   The running door is one Python process with one listening port, its container is non-root, read-only, without capabilities and without a network but the
   provider, and nothing the agent can reach starts a process in it, so this opens nothing today. A door image of its own (the Python runtime and nothing else) would
   make the table true; it is a size and build question for the owner (#861).
4. **`/dev/net/tun` is not in the agent's container (information).** The boot step makes it world-writable on the VM, but Sysbox does not put it into the container, so a
   task that needs a tunnel device will not find one. Not a security matter.
5. **The agent can make files with any uid below 65,536 in the volume (information).** The volume is mounted with the user ids shifted, so a file the agent's root makes is
   the VM's root's, and a `chown` to another uid shows as that uid. The mount is `nosuid,nodev` and Control never opens a path in the volume, so nothing runs.
6. **Not a finding, a reading aid.** A `core.worktree` of `/` fails the leftover commit (the agent's own last change is not committed, with a named note);
   `kernel.panic`, `printk` and `sysrq` take a write inside the container and stay as they are on the VM (Sysbox's emulation).

**What it does not prove.** A flaw of the shared kernel or of Sysbox itself (its `sysbox-fs`, which answers for `/proc` and `/sys`, is a large surface), a flaw of
the Docker daemon, or a side channel is not looked for: no VM stands around the container, which the owner accepts for internal use ("What is accepted"). The check runs
the sizes of 2 and 4 vCPU; the memory the agent gets at 6 and 8 vCPU follows the same sum (`contracts/environment-sizes.v1.json`, held by tests). It tests the
network as the platform leaves it today (the VM's Vercel network policy is open until step 7).

## The disk

The agent is root in a container with its own Docker and no rule inside it, so it can fill the VM's disk: with the repository, with the
layer of its container, with the images and volumes of its own Docker. The first design put Control's mirror (the bare repository the final push
fetches the agent's branches into) on the same work volume, so a full disk meant a failed fetch and lost work.

**What the VM has.** One XFS file system of 64 GB (`/dev/vdb`, mounted `noatime`, **no quotas**), the same at 1, 2 and 8 vCPU (measured); 61 GB are free
on a fresh VM, 58 GB on one restored from the golden snapshot (6.8 GB are the two images and the base). `/run` and `/tmp` are directories of
it, not memory. Because it has no quota and no project quota can be switched on for a mounted root, the agent's writes cannot be limited
where they go (the repository, the layer of its container, the inner Docker's data); what can be done is to keep something it cannot fill.

**What Control gets: a reserve disk.** For every job the Launcher makes a file of **8 GiB** (an eighth of the disk; `fallocate`, so the blocks are
taken at once and stay taken), puts an ext4 file system on it, mounts it over a loop device on `reserve` below the work volume, and makes the volume with a recursive bind
(`work-volume-reserve-*`, `docs/dispatcher.md`). Control's mirror is `/work/reserve/mirror.git`. The agent's container mounts the Subpath
`repo` of the volume and sees none of it. Whatever the agent writes to the VM's disk, the blocks of the mirror are already taken (measured: with the root file system at 100% a 2 GiB write
to the reserve succeeded at 374 MB/s). The cost is 8 of the 58 GB the agent could have had; the agent keeps about 50 GB for images and builds.

**What Control also needs on a full disk: a command in a container.** The first run on a real VM with the disk full by the agent's doing ended with nothing pushed, because
every `docker exec` failed: the pipes of an exec are files in `/run/docker/containerd`, and `runc exec` writes `/tmp/runc-process...`, both on the full disk
("failed to open stdout fifo ... no space left on device", "OCI runtime exec failed: open /tmp/runc-process...: no space left on device"). Control looks at the repository and reaches the
agent's engine only through exec. So on the Implementer's VM the launcher puts `/run/docker` and `/run/containerd` on memory (64 MB each) before the daemon starts, and starts the
daemon with `TMPDIR=/run/containerd` (`docs/dispatcher.md`); the readers are made before the agent runs, so that no container has to be created later.
`docker kill`, `docker inspect` and `wait` need nothing from the disk (measured: the kill took 0.4 to 0.5 s with 0 bytes free).

**Before the fetch: the room is asked for.** Before any branch is taken over the runner asks the mirror's file system for its free bytes and inodes
(`MIN_FREE_BYTES` 256 MiB, `MIN_FREE_INODES` 10,000). Too little: no fetch is started, and every branch is reported `rejected (out_of_space)`; a fetch that fails with the room gone says the same instead
of `unreadable`. The summary says "the disk of the workspace had no room left", and, whenever the VM's disk has less than 1 GiB left at the end, "the VM's disk had N MB left at the end". The reserve is full only
when the agent *committed* more than 8 GiB of objects. What the agent wrote when the disk was full is the agent's: the leftover commit of its working tree needs room in its repository and is
reported "uncommitted changes could not be committed" when there is none; what it committed before arrives.

**Proven on a real VM (2026-11-03).** The agent filled the layer of its container (`dd` to 100%, 648 KB free on the 64 GB disk) and then its repository; it had committed one file before.
The OpenCode in its container could not go on (its own disk was full), the turn ended `agent_gave_up` (charged: the model was used), the container was killed in 0.5 s, the
commit was fetched into the mirror, **pushed, and the branch on the stand-in for GitHub is the commit**; the notes say that the leftover could not be committed and that the VM's disk had 0 MB left. The same run
without the memory directories ended with "the local branches of the agent's repository could not be read" and nothing pushed. In CI (without Sysbox) the lane gives the work volume a 700 MB file system of
its own as the stand-in for the VM's disk and fills that (`runner/tests/lane/test_disk.py`).

**What is not bounded.** Inodes: an agent that makes millions of files exhausts the inodes of the XFS (it allocates them dynamically) as it exhausts the blocks; the reserve has its own. The
agent can still fill the disk, and a build that needs more room fails: it is not a question of money, key or exit. And the leftover of a full disk is the agent's.

## Network in the agent phase

The agent has the model door and nothing else, and the network door when its environment's rule is `list` or `open` (the next
section). The agent's container is on an internal Docker network with no exit
(`gateway_mode_ipv4=isolated`), so there is no route to the internet, to the VM or its services, or to a neighbour, and no name
server; the containers it starts through its own Docker are behind it and reach the door only. The firewall rules of the Control
container that used to confine the agent's user, and the allowlist proxy of package registries (`registry.npmjs.org`,
`pypi.org`, `index.crates.io` and the others), are gone.

**IPv6 link-local, a hole found and closed in #818 (2026-11-03).** The probes of step 4 were IPv4. Root in the agent's container can switch IPv6 on in
its own namespace (Docker leaves it off there, a sysctl of that namespace), ping `ff02::1`, find the model bridge's link-local address and
**connect to port 23456 of the VM over it**: the VM's control service listens on `*`, the isolated gateway mode and the `nft` table of the door are
IPv4, and the VM's kernel has no `ip6` netfilter to put a rule in. Measured on a `spike-` VM: `OPEN fe80::...%eth0 23456` from the agent-style
container on an `internal`, `isolated` network, `ConnectionRefused` for ports 22 and 80 (so the address was a real host). The fix is the
same as for the Setup network (`host_rules.close_bridge_ipv6`, called by `AgentContainer.create` before the container is made): no IPv6 address
on the VM's side of the bridge, so there is no host to find on that segment; measured after it, the same probe times out and a container that
joins later finds no neighbour. The VM does not forward IPv6 (`net.ipv6.conf.all.forwarding = 0`) and the agent has no IPv6 route out.
Step 6 repeated this class of probe, from the agent and from the Setup container, against every address of the VM (section "The attack test (step 6)").

**IPv6, switched off in the VM and a second wall (#818, 2026-11-03).** Defensive configuration on top of the missing bridge address, with nothing probed
for it. (1) The Launcher's step `ipv6-off` (`IPV6_OFF_COMMANDS`, the Implementer's VM only, before `vm-prepare.sh` starts the daemon) writes 1 to
`net.ipv6.conf.default.disable_ipv6` and reads it back (a kernel with no such file has no IPv6, which is the same as off); a launch whose VM cannot do that ends with the retryable
`docker_not_ready`. `default` is what a bridge the daemon makes afterwards (and the interface of every container on it) takes, so those have no IPv6 at all. `all`, `lo` and `eth0`
are not touched: the platform reaches the VM through them, and they add nothing for the bridges of the containers. (2) For a kernel that has the `inet` family, Control installs one
more table in the host's namespace beside each `ip` one (`host_rules.close_bridge_inet`, tables `implementer_ipv6_setup` and
`implementer_ipv6_agent`, hooked before Docker's rules at priority -10, only drops): no IPv6 packet from the Setup bridge or the model bridge to the VM
itself (`input`) and none through the VM to a private range (`forward`: `::`, `::1`, `::ffff:0:0/96`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`, `ff00::/8`).
The platform's kernel has no `inet` family (measured, above), so there the table is tried (the helper tells that case from a refusal by its exit status, and the status comes from probes, not from `nft`'s wording (#827): when the table could not be installed, an empty `inet` table is tried (made: the family is there, so the table was refused, status 1), then an empty `ip` table (made: `nft` works but there is no `inet` family, status 3), and when neither can be made `nft` itself fails, status 1; a test runs the script for real against a stand-in `nft` of both kernels under several wordings), a log line says the kernel has no family, and the turn goes on. On a kernel that has the family and refused the table, the turn goes on as well and the report has a note (`inet_failure_note`). The
sysctls and the missing address are what closes IPv6 on a kernel without the table. A Setup or an agent never fails for the table. The lane (L07) reads the state back where
the kernel supports it: IPv6 off on the container's `eth0` (which takes `default`) before the probe switches it on, no IPv6 address on the bridge, and the `inet` table with
its two drops.

**Without a network door (the rule `off`, the default), `npm install`, `pnpm install`, `pip install`, `apt-get`, `cargo`, `go get` and `docker pull`
all need a registry and fail** ("lookup registry-1.docker.io ... server misbehaving", measured). Whatever such a task needs must already
be in the image: the toolchain of the agent image is there, and an environment's setup script (section "The environment's setup script":
full internet, no secrets, its result becomes the agent image with `docker commit`) installs the rest. A task without an environment, or with a
repository whose dependencies the script does not install, can read and edit but not build or test. **Since step 7 an environment can give the agent a
network back**, on its owner's terms, through the network door (next section).

There is no Go module proxy and there never was one.

## The network door (step 7)

An environment has a **network** setting (#745, step 7 of `plans/implementer-sandbox.md`), chosen by its owner on the environments page. It
decides what the agent can reach once the setup script is done:

| Setting | What the agent has | Door |
| --- | --- | --- |
| `off` (the default; every existing environment, and a task without an environment) | No network at all, as in steps 4 to 6 | None: no container is started |
| `list` | The host names the owner wrote, and only those. Each is exact (`registry.npmjs.org`) or a suffix (`*.pythonhosted.org`: every name below it, not `pythonhosted.org` itself, so list both if both are needed). At most 100; each at least two labels (`*.com` is not a rule), no IP address, no port, no path. Stored in one form: lower case, punycode, no trailing dot | Yes |
| `open` | Any public name | Yes |

**The rule is the one closed list of the sandbox, because the door is an exit.** The owner's rule: inside the sandbox the agent is free, and
only money, the key and exits are guarded; the list of hosts is the owner's decision about an exit and nothing else in the engine is listed. Only a member who may
manage environments (Owners and Admins, `manage_implementer_environments`) can change the setting. The rule is copied into the turn when a task starts, like the size
and the script (`implementer_turns.environment_network_*`, no foreign key), so editing or deleting the environment later touches no task. The migration
(`20261103100000_add_environment_network`) is expand only: two columns with a constant default on the environments (`network_mode` `off`, `network_hosts` empty) and two
nullable ones on the turns; every environment that existed reads `off`, every turn that existed reads null, which reads `off`. The API takes `network: { mode, hosts }` in the body of `POST` and `PUT`
(a body without it is `off`: a `PUT` replaces the whole environment); a bad value is `ENVIRONMENT_REQUEST_INVALID` with an issue on the field `network` (the mode or the shape) or `networkHosts` (`invalid`: an entry that is
not a host name or a suffix; `required`: a list with no host; `too_long`: more than 100), never with the value in it. The form shows the setting as three radio buttons and a field for the hosts, one on each line; the picker of the task form says in its list which environments give the agent a network;
the Runs page shows the rule the task ran with and what the door reported.

**What the door is** (`implementer/netdoor/`, started by `implementer/netdoor_launcher.py`): an HTTP and HTTPS **forward proxy in a container of its own**, built like the model
door. The Worker's image with another entry point (`python -m code_reviewer_runner.implementer.netdoor`), non-root, read-only root file system, every capability dropped, `no-new-privileges`, 96 MB of
memory without swap, 400 processes, a 16 MB `noexec` `/tmp`, no mount, no published port, IPv6 off, an `OomScoreAdj` of -500 (the VM's OOM killer takes the agent, whose score is 1,000, first), and **no environment variable and no secret of any kind**: it holds the owner's rule and nothing else.
It sits on the model network at **`10.213.77.3:3128`** and on the VM's default bridge (its only way out). Control starts it over the Docker Engine API right after the model door (whose network it joins), installs its egress rules with the same
one-shot `NET_ADMIN` container, and only then writes the rule to its stdin. The door answers on stdout (`ready`, the log of its connections once a second when it changed, a last one when it stops) and **never calls Control**. A door that cannot be started ends the turn `setup_failed`, free, before the agent exists (`network_door_unavailable` in the log): an environment that asked for a network does not run without one. A door that dies during the turn leaves the agent with no network and a note in the report; the turn goes on, because nothing it held was a key.

**What it decides, per request, by the host name of the request:**

* `CONNECT host:port` is an **HTTPS tunnel**; the door never looks inside (no certificate of ours, no interception). Plain HTTP (`METHOD http://host[:port]/path`) is forwarded to the port the URL names, 80 when it names none, if that port is one of the two the door allows (any other port is `port_not_allowed`), with the request line rewritten to its origin form, `Host` set from the same authority the decision was made on, `Connection: close` forced, and the rest of the traffic relayed unread, so one connection is one destination. Anything else (a request in origin form, `https://` as a URL, a user name in the authority, a malformed line, a method that is not an HTTP token) is a 400.
* The order, the same in every mode: an **IP literal** is refused (`ip_literal`: IPv4 in any spelling a resolver reads, `127.1`, `0x7f.1`, `2130706433`, IPv6 in brackets); a name that is no DNS name is refused (`bad_request`); a **port other than 443 and 80** is refused (`port_not_allowed`); the rule must list the name (`list`; `open` lists everything; `not_listed`); only now is the name looked up, so **a name the rule does not list is never sent to a resolver**; **every IPv4 address it has must be public** (`private_address`: private, loopback, link-local, the metadata address, shared (CGNAT), special-purpose, documentation, multicast and reserved ranges, `netdoor/addresses.py`), and a name with one public and one private address is refused as a whole; the door then **connects to an address it checked**, never to the name again, so a resolver that answers differently the second time (DNS rebinding) changes nothing. IPv6 is not looked up: the door has none.
* A refusal is a `403` with `X-Network-Door: <word>` and one plain sentence in the body, so that a failed `npm install` says why. A connection that cannot be made is a `502` (`upstream_failed`); more than 128 connections at once get a `503`.
* Case, a trailing dot and Unicode do not get round the list: the name is brought to lower case ASCII (punycode) before it is compared, the entries are in the same form.

**The door's own egress** is closed in its network namespace, as the model door's is, by a one-shot container with `NET_ADMIN` and nothing else before it is told anything (`netdoor_launcher.egress_rules`, table `netdoor_egress`): loopback and replies are open; a new connection into the model network is dropped (the door answers the agent and opens none towards it); DNS (port 53) is open; every private, link-local, shared and special range is dropped (the VM, its neighbours, other containers, the platform's services); **ports 80 and 443 are open to the rest of the internet and nothing else is**. A door whose rules did not go in is taken away and never told the rule.

**What the agent has** (`agent_container.proxy_environment`): `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` (all `http://10.213.77.3:3128`), `NO_PROXY` and `no_proxy` (`localhost`, `127.0.0.1`, `::1`, the model door and the network door itself) and `NODE_USE_ENV_PROXY=1`, as **environment variables of the agent's container** (none for `off`: the container has no variable then). The image's init starts the inner `dockerd` from the container's environment, so **`docker pull` goes through the door**; every exec of the container, the engine's tools and the agent's own shells inherit them, and `npm`, `pnpm`, `pip`, `uv`, `apt`, `cargo`, `go` and `git` read the proxy from those variables, so no configuration file is written in the agent's home. The agent has no name server: the door resolves. **Containers the agent starts through its own Docker are not given the variables** (a service name between two of them would be sent to the door); they reach the door by its address, `http://10.213.77.3:3128` (a name does not resolve there), when a command in them needs the network, for example `docker run -e HTTPS_PROXY=http://10.213.77.3:3128 ...` or `docker build --build-arg HTTPS_PROXY=...`. The setup script is unchanged: it runs before all of this, on its own network, with full internet access.

**Memory.** The door counts 96 MB for every turn, `off` included (the memory the page shows does not depend on the rule), so the agent's container has 96 MB less than before at every size: 1,952, 5,904, 9,672 and 13,441 MB at 2, 4, 6 and 8 vCPU (`contracts/environment-sizes.v1.json`, the Dispatcher's `agentMemoryMb`, the app's `AGENT_MEMORY_MB` and the Runs page's `AGENT_MEMORY_GB` are held to it by tests).

**The report.** For every turn that got as far as the network, whatever its rule (`off` included, and also when the second wall is not in place: `vmPolicy: not_configured` and a note), the turn's result carries `implementer.network` (`ImplementerNetworkReport`): the rule's mode, whether a door ran, what the second wall did (`vmPolicy`), the totals (connections allowed and refused, bytes each way) and at most 100 entries, one for each host, port and outcome with its count and bytes, refusals first, and the number of entries that did not fit. **No body, no header and no path is kept anywhere** (a test holds that the log of the door has none of them); the host is the text the agent asked for, cleaned to printable ASCII and shown as text.

### The second wall: the VM's network policy

The first wall is the door and its table. The second is outside the VM, so that a flaw inside it does not undo it: after the setup, the VM's **Vercel network policy** is narrowed to GitHub (`github.com`, `api.github.com`: the final push), the model provider, the App, the Dispatcher's own host, and the environment's list; nothing more for `off`. For `open` it is left as it is (the platform's `allow-all`). The setup runs under the open policy, as before.

**Who changes it, and why not Control.** The policy is a setting of the VM changed with the platform's API and a credential of the team, which must never be in a VM. The Dispatcher has the credential but holds nothing after the hand-over (#487) and cannot wait for a setup script of up to 15 minutes. So the Dispatcher gives the Control container, in its environment (`RUNNER_IMPLEMENTER_NETWORK_SWITCH`), a document with the address of its **`POST /network`**, the VM's name, the app, the rule and the model provider's host it read in the claim (`job.network` and `job.modelHost` of the App's answer, for every Implementer job: a task without an environment is `off`; the App takes the host from the turn's model entry), the time the token stops working (the VM's lifetime from its creation, which is derived from the job's time limit, plus a minute), and a **token**: an HMAC-SHA256 over the app, the VM, the rule, the provider's host and the expiry, keyed by a key derived from the app's signing secret for this purpose only. **Control makes the call after the setup and before the agent exists** (`session._start_network`, `network_switch.py`), with the values of the document; it refuses to start when the model it is about to use is not on the provider's host the Dispatcher signed. The Dispatcher checks the token and its expiry (the current key and the previous one while keys rotate), builds the policy itself (`network/rule.ts` `policyFor`), and sets it through the SDK (`updateNetworkPolicy`, the port's `SandboxFleet.setNetworkPolicy`). Control cannot choose another VM, rule or provider host, and a copy of the token narrows the VM it was made for, to the same rule, until the VM is gone.

**The switch ends the connections that are open, the call that asks for it among them.** So the answer may never arrive. Control asks again, up to eight times two seconds apart, until it gets `{"status":"applied"}`; the Dispatcher's own host is in the narrowed policy, so the next call gets through, and the call is idempotent. A `4xx` is not asked again. A call that never gets through ends the turn `setup_failed`, free, before the agent exists. A Dispatcher with no public address (`DISPATCHER_PUBLIC_URL`, else the platform's `VERCEL_PROJECT_PRODUCTION_URL`), or one whose claim answer names no provider host (an App of the release before), hands out no switch, and the Worker then says in the report and in a note that the policy was not changed (`vmPolicy: not_configured`, for every rule, `off` too); the first wall is the only wall. `DISPATCHER_PUBLIC_URL` is an origin: a path in it is refused when the Dispatcher starts, because the route is served at the root.

**What the Dispatcher accepts.** The route takes a JSON body of at most 64 KB; the VM's name must be `cr-implementer-<job id>-<suffix>`; the model host a plain host name (no wildcard, no address); the rule the contract's; and the token must be the HMAC. Every refusal of one status has the same words, so a caller cannot tell which check failed. Nothing logs a token or a body.

**Wildcards.** The platform's policy takes `*.suffix` in its `allow` list, and the entries are passed on as they are. The platform's wildcard may be wider than the door's (the door never lets the suffix's own name through, the platform may), which is harmless: the door decides for the agent, the policy decides for the VM.

### Measured on a real VM (2026-11-03, `spike-net-door-1`, 2 vCPU, 4 GB, from the golden snapshot of 17:28 with this branch's runner source over the Worker image)

The Control container, the door and the agent's container were started by the real code (`AgentContainer.create`, `start_network_door`, Sysbox runtime, the production model network), a `list` environment with `registry.npmjs.org`, `*.npmjs.org`,
`pypi.org`, `files.pythonhosted.org` and the Docker Hub names; the policy was changed with the platform's own call (the platform connector's call that sets a running session's network policy, the same API the SDK's `updateNetworkPolicy` calls) with the policy that `policyFor` builds.
What was **not** run here: the Dispatcher's `POST /network` route and the call from Control to it (a deployed Dispatcher is needed); they are covered by unit tests, the lane covers the door, and the policy semantics below were measured with the platform directly.

| Check | Result |
| --- | --- |
| Start: volume, Control, door (incl. its egress table), agent container with its inner Docker | 4.5 s in all (the door included) |
| `list`: `npm install left-pad` through the door | 1.2 s, installed |
| `list`: `pip install six` through the door | 2.1 s, installed |
| `list`: `docker pull hello-world` in the agent (the inner `dockerd` takes the proxy from the container's environment) | went through the door; Docker Hub's blob host `production.cloudfront.docker.com` was **not on the list** and got the door's `403 not_listed` (list `*.docker.com` or `*.cloudfront.docker.com` for Docker Hub); with `open` the pull worked |
| `list`: `https://example.com` and `http://example.com` through the door | `403 Forbidden` (`not_listed`), `Tunnel connection failed: 403` |
| Direct egress from the agent (`1.1.1.1:443`, `142.250.185.78:443`, the model network's gateway, the metadata address) | all blocked; the same probe from a plain container on the VM connects; the agent has no name server (`gaierror`); `172.17.0.1` answered "refused" because it is the address of the agent's own inner `docker0` |
| The door's size | 17.4 MiB of its 96 MiB, 8 processes after the traffic above; 27.8 MiB and 204 processes with 100 tunnels open at once (CI lane, `runc`); `OomScoreAdj` -500 as asked |
| The door's log (`list`) | 15 allowed, 3 refused, 270,792 bytes in, 47,755 out; entries per host: `registry.npmjs.org` 6, `pypi.org` 3, `files.pythonhosted.org` 2, `registry-1.docker.io` 3, `auth.docker.io` 1; refused `example.com` 2, `production.cloudfront.docker.com` 1; no path, no body |
| `open`: `example.com` (https and http), `github.com`, `docker pull` | all worked; `http://10.0.0.5` and `http://169.254.169.254/...` were `403` (`private_address` / `ip_literal`); direct egress still blocked |
| `off`: proxy variables in the agent | none (0); no door container; `1.1.1.1:443`, the door's address and the model door's port all blocked; `npm install` failed with `EAI_AGAIN` |
| **The switch of the VM's network policy** (second wall) | an open connection (a TLS connection to `github.com` that sent a request each second) **was reset (`ConnectionResetError`) at the moment the policy changed**, as the plan said. After it: from the VM itself `example.com`, `google.com` and `pythonhosted.org` (not listed) were unreachable (`dispatcher.code-review.com`, listed but a name that does not exist, did not answer either), `github.com`, `registry.npmjs.org`, `pypi.org` and `code-review.com` answered; **Control (a new connection to `api.github.com`) was reachable at once**, no reconnect needed beyond the new connection; the agent's `npm install` and `pip install` through the door still worked and `example.com` was still `403` at the door |
| **Wildcards of the platform's policy** | `*.npmjs.org` let `docs.npmjs.org` and `www.npmjs.org` through and **not `npmjs.org`**: the platform's `*.suffix` matches the names below it and not the name itself, the same as the door's rule, so the policy can express suffixes and no special case is needed |

**The second wall is a fence, not a filter of what the agent says.** Both walls know host names; neither looks inside a tunnel. See "What is accepted" for what that leaves.

## The environment's setup script

A task whose environment has a script runs it once, between the clone and the model (step 5 of "The data flow"). A task without an
environment, or with an environment without a script, has no Setup container, no extra network, no extra image and no extra second.
Everything below is `setup_container.py` (the container), `environment_setup.py` (the step: budget, output, the tracked files, the codes)
and `host_rules.py` (what Control does to the VM's own network), driven by `job_run.py` before the session exists.

**The Setup container** is a throw-away container of the **agent's own image**, under `sysbox-runc`, as root, with its own `dockerd`,
the `repo` directory of the work volume mounted as `/work/repo` (the Subpath the agent will get, so the mirror is out of its reach) and the
agent's limits: its memory (what the VM has left after the OS, Control, the door and the readers, no swap) and 16,384 processes. **It has no
secret of any kind**: no git token, no model key, no job token, no environment variable besides the image's own, no mount besides the
repository, no socket, no device, no label of the job, and the image carries none either. Its definition is made of constants and of
identifiers the daemon gave; Control reads the container back from the daemon before the script is written and stops the run if it is
privileged, not under Sysbox, on another network, has another mount or another variable (`_seal_check`). The model door does not exist yet
while it runs, and the script's text is in one place only, a file in this container.

**The script runs as the owner's rule says: free inside, guarded outside.** It is written to `/tmp/code-reviewer-setup.sh` and run as root
with `/work/repo` as its working directory, by `bash -e` (a failing command ends it, as in a `run:` step of GitHub Actions), or by the interpreter of
its first line when that starts with `#!`. Its environment is the image's plus `HOME=/root` and `DEBIAN_FRONTEND=noninteractive`. Its
standard output and standard error are one stream. It may install anything, start its own Docker, pull images, and use the internet on any
port. Nothing in it is on a list of allowed commands.

**How it gets the internet and nothing of ours.** The container is alone on a Docker network of its own (`code-reviewer-setup`, a bridge
named `crsetup0`, range `10.213.78.0/29`, not internal, so Docker masquerades its traffic). Its DNS servers are public resolvers named in
its definition (`1.1.1.1`, `8.8.8.8`): the VM's resolver is on a private address. What it must not reach is closed on **the VM's side of
the bridge**, in the VM's own network namespace, by two things that a one-shot container installs before the Setup container exists
(`host_rules.py`: the host's network namespace, `NET_ADMIN` and no other capability, a read-only root, no mount, a constant command):

1. an `nft` table `setup_egress` (family `ip`, hooks at priority -10 so that it runs before Docker's own rules, whose only verdicts are
   drops): everything that comes **into the VM** from the bridge is dropped (that is the VM's control port `23456`, every other service,
   the bridge's own gateway), and what is **routed through** the VM is dropped when it is going to a private, link-local, shared or special
   range (`10/8`, `100.64/10`, `127/8`, `169.254/16` where the platform's own addresses are, `172.16/12`, `192.168/16` and the rest of
   `PRIVATE_RANGES`) or into another bridge (`docker0` where Control and the door's bridge side are, the `br-*` bridges, the model network)
   and nothing else; the rest of the internet is open on every port, which includes the containers of the Setup's own Docker, whose
   traffic is routed through the Setup container's address;
2. **no IPv6 address on the bridge** (`ip link set dev crsetup0 addrgenmode none`, `ip -6 addr flush`). The VM's kernel has no `ip6` and no
   `inet` netfilter (`nft` answers "Operation not supported", measured), so the table cannot see IPv6, and the VM does not forward IPv6.
   But root in a container can switch IPv6 on in its own namespace, ping `ff02::1`, find the bridge's link-local address and connect to
   **port 23456 of the VM** over it (measured, below): the control service listens on `*`. With the address taken off the bridge there is
   nothing to connect to. **The same hole was in the model network of the agent's container (step 4) and is closed the same way**
   (`AgentContainer.create` does it before the container is made).

These are on the VM's side because the container is root of a user namespace of its own and owns its network namespace: any rule it
installs inside, its script can flush (and one `nft flush ruleset` in it changes nothing outside, measured). The rules are read back
(`list table`) and a Setup whose network is not closed is never started (`setup_failed`, free).

**Time.** The script has 15 minutes at most (`contracts/environment-sizes.v1.json`). The whole step is part of the turn's 60 minutes: the
agent's own deadline is counted from the start of the job, so the minutes of the step are gone from it. Around the script the step may
take, at its ceilings, 20 s for each of the four host helpers (the bridge's IPv6, the `ip` table, its read back and the `inet` table), 60 s until the container's Docker is ready, 30 s to write the script,
45 s for the kill of a script that has to be stopped (the kill, the wait for its exec, the kill of the clean-up: 15 s each), 30 s for the end
script, 120 s for the container's Docker to stop, 40 s for the stop, 30 s for the question about the disk, 300 s for the commit and 120 s for
the removal, 855 s together (`SETUP_OVERHEAD_SECONDS`); a test holds the sum. The script is held to what the limit leaves after the grace
for the end of the turn (270 s), those 855 s and **at least 10 minutes for the agent** (`MIN_AGENT_SECONDS`); with the normal 3600 s that is the 15 minutes. A
limit that leaves less than a minute for the script ends the turn here, free ("the time limit of the turn leaves no room for the setup
script"). A script that runs out of its time is killed with its container and ends the turn.

**What the Runs page gets.** The `setup` block of the result: whether it succeeded, the exit status (empty when the script did not end by
itself), whether it ran out of time, the seconds, and the **end of its output** (stdout and stderr together). The output is kept as the last
64 KiB while it runs (memory is bounded whatever the script prints), then cleaned: terminal escape sequences and control characters out,
a carriage return a line end, the job's secrets removed, the last 8,192 characters. The log line of a failed turn has the notes of the step
and the last 1,200 characters of it. The page renders it as text.

**What becomes of what it did.** When the script ends with status 0: the script's file is removed, the container's own Docker is stopped the
way a daemon is stopped (SIGTERM; the container's init ends with it and the container stops by itself), and the container's file system is
committed (`docker commit`, `POST /commit`) as `code-reviewer-agent:environment`. **Under Sysbox a stopped container's file system holds its
inner Docker's images** (Sysbox writes them back into it when the container stops; measured on a VM, below), so the packages and the
browsers the script installed and the images its Docker pulled are in the image. The Setup container is then removed, and the Agent container
starts from the committed image by its id (`AgentSeams.image`). The repository volume is not part of the commit: the files the script left in
`/work/repo` are in the volume, which the agent mounts as before. There is no cache of the result: every turn runs its script.

**The repository after the script (what is the base of the turn).** The script ran in the repository's folder and may have changed anything in
it. What it did to the repository is the **base** the agent starts from, not a change the agent made, and two rules follow
(`GitWorkspace.settle_after_setup`, in the reader, one place for both):

1. **A change to a file that git tracks is undone** (`git reset --hard` after `git status` counted them; the log says how many files and names the first
   five). The turn ends by committing and pushing whatever the tree holds, so a lockfile an install rewrote or a configuration a script patched
   would arrive on the branch as the agent's work.
2. **A file or folder the script added, and the repository does not ignore, stays in the working tree and goes on the repository's local ignore
   list** (`.git/info/exclude`: git's own, never committed, never pushed; the top-level entries, anchored and escaped, a folder counting once). The
   agent sees and uses it, but it is no change of the agent: the tree is not dirty because of it (so no extra message), the system's commit of what is
   left does not take it, and the agent's `git add -A` does not either (the agent's prompt says so in one sentence, `prompts.py`); an agent that wants one in a commit adds it by name with `git add -f`. What the
   repository ignores already (`node_modules`, a virtual environment, build output) needs nothing. A name with a line end cannot be written as a
   pattern and is left as it is; more than 10,000 entries (or 1 MiB of names) ends the turn rather than half of them being kept.

Before both, the script's **history** is undone (`_return_to_start`): HEAD goes back to the branch the agent starts on, every branch of the turn (the base branch, the task's branch and, on a follow-up, each branch of the session) to its own start tip, and every other
branch and every tag is deleted, whatever worktree has it checked out (`git update-ref --stdin -z`, fed by a streamed listing of the refs, so no length of one name is a limit, and the number of refs and the bytes of their names are (#827): a script that leaves more than 100,000 branches and tags (`ref_drop.MAX_REFS`), or branches and tags whose delete commands are more than 32 MiB together (`ref_drop.MAX_REF_BYTES`, so that a few refs with names of kilobytes do not get round the count), ends the turn `setup_failed`, free, with "the script made more than 100000 branches and tags" or "the names of the branches and tags the script made are more than 33554432 bytes" (both bounds are well above any repository and well below what the 256 MiB reader holds in one `update-ref`, not measured on a VM); before, such a script ended it by the reader's memory limit with no reason; `branch -D` would refuse a branch a linked worktree of the script has checked out and end the turn). The commits stay in the object store and their files in the tree.

This is a rule about where the agent starts, not about what the script may do. If it turns out to be wrong, it is one function. A script that left the
repository unreadable (it removed `.git`) ends the turn with `setup_failed` (free: the runner could not read what the script left, and the script's output is not shown).

**When it fails.** A script that exits non-zero, runs past its time limit, fills the disk, is killed for the memory of the container (the
log says so: "killed for its memory"), or leaves a container whose result cannot be committed (the disk) ends the turn `environment_setup_failed`
**before the model door exists**: nothing was handed a key, nothing was used, the turn is free, and the Runs page shows the exit status, the
seconds, whether it timed out and the end of the output. A script that exited 0 and whose result could not be kept (the VM's disk had no room for the commit, or the daemon could not save the image)
has the exit status 0 and the runner's own last line in the output (`[setup] the VM had no room to save the setup result: the VM's disk has X MB left and the result of the script needs about Y MB`);
the page says "The script finished, but its result could not be kept" and shows that line. A script whose container went away under it (its own memory, or the guard when the VM was running out of memory) has no exit status that says why (137 or none), so the same last line carries the reason as a whole sentence (`[setup] vm_memory: the container ended during the script: it was killed because the VM was running out of memory (exit code 137)`, #827). The room check is skipped, with a note in the report, when the VM's free space or the size of the container's file system cannot be had. A Setup container that could not be had (the daemon refused a step, the network rules
did not go in, the container was not what was asked for) is `setup_failed`, free as well, with the reason word in the log: it is the runner's, not
the script's. A SIGTERM during the script kills the container and ends the turn `runner_shutdown` as for the agent.

**Disk and memory.** Setup has the agent's limits for memory and processes. What it writes goes to the VM's disk like everything the agent
writes: the container's file system, the inner Docker's images, the commit (an image the size of what changed, for the measured
Playwright environment below) and, while the agent runs from it, the agent's own copy of the inner images. **Control's reserve disk is
untouched** by any of it: the mirror is on its own 8 GiB file system, and a script that fills the work volume or the VM's disk fails with
"No space left on device" (the lane proves it with a small stand-in disk), the step reads how much of the disk is left after the script and
says so when it is under 1 GiB.

**A disk too full for the commit.** A script can end well and leave a container whose file system the VM's disk cannot keep as an image. Once the
container has stopped (the inner Docker's data is in its layer by then) and before `docker commit`, Control asks the daemon for the size of the
container's writable layer (`SizeRw`) and for the free room of the VM's disk, and needs **twice the layer and 1 GiB** (`COMMIT_ROOM_FACTOR`,
`COMMIT_HEADROOM_BYTES`: the layer as a tar and the copy the daemon unpacks). With less, the run ends with its own outcome `no_room` and the turn
with `environment_setup_failed`, free, saying "the disk of the VM is too full to keep its result: the VM's disk has N MB left and the result of
the script needs about M MB (the container's file system is K MB)", instead of a commit that fails minutes in with the daemon's words. A size or a free
space that cannot be had is not a reason to refuse: the commit is tried. The commit has `COMMIT_SECONDS` = 300 s: measured 3.9 GB in 61 s (64 MB/s),
and 4 GB on a disk four times slower is 250 s (`COMMIT_MEASURED_BYTES_PER_SECOND`, `COMMIT_SLOWDOWN`; a test holds it). The lane (L09) fills the
container's root beyond a small stand-in disk and expects `no_room`.

**Measured on a real VM, round of #818 (2026-11-03, 2 vCPU, 4 GB, a `spike-` VM from a snapshot built from the branch; its images are from commit
`1bfda743`, the Dockerfile and the boot scripts have not changed since, the code under test is the head, run on the VM with `uv`; `sysbox: proven`).**

*The whole step with a real environment.* The script: `npm install playwright@1.49.1`, `npx playwright install --with-deps chromium`, `docker pull
postgres:17-alpine` in the container's own Docker, a file in `/opt` and one in the repository. Then a turn (the real OpenCode, the real door, the scripted
provider of `fakes/wire`) in which the agent, **with no internet**, runs a Playwright test and starts the postgres image the script pulled.

| | Measured |
|---|---|
| Setup container, from the call to the script running (network, four helpers, container, ready) | 1 s |
| Script (npm, Chromium 100.9 MiB, its apt packages, a pull of 422 MB) | 24 s |
| Saving the result: the container's Docker stops by itself in about a second, **`docker commit` 61 s** (3.9 GB of image) | 62 s |
| Removing the Setup container (with its inner Docker) | 0.3 s |
| The agent's container from the committed image, to ready (Sysbox copies the inner images into its Docker) | 1.7 to 2.0 s (1.5 to 1.8 s from the golden image, step 4) |
| The turn, all of it (setup 87 s, the agent's turn 15 s) | 102 s |
| The committed image | **3.92 GB on disk, 1.07 GB of content**, against 1.54 GB and 397 MB for the golden agent image: Chromium and its libraries 862 MB (`~/.cache/ms-playwright`), postgres 422 MB, the rest the apt packages of `--with-deps`, the npm tree and the copy of the inner Docker's data |
| The VM's disk | 15.4 GB used before, 18.3 GB after the agent ran: the images the script made cost about 2.9 GB, in the committed image and the agent's own copy of the inner images |

In the agent, the file the script left in the container's file system was there (`cat /opt/setup-marker`); `1.1.1.1:443` and a name lookup both failed
("Network is unreachable"); the Playwright script launched headless Chromium and printed the title and the heading of a page it set; `docker image ls`
listed `postgres:17-alpine`, `docker run` started it and `psql -c 'select 6*7'` answered 42; the agent's commit arrived. The commit is the long part and
grows with the image (about 64 MB/s here); its ceiling of 300 s holds an image of roughly 19 GB.

*What the Setup container reaches*, through the production code (the lane's environment helper with a Control stand-in on the default bridge, a model network with
the door's relay at `10.213.77.2` and on the default bridge, and the VM's own control service on port 23456). From the container and, for the last block,
from a container of its own Docker:

| Target | Before the rules (the control) | With the rules |
|---|---|---|
| `1.1.1.1:443`, `example.com:443` by name, `example.com:80`, `github.com:22`, `8.8.8.8:53`, `1.1.1.1:8443`, a name lookup | open | **open** |
| The VM's control port by the VM's address (`169.254.0.2:23456`) | **open** | blocked |
| The VM's control port by the Setup bridge's gateway (`10.213.78.1:23456`) | **open** | blocked |
| The VM's control port by `docker0`'s gateway (`172.17.0.1:23456`), `169.254.0.1:23456` and `:80` (the platform) | blocked | blocked |
| Control's stand-in (`172.17.0.2`), the door's stand-in on the model network (`10.213.77.2`) and on the default bridge (`172.17.0.3`) | blocked | blocked |
| `10.0.0.1`, `192.168.0.1`, `172.16.0.1`, `100.64.0.1` | blocked | blocked |
| The same from an inner container of the Setup's Docker (`alpine`, pulled through the internet) | n/a | the internet open, the rest blocked |
| IPv6: root switches it on, pings `ff02::1`, looks for the bridge's neighbour | the host's `fe80::...%eth0` **answers on 23456** | no neighbour on the bridge; the connect times out |
| `nft flush ruleset`, `iptables -F` in the container (after `apt-get install nftables` over the internet) | n/a | nothing changes: the rules are on the VM's side |

The platform's own network already refuses a good part of the private ranges (the "before" column shows it); what the rules add is the VM itself,
which the Setup bridge reaches by default, and the bridge-to-bridge routes. Under `runc` (the lane in CI) the same probes give the same answers.
The whole lane on a fresh VM at the final head: 25 of 25 tests of `runner/tests/lane` under `sysbox-runc` (262 s) and 25 of 25 under `runc` (192 s, as CI runs it).

*The failures.* A script that exited 3 ended the turn `environment_setup_failed` with its two output lines and no model side (no door, no model
network); a script that slept past its time was killed at the limit (`timedOut`, null status); one that filled the work volume's disk failed with "No
space left on device" and the mirror on the reserve disk was whole; a stop during the script removed the container and left nothing; an `apt-get
install` without an `apt-get update` first exited 100 and ended the turn the same way (the "script that tried to undo the rules" of the table
first ran into it).

## Environments

An environment is a start configuration for a task: a **name**, a **size**, a **setup script** and (step 7) a **network** setting. They are kept per workspace on
the page `/w/<slug>/environments` (navigation entry "Environments", between Implementer and Runs; only in a deployment with the
capability `implementer`, anywhere else the path is a 404 like an unknown one).

- **Who:** every member sees the list and the scripts, because every member may use one. Owners and Admins create, change and
  delete (`manage_implementer_environments`). A workspace holds at most 50.
- **Sizes** are 2, 4, 6 and 8 vCPU. The VM has 2 GB per vCPU and the system around the agent takes 2 GB of it (the OS and the Sysbox daemons
  512 MB, Control 768 MB, the model door 256 MB, the network door 96 MB, the two readers 512 MB) and the memory guard's floor above 512 MB (144, 472 and 799 MB at 4, 6
  and 8 vCPU, `memoryGuardFloorMb`), so the **agent's container gets 1.9, 5.7, 9.4 and 13.1 GB** (1,952, 5,904, 9,672 and 13,441 MB): the page shows
  that figure rounded down to a tenth ("4 vCPU, 5.7 GB memory"), the memory `sandbox.ts` computes (`agentMemoryMb`). **1 vCPU is not offered**: it is a size of
  the platform (reviews run on it) and leaves the agent's container nothing. An environment that still has it (a row made before this
  change; the table has no default for the column and the form's default was 2, so such a row exists only where a member chose 1) is
  listed as it is, with its 1 vCPU and a sentence that a task started with it is refused until another size is chosen; the form opens with no
  size chosen and does not save before one is; the picker of the task form lists it as "(1 vCPU, no longer offered)" and a task started with it
  is refused at the submit with `IMPLEMENTER_ENVIRONMENT_SIZE_UNSUPPORTED` (422), before a session, a turn, a job or a VM exists: free. The sizes,
  the memory per size and the least memory an agent is worth starting with (1,024 MB) are `contracts/environment-sizes.v1.json`; the app and
  the Dispatcher are both held to it by a test. A task without an environment keeps the standard: 2 vCPU, no script.
- **The script** is text of at most 64 KB (UTF-8), literal data, stored exactly as written: no trimming, no changed line ends, no
  checking of what it says. Only what cannot be stored as text (a NUL byte, half of a character) is refused. It has no secrets
  field and the page says so. **It runs when a task starts** (section "The environment's setup script"), and the page says what it
  gets: root, full internet, no secrets, a container of its own, `bash -e`, 15 minutes, the tracked files put back, and an agent that has no
  internet afterwards.
- **The network** is `off` (the default), a list of hosts or `open`: what the agent can reach once the script is done (section "The network door (step 7)"). Only Owners and Admins can change it, like every other field. The form says that network access can be used to send out anything the agent can read.
- **Names** are unique within a workspace, whatever the case.
- **The form** has an optional picker "Environment". It lists the standard first and then the environments with their size and memory,
  and says "setup script" next to those that have one and "network: listed hosts" or "network: any host" next to those that give the agent a network. A task that names none is the task of before.
- **The task keeps its own copy.** When the task is sent, its turn copies the environment's name, size and script
  (`implementer_turns.environment_*`, no foreign key). Changing or deleting the environment later touches no running or past task, and
  sending the same request again after the environment was deleted still gives the first task back. The Runs page shows which environment
  and size a task used, and what its script did (how it ended, the seconds and the end of its output).

Routes (all `Cache-Control: no-store`, errors `{ "error": <code> }` with the codes of `app/src/implementer/environments/errors.ts`):
`GET /api/w/<slug>/environments` (every member; `?view=picker` is the list for the task form's picker, without the scripts), `POST` the same path, `PUT` and `DELETE /api/w/<slug>/environments/<id>` (Owner or
Admin).

### How the environment reaches the runner and the VM

The Dispatcher creates the VM when it claims the job, before any Worker exists, so the **size** comes from the App's answer to the claim
and from nothing else, and the **script** from the job the Worker fetches:

1. The claim answer (`SplitClaimResponse`, authenticated with the Dispatcher's credential) carries `job.vcpus` for a turn that has an
   environment, and for nothing else. Neither the name nor the script is in it.
2. The core of the Dispatcher believes the number for the kind `implementer` only. A review job's answer may say anything: the field is
   dropped, so a review can never name a size.
3. The Launcher accepts only the sizes of `SANDBOX_VCPUS` (1, 2, 4, 6, 8) and, for a job, only those that leave the agent at least 1,024
   MB (`IMPLEMENTER_MIN_AGENT_MEMORY_MB`): anything else, 1 vCPU included, fails the launch with `sandbox_size_unsupported` (not
   retryable, nothing created); a size the platform itself refuses at the create reaches the usual codes (`sandbox_rejected`,
   `sandbox_quota_exceeded`).
4. **Precedence** of the size of an Implementer VM: the turn's environment, then `DISPATCHER_WORKER_CONFIG.implementer.launcher.vcpus`, then
   the default of the kind (2). **The memory of the Control container does not follow the size** (768 MB at every size; the operator's
   `container.memory` for the kind applies at every size): the size is the agent's, which gets what the VM has left (`RUNNER_IMPLEMENTER_AGENT_MEMORY_MB`,
   1,952 at 2 vCPU, 5,904 at 4, 9,672 at 6 and 13,441 at 8). An operator who configures `launcher.vcpus: 1` for the kind gets
   `sandbox_config_invalid` (the network door's 96 MB took the last room Control's default 768 MB had at 1 vCPU; it was the Worker's free `sandbox_size_unsupported`
   before, which a job that names the size still gets from the Launcher).
5. The Dispatcher reports the VM's size with the VM (`vcpus` in `VmStartRequest`) for an Implementer job only (an App of the release before
   refuses a field it does not know, and a refused report only costs the measuring of the minutes), and the App keeps it in
   `job_vm_runs.vcpus`, so that minutes can be priced per size later. Billing is off in the factory; nothing is charged by size today.
6. The script reaches the Worker as `implementer.environment` (`name`, `setupScript`) in the job, and **only to a Worker that names the claim
   feature `implementer_environment`**: for any other, a task whose environment has a script is refused at the claim
   (`implementer_engine_unavailable`, free) rather than run without it on a base the person did not choose. The result carries
   `implementer.setup` (`ok`, `exitCode`, `timedOut`, `durationSeconds`, `output`) when a script ran.
7. **The network rule** (step 7) goes two ways. To the Dispatcher, in the same claim answer as the size: `job.network` (`{mode, hosts}`) for **every** Implementer job
   (a task without an environment, or an environment without a rule, is `off`) and `job.modelHost` (the provider's host, when it is a plain host name) and for no other kind, so that it can hand the Control container the token of the second wall
   (section "The network door (step 7)"). To the Worker, in `implementer.environment.network` next to the script (an environment now carries a script, a rule, or both; one with
   neither is no environment), **only if the Worker names the claim feature `implementer_network`**: for any other, a task whose rule is not `off` is refused at the claim
   (`implementer_engine_unavailable`, free). A rule of `off` is not sent (a Worker without the feature does the same). The Dispatcher believes `job.network` for the kind
   `implementer` only, and a rule that is not the contract's is an answer it cannot read: nothing is launched.

What does not depend on the size: the work volume is a directory of the VM's disk (64 GB on the Pro plan, whatever the vCPUs), the reserve disk
(8 GiB), `pids` of the Control container, the steps of the volume, and a VM lives `timeoutSeconds` plus the margin whatever its size.

## Profiles

A task can run with a **profile** (#843, [`docs/profiles.md`](profiles.md)): a workspace's own, versioned data with the model, standing
instructions, cost limit and **push right** a turn runs with. The task is sent with `profile` in the body of the route behind the form (the form
on the page does not offer one yet); the version it runs with is copied into the turn (`implementer_turns.profile_*`), like the environment, and the
model and cost limit of the version are the turn's own. A task **without** a profile is the Implementer of before: no extra text, every local branch
pushed. A profile with `canPush: false` makes Control skip everything about the push: no leftover commit, no listing, no push, no commits or files in
the result, and the turn is a success when the agent ended well. The text of the profile is appended last to the instruction file the runner writes
(`implementer/prompts.py`), so it is the same for every turn of one version and the provider's prompt cache hits. It reaches the Worker as
`implementer.profile`, only if the Worker names the claim feature `implementer_profile`.

## Limits

| Limit | Value | Where it is decided |
|---|---|---|
| Cost of a turn | The operator's maximum per turn: 5.00 USD once the owner has set it in the factory's admin portal (General, Limits, "Maximum cost per review"); the default is 1.00 USD until then, which is too low for a task. A person may ask for a lower limit on the form (never above that maximum or 100 USD). Without one, the maximum applies | Claim, and the proxy of the Worker: it refuses the next model call once the calls so far cost that much, so a turn can end slightly above it by the last call |
| Steps of the agent | None. There is no step limit, no plan, no approach rule: the cost limit is the brake | |
| Time of a turn | 3600 seconds, **the environment's setup script included** (it runs inside them; section "The environment's setup script"). The runner keeps the last 270 seconds for the commit of what is left and the final push of all branches (a third of a short limit; the split is in "The git rules"). The Dispatcher stops the Worker at 3600 seconds (`DISPATCHER_WORKER_CONFIG`, `implementer.timeoutSeconds`, 60 to 21600) and the App fails a turn still running after 70 minutes with `timeout`; the App cannot read the Dispatcher's setting, so change the constants with it (`docs/dispatcher.md`). The runner holds a turn to the smaller of its time limit and `RUNNER_JOB_TIMEOUT_SECONDS` | Dispatcher, runner, App |
| Stop | On SIGTERM the engine is ended at once, all committed branches are pushed (if the lease is still held; nothing uncommitted is committed) and the turn ends `runner_shutdown`. The job process gets a grace of 120 seconds, ends itself after 115 (the final push gets 25 of them), and the container's stop timeout is 150 seconds; each lease question (before the listing and before each push) is retried for 30 seconds at a normal end and 20 on a stop, and
never beyond the time that is left of the final push | Runner, container spec |
| Task text | 20,000 characters | Form and route |
| Branch name | At most 200 characters and 255 bytes, each part between slashes at most 240 bytes, no leading `-` or `+`, no white space or control character (the C1 block too), no lone surrogate half, git's rules, not the base branch (the Worker's push policy refuses the rest, #838) | Form and route |
| Base branches offered | 100 names, default first; a base beyond that can be typed | Route |
| Result | 200 commits and 500 files (of the task's branch), 50 branches, 8,192 characters of summary, the whole report under 4 MB (Vercel cuts a body at 4.5 MB) | Contract and runner |
| VM and containers | 2 vCPU and 4 GB for the VM; the Control container 768 MB without swap and 2048 processes, `/work` mounted `nosuid,nodev`; the model door 256 MB; the network door 96 MB; the two readers 256 MB each; the agent's container the rest after 512 MB for the OS and the daemons (1,952 MB at 2 vCPU, section "The agent's container" for the other sizes), no swap. The Dispatcher refuses a size that leaves the VM no room for Control, the door, the readers and the OS (`sandbox_config_invalid`); a size that leaves the agent less than 1,024 MB (1 vCPU) is `sandbox_size_unsupported`, free, from the Worker, and from the Launcher for a job that names it. A task whose environment names a size (2, 4, 6 or 8 vCPU) gets that VM and, at that size, 2,048, 6,000, 9,768 or 13,537 MB for the agent ("Environments"); Control stays at 768 MB | Dispatcher (`DISPATCHER_WORKER_CONFIG` can override the default size), runner |
| Setup script | 64 KB of text, 15 minutes, the whole step (start, script, saving the image) at most 855 seconds more, all of it inside the 3600 seconds of the turn, and the agent keeps at least 10 minutes; the end of its output, 8,192 characters, reaches the Runs page | Contract, runner (`environment_setup.py`) |
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
| `environment_setup_failed` | The setup script of the task's environment exited with a status other than 0, ran out of its time (15 minutes, or what the turn's limit leaves), was killed for the memory of its container, filled the disk, or left a result that could not be saved as the agent's image. It runs before the model door exists, so nothing was used. The Runs page shows the exit status, the seconds, whether it timed out and the end of the output (the job's secrets removed) | free | Fix the script in Environments and send the task again |
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

- **The repository's own setup scripts and registries for the agent.** The repository's own install and set-up steps are not run. What a
  task needs is installed by the environment's script, which has the internet; the agent has none unless its environment's network rule is `list` or `open` (section "The network door (step 7)").
  Private registries do not work in the script either: it has no secrets, and a credential for one would be a new step.
- **Secrets for tests.** No credential of any kind reaches the agent: tests that need an API key or a database URL cannot run
  against a real service (a database in the agent's own Docker is fine).
- **Pushes that touch `.github/workflows/`.** The App has no `workflows` permission and never asks for it for this; GitHub
  rejects that branch (`workflows_not_allowed`) while the others arrive; a task whose own branch is the one rejected ends
  `push_rejected`. Change workflow files by hand ([`github-app.md`](github-app.md)).
- Opening or merging a pull request, a second turn on the same branch, a task on an existing branch, forks, other platforms
  than GitHub.
- **A targeted escape from the kernel or the Sysbox daemons.** Step 6 attacked the boundaries the runner builds (section "The attack test (step 6)"); it
  did not look for a flaw in the kernel, Sysbox or Docker themselves.

## What is accepted, and until when

These are decisions of the owner, not oversights.

- **The Control container is effectively root on the VM** (#745, step 3). It has the VM's Docker socket so that it can start the
  model door, the agent's container and the reader. The agent never reaches it: its container has no socket and no route to Control,
  and the runner puts nothing of a job or of the agent's output into a request to the socket.
- **The agent shares the VM's kernel.** Sysbox makes root of its container an unprivileged user and gives it its own Docker without
  `--privileged`, but there is no virtual machine around it (no KVM on the platform). A kernel flaw that Sysbox does not stop is an
  escape to the VM, where the key and the token are in other containers. Acceptable for our own repositories, not for strangers' (the
  plan's table of exits); step 6 attacked what stands around it (section "The attack test (step 6)") and not the kernel itself. Sysbox officially supports Ubuntu up to 24.04 and the platform runs 26.04; the
  snapshot's proof is what notices a platform that breaks it.

- **Git is free, and every local branch is pushed.** No rule inside the workspace, none at the push: the agent can move any
  branch forward, including the default branch, and may push new branches (see "The risk, plainly"). Protect the default
  branch on GitHub. What the end of the turn will not do is force or delete.
- **The author and the committer are the agent's.** Nothing on GitHub proves that the system made a commit.
- **The work of a VM that dies is lost.** Nothing is pushed during the turn.
- **A branch created meanwhile.** If someone creates the task's branch after the submit check and before the end of the turn,
  and it points at an ancestor of the agent's tip, GitHub fast-forwards it: the task lands on a branch it did not create, with
  that person's earlier history under it. Any other history is a rejected branch (`non_fast_forward`).
- **Exfiltration through a registry: back with the network door (step 7) for `list` and `open`; `off`, the default, has none.** An environment whose
  rule is `list` or `open` gives the agent a network again, and the old risk returns with it, stated plainly: both walls look at the **host name** of the
  tunnel and nothing inside it, and `registry.npmjs.org` and `pypi.org` accept uploads, so an agent that holds an npm token (from the repository, or from
  prompt-injection text) can `npm publish` any file it can read, and with `open` it can send it to any host that takes a `POST`. The form says so where the rule is
  chosen. It is accepted for **internal use, on own repositories** only, and for the owner's decision on each environment. **#784 stays open and must be closed
  before external users** or a repository that is not ours: a read-only caching registry mirror (GET of metadata and tarballs only) or an intercepting proxy with a
  method allowlist, so that the agent has no tunnel to a public registry at all. The door does not read what goes through a tunnel (no interception, no certificate
  of ours), so the list cannot say "download, never upload". Nothing the agent sends is kept, in the report or anywhere.
- **The model provider's host in the second wall is the App's word, signed by the Dispatcher** (review of #830: it used to be the Worker's). The policy is built from the signed rule, the signed
  provider host, GitHub's two hosts, the App's and its own; a taken-over Control cannot add a host, and the token expires with the VM.
- **IPv6 does not go through the door.** The door looks up IPv4 only (its table is an `ip` table and its container has IPv6 off), so a host that has only an AAAA record is not
  reachable through it.
- **A door that dies takes the agent's network with it** for the rest of the turn, with a note in the report; the turn goes on.
- **Any member may start a task.** See "What it is". Move to Admin and up before outside users.
- **No registry and no `.github/workflows` pushes.**
- **Turns are billed at the Dynamic rate** until the Implementer has a rate of its own.
- **A turn that fails before it starts keeps its branch name** (#785).
- **Follow-ups that do not block the first release:** the retry batch of write tokens and the wording for a provider pin
  (#794), the lint of the image's package managers and the OpenSSL wording (#786), remaining QA wording (#775).

## Open points

Open issues at the time of this change (2026-11-04):

- **#745**, the epic of the first vertical slice, and **#768**, the operator guide and the live smoke test: the smoke test
  ([`implementer-smoke-test.md`](implementer-smoke-test.md)) is the first run of the whole path on the platform and has not
  been run for this git model.
- **#784**: read-only registry access, before external users (above). The network door (step 7) brings the risk back for `list` and `open`; it is **not** closed by it.
- **The Sysbox verdict in the deploy** is written and read (the fourth member of the pair), and `unrecorded` is gone: the first release
  after it has no verdict anywhere, so the Implementer is refused (`sandbox_unproven`) until that release has built a snapshot and
  promoted it (the changed image inputs rebuild it by themselves). **Before the first release that carries this change the owner must
  grant the machine identity's role *create* and *edit* on `SANDBOX_SYSBOX_PROOF` of `/dispatcher`** (`docs/deployment-vercel.md`,
  section 2.1). It is not a step that can follow the release: the persist job writes the key right after the promotion, and without
  the permission that write is refused. Then the run is red although production is live, `cleanup` is skipped (it needs `persist` to
  have succeeded or been skipped), so the old snapshots are not removed, and every later release fails at `persist` the same way until
  the permission is granted. Nothing has to be undone afterwards: *Re-run failed jobs* of the latest run writes the pair.
- **#797**: a failed proof of the Implementer blocks code-review.com. The Dispatcher is shared, the deploy canary requires
  `implementer` as soon as the factory's entry names the kind, and the promotions of everything staged in that run wait for the
  canary. There is no switch that waives the proof; the way back is in the rollout, step 2.
- **#799**: the usage of a turn that was stopped (`runner_shutdown`) is not recorded.
- **#794**, **#786**, **#775**: the follow-ups listed under "What is accepted".
- Which branches may be pushed (`PUSH_EXCLUDED_BRANCHES`) is the owner's open question; the list is empty.
