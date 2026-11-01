# Runs

A run is a job as a person sees it: a review on one pull request,
with its status, who or what started it, its times, the link to the review comment on GitHub and, if
it did not succeed, why. The **Runs** page lists them (newest first, filtered by project and status),
the page of one run shows the details, and the project list shows the status of each repository's
last run. Jobs are made and changed only by the job queue (`src/jobs`); this module reads them.

| File              | Role                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-status.ts`   | Label, description and symbol of each status (a status is never told by color alone); which statuses can still change                                                                                              |
| `run-duration.ts` | `runDurationMs` (waiting: none; running: start to the given time; finished: start to end) and `formatDuration`; the clock is passed in                                                                             |
| `error-copy.ts`   | The plain-English sentence for every error code the queue, the claim of the runner API and the runner can store; a test requires one for each code. An unknown code gets a general sentence and is shown beside it |
| `run-view.ts`     | The boundary to the browser: `toRunRowView`, `toRunDetailView`. Only listed fields leave the server; of the stored result only the comment link and the log tail are read. `safeCommentUrl`, `cleanLog`            |
| `runs-service.ts` | `createRunsService` (`list`, `get`), `parseRunsFilter`, `createLastRunSource` (the real `LastRunSource` of the project list)                                                                                       |
| `http.ts`         | The handlers behind `GET /api/w/:workspace/runs` and `GET /api/w/:workspace/runs/:id`, the two polling routes (`src/app/api/w/[workspace]/runs/`)                                                                  |
| `shared.ts`       | The wiring of the running server: `getRunsService()` (with the secrets of the app removed from a log) and `getLastRunSource()`, both for the workspace the signed-in user works in                                 |
| `ui/`             | `RunsFilterToolbar`, `RunsList`, `RunDetail`, `RunStatusBadge`, the page contents (`runs-page.tsx`, `run-detail-page.tsx`) and the browser side of the polling (`api.ts`)                                          |

The read side of the table is `src/db/repositories/runs-repository.ts` (a join with the repository name,
newest first, and the newest job of each repository); it only reads. The list is read without the
stored result, the arguments and the lease (every open tab asks every few seconds), and the newest job
of a repository is one lookup per repository on the index `jobs_repository_recent`
(`repository_id, created_at, id`).

## What a person sees

| Status       | Label     | Meaning                                                                                                |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| `queued`     | Waiting   | Waiting for a runner (or for its retry time)                                                           |
| `running`    | Running   | A runner holds it                                                                                      |
| `succeeded`  | Succeeded | The review was published                                                                               |
| `failed`     | Failed    | Ended without a review; the error code is translated                                                   |
| `cancelled`  | Cancelled | Stopped before it produced a review (project switched off, pull request closed or turned into a draft) |
| `superseded` | Replaced  | A newer commit made it unnecessary; the page links the newer run                                       |

A run has no pull request title (the job stores the number, the address and the head commit), so none
is shown. The "Started by" line is `Automatic`, `Comment by <login>` or `Started by <login>`.

The **review kind** the run was queued for (#200, `Diff Review` or `Dynamic Review`, `review-settings/kind-names.ts`)
is a "Review kind" fact in the detail summary; the list marks only a Dynamic Review run with a small
badge, since Diff Review is the default. The codes a Dynamic project's run can end with
(`dynamic_review_disabled`, `no_capable_runner`, `dispatch_unavailable` (#328: no Worker was started within the give-up time of a hosted deployment), the three refusals for the plan of the workspace (#277: `workspace_suspended`, `quota_exhausted`, `entitlements_invalid`; their sentences say a run did not start and no model was used, and carry no number) and the Dynamic failure codes) are translated in
`error-copy.ts` like every other code; a test requires a sentence for each.

The **call trace** of a Dynamic Review (#541, `usage.callTrace` of the runner API) is a "Call trace" section of the
detail page, below Diagnostics: a table of the model calls (start, prompt, cache read and write, output, cost, why the call
ended, tools) and one of the tool calls (tool, size of the result, whether it repeated an earlier call), with a note when the
trace was cut at its 100 entries. It holds numbers and stable names only (`runner-api/call-trace.ts` checks the stored value
against the contract before it is read, so a row that is not the contract's shows no section). A run on a managed quality
level shows no cost and no cache count per call (and no such columns), like it shows no cost for the run (#283): whether
a provider reports cache writes says which provider it is. Its ending stays, as the protocol's normalised label. A run without a trace (an older runner, a Diff
Review) shows no section. It is in the detail only, not in the list, and its copy is `ui/call-trace-messages.ts`.

## Runs of the Implementer (#758)

A turn of the Implementer is a job of the kind `implementer` (factory only; code-review.com has no such row). It has a
repository, a base branch, a branch, an instruction and commits, not a pull request, so the views get an `implementer`
variant. The key is **absent** on a Diff or Dynamic run, which keeps their JSON and pages exactly as they were.

- **List row** (`ImplementerRowView`): the repository, the branch (a link to `<repository url>/tree/<branch>` when the
  repository's own url is `https://github.com/<owner>/<name>`), an "Implementer" badge, status, start and duration. No
  pull request number or link (the `prNumber` of the job is the placeholder `-slot`; `prUrl` is always null).
- **Detail** (`ImplementerDetailView`): base branch, branch link, the pushed head, model, cost (hidden for a managed key as
  today), duration, the instruction (first 500 characters; the whole text behind an expander), the agent's summary, the
  commits (first 20, short sha linked to the commit once pushed, "and N more"), the files changed (count, first 20 paths) and
  the usage as for Dynamic. A **failed** task that pushed work says "N commits were pushed to <branch>." next to the error sentence.
