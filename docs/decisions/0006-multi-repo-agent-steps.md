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
- Two entries may not name the same repository (`repo_duplicate`). `repos` is not allowed with the step's `branch` (the old start
  branch of a session of its own) or with `session.continue` (a session that goes on keeps its repositories).
- A step **without** `repos` is the step of today: the run's repository, the platform's session branch `workflow/…`, the job with
  one `repo`.

### Facts

- `{{<step>.repos}}` is a list with one entry per repository, in the order of the step: `{ fullName, base, branch, commits,
  headCommit, pushed }`. `branch` is the working branch, equal to `base` for direct work; `commits` is the list of commit ids the
  turn made, oldest first; `pushed` says that the branch reached the remote. Like the single facts, they exist only for a profile
  that may push.
- The single facts (`branch`, `commits`, `headCommit`, `pushed`) **refer to the first repository**, so a lane written for one
  repository keeps working when a second one is added behind it.

### The pull request step

The pull request step opens **one pull request per repository** of an agent step that has a branch different from its base and
pushed commits: `repos: "{{<agent>.repos}}"` replaces `head` and `base`, `title`, `body` and `draft` apply to every pull request,
and `{{repo.fullName}}`, `{{repo.base}}` and `{{repo.branch}}` are available in the texts. A repository with direct work, with
nothing pushed or without commits between its branch and its base is skipped, not an error. The step yields `pullRequests` (one
entry per repository with its state) and, for the first pull request that exists, the old `number`, `url` and `existing`. The
contract of this step is in `docs/workflows.md`; the schema of the action changes with its implementation (#1094), because the
app's connector registry and the schema are held equal by a test.

### The job

`ImplementerJob` gets `repos[]` (`ImplementerJobRepo`), **instead of** `repo`, `baseBranch`, `branch` and `startBranch` (the schema
makes the two forms exclusive; the job is closed, so a runner that does not know `repos` refuses it).

- Each entry has `name` (the mount: `/work/<name>`), `fullName`, `cloneUrl`, `base`, `branch`, optionally `branchExists`, and
  `tokenId`.
- The **app resolves** `base` (the default branch when the step gave none) and `branch` (the base again when it gave none), so
  `branch == base` means direct work and the runner never guesses. `branchExists` is what the app saw at claim time, for the note
  to the agent; the runner decides from the refs it fetched and follows them when the two disagree.
- `name` is the name part of `owner/name`, or `<owner>__<name>` for **every** repository whose name part another repository of the
  job has too (so the result does not depend on the order) and for the names the work volume uses itself (`result`, `reserve`).
- **Tokens.** `git.tokens` holds one installation token per installation that owns a repository of the job, made for exactly the
  repository ids of the job that belong to it, with the contents right the profile needs; `tokenId` names the entry. `git.token`
  stays and is the first repository's token. A job has `git.tokens` exactly when it has `repos`.
- **Feature gate.** The claim feature `implementer_multi_repo`: the app sends a job with `repos` only to a caller that named it and
  ends the turn `implementer_engine_unavailable` (free, reason `multi_repo_not_supported`) otherwise. A step without `repos` is a
  job of today for every caller, so an old runner keeps getting single-repository jobs. A step with `repos` of one entry is a
  multi-repository job: the form follows the step, not the number of repositories.

### Running and pushing

Every repository is cloned as a single one is today (every branch and tag, the whole history, no remote, no credential) into
`/work/<name>`. The agent's working directory is `/work`. When the turn ends the runner pushes **per repository, in the order of
the list, every local branch the agent created or moved, without force, with the token of that repository**: the push of today
(`docs/implementer.md`, "The git rules"), repeated. `profile.canPush` false pushes nothing anywhere. A repository whose clone or
checkout fails ends the turn before the agent starts and nothing is pushed.

### The result

`ImplementerResult.repos[]` (`ImplementerRepoResult`) has one entry per repository, in the order of the job, with the name, base,
branch, whether the turn **created** the branch, base commit, head commit, `pushed`, commits, files and the per-branch push
report. The old fields of `ImplementerResult` are copies of the **first** repository's entry, so a reader that does not know
`repos` still reads a valid single-repository result. A rejected push is reported per repository; the turn ends `push_rejected`
when in any repository the working branch was not taken, and says which one; what was pushed elsewhere stays pushed.

### The session and resume

The session keeps its repository list for answer turns and for `session.continue` (the repositories of a session are fixed when it
starts). A follow-up job carries `resume.repos`: one entry per repository, by mount name, with the branches the last turn pushed
and the branch HEAD was on; `branches` and `checkout` are then absent. Resume restores every repository.

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
- **The runner chooses the mount names.** Rejected: the app writes facts and the preface and must agree with the runner; the
  names are derived by one rule and carried in the job, and the runner checks them.
- **Opening a pull request for every repository with a changed branch, whatever the turn pushed.** Rejected: a repository with
  direct work or with nothing pushed has no pull request to open, and a skipped repository must be visible, not an error.

## Consequences

- **Easier:** a task across repositories is one step, one session, one conversation and one budget. A second round continues the
  branches of the first. A lane can work on a repository next to the ticket's, with a pull request in each.
- **Harder:** the job, the result and the resume each have two forms; the app builds a job per installation of tokens and the runner
  holds several repositories, mirrors and pushes. The result is larger (up to ten repositories, with the lists shortened per
  repository: 100 commits, 250 files and 25 branches), so the app's limit for the body of an Implementer report is raised in #1092.
- **The project repository is not required.** A lane that names its repositories does not need the project's one, and the
  repository of the run is just one more repository. This is the first lane feature that does not depend on
  `projects.repository_id`; the owner plans to drop the project↔repository tie later, and nothing new may depend on it.
- **Direct work on a base branch is allowed and unforced.** A protected branch refuses the push; the refusal is the turn's
  `push_rejected` for that repository, with the commits left on the agent's side only until the sandbox ends. A lane that must not
  touch a base branch names a branch.
- **Rollout.** Contract first (this record and #1091, no behaviour change: the parsers still refuse `repos` and no code sends or
  reads it), then the app and the runner in parallel behind `implementer_multi_repo`, then the pull request step and the lane
  editor. A runner and an app of different releases keep working because of the gate.
- **Cost.** More repositories mean more clone time and more disk in the sandbox (every repository is a full clone and a mirror
  of its own). The environment's size and the time limit are the brakes; no new limit besides ten repositories.

## Open questions

- **The agent's working directory.** `/work` is not a git repository. OpenCode stores a session per project and `opencode import`
  rewrites the project id (`docs/implementer.md`, "Follow-up turns: what was measured on a real VM"); whether a session in `/work`
  resumes as well as one in a repository has to be measured by #1093. Fallback: the working directory is the first repository's
  mount.
- **Reviews and ticket moves per pull request.** `ticket.requestReview` takes one pull request; a step that must ask for a review of
  each pull request of `pullRequests` needs the reserved `forEach` step. Until then it asks for the first.
- **The size of the report.** The per-repository bounds (100/250/25) are a guess from the single-repository bounds; #1092 sets the
  body limit from them and may tighten them after a measured turn on ten repositories.
- **`{{trigger.ticket.key}}`.** The epic's example uses it; the validator in #1092 must say which tickets have a key (a Jira issue
  does) and what a GitHub issue gives (its number).

## Out of scope

- Dropping `projects.repository_id`, or any change to which repository a project belongs to.
- Repositories of another provider than GitHub, or of another workspace.
- Pushing tags, deleting branches, force pushes: unchanged, never.
- A pull request step that works across steps (`forEach`), and review requests per pull request.
- Changing the profile's `canPush`: it applies to all repositories of a step alike.
