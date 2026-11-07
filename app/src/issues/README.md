# Issues tab (#925)

The **Issues** tab of a project's cockpit: the table of the issues of its ticket source, the issue drawer and the dialog that starts a lane on an issue. It exists only in a deployment with the capability `implementer`
(the cockpit is the factory's). The page for people is [`docs/workflows.md`](../../../docs/workflows.md#the-issues-tab-925); the data is the ticket mirror ([`src/tracker`](../tracker/README.md)).

| File                    | Role                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load.ts`               | `loadIssuesPage` (server): the project of the repository, the first list of its tickets and the lanes that can start from an issue                                                                                |
| `start-lanes.ts`        | `startLaneOf`: reads a lane's saved document for the start dialog (description, first steps, budget, turn time limit); a lane is offered only when its manual trigger asks for a ticket and nothing else required |
| `view.ts`               | Pure: which tickets are issues, what an issue waits for (`waitsFor`), the tiles, sub-issues, the pull request of an issue; addresses are checked before they become links                                         |
| `api.ts`                | The browser's calls: the project's issues route and, for the drawer, the run on an issue; the polling intervals                                                                                                   |
| `issues-board.tsx`      | The tiles, the table (polls like the runs list), the filter, and the drawer and the dialog it opens                                                                                                               |
| `issue-drawer.tsx`      | The side sheet (Radix dialog: focus trap, Escape, focus returns to the row's button via `return-focus.ts`)                                                                                                        |
| `start-lane-dialog.tsx` | The one question "Which lane?", the lane's facts and limits, and the start through the lane's start route with the issue as `ticket`                                                                              |
| `return-focus.ts`       | `useReturnFocus`: the board remembers the button that opened the drawer or the start dialog (controlled dialogs have no Trigger) and hands the focus back to it                                                   |
| `messages.ts`           | The words around GitHub's own                                                                                                                                                                                     |

Rules that hold here:

- **Nothing is mapped.** State, type, labels, board status and checks are GitHub's words. The lane, its step and the cost are the only things the factory adds.
- **No machine, profile or model is asked.** The profile of a step carries the harness, the model, the key and the runner; the dialog asks which lane and nothing else.
- **Review means an open pull request.** `waitsFor` offers Review for the newest open pull request linked to the issue; closed and merged ones leave Start, and so does one the loaded list does not hold (its state is unknown, and the list is only the tickets that changed last).
- **A field we do not have is left out**, not made up (no tokens or lines of code yet).
- This module imports `tracker`, `workflow-pages`, `workflows` and `projects`; none of them imports it (the pages of `src/app` wire it in).