- **Where it is read**: `runs-repository.ts` left-joins `implementer_turns` and `implementer_sessions` (branch for the list;
  also base branch and instruction for one run); the list still never reads the stored result. The commits, files and summary
  come from the `implementer` block of the stored result, checked again field by field (`readStoredImplementer`).
- **Untrusted text**: instruction, branch names, subjects, paths and the summary are cleaned with `cleanLog` (control
  characters, terminal escapes, bidi marks), stripped of known secrets, cut (instruction 20 000, summary 8 192, subject 500,
  path 300) and rendered as plain text. A link is made only from the repository url and an encoded branch name or a 40-character
  sha (`githubBranchUrl`, `githubCommitUrl`); a name with a `..` part gets none.
- **Sentences**: `turnErrorCopy` in `error-copy.ts` words the codes where the table of code-review.com does not fit a task
  (`branch_violation`, `cost_limit_reached`, `dynamic_accounting_failed`, `time_limit_reached`, `push_rejected`, and the
  ones that promise a new run on the next push). Nothing in it promises a pull request; the table of code-review.com is not
  changed (its golden stays).

## Polling

The server renders the first snapshot; the browser then asks for newer ones (`useLiveSnapshot` in
`src/ui/`): the list every 3 seconds while a run waits or runs and every 5 seconds once everything is
settled (so a run that starts after the page was opened still appears: a deviation from the story's
"stop after the last state", which holds for the page of one run: it stops asking once the run is
settled). A page nobody looks at (another tab, or a page Next.js keeps mounted but hidden) does not
ask, and asks at once when it is shown again. A failed request keeps the last data on screen and shows
"Updating failed"; the next attempt runs on schedule, and the wait doubles with every further failure in
a row (up to a minute). A failure that asking again cannot fix (the session ended, the person is not
allowed, the run is gone) stops polling and says so. With Cache Components a page that was left stays
mounted, so state is tied to server data: the polled snapshot is shown only while the server snapshot
it was fetched next to is still the current one. The filter is a prop from the address, so the toolbar
and the list follow a new address without being remounted (no remount key).

The duration of a running run is counted to the time of the answer (`generatedAt`), so a page renders
the same on the server and in the browser.

## What never leaves the server

The lease token, the runner id, the delivery id, the heartbeat and lease times and the `errorMessage`
of a result are not in any view, list, detail or polling answer (`run-view.ts` copies listed fields
only; tests search the answers for them). Of the result's `usage` only the detail carries four values
(#201): the model name (cleaned and redacted like the log), the summed tokens, the number of model
calls and the cost, which stays `null` ("Not available") when the runner could not know it. A Dynamic
Review reports the sum of the charges its provider reported for every call, or `null`; it never
guesses a price. The detail shows the cost to four decimals, and a positive cost below $0.0001 reads
"Less than $0.0001", never "$0.0000". The prompt/completion split and the fallback flag stay on the
server; the list carries no usage. **A run on the operator's key** (#283; its usage record says `managed`, names a catalog entry, or, for a row from before the catalog, a tier) shows
no model and no cost: `usage.costUsd` is `null` and `costHidden` is `true`, and the page has no Cost row, because the
cost with the tokens would give the price per token and so the model; the tokens and the call count stay. The operator
reads the cost through the operator API. The log is cleaned (terminal escapes and control characters out)
and passed through the same redaction the runner API uses for results, with the secrets the app
knows. Everything that came from outside (project name, login, a historical question of a removed `/ask` run, the log)
is rendered as text. The links made from stored data are the comment link and the pull request link, and only when they are `https://github.com/` addresses
(`rel="noopener noreferrer"`, one rule: `safeGithubUrl`). The comment link is shown for succeeded runs
and for the two failed runs whose review was posted but shortened to GitHub's comment limit
(`review_state_truncated`, `review_text_truncated`); for every other failed run it is not shown.

## Access

The pages and both routes belong to a workspace and need a member of it: the workspace is the one in the
address (`/w/<slug>/runs`, `/api/w/<slug>/runs`), the proxy answers `401` (data routes) or redirects (pages)
for a visitor and the answer of a path that does not exist for somebody who is not a member, and every page
and route asks `requireWorkspace(...)` / `withWorkspace(...)` itself first (`src/workspaces/README.md`). Every
member may read the runs; a run is looked up in the workspace of the address only, so the id of a run of
another workspace is a run nobody has. `GET /api/w/:workspace/runs` takes `repository` and
`status` (`RUNS_FILTER_INVALID`, `400`, for a value it does not know); `GET /api/w/:workspace/runs/:id` answers
`404 RUN_NOT_FOUND` for an unknown or malformed id. With Cache Components the page of a run streams, so
an unknown id shows the not-found page with status 200; the data route answers a real 404.

## Tests

Unit (`*.test.ts(x)` here): status, duration, error copy (every code has a sentence), the views (links,
logs, what is left out), the filter toolbar (`runs-filter.test.tsx`: the query string and the controls
following the filter), the list and the detail component (table rows, grouped facts, empty states,
polling with fake timers, text rendered as text). Integration: `runs-service.integration.test.ts` (real
Postgres, runs made through the queue with `src/test-support/runs.ts`), `ui/runs-page.integration.test.tsx`
(the pages with real data and the filter from the address, without a remount key),
`integration-tests/http/runs-route*.integration.test.ts` (the proxy in front of the routes, 401 and 403,
the route files). E2E: `e2e/runs/runs.e2e.ts`, where a pull request opened at the fake GitHub arrives as a
signed delivery and the queue stands in for the runner (`e2e/helpers/job-queue.ts`,
`src/test-support/e2e-queue-child.ts`).
