# Workflow pages (#873, milestone 3c of epic #833)

The pages of the agent workflows: the list of a workspace's workflows, one workflow with its **Start form** and its runs, and one run with its status, budget, cost
basis, steps and results. What they show and how: [`docs/workflows.md`](../../../docs/workflows.md#the-run-page). The engine and the routes they read are
[`workflow-runs/`](../workflow-runs/README.md) and [`workflows/`](../workflows/README.md).

This is a module of its own, and the engine imports nothing from it: the pages only read through the services and the routes, so the import cycles of the engine
(the runner API, the dispatch sweep) do not grow with the UI (`src/ci/import-cycles/`).

The pages exist only in a deployment with the capability `implementer` (`src/capabilities/routes.ts`) and are reached from the **Lanes** tab of a project (#925: the sidebar has no Workflows place any more; the tab lists the workspace's workflows until a lane
belongs to a project, #922). They sit in `src/app/(app)/w/[workspace]/workflows/`.

| File                                   | Role                                                                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages.tsx`                            | The `load…` functions that gather a page's data from the services (an id of another workspace is `not_found`) and the `…Content` components that render it                                         |
| `run-detail.tsx`                       | One run (client): status, budget, steps; polls while the run runs                                                                                                                                  |
| `runs-list.tsx`, `workflows-list.tsx`  | The runs of a workflow (polls while one runs) and the workflows of a workspace                                                                                                                     |
| `start-form.tsx`, `start-form-spec.ts` | The form for a manual trigger (one for each when the document has several, #916): the fields come from the `input` schema of the saved document, a `ticket` is a text; `clientRequestId` per input |
| `view.ts`, `github-link.ts`            | What the pages take from a run; `github-link.ts` is the one place a link is made from a step's output (`https://github.com/<repo of the run>/…`, checked with `new URL`)                           |
| `messages.ts`                          | All the copy: a failure code becomes a sentence, never shown as the code; the cost bases and what they mean                                                                                        |
| `api.ts`, `status-badge.tsx`           | The browser's calls to the run routes; the status badge                                                                                                                                            |

Everything a step returned (an agent's result, what a connector got from GitHub) is data from outside: rendered as text, never as markup.
