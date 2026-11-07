# Agent workflows: format v1 and validator (#833, milestone 1)

A workflow is a JSON document: one or more triggers, each with pre-steps (#916), and a list of steps. This folder is the **format**, the **validator** and the **API** behind it. There is
no engine here: this folder is pure (milestone 2 of the plan added the [profiles](../profiles/README.md) the steps refer to; the engine that runs a
document is [`src/workflow-runs/`](../workflow-runs/README.md), milestone 3a; the label trigger and the review loop follow). What the format is, every error code and how an AI should use it: [`docs/workflows.md`](../../../docs/workflows.md). The two JSON
Schemas are [`contracts/workflow.v1.json`](../../../contracts/workflow.v1.json) and
[`contracts/result-schema.v1.json`](../../../contracts/result-schema.v1.json), checked by
`integration-tests/compatibility/workflow-contract.integration.test.ts`.

The workflows exist only in a deployment with the capability `implementer`: the routes are classified `implementer` in `src/capabilities/routes.ts` and
ask again in the route file. Every member may use them (`start_implementer_task`; the owner decided that everyone may do everything).

## The core is pure

No database, no I/O: a document and a `WorkflowResolver` go in, a list of problems comes out.

| File                                              | Role                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate.ts`                                     | `validateWorkflow(document, resolver, { maxBudgetUsd })`: the document, the trigger, the budget; returns `{ valid, errors, budgetUsd?, steps }`. Never throws, never stops at the first problem, sorted by path |
| `check-steps.ts`                                  | The steps in the order they run: the shape of each node, what each yields, the scope that grows as it goes                                                                                                      |
| `check-values.ts`                                 | Texts, the inputs of an action held to the connector's types, conditions                                                                                                                                        |
| `scope.ts`                                        | What a reference can reach at a place, and how a reference is resolved (the rules are in its header)                                                                                                            |
| `template.ts`                                     | `{{step.field \| default <JSON>}}`: parse and render. A list renders one entry per line                                                                                                                         |
| `result-schema.ts`                                | The result schema subset: `validateResultSchema`, `objectTypeOf`, `checkResultValue` (the finish tool of M2 reuses the last one)                                                                                |
| `value-type.ts`                                   | The types of values that flow, assignability                                                                                                                                                                    |
| `failure.ts`                                      | `onFailure` (#902): the facts of the failure (`{{failure.*}}`), the connectors and node kinds its steps may use                                                                                                 |
| `connectors.ts`, `triggers.ts`, `facts.ts`        | What the actions take and yield, what each trigger hands over and what all of them do (`commonTriggerType`), the facts every agent step yields without the agent                                                |
| `ticket-ref.ts`                                   | The `ticket` of a trigger (#916): `github:owner/repo#128`, the fields of `{{trigger.ticket}}`                                                                                                                   |
| `resolver.ts`                                     | `WorkflowResolver`: which profiles (with the facts of the versions a document runs), environments and connectors exist, as plain data                                                                           |
| `profile-refs.ts`                                 | Which profiles and versions a document names (an iterative walk), and the resolver's profile list built from the rows read for exactly those versions                                                           |
| `issues.ts`, `limits.ts`                          | The issue shape and its stable codes (form codes are the ones the JSON Schema states too), the bounds                                                                                                           |
| `service.ts`, `http.ts`, `errors.ts`, `shared.ts` | The workspace service (validate, list and create within a project, get, save a version, archive, copy built-in lanes), the handlers, the route codes, the wiring                                                |
| `built-in-lanes.ts`                               | The two documents a new project copies as its first lanes (`issue-to-pr`, `review-a-pull-request`), as data in format v1; `issue-to-pr` is the example of `docs/workflows.md`                                   |

The storage is `workflows` (name, current version, `archived_at`, and since #922 `project_id`: a lane belongs to exactly one project, and its name is held once per project) and `workflow_versions` (the document text of every version; the database refuses an
UPDATE, only the erasure of a workspace deletes) in `src/db/repositories/workflows-repository.ts`, scoped to a workspace. A workflow is archived, not
deleted: hidden from the list, no new version, free name, versions kept.

## Decisions where the plan left room

- **The resolver is data, not calls.** The validator asks for lists (`profiles()`, `environments()`, `connectors()`) so the same list gives the
  "available" names of an error, tests use fakes, and nothing in the core awaits. The service reads the workspace's environments and builds the
  resolver per request.
- **Profiles: a name no list knows is an error.** Profiles are user data (#843): the rows of the workspace's profiles table that are not archived. The
  resolver answers per version: the versions that exist (1 to the current, without a gap) and, for the versions the document runs, whether the version may
  push and its default result schema. A pinned version has its own facts; a reference without a version has the newest's; a version that does not exist is
  reported where it is written and takes the newest's facts, so one mistake is not reported at every use. The service reads only those versions
  (`profile-refs.ts`), not every version of every profile. Accepting any name as "well formed, unresolved" would leave the push facts and the version
  unchecked for exactly the profiles that matter.
- **Scope after an `if`**: only the `if` itself (`taken`). Ids are unique in the document, so no step is produced by both branches; nothing a branch made is
  certain to exist afterwards. After a **loop**: the body's own steps with the last round's values (a body runs at least once and a round runs to its
  end; the budget is checked between rounds). `previous.*`: direct steps of the innermost loop body only, from round two.
- **A loop's own result** is `exit` and `rounds`; the plan's `{{fix.findings}}` is `{{review.findings}}` in version 1.
- **`environment` is a name**, a literal only (names are unique in a workspace, case ignored): a reference is `target_from_untrusted_value`. Since #919 it is optional and
  deprecated: the profile version names the environment (`environmentId` in its facts, matched with the `id` of the resolver's environments), the step must not name another
  (`environment_mismatch`), and only a version saved before #919 needs it (`environment_required`).
  `trigger.repo.defaultEnvironment` of the plan's example does not exist: nothing maps a repository to an environment yet.
- **One repository per run.** The run's repository is the ticket's (`trigger.ticket.repo`: a label trigger, or a manual or api trigger whose input declares `ticket`) or the input `repo` a manual trigger declares; no node names another one.
- **Several triggers (#916).** `triggers` is a list, each entry with an `id` and `steps` (pre-steps); the single `trigger` of before is read as a list of one, `github.issueLabeled` as `ticket.labeled`. The pre-steps of a trigger see that
  trigger's own values; the shared steps and `onFailure` see what **every** trigger yields (`commonTriggerType`; `Binding.triggers` names a trigger that lacks a value, `reference_not_in_scope`). Step ids are unique across the pre-steps of all
  triggers and the shared steps, so the engine can walk the pre-steps and the shared steps as one list. `label_retriggers_workflow` holds for the shared steps and the pre-steps of a label trigger, not for a pre-step of another kind of trigger
  (the bot's own writes start no run). `ticket` is a type of the input of a manual or api trigger only (`validateResultSchema(…, { allowTicket: true })`), a field of the input itself and called `ticket`.
  More than one repository per run is a later, additive extension.
- **Targets** (`issue`, `head`, `base`, the labels, the `environment`) take a literal or one whole reference to a value the platform or the caller vouches for,
  and which one depends on the input (`TargetRoot` in `connectors.ts`: `issue`: `trigger.issue[.number]` or a manual `input.*`; labels: a manual `input.*`; `base`:
  `trigger.repo.defaultBranch` or a manual `input.*`; `head`: an agent step's `branch`). Never a value an agent reported, and never the title, body or labels of the
  issue, which whoever opened it wrote (`check-values.ts`): data, not a command. An issue number is a safe integer from 1 to 2^31-1, as a literal and as a default; a
  manual input used as one must be `integer`, and the engine checks it again at run time.
- **`json.ts`** holds the one `isRecord` and `jsonTypeName`, and the length of a text in characters (code points), which is how the JSON Schema counts. A message
  repeats at most 64 characters of what the user wrote (`shown` in `issues.ts`), and so do a path and a name in `available`.
- **The operator's maximum budget** is `BUDGET_OPERATOR_MAX_USD` (100) in `limits.ts`, passed into the validator; there is no operator setting for it yet.
- **`turnTimeLimitMinutes`** (#918) is a whole number from `TURN_TIME_LIMIT_MINUTES_MIN` (15) to `TURN_TIME_LIMIT_MINUTES_MAX` (60), `TURN_TIME_LIMIT_MINUTES_DEFAULT` (60) when left out
  (`invalid_value` out of range, `wrong_type` for a non-number); the validator returns it beside `budgetUsd`, and the engine copies it into every turn it starts.
- **Saving**: the name of the workflow is the `name` of the document, and every save is a new version, an identical document too. The stored text is the JSON that
  was validated. `who saved a version` is kept as text, without a foreign key (history survives the merge that retires an imported operator).
