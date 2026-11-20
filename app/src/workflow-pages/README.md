# Workflow pages (#873, milestone 3c of epic #833)

The pages of the agent workflows: the list of a workspace's workflows, one workflow (its name, description, project, triggers and versions with their change descriptions, read only, #1107; below them the **Start form**) and its runs, and one run with its status, budget, cost
basis, steps and results. What they show and how: [`docs/workflows.md`](../../../docs/workflows.md#the-run-page). The engine and the routes they read are
[`workflow-runs/`](../workflow-runs/README.md) and [`workflows/`](../workflows/README.md).

This is a module of its own, and the engine imports nothing from it: the pages only read through the services and the routes, so the import cycles of the engine
(the runner API, the dispatch sweep) do not grow with the UI (`src/ci/import-cycles/`).

The pages exist only in a deployment with the capability `implementer` (`src/capabilities/routes.ts`) and are reached from the **Lanes** tab of a project (#925: the sidebar has no Workflows place any more; the tab lists the workspace's workflows until a lane
belongs to a project, #922). They sit in `src/app/(app)/w/[workspace]/workflows/`.

| File                                                  | Role                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages.tsx`                                           | The `load…` functions that gather a page's data from the services (an id of another workspace is `not_found`) and the `…Content` components that render it                                                                                                      |
| `run-detail.tsx`                                      | One run (client, #1079): the header, the lane as a flow and the panel of the selected step (`?step=`); the plain list of steps when the lane cannot be drawn; polls while the run runs or waits for an answer                                                   |
| `run-flow.tsx`, `run-node-states.ts`                  | The lane of a run drawn read-only on the layout of the lane flow (`flow/flow-layout.tsx`), each node coloured by its state (#1079); the pure mapping of the step runs onto every node by `stepId`, latest round wins, and the default selection                 |
| `step-panel.tsx`, `step-parts.tsx`                    | The details of the selected step (facts, failure, question, result, rounds, the agent's run and its MCP calls); the small pieces shared with the plain list (times, cost with its basis, results)                                                               |
| `lane-runs-*.tsx`                                     | The Lane runs tab of the Runs page (#1078, `?view=lanes\|agents`): every lane run of the workspace, active first, polled while one is active; filters in the address. The page of one lane reuses the list with `filter={{ lane }}` as its Runs section (#1080) |
| `run-track.ts`, `run-track.tsx`                       | The compact step track (#1078): step rows laid onto the top-level nodes of the lane version (`trackOf`), its text alternative, the small component; the Issues tab and drawer (#1080) reuse it                                                                  |
| `workflows-list.tsx`                                  | The workflows of a workspace                                                                                                                                                                                                                                    |
| `agent-run-lane-notice.tsx`, `agent-run-lane-step.ts` | The note on the page of an agent run that is a step of a lane run (#1080), and its link back to the run page opened at that step (`?step=`); the gate of the lookup (only a task, only with the Implementer)                                                    |
| `start-form.tsx`, `start-form-spec.ts`                | The form for a manual trigger (one for each when the document has several, #916): the fields come from the `input` schema of the saved document, a `ticket` is a text; `clientRequestId` per input                                                              |
| `view.ts`, `github-link.ts`                           | What the pages take from a run (the ticket, the durations, the results); `github-link.ts` is the one place a link is made from a step's output (`https://github.com/<repo of the run>/…`, checked with `new URL`)                                               |
| `messages.ts`                                         | All the copy: a failure code becomes a sentence, never shown as the code; the cost bases and what they mean                                                                                                                                                     |
| `ask-block.tsx`                                       | The question an agent step asked (#920): the text, the options, the way to answer while the run waits, who answered what once it is answered                                                                                                                    |
| `api.ts`, `status-badge.tsx`                          | The browser's calls to the run routes; the status badge                                                                                                                                                                                                         |

Everything a step returned (an agent's result, what a connector got from GitHub) is data from outside: rendered as text, never as markup.

## The lane page and the flow

The page of one workflow shows the lane read only (#1107, ADR 0007): `lane-overview.tsx` renders the description, the project, the triggers and the versions with their change descriptions; `pages.tsx` loads them (the project's name from the project service, the authors' names from the members of the workspace, the text of version 1 from version 1's document). What it shows and why: [`docs/workflows.md`](../../../docs/workflows.md#the-lane-page). There is no editor; a lane is changed through the API.

`flow/` holds what the run page needs to draw a lane: `document.ts` (the document read by JSON pointer, the old single `trigger` read as `triggers`), `describe.ts` (what a node says about itself), `flow-layout.tsx` and `copy.ts` (the layout and its headings). `lane-overview.tsx` has the lane page's own copy in `messages.ts` (`PAGE_COPY`).
