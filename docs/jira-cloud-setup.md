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
- **They are deleted** when the project is switched off, when its ticket source changes, and when the project is switched to GitHub
  issues. A deletion that fails is repeated by the nightly job.
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
   the address (Atlassian's delivery log, an access log of a proxy in front of the app, a screenshot) can post deliveries until the
   webhook is registered again. The deliveries only carry the factory to re-read the issue from Jira (the status that starts a lane is read
   again from Jira before a run starts, so a forged status change cannot start a run Jira does not stand behind), but a forged delivery
   could write a made-up issue into the mirror. Keep the address out of logs you share.
2. **When a delivery carries a bearer token it must verify**: a JWT signed with the app's client secret (HS256, HS384 or HS512; never
   `none` or an asymmetric algorithm) that is not expired. A token that does not verify refuses the delivery. A delivery without a token
   is accepted on the secret alone. Because Atlassian does not document the claims, only the signature and `exp` are checked.

Deliveries are **de-duplicated** by registration and Jira's `X-Atlassian-Webhook-Identifier` (the same across retries, unique per
tenant): a delivery that succeeded is answered `duplicate` and does nothing; one that another request is handling answers `409` (Jira retries
408, 409, 425, 429 and 5xx up to five times); one that failed after its claim releases it and answers `503`.

### What a delivery does

- **Every event** writes the issue into the ticket mirror (`tracker_items`, `provider = 'jira'`, [`docs/ticket-mirror.md`](ticket-mirror.md)).
- **A change of the status** in an `jira:issue_updated` (the `status` item of the changelog) starts the lanes of the project that wait for the
  new status (trigger `ticket.statusChanged`, [`docs/workflows.md`](workflows.md#the-status-trigger)). **Whoever made the change starts
  it**, the factory's own transitions included. A creation is no change of status and starts nothing. Before a run starts the factory
  asks Jira for the issue and checks that it **still has that status** (a late or repeated delivery starts nothing).

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
- [ ] **Status into a lane.** A lane with `ticket.statusChanged` to a Jira status: move an issue into it in Jira (person, then an automation
      rule): one run each, `trigger.ticket` has key, title, description as text, status, type, labels, assignee, link.
- [ ] **Extension and expiry.** Call `GET /api/internal/jira-webhooks` with the cron secret: a young webhook is `unchanged`; set `expires_at`
      of the row to a date within ten days and call again: `extended`, and Jira's `GET /rest/api/3/webhook` shows the later end. Delete the
      webhook in Jira's API and call the job: it registers a new one. Find out what `PUT /rest/api/3/webhook/refresh` answers for a webhook
      that does not exist (the factory takes 404 as gone and registers a new one; any other 4xx is kept as `jira_webhook_rejected`).
- [ ] **Fifth and sixth project.** Five projects on one connection work; the sixth shows `jira_webhook_limit` on its row.
