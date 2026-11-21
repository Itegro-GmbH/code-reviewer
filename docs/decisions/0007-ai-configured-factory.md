# 0007: An AI-configured factory

- **Status:** Accepted (2026-11-20). The **owner decisions** below are binding (epic #1103). The owner has answered the open questions
  that this record first put as proposals (decisions 10 to 15) and added the hosted runner types (decision 16); "Details the author
  added" are not decisions of the owner and stay for review with #1105.
- **Date:** 2026-11-20
- **Deciders:** the owner (target picture and decisions of 2026-11-20, epic #1103).
- **Implements:** epic #1103. This record and the documentation are #1104; the agent step settings inline and the removal of
  profiles are #1105, the manual and api trigger without input #1106 (merged, #1110), the lane versions with a change description and the read-only lane pages
  #1107, Setup and the control panel #1108.
- **Supersedes** (the owner decisions): the **profile** parts of `docs/profiles.md` and of the agent step in `docs/workflows.md`, the
  **environment** of a lane step (`docs/implementer.md`, "Environments"), and the **labels** as the way a lane step reaches a runner.
- **Amends** (decision 10): [ADR 0005](0005-runner-v2-one-dispatcher-contract.md) §1, "Labels": today only the platform
  identity may carry a label in `cr:`. See "Decisions 10 to 16 in detail", point 10, for what changes. The rest of ADR 0005 stays.

## Context

Everything a person can configure in the web app costs a page, its states, its errors, its translations and its tests, and the
person still has to know what a profile, a version, an environment and a label are before a lane runs. The factory has grown
four places to configure the same thing:

- **Profiles** (`docs/profiles.md`, #843): versioned data with harness, model, instructions, push right, a deprecated cost limit, a default
  result and an environment. A lane step only names one (`profile: "implementer@1"`), so reading a lane means reading the profile too.
- **Environments** (`docs/implementer.md`, "Environments"; `docs/runner.md`, "Environments of the kind `runner`"): a hosted VM with a size,
  a setup script and a network rule, or a set of **labels** that some runner must have. A step reaches a machine through its profile's
  environment, and a runner through labels that happen to match.
- **The lane builder** (`docs/workflows.md`, "The lane builder", #926): an editor of the lane document, with a validator beside it.
- **The Implementer form**, which takes a profile and an environment of its own.

The lane **format**, on the other hand, was made for an AI from the start: strict, closed objects, a validator that answers with every
error, a `path`, a stable `code` and the names that would have been valid (`docs/workflows.md`, "How an AI should use it: validate,
fix, save"). Today the lead agent already writes the lanes through the API. The owner's picture (2026-11-20) is that **nobody
configures lanes in the UI any more**: an AI writes the configuration as JSON through the API (later through an MCP server of the
factory), and the person uses the factory: links the accounts it needs, watches runs, starts lanes and answers an agent's questions.

The forces:

- **The server stays the only guard.** If an AI writes the configuration, nothing the AI writes may be trusted beyond what the validator and
  the integrations allow: which runners, keys and repositories exist, what a model costs, which servers an agent may reach
  ([ADR 0006](0006-multi-repo-agent-steps.md) took the same line for repositories).
- **A person must still understand what changed.** Without an editor nobody reads a diff of two JSON documents; somebody has to say, in
  words, what a version changed and why.
- **Existing lanes and runs must survive.** Lanes name profiles and environments today; runs have copied what they ran with.
- **A profile is only part of a step's meaning, and it can change underneath it.** A step that names `reviewer` says nothing about the
  model or the push right: those live in the profile, and the version the step resolves to can change after the lane was saved
  (`docs/workflows.md`, "Known limits": "Profiles are resolved per step").

## Owner decisions (2026-11-20, epic #1103)

These are decided: decisions 1 to 9 are the target picture, decisions 10 to 16 are the owner's answers of 2026-11-20 to the questions
this record put (10 to 15) and the hosted runner types (16). The details under them, and "Details the author added", are the author's way
to carry them out; where a detail contradicts a decision, the decision wins.

1. **Profiles are removed completely, everywhere.** Harness, model, may-push, cost limit and extra instructions move into the agent step
   of the lane document.
2. **No lane editor and no diff view.** A lane shows its name, its description and its versions. Every version from 2 on carries a
   description of what changed against the previous one, written by whoever saves it (the AI).
3. **Lanes always belong to a project.**
4. **A manual and an api trigger may have no input;** the run works on the project's repository and its default branch (merged with
   #1106, #1110; `WORKFLOW_RUN_PROJECT_REQUIRED` 422 and `WORKFLOW_RUN_PROJECT_INACTIVE` 409 when the project is missing or switched off).
5. **A hosted runner says only how many turns it can run at the same time** (its concurrency); its size is not configured, it is the
   property of its type (decision 16). Nothing else is configured there.
6. **Each agent step names one concrete runner** (a hosted runner of one type, such as "Vercel Sandbox 4 vCPU", or a self-hosted runner
   such as the DevBox). A lane does not ask for a runner by label, and there is no label matching for lane steps.
7. **Setup** only links integrations: GitHub, Jira, MCP servers, runners, LLM API keys. The **control panel** is for watching runs and
   starting lanes (start with inputs, answer an agent's questions, cancel).
8. **A lane is configured only as JSON through the API;** later an MCP server of the factory wraps the API. Until then the lead agent
   writes the lanes.
9. **The server stays the only guard:** the validator and the integrations (which runners, keys, repositories exist) bound what an AI can
   configure.
10. **A job reaches a concrete runner through the reserved internal label `cr:runner:<id>`.** This amends ADR 0005 §1. (Accepted
    2026-11-20.)
11. **The setup script and the network rule move from the hosted environment into the agent step** of the lane JSON. (Accepted
    2026-11-20.)
12. **Admins and Owners of the workspace may save lanes through the API (later through the MCP server); members may only start and
    observe.** (Accepted 2026-11-20.)
13. **A job whose runner is busy, at its concurrency, keeps waiting until the lane's budget or run time limit ends it.** The 30-minute
    "no runner" limit applies only when the runner is offline or not reachable. (Accepted 2026-11-20.)
14. **Runners may be renamed; the lane stores the runner's id and the UI shows the name.** (Accepted 2026-11-20.)
15. **Tasks started by hand outside a lane go away.** A small one-off lane, "Einmalige Aufgabe", with a text input replaces them.
    (Accepted 2026-11-20.)
16. **The provided Vercel Sandbox is not one hosted runner but several sandbox types; each type counts as its own hosted runner.** The
    types are the platform sizes the Vercel launcher can start. Each hosted runner is one type with a fixed size (a property of the type,
    not something a user configures) and its own concurrency. A step picks a concrete hosted runner, for example "Vercel Sandbox 4
    vCPU", exactly as it picks a self-hosted one. (Decided 2026-11-20.)

Sub-issues, in order: #1104 (this record and the docs), #1105, #1106, #1107, #1108. The MCP server is not part of the epic.

## Carrying out the decisions

Everything from here to "Out of scope" is how the decisions above are carried out. Decisions 10 to 16 are detailed first; the field names
and limits are #1105's. "Details the author added" are not decisions of the owner and are for review with #1105.

### Decisions 10 to 16 in detail

Put to the owner on 2026-11-20 and accepted (10 to 15) or decided (16) the same day; #1105 builds on them.

**10. Routing to a concrete runner with a reserved platform label `cr:runner:<id>`.** The decisions say a step names one
concrete runner; they do not say how a job reaches it. The decision keeps ADR 0005's one rule (a job requires labels, a dispatcher takes it
when it has all of them) and gives each self-hosted runner a label that only its own credential carries. This **amends ADR 0005 §1** and
**changes the code**; it is not "nothing changes". What changes:

- `callerLabels` in `app/src/db/repositories/jobs-claim.ts` (`:129-132`, `:136-150`): today a customer runner's labels are filtered with
  `!isReservedLabel(label)`, so it can never carry a `cr:` label. The claim of a runner credential would add `cr:runner:<the runner's id>`,
  derived from the credential row, **never from an announcement**. Registration keeps refusing a runner that announces a `cr:` label
  (`RUNNER_LABEL_RESERVED`); the exception for a `cr:` label derived from the credential is new and goes into ADR 0005's text.
- The **doorbell matcher** (ADR 0005: "workspace, every label, a ready harness") must know the label too, or the runner is not rung.
- `requiredLabelsOfTurn` (`app/src/runner-identity/labels.ts:90`) is built from a runner environment's labels or a hosted environment's
  size; neither exists for a step any more. It takes the runner the step names.
- The **exclusion of runner turns from the platform branch**: the claim of the platform identity excludes runner turns by
  `implementer_turns.environment_kind = 'runner'`. A turn with no environment needs another exclusion; the label rule already does it
  (a job requiring `cr:runner:<id>` is not contained in the platform's labels), but the legacy fallback of the query for jobs written before
  `required_labels` must keep working for turns that still have the old form.
- The Dispatcher itself (`dispatcher/src`) forwards labels and is **not expected to change**; #1105 confirms that.

The alternative, a column on the job for the named runner, would change the claim query, the doorbell and `requiredLabelsOfTurn` as well.
It is no cheaper; the label keeps the one rule of ADR 0005 and needs no new Dispatcher field. The owner accepted the label.

For a **hosted** runner the job still carries the size label `cr:size-<n>` of the runner's type, so the Dispatcher starts the right VM
(decision 16); the record of the runner the job was enqueued for is what the concurrency counts (see "Concurrency").

**11. The hosted environment's setup script and network rule move into the agent step of the lane JSON.** Today a hosted environment
holds a size, a setup script and a network rule (`docs/implementer.md`, "Environments"); the decision leaves the hosted runner with
its type's size and concurrency only. The step carries `setup` (the script text) and `network` (the rule) as optional settings, valid only
when the step's runner is hosted (the validator refuses them for a self-hosted runner: that machine's setup is its owner's). The
size is not a step setting: it is the size of the hosted runner's type (decision 16). The field names and limits are #1105's. The
migration copies a hosted environment's script and rule into the converted steps and maps its size to the hosted runner of that type
(see Migration), so nothing a lane relied on is dropped silently.

**12. Saving lanes through the API: workspace Admins and Owners.** Every member may save a lane today. With the settings inline, whoever
saves decides a step's model (and so its cost), push right and instructions, which a profile page used to gate by being a separate
object. So: `POST /workflows`, `PUT /workflows/<id>` and archive are for roles `owner` and `admin`; `validate` stays open to
members; starting a lane stays open to members as today. The MCP server of the factory, when it wraps these routes, keeps the same roles.

**13. A job waiting only because its runner is at its concurrency.** Today a turn of a runner environment is cancelled with
`no_runner_available` after `RUNNER_WAIT_DEADLINE_MINUTES` (30 minutes by default, `app/src/db/job-limits.ts:54`). That is right for a
runner nobody has and wrong for one that is online and busy. So: a job that waits **only** because its runner is at its
concurrency keeps waiting until the lane's own limits end the run (its budget, its run time limit, a cancel); the 30-minute
`no_runner_available` deadline applies only when the runner is **not reachable at all** (offline beyond the usual window, or revoked).
Whether a run-level time limit exists to end a long wait is for #1105 to confirm; if not, the cancel by a person is the limit.

**14. Runners may be renamed; a lane stores the runner id and displays the name.** The step holds the runner's **id** (`runner`), the
validator resolves it and its `available` lists id and name, and the pages show the current name, so a rename never breaks a lane. A
runner that was revoked and registered again (the normal flow for a DevBox) is a **new id**: a step that names the old id is
`runner_unknown` at the next save and `runner_not_found` for a run, until a new version names the new runner. This holds for a hosted
runner too, except that it is not revoked: it is created with the type and stays.

**15. No task started by hand outside a lane; the one-off lane "Einmalige Aufgabe" replaces it.** Today the Implementer start and
follow-up bodies take a profile or a `model` and an `environmentId`. With profiles and environments gone, a second shape of the same
settings would be a second place to configure the same thing, so the start by hand goes away. In its place there is a small built-in
lane, **"Einmalige Aufgabe"** (one-off task): a `manual` trigger with one required text input (the task), one agent step with a
runner and the step's settings, written to the project's repository like the other built-in lanes (`docs/workflows.md`, "Built-in
lanes"), so it is a lane of a project and starts from the control panel. What goes away: the Implementer start form and its profile and
environment selects, the `profile`, `model`, `costLimitCents` and `environmentId` of the start body, and the profile branch of the
follow-up body. Which runner and settings the lane's step carries, and what a follow-up of such a run is (a `session.continue` step or
a new run), are #1105's and #1108's to settle; they must not bring back a second configuration shape. Sessions and turns of earlier
tasks stay readable as history.

**16. Hosted runners are the sandbox types.** The provided Vercel Sandbox is not one runner with one size: each size the Vercel launcher
can start is its own **type**, and each type is its own hosted runner. The types are the platform sizes the launcher starts:
`PLATFORM_VCPUS` in `dispatcher/src/core/size-labels.ts` (1, 2, 4, 6, 8) held to `contracts/environment-sizes.v1.json` (`vcpus`, with
`environmentVcpus` naming the sizes an environment may use: 2, 4, 6, 8). **1 vCPU is refused by the launcher as
`sandbox_size_unsupported`** (it leaves the agent no memory), so in practice the types are **2, 4, 6 and 8 vCPU**. The list is held to
that contract file by a test (the code keeps a typed copy, and the migration its own frozen one, so a size added later is a new migration). A hosted runner is **one type with a fixed size** (a property of the type, not a setting
of the user) and **its own concurrency**; a step picks "Vercel Sandbox 4 vCPU" the way it picks a DevBox, and a step that needs more
memory names a bigger type.

### Details the author added (not decisions of the owner)

These follow from the decisions or from the code; they are for review with #1105.

**Settings of the agent step.** What a profile held moves into the step:

| What | Where it is after | Notes |
| --- | --- | --- |
| `harness` | the step | `opencode` when left out, `claude-code` as today (a runner only) |
| `model` | the step | the two shapes of today: `{"entryId"}` (a catalog entry) or `{"provider","model"}` (the workspace's own key) |
| `canPush` | the step | required, as in the profile: decide it. It decides whether the step yields `branch`, `commits`, `headCommit` and `pushed`, and whether the token can write |
| cost limit | the step (`costLimitCents`, optional) | lowers the cap of one turn below what is left of the lane's budget. The profile's value is deprecated and not read (#918), so it is **not** carried over by the migration |
| `instructions` | the step | the standing system-level text, appended last and unchanged, so the prompt cache hits across turns of one step as it does for a profile version |
| `defaultResult` | the step's `result` | a step that relied on its profile's default gets that schema written out |
| `description` (note of the profile) | the step's `description` | when the step has none |
| `environment` | the step's **runner** | see "Where an agent runs" |

The exact names, which fields are required, and the limits are the schema of #1105. The step already has `instruction` (the task) and the
profile had `instructions` (the standing text); the new field must not read as a typo of the other.

**Where the profile goes away.** The profile routes, the profiles page and its navigation entry, the `profile` field of the Implementer's
start and follow-up bodies and the profile select of the Implementer form, the profile references of the validator, the engine and the
built-in lanes, and the tables.

**A task started by hand (the Implementer start and follow-up) goes away** (decision 15). The start and follow-up routes that take a
`profile`, a `model` or an `environmentId`, and the Implementer form with its two selects, are removed in release B with the profile
tables; the one-off lane "Einmalige Aufgabe" takes their place. The `implementer_environments` table stays, but only as the hosted
runners (see "Where the hosted runner lives"). Release A keeps the routes working for tasks and follow-ups that exist when it ships.

**`session.continue`.** A step that continues another's session today gets the profile name and the environment as the identity of the
session (`check-steps.ts`, "A session belongs to one profile in one environment"), and the continuing **turn keeps** the model, the
environment, the profile and the result schema of the session's last turn (`engine.ts` `continueSessionOf`; `docs/workflows.md`,
"`session.continue`"). With inline settings a continuing step would carry a `model`, `instructions` or `canPush` that the turn then
ignores; a `canPush` that differs is security relevant (the write token). So the validator holds the continuing step to the session:
**it must repeat the same harness, model, `canPush`, `instructions` and runner as the step whose session it continues** (the cost limit
may differ; the turn takes the lower of it and what is left of the budget, as today). A difference is `session_target_invalid`, the code
the same check uses today, with the message naming the setting. A step that does not repeat them is refused, not inherited, so a
document says what it does.

**The change description.** `changeDescription` is required on `PUT /workflows/<id>`: 1 to 1,000 characters, not only white space, stored
with the version (a new nullable column `change_description` of `workflow_versions`, immutable like the version) and shown in the list of
versions with its author and time. A save without it is refused (`WORKFLOW_CHANGE_DESCRIPTION_REQUIRED`). Version 1 needs none; the
lane's description serves. It is **text for people**: never read by the validator or the engine, and `docs/workflows.md` says so to an AI.

**No lane editor.** The lane builder (`app/src/workflow-pages/builder/`) is removed. A lane's page shows its name, description and
versions. The page of a run keeps its flow view, which is a picture of what ran and not an editor.

**Lanes always belong to a project.** The service never creates one without a project. The schema: `workflows.project_id` stays
**nullable**, because an archived lane that no project could take has a null project **by design** (`app/src/db/schema.ts`, comment on
`WorkflowsTable.project_id`; the migration `20261107190000_project_ticket_source`). Release B adds a check constraint
`archived_at is not null or project_id is not null`: a lane that is not archived has a project. `SET NOT NULL` is not used. The paths for
"a lane without a project" in the routes, the run start and the documentation go.

**A manual or api trigger without `input`** (decision 4; merged with #1106, #1110; `docs/workflows.md` on `development` has the wording). A
manual **and** an api trigger may declare no `input`. Its run starts with nothing and **works on the project's repository and its default
branch**; a lane without a project is `422 WORKFLOW_RUN_PROJECT_REQUIRED`, and one whose project is switched off is
`409 WORKFLOW_RUN_PROJECT_INACTIVE`. The run reads **`project.ticketSource.repositoryId`**, as `withProjectRepository` does today (`workflow-runs/service.ts`),
not `projects.repository_id` (ADR 0006 notes that the tie is planned to go; nothing new is built on it). For such a run `trigger.input` is
the empty object, so a step cannot reference `trigger.input.repo` (the validator refuses it as an unknown field); the repository is
reached through `trigger.repo`, as for any run. A trigger that declares an input keeps the rules of today for a `ticket` or a `repo` it declares (`repo_required`: the ticket is required, `repo` is a required text). `validate.ts` applies the rule to manual **and api** triggers alike, so the rule of an omitted
`input` is the same for both. **Amended in #1105 (the one-off lane, decision 15):** an input that declares **neither** `ticket` nor `repo` is accepted and works, like a
trigger without `input`, on the project's repository and its default branch (`workflow-runs/service.ts` reads the project's repository whenever the schema has neither); the one-off lane's
required text `task` needs it, and "must declare `ticket` or `repo`" would have forced a repository field on a lane that has the project's.

**Names of runners.** Among **non-revoked** runners of a workspace a name is unique without regard to case: a partial unique index on
`runners (workspace_id, lower(name)) where revoked_at is null`, so that registering a DevBox again after revoking it keeps its name. A
revoked runner's name is free. Existing duplicates are made unique by the migration (a suffix with a short id) and listed.

### Where an agent runs

A **runner** is whatever runs an agent turn. Two kinds, both integrations that Setup links:

- **A hosted runner** is one **sandbox type** of the provided Vercel Sandbox (decision 16): "Vercel Sandbox 2 vCPU", "… 4 vCPU", and so
  on. Its **size comes from its type** and is not configured; it states **only how many turns it can run at the same time** (decision 5).
  The setup script and network rule of the step apply (decision 11).
- **A self-hosted runner** is a machine the customer registered (`docs/runner.md`). It announces its name, its harness entries and its
  limits, among them `parallelRuns`.

**Where the hosted runner lives.** Nothing holds a hosted runner's name and concurrency today: a hosted environment is a row of
`implementer_environments` (name, size, script, network), a self-hosted runner a row of `runners`. **`implementer_environments` with
`kind = 'hosted'` is kept and reduced to `name`, the type's size (`vcpus`) and `concurrency`** (`concurrency` is a new column of release
A; `setup_script`, `network_*` and `labels` are no longer read and are dropped in release B), and `runners` holds the self-hosted ones.
No new table. The size is **fixed per type**: the `vcpus` of a hosted runner is not editable, and there is **exactly one hosted runner
per type per workspace** (a unique index on `(workspace_id, vcpus)` where `kind = 'hosted'`). The names are the types' ("Vercel Sandbox
4 vCPU"); a hosted runner is not renamed or deleted by a user, only its concurrency is set.

**Which types exist in a workspace: all supported types, created by the migration.** The migration creates a hosted runner for **every
type the launcher supports** (today 2, 4, 6 and 8 vCPU) in **every workspace**, each with a **default concurrency set by the operator**
for the migration (one number for all, or one per type: the operator's choice; **not** the Dispatcher's `maxRunning`, which is a pool-wide
number over all workspaces). Creating only the types in use would make the first step on a new type fail until somebody creates the
runner, for no saving: a row is a name and a number. A size the platform adds later is a new type that the same code creates for every
workspace (at start-up or by a migration, #1105's choice); a workspace created after the migration gets its runners with the workspace.
**Uniqueness of the name across both tables** cannot be a database constraint without a third table; each table gets its own partial
unique index (non-revoked runners; non-archived environments) and the service that creates or renames a self-hosted runner takes one lock
per workspace and checks both, so a runner cannot take a type's name. The validator reports `runner_unknown` with every runner's id and
name in `available`, hosted types first.

**Concurrency is new claim-side logic.** It is **not** what the app does today. `maxRunning` is sent by the **caller**: the
Dispatcher's own configuration (`DISPATCHER_MAX_RUNNING`, `DISPATCHER_APPS[].maxRunning`, `dispatcher/src/config.ts`) and counted per
`X-Runner-Id`, i.e. per pool (`runningInPool`, `runner-jobs-repository.ts`). `parallelRuns` is only stored in `runners.limits`
(`runner-identity/announcement.ts:43`); nothing on the server reads it for the claim. All hosted jobs of **all workspaces** go to one
Dispatcher pool, and two hosted environments of one workspace require the same labels today. So a count **per named runner** does not
exist and is built: the job records the runner it was enqueued for (a self-hosted runner: the label `cr:runner:<id>` of its
`required_labels`; a hosted one: the same record, which the platform identity takes because the runner is hosted, with how the query says
so being #1105's), the claim counts the running jobs of that runner and answers `204` at or above its concurrency (`parallelRuns`,
held within the operator's maximum, for a self-hosted runner; the stored `concurrency` for a hosted one), and the job waits (decision
13). **Concurrency is counted per hosted runner, that is per type per workspace**: a workspace's four 2 vCPU turns do not use its 8 vCPU
allowance. The job still carries the **size label `cr:size-<n>`** of its type, so the Dispatcher starts the right VM. The Dispatcher's
`maxRunning` stays as the **pool-wide** safety cap above all workspaces and types; a hosted runner's concurrency is a workspace's share
within it.

**What the validator checks.** The step's runner exists and is not revoked and can run what the step asks for: the rules
`runner_needs_own_key`, `harness_needs_runner` and `no_runner_announces` stay, at the step's runner (`no_runner_announces` over the
runner's own announcement instead of the labels of an environment).

## Alternatives considered

- **Keep profiles as the shared, versioned way to reuse a setup.** Rejected by the owner: a second place to read, a version that changes
  beneath a lane, and a UI to manage it. An AI writes a step in full as easily as a name.
- **Lane-level defaults for the agent settings (one block, steps override).** Fewer repeated lines, but two places again, and the question
  of which wins. Not now; a document that repeats a model in five steps is acceptable and visible.
- **Keep the lane builder, but read-only, with a diff view.** The page and its state are the cost this decision removes; a description
  written by the author is what a person needs.
- **Keep matching runners by label and let a step name the labels.** Rejected by the owner. An AI cannot know what labels mean on a machine
  (`gpu` may be a different machine tomorrow); a step that names a runner fails clearly when it is gone.
- **Route a named runner by a new column instead of a reserved label** (decision 10). Changes the same parts of the claim as the label does
  and adds a field; see decision 10.
- **A schema version 2 of the lane document** instead of making `profile` optional. See "The schema version" below.

## Consequences

- **Easier:** one place to read a lane, with no second lookup. No profile or builder pages to build, translate and test. A change of a
  lane is one new version with a sentence. An MCP server later is a thin wrapper over routes that already are the interface.
- **Harder:** a lane is longer (each step carries its settings), and changing a model that many steps use means editing many steps; the
  author (an AI) does it and says so in the change description. The person can no longer fix a lane in the browser: they ask the AI.
  Only Admins and Owners save lanes (decision 12), so a member cannot decide a step's model, push right or instructions; they ask one.
- **No version changes by itself any more.** An unpinned `"profile": "implementer"` followed the newest version; an inline step is what
  it says. The migration pins to the version that exists when it runs.
- **A runner that goes away breaks a lane visibly.** A step on a revoked runner is `runner_unknown` at save and, for a saved version, a
  failed step (`runner_not_found`) instead of a turn that waits for labels nobody has.
- **A fleet of runners sharing a label no longer spreads load by itself.** Today a step that asks for `linux` runs on any of N machines;
  with a named runner it runs on one. Spreading load becomes the author's choice of runner per step.
- **Hosted capacity is per type** (decisions 5 and 16). A workspace sets the concurrency of "Vercel Sandbox 2 vCPU" and of "… 8 vCPU"
  separately, so it can have a few big VMs and many small ones at once; a step that needs more memory names a bigger type, and a
  type's size cannot be changed, only another type named. The operator's pool-wide cap still bounds all types of all workspaces.
- **A busy runner makes a job wait, not fail** (decision 13): a run on a full runner stays queued until its budget or run time limit
  ends it, so a limit that is too generous keeps a run waiting for a long time; only an offline or unreachable runner ends it after 30
  minutes.
- **No second way to start an agent** (decision 15): a quick task is a run of the one-off lane, so it needs a lane in the project and
  has its settings written in that lane.
- **Cost and security are unchanged in kind:** the lane's budget, the turn time limit, the operator's maximum, the managed-model rules and
  the token rules (a step that may not push gets a read-only token) all stay, and the server enforces them at save and at run time.

## Migration path

Two releases, expand first and contract one release later (the project's rule for the database: expand-only migrations, ADR 0001).
Runs are never rewritten. **Release B ships only when the list of release A is empty** (below), so no lane breaks silently.

**Release A: expand, and write the new form.**

1. The schema and the validator accept the **inline settings and `runner`** next to the old `profile` and `environment`. A step with
   both a `profile` and inline settings is refused (`profile_with_inline_settings`). The profile and environment **routes stay as they are**
   in release A, so a lane that could not be converted keeps working; the pages and navigation entries for profiles, environments and the
   builder go with their sub-issues (#1105, #1107, #1108), the routes in release B. `workflow_versions` gets the nullable
   `change_description` column in the same release, so the migration can write one.
2. **A data migration gives every lane that is not archived a new version with the profile values inline**, only the **current** version.
   For each agent step: the profile reference (`name`, or `name@n`) is resolved **now** (the newest version for a bare name, as the engine
   would at the first run); `harness`, `model`, `canPush`, `instructions` are copied; `defaultResult` becomes the step's `result` if the
   step declared none; the profile's `description` becomes the step's if it had none; `costLimitCents` is **not** copied (a value the engine
   never read must not start limiting turns). The step names its **runner**, mapped as in step 3. The new version's description is
   "Profile values and runner written into the steps (ADR 0007)", and its author is the author of the version it replaces. Older versions
   stay as saved.
   **The converted document is validated before it is saved**, by the same validator a save uses (including the rules at the step's
   runner, such as `runner_needs_own_key`). If it has **any** issue, no version is written: the lane keeps its current version and is
   **listed** with the issue codes. A lane that cannot be converted at all (a profile that is archived or gone, a runner it cannot name,
   one of the cases in step 3) is listed the same way. Nothing is guessed.
3. **Environments to runners.**
   - A **hosted** environment with size N becomes a step on the workspace's **hosted runner of type N vCPU** (the runners are created by
     the migration, one per supported type, each with the operator's default concurrency; **not** the Dispatcher's `maxRunning`, which is
     a pool-wide number over all workspaces). Its setup script and network rule are copied **into the converted step** (decision 11).
     The size is kept by the type, so a lane that ran on 4 vCPU still does. Only an environment whose size **no type offers** (1 vCPU,
     which the launcher refuses, so an environment could not have it for a task) is **not converted**: the lane is listed.
   - A **runner** environment (labels) becomes the self-hosted runner whose labels include all of the environment's labels **only if exactly
     one runner of the workspace matches**. With **none or several** the step is not converted and the lane is listed with the candidates.
     Several matches are the usual case of a fleet sharing a label, and picking one would quietly turn "any of N" into "one": **the owner
     decides** which runner (or whether to split the lane), and the lead agent rewrites the lane. The migration never picks.
   - Duplicate runner names among the non-revoked runners of a workspace are made unique (a suffix with a short id) and listed.
4. **Lanes without a project.** Archived lanes with a null `project_id` are left as they are (by design, see above). A lane that is **not**
   archived and has none is archived and listed, as the migration of #937 did; this is what lets Release B add the check constraint.
5. **In-flight and old runs are untouched.** A run holds the version of the lane it started with (`workflow_runs.workflow_version`), so a
   run that started before the migration finishes on the old document: the engine reads **both forms** in release A (`resolveProfile` and
   the environment lookup stay for a step in `profile` form). A step run keeps `profile_name`, `profile_version` and its turn's copy
   (`implementer_turns.profile_*`, `environment_*`): the run page shows them as before and nothing is rewritten. A new turn of an inline
   step records no profile; its copy of the harness, the push right and the instructions is the same columns, filled from the step, so
   the claim and the runner read one shape.
6. **The wire contract is not changed in this epic.** The job's `profile` object (`ImplementerProfile`, `implementer_profile`) stays: the
   app fills it from the step, with the lane's name (as a slug, because `name` takes `^[a-z0-9][a-z0-9_-]{0,63}$`; a name with nothing usable is `lane`) and version as `name` and `version`. Renaming it would need a runner release and
   gains nothing for the person; it can follow later.

**How steps 2 to 5 were carried out (#1105, third slice).** The data migration of steps 2 to 4 is an **app-side job, `pnpm lanes:convert`**
(`app/src/lane-conversion/`), not a SQL migration: it needs the validator of a save and the repositories, and a migration is frozen and
imports none of that (`db/migrations/support`). It is re-runnable (a lane already in the new form is skipped), has a dry run, holds an advisory
lock and writes the **list of release A** as a report (lines, or JSON with `--json`); its exit code is 0 only when nothing is left, and
**only a real run over all workspaces** that exits 0 is the precondition of release B (a dry run and a `--workspace` run are not;
`docs/factory-bring-up.md`, "Converting the lanes"). One exception to "validated by the same validator as a save": the job does **not**
run the model rule (`model_not_allowed`), which needs the workspace's decrypted keys and the app's catalog wiring; it lists every converted
lane with the warning `model_unchecked` instead. It also converts a step that already has settings of its own
but names an `environment` and no `runner` (written between #1111 and #1114). The names of runners were made unique by the migration of the
hosted runners (a unique index keeps them), so the job finds none to rename. The built-in lanes are written in the inline form: the settings
of their two agents are taken from the profiles `implementer@1` and `reviewer@1` and the runner is the hosted runner of 4 vCPU; where a new
workspace gets its model once the profiles are gone is for release B, which must give the built-in lanes another source of settings first
(after it `copyBuiltIn` can never succeed for a workspace without those profiles). Because the copy goes through the save path, a built-in
lane can now also be refused with `model_not_allowed`; project creation reports it per lane like `profile_unknown`. The engine reads both forms (step 5): nothing of it changed.

**The schema version.** `contracts/workflow.v1.json` has `profile` in `required` (`:123`). The author's detail (not a decision of the owner): **the document stays version 1**.
Release A is additive: the new settings are optional properties and `profile` leaves `required`; the validator requires either `profile`
or the inline settings (together with `profile_with_inline_settings`). In release B the validator, not the schema, refuses `profile` and
`environment` on a save (`profile_removed`, `environment_removed`). The schema keeps them as deprecated properties, so every version
ever stored stays a valid v1 document and nothing needs a second reader. A bump to `version: 2` would need the app to read and migrate
every stored version of both forms for the sake of a rule the validator already holds; #1105 can still choose it.

**Release B, one release later: contract.** Precondition: the list of release A is empty. Every lane on it has been rewritten into the new
form by a saved version (the lead agent writes it, the owner decides where a choice is needed) or archived, and the release's migration
**fails loudly** while any lane that is not archived still holds `profile` or `environment` in its current version, instead of breaking it.

1. The validator refuses `profile` and `environment` in a step on a save (`profile_removed`, `environment_removed`, with a message naming
   the field to use), and the engine's `profile_not_found` / `environment_not_found` paths for the old form go. Stored versions older than
   the migration stay readable as documents but cannot be saved again as they are.
2. The **profile tables** `profiles` and `profile_versions` are dropped (and `workspace-erasure-repository.ts` stops listing them), as are
   the profile routes, the pages, the start and follow-up routes and the form of tasks started by hand (decision 15),
   and the capability routes. The columns of past turns and step runs stay: they are history.
3. `workflows` gets the check constraint `archived_at is not null or project_id is not null`.
4. The script and network columns and the labels of `implementer_environments` are dropped once nothing reads them; the table and its
   rows of the kind `hosted` (name, size, concurrency) stay as the hosted runners, and rows of the kind `runner` are dropped with the
   lane steps that named them (self-hosted runners live in `runners`). The turn copies (`environment_*`) stay.
5. The labels a runner announces stay in the registration (they are shown on the runners page) and stop being a routing input for lane
   steps.

## Documentation

The documentation is part of #1104. Where a document describes behaviour that this record supersedes, a **Superseded** note sits directly
under the heading it concerns and says "This section" or "This page". What stays to be rewritten with the code, by sub-issue:

- **#1105:** `docs/profiles.md` (whole page), the agent step and "Known limits" of `docs/workflows.md`, "Environments" and "Profiles" of
  `docs/implementer.md`, "Routing" and "Validator rules" of `docs/runner.md`, the built-in lanes. **Done in release A:** `profiles.md` is a short redirect page that keeps the routes and error tables until release B;
  the others carry Amended notes and the final wording, and the one-off lane is under "Built-in lanes".
- **#1106:** the manual trigger in `docs/workflows.md` (the trigger table, `repo_required`).
- **#1107:** `docs/workflows.md` "The lane builder", the lane page under "The pages", the intro, and the run page text that names the
  profile.
- **#1108:** Setup and control panel pages (`docs/workflows.md`, "The pages"; the navigation).

`docs/dispatcher.md`, `docs/factory-bring-up.md`, `docs/implementer-smoke-test.md` and `docs/jira-cloud-setup.md` name a "container
profile" or an Atlassian profile, not a lane profile: nothing to change.

## Touch points (where the code reads profiles and environments today)

For the next sub-issues. Line numbers are those of `development` at the time of this record. The Dispatcher itself (`dispatcher/src`)
reads no profile and no label of a lane: only its copies of the contracts mention them; the job is built by the app in `claim.ts`.

**Lane format and validator**

- `contracts/workflow.v1.json:123,134` (`profile` is required in the agent step), `:139` (`environment`, deprecated).
- `app/src/workflows/check-steps.ts`: `findProfile` `:217`; `environmentOfStep` `:240`; the session identity (profile name and environment)
  `:270` and its check `:851`; push facts by the profile `:295,:319`; the allowed keys `:444`; `checkProfile` `:463`;
  `checkProfileEnvironment` `:565`; `checkRunnerRules` `:616` (`runner_needs_own_key`, `harness_needs_runner`, `no_runner_announces`,
  with `announcedBy` over the environment's **labels**, `:651`); the calls `:1097,:1104,:1105`.
- `app/src/workflows/resolver.ts:14-65` (`ProfileVersionFacts`, `ProfileInfo`, `profiles()`, `archivedProfiles`), `:101,:104`
  (`PROFILE_REF`, `parseProfileRef`, also used by the Implementer bodies); `workflows/profile-refs.ts` (whole file);
  `workflows/service.ts:10,41,148,216-230` and `workflows/shared.ts:9,34` (the resolver is built from the profile repository);
  `workflows/issues.ts:51,79-97` (the codes `profile_unknown`, `profile_archived`, `profile_version_unknown`, `environment_mismatch`,
  `environment_required`, `runner_needs_own_key`, `harness_needs_runner`, `no_runner_announces`); `workflows/scope.ts:40-47`;
  `workflows/facts.ts`; `workflows/validate.ts:180-225` and `:421` (the manual **and api** trigger's `repo_required`, for #1106).
- `app/src/workflows/built-in-lanes.ts:5,108-139,348-382,399-402`: the three built-in lanes name `implementer@1` and `reviewer@1`
  (`:117,:138,:381`) and an environment that the caller passes in.

**Engine**

- `app/src/workflow-runs/engine.ts`: dependencies `:121-122` (profiles, environments); `resolveProfile` `:760-772`; its use `:808-819`
  and `:945-990` (`profile_not_found`); the turn of a step `:1203-1307` (the environment by name, case ignored, `:1219-1247`,
  `environment_not_found`, `environment_mismatch`); a continuing session `:1326` (`continueSessionOf`); `:1463-1474`.
- `app/src/workflow-runs/service.ts:85,357` and `:476-490` (`withProjectRepository`, the project's repository from
  `ticketSource.repositoryId`); `workflow-runs/shared.ts:14,232`; `workflow-runs/turn-facts.ts:128,375` (harness and push right read from
  the turn's profile copy); `workflow-runs/errors.ts:106-120`.
- `app/src/db/repositories/workflow-runs-repository.ts:102,252,704,1411,1449`; `db/schema.ts:1573` (`profile_name`, `profile_version`
  of a step run).

**Implementer (a task started by hand, which goes away with decision 15, and the copy a turn holds, which stays)**

- `app/src/implementer/start-input.ts:233-257`, `continue-input.ts:58-86` (the `profile` of a body, `not_with_profile`);
  `service.ts:124,140,181-195,458-503,522`; `service-support.ts:175-263` (`copyProfile`, `requireRunnerForHarness`, `resultOfProfile`);
  `follow-up.ts:62,114,206,317-336,419-425,547,677,806`; `shared.ts:107`; `errors.ts:56,98,120-128`.
- `app/src/db/repositories/implementer-repository.ts:161-174,528-543,652-663`, `db/schema.ts:1212-1250` (`implementer_turns.profile_*`,
  and `environment_*` at `:1165-1206`); `jobs/job-types.ts:139,177`; `db/repositories/jobs-repository.ts:706,829`.

**The claim and the job (app side; the Dispatcher forwards)**

- `app/src/runner-api/claim.ts`: the turn's profile `:425-453`, `:1137`, `:1180-1187`; the feature gate `implementer_profile`
  `:1306-1309`, `:1770`; push right and read-only token `:1395,:1411`; the job's `profile` object `:1517-1527`, `:1907-1933`;
  Claude Code `:1681,:1751,:1823-1882`; the **labels** of the job `:1714,:2051-2068` (`sizeLabelOf`); `runner-api/contract.ts:61-63,588`;
  `runner-api/report.ts:70,409`; `runner-api/multi-repo.ts:222`.
- Contracts that carry the profile: `contracts/runner-api.v1.json:88,673` and `app/src/contracts/runner-api.ts:51,372,1493`,
  `contracts/worker-api.v1.json`, `app/src/contracts/worker-api.ts:232,1065`, the copies in `dispatcher/src/contracts/`, and the
  runner: `runner/src/code_reviewer_runner/job.py:138-149,426`, `implementer/runner_profile.py`.
- `app/src/runner-identity/` (`harness.ts`, `access.ts` `demandOfProfile`, `announced.ts`, `online.ts`) and
  `db/repositories/runner-jobs-repository.ts:96-116` (the harness read from the turn's profile copy).

**Labels, routing and concurrency (where a runner is chosen today, and what decisions 10, 13 and 16 change)**

- `app/src/runner-identity/labels.ts`: `hostedLabels`, `PLATFORM_LABELS` `:36-52`, `isReservedLabel`, `hasAllLabels` `:78`,
  **`requiredLabelsOfTurn` `:90`**. It is called when a turn is enqueued: `db/repositories/jobs-repository.ts:751,:879`
  (`required_labels`; a review has `hostedLabels` at `:575`).
- `app/src/db/repositories/jobs-claim.ts:129-153`: `callerLabels` (a customer runner's labels **without** any `cr:` label, `:129-132`),
  the claim query, `required_labels` against the caller's labels, with the **fallback for jobs written before the column** (the legacy
  environment labels of the turn) and the platform branch's exclusion by `implementer_turns.environment_kind = 'runner'`;
  `runner-jobs-repository.ts` (the runner turns a runner may take; `runningInPool` `:1078,:1197`); `runner-api/claim.ts:2250-2286`
  (`maxRunning`, sent by the caller, counted per `X-Runner-Id`); `runner-identity/announcement.ts:43` (`parallelRuns`, stored in
  `runners.limits`, read by nothing in the claim); `dispatcher/src/config.ts` (`DISPATCHER_MAX_RUNNING`, `DISPATCHER_APPS[].maxRunning`).
- `app/src/runner-api/registration.ts` and `contracts` (`RUNNER_LABEL_RESERVED`); the doorbell matcher of ADR 0005 (`job_rings`).
- `app/src/implementer/environments/` (`input.ts:19-120` labels of the kind `runner`, `service.ts:26-84`, the page and its panel under
  `ui/`), `db/schema.ts:1366-1386` (`implementer_environments`), `:1200-1206` (the turn's copy of kind and labels), `db/schema.ts:1621`
  (`runners`: **`name` is not unique**, only `runners_workspace_idx` and the credential index exist; labels, manifest, limits,
  `last_seen_at`, `revoked_at`).
- **Hosted runner types (decision 16):** `dispatcher/src/core/size-labels.ts` (`PLATFORM_VCPUS`, `vcpusOfSizeLabel`),
  `contracts/environment-sizes.v1.json` (`vcpus`, `environmentVcpus`, `agentMemoryMb`), `dispatcher/src/launchers/sandbox.ts`
  (`SANDBOX_VCPUS`, the launcher's `sandbox_size_unsupported`), `app/src/implementer/environments/limits.ts` (the app's copy, held to
  the file by `limits.test.ts`), the size label of the job (`sizeLabelOf` in `runner-api/claim.ts`).
- The wait: `runs/run-view.ts:219,1044` ("Waiting for a runner with labels …"), `db/job-limits.ts:54-56` and `:122` (`no_runner_available`
  after `RUNNER_WAIT_DEADLINE_MINUTES`).

**Pages and UI**

- The profile module: `app/src/profiles/` (`service.ts`, `http.ts`, `validate.ts`, `limits.ts`, `errors.ts`, `shared.ts`, `ui/`),
  `db/repositories/profiles-repository.ts`, the routes `app/src/app/api/w/[workspace]/profiles/` and
  `app/src/app/(app)/w/[workspace]/profiles/page.tsx`, `capabilities/routes.ts:265,284,385-389`, the navigation `shell/nav-items.ts:61`,
  `db/repositories/workspace-erasure-repository.ts:202-204`; migrations `20261104150000_create_profiles`,
  `20261104160000_add_implementer_turn_profile`, `20261105230000_add_profile_harness`, `20261107180000_add_profile_environment`.
- The lane builder: `app/src/workflow-pages/builder/` (`inspector.tsx:63,222-261,301,419,451-461`, `builder.tsx:84,98,241,404`,
  `document.ts:354-372`, `describe.ts:135`, `problems.ts:54-80`, `copy.ts:158`), `workflow-pages/pages.tsx:13,64-113,221`,
  `workflow-pages/messages.ts:124,432,509`, `run-detail.tsx:194`, `step-panel.tsx:224`; the lane page
  `app/src/app/(app)/w/[workspace]/workflows/[workflowId]/page.tsx`.
- Elsewhere: `issues/start-lane-dialog.tsx:6`, `projects/ui/new-project-dialog.tsx:10`, `projects/ui/cockpit-messages.ts:12,82` (the
  built-in lanes "need the profiles implementer and reviewer"), `implementer/ui/implementer-form.tsx:69-250` and `ui/api.ts:26-103`
  (the profile select and its two reads), `ui/continue-form.tsx:498`, `ui/model-picker.tsx:49`.

## Open points

- **The one-off lane "Einmalige Aufgabe"** (decision 15) — **settled in #1105 (release A).** The built-in lane `one-off-task` (English name "One-off task") has a manual trigger with one required text `task`
  (8,000 characters at most), one agent step `implement` in the inline form (the settings of `implementer@1`, may push, on the workspace's hosted runner of 4 vCPU, the same source as the
  other built-in lanes) and the pull request step; it works on the project's repository and its default branch. A new project copies it (ticked by default; offered for Jira projects too);
  a project that exists gets it by saving the document through the API (`docs/workflows.md`, "Built-in lanes"), because the lanes are written through the API and the copy needs the workspace's
  own model and runner id. **A follow-up of such a run is a new run of the lane** (the task names the earlier branch); there is no `session.continue` step. An optional base or branch input is not
  part of it. The old follow-up route and the "Continue" form of earlier tasks stay until release B.
- **A run-level time limit for a waiting job** (decision 13): #1105 confirms that a run time limit exists to end a long wait; if it does
  not, the cancel by a person is the limit.
- **Creating the hosted runners of a new type** (decision 16): by a migration or at start-up, and the default concurrency per type, are
  #1105's and the operator's.
- **Order of #1105 and #1107.** The migration writes `change_description`; the column is in release A so that stays true whichever merges
  first, but #1105 must not ship the migration before it.

## Out of scope

- The MCP server of the factory that wraps these routes (a later epic).
- The runner's contract with the Dispatcher, other than which labels a job of a lane step requires.
- Changing the lane's budget, the turn time limit or the operator's maximum.
- A shared library of agent settings or lane templates beyond the built-in lanes.
- Dropping `projects.repository_id` (ADR 0006).
