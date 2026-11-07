# Ticket mirror

The ticket mirror is a **read cache** of the issues and pull requests of a project's repository, kept in two tables
(`tracker_items`, `tracker_sync_state`). It exists so that the project board, the issue drawer and the runs can show tickets
without asking GitHub for each of them. It is part of the cockpit of epic #915 and shows what GitHub says; it decides nothing.

**The rule: the mirror can be rebuilt from GitHub at any time and is never the source of truth.** Everything in it is a copy.
Deleting both tables (or one row, or the whole database of a new region) and running **Resync** gives the same rows that the
webhooks had written, and a ticket changed on GitHub is changed here by the next delivery or the next resync, never by us. The app
never writes a ticket to GitHub through the mirror; a change of a ticket (a comment, a label, a pull request) goes to GitHub first
and comes back as a delivery.

- [What is stored](#what-is-stored)
- [How rows get there](#how-rows-get-there)
- [Deliveries out of order](#deliveries-out-of-order)
- [The rebuild rule](#the-rebuild-rule)
- [What is read at the time of the question](#what-is-read-at-the-time-of-the-question)
- [The API](#the-api)
- [What the mirror does not do](#what-the-mirror-does-not-do)

## What is stored

One row per issue or pull request, per repository (`repository_id` and `number` are the key). The values are **as GitHub delivers
them**: no status, type or label is mapped to a vocabulary of ours.

| Column                                        | Content                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace_id`, `repository_id`, `project_id` | The owner. `project_id` is empty until a project is the ticket source (#922); until then the rows are keyed by the repository                                                                                                                                                                                                                                                                                               |
| `provider`, `repo`, `number`, `node_id`       | `github`, `owner/name`, the number, and GitHub's global id (a board item names its ticket by it)                                                                                                                                                                                                                                                                                                                            |
| `kind`                                        | `issue` or `pull_request`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `state`, `state_reason`                       | `open` or `closed`; GitHub's reason (`completed`, `not_planned`, `reopened`). A merged pull request is `closed` with the reason `merged`, the one value that is not GitHub's word for an issue                                                                                                                                                                                                                              |
| `type`                                        | The issue type of the organization (`Bug`, `Task`, ...), as named; empty for none and for a pull request                                                                                                                                                                                                                                                                                                                    |
| `title`, `body_excerpt`                       | The title and the first 500 characters of the description. Text of whoever wrote the ticket: only ever shown as text                                                                                                                                                                                                                                                                                                        |
| `labels`, `assignees`                         | JSON: `[{ "name", "color" }]` and `[{ "login" }]`                                                                                                                                                                                                                                                                                                                                                                           |
| `board_status`                                | The **Status** of the item on the board the project chose (a project without a chosen board: on the first board that has one), as the board names it; empty when the item is on none, or the App may not read boards ([The project board](github-app.md#the-project-board))                                                                                                                                                                                                                 |
| `parent_number`                               | The issue this one is a sub-issue of, in the same repository                                                                                                                                                                                                                                                                                                                                                                |
| `pull_requests`, `closes`                     | For an issue, the numbers of the pull requests that close it; for a pull request, the issues it closes. A pull request closes an issue when its description says so with GitHub's keywords (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` followed by `#12` or `owner/repo#12` of the same repository). `pull_requests` is computed from the `closes` of the cached pull requests |
| `checks_state`                                | The state of the checks of an open pull request, in GitHub's words: the worst conclusion of its check suites (`failure`, `timed_out`, `startup_failure`, `action_required`, `cancelled`, `stale`), else `in_progress` or `queued`, else `success`, else `neutral` or `skipped`. Empty when it has no suite                                                                                                                  |
| `updated_at`, `synced_at`                     | GitHub's time of the last change (the newest one the row has taken: see [Deliveries out of order](#deliveries-out-of-order)), and when we last wrote the row                                                                                                                                                                                                                                                                |
| `deleted_at`                                  | Set when GitHub deleted or moved the issue: the row stays as a **tombstone**, hidden from every read, so that a late delivery cannot bring the issue back. Empty for a ticket that exists                                                                                                                                                                                                                                   |
| `board_seen_at`                               | When a board last said something about the item (a delivery, or the board phase of a full sync): what the end of a full sync resets the board statuses by                                                                                                                                                                                                                                                                   |

`tracker_sync_state` holds, per repository, the position of a full sync that is under way (`cursor`, `started_at`) and when the last
one ended (`last_full_sync_at`).

`workflow_runs.ticket_ref` (`github:owner/repo#128`) names the ticket a run is about. The label trigger sets it, and so does the start of a run
with a `ticket` input (by hand or through the API; the reference of the ticket as the provider resolved it). A run without a ticket has none. The migration filled it
for the runs started before, from both shapes of their stored input: the issue and the repository of a label run (`github.issueLabeled` and `ticket.labeled`), and
`{ input, ticket }` of a run started with a ticket; a raw input (every run whose trigger has no `ticket` input) names no ticket, whatever fields it has.

## How rows get there

A repository is mirrored while it has an **active project**, the same rule that decides which repositories are reviewed. Its rows
come from two sources, and both write the same shape:

**Webhooks** (`docs/github-app.md`, "Events"; the code is `integrations/providers/github-app/tracker-events.ts` and
`src/tracker/mirror.ts`). Each delivery is read by the provider into one change, which the mirror applies:

| Event and action                                                                                          | Effect on the cache                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues`, any action                                                                                      | The ticket is written (created or replaced); `deleted` and `transferred` hide it (tombstone)                                                                                                                                                                                                                                                                                                                                                                                     |
| `pull_request`, any action (`opened`, `closed`, merged, `review_requested`, `synchronize`, `edited`, ...) | The ticket of the pull request is written; `opened`, `reopened` and `synchronize` clear its checks (they belong to a commit), a closed pull request has none; the issues it closes (before and now) are linked again                                                                                                                                                                                                                                                             |
| `issue_comment`, `created` or `edited`                                                                    | The ticket (issue or pull request) is written from the delivery: the time of its last change moves. A deleted comment changes nothing. The comments themselves, and the markers of a question of a run, are not stored: the ask of a run is read from the run                                                                                                                                                                                                                    |
| `sub_issues`                                                                                              | `parent_number` of the sub-issue is set, or emptied (as of the time of the sub-issue in the delivery, `sub_issue.updated_at`)                                                                                                                                                                                                                                                                                                                                                    |
| `projects_v2_item`, `edited` (field Status)                                                               | `board_status` of the item's ticket is set to the new **Status**, or emptied when the new value is none. The item is found by the node id of its content, in any repository of the workspace. With a chosen board, the edit of an item of **another** board is ignored                                                                                                                                                                                                                                                                                     |
| `projects_v2_item`, `created`, `restored`, `archived`, `deleted`                                          | These deliveries carry no status, and the ticket can be on **more than one board**, so the app asks GitHub where the ticket stands now and stores that: the status on **the board the project chose** (`ticket_source.board`, #922; the ticket's item on it, not archived), or, for a project without a chosen board, the first board item of the ticket that has a Status (a ticket that left one board keeps the status another board gives it). One that is added or restored shows its status at once. The delivery names its board (`project_node_id`): with a chosen board, a delivery about **another** board changes nothing. Nothing is stored when the boards cannot be read, except that an `archived` or `deleted` item empties the status |
| `check_suite`                                                                                             | For each open pull request the suite lists (same repository), the app asks GitHub for the check suites of the commit and stores their state (`checks_state`)                                                                                                                                                                                                                                                                                                                     |

What a delivery does not carry stays as it was: a ticket written again keeps its `board_status`, its `pull_requests` and its
`checks_state`. A delivery the mirror cannot use (a repository without a project, a ticket it does not hold) is not an error. A
delivery that only the mirror reads fails with a 5xx if the cache cannot be written (GitHub does not retry a failed delivery by itself: someone presses **Redeliver**, or the nightly resync heals it); a delivery that also starts a
review or a workflow never fails because of the mirror (the failure is logged by its code).

**The full sync** reads everything from GitHub and writes it. It starts when a project is created, and on demand: **Resync** in the
project's setup, or `POST /api/w/<slug>/repositories/<id>/issues/sync`. Since #922 `tracker_items.project_id` and `tracker_sync_state.project_id` hold the project of the repository, and the tickets are also read as `GET /api/w/<slug>/projects/<projectId>/issues` (the same answer; an unknown project is `404 TRACKER_PROJECT_NOT_FOUND`). It reads, one page of one phase at a time:

1. **issues**: every issue and pull request, any state, the least recently changed first
   (`GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc`, 100 per page). Sub-issues come with it
   (`parent_issue_url` of each issue); a pull request comes with its `merged_at`. Each page is asked **from the time of the last item of
   the page before** (`since`, the item at the end is read once more, which is harmless), so a repository of any size ends, and the walk
   does not shift when a ticket is edited while it runs: an edited ticket moves to the end of the list and is read again there. The one
   thing that still stops it is more than 100 pages (10,000 items) that all changed in the same second: the sync then fails with
   `TRACKER_SYNC_FAILED` and stands where it was;
2. **checks**: the open pull requests, 30 per page and in the order of their numbers, and for each the check suites of its head commit. A page is the first 30 whose number is **greater than the last one read** (`cursor.after`), not a page number: a pull request that closes between two slices cannot move another one past the walk. Finding the place costs list calls of 100 pull requests, no check reads;
3. **board**: the items of the board the project chose with their **Status** (`ticket_source.board`, #922: only that board is asked, so a ticket on two boards shows the project's board), or, for a project without one, of every project board of the repository (GraphQL, the one place REST has nothing). A position saved for another board (or for the boards of the repository) starts this phase again from its first page (`cursor.board`). A board
   the App may not read is skipped: GitHub says so with `FORBIDDEN`, `INSUFFICIENT_SCOPES` or `NOT_FOUND` as the type of every error of
   the answer. **Any other error** (a rate limit, a server error, a query GitHub could not run) fails the call like a REST failure, so the
   sync keeps its place and continues from there; it is never read as "no board".

The token of each read is minted for it and limited to one repository and to read access (`issues`, `pull_requests`, `checks` and
`metadata`; `organization_projects` and `metadata` for the board). The sync is **resumable**: the phase and position are saved after each
page (`tracker_sync_state.cursor`), so a call that ends early (the request has about twenty seconds, GitHub did not answer) is
continued by the next call, which answers `202` while there is more to read and `200` when the cache is complete. A sync that has not
moved for an hour (counted from the last page that was saved, `tracker_sync_state.updated_at`, not from its start) starts again from the
beginning. The nightly resync (below) continues a sync for a week instead of an hour, because its calls are a day apart.

A position that **keeps failing** is reset. A call that fails on the saved position (GitHub failed, or a write did) writes the count of failures in a row into the cursor
(`failures`); a page that was read drops it. After **3** failures in a row (`MAX_FAILURES` in `sync.ts`) the sync starts again from the first page with a new start time and logs
`TRACKER_SYNC_CURSOR_RESET` (a position of the boards that a board created or closed under way made useless would otherwise block the repository until the sync is abandoned, up to
a week for the nightly resync). Any failure counts, so three nights of a GitHub outage also start the sync again, which costs reading it once more and nothing else. A page that the
end of its slice aborted is no failure and is not counted.

**The nightly resync** (#932). A delivery can be missed (a GitHub App that does not subscribe to `issues`, `sub_issues` or `check_suite`, a delivery GitHub gave up on)
and nothing flags it, so once a night (`GET /api/internal/tracker-resync`, `app/vercel.json`, `CRON_SECRET`) every **active project** is synced
with the same code as **Resync**. The run has a budget of four minutes, counted from the moment the function is entered. Every project gets a fair
slice of what is left (the rest of the budget divided by the projects still to go, at least ten seconds), so one huge project cannot use up the night
for the others. The projects whose last sync ended, or that never ran, come first, the one attempted longest ago first; a project whose last sync did
not end comes after them. The projects the budget does not reach are counted `deferred` and, having the oldest attempt, come first the next night.
A sync that its slice ends in the middle of **continues the next night**: the nightly run asks the sync to resume, so a sync that has not moved for
a week (not an hour) starts again from the first page. A repository too big for one slice is `partial` for a few nights, completes, and only then applies
the [rebuild rule](#the-rebuild-rule), counted from the start of the whole sync, so what an earlier night wrote is not removed. A page that is in flight
when the slice ends is aborted thirty seconds later, and never later than 285 seconds into the run (the function may run 300), so the counts line is
always logged. One project's
failure is logged (its repository id and the code of the failure, the platform's own code when it has one) and the others go on; when the platform
answers a project with a **rate limit**, the other projects of the same installation are skipped in this run (counted `deferred`). A deployment
without the factory (`implementer`) reads the mirror nowhere: the route answers `skipped` and asks GitHub for nothing. The answer is counts only
(`projects`, `done`, `partial`, `failed`, `deferred`); a project whose page was aborted at the end of its slice counts `partial`, not `failed`. A reread (after a board delivery) or a delivery can see state that is already stale or race
another delivery for the same ticket; the nightly resync heals what such a race leaves behind.

**What tells that a sync is overdue.** The list answers `sync: { lastFullSyncAt, inProgress, lastWriteAt }`. `lastWriteAt` is when a row was last written
(by a delivery or by a sync): a `lastWriteAt` that is not after `lastFullSyncAt` means no delivery has arrived since the last full sync, which
for a repository that has activity is the sign of a missed subscription. The read is served by the index `tracker_items_written_index (workspace_id, repository_id, synced_at desc)` (#937), the first entry of the repository. The hint and the Resync button in the project's Setup are left to the
rework of the project pages (#922); they read these two times.

**One sync at a time.** Starting a sync is one atomic step in the database (`claimSync`: an insert that updates only when there is no sync,
the last one ended, it has not moved for an hour or its cursor is unreadable). Of two calls at the same time one starts, the other
continues the sync that is there: it never resets another call's cursor or start time. Two calls that continue the same sync read a
page twice and write the same rows twice.

## Deliveries out of order

GitHub delivers each event once or more, and not in the order the changes were made (a failed delivery is retried later; a replay can be
asked for). A delivery is a snapshot of the ticket as of its `updated_at`, so **the mirror never lets an older snapshot replace a newer
one**:

- a ticket is replaced only by a delivery whose `updated_at` is **equal or newer** than the row's (`updated_at` of the row is the newest
  time it has taken). An older one changes nothing (the checks, the issues a pull request closes and the parent stay as they are) and is
  answered as `not_mirrored`; the row still counts as written, so a full sync that is reading keeps it;
- the same rule holds for the page of a **full sync**: a page read before a newer webhook does not overwrite it;
- a parent change (`sub_issues`) and a deletion carry the time of the issue in the delivery and follow the same rule: a change older than
  the row is dropped, and a newer one moves the row's time, so an older issue delivery that comes after it is dropped too;
- a **deleted** issue stays as a tombstone (`deleted_at`): hidden from the list, from the single read, from the board and checks
  writes and from the linking of pull requests, but present for the ordering. A delivery older than the deletion, or at the very time of
  it, does not bring the issue back; one **strictly newer** does (the tombstone is cleared). A full sync does not count a tombstone as
  removed and keeps it for 30 days after it was last written, then forgets it.

What is not covered: a deletion that arrives before the delivery that created the issue leaves no tombstone (there was no row), so a
late creation writes the issue until the next full sync removes it.

## The rebuild rule

When the last phase of a full sync is over:

1. every ticket **not written since the sync began** is removed: GitHub does not have it any more (a deleted or transferred issue whose
   delivery was missed). **Not when a ticket of the list could not be read** (a record that lacks what the mirror needs): the row of that
   ticket would look gone, so nothing is removed in that sync, the number of tickets it left out is in the answer (`skipped`) and in the
   log, and the next sync tries again. The count is kept across the calls of one sync;
2. the **board statuses** no board said anything about since the sync began are emptied (an item that left the board without a delivery).
   They are not emptied before: a board that cannot be read keeps the statuses the cache has, and a status a webhook set while the sync was
   between its phases survives. A board the App may not read keeps its place in the list of boards, so the position of the boards after it does
   not shift between the calls of one sync;
3. at the end of the **checks** phase the checks of every row that is not an open pull request are emptied (every open pull request was read in
   that phase, and a state GitHub does not know is written as empty). They are not emptied before: a sync that is cut in the middle of the checks
   leaves the pull requests it has not reached as they were. The phase continues after the last pull request **number** it read, so a pull request that
   closes between two slices moves none past the walk; one that closed under way is not listed, and its checks are emptied here (its row is closed). A position
   saved by page number before #937 starts the checks again from the first pull request;
4. the pull requests of every issue are computed again from the `closes` of the pull requests, in one pass over the pull requests;
5. `last_full_sync_at` is set and the cursor is cleared.

Because the sync reads the same fields the webhooks read, with the same functions (`tracker-map.ts`: the same rule for the closing
keywords, the merged state and the state of the checks), **a cache that was deleted and synced holds what a cache kept current by
the webhooks holds**: that is the test of the rule (`src/tracker/sync.test.ts`, "the rebuild rule"). The things only a delivery can say are the exception, and
the sync says them by reading: the board status of an item whose board change was not delivered, and the checks of a pull request from a
fork, which GitHub's `check_suite` delivery does not attribute to the pull request.

To rebuild by hand: `delete from tracker_items; delete from tracker_sync_state;`, then press **Resync** for each project. Nothing else
depends on the tables: the runs, their costs and the project keep working while the cache is empty, and the issue list shows the
tickets as they arrive.

## What is read at the time of the question

The list adds two things that are **never stored** (they are read from `workflow_runs` when the list is asked for, by `ticket_ref`):

- `lane`: the run that is going on for the ticket (the newest running one): its id, the name of its workflow, its current step and its
  status; `null` when no run is going on;
- `costUsd`: the sum of what all runs of the ticket spent so far, whatever their status.

The ask of a run (a question the run put to a person) is read from the run in the same way; the engine has no such step yet, so the
list has no field for it.

## The API

`GET /api/w/<slug>/repositories/<repositoryId>/issues?state=open` (every member of the workspace). Until projects are the ticket source
(#922) the route is addressed by the repository; `/projects/<id>/issues` will be a thin alias.

- `state`: `open` (the default), `closed` or `all`; `limit` (1 to 200, default 100) and `offset`. The newest change comes first.
- The answer is `{ repositoryId, repo, items, sync: { lastFullSyncAt, inProgress, lastWriteAt } }`. An item has the fields of the table above
  (`number`, `kind`, `state`, `stateReason`, `type`, `title`, `bodyExcerpt`, `labels`, `assignees`, `boardStatus`, `parentNumber`,
  `pullRequests`, `checksState`, `updatedAt`, `syncedAt`), the address of the ticket on GitHub (`url`), and `lane` and `costUsd`.
- A query that cannot be used is `400 TRACKER_REQUEST_INVALID` with `issues: [{ path, code, message, available }]`: `path` names the
  parameter, `code` is `invalid` or `out_of_range`, and `available` lists the values that would have been accepted for a name out of a
  closed set (`state`).
- Other codes: `TRACKER_REPOSITORY_NOT_FOUND` (404), `TRACKER_PROJECT_NOT_ACTIVE` (409, the repository has no active project).

`POST /api/w/<slug>/repositories/<repositoryId>/issues/sync` (members who may change the project's settings) runs the full sync as above and answers
`{ status, next, written, removed, skipped, boardAvailable }`: `200` with `status: "done"`, or `202` with `status: "partial"` and the phase `next`
reads when it is asked again. `TRACKER_INTEGRATION_UNAVAILABLE` (409) says the installation is suspended or removed;
`TRACKER_SYNC_FAILED` (503) says GitHub could not be asked, and the sync stands where it was.

## What the mirror does not do

- **It does not map.** GitHub's `Status`, type and reason are shown as they come; there is no list of statuses of ours.
- **It is no source of truth.** A ticket is never created or changed from it; a field is never read from it to decide something that
  matters (an agent step reads the ticket from GitHub).
- **It does not hold comments**, the diff of a pull request or the history of a ticket.
- **It holds one repository's tickets.** A sub-issue or a closing keyword that points to another repository is left out.
- **A repository without a project is not mirrored**, and a project that is switched off keeps its rows until a resync after it is
  switched on again; they are not served while it is off.

Code: `app/src/tracker/` (the mirror, the sync, the list and its routes), `app/src/db/repositories/tracker-repository.ts` (the only SQL),
`app/src/integrations/providers/github-app/` (`tracker-events.ts`, `tracker-map.ts` and the three reads of the client).
