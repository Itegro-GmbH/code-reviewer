# ToDos

What waits for a person in a workspace (#924, epic #915): the questions of agents and the reviews that are asked for. A query over the runs
and the [ticket mirror](../tracker/README.md); **nothing about a ToDo is stored**. The page for people is [`docs/todos.md`](../../../docs/todos.md);
this file is the map of the code.

| File             | Role                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`     | `createTodosService`: `list(viewer, scope?)` (questions, reviews, done list, for the workspace or one project), `countOpen(viewer)` (`{ open, projects }` for the badges: the same reads without the done list and without the ticket of a question) and `findReview` (the review ToDo of a pull request for the viewer)                                                                                                   |
| `review.ts`      | `readReviewInput` (the strict check of the body: `path`, `code`, `message`, `available`) and `createReviewActions`: a review of the GitHub App in the name of the person, on a pull request that is a ToDo of theirs                                                                                                                                                                                                       |
| `http.ts`        | The handlers behind `GET /api/w/:workspace/todos`, `GET /api/w/:workspace/projects/:projectId/todos` and `POST /api/w/:workspace/todos/reviews`                                                                                                                                                                                                                                                                            |
| `count-cache.ts` | `createCountCache` and `openCountKey`: the short memory behind the badge's route, in the memory of one server instance (per key, reads at the same time share one, fresh reads at the same time share one more that starts after them, a failure is not kept, `fresh` replaces the entry; the key is the workspace and the lowercased login, empty for none)                                                               |
| `errors.ts`      | The stable codes (`TODOS_*`) and their statuses                                                                                                                                                                                                                                                                                                                                                                            |
| `shared.ts`      | The wiring on the running server: `todosServiceFor`, `reviewActionsFor`, and `openTodoCountFor` (`countOpen` for the viewer through the cache of `count-cache.ts`, 10 s per workspace and person, `fresh` to skip it)                                                                                                                                                                                                      |
| `ui/`            | The page and the ToDos tab of a project (`todos-page.tsx`), the panel (`todo-panel.tsx`) with the answer form (`answer-panel.tsx`) and the review form (`review-panel.tsx`), the reader of the list (`use-todo-list.ts`), the calls (`api.ts`), the words (`messages.ts`), what a person typed that is kept (`panel-parts.tsx`) and who looks (`actor.ts`: the right to answer and whether the account has a login) (#925) |

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
- **The UI posts to routes that exist.** An answer goes to the run's `answer` route (the run page uses the same one), a review to `todos/reviews`; the page invents no
  state: it hides what the person dealt with and reads the list again. Text of the agent or of GitHub is rendered as text; an address is a link only if it is `http(s)`.
- **`ui/` imports server code as types only** (`review.ts` and `service.ts` pull in the database): the client bundle gets the shapes, not the code.
