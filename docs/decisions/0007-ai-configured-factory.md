# 0007: An AI-configured factory

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** the owner (target picture and decisions of 2026-11-20, epic #1103)
- **Implements:** epic #1103. This record and the documentation are #1104; the agent step settings inline and the removal of
  profiles are #1105, the manual trigger without input #1106, the lane versions with a change description and the read-only lane pages
  #1107, Setup and the control panel #1108.
- **Supersedes:** the **profile** parts of `docs/profiles.md` and of the agent step in `docs/workflows.md`, the **environment** of a
  lane step (`docs/implementer.md`, "Environments"), and, for the jobs of lane steps, the **routing by labels** of
  [ADR 0005](0005-runner-v2-one-dispatcher-contract.md) (a job requires the concrete runner its step names instead of labels). The
  rest of ADR 0005 (one claim contract for every Dispatcher, the reserved namespace `cr:`) stays.

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
- **Profiles are only part of a lane's meaning.** A step that names `reviewer` says nothing about the model or the push right, and the
  version it resolves to can change underneath it (`docs/workflows.md`, "Known limits": "Profiles are resolved per step").

## Decision

### Two areas for the person

- **Setup** only links **integrations**: GitHub, Jira, MCP servers, **runners** (hosted and self-hosted, below) and LLM API keys. Each is
  something that exists outside the factory and that a person has to authorise, install or pay for. Setup has no page that says how a lane
  behaves.
- **The control panel** is for **running** the factory: watch runs, start a lane (with its inputs, if it has any), answer an agent's
  question (`docs/workflows.md`, "A question: `done` or `ask`"), cancel and discard runs, pause.
- A lane is **configured only as JSON through the API**, by an AI: validate, fix, save (`POST /workflows/validate`, `POST /workflows`,
  `PUT /workflows/<id>`). **Later** (not in epic #1103) an MCP server of the factory wraps the same routes; until then the lead agent
  calls them.
- **The server is the only guard.** The validator and the integrations bound what an AI can configure: a runner, a key, a model, a
  repository or an MCP server that the workspace has not linked is a validation error, with the names that exist in `available`.

### Profiles are removed, everywhere

A profile is not replaced by something else that is shared. **What a profile held moves into the agent step of the lane document**:
harness, model, whether the step may push, a cost limit for the turn, and the standing instructions. The step is then the whole truth about
who works: a reader (a person looking at one version, or an AI) sees it without a second lookup, and nothing changes underneath a saved
version.

| What | Where it is after | Notes |
| --- | --- | --- |
| `harness` | the step | `opencode` when left out, `claude-code` as today (a runner only) |
| `model` | the step | the two shapes of today: `{"entryId"}` (a catalog entry) or `{"provider","model"}` (the workspace's own key) |
| `canPush` | the step | required on purpose, as in the profile: decide it. It decides whether the step yields `branch`, `commits`, `headCommit` and `pushed`, and whether the token can write |
| cost limit | the step (`costLimitCents`, optional) | lowers the cap of one turn below what is left of the lane's budget; the profile's value was deprecated and not read (#918), so it is **not** carried over (see Migration) |
| `instructions` | the step | the standing system-level text, appended last and unchanged, so the prompt cache hits across turns of one step as it did for a profile version |
| `defaultResult` | the step's `result` | a step that relied on its profile's default gets that schema written out |
| `description` (note of the profile) | the step's `description` | when the step has none |
| `environment` | the step's **runner** | see "Where an agent runs" |

The exact names of the fields, which are required, and the limits are the schema of #1105 (`contracts/workflow.v1.json`). One thing to
settle there: the step already has `instruction` (the task) and the profile had `instructions` (the standing text); the new field must
not read as a typo of the other.

**Everywhere** means: the profile routes, the profiles page and its navigation entry, the `profile` field of the Implementer's start and
follow-up bodies and the profile select of the Implementer form, the profile references of the validator, the engine and the built-in
lanes, and the tables. Sessions that used to go on only with the same profile name (`session.continue`) go on with the same **harness
and runner**: the session holds that setup's files and conversation. The model, the instructions and the result schema of a continuing
turn are those of the session's last turn, as they are today.

### Where an agent runs: one concrete runner per step

A **runner** is whatever runs an agent turn. There are two kinds, and both are **integrations** that Setup links:

- **A hosted environment** is an integration that states **only how many turns it can run at the same time** (its *concurrency*). It has
  no size, no setup script and no network rule to configure: the platform runs it on its standard size (the operator's configuration of
  the Dispatcher for the kind), and nothing else is a setting of the workspace. A workspace has at least one (the platform's hosted
  runner); it is named like any other runner.
- **A self-hosted runner** is a machine the customer registered (`docs/runner.md`). It announces its name, its
  harness entries and its limits, among them `parallelRuns`, which is its concurrency.

**A lane does not ask for a runner by label.** Each agent step names **exactly one concrete runner**: a hosted environment or a
self-hosted runner, by name. There is no set of labels to match, no environment of the workspace between the step and the machine, and no
"first environment by name". The name is unique in the workspace, whichever kind it is, compared without regard to case (a registration
that takes a name already used is refused; see Migration for the runners that exist). The validator checks that the runner exists, is not
revoked, and can run what the step asks for (the harness, the model and the key: the rules of `runner_needs_own_key`,
`harness_needs_runner` and `no_runner_announces` stay, now at the step's runner), so an AI that writes a name nobody linked gets
`runner_unknown` with the names that exist.

How the job reaches the runner stays the one rule of ADR 0005, **a job requires labels and a dispatcher takes it only when it has all of
them**, so the claim query, the doorbell and the Dispatcher contract do not change:

- A job of a step on a self-hosted runner requires one **reserved label that names that runner** (`cr:runner:<id>`). The label is in the
  namespace `cr:`, so only the claim of that runner's own credential carries it and nothing a runner announces or a lane writes can
  forge it; the labels a runner announces (`linux`, `gpu`) are no longer used for routing of lane steps.
- A job of a step on a hosted environment requires `cr:managed` and the platform's size label, as a hosted turn does today.
- **Concurrency** is held by the app: it counts the running jobs of a runner and answers `204` at or above the number, so the next job
  waits in the queue. For a self-hosted runner the number is the one it announced (`parallelRuns`, held within the operator's maximum); for a
  hosted environment it is the number Setup stores. The app counts per runner, in the claim, as it already does for `maxRunning`
  (`contracts/runner-api.ts`, "the pool cap").

### The lane document, the versions, and what the person sees

- **There is no lane editor and no diff view.** The lane builder (`app/src/workflow-pages/builder/`) is removed. A lane's page shows its
  **name**, its **description** (`description` of the document) and its **versions**. The page of a run keeps its flow view, which is a
  picture of what ran and not an editor.
- **Every version from 2 on carries a description of what changed against the previous one**, written by whoever saves it (the AI). It is
  required on `PUT /workflows/<id>`: `changeDescription`, 1 to 1,000 characters, not only white space, stored with the version (a new column
  of `workflow_versions`, immutable like the version) and shown in the list of versions with its author and time. A save without it is
  refused (`WORKFLOW_CHANGE_DESCRIPTION_REQUIRED`). Version 1 needs none; its description is the lane's. The description is **text for
  people**: it is never read by the validator or the engine, and an AI is told so in `docs/workflows.md`.
- **Lanes always belong to a project.** The service already never creates one without a project; what remains is the schema (`project_id`
  becomes not null once none is left) and the paths for "a lane without a project" in the routes, the run start and the documentation.
- **A manual trigger may have no `input`.** A lane with such a trigger starts with nothing and its run **works on the project's
  repository** (the repository of the project the lane belongs to). Today a manual trigger must declare `ticket` or `repo`
  (`repo_required`, `app/src/workflows/validate.ts`), and since #937 a start may leave `repo` out for a lane of a project; the run is then given
  `input.repo`. After this record the declaration itself is optional. A trigger that does declare an input keeps all rules of today.
  Nothing new may be built on `projects.repository_id` more than this already does (ADR 0006 notes that the tie is planned to go).

## Alternatives considered

- **Keep profiles as the shared, versioned way to reuse a setup.** Rejected by the owner: a second place to read, a version that changes
  beneath a lane, and a UI to manage it. An AI writes a step in full as easily as a name.
- **Lane-level defaults for the agent settings (one block, steps override).** Fewer repeated lines, but two places again, and the question
  of which wins. Not now; a document that repeats a model in five steps is acceptable and visible. It can come later as a convenience of
  the format.
- **Keep the lane builder, but read-only, with a diff view.** The page and its state are the cost this decision removes; a description
  written by the author is what a person needs.
- **Keep matching runners by label and let a step name the labels.** An AI cannot know what labels mean on a machine (`gpu` may be a
  different machine tomorrow); a step that names a runner fails clearly when it is gone. One concrete name is also what the owner wants
  to read in a lane.
- **Route a named runner by a new column instead of a reserved label.** Works, but it would change the claim query and the contract of
  every Dispatcher for something the reserved namespace already expresses.
- **Hosted environments with size, script and network rule remain settings.** Rejected by the owner: a hosted environment is capacity,
  nothing more.

## Consequences

- **Easier:** one place to read a lane, with no second lookup. No profile or builder pages to build, translate and test. A change of a
  lane is one new version with a sentence. An MCP server later is a thin wrapper over routes that already are the interface.
- **Harder:** a lane is longer (each step carries its settings), and changing a model that many steps use means editing many steps; the
  author (an AI) must do it and say so in the change description. The person can no longer fix a lane in the browser: they ask the AI.
  Whoever may save a lane through the API can now also decide a step's model, push right and instructions, which a profile page used to
  gate by being a separate object (see Open points).
- **No version changes by itself any more.** An unpinned `"profile": "implementer"` followed the newest version; an inline step is what
  it says. The migration pins to the version that exists when it runs.
- **A runner that goes away breaks a lane visibly.** A step on a revoked runner is `runner_unknown` at save and, for a saved version, a
  failed step (`runner_not_found`) instead of a turn that waits for labels nobody has.
- **Hosted capacity is a number.** A workspace cannot have a big and a small hosted VM, and a hosted turn has no setup script or network
  rule of the workspace's own: see Open points. Self-hosted runners keep their own size and setup, which are the machine's business.
- **Cost and security are unchanged in kind:** the lane's budget, the turn time limit, the operator's maximum, the managed-model rules and
  the token rules (a step that may not push gets a read-only token) all stay, and the server enforces them at save and at run time.

## Migration path

Two releases, expand first and contract one release later (the project's rule for the database: expand-only migrations, ADR 0001). Runs
are never rewritten.

**Release A: expand, and write the new form.**

1. The schema and the validator accept the **inline settings and `runner`** next to the old `profile` and `environment`. A step with
   both a `profile` and inline settings is refused (`profile_with_inline_settings`). The routes of the profiles stay, read-only in the
   next step of the owner's choosing; the pages and navigation entries for profiles, environments and the builder go with their sub-issues.
   `workflow_versions` gets the nullable `change_description` column in the same release (so the migration below can write one).
2. **A data migration gives every lane that is not archived a new version with the profile values inline**, and only the **current**
   version. For each agent step: the profile reference (`name`, or `name@n`) is resolved **now** (the newest version for a bare name, as
   the engine would at the first run); `harness`, `model`, `canPush`, `instructions` are copied; `defaultResult` becomes the step's `result`
   if the step declared none; the profile's `description` becomes the step's if it had none; `costLimitCents` is **not** copied (a value
   the engine never read must not start limiting turns). The step names its **runner**: the profile's environment if it had one, else the
   step's own `environment`, mapped as in the next paragraph. The new version's description is "Profile values and runner written into
   the steps (ADR 0007)", and its author is the author of the version it replaces. Older versions stay as saved. A lane the migration cannot
   convert (a profile that is archived or gone, a runner it cannot name) keeps its version and is **listed in the migration's log**, as the
   migration of #937 did for lanes without a project; the validator keeps accepting the old form until release B for exactly these.
3. **Environments to runners.** A **hosted** environment becomes the workspace's hosted runner (one per workspace, created by the
   migration, concurrency set to the pool cap that applies today). A **runner** environment becomes the self-hosted runner whose labels
   are all of the environment's labels **if exactly one runner of the workspace matches**; with none or several, the step is not
   converted and the lane is listed. Duplicate runner names in a workspace are made unique by the migration (a suffix with a short id of the
   runner) and listed. A hosted environment's size, script and network rule are not applied to a converted step; the workspaces that had a
   script or a rule other than the standard are listed too (see Open points).
4. **Lanes without a project** are archived and listed if any still exist (the migration of #937 did that once; the check makes the not
   null column safe).
5. **In-flight and old runs are untouched.** A run holds the version of the lane it started with (`workflow_runs.workflow_version`), so a
   run that started before the migration finishes on the old document: the engine reads **both forms** in release A (`resolveProfile` and
   the environment lookup stay for a step in `profile` form). A step run keeps `profile_name`, `profile_version` and its turn's copy
   (`implementer_turns.profile_*`, `environment_*`): the run page shows them as before ("profile reviewer version 2"), and nothing is
   rewritten. A new turn of an inline step records no profile; its copy of the harness, the push right and the instructions is the same
   columns, filled from the step, so the claim and the runner read one shape.
6. **The wire contract is not changed in this epic.** The job's `profile` object (`ImplementerProfile`, `implementer_profile`) stays: the
   app fills it from the step, with the lane's name and version as `name` and `version`. Renaming it would need a runner release and
   gains nothing for the person; it can follow later.

**Release B, one release later: contract.**

1. The validator refuses `profile` and `environment` in a step (`profile_removed`, `environment_removed`, with a message that names the
   field to use), and the engine's `profile_not_found` / `environment_not_found` paths for the old form go. Lane versions older than the
   migration stay readable as documents but cannot be saved again as they are.
2. The **profile tables** `profiles` and `profile_versions` are dropped (and `workspace-erasure-repository.ts` stops listing them), as
   are the profile routes, the pages, the `profile` field of the Implementer bodies, and the capability routes. The columns of past
   turns and step runs stay: they are history.
3. The `implementer_environments` table and its routes and page go when its last reader does; the turn copies (`environment_*`) stay.
4. The labels a runner announces stay in the registration (they are shown on the runners page) and stop being a routing input.

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
  `workflows/facts.ts`; `workflows/validate.ts:180-225` (the manual trigger's `repo_required`, for #1106).
- `app/src/workflows/built-in-lanes.ts:5,108-139,348-382,399-402`: the three built-in lanes name `implementer@1` and `reviewer@1`
  (`:117,:138,:381`) and an environment that the caller passes in.

**Engine**

- `app/src/workflow-runs/engine.ts`: dependencies `:121-122` (profiles, environments); `resolveProfile` `:760-772`; its use `:808-819`
  and `:945-990` (`profile_not_found`); the turn of a step `:1203-1307` (the environment by name, case ignored, `:1219-1247`,
  `environment_not_found`, `environment_mismatch`); a continuing session `:1326`; `:1463-1474`.
- `app/src/workflow-runs/service.ts:85,357`; `workflow-runs/shared.ts:14,232`; `workflow-runs/turn-facts.ts:128,375` (harness and push
  right read from the turn's profile copy); `workflow-runs/errors.ts:106-120`.
- `app/src/db/repositories/workflow-runs-repository.ts:102,252,704,1411,1449`; `db/schema.ts:1573` (`profile_name`, `profile_version`
  of a step run).

**Implementer (a task started by hand, and the copy a turn holds)**

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

**Labels and environments (where a runner is chosen today)**

- `app/src/runner-identity/labels.ts`: `hostedLabels`, `PLATFORM_LABELS` `:36-52`, `hasAllLabels` `:78`, **`requiredLabelsOfTurn` `:90`**
  (a runner environment's own labels, or `cr:managed` and the size). It is called when a turn is enqueued:
  `db/repositories/jobs-repository.ts:751,:879` (`required_labels`; a review has `hostedLabels` at `:575`).
- `app/src/db/repositories/jobs-claim.ts:136-150`: the claim query, `required_labels` against the caller's labels, with the **fallback for
  jobs written before the column** (the legacy environment labels of the turn); `runner-jobs-repository.ts` (the runner turns a runner may
  take); `runner-api/claim.ts:2250-2286` (`maxRunning`, the per-runner pool cap); `runner-identity/announcement.ts:43` (`parallelRuns`).
- `app/src/implementer/environments/` (`input.ts:19-120` labels of the kind `runner`, `service.ts:26-84`, the page and its panel under
  `ui/`), `db/schema.ts:1366-1386` (`implementer_environments`), `:1200-1206` (the turn's copy of kind and labels), `db/schema.ts:1621`
  (`runners`: **`name` is not unique**, labels, manifest, limits, `last_seen_at`, `revoked_at`).
- The wait: `runs/run-view.ts:219,1044` ("Waiting for a runner with labels …"), `db/job-limits.ts:54-56` and `:122` (`no_runner_available` after
  `RUNNER_WAIT_DEADLINE_MINUTES`).

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

- **Hosted setup script and network rule.** A hosted environment no longer configures a size, a script or a network rule (owner's
  decision). Some lanes rely on them today: a setup script that installs the project's tools, and a network rule that lets the agent reach
  a package registry. Where does that go: into the repository (a file the runner reads), into the lane's step, or nowhere (the hosted runner
  gets a fixed, documented base)? Until decided, the migration lists every workspace whose hosted environments have either and converts
  nothing for them; self-hosted runners keep their own machine's setup.
- **Who may save lanes through the API.** Every member of a workspace may today (`start_implementer_task`). With the configuration
  inline, whoever saves decides a step's model (and so its cost), push right and instructions. A narrower right (Owners and Admins, or a
  token an AI holds that is limited to a project) is for the owner to decide before the MCP server, and in any case before an AI other than
  the lead agent writes lanes.
- **The wait of a job behind a runner's concurrency.** A queued job that waits for a runner that is online and busy must not expire the way a
  job for a runner nobody has does (`no_runner_available` after 30 minutes). The rule to apply (the deadline counts only while the named
  runner is offline or revoked) is proposed here and to be confirmed in #1105.
- **Names of runners** are unique per workspace from now on; whether a name can change after a lane uses it (and the lanes follow) or
  never, as with a profile's name, is not decided.
- **Where the change description of the migration's version comes from if #1107 is merged first.** This record puts the column into
  release A so that the migration can write it; the order of #1105 and #1107 must keep that true.

## Out of scope

- The MCP server of the factory that wraps these routes (a later epic).
- The runner's contract with the Dispatcher, other than which labels a job of a lane step requires.
- Changing the lane's budget, the turn time limit or the operator's maximum.
- A shared library of agent settings or lane templates beyond the built-in lanes.
- Dropping `projects.repository_id` (ADR 0006).
