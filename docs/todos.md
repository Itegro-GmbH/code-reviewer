# ToDos: what waits for a person

The ToDo list of the factory (#924, epic #915) is **a query over the runs and the [ticket mirror](ticket-mirror.md); nothing about a ToDo is
stored**. A ToDo is there as long as the thing it is about is: a question while its run waits, a review while the review is asked for.
Only a deployment with the capability `implementer` has the routes and the page (code-review.com does not and behaves as before). This file
describes the API ([below](#the-page) the page and the answer panel on it, #925). The code is `app/src/todos/` (its `README.md` is the map).

The routes need a signed in member of the workspace (`view`; the review needs the right named below), answer `Cache-Control: no-store`, and are scoped to the workspace in the
address: nothing of another workspace is ever read.

| Route                                          | Answers                                                                                                                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/w/<slug>/todos`                      | `200 { projectId: null, questions, reviews, done }` for all projects of the workspace                                                                                                                          |
| `GET /api/w/<slug>/projects/<projectId>/todos` | The same, narrowed to the lanes and the repository of the project (`projectId` is the project's id, as in `.../projects/<id>/issues`); `404 TODOS_PROJECT_NOT_FOUND` for a project the workspace does not have |
| `GET /api/w/<slug>/todos/count`                | `200 { open }`: the number of open ToDos of the caller (questions and reviews, not the done list), what the badge on the sidebar's ToDos link shows; read by the badge when the page changes and when the ToDos page dealt with one |
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
  regard to case: `audience: "you"`. **A request that names logins can only be acted on by those logins**: a pull request asked of bob is
  no ToDo of carol, whoever carol is;
- from **the members, by the lane's fan-out**: `audience: "members"`. Only a lane whose document asks `reviewers: "project members"`
  ([#917](workflows.md)) asks every member and lets any of them answer, so a member who is not named still sees the review (when at least
  one asked login is a member). Until a project has members of its own (#922) the members of the workspace are the project members. The
  fan-out is read from the lane's document (the version the run ran), not guessed from who is asked.

**A person who acted does not see the review again.** The App's review does not satisfy a person's request on GitHub, so GitHub keeps it;
after a review the caller's request is taken away ([below](#giving-a-review)) and, whether that worked or not, the mirror remembers that the login acted, together with the head commit of the pull
request at that time (`review_acted_by`, JSON `[{"login", "sha"}]`, [ticket mirror](ticket-mirror.md)); the list hides the review from that
login. The mark is kept for a member of a fan-out too, who is never asked by name: a list of the people asked that lacks the login does not
end it, so a later `pull_request` delivery or the nightly resync cannot bring the review back and invite a second, contradicting one. The
mark ends when the pull request gets a new commit (a request that stands is for the new head: the delivery clears it, and the full sync
drops the marks made for another head), when the pull request is over, and when nobody is asked any more (a request after that is a new
ToDo). One edge stays: a person whose request was taken away and who is asked again on the same commit does not see it until the commit
changes. The other members asked by a fan-out keep seeing the review until they act or the pull request ends. Team reviewers are not read
(a request for a team is nobody's ToDo here).

A pull request that no lane opened is not a ToDo, whoever is asked. The entry has `id: "review:<repositoryId>:<number>"`, `number`, `title`,
`url`, `requestedFrom`, `audience`, `checksState` and `since` (the provider's time of the last change), with the project, repository, run
and lane as a question has.

### Giving a review

`POST /api/w/<slug>/todos/reviews` with `{ "repositoryId": "…", "number": 7, "decision": "approve" | "request_changes", "comment"?: "…" }`
(`comment` at most 4000 characters, mentions defused). Only a pull request that is a review ToDo **of the caller** can be reviewed here; any
other is `404 TODOS_REVIEW_NOT_REQUESTED` (also for one that does not exist, is not open any more, or whose request GitHub no longer holds:
the mirror is checked against GitHub's `requested_reviewers` of the pull request at the moment of the review), so the route is no way to
review any pull request of a repository.

The review is made by the GitHub App with a token limited to that one repository and the pull request permission (`pull_requests: write`,
`metadata: read`), on the commit that is the head now, with the body

```
<!-- factory todo-review pr=7 sha=<head> by=<login> event=approve -->
Review by @login: Approved            (or "Changes requested")

<the comment>
```

An account without a GitHub login is "a member of the workspace"; an email never goes onto a pull request. The marker names the pull request,
the commit and the person, so the same decision twice posts once: the answer is `{ "outcome": "already_there", "reviewId" }` for the second.

**What is left behind.** After the review (or the comment), the App takes the caller's request away
(`DELETE /repos/{owner}/{repo}/pulls/{number}/requested_reviewers`, the same token with `pull_requests: write`) and the mirror row's
`review_requested_from` loses the login at once, so the ToDo is gone before the next delivery. If that fails (GitHub unreachable, no
permission) or the caller was not asked by name, the action is remembered in the mirror instead (see above) and the answer is the same:
the review stands, a failure of this clean-up is logged by its code only and never fails the review.

| Answer                                                                                           | Meaning                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200 { "outcome": "submitted", "reviewId" }`                                                     | The App's review was submitted                                                                                                                                                                                                                                                                                   |
| `200 { "outcome": "already_there", "reviewId" }`                                                 | The same review (same pull request, commit, person, decision) was submitted before                                                                                                                                                                                                                               |
| `200 { "outcome": "commented", "url" }`                                                          | GitHub refuses a review of a pull request the App opened itself ("can not approve your own pull request"), which is what a lane's pull request is; the decision, with the same words and marker, is written as a comment of the App instead. Any other 422 of GitHub is `503 TODOS_REVIEW_FAILED`, not a comment |
| `400 TODOS_REQUEST_INVALID`                                                                      | `issues: [{ path, code: "required" \| "invalid" \| "too_long", message, available? }]`; `available` names the decisions (or the fields) that would have been accepted                                                                                                                                            |
| `403 TODOS_CROSS_SITE_REQUEST`, `413 TODOS_BODY_TOO_LARGE`, `415 TODOS_CONTENT_TYPE_UNSUPPORTED` | The request does not come from this site; the body is over 32 KB; it is not `application/json`                                                                                                                                                                                                                   |
| `404 TODOS_REVIEW_NOT_REQUESTED`                                                                 | No review is asked of the caller (or of the members) for that pull request of a lane, or it is not open                                                                                                                                                                                                          |
| `409 TODOS_GITHUB_UNAVAILABLE`                                                                   | The repository has no active GitHub connection that can review                                                                                                                                                                                                                                                   |
| `503 TODOS_REVIEW_FAILED`                                                                        | GitHub could not be asked or refused; nothing was changed, asking again is safe                                                                                                                                                                                                                                  |

**Asking for changes does not start a turn of the implementer session.** The session of a run has ended by the time its pull request is
reviewed, and continuing it on a fresh sandbox is the resumable session of the cockpit (#915); the request for changes is on the pull request
for whoever works on it next. The decision is the person's, so it is never made for them.

## The done list

At most 20 entries, the newest first (`at`):

- **an answered question**: `{ kind: "question", id, runId, …, question, options, answer: { text, choice?, by, via: "comment" | "ui" }, ticket, at }`,
  read from the answer the run keeps with the step (the same fact the "answered" edit of the comment on the ticket records), where `at` is the time of the answer;
- **a finished review**: `{ kind: "review", id, …, number, title, url, outcome: "merged" | "closed", at }`: a pull request of a lane that is over while a
  review was still asked for the viewer (by name, or by the lane's fan-out: the same audience as an open review). A request that a
  review from the list took away is not there at the end and is not listed (nothing about the reviews of GitHub is stored here); one that
  stood until the pull request was over (nobody acted, or the App could not take it away) is.

## How much is read

Every list is read newest first and bounded: at most 200 waiting runs, 200 answered questions and 200 pull requests of lanes are looked
at (more than a person can answer; the done list shows 20). A list narrowed to a project is narrowed **inside the queries**, by the
repositories of the project, before the bound applies, so the runs of another project cannot use it up. The steps of all runs that are
read come in one query (not one per run), and the two text matches on the steps (an answered question, a succeeded action step whose
output names a pull request) are served by partial indexes (migration `20261107220000_todo_list_indexes`), not by a scan of the table.

## What stays as it was

The answer route, the comments and the labels of a question, the review settings and the code-review.com routes are unchanged. The mirror gains two
columns (`review_requested_from` and `review_acted_by`, migration `20261107210000_tracker_review_requested_from`): null for every row that
exists, read as nobody until a delivery or the next full sync says who is asked, and as nobody who acted.

## The page

`/w/<slug>/todos` (the sidebar entry "ToDos") and the tab **ToDos** of a project (`/w/<slug>/projects/<id>/todos`, the same list from
`GET …/projects/<projectId>/todos`; a repository that is not a project yet says so and reads nothing). Both are the same component
(`app/src/todos/ui/todos-page.tsx`); the prototype is the board "1 ToDos with answer panel".

| Part                | What it does                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open · n**        | The questions and the reviews in one list, the newest first: kind, since when, the question or the pull request title (text, never markup), repository, ticket and lane, and the pill **Answer** or **Review**. With ToDos of more than one project a **Project** filter appears. A ToDo the person dealt with leaves the list at once                |
| **Done · n**        | The done list of the API (answered questions with who answered and from where, finished reviews)                                                                                                                                                                                                                  |
| States              | *Loading* (skeleton, announced), *empty* (with the way to the projects, or a line for a project), *error* (alert: the first read failed, the page tries again by itself; a failure that asking does not fix, as a signed-out session or a project that is gone, stops the polling), *stale* (a later read failed: the last list stays and a status line says so) |
| Polling             | One read when the page opens, then every 20 s while the page is shown (never while it is hidden), and at once after an answer or a review                                                                                                                                                                       |
| **The panel**       | Opens next to the list (below it on a narrow screen) for the ToDo that is picked; the focus moves to its heading, **Close** gives it back to the row. A ToDo that is not on the list any more (answered elsewhere, or by this panel) says so and offers no form                                                  |

**Answering a question.** The question is shown like a comment of the agent (its text and context as text), with lane, spend of the budget, since
when and the ticket. The options are radio choices, a note is optional, and **Answer** posts to the route that exists:
`POST /api/w/<slug>/workflows/<workflowId>/runs/<runId>/answer` with `{ question: { stepRunId, n }, choice?, text? }` (`choice` is the number of the
option from 1, `text` the note, or the answer when the question has no options). The answer is written on the ticket in the name of the signed-in
person (`Answer by @login: …`, [`workflows.md`](workflows.md#a-question-done-or-ask-920)). One answer goes at a time (a second click while one is on its way does
nothing). The refusals are told in words and the note stays: `WORKFLOW_RUN_NOT_WAITING` and `WORKFLOW_RUN_QUESTION_CHANGED` ("already answered or replaced": the
list is read again), `WORKFLOW_RUN_ANSWER_INVALID` (an option the question has not, an empty or too long answer). After success the panel says the answer went on, the focus
moves to that message and the ToDo is in **Done** as soon as the list is read again.

**Reviewing.** A review ToDo shows the pull request (a link to it on GitHub when its address is a web address), who is asked (you, or the
project members: any member may answer) and the checks, with an optional note (4000 characters). **Approve** and **Request changes** post to
`POST /api/w/<slug>/todos/reviews` and the result is told as the API names it: `submitted` ("Approved on GitHub" / "Changes requested on GitHub"), `commented` (GitHub does not let
the App review its own pull request, so the decision stands as a comment; the panel links to it) and `already_there` (the same review was posted before). Errors
(`TODOS_REVIEW_NOT_REQUESTED`, `TODOS_GITHUB_UNAVAILABLE`, `TODOS_REVIEW_FAILED`, …) are told in words and nothing is lost: both buttons work again. A review that was given is not on the list any more (and
is not in **Done**, which holds only reviews that ended while still asked); asking for changes does not start the agent again ([above](#giving-a-review)).

**The badge.** The sidebar's ToDos link shows the count of open ToDos (`GET …/todos/count`, `countOpen` of the service: the two reads of the questions
and the reviews, bounded as the list is, without the done list; one call per page change, not one per ToDo). After an answer or a review the page sends the browser event
`factory:todos-changed` and the badge reads again. Nothing is shown for none or when the read fails.

**Accessible and safe.** The list is a list of buttons (`aria-pressed`), the panel a labelled region, the options a fieldset with a legend, the note and the filter have labels, results
and errors are in live regions (`role="status"` / `role="alert"`), and the focus is moved on open, on close and to a result. Everything the agent or GitHub wrote
(question, options, context, titles, logins) is rendered as text; an address is a link only when it is `http(s)`.
