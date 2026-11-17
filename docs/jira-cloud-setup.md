# Setting up the Jira Cloud connection

The factory connects a workspace to **Jira Cloud** with one **OAuth 2.0 (3LO) app of its own** at Atlassian (epic #1034,
issue #1037). The owner of the deployment registers that app once per environment in the Atlassian developer console and
puts its client id and secret into the deployment's settings. After that, an Owner or Admin of a workspace presses
**Connect Jira** under **Settings, Integrations**, signs in at Atlassian, and the factory keeps the access for that site.
There is no API-token way: the connection is always the person's consent at Atlassian.

Plan for about ten minutes. What you need:

- An Atlassian account that can open <https://developer.atlassian.com/console/myapps/>.
- The public https address of the factory app, `<BETTER_AUTH_URL>` (for the factory deployment
  `https://factory-app-omega-eight.vercel.app`).
- Access to the deployment's settings (Infisical) to enter two values.

## 1. Register the app

1. Open the [developer console](https://developer.atlassian.com/console/myapps/), **Create**, **OAuth 2.0 integration**,
   a name such as `Code Reviewer Factory`, accept the terms.
2. **Permissions**: add **Jira API** and press **Configure**. Under _Classic scopes_ switch on:

   | Scope                 | What the factory uses it for                                                                |
   | --------------------- | ------------------------------------------------------------------------------------------- |
   | `read:jira-work`      | Read issues, comments, transitions, projects and their statuses                             |
   | `write:jira-work`     | Comment on issues, move them (transitions), change labels                                   |
   | `manage:jira-webhook` | Register, list and extend the webhooks of a site (the factory registers them itself, #1039) |

   Add **User identity API** and **Configure** `read:me` (_View active user profile_): the name of the account that
   granted access, shown on the settings page. The fifth scope, `offline_access`, is not switched on in the console: the
   factory asks for it in the authorization request and Atlassian then hands out a refresh token.

3. **Authorization**: add **OAuth 2.0 (3LO)** and enter the **Callback URL**. It is the `BETTER_AUTH_URL` of the
   deployment plus `/api/jira/callback`, character for character (Atlassian compares it exactly):

   | Where             | Callback URL                                                                    |
   | ----------------- | ------------------------------------------------------------------------------- |
   | Factory app       | `https://factory-app-omega-eight.vercel.app/api/jira/callback`                  |
   | Local development | `http://localhost:3000/api/jira/callback` (or the port you start `pnpm dev` on) |

   The console takes one callback URL per app. For local development register a second app (a development app with its own
   client id and secret) and keep the factory's callback on the first.

4. **Settings**: copy the **Client ID** and the **Secret**. Leave _Rotating refresh tokens_ on (the default): Atlassian then hands out a
   new refresh token with every renewal, which the factory stores; it also works with an app that does not rotate.

## 2. Give the values to the deployment

Set these two variables in the environment of the app (for the factory in Infisical, next to the other app settings, and then
redeploy; locally in `app/.env.local`):

| Variable                  | Value                   |
| ------------------------- | ----------------------- |
| `ATLASSIAN_CLIENT_ID`     | The client id of step 1 |
| `ATLASSIAN_CLIENT_SECRET` | The secret of step 1    |

Both or neither: without them **Connect Jira** is not offered and the routes answer `jira_not_configured`; one without the
other stops the start of the server and names the missing variable. The start log says `[jira] on.` or `[jira] off: ...`
(variable names only, never a value). `ATLASSIAN_AUTH_BASE_URL`, `ATLASSIAN_API_BASE_URL` and
`ALLOW_TEST_ATLASSIAN_ENDPOINTS` exist for the test stack (the fake Atlassian) and are never set in a real deployment.

## 3. Distribution

A new app is **private**: only the account that owns it can grant it, which is enough for your own test site. To let
customers connect their own Jira sites, open **Distribution** in the console and set the app to **Sharing** (Atlassian asks
for the vendor name, a privacy policy URL and a statement whether personal data is stored; the factory stores the Atlassian
account id and display name of the person who connected a site). Until then a customer's Atlassian account is refused at the
consent page. Check the console for the current wording of these steps; Atlassian changes them from time to time.

## 4. Connect a site

1. Sign in to the factory as an Owner or Admin of the workspace, open **Settings, Integrations**, **Jira Cloud**, **Connect
   Jira**.
2. Atlassian shows its consent page (every time, so you can choose the site again). Choose the Jira site and accept.
3. The factory shows the site as **Connected**. If your Atlassian account gave access to several sites, the card offers them:
   choose one. One round of consent makes **one** connection (the access of a grant is one token pair that Atlassian
   rotates); for another site press **Connect another site** and choose it there.

**Needs reconnecting** means Atlassian refuses the stored refresh token (`invalid_grant`): the app was removed in the Atlassian account, or the grant
ran out (Atlassian lets a refresh token expire when it is not used for a long time, 90 days at the time of writing; the factory
only renews it when it calls Jira). Press **Reconnect** and accept again; the connection keeps its place. **Remove** deletes the stored access and is
refused while a project still uses the connection (the answer names the projects). Removing does not end the grant at
Atlassian: do that at <https://id.atlassian.com/manage-profile/apps> if you want it gone there too.

## 5. Webhooks: nothing to do in Jira

When a project is set up on a Jira project (or switched on again), **the factory registers its own webhook** at the site with the
connection's access: one dynamic webhook per project for the JQL filter `project = KEY` and the events `jira:issue_created`,
`jira:issue_updated`, `jira:issue_deleted` and `comment_created`. Nobody opens the webhook page of Jira, and the webhook is not an
_admin_ webhook (Atlassian does not list the webhooks of an OAuth 2.0 app on that page; they belong to the app).

- **They expire.** Atlassian ends a webhook registered through the REST API 30 days after it was registered or extended. The nightly job
  (`GET /api/internal/jira-webhooks`, `vercel.json`, 03:29 UTC) extends every webhook that ends within ten days, registers again one that
  Jira lost (Atlassian keeps an expired webhook for three months) or that failed to register, and deletes one whose project is off or has
  another source. The `jira_webhooks` table says where each stands (`status`, `expires_at`, `error_code`). Without a working cron a Jira
  source stops delivering after at most 30 days.
- **The secret is rotated.** The secret is part of the address, and an address ends up in the request logs of the platform (Vercel's
  request logs and any log drain keep the query string). So the nightly job registers a **new webhook with a new secret** for a
  registration that is more than **25 days** old, and deletes the old webhook after the new one is the row's; while it runs both secrets
  are accepted (`pending_secret_hash`), so no delivery is lost. A rotation that fails (Jira's limit of five is the usual reason: the new
  webhook exists next to the old one for a moment) leaves the old webhook as it was and extends it when it ends soon; it is tried again the next night. A secret that
  leaked into a log is therefore valid for 25 days at most, not for as long as the webhook is extended. There is no way to rotate sooner
  than by switching the project off and on (or by setting `registered_at` of the row back in the database and calling the job).
- **They are deleted** when the project is switched off, when its ticket source changes, and when the project is switched to GitHub
  issues. A deletion that fails is repeated by the nightly job. A deletion Jira **refuses** (401 or 403, a connection that is broken or
  gone) is not repeated: the row goes anyway, so the new source can register, and Jira ends the webhook within 30 days (its deliveries
  are refused as those of an unknown registration until then).
- **A registration that times out** may have made a webhook at Jira without the factory knowing its id (Jira does not tell the address
  of a webhook, so it cannot be matched by it). The next registration looks for webhooks with the filter `project = KEY` that no
  registration of the workspace knows and that end about 30 days after the failed attempt, and deletes them, so they do not eat the
  five. Two registrations of one project at the same moment leave the row with the Jira id and the secret of one of them; the other
  deletes its webhook.
- **A changed source clears the mirror's rows of the old one.** Switching a project to another Jira project (or connection) deletes the
  cached Jira issues of the old one (`OLD-7` and `NEW-7` cannot share a number in the mirror); the cache of the new one fills from deliveries.
- **Limit: five webhooks per connection.** Atlassian allows 5 webhooks per OAuth 2.0 app and user on a site. The factory uses one per
  Jira project, so one connection (one person's grant) can serve **five projects**; the sixth gets the code `jira_webhook_limit` on its
  row (the project is created, no status change reaches it). Connect the site again with another person's grant to serve more.
- **Address.** The webhook calls `<BETTER_AUTH_URL>/api/webhooks/jira?w=<registration>&s=<secret>`. Atlassian requires https and the
  base address of the app; the address has to be reachable from the internet (not a laptop's `localhost`).

### How a delivery is verified

Atlassian documents one mechanism for webhooks that an OAuth 2.0 (3LO) app registers through the REST API: _"Webhooks for OAuth 2.0 apps are
secured by bearer authentication. The token is present in the `Authorization` header and is signed with the app's client secret."_ It
names neither the algorithm nor the claims, and it documents **no HMAC signature** (`X-Hub-Signature`) for these webhooks: the `secret`
field of that signature belongs to _admin_ webhooks, and Atlassian's developer community reports that OAuth-registered webhooks carry
neither a secret nor, in practice, always the token (a feature request, JRACLOUD-96162, is open). The factory therefore does **not rely on
the bearer token alone**:

1. **The address carries an unguessable secret of its own, one per registration** (256 random bits; only its SHA-256 is stored). A
   delivery without it, with another one, or for a registration that is unknown or being removed is refused `401` with one and the same
   answer. **This is the check that always applies, and it is a shared secret in the URL, not a signature of Atlassian's**: whoever learns
   the address (Atlassian's delivery log, **Vercel's request logs and log drains, which keep the query string**, an access log of a proxy
   in front of the app, a screenshot) can post deliveries until the secret is rotated (every 25 days, see above). The deliveries only carry the factory to re-read the issue from Jira (the status that starts a lane is read
   again from Jira before a run starts, so a forged status change cannot start a run Jira does not stand behind), but a forged delivery
   could write a made-up issue into the mirror. Keep the address out of logs you share.
2. **When a delivery carries a bearer token it must verify**: a JWT signed with the app's client secret (HS256, HS384 or HS512; never
   `none` or an asymmetric algorithm), not expired (`exp` plus 60 seconds of clock skew) and not issued or valid in the future (`iat`,
   `nbf`, minus 60 seconds). A token that does not verify refuses the delivery, always. **A token without `exp` is accepted**: its
   signature proves that the sender knows the client secret, and Atlassian documents no claims, so none is required.
3. **Trust on first use.** Atlassian's documentation says the token is present, community reports say it is not always. So a registration
   accepts deliveries without a token until the first delivery whose token verifies; the factory notes that (`bearer_seen_at` of the
   registration) and from then on **refuses a delivery without a token** (`bearer_missing` in the log). A leaked address alone then forges
   nothing for a registration whose real deliveries carry a token (the forger would need the client secret too). A rotation keeps the
   note; a new registration (a project switched off and on) starts without it.

The request is checked (steps 1 and 2) **before its body is read**. Deliveries are **de-duplicated** by registration and Jira's
`X-Atlassian-Webhook-Identifier` (the same across retries, unique per tenant). A delivery without a usable identifier is **not** refused
(Jira treats a `4xx` as final and the event would be lost): it is claimed under a hash of its body, which a retry repeats, and the log says
so. A delivery that succeeded is answered `duplicate` and does nothing; one that another request is handling answers `409` (Jira retries
408, 409, 425, 429 and 5xx up to five times); one that failed after its claim releases it and answers `503`.

A delivery that Atlassian **replays after the 7 days** the claims are kept for is no duplicate any more. It is handled as new, and if the
ticket **still has** the status a lane waits for, it starts a run (the factory reads the status from Jira again before a run starts, and it
matches). That is by design: the claim table is a retry guard, not a history, and a ticket that has sat in the trigger status for a week
and is announced again is, as far as the lane can tell, in that status.

### What a delivery does

- **Every event** writes the issue into the ticket mirror (`tracker_items`, `provider = 'jira'`, [`docs/ticket-mirror.md`](ticket-mirror.md)).
- **A change of the status** in an `jira:issue_updated` (the `status` item of the changelog) starts the lanes of the project that wait for the
  new status (trigger `ticket.statusChanged`, [`docs/workflows.md`](workflows.md#the-status-trigger)). **Whoever made the change starts
  it**, the factory's own transitions included. A creation is no change of status and starts nothing. Before a run starts the factory
  asks Jira for the issue and checks that it **still has that status** (a late or repeated delivery starts nothing). Statuses are compared **by id**: Jira answers REST calls with names in the connected person's language (`Zu erledigen`) but a delivery carries the name Jira keeps for every language (`To Do`); a lane may name a status either way (#1058).

### What the factory writes to Jira (#1040)

The OAuth scopes `read:jira-work` and `write:jira-work` let the factory write **as the person who connected the site** (3LO acts as that
person), so its comments, label changes and transitions show that person's name in Jira. The permissions of that account in the Jira project
decide what works: add comments, edit issues (labels) and transition issues. What it writes:

- **Comments** (`POST /rest/api/3/issue/{key}/comment`, ADF from the Markdown of the lane), and **an edit of its own comment** (`PUT .../comment/{id}`)
  when the question of an agent is answered. The hidden marker that tells the factory a comment is its own is kept as a comment **property**
  (`factory.markers`), not as text; the factory looks for its comment by that property and by its author.
- **Labels** (`PUT /rest/api/3/issue/{key}` with `update.labels`). Jira refuses a label with a space, so the factory writes `agent working` as `agent-working`.
- **Transitions** (`GET` and `POST /rest/api/3/issue/{key}/transitions`): the transition whose target is the status the lane names. A transition that needs a field the factory cannot
  fill (a screen with a required field) is refused by Jira; give that transition no required field, or use another route to the status.
- **The full read of the project** (`POST /rest/api/3/search/jql`) for the first read, the nightly resync and the "Resync" button.
- **A pull request** is linked to an issue by Jira's own GitHub integration (the Jira app for GitHub must be installed on the Jira site and the repository connected to it): the branch of a lane's agent
  carries the key (`workflow/PROJ-12/…`), the pull request title starts with the key and the body has the ticket address. Without that integration the pull request still names the ticket, but
  Jira's development panel does not show it.
- **An answer** is a comment that begins with `/answer`; the `comment_created` event of the webhook delivers it. Anyone who can comment on the issue can answer (see [`docs/workflows.md`](workflows.md#the-status-trigger)).

## What the factory keeps, and what it never shows

- Per connection: the site (cloud id, address, name), the Atlassian account id and display name of the person who connected
  it, the granted scopes, and the access and refresh token **encrypted** with the instance's `APP_SECRET` (AES-256-GCM, the
  row is bound into the ciphertext).
- No page, API answer, log line or error message contains a token, the authorization code or the client secret.
- The access token lives one hour; the factory renews it before a call when it ends within five minutes. Atlassian hands out a
  new refresh token with every renewal and the old one dies, so the pair is stored in one step.
- The `state` of the round trip is signed, single-use, ten minutes old at most and bound to the person and the browser
  session. Atlassian's 3LO flow for a web app documents no PKCE; the client secret protects the exchange of the code.

## Live test checklist

Run this once against the real Atlassian app after the first deployment of a change to the connection or the token handling. The
connection of a site must keep working through all of it:

- [ ] **Two sites, one user.** Connect site A, then connect site B with the same Atlassian user (a second round of **Connect
      Jira**), then use A again (a call through the connection of A, for example the connection's page after the access token
      ended or a project that reads its tickets). Both connections show **Connected**. If A now needs reconnecting, Atlassian
      revoked the first grant when the second one was made, and the one-connection-per-grant design needs another look before
      the release.
- [ ] **Two workspaces, one user.** Connect the same site (or two sites) from two workspaces with the same Atlassian user, then
      use the first workspace's connection again. Both stay **Connected**.
- [ ] **Refresh token reuse window.** Let an access token end (an hour) and make two calls through the same connection at the
      same moment (two browser tabs, or two requests of a project). Both succeed and the connection stays **Connected**. The
      server's log has no `JIRA_CONNECTION_BROKEN` and at most one refresh for that moment. Atlassian documents a short grace
      period in which a used refresh token is still accepted; note what you see, the factory does not rely on it.
- [ ] **Wrong client secret.** In a throwaway deployment set a wrong `ATLASSIAN_CLIENT_SECRET`: calls fail with
      `jira_unavailable`, the log says `JIRA_TOKEN_ENDPOINT_REJECTED`, no connection turns to **Needs reconnecting**, and the
      right secret makes them work again without reconnecting.
- [ ] **Removed in Atlassian.** Remove the app in the Atlassian account (<https://id.atlassian.com/manage-profile/apps>): the
      next call turns the connection to **Needs reconnecting**, and **Reconnect** mends it.
- [ ] **A webhook of its own (#1039).** Set up a project on a Jira project of the test site and check that **no step in Jira** was needed:
      the row of the project in `jira_webhooks` is `active` with an `expires_at` about 30 days away, and the `X-Atlassian-Webhook-Identifier`
      of the first change shows in the log of the deliveries of the app. Note whether the delivery carries an `Authorization` bearer token and
      whether its signature verifies with the client secret (the factory refuses a delivery whose token does not verify; if real deliveries
      are refused for that reason the documentation of Atlassian and its behaviour disagree, and the check of the token needs another look
      before the release).
- [ ] **Open question 1: the bearer token (#1039).** Capture one real delivery (Atlassian's delivery log, or a temporary log line of the
      header's first two segments, never the signature): which `alg`, which claims (`exp`, `iat`, `nbf`, `iss`, anything else), and whether
      **every** delivery has one. The factory refuses a token that does not verify with the client secret and, once one verified,
      a delivery without a token (`bearer_seen_at` of the row is set after the first). If real deliveries are refused with `bearer_invalid`
      or `bearer_expired`, or alternate between with and without a token (then `bearer_missing` refuses the ones without), the
      documentation and the behaviour disagree: stop and look before the release.
- [ ] **Open question 2: the identifier header (#1039).** Check that every real delivery carries `X-Atlassian-Webhook-Identifier` and that
      the retry of a failed delivery carries the **same** one. A delivery without it is claimed under a hash of its body (log line:
      `no usable X-Atlassian-Webhook-Identifier`); that line should never appear.
- [ ] **Rotation.** Set `registered_at` of the row 26 days back, call `GET /api/internal/jira-webhooks`: `registered: 1`, Jira's
      `GET /rest/api/3/webhook` shows one webhook with a new id, the next delivery is accepted and `bearer_seen_at` is unchanged. With five
      webhooks already on the connection the rotation fails (`jira_webhook_limit`) and the old webhook keeps working.
- [ ] **Status into a lane.** A lane with `ticket.statusChanged` to a Jira status: move an issue into it in Jira (person, then an automation
      rule): one run each, `trigger.ticket` has key, title, description as text, status, type, labels, assignee, link.
- [ ] **Extension and expiry.** Call `GET /api/internal/jira-webhooks` with the cron secret: a young webhook is `unchanged`; set `expires_at`
      of the row to a date within ten days and call again: `extended`, and Jira's `GET /rest/api/3/webhook` shows the later end. Delete the
      webhook in Jira's API and call the job: it registers a new one. Find out what `PUT /rest/api/3/webhook/refresh` answers for a webhook
      that does not exist (the factory takes 404 as gone and registers a new one; any other 4xx is kept as `jira_webhook_rejected`).
- [ ] **Fifth and sixth project.** Five projects on one connection work; the sixth shows `jira_webhook_limit` on its row.
- [ ] **Write-back (#1040).** On a project with the lane "Issue to PR (status)" and an issue in its trigger status: move the issue into the status. Within a minute the issue shows a transition to
      the lane's "in progress" status, the label `agent-working`, and the comments of the lane written **as the connected person**, as formatted text (headings, lists, links) and **without** any
      `<!-- … -->` text. Note what the activity of the issue shows: one entry per change, no duplicate comment when a step is retried.
- [ ] **The marker property.** With the Jira REST API (`GET /rest/api/3/issue/{key}/comment?expand=properties`) check that the comment of the factory has the property `factory.markers`, that an
      answered question has the marker `answered` (the first version has `ask`), and that a second run on the same issue does not edit the first run's comments.
- [ ] **A transition that cannot be done.** Name a status in the lane that no transition leads to from the issue's status: the step ends `ticket_status_unreachable` and the message lists the reachable
      statuses; a status the workflow does not have ends `ticket_status_unknown`; a transition with a required screen field ends `ticket_rejected`.
- [ ] **The pull request link.** The pull request of the run has `PROJ-12: <title>`, `Ticket: <url>` in the body and no `Closes #`; with the Jira app for GitHub installed the issue's development
      panel shows the branch and the pull request.
- [ ] **`/answer` (#1040).** Let an agent ask a question: a comment of the factory appears. Reply in Jira with `/answer 1`: the run goes on, the question comment is edited to say it was answered. Check
      what the real `comment_created` delivery carries (`comment.body` as ADF or as text, `comment.author.accountType`); the factory reads both, and takes only a comment of a person.
- [ ] **The full read.** Create five issues in the project, set the project up, press **Resync** in the project's setup: the Issues tab lists them with their keys. Move one issue to another
      Jira project and press **Resync** again: it is gone from the list. Note how many pages `search/jql` took.
