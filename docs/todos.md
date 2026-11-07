# ToDos: what waits for a person

The ToDo list of the factory (#924, epic #915) is **a query over the runs and the [ticket mirror](ticket-mirror.md); nothing about a ToDo is
stored**. A ToDo is there as long as the thing it is about is: a question while its run waits, a review while the review is asked for.
Only a deployment with the capability `implementer` has the routes (code-review.com does not and behaves as before). The page and the
answer panel are the rest of #925; this is the API behind them. The code is `app/src/todos/` (its `README.md` is the map).

The routes need a signed in member of the workspace (`view`; the review needs the right named below), answer `Cache-Control: no-store`, and are scoped to the workspace in the
address: nothing of another workspace is ever read.

| Route                                          | Answers                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/w/<slug>/todos`                      | `200 { projectId: null, questions, reviews, done }` for all projects of the workspace                                                                                                                          |
| `GET /api/w/<slug>/projects/<projectId>/todos` | The same, narrowed to the lanes and the repository of the project (`projectId` is the project's id, as in `.../projects/<id>/issues`); `404 TODOS_PROJECT_NOT_FOUND` for a project the workspace does not have |
| `POST /api/w/<slug>/todos/reviews`             | Gives a review ([below](#reviews)); needs the right to start an Implementer task (`start_implementer_task`), as answering a question does                                                                      |

An answer to a question is not a new route: the panel posts to the one that exists, `POST /api/w/<slug>/workflows/<workflowId>/runs/<runId>/answer`
with `{ question: { stepRunId, n }, choice?, text? }` ([`workflows.md`](workflows.md#a-question-done-or-ask-920)), with the ids the list gives.

## Questions

A run in the status `waiting` whose agent step holds an **open** question. A question is listed whether or not the ticket carries the label
`agent waiting`: the label is a hint of the App that a repository may refuse, and a question nobody sees would never be answered. The
ticket is added from the mirror when the mirror has it (and says whether it carries the label).

```json
{
  "kind": "question",
  "id": "question:<runId>:<stepRunId>:<n>",
  "projectId": "…",
  "repositoryId": "…",
  "repo": "owner/name",
  "runId": "…",
  "workflowId": "…",
  "lane": "Implement",
  "stepRunId": "…",
  "stepId": "plan",
  "n": 1,
  "question": "Retry which failures?",
  "context": null,
  "options": ["Network errors", "Network errors and 5xx answers"],
  "since": "2026-11-07T08:20:00.000Z",
  "spentUsd": 0.75,
  "budgetUsd": 5,
  "ticket": {
    "number": 12,
    "kind": "issue",
    "title": "…",
    "url": "https://github.com/owner/name/issues/12",
    "labelled": true
  }
}
```

`since` is when the step began to wait. `ticket` is the ticket of the run (`workflow_runs.ticket_ref`), else the pull request an earlier step
opened, else `null`; `title` is `null` and `labelled` is `false` when the mirror does not hold it. `lane` is `null` for an archived lane. The
newest question is first. The question, the options and the context are the agent's text: show them as text.

## Reviews

An **open pull request that a lane opened** (a run's action step made it) and a review is asked for (`review_requested_from` of the mirror):

- from the **viewer**: their GitHub login (the login of their account; an account without one never matches by name), compared without
  regard to case: `audience: "you"`;
- from **another member of the workspace**: `audience: "members"`. A lane that asks `reviewers: "project members"` ([#917](workflows.md)) asks
  every member, and any of them may answer, so a member who is not named still sees it. Until a project has members of its own (#922) the
  members of the workspace are the project members.

A pull request that no lane opened is not a ToDo, whoever is asked. The entry has `id: "review:<repositoryId>:<number>"`, `number`, `title`,
`url`, `requestedFrom`, `audience`, `checksState` and `since` (the provider's time of the last change), with the project, repository, run
and lane as a question has.

### Giving a review

`POST /api/w/<slug>/todos/reviews` with `{ "repositoryId": "…", "number": 7, "decision": "approve" | "request_changes", "comment"?: "…" }`
(`comment` at most 4000 characters, mentions defused). Only a pull request that is a review ToDo **of the caller** can be reviewed here; any
other is `404 TODOS_REVIEW_NOT_REQUESTED` (also for one that does not exist or is not open any more), so the route is no way to review any
pull request of a repository.

The review is made by the GitHub App with a token limited to that one repository and the pull request permission (`pull_requests: write`,
`metadata: read`), on the commit that is the head now, with the body

```
<!-- factory todo-review pr=7 sha=<head> by=<login> event=approve -->
Review by @login: Approved            (or "Changes requested")

<the comment>
```

An account without a GitHub login is "a member of the workspace"; an email never goes onto a pull request. The marker names the pull request,
the commit and the person, so the same decision twice posts once: the answer is `{ "outcome": "already_there", "reviewId" }` for the second.

| Answer                                                                                           | Meaning                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200 { "outcome": "submitted", "reviewId" }`                                                     | The App's review was submitted                                                                                                                                                                    |
| `200 { "outcome": "already_there", "reviewId" }`                                                 | The same review (same pull request, commit, person, decision) was submitted before                                                                                                                |
| `200 { "outcome": "commented", "url" }`                                                          | GitHub refuses a review of a pull request the App opened itself, which is what a lane's pull request is; the decision, with the same words and marker, is written as a comment of the App instead |
| `400 TODOS_REQUEST_INVALID`                                                                      | `issues: [{ path, code: "required" \| "invalid" \| "too_long", message, available? }]`; `available` names the decisions (or the fields) that would have been accepted                             |
| `403 TODOS_CROSS_SITE_REQUEST`, `413 TODOS_BODY_TOO_LARGE`, `415 TODOS_CONTENT_TYPE_UNSUPPORTED` | The request does not come from this site; the body is over 32 KB; it is not `application/json`                                                                                                    |
| `404 TODOS_REVIEW_NOT_REQUESTED`                                                                 | No review is asked of the caller (or of the members) for that pull request of a lane, or it is not open                                                                                           |
| `409 TODOS_GITHUB_UNAVAILABLE`                                                                   | The repository has no active GitHub connection that can review                                                                                                                                    |
| `503 TODOS_REVIEW_FAILED`                                                                        | GitHub could not be asked or refused; nothing was changed, asking again is safe                                                                                                                   |

**Asking for changes does not start a turn of the implementer session.** The session of a run has ended by the time its pull request is
reviewed, and continuing it on a fresh sandbox is the resumable session of the cockpit (#915); the request for changes is on the pull request
for whoever works on it next. The decision is the person's, so it is never made for them.

## The done list

At most 20 entries, the newest first (`at`):

- **an answered question**: `{ kind: "question", id, runId, …, question, options, answer: { text, choice?, by, via: "comment" | "ui" }, ticket, at }`,
  read from the answer the run keeps with the step (the same fact the "answered" edit of the comment on the ticket records), where `at` is the time of the answer;
- **a finished review**: `{ kind: "review", id, …, number, title, url, outcome: "merged" | "closed", at }`: a pull request of a lane that is over while a
  review was still asked for. GitHub takes a request away once a review is submitted, so what the mirror still holds at the end was never
  done; a request that was done is not listed (nothing about the reviews of GitHub is stored here).

## What stays as it was

The answer route, the comments and the labels of a question, the review settings and the code-review.com routes are unchanged. The mirror gains one
column (`review_requested_from`, migration `20261107210000_tracker_review_requested_from`): null for every row that exists and read as nobody
until a delivery or the next full sync says who is asked.
