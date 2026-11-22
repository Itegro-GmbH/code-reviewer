# Setting up the Jira Cloud connection

The factory connects a workspace to **Jira Cloud** with one **OAuth 2.0 (3LO) app of its own** at Atlassian (epic #1034,
issue #1037). The owner of the deployment registers that app once per environment in the Atlassian developer console and
puts its client id and secret into the deployment's settings. After that, an Owner or Admin of a workspace presses
**Connect Jira** under **Setup, GitHub and Jira**, signs in at Atlassian, and the factory keeps the access for that site.
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
- **One address per connection (#1131).** Jira allows **one address per app and user** for the dynamic webhooks of an OAuth 2.0 app
  (a second one is refused with "Only a single URL per user is allowed to be registered via REST API"). So the webhooks of all projects of
  a connection call **the same address**, each registered for its own filter `project = KEY`; the project of a delivery is told by the
  project key of its issue. Before #1131 every webhook had its own address (`?w=<registration>&s=<secret>`) and a second project on a
  connection could not be registered (code `jira_webhook_rejected` on its row).
- **The secret is rotated.** The secret is part of the address, and an address ends up in the request logs of the platform (Vercel's
  request logs and any log drain keep the query string). The secret of a connection is **derived** (HMAC over the connection id and the
  connection's `webhook_generation`, keyed by a key of `APP_SECRET`), never stored, so every project of the connection can register under
  the same address. The nightly job **rotates** the address of a connection once it is more than **25 days** old (`webhook_address_at`):
  Jira refuses a second address while one exists, so it **deletes all webhooks of the connection at Jira and registers them all again**
  under the next generation, in the same run. A rotation whose deletion fails leaves the webhooks as they were and extends one that ends
  soon; it is tried again the next night. A secret that leaked into a log is therefore valid for 25 days at most, not for as long as the
  webhook is extended. `webhook_address_at` is the start of the **generation** (it does not start over when the last webhook of a
  connection goes and a new one comes); a connection with no webhook registered whose address is older than 25 days gets the next
  generation without any deletion. There is no way to rotate sooner than by setting `webhook_address_at` of the connection back in the
  database and calling the job.
- **The gap, and what is lost in it.** Jira refuses a second address while one exists, so a move or a rotation deletes first and registers
  after; an event in between is sent to no address (nothing is registered), a delivery already on its way to the old address is refused with `401` (final at Jira), and **a lost event is lost**:
  the mirror is brought right by the next change of the same issue and the nightly resync, but **a `-> status` trigger only fires from a
  delivery, so a status change in the gap does not start its lane** (move the issue again). The gap is kept as short as it can be: the first
  webhook is registered at once, the others at the same time, and a registration that fails because Jira is unavailable is tried again twice
  (after 0.3 s and 1.5 s). If it cannot be closed, the rows stay `pending` with `error_code` `jira_webhook_move_pending` (or the code of the
  failure, for example `jira_unavailable`), the log says `JIRA_WEBHOOK_MOVE_REGISTER_FAILED`, and **the second cron entry**
  (`GET /api/internal/jira-webhooks?retry=pending`, every 15 minutes) registers those rows again; a project is not dark until the next
  night. A function that dies in the middle of a move leaves the rows with `jira_webhook_move_pending`, which the same entry finds.
  Atlassian documents no way to change the address of a webhook, to have two addresses, or to verify a delivery without it (the bearer
  token of an OAuth 2.0 webhook is documented without its claims, and community reports say it is not always there), so the secret stays
  in the address and the gap stays: a stable address with the secret taken out of it, checked by the token alone, would remove the gap but
  rest everything on a token whose content nobody has verified live. If the open question about the token (below) turns out well, that is
  the way to look at next. The 25-day rotation is kept because it is the only thing that limits a secret that leaked into a log.
- **A changed `APP_SECRET`.** The secret of an address is derived from it, so a new `APP_SECRET` changes every secret: Jira still calls the
  old address and every delivery is refused (`secret_mismatch` in the log). The connection keeps the SHA-256 of the secret its address was
  registered with (`webhook_secret_fingerprint`, never the secret); at the next reconcile of any of its projects (a switch, or the next
  night; call `GET /api/internal/jira-webhooks` to do it at once) another fingerprint is treated like an old address: all webhooks are deleted
  and registered again under the next generation (`JIRA_WEBHOOK_SECRET_CHANGED` in the log). A connection whose fingerprint is empty
  (registered before it was kept) is left alone until its next rotation. When you rotate `APP_SECRET`, call the job once right after the
  deploy; the stored Jira tokens are encrypted with a key of the same secret (`keys.ts`), so a deployment with another `APP_SECRET` than the
  one that wrote them cannot reach Jira at all and changes nothing.
- **Webhooks from before #1131** (one address per project, `jira_webhooks.address = 'project'`) keep working after the deploy: their old
  address is accepted until the **next reconcile of any project of their connection** (the nightly job, or switching a project on or off)
  moves the connection: all its webhooks are deleted at Jira and registered again under the shared address, and a project that was
  `pending` (for example with `jira_webhook_rejected`) registers in the same run. Nothing has to be written in the database. To do it
  right after the deploy call `GET /api/internal/jira-webhooks` with the cron secret once; deliveries are lost for the seconds the move takes.
  From then on the old address of a moved webhook is refused (`401`). Two runs at the same moment (that call and the nightly job, or a
  project switch) move the rows **once**: the row update checks that a row is still under its own address, so the second run leaves the rows
  the first one registered alone. What the first bearer token of an old address proved is carried over to the connection, so token-less
  deliveries stay refused.
- **They are deleted** when the project is switched off, when its ticket source changes, and when the project is switched to GitHub
  issues. A deletion that fails is repeated by the nightly job. A deletion Jira **refuses** (401 or 403, a connection that is broken or
  gone) is not repeated: the row goes anyway, so the new source can register, and Jira ends the webhook within 30 days (its deliveries
  are refused as those of an unknown registration until then).
- **A registration that times out** may have made a webhook at Jira without the factory knowing its id (Jira does not tell the address
  of a webhook, so it cannot be matched by it). The next registration looks for webhooks with the filter `project = KEY` that no
  registration of the workspace knows and that end about 30 days after the failed attempt, and deletes them, so they do not eat the
  five. Two registrations of one project at the same moment leave the row with the Jira id of one of them; the other
  deletes its webhook.
- **A webhook that no row knows and that holds the address** (the unknown outcome of an old registration under another address) makes
  every registration fail with `jira_webhook_url_conflict`. The factory lists the webhooks of the app once, deletes those that no row of
  the workspace knows (except those made in the last ten minutes: they may be another reconcile's registration) and registers again
  (`JIRA_WEBHOOK_ORPHANS_REMOVED` in the log). Jira does not tell the user of a webhook apart per workspace: the webhooks of the same Jira
  user in **another workspace** are deleted too and register themselves again at their next extension; one Jira user should not be
  connected in two workspaces.
- **A webhook Jira no longer knows.** Atlassian's guide says "IDs corresponding to non-existent webhooks are ignored" and its reference
  documents a 400 only for a missing list of ids. Should Jira answer 400 to a delete that names an id it forgot all the same, the factory
  lists the webhooks of the app and deletes only the ids that exist, so such a row never blocks a move or a rotation.
- **A changed source clears the mirror's rows of the old one.** Switching a project to another Jira project (or connection) deletes the
  cached Jira issues of the old one (`OLD-7` and `NEW-7` cannot share a number in the mirror); the cache of the new one fills from deliveries.
- **Limit: five webhooks per connection.** Atlassian allows 5 webhooks per OAuth 2.0 app and user on a site (the registration of a
  webhook with a filter each counts, whatever their address). The factory uses one per
  Jira project, so one connection (one person's grant) can serve **five projects**; the sixth gets the code `jira_webhook_limit` on its
  row (the project is created, no status change reaches it). Connect the site again with another person's grant to serve more.
- **The refusal of a second address.** Should Jira still answer "Only a single URL per user ..." (the person of the connection has webhooks
  under another address: the same Jira account connected in another workspace, or a webhook made by hand with the app), the row says
  `jira_webhook_url_conflict`. Delete the other webhooks of that account at Jira (`GET`/`DELETE /rest/api/3/webhook` as the app) or give the
  workspace its own Jira account's grant.
- **Address.** The webhooks of a connection call `<BETTER_AUTH_URL>/api/webhooks/jira?c=<connection>&s=<secret>`. Atlassian requires https
  and the base address of the app; the address has to be reachable from the internet (not a laptop's `localhost`).

### How a delivery is verified

Atlassian documents one mechanism for webhooks that an OAuth 2.0 (3LO) app registers through the REST API: _"Webhooks for OAuth 2.0 apps are
secured by bearer authentication. The token is present in the `Authorization` header and is signed with the app's client secret."_ It
names neither the algorithm nor the claims, and it documents **no HMAC signature** (`X-Hub-Signature`) for these webhooks: the `secret`
field of that signature belongs to _admin_ webhooks, and Atlassian's developer community reports that OAuth-registered webhooks carry
neither a secret nor, in practice, always the token (a feature request, JRACLOUD-96162, is open). The factory therefore does **not rely on
the bearer token alone**:

1. **The address carries an unguessable secret, one per connection** (256 bits, derived from `APP_SECRET`, the connection and its
   generation, so nothing but the generation is stored; the address of a webhook from before #1131 carries a random secret of its own
   of which only the SHA-256 is stored). A delivery without it, with another one (or one of an older generation), for a connection that
   is unknown, or on the old address of a registration that moved or is being removed is refused `401` with one and the same
   answer. **This is the check that always applies, and it is a shared secret in the URL, not a signature of Atlassian's**: whoever learns
   the address (Atlassian's delivery log, **Vercel's request logs and log drains, which keep the query string**, an access log of a proxy
   in front of the app, a screenshot) can post deliveries until the secret is rotated (every 25 days, see above). The deliveries only carry the factory to re-read the issue from Jira (the status that starts a lane is read
   again from Jira before a run starts, so a forged status change cannot start a run Jira does not stand behind), but a forged delivery
   could write a made-up issue into the mirror. Keep the address out of logs you share.
2. **When a delivery carries a bearer token it must verify**: a JWT signed with the app's client secret (HS256, HS384 or HS512; never
   `none` or an asymmetric algorithm), not expired (`exp` plus 60 seconds of clock skew) and not issued or valid in the future (`iat`,
   `nbf`, minus 60 seconds). A token that does not verify refuses the delivery, always. **A token without `exp` is accepted**: its
   signature proves that the sender knows the client secret, and Atlassian documents no claims, so none is required.
3. **Trust on first use.** Atlassian's documentation says the token is present, community reports say it is not always. So a connection
   accepts deliveries without a token until the first delivery whose token verifies; the factory notes that (`webhook_bearer_seen_at` of the
   connection; `bearer_seen_at` of the row for an address from before #1131) and from then on **refuses a delivery without a token**
   (`bearer_missing` in the log). A leaked address alone then forges nothing for a connection whose real deliveries carry a token (the
   forger would need the client secret too). A rotation keeps the note.

The request is checked (steps 1 and 2) **before its body is read**. Deliveries are **de-duplicated** by registration (the project's webhook row) and Jira's
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

- **A label put on** (the `labels` item of the changelog of a `jira:issue_updated`, and the labels of a `jira:issue_created`) starts the lanes of the
  project that wait for it (trigger `ticket.labeled`, [`docs/workflows.md`](workflows.md#a-label-in-a-jira-project), #1129). Nothing is set up in Jira for it:
  the webhook already delivers both events. What to know:
  - **Only an addition starts a run.** A label taken off, or left on while another changes, starts nothing. An issue **created with** the label starts the lane,
    and so does a **clone** or a **move** of an issue that carries it, and an issue an automation or the factory creates with it; keep the trigger label out of
    clone and move rules and out of templates unless that is meant. Several `ticket.labeled` triggers in one lane start one run, through the first matching one.
  - **The hyphen rule.** Jira labels hold no spaces, and the factory writes a label with a space as a hyphen, so the lane label `ready for agent` starts when
    `ready-for-agent` is put on, and a lane that names `ready-for-agent` does too. Case counts (`Ready-for-agent` is another label). The lane editor warns
    (`label_retriggers_workflow`) when a step adds the lane's own label, in either spelling.
  - **The factory's own label writes arrive on this webhook** (`agent-working`, `agent-waiting`, and any label a step adds): Jira shows them as the connected
    person's, so they cannot be told from a person's. They start a lane only if a lane waits for that label; never use one the factory writes as a trigger label.
  - **The lane's own label write starts no second run.** A run started by hand (or through the API) whose pre-step puts the lane's label on the ticket, as the
    demo lane "Ticket zu PR" does ("ready for agent" first), is the lane's one active run for that ticket; the delivery its label write causes finds it and
    starts nothing (log line `is still running for ticket`). Before a run starts, the factory asks Jira for the issue and checks that it **still has the label**.

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
- [ ] **Rotation.** Set `webhook_address_at` of the connection 26 days back, call `GET /api/internal/jira-webhooks`: Jira's
      `GET /rest/api/3/webhook` shows one webhook per project with new ids and one and the same address (the `c` is the connection's, the
      `s` is new), `webhook_generation` is one higher, the next delivery is accepted and `webhook_bearer_seen_at` is unchanged.
- [ ] **Two projects on one connection (#1131).** Set up a second project of the same site on the same connection: its row becomes
      `active` (no `jira_webhook_rejected`, no `jira_webhook_url_conflict`), `GET /rest/api/3/webhook` lists two webhooks with the same
      address, and a status change in each project reaches its own project.
- [ ] **Delete an id Jira does not know.** Expire or delete one webhook of a connection with two projects in Jira's API, then rotate (set
      `webhook_address_at` 26 days back and call the job): what does `DELETE /rest/api/3/webhook` answer for the forgotten id, `202`
      (the guide) or `400`? Either way the rotation succeeds and the other webhooks come back under the new address; note the answer.
- [ ] **A changed `APP_SECRET`.** On a throwaway deployment change `APP_SECRET`, check that a status change is refused (`secret_mismatch`),
      call `GET /api/internal/jira-webhooks`: the webhooks are registered again (`webhook_generation` one higher, a new
      `webhook_secret_fingerprint`) and the next change is accepted.
- [ ] **The gap.** With a move or a rotation under way (Jira's API answering 503 for the registration, for example with the app's
      network blocked at Atlassian's side), the rows are `pending` with `error_code` set, and within 15 minutes of the API working again the
      `?retry=pending` run registers them.
- [ ] **A webhook from before #1131.** After the deploy a project registered the old way still receives deliveries (its old address is
      accepted). Call `GET /api/internal/jira-webhooks` once: its row says `address = 'connection'`, its webhook is registered again under
      the shared address, and a project that was `pending` with `jira_webhook_rejected` is `active` in the same run.
- [ ] **Status into a lane.** A lane with `ticket.statusChanged` to a Jira status: move an issue into it in Jira (person, then an automation
      rule): one run each, `trigger.ticket` has key, title, description as text, status, type, labels, assignee, link.
- [ ] **Label into a lane (#1129).** A lane with `ticket.labeled` "ready for agent" in a Jira project: (a) put `ready-for-agent` on an issue in Jira: **one** run,
      `trigger.ticket` filled; (b) take the label off: no run; (c) put another label on while this one stays: no run; (d) create an issue that already has the
      label: one run; (e) start the demo lane "Ticket zu PR" **by hand** on an issue (its pre-step puts "ready for agent" on the ticket): **exactly one** run in
      the lane's run list, and the log has `is still running for ticket` for the delivery of that label; (f) after that run has ended, take the label off and put
      it on again: a new run. Also look at what the lane's own writes (`agent-working`) do: they must start nothing.
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
