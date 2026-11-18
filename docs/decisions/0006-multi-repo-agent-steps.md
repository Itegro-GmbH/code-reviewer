# 0006: Several repositories per agent step

- **Status:** Accepted
- **Date:** 2026-11-18
- **Deciders:** the owner (request and decisions of 2026-11-18, epic #1090)
- **Implements:** epic #1090. This record and its contract are #1091; the app side is #1092, the runner side #1093, the pull
  request step and the lane editor #1094.

## Context

An agent step works on **one repository**: the one of the run (the ticket's repository, or the `repo` input of a manual
trigger). No agent step and no action names a repository (`unknown_field`, `docs/workflows.md`, "One repository per run, and
targets"). The job of the Implementer mirrors that: `ImplementerJob` has one `repo`, one `baseBranch`, one `branch` and an
optional `startBranch` (`contracts/runner-api.v1.json`), `git.token` is an installation token for exactly that repository, the
runner clones it into `/work/repo`, pushes every local branch the agent created or moved when the turn ends, and reports one
`baseCommit`, `headCommit`, `pushed`, `commits`, `filesChanged` and `branches`. The platform's branch of a session is made by the
engine (`sessionBranchOf`, `workflow/<run>/<step>`), a lane may only override where it starts from (`branch` of the step), and the
pull request step opens one pull request from `{{<agent>.branch}}`.

Real tasks span repositories: an app and the library it uses, a service and its client, a change and the repository of its
documentation. Today that takes one lane per repository and a person to keep them in step. The owner asked (2026-11-18) for an
agent step that gets **several repositories**, each with a **base branch** and an **optional branch** that, if given, is created
and checked out right away, and for everything the agent committed to be pushed when the run ends.

The forces:

- **Existing lanes must not change.** A step without the new field behaves exactly as before, the job of a single repository
  stays what it is, and an older runner must never receive a job it would run on the wrong repository.
- **The agent still has no remote and no credential.** More repositories mean more tokens, and a token must still reach only what
  the job named. A repository of another installation of the GitHub App needs a token of its own.
- **The contract is built by two sides at once.** The app (#1092) and the runner (#1093) are implemented in parallel against this
  record and the schemas, so the schemas have to leave nothing to guess: names, defaults, who decides what, what is reported.
- **`projects.repository_id` is going away.** The owner plans to drop the tie between a project and a repository later. New code
  must not build on it.

## Decision

### The step

An agent step may have `repos`: one to ten entries `{ repo, base?, branch? }` (`AgentStepRepo` in `contracts/workflow.v1.json`).

- `repo` is any **active repository of the workspace** (an installation of the GitHub App that can reach it; write access when the
  profile may push). It is a literal `owner/name` or one reference (`{{trigger.ticket.repo.fullName}}`, `{{trigger.repo.fullName}}`,
  an input of a manual trigger). **The run's repository is not special** and need not be listed. The project's repository is not
  required for this either, and nothing here reads `projects.repository_id`.
- `base` defaults to the **default branch of that repository**, read when the step runs.
- `branch` is optional.
  - **Given and it exists:** it is checked out and the work continues on it (a second fix round, a retry).
  - **Given and it does not exist:** it is created from the head of `base`.
  - **Not given (or equal to `base`):** the agent works **directly on the base branch** and what it commits is pushed to it. A
    branch protection rule may refuse that; the refusal is reported for that repository (`remote_rejected`), never forced.
- `repo`, `base` and `branch` are **targets** (they decide where the agent works and where its commits go): a literal or a
  reference to a value the platform or the caller vouches for, never a result field or the title, body or labels of an issue
  (`target_from_untrusted_value`). `branch` may be a text with such references in it (`feature/{{trigger.ticket.key}}`).
- Two entries may not name the same repository, **compared without regard to case** (`Acme/App` is `acme/app` on GitHub): `repo_duplicate`, rejected at lane validation for equal literals and by the engine for filled-in references. Two repositories whose derived mount names clash (below) end the step `repo_name_clash`. `repos` is not allowed with the step's `branch` (the old start
  branch of a session of its own) or with `session.continue` (a session that goes on keeps its repositories, **as the first turn resolved them**: bases and branches are never resolved again for an answer turn, a `session.continue` step or a resume).
- A step **without** `repos` is the step of today: the run's repository, the platform's session branch `workflow/…`, the job with
  one `repo`.

### Facts

- `{{<step>.repos}}` is a list with one entry per repository, in the order of the step: `{ fullName, base, branch, commits,
  headCommit, pushed }`. `branch` is the working branch, equal to `base` for direct work; `commits` is the list of commit ids
  **this turn** made on it, oldest first; `headCommit` is the tip of `branch` at the end of the turn (the commit it started from
  when the turn made none there, as for the single facts; null only for a repository with no commit at all); `pushed` says that
  the branch with `headCommit` is on the remote. Like the single facts, they exist only for a profile that may push.
- The single facts (`branch`, `commits`, `headCommit`, `pushed`) **refer to the first repository** and keep their meaning there
  (`headCommit` stays non-null), so a lane written for one repository keeps working when a second one is added behind it. On a
  step with `session.continue`, `{{<step>.repos}}` is the session's list with the facts of this turn; the pull request step reads
  it there.

### The pull request step

The pull request step opens **one pull request per repository** of an agent step whose branch differs from its base, **has commits
ahead of the base on the provider, and has no open pull request from that branch yet** (the turn's own `commits` do not decide it, so
a later round without new commits opens no second pull request and a continued branch still gets its pull request): `repos: "{{<agent>.repos}}"` replaces `head` and `base`, `title`, `body` and `draft` apply to every pull request,
and `{{repo.fullName}}`, `{{repo.base}}` and `{{repo.branch}}` are available in the texts. A repository with direct work, with
nothing pushed or without commits between its branch and its base is skipped, not an error. The step yields `pullRequests` (one
entry per repository with its state) and, for the first pull request that exists, the old `number`, `url` and `existing`. The
contract of this step is in `docs/workflows.md`; the schema of the action changes with its implementation (#1094), because the
app's connector registry and the schema are held equal by a test.

### The job

`ImplementerJob` gets `repos[]` (`ImplementerJobRepo`), **instead of** `repo`, `baseBranch`, `branch` and `startBranch` (the schema
makes the two forms exclusive; the job is closed, so a runner that does not know `repos` refuses it).

- Each entry has `name` (the mount: `/work/<name>`), `fullName`, `cloneUrl`, `base`, `branch`, **`branchExists`** and `tokenId`, all
  required.
- The **app resolves** `base` (the default branch when the step gave none) and `branch` (the base again when it gave none), so
  `branch == base` means direct work and the runner never guesses. For a follow-up they are the values the session stored from
  the first turn, never resolved again. **`branchExists`** is decided by the app at claim time and the runner follows it: true,
  fetch and check out the remote branch (missing there: `clone_failed` naming the repository); false, create it from `base` (it
  exists after all: `branch_exists`, a clear failure, never overwritten or continued).
- `name` is the name part of `owner/name`, or `<owner>__<name>` for **every** repository whose name part another repository of the
  job has too (so the result does not depend on the order) and for the reserved names (`result`, `reserve`, `.git`, any case). The
  schema forbids those, `.`, `..` and a leading `-`; the runner **re-derives** every name from the `fullName`s and refuses one
  that differs. Derived names that clash without regard to case are `repo_name_clash` in the app.
- **`cloneUrl` is checked for every entry** by the rule of the single repository (#762): host equal to the web host of
  `git.baseUrl`, path `/<fullName>[.git]`, https without credentials. The token goes only there.
- **The preamble is the app's.** It writes it at the start of `instruction` (it knows names, bases and branches); the runner adds no
  list of repositories.
- **Tokens.** `git.tokens` holds one installation token per installation that owns a repository of the job, made for exactly the
  repository ids of the job that belong to it, with the contents right the profile needs; `tokenId` names the entry. `git.token`
  stays and is byte-equal to the token of the first repository's `tokenId`. A job has `git.tokens` exactly when it has `repos`.
  **The app, not the runner, must make each token for exactly the repository ids of the job that belong to that installation**
  and give every repository the token of its own installation: the runner can check the host and path of the clone address but
  not which installation a token belongs to.
- **Feature gate.** The claim feature `implementer_multi_repo`: a job with `repos` is **only claimed by a caller that named it**. For
  every other caller it is not a candidate: it **waits in the queue** (as a job for a runner with other labels does), nothing
  fails, and there is no error code or reason word for it. The app ends it only when no runner exists that could claim it, with
  the codes it has today. A Dispatcher names the feature only when the Worker image it starts reads `repos`; a Worker handed such
  a job anyway (Dispatcher and snapshot disagree) is refused at its details request and the job ends
  `implementer_engine_unavailable` (free) with a message that names the feature. A step without `repos` is a job of today for
  every caller, so an old runner keeps getting single-repository jobs. A step with `repos` of one entry is a multi-repository
  job: the form follows the step, not the number of repositories.

### Running and pushing

Every repository is cloned as a single one is today (every branch and tag, the whole history, no remote, no credential) into
`/work/<name>`. **The agent's working directory is `/work`**, which is not a repository (the contract; #1093 measures how OpenCode
behaves there, see "Open questions"). When the turn ends the runner pushes **per repository, in the order of
the list, every local branch the agent created or moved, without force, with the token of that repository**: the push of today
(`docs/implementer.md`, "The git rules"), repeated. That includes **the base branch of every repository**, also where the entry names a
working branch: the owner's rule is that everything committed is pushed. `profile.canPush` false pushes nothing anywhere. A repository whose clone or
checkout fails ends the turn before the agent starts and nothing is pushed.

### The result

`ImplementerResult.repos[]` (`ImplementerRepoResult`) has one entry per repository, in the order of the job, with the name, base,
branch, whether the turn **created** the branch, base commit, head commit, `pushed`, commits, files and the per-branch push
report. Per repository: `created` is true when this turn made the branch; **`baseCommit` is the tip of the branch when the turn
started** (the base head if the turn created it or the work is direct, its own tip for a continued branch); `commits` are the
commits **this turn** made on the branch after it; `headCommit` is the tip at the end (equal to `baseCommit` when the turn made
none); `pushed` that the branch with `headCommit` is on the remote. The old fields of `ImplementerResult` are copies of the **first** repository's entry, so a reader that does not know
`repos` still reads a valid single-repository result. A rejected push is reported per repository; the turn ends `push_rejected`
when in any repository the working branch was not taken, and says which one; what was pushed elsewhere stays pushed.

**Size.** The body of a completion with `repos` is at most 4 MiB (4,194,304 bytes); the runner keeps `repos` plus the old-field copies
within 3 MiB by cutting `filesChanged`, then `commits`, ten entries at a time, and counts what it cut (`filesTruncated`,
`commitsTruncated`). The app's limit is raised to the 4 MiB in #1092.

### The session and resume

The session keeps its repository list for answer turns and for `session.continue` (the repositories of a session are fixed when it
starts), **with the `name`, `base` and `branch` the first turn resolved and the app stored: a follow-up never resolves them again**
(`branchExists` is asked again, tokens are made fresh). A follow-up job carries `resume.repos`: one entry per repository, by mount name, with the branches the last turn pushed
and the branch HEAD was on; `branches` and `checkout` are then absent. Resume restores every repository.

### Error codes

All end the step before the agent starts and cost nothing, except `push_rejected`. The lane codes are the app's and get their rows
in the table of semantic codes of `docs/workflows.md` with #1092 (a test holds that table to the validator); the runner's codes
are `ErrorCode`s of the runner contract.

| Code | Emitted by, when | Free |
| --- | --- | --- |
| `repos_with_branch`, `repos_with_session_continue` | validator, when the lane is saved | yes |
| `repo_duplicate` | validator (equal literals) and engine (filled-in references), without regard to case | yes |
| `repo_name_clash` | engine, when the step runs: derived mount names equal without regard to case | yes |
| `repo_invalid`, `branch_invalid` | engine: a reference gave no repository or no branch name | yes |
| `repo_not_available` | engine: no active installation, or none that can write when the profile may push | yes |
| `base_branch_not_found` | the runner (existing code), or the app when it resolves `base` | yes |
| `clone_failed` | runner: a clone or checkout fails; `branchExists` true and the branch is gone | yes |
| `branch_exists` | runner (re-used): `branchExists` false and the refs have the branch | yes |
| `invalid_job` | runner's parser: a rule of the job that the schema cannot state (the shared corpus) | yes |
| `push_rejected` | runner: in any repository the working branch was not taken | no (the agent ran) |

## Alternatives considered

- **One agent step per repository, chained.** The agent of the second step cannot see the first one's change, and a change that
  spans two repositories is one task. Rejected: that is the problem.
- **A list of repository names only, with the platform's `workflow/…` branch in each.** Simpler, but the owner wants to name the
  branch (to continue one, to follow a ticket-key convention) and to work directly on a base. Rejected.
- **Keep `repo`, `baseBranch` and `branch` required next to `repos` and let them mirror the first entry.** Keeps the generated
  types unchanged, but a runner that ignored `repos` would silently work on the first repository, and a job could contradict
  itself. The closed job with exclusive forms is refused by an old runner instead. The result mirrors the first repository
  because a reader that ignores new fields is harmless there.
- **One token for everything (a user token or the App's JWT).** Rejected: it would reach more than the job named, and a push
  would no longer be limited to the listed repositories.
- **The runner chooses the mount names and writes the preamble.** Rejected: the app writes the facts and the preamble and must
  agree with the runner on the names; they are derived by one rule, carried in the job, and the runner re-derives and checks
  them. One owner for the preamble (the app) avoids two agents writing one, or none.
- **Opening a pull request for every repository with a changed branch, whatever the turn pushed.** Rejected: a repository with
  direct work or with nothing pushed has no pull request to open, and a skipped repository must be visible, not an error.

## Consequences

- **Easier:** a task across repositories is one step, one session, one conversation and one budget. A second round continues the
  branches of the first. A lane can work on a repository next to the ticket's, with a pull request in each.
- **Harder:** the job, the result and the resume each have two forms; the app builds a job per installation of tokens and the runner
  holds several repositories, mirrors and pushes. The result is larger (up to ten repositories, with the lists shortened per
  repository: 100 commits, 250 files and 25 branches), so the app's limit for the body of an Implementer report is raised to 4 MiB in #1092 (the runner's budget is 3 MiB, see "The result").
- **The project repository is not required.** A lane that names its repositories does not need the project's one, and the
  repository of the run is just one more repository. This is the first lane feature that does not depend on
  `projects.repository_id`; the owner plans to drop the project↔repository tie later, and nothing new may depend on it.
- **Direct work on a base branch is allowed and unforced.** A protected branch refuses the push; the refusal is the turn's
  `push_rejected` for that repository, with the commits left on the agent's side only until the sandbox ends.
- **Everything committed is pushed, the base branch included.** The owner's rule is that every changed local branch of every
  repository is pushed. A consequence, stated plainly: **naming a branch does not protect the base.** An agent that commits on
  `main` in a repository that has a working branch gets that commit pushed to `main` as well, unless the provider's branch
  protection refuses it (then it is a `remote_rejected` entry). Branch protection is the only guard; a lane that must never
  change a base branch needs it on the repository. The single-repository form behaves the same today.
- **Rollout.** Contract first (this record and #1091, no behaviour change: the parsers still refuse `repos` and no code sends or
  reads it), then the app and the runner in parallel behind `implementer_multi_repo`, then the pull request step and the lane
  editor. A runner and an app of different releases keep working because of the gate.
- **Cost.** More repositories mean more clone time and more disk in the sandbox (every repository is a full clone and a mirror
  of its own). The environment's size and the time limit are the brakes; no new limit besides ten repositories.

## Open questions

- **The agent's working directory: measured (#1093), `/work` stays.** The contract is `/work`, which is not a git repository, and
  the fallback (the first repository's mount) is **not needed**. Measured with the pinned engine (OpenCode 1.19.0, `npm install
  opencode-ai@1.19.0`, a scratch data directory, no model): a session made with `directory=/work` (a directory that is not a
  repository, with two repositories below it) belongs to the engine's **`global` project** (project id `global`, worktree `/`),
  while one made in either repository belongs to the project of that repository (its root commit). `opencode export` of the `/work`
  session and `opencode import` of it into a fresh data directory, run from `/work`, gave `Imported session: <id>`, kept the id, and
  the engine answered `GET /session/<id>` with 200; **the project id did not change** (`global` before and after), where an
  import into a repository rewrites it to the repository's root commit. So the one thing the import used to rewrite (the project)
  is constant for `/work`, and a follow-up on a new VM resumes the session at least as well as one in a repository. The tools of the
  engine reach the repositories below `/work` by their paths (`external_directory` is allowed anyway, `config.py`), and `git`
  works in each repository (the agent changes into one). **Claude Code in `/work`, measured without a model call (#1093):** the program on this machine
  (`claude --version`: 2.1.325; the runner pins 2.1.311) keys its session store by the working directory **path**, not by a git
  root: the directories under its `projects/` are the cwd with `/` turned into `-`, including one for a directory that is not a git
  repository (`/home/luca/projects/code-reviewer`, whose repositories are in the directories below it, the same layout as `/work`
  with `/work/<name>`). The transcript lines of such a session carry the cwd and a branch of `null` or `HEAD` where the cwd is not
  a repository, and sessions there ran their tools (shell, reads, edits) in repositories below that directory. Without a
  repository only the git status block of the system prompt is missing (`claude --help` lists it among the per-machine
  sections). So a session in `/work` has one stable key on every VM (`/work`), and a resume (`claude -p --resume <id>`) looks it
  up under that key in the session volume. This is observation of a session that already existed,
  not a controlled run of the pinned version in the agent container. **Still not measured, a required item of the live test
  before the first release with a live multi-repository lane:** a model-driven turn of each harness (OpenCode and Claude Code in
  `/work` in the pinned agent image, with `bypassPermissions`), a follow-up turn that resumes the Claude Code session in the same
  container, and that the hand-over of each `/work/<name>` to the agent's user (`chown -R`, `claude_code/agent.py`) is enough. If
  Claude Code fails there, `RepoPlaces.workdir_of_first` is the fallback and `worker_api.py` must then not announce the feature for
  Claude Code. The switch to the fallback is one flag
  (`RepoPlaces.workdir_of_first`), should that ever be needed.
- **Reviews and ticket moves per pull request.** `ticket.requestReview` takes one pull request; a step that must ask for a review of
  each pull request of `pullRequests` needs the reserved `forEach` step. Until then it asks for the first.
- **The bounds of the report.** The per-repository bounds (100/250/25) and the budget (4 MiB body, 3 MiB for `repos`) are a guess
  from the single-repository bounds; a measured turn on ten repositories may tighten them.
- **A rejected direct push ends the turn `push_rejected`,** so the facts and the pull request step for the other repositories are
  not reachable on that failure path (a pull request step is skipped when the agent step fails). A `continue_on_error` for the
  step, or a pull request step that runs on a failed agent step, would fix that; not decided here.
- **Repository access of the person.** "Any active repository of the workspace" is checked at workspace level (the GitHub App's
  installation). A manual input `repo` is free text typed by a member of the workspace, who may have no access to that
  repository on GitHub; the run's own repository has the same property today, but now every repository is free text. Not decided here.
- **`{{trigger.ticket.key}}`.** *Settled in #1092:* every ticket has a text key (a Jira issue its key, `PROJ-123`; a GitHub issue its number as text), which is
  what `TICKET_TYPE` already says, so the validator takes `{{trigger.ticket.key}}` and `{{trigger.ticket.number}}` (0 for a Jira ticket) in the `branch` of an entry.

## Notes from the implementation of the app side (#1092)

- **The session's `branch` column.** A session has a unique branch per repository (`implementer_sessions_repository_branch_unique`), and a lane may name the same working
  branch again (a retry, a second round). A session with `repos` therefore keeps the platform's own session name (`workflow/<run>/<step>`) in that column: it is a key and no
  git branch. The repositories, as resolved, are in the new column `repos` (expand-only migration `20261118160000`); the first one is the session's `repository_id`.
  Everything that wants a git branch reads it from `repos` (the facts, the claim, the resume), not from `branch`.
- **Size limit.** The limit of the app for the body of an Implementer report (`IMPLEMENTER_MAX_BODY_BYTES`) is derived from the single form's worst case and is about 27 MB, so
  there was nothing to raise to 4 MiB: it is unchanged.
- **Direct work and read access.** For a profile that may not push the installation need not have the right to write, in the start of the task, the follow-up and the claim
  alike; the token is then a read-only one.

## Out of scope

- Dropping `projects.repository_id`, or any change to which repository a project belongs to.
- Repositories of another provider than GitHub, or of another workspace.
- Pushing tags, deleting branches, force pushes: unchanged, never.
- A pull request step that works across steps (`forEach`), and review requests per pull request.
- Changing the profile's `canPush`: it applies to all repositories of a step alike.
