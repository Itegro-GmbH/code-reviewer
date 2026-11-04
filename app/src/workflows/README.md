# Agent workflows: format v1 and validator (#833, milestone 1)

A workflow is a JSON document: a trigger and a list of steps. This folder is the **format**, the **validator** and the **API** behind it. There is
no engine yet: nothing runs a workflow (milestones 2 to 5 of the plan add profiles and the finish tool, the engine, the label trigger and the
review loop). What the format is, every error code and how an AI should use it: [`docs/workflows.md`](../../../docs/workflows.md). The two JSON
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
| `connectors.ts`, `triggers.ts`, `facts.ts`        | What the three actions take and yield, what each trigger hands over, the facts every agent step yields without the agent                                                                                        |
| `resolver.ts`                                     | `WorkflowResolver`: which profiles, environments and connectors exist, as plain data                                                                                                                            |
| `issues.ts`, `limits.ts`                          | The issue shape and its stable codes (form codes are the ones the JSON Schema states too), the bounds                                                                                                           |
| `service.ts`, `http.ts`, `errors.ts`, `shared.ts` | The workspace service (validate, list, get, create, save a version, archive), the handlers, the route codes, the wiring                                                                                         |

The storage is `workflows` (name, current version, `archived_at`) and `workflow_versions` (the document text of every version; the database refuses an
UPDATE, only the erasure of a workspace deletes) in `src/db/repositories/workflows-repository.ts`, scoped to a workspace. A workflow is archived, not
deleted: hidden from the list, no new version, free name, versions kept.

## Decisions where the plan left room

- **The resolver is data, not calls.** The validator asks for lists (`profiles()`, `environments()`, `connectors()`) so the same list gives the
  "available" names of an error, tests use fakes, and nothing in the core awaits. The service reads the workspace's environments and builds the
  resolver per request.
- **Profiles: a name no list knows is an error.** Until M2 the one profile is `implementer` (today's Implementer: version 1, may push). It is the same
  question M2 will ask of the profiles table (exists? version? may push? default result schema?), so M2 replaces `BUILT_IN_PROFILES` by the rows and nothing
  else changes. Accepting any name as "well formed, unresolved" would leave the push facts and the version unchecked for exactly the profiles that matter.
- **Scope after an `if`**: only the `if` itself (`taken`). Ids are unique in the document, so no step is produced by both branches; nothing a branch made is
  certain to exist afterwards. After a **loop**: the body's own steps with the last round's values (a body runs at least once and a round runs to its
  end; the budget is checked between rounds). `previous.*`: direct steps of the innermost loop body only, from round two.
- **A loop's own result** is `exit` and `rounds`; the plan's `{{fix.findings}}` is `{{review.findings}}` in version 1.
- **`environment` is a name** (names are unique in a workspace, case ignored), or a reference to a text. `trigger.repo.defaultEnvironment` of the plan's
  example does not exist: nothing maps a repository to an environment yet.
- **One repository per run.** The run's repository is `trigger.repo` (issue trigger) or the input `repo` a manual trigger must declare; no node names another one.
  More than one repository per run is a later, additive extension.
- **Targets** (`issue`, `head`, `base`, the labels, the `environment`) take a literal or one whole reference to the trigger or to an agent step's `branch`, never a
  value an agent reported (`check-values.ts`, `connectors.ts`): an agent's result is data, not a command.
- **`json.ts`** holds the one `isRecord` and `jsonTypeName`, and the length of a text in characters (code points), which is how the JSON Schema counts. A message
  repeats at most 64 characters of what the user wrote (`shown` in `issues.ts`).
- **The operator's maximum budget** is `BUDGET_OPERATOR_MAX_USD` (100) in `limits.ts`, passed into the validator; there is no operator setting for it yet.
- **Saving**: the name of the workflow is the `name` of the document, and every save is a new version, an identical document too. The stored text is the JSON that
  was validated. `who saved a version` is kept as text, without a foreign key (history survives the merge that retires an imported operator).
