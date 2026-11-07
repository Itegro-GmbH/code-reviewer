# Workflow engine (#844, milestones 3 and 5 of epic #833)

Runs a saved [workflow](../../../docs/workflows.md#engine) version: one **run** per start, one **step run** per time a step runs, in the order they run.
It has the **core** and the **GitHub actions** (milestone 3b: `github-connectors.ts`): `agent` and `action` steps, and since milestone 5 (#846) the control steps `if` (a branch is
taken, the other is written as skipped) and `loop` (rounds, `until`, `maxRounds`, `previous.*`, `session.continue`: `conditions.ts`, and the replay of the rows in `machine.ts`). The pages (milestone 3c, #873) are in [`workflow-pages/`](../workflow-pages/README.md). What it does and the error codes: [`docs/workflows.md`](../../../docs/workflows.md#engine). The plan: `plans/agent-workflows.md`.

The routes exist only in a deployment with the capability `implementer` (`src/capabilities/routes.ts`), like the workflows and the Implementer; every
member may use them (`start_implementer_task`: a run starts tasks).

| File                                 | Role                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `machine.ts`                         | The state machine as a pure function: the state of a run (its steps, the budget, the clock) in, the one next move out. A function of the state, so a repeat finds `idle`. Also the failure phase of `onFailure` (#902)              |
| `engine.ts`                          | `createWorkflowEngine`: reads the state under the lock of the run, asks for the move, makes it; `advance(runId)` and `jobEnded(jobId)` (never throws)                                                                               |
| `turn-facts.ts`, `turn-reader.ts`    | What an agent step yields once its turn is over: the result held to the stored schema again (`checkResultValue`), the facts, the cost; and the read of a turn                                                                       |
| `templates.ts`                       | `{{ref}}` at run time: one pass, values are data, bounded, a missing value fails the step                                                                                                                                           |
| `connectors.ts`                      | The interface of an action, the registry, `ConnectorError` (a step ends with its code), and the inputs of an action node resolved and held to the connector's spec                                                                  |
| `github-connectors.ts`               | The three GitHub actions through the GitHub App of the workspace: cleaned and bounded inputs, GitHub's refusals as stable codes (`docs/workflows.md`, "GitHub actions")                                                             |
| `label-trigger.ts`                   | The label trigger (#845): which workflows a label on an issue starts, one run each under `gh-<delivery id>-<workflow id>`, through the `ticket.labeled` trigger whose label it is (#916), and the bounded ticket as the run's input |
| `ticket.ts`                          | The ticket a run is about (#916): `{{trigger.ticket}}` as the steps read it, bounded, whether the webhook or the start API handed it over                                                                                           |
| `ask.ts`                             | The question an agent step ended its turn with (#920): what is stored with the step (`workflow_step_runs.ask`), the answer to it (an option by number, a text, a note) and the instruction the turn that goes on gets               |
| `document.ts`                        | The workflow document as the engine reads it (defensively)                                                                                                                                                                          |
| `service.ts`, `http.ts`, `shared.ts` | The run service (start, get, list), the handlers behind the routes, the wiring of the running server (the hook of the runner API, the reconciler of the sweep)                                                                      |
| `errors.ts`, `limits.ts`             | The stable codes (`WORKFLOW_RUN_*` for the routes, the lower case codes of a failed run or step) and the bounds                                                                                                                     |

The tables are `workflow_runs` and `workflow_step_runs` (migration `20261105130000_create_workflow_runs`; `20261105170000_add_workflow_step_cost_basis` adds where a step's cost comes from), written by
`src/db/repositories/workflow-runs-repository.ts`, scoped to a workspace. `workflow-runs-sweep.ts` is the one instance-level read (the runs that run and were
not touched for a minute), classified in `scoping.test.ts`.

## Runs of a label (#845)

A run is started by hand or through the API (`service.ts`) or by a label on an issue (`label-trigger.ts`, called by the webhook): `workflow_runs.trigger_kind` says which (`manual`, `api`,
`ticket.labeled`, and `github.issueLabeled` on rows written before #916) and `trigger_id` which trigger of the document (#916: a workflow has several, each with pre-steps). The engine runs the
pre-steps of that trigger and then the shared steps: `forTrigger` (`document.ts`) puts the pre-steps in front of the shared steps and the state machine walks the one list. A run of a label has
no `created_by` (the table holds that: only `manual` and `api` need a user), its `actor_login` is the login of whoever put the label on (display only), and its `trigger_input` is
`{ticket, issue, repo}`, which the engine reads as `trigger.ticket`, `trigger.issue` and `trigger.repo` (`triggerValueOf`); a run by hand or through the API stores its input exactly as it was handed in (the shape every version stored, so a version that still runs during a deploy reads it), and
`{input, ticket}` only when the trigger has a `ticket` input: the ticket resolved through the provider when the run started (`readTicket`). `readStoredInput` (`ticket.ts`) reads both: `trigger.input` and `trigger.ticket`. A run written before #916 has no `trigger_id`; the engine reads the same shape. `trigger.id` and `trigger.kind` are facts of every run. `workflow_runs.ticket_ref` (#923, `github:owner/repo#128`) is written with the run by the label trigger and by the start service for a run with a ticket, never read back from the input. The Implementer session of an agent step needs an
account: the owner of the workflow (`sessionOwner`: the author of the workflow version the run uses, so whoever saves the workflow again takes over the runs that start afterwards), who must still be a member of the workspace (else the run ends with `workflow_owner_gone`, before its first step). A workflow has one running run for one issue at a time (`trigger_key`, a partial unique index; `createRun` answers `busy`). The title, body and labels of the issue are defused where they go into the text of an action (`templates.ts`). The rules and
the filter: [`docs/workflows.md`](../../../docs/workflows.md#the-label-trigger).

## How a run goes

1. `POST .../workflows/:id/runs` (`service.start`): the body, a request id that made a run before, the workflow (exists, not archived), the trigger (a `manual` or `api` one, named in the body or the only one),
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

## A question: `ask` (#920)

A turn ends with `done` or with `ask` (`docs/workflows.md`, "A question: `done` or `ask`"). The runner reports a question as `implementer.agentAsk`; `turn-facts.ts` yields it as `asked` (bounded again, a result wins over it).
`endAgentStep` then writes `askStep`: the step and the run become `waiting`, the question is stored with the step (`ask.ts`) and the cost of the turn is charged now (a step that asked before is charged the sum of its
turns at the end, and `finishStep` adds only the difference). `nextMove` does nothing for a `waiting` run, however long, except `cancel_waiting` once a stop is asked for; `waiting` also holds the ticket's slot
(`trigger_key`). The question is shown through the optional `AskChannel` of the engine (`asks`), after the lock is released: `asked`, `answered` and `cancelled` (a stop while it waits). A step that waits with no comment
(`waiting_on_comment_id` null) is announced again by `advance` and by the sweep (`dueWorkflowRuns` takes such a waiting run too); the marker of the comment makes that idempotent, and what happened meanwhile decides what is
posted (an answer that came first is posted as answered, a stop is not posted). `finishStep` keeps the cost a step was charged when it asked, whatever outcome it ends with. `ticket-answers.ts` finds the waiting run of the ticket by `workflow_runs.ticket_ref` (`listWaitingForTicket`; a run about no ticket is found by its pull request, `listWaitingWithoutTicket`) and binds a `/answer` comment to the
open question (`isOlderThanQuestion`) and replies to a comment that could not answer.

`engine.answer` (called by the answer route and the `/answer` comment) runs under the lock of the run: of two answers one wins. It puts the answer on the step (`state: "answered"`) and makes step and run `running` again;
the machine's next move is `resume_turn`, which starts the next turn of the session the step's last turn ran in, with the question and the answer as its instruction, under the request id `wf-<run>-<position>-q<n>` (starting it
twice makes one turn) and attaches it to the step (`attachAnswerTurn`; the earlier job is over). A stop asked for between the answer and that turn starts it first, so no turn is left without a step.

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
