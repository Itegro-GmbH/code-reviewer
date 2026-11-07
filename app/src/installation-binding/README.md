# Binding GitHub installations to workspaces

One GitHub App serves many workspaces and anybody may install it. This folder decides which workspace an installation
belongs to, and never hands the repositories of one customer to another. The decision is
`docs/decisions/0001-editions-setup-and-accounts.md`, section 2.9; the rule that runs through everything is
**fail closed**: whatever cannot be established links nothing.

| File                                              | Role                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`                                      | The flow: `startConnect`, `completeSetup` (the App's Setup URL), `completeAuthorization` (the user authorization and the checks), the list of installations (`startPicker`, `chooseFromPicker`, `readPicker`) |
| `connections.ts`                                  | `link` (create, recognize or bring back a connection, then read its repositories) and `disconnect`; the only place that does either for the binding                                                           |
| `approvals.ts`, `approvals-http.ts`               | The instance admin's decision on a request (`POST /api/admin/approvals/:id`)                                                                                                                                  |
| `placement.ts`                                    | Where an installation that is new to the instance may go **without** a person: a workspace in one case, otherwise nowhere                                                                                     |
| `http.ts`                                         | The handlers of the routes below, and the two redirects of GitHub                                                                                                                                             |
| `rate-limits.ts`                                  | The shared counters (`start`, `callback` and `sync`, per person and for the instance)                                                                                                                         |
| `errors.ts`, `../db/installation-link-request.ts` | The stable codes (refusals, waits, results of the page) and the vocabulary of a request                                                                                                                       |
| `assemble.ts`, `shared.ts`                        | The wiring over a database (tests) and over the running server                                                                                                                                                |
| `ui/`                                             | The GitHub App page of a workspace (the Integrations tab of its settings) and the Approvals page of the portal, with the copy of every code                                                                   |

## The flow

1. **Connect GitHub** (`POST /api/w/:workspace/github/connect`, Owner or Admin). A signed state (`github-install`: the
   workspace, the person, a single-use nonce, 10 minutes, bound to the browser session) is made, and the answer is the
   address of the App's installation page on GitHub with that state. In a multi-tenant instance this is refused with
   `user_authorization_not_configured` until the App's user authorization (client id and secret) is configured.
2. GitHub sends the browser to the App's **Setup URL** `/github/connected?installation_id&setup_action&state`. The state is used
   up and must be this person's, this session's and the right purpose's; the person must still be an Owner or Admin of
   its workspace. `setup_action=request` (GitHub asked the owners of the account) ends here as `waiting_for_github_approval`.
   Otherwise the browser goes on to GitHub's authorization, with a second state (`github-authorize`, PKCE).
3. The callback of the authorization (`/api/auth/callback/github`, dispatched by the purpose of the state) exchanges the
   code. **The user token lives in memory for the checks and is never stored, logged or returned.** In this order:
   whose GitHub account it is (it becomes the person's identity, or must be the one they have; one belonging to another
   user is refused, no second user is made), whether the installation is among the ones the token can use
   (`GET /user/installations`), and whether the person is the personal account itself or an organization **owner**
   (`GET /user/memberships/orgs/{org}`: an active member with the role `admin`). Access to the installation, or admin
   rights on a repository, never suffice.
4. Only then `connections.link` creates the connection (one workspace per installation: the unique index of
   `integrations`) and the repositories are read. An installation of another workspace is refused with
   `installation_already_linked`, which does not say whose it is and is only reached after the person has shown they
   can use the installation; linking again from the same workspace is idempotent.
5. If the **role cannot be read** (GitHub refuses it: the App lacks the organization permission Members), nothing is
   linked: an `installation_link_request` (workspace, person, installation, evidence) is made and the instance admin
   approves or denies it under **Approvals** in the admin portal. The evidence is whether the person's token lists the
   installation and the result of the role read, never the token. Approving links the installation in the same
   transaction that claims the decision, with the checks that still apply (the person is still an Owner or Admin, the
   installation is not another workspace's). Linking an installation through the binding ends the waiting requests for it in every
   workspace (`withdrawn`), and an approval that finds it linked elsewhere withdraws its request. A single-tenant instance
   without the user authorization sends every request there, but only for an installation the instance has noted as
   unclaimed (or one the workspace already has): any other id, unknown to GitHub or linked elsewhere, is answered
   `installation_not_accessible` without asking GitHub, so the id is no probe. An instance whose tenancy is not stored is
   treated as multi-tenant.

"Link an existing installation" lists the installations the person's token can use that no other workspace has linked (an
authorization, then a signed list `github-picker`), and a choice goes through steps 3 to 5 again.

A state never carries an address. Where a browser lands is a fixed page: `/w/<slug>/settings/integrations?github=<code>` (the Integrations tab of the settings, #925; the old `/connections` redirects there and carries the two query parameters) for a workspace
the person administers, `/github/result?github=<code>` otherwise; `redirect` or `next` parameters are ignored.

## What never creates a connection

An `installation created` delivery and the App-wide listing of the synchronization (at start, by the instance admin's
button) only **note** the installation in `unclaimed_installations`. `placement.ts` allows one exception: a **single-tenant**
instance, a **private** App (the admin's flag) and an installation on the App's **own account** (`GET /app` owner id) is
attached to the instance's one workspace. Anything that cannot be established is "no". Webhooks are attributed to a
workspace only through the installation id of a linked connection; a delivery for an unclaimed installation creates nothing.

## Disconnect and synchronization

`DELETE /api/w/:workspace/integrations/:id` turns the connection into `disconnected` and its repositories inactive; projects
and runs stay, GitHub is untouched, the synchronization and deliveries never bring it back, and the installation stays the
workspace's: only the same workspace can connect it again (who may link it after a disconnect is an open question of the
decision record; this is the conservative answer). `POST /api/w/:workspace/integrations/sync` reads the repositories of the
workspace's own connections and answers `{ added, errors }` for them only. The instance-wide synchronization stays the
instance admin's (`/api/admin/integrations/sync`, a button on the Approvals page).

## Routes

| Route                                                  | Who                       | What                                                      |
| ------------------------------------------------------ | ------------------------- | --------------------------------------------------------- |
| `POST /api/w/:workspace/github/connect`                | Owner, Admin              | The address of the installation page                      |
| `POST /api/w/:workspace/github/installations`          | Owner, Admin              | The address of the authorization that lists installations |
| `POST /api/w/:workspace/github/installations/choose`   | Owner, Admin              | The address of the authorization that links a choice      |
| `DELETE /api/w/:workspace/integrations/:integrationId` | Owner, Admin              | Disconnect                                                |
| `POST /api/w/:workspace/integrations/sync`             | Owner, Admin              | Read the workspace's connections from GitHub              |
| `GET /github/connected`                                | the signed in person      | The Setup URL of the App                                  |
| `GET /api/auth/callback/github` (states of this flow)  | the signed in person      | The callback of the authorization                         |
| `POST /api/admin/approvals/:id`                        | instance admin (else 404) | Approve or deny a request                                 |

The JSON routes read the request the one way every route does (`src/http/json-body.ts`: same site, `application/json` only, a
small limit, parsed once). Every start and every callback is rate limited through `rate_limits` (10 per person per 10
minutes, per kind; the button of the workspace synchronization counts as `sync`, and its answer carries the code of each
problem only).

## Tests

`binding.integration.test.ts` (the flow against the fake GitHub), `placement.integration.test.ts` (webhook and
synchronization), `connections.integration.test.ts` (disconnect, the workspace synchronization), `approvals*.test.ts`,
`http.integration.test.ts` (parsing, roles, redirects, limits), `isolation.integration.test.ts` (two workspaces), the
tests of `ui/`, and the journey `e2e/workspaces/connect-github.e2e.ts`. The harness is `src/test-support/binding-harness.ts`.
