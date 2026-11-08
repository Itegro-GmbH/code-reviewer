# Webhooks

`POST /api/webhooks/github-app` is the one webhook URL of the GitHub App: installations, repository
changes, pull requests, comment commands and labels on issues (#845) of every installation arrive here. The route file
(`src/app/api/webhooks/github-app/route.ts`) only calls `getGithubAppWebhookHandler()` (and hands it `labelTriggerFor` of the workflow engine, see below); the logic is a
function of its collaborators in this folder, so tests wire fakes in.

The route is **public**: it needs no session, and the auth guard must keep letting `/api/webhooks/**`
through. The signature of the delivery is its authentication.

| File                                                 | Role                                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-app-handler.ts`                              | `createGithubAppWebhookHandler(deps)`: the steps below                                                                                                                                               |
| `limited-body.ts`                                    | `readLimitedBody`: reads the body as text and stops at the limit, whatever `Content-Length` claims                                                                                                   |
| `automatic-review-policy.ts`                         | The trigger policy for pull request events: drafts, the settings, the commit still being the head (pure functions)                                                                                   |
| `automatic-review-settings.ts`, `debounce-config.ts` | Where the policy gets the project's settings from, and the configured wait of a push (`REVIEW_DEBOUNCE_SECONDS`)                                                                                     |
| `review-trigger-intake.ts`                           | `ReviewTriggerIntake`: where a review trigger goes (`enqueueReviewTrigger(trigger, integration, source, options)`) and where a closed pull request drops its waiting jobs                            |
| `job-queue-intake.ts`                                | `createJobQueueReviewTriggerIntake`: the intake of the running app, a thin mapping from a trigger to a job in the queue (`src/jobs`)                                                                 |
| `shared.ts`                                          | The wiring of the running server: database, registry, the process-wide sync service, and for each workspace its project service, settings and intake (`getJobQueueReviewTriggerIntake(workspaceId)`) |
| `errors.ts`, `logger.ts`                             | The stable error codes of the answers, and the two-level logger                                                                                                                                      |

## What happens to a delivery

Each step ends the request when it fails; nothing before step 5 writes anything.

| Step | What                                                                                                                                                                                                                                                                                              | Answer                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Size: more than 1 MiB (`WEBHOOK_MAX_BODY_BYTES`) is refused, by `Content-Length` or while reading                                                                                                                                                                                                 | `413` `WEBHOOK_BODY_TOO_LARGE`                                                                                                             |
| 2    | Signature: `verifyWebhook(null, request)`, HMAC-SHA256 of the exact bytes received, constant time                                                                                                                                                                                                 | `401` `WEBHOOK_SIGNATURE_INVALID` (also when the secret is not configured: the cause is logged once, never answered)                       |
| 3    | Shape: `X-GitHub-Event` and `X-GitHub-Delivery` exist and look like names, the body is JSON                                                                                                                                                                                                       | `400` with `WEBHOOK_EVENT_HEADER_INVALID`, `WEBHOOK_DELIVERY_HEADER_INVALID` or `WEBHOOK_BODY_NOT_JSON`                                    |
| 4    | Relevance: only `pull_request`, `issue_comment`, `issues`, `installation` and `installation_repositories` are used; any other event (`ping`, `push`, ...) is answered at once, nothing is recorded                                                                                                | `202` `event_not_used`                                                                                                                     |
| 5    | Claim: the delivery id is claimed in `webhook_deliveries`; an id that succeeded before is a duplicate, an id another request holds right now is in progress                                                                                                                                       | `202` `duplicate`; `409` `WEBHOOK_DELIVERY_IN_PROGRESS`                                                                                    |
| 6    | Identify: `identifyWebhook` names the installation; the integration is loaded by `(github_app, externalId)` in any workspace (`integration-directory-repository.ts`), and with it the workspace: everything after this step (projects, settings, the job queue) runs in `integration.workspaceId` |                                                                                                                                            |
| 7    | Translate: `parseEvent` gives `review_trigger`, `installation_changed` or `ignored`                                                                                                                                                                                                               |                                                                                                                                            |
| 8    | Act: a trigger needs an active project for its repository (`project_not_active` otherwise), then the trigger policy (below), then `canTrigger`, then the intake; a closed pull request drops its waiting jobs; an installation change goes to the shared sync                                     | `202` with the outcome; `400` `WEBHOOK_PAYLOAD_INVALID` when the payload of a used event lacks a field the app reads (no head commit, say) |

Answers carry only an error code or `{ "status": "accepted", "outcome": ... }`, never the body, a
signature or a secret. Log lines name the delivery id, the event and the outcome, and nothing else.

The outcomes of step 6 to 8 are `tracker_updated` (the ticket mirror took something from the delivery, see below), `workflow_runs_started` and `no_workflow_matched` (a label on an issue, see below), `ticket_answered` and `no_answer_taken` (a comment `/answer ...`, see below), `trigger_enqueued`, `trigger_skipped` (a pull request event the policy
turned down, with the reason in the log), `waiting_jobs_discarded` (a pull request was closed or turned into a draft),
`installation_changed`, `ignored` (a genuine event that starts nothing, such as a `labeled` pull
request, or a command from a user without write access),
`trigger_not_allowed` (`canTrigger` said no), `command_not_allowed` (the project does not allow that
comment command; like `trigger_not_allowed` the delivery id can be claimed again), `project_not_active` (the repository has no active project: never
activated, deactivated, or gone from the installation; nothing is handed to the intake and, like
`trigger_not_allowed`, the delivery id can be claimed again, so redelivering it after the project was
activated works), `integration_disabled` (the installation is suspended or
removed: its own installation events still go through, everything else is not looked at) and
`unknown_installation` (no row for the installation and the event is not an installation event). They
are stored with the delivery. Anything unexpected before the claim (a stream error, a registry problem)
is logged and answered with a generic `500 WEBHOOK_PROCESSING_FAILED`.

### Installations the app does not know yet

An `installation` `created` delivery arrives before any row exists. The route lets `parseEvent` read it
with a stand-in integration and hands the `installation_changed` event to
`getIntegrationSync().handleInstallationChange`, which asks GitHub (App JWT) whether the installation
exists and only then creates the row. The route never creates an integration itself and never starts a
second sync service. For every other event an unknown installation is `unknown_installation`, and
GitHub is not asked.

### Known limits of the automatic reviews

- **Closed while a push is being handled.** A `closed` delivery handled between the head check and
  the enqueue of a concurrent `synchronize` finds nothing to cancel, so that job reviews a closed
  pull request (the claim ends it as `pull_request_closed` if it is still waiting). The window is a few
  milliseconds; the review is wasted, not harmful.
- **Every push starts a review.** There is no debounce since #395: a push is due at once, and a review
  that is still waiting for a runner is replaced by the one of the newer commit. A review that is already
  running finishes first (one job runs per pull request) and the new one runs after it, so a pull request
  that gets many pushes in a row is reviewed once for the first push and once for the newest one, plus the
  ones that found a free runner in between. Stopping a running review that a push made stale is a separate
  change (the supersede, not part of #395).
- **The head check is best effort** (it fails open, see above).

### Failures and redelivery

GitHub does not retry a failed delivery by itself. "Redeliver" in the app's advanced settings (or the
API) sends the delivery again **with the same `X-GitHub-Delivery` id**, so the id is how a manual retry
reaches the app, and the rules below make sure it is handled again when that is what the operator
wants:

- `installation_unclaimed` answers an installation delivery for an installation that no workspace has linked (and that
  `placement.ts` does not attach): the installation is noted, nothing is created, and the delivery can be redelivered.
- Only a delivery that **succeeded** (`trigger_enqueued`, `installation_changed`) stays a duplicate
  (`202 duplicate`, nothing done) for 7 days. A `400` is never kept: an unusable payload releases the
  claim.
- A delivery that was turned away for a reason that can change (`unknown_installation`,
  `integration_disabled`, `trigger_not_allowed`, `command_not_allowed`, `project_not_active`, `trigger_skipped`, `waiting_jobs_discarded`, `ignored`, for example a pull request delivery that
  raced the `installation.created` sync, or a command from a user who gets write access later) is
  recorded with that outcome for diagnostics, but the id can be claimed again: redelivering it
  handles it anew.
- If anything after the claim fails (the intake rejects, GitHub cannot be asked, the sync reports
  `failed`), the claim is released and the route answers `500` (`503` for a failed sync) with
  `WEBHOOK_PROCESSING_FAILED`.
- A request with an id that another request is handling right now gets `409`
  `WEBHOOK_DELIVERY_IN_PROGRESS`, not `202`: the first one may still fail, and GitHub must then show
  the delivery as failed so it can be redelivered.
- A request that dies without releasing its claim blocks the id for
  `WEBHOOK_DELIVERY_PROCESSING_LEASE_MS` (5 minutes), after which the next request takes it over. Each
  claim has an ownership token and only its owner can complete or release it, so a request that
  stalled past its lease cannot clobber the claim of the one that took over.

The answer is sent when the work is done, not before: the work is a handful of calls at most, and a
failure has to reach GitHub as a status code, which work scheduled with `after()` could not do.
GitHub gives up on a delivery after 10 seconds; the GitHub client times out after 15, so a slow GitHub
can make GitHub record a failed delivery even though the work finishes. A redelivery is then a
duplicate or repeats an idempotent sync. The enqueue is one short local transaction, so the work itself stays well inside that.

### Deduplication and replay

`webhook_deliveries` (`src/db/migrations/20261010170000_create_webhook_deliveries.ts`, repository
`src/db/repositories/webhook-deliveries-repository.ts`) holds one row per delivery id: the event, the
outcome, the owner token of the claim and when it was claimed. The claim is a single
`insert ... on conflict do nothing`, so of several simultaneous requests with one id exactly one
proceeds. Rows older than 7 days are deleted, at most every 10 minutes per process.

**The delivery id is not covered by the signature** (GitHub signs the body only). Replaying a captured
signed body with a fresh id passes the signature check and the delivery dedupe. Replay protection is
therefore the queue's: it deduplicates on (pull request, head commit, command), as
`ReviewTriggerIntake` says. The same event can also legitimately arrive under different ids
(two identical comments).

## The trigger policy for automatic reviews

A `pull_request` delivery with an active project goes through `decideAutomaticTrigger`
(`automatic-review-policy.ts`) before the intake. The handler gives it the settings of the
repository's project (`createAutomaticReviewSettingsSource`: project over global over built-in, see
`src/review-settings/README.md`). In this order:

| Rule                                                                                                                                       | Outcome                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| The delivery says the pull request is `closed` (a late `synchronize` or `reopened`)                                                        | `trigger_skipped`, reason `pull_request_closed`                                                                                       |
| The pull request is a draft                                                                                                                | `trigger_skipped`, reason `draft`; `ready_for_review` arrives as an `opened` trigger and starts the review                            |
| The project switched this kind off: `autoReviewOnOpen` covers opened, reopened and ready for review, `autoReviewOnPush` covers new commits | `trigger_skipped`, reason `automatic_review_disabled`                                                                                 |
| Otherwise                                                                                                                                  | a job (after the head check below), due at once: `opened`, `reopened`, `ready_for_review` and `synchronize` alike (no debounce, #395) |

A trigger that passed these rules is then compared with GitHub (`getPullRequest`, one call per
pull request trigger; the trigger kind cannot tell `opened` from `reopened` and `ready_for_review`, so
all of them are checked): a commit that is no longer the head is `stale_head`, a pull request that is
closed or a draft by now is skipped with that reason, and a pull request GitHub does not know is
`pull_request_not_found`. Deliveries arrive late and out of order, and without this a late delivery
for an older commit would replace the waiting job of the newest.

**The check fails open.** It has a timeout of 5 seconds (GitHub waits 10 for our answer). If the call
fails or times out, a warning with the error code only is logged and the trigger is enqueued with
the head of the payload: the job queue is durable and the runner already copes with a GitHub outage,
so a blip must not cost the review of a push (GitHub never redelivers a failed delivery by itself).
The only price is that during such a blip a late delivery for an older commit is not recognised.

There is no wait: `REVIEW_DEBOUNCE_SECONDS` is retired (#395) and only logs a start-up warning when it is
still set. The queue replaces the waiting job of the older commit; a job that runs already is not
touched, the new one waits behind it (one job runs per pull request).

A pull request that is closed or merged (`pull_request_closed`) calls
`intake.discardWaitingJobs`: **all** its waiting jobs are cancelled with `pull_request_closed`, the
automatic ones and the ones a person started with a comment or the start button (a closed pull request
takes no commands); a running job finishes. A pull request that is turned into a draft
(`pull_request_drafted`) cancels only its waiting _automatic_ jobs (error code `pull_request_draft`):
a draft is not reviewed automatically, but a review someone asked for stays. Pull requests from forks and pull requests opened by bots are reviewed like any other. A
comment command is not subject to this policy; it has its own rules, below.

## Comment commands

A comment on a pull request is a command when it starts with `/review`
(`src/integrations/comment-command.ts`, see `src/integrations/README.md`). A comment that starts with
the removed `/ask`, `/improve` or `/describe` is an ordinary comment (#203). The
rules, in the order they are applied:

| Rule                                                                                                                                                                                                           | Where    | Result                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| Only `created` comments count; `edited` and `deleted` do not (an edited comment must not start a second job)                                                                                                   | provider | `ignored`             |
| The comment is on a pull request (the payload has `issue.pull_request`), and the pull request is open (closed and merged ones take no commands)                                                                | provider | `ignored`             |
| The author is not a bot (this includes the app's own comments, so a review that quotes `/review` cannot loop)                                                                                                  | provider | `ignored`             |
| The text starts with `/review`; a removed command, an unknown command or a word that only starts with one is nothing                                                                                           | provider | `ignored`             |
| The author can have write access (`author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`) and really has it (collaborator permission `admin` or `write`). Anyone else gets no reply; the reason is logged | provider | `ignored`             |
| The repository has an active project                                                                                                                                                                           | handler  | `project_not_active`  |
| The project allows the command (setting `allowedCommands`, "Comment commands people may use")                                                                                                                  | handler  | `command_not_allowed` |
| `canTrigger` (the permission, asked again)                                                                                                                                                                     | handler  | `trigger_not_allowed` |
| Otherwise a `comment` job with the command and the author (never any text)                                                                                                                                     | intake   | `trigger_enqueued`    |

The text of a comment is read only after the bot check and the `author_association` check, and only
its first part is looked at; every pattern that reads it is bounded (a comment of 65 536
characters made of `![` once kept the parser busy for seconds). Tests pin a time limit for hostile
shapes. A removed command is refused by the parser before anything is known about the commenter, so
no permission is asked of GitHub for it.

Replays: the same delivery id is a `duplicate` (the route). The same comment under another delivery id
(the signature does not cover the delivery id) finds the job of the comment, whatever became of it:
the queue records the comment id with the job that answers it and refuses a second job for it (`same_comment`, see `src/jobs/README.md`).
A second comment with the same command is a new job unless an equal one is still waiting or running.

`/review` takes no arguments: text after it is dropped and never reaches a job, a settings file or an
environment variable (PR-Agent would read it as options). It is never logged. No reply is posted for
a refused command: the app only reacts through the review it posts when the job has run.

## A label on an issue (workflow trigger)

The event `issues` with the action `labeled` is not a review. `parseEvent` turns a label put on an **open issue** by a **user account** (sender type `User`) into `issue_labeled` (the issue, the label,
the repository with its default branch, who put it on); a pull request (`issue.pull_request`), a bot, an organization or a mannequin (the App itself is a bot: the connectors label issues with the App's token),
a closed issue and every other action are `ignored`. No project is needed. The handler hands the event to `WorkspaceCollaborators.workflows` (`LabelTrigger.start`,
`src/workflow-runs/label-trigger.ts`), which starts the workflows of the workspace that wait for exactly this label, one run each, under the request id
`gh-<delivery id>-<workflow id>`, and no workflow that already has a running run for the issue (`trigger_key`, one running run per workflow and issue): the outcome is `workflow_runs_started` when at least one workflow has a run for the delivery (the delivery id then stays claimed, so a
redelivery is a `duplicate`) and `no_workflow_matched` otherwise (the id can be claimed again). What a run is made of and why the title and the body of the issue are
defused in the text of an action: [`docs/workflows.md`](../../../docs/workflows.md#the-label-trigger). A server without a workflow engine leaves `workflows` out; a label is then `ignored`.

**A comment `/answer <n>` or `/answer <text>` (#920).** An `issue_comment` on an issue or a pull request that starts with `/answer` is the answer to the question a workflow run waits for
([`docs/workflows.md`](../../../docs/workflows.md#a-question-done-or-ask-920)). The parser reads it like `/review`: not from a bot, and only from a commenter whose association can have write access (`OWNER`, `MEMBER`,
`COLLABORATOR`) and who really has it (one more GitHub call); anybody else is `ignored`. On an issue and on a pull request the state does not matter (a run that waits is answered on a closed or merged pull request too; `/review` there still needs an open one). The handler gives the answer to `answers`
(`TicketAnswers` of `src/workflow-runs/`), which finds the run in the database: the runs of the workspace that wait on that repository, whose open question belongs to this ticket (or pull request). The outcome is
`ticket_answered` (the delivery id stays claimed) when the run took the answer, and `no_answer_taken` otherwise (no run waits on it, the answer cannot be used, somebody answered first, or the comment is older than the question:
its id must be greater than the id of the question's comment and its `created_at` not before the step began to wait, so a redelivery never answers a later question). A comment that has write access and could not answer
gets a short reply of the App (fixed words, nothing of the comment). A server without a workflow engine leaves `answers` out; such a comment is then `ignored`.

## The review trigger intake

The route hands a `ReviewTrigger` to `ReviewTriggerIntake.enqueueReviewTrigger(trigger, integration, source)`
and knows nothing about jobs. The intake of the running app is `createJobQueueReviewTriggerIntake`
(`job-queue-intake.ts`, wired in `shared.ts` by `getJobQueueReviewTriggerIntake`): it looks up the
`repositories` row of the trigger's repository and enqueues a job with the delivery id.

- `opened` and `updated` become an automatic `webhook` job for the command `review`, due at once; a `command` trigger becomes a
  `comment` job with its command and arguments.
- `discardWaitingJobs(repo, integration, prNumber)` cancels every waiting job of a closed pull request (also comment and manual ones); `discardWaitingAutomaticJobs` cancels only the automatic ones (a pull request turned into a draft).
- It is a thin mapping on purpose. It adds **no trigger policy**: drafts and the settings
  are decided before it, by the handler with `automatic-review-policy.ts`.
  Whether a repository has an active project is decided before the intake too, by the route
  (`projects` in the handler's dependencies, see `src/projects/README.md`): the intake only ever sees
  triggers of active projects.
- What the queue does with a job (the same delivery gives the same job; one automatic job per pull
  request, head commit and command; a newer commit replaces the waiting job) is described in
  `src/jobs/README.md`. That is the replay protection the signature cannot give: a captured signed body
  replayed under a new delivery id finds the job of the head commit and creates nothing.
- A trigger the queue can never accept (today only: a command whose arguments are over 10 000
  characters) is dropped with an error log line naming the field and code, not the value, and the
  intake resolves. Rejecting would make the route answer `500` and release the delivery, and every
  redelivery would fail the same way.
- A trigger for a repository the app has no row for (the delivery outran the synchronization) makes
  the intake reject with `JOB_REPOSITORY_UNKNOWN`; the route answers `500` and releases the delivery,
  so "Redeliver" works after the sync.
- The log line names the job, the outcome (`created` or `existing` with the reason), repository, pull
  request, command and delivery id, never any arguments.

## Testing

`integration-tests/webhooks/comment-commands.integration.test.ts` runs signed comment deliveries
through the same wiring (the CR-32 behaviors above). `integration-tests/webhooks/automatic-reviews.integration.test.ts` runs signed deliveries through the
handler into the real queue with a hand-set clock (the CR-31 behaviors above). `src/test-support/webhook-harness.ts` starts everything the route needs: a real Postgres database, the fake
GitHub API, the real GitHub App provider, a `RecordingReviewTriggerIntake`
(`recording-review-trigger-intake.ts`, which can fail or take its time), the project service and the
handler (`seedInstallation()` also activates the seeded repository as a project; pass
`{ activateProject: false }` for the opposite). Tests send
signed requests built by `fakes/github/webhooks.ts` from the recorded payloads in
`fakes/fixtures/github-webhooks/`. `integration-tests/webhooks/github-app-route.integration.test.ts`
covers every behavior above; `github-app-route-file.integration.test.ts` calls the real `route.ts`
with the production wiring; `review-trigger-jobs.integration.test.ts` runs the handler with the real
job queue intake.

## The ticket mirror (#923)

The events `issues`, `issue_comment`, `pull_request`, `sub_issues`, `projects_v2_item` and `check_suite` also update the ticket mirror
(`src/tracker/`, [`docs/ticket-mirror.md`](../../../docs/ticket-mirror.md)). Between the claim of the delivery and `parseEvent` the handler asks the
provider what the delivery changes in the cache (`parseTrackerChange`) and hands the change to the mirror of the delivery's workspace
(`tracker` of `WorkspaceCollaborators`, wired in by the route like the workflows):

- an event only the mirror reads (`sub_issues`, `projects_v2_item`, `check_suite`) is answered `tracker_updated` when a row changed and
  `ignored` otherwise; when the cache cannot be written the delivery fails (503, `WEBHOOK_PROCESSING_FAILED`); GitHub does not retry it by itself, it can be redelivered by hand and the nightly resync heals it;
- an event that also starts a review or a workflow (`issues`, `issue_comment`, `pull_request`) does that as before, and a failure of the
  mirror is only logged (by its code), so a broken cache never costs a review its start. When such a delivery starts nothing (an `edited`
  issue) and the mirror took it, the answer is `tracker_updated` instead of `ignored`;
- only a repository with an active project is mirrored; a delivery for another is not an error.
