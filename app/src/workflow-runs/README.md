# Workflow engine (#844, milestones 3 and 5 of epic #833)

Runs a saved [workflow](../../../docs/workflows.md#engine) version: one **run** per start, one **step run** per time a step runs, in the order they run.
It has the **core** and the **GitHub actions** (milestone 3b: `github-connectors.ts`): `agent` and `action` steps, and since milestone 5 (#846) the control steps `if` (a branch is
taken, the other is written as skipped) and `loop` (rounds, `until`, `maxRounds`, `previous.*`, `session.continue`: `conditions.ts`, and the replay of the rows in `machine.ts`). The pages (milestone 3c, #873) are in [`workflow-pages/`](../workflow-pages/README.md). What it does and the error codes: [`docs/workflows.md`](../../../docs/workflows.md#engine). The plan: `plans/agent-workflows.md`.

The routes exist only in a deployment with the capability `implementer` (`src/capabilities/routes.ts`), like the workflows and the Implementer; every
member may use them (`start_implementer_task`: a run starts tasks).

| File                                 | Role                                                                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine.ts`                         | The state machine as a pure function: the state of a run (its steps, the budget, the clock) in, the one next move out. A function of the state, so a repeat finds `idle`. Also the failure phase of `onFailure` (#902) |
| `engine.ts`                          | `createWorkflowEngine`: reads the state under the lock of the run, asks for the move, makes it; `advance(runId)` and `jobEnded(jobId)` (never throws)                                                                  |
| `turn-facts.ts`, `turn-reader.ts`    | What an agent step yields once its turn is over: the result held to the stored schema again (`checkResultValue`), the facts, the cost; and the read of a turn                                                          |
| `templates.ts`                       | `{{ref}}` at run time: one pass, values are data, bounded, a missing value fails the step                                                                                                                              |
| `connectors.ts`                      | The interface of an action, the registry, `ConnectorError` (a step ends with its code), and the inputs of an action node resolved and held to the connector's spec                                                     |
| `github-connectors.ts`               | The three GitHub actions through the GitHub App of the workspace: cleaned and bounded inputs, GitHub's refusals as stable codes (`docs/workflows.md`, "GitHub actions")                                                |
| `label-trigger.ts`                   | The label trigger (#845): which workflows a label on an issue starts, one run each under `gh-<delivery id>-<workflow id>`, and the bounded issue as the run's input                                                    |
| `document.ts`                        | The workflow document as the engine reads it (defensively)                                                                                                                                                             |
| `service.ts`, `http.ts`, `shared.ts` | The run service (start, get, list), the handlers behind the routes, the wiring of the running server (the hook of the runner API, the reconciler of the sweep)                                                         |
| `errors.ts`, `limits.ts`             | The stable codes (`WORKFLOW_RUN_*` for the routes, the lower case codes of a failed run or step) and the bounds                                                                                                        |

The tables are `workflow_runs` and `workflow_step_runs` (migration `20261105130000_create_workflow_runs`; `20261105170000_add_workflow_step_cost_basis` adds where a step's cost comes from), written by
`src/db/repositories/workflow-runs-repository.ts`, scoped to a workspace. `workflow-runs-sweep.ts` is the one instance-level read (the runs that run and were
not touched for a minute), classified in `scoping.test.ts`.

## Runs of a label (#845)

A run is started by hand (`service.ts`) or by a label on an issue (`label-trigger.ts`, called by the webhook): `workflow_runs.trigger_kind` says which. A run of a label has
no `created_by` (the table holds that: only `manual` needs a user), its `actor_login` is the login of whoever put the label on (display only), and its `trigger_input` is
`{issue, repo}`, which the engine reads as `trigger.issue` and `trigger.repo` (`valuesOf`; a run by hand has `trigger.input`). The Implementer session of an agent step needs an
account: the owner of the workflow (`sessionOwner`: the author of the workflow version the run uses, so whoever saves the workflow again takes over the runs that start afterwards), who must still be a member of the workspace (else the run ends with `workflow_owner_gone`, before its first step). A workflow has one running run for one issue at a time (`trigger_key`, a partial unique index; `createRun` answers `busy`). The title, body and labels of the issue are defused where they go into the text of an action (`templates.ts`). The rules and
the filter: [`docs/workflows.md`](../../../docs/workflows.md#the-label-trigger).

## How a run goes

1. `POST .../workflows/:id/runs` (`service.start`): the body, a request id that made a run before, the workflow (exists, not archived), the trigger (manual),
   the steps (only `agent` and `action`), the input against the trigger's schema, the repository of the workspace. Then `createRun` and `kick`, which
   runs `advance` after the response.
2. `advance(runId)` loops: **lock the run row** (`select … for update`), build the state, `nextMove`, make the decision under the lock, and, for work that
   talks to others (starting a turn, an action), do it **after** the lock is released:
   - `add_step` writes the next step (an agent step with the profile version resolved now and the rest of the budget as its cap), then `execute`;
   - `execute` claims the step by a guarded update (`pending` to `running`; one worker wins), renders the instruction from the templates and calls
     `startTask` under the request id `wf-<run>-<position>`, with `costCapCents` (the rest of the budget). The turn's job is stored with the step;
   - `read_job` ends the step when its job is over: it reads job, turn and session from the database, checks the result again and adds the cost to the run;
   - `finish_run` ends the run (all steps succeeded, a step failed, the budget is used up, a step kind this engine does not run).
3. The end of a turn reaches the engine through `ReportDeps.turnEnded` (`runner-api/report.ts`, called where the write tokens are switched off), after the
   completion is stored. A hook that throws or rejects is caught and logged by its code; the completion is not affected. A job that ends without a report is
   found by `reconcileWorkflowRuns` (the sweep and the opportunistic maintenance), which calls `advance` for every run that waited a minute.

## `onFailure` (#902)

A run that would end `failed` or `cancelled` in a workflow with `onFailure` steps first answers `begin_failure` (`machine.ts`): the engine stores `FailureRecord` (the status and error code the run ends
with, and the facts `{{failure.*}}`) in `workflow_runs.failure` and keeps the run `running`. From then on `nextMove` is in the failure phase: the rows after the workflow's own are replayed against the
`onFailure` nodes (`contextOf` tells a row its place), a failed step counts as over, a cancel is ignored, an agent step or a loop is never started, and the run ends with the stored status. Not run for
`document_unusable` and `workflow_owner_gone`. `code` and `message` of the failure are defused where they go into a comment (`templates.ts`). `docs/workflows.md`, "After a failure".

## Decisions where the plan left room

- **Claim, then act.** Starting a turn asks GitHub several times, so it is not done inside the transaction that holds the lock. The step row is the claim; a
  claimed agent step with no job after two minutes is taken over, which is safe because the turn is started under a request id. An **action** is not taken
  over (it may have happened): `action_interrupted`. After an hour without a job an agent step is given up (`agent_start_failed`).
- **The event carries no data.** `jobEnded` only names a job; the state is read from the database. This is what makes late, doubled and lost events harmless.
- **An unknown cost is charged at the cap.** A run whose spend cannot be seen still cannot spend more than its budget.
- **Cap, not a copy.** `startTask` takes `costCapCents` as an option (`implementer/service.ts`), not as a field of the body: only code inside the app can ask for it. It
  lowers the cost limit of the task (the profile version's) and is held to the operator's maximum.
- **Facts.** The validator knows `headCommit` and `pushed` besides `costUsd`, `branch` and `commits` (`workflows/facts.ts`); only a profile that may push has the four.
- **The run's repository and base branch are fixed at the start** (`input.repo`, its default branch then), so every agent step of a run starts from the same branch, unless the step names a `branch` (#846: a target the validator held to a literal, a trigger value or the branch fact of an earlier agent step), which `beginSession` hands to `startTask` as the base branch. The session always works on a branch of its own, `sessionBranchOf`: `workflow/<run>/<step>`, and `<step>.r<round>` from the second session of a step on (a step id has no `.`, so two steps cannot be named alike).
- **A step that waits.** A `session.continue` step whose session holds an instruction (a turn runs; or somebody else's instruction is queued, `IMPLEMENTER_SESSION_BUSY`) stays claimed without a job and asks again when its claim is stale (`STEP_STALE_MS`). Given up after `STEP_GIVE_UP_MS`, it first discards its own queued instruction (`discardRequested`) and looks for the turn that may have started in that moment, so no turn starts later without a step to read it.
