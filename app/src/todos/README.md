# ToDos

What waits for a person in a workspace (#924, epic #915): the questions of agents and the reviews that are asked for. A query over the runs
and the [ticket mirror](../tracker/README.md); **nothing about a ToDo is stored**. The page for people is [`docs/todos.md`](../../../docs/todos.md);
this file is the map of the code.

| File         | Role                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts` | `createTodosService`: `list(viewer, scope?)` (questions, reviews, done list, for the workspace or one project) and `findReview` (the review ToDo of a pull request for the viewer)                                   |
| `review.ts`  | `readReviewInput` (the strict check of the body: `path`, `code`, `message`, `available`) and `createReviewActions`: a review of the GitHub App in the name of the person, on a pull request that is a ToDo of theirs |
| `http.ts`    | The handlers behind `GET /api/w/:workspace/todos`, `GET /api/w/:workspace/projects/:projectId/todos` and `POST /api/w/:workspace/todos/reviews`                                                                      |
| `errors.ts`  | The stable codes (`TODOS_*`) and their statuses                                                                                                                                                                      |
| `shared.ts`  | The wiring on the running server: `todosServiceFor`, `reviewActionsFor`, and the count the sidebar badge reads (still 0: the page, #925, wires it)                                                                   |
| `ui/`        | The page and its messages (#925)                                                                                                                                                                                     |

Rules that hold here:

- **Nothing is stored.** The list is read when it is asked for. The reads are `workflow_runs` (a run that `waits`, an answered ask, the pull request an
  action step opened) and `tracker_items` (the title, the label, who a review is asked from).
- **Only the pull requests of lanes.** A review is a ToDo only for a pull request a run opened; a pull request of a person is not.
- **A review needs a ToDo.** The review route looks the ToDo up for the caller first (and checks GitHub's live `requested_reviewers`), so it
  reviews nothing else. A request that names logins is acted on by those logins only; the fan-out of a lane (`project members`) by any member.
- **An action leaves no ToDo behind.** After a review the caller's request is taken away on GitHub and in the mirror; and the mirror
  remembers the login with the head commit (`review_acted_by`), whether or not that worked; the list hides the review from it, whatever a
  list of the people asked says later, until a new commit, the end of the pull request, or a request after nobody was asked.
- **The reads are bounded and narrowed in SQL.** 200 rows per kind, newest first; a project's list is narrowed by its repositories inside the
  query; the steps of all runs come in one query; the text matches are served by partial indexes.
- **`src/workflow-runs/` does not import this folder**; this folder reads the question's words and the place of a run from there.
