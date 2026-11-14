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

4. **Settings**: copy the **Client ID** and the **Secret**. Leave *Rotating refresh tokens* on (the default): Atlassian then hands out a
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

**Needs reconnecting** means Atlassian refuses the stored access: the app was removed in the Atlassian account, or the grant
ran out (Atlassian lets a refresh token expire when it is not used for a long time, 90 days at the time of writing; the factory
only renews it when it calls Jira). Press **Reconnect** and accept again; the connection keeps its place. **Remove** deletes the stored access and is
refused while a project still uses the connection (the answer names the projects). Removing does not end the grant at
Atlassian: do that at <https://id.atlassian.com/manage-profile/apps> if you want it gone there too.

## What the factory keeps, and what it never shows

- Per connection: the site (cloud id, address, name), the Atlassian account id and display name of the person who connected
  it, the granted scopes, and the access and refresh token **encrypted** with the instance's `APP_SECRET` (AES-256-GCM, the
  row is bound into the ciphertext).
- No page, API answer, log line or error message contains a token, the authorization code or the client secret.
- The access token lives one hour; the factory renews it before a call when it ends within five minutes. Atlassian hands out a
  new refresh token with every renewal and the old one dies, so the pair is stored in one step.
- The `state` of the round trip is signed, single-use, ten minutes old at most and bound to the person and the browser
  session. Atlassian's 3LO flow for a web app documents no PKCE; the client secret protects the exchange of the code.
