# Jira Cloud connection

A workspace connects Jira Cloud sites to the factory with OAuth 2.0 (3LO) and the factory's own Atlassian app (epic #1034,
issue #1037). This folder is the connection and, since #1038, the reads a project's ticket source needs (the projects and the workflow statuses of a
site, `projects.ts`); the inbound webhook (#1039) and the write-back come on top and call Jira through `JiraTokens.request`. How an owner registers the Atlassian app:
[`docs/jira-cloud-setup.md`](../../../docs/jira-cloud-setup.md).

| File                                  | Role                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                           | `readAtlassianConfig(env)` (`ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`, both or the feature is off; the test-only addresses need `ALLOW_TEST_ATLASSIAN_ENDPOINTS`), `JIRA_SCOPES`, `jiraCallbackUrl`, the start-up problems and the one start line                                                                                                                            |
| `errors.ts`                           | The stable codes: refusals, why a connection is broken (`jira_refresh_refused`), what a call can fail with, what a flow can end with                                                                                                                                                                                                                                                   |
| `client.ts`                           | The calls to Atlassian (consent address, code exchange, refresh, accessible resources, the account): values, never exceptions; a failure holds nothing of the answer                                                                                                                                                                                                                   |
| `projects.ts`                         | `createJiraProjectReader` (#1038): `listProjects` (the projects of the connection's site, page by page, cut at `MAX_PROJECT_PAGES`, `complete` says so) and `listStatuses` (the workflow statuses of one project, all issue types together, each name once, Jira's own spelling and order); values, never exceptions (`jira_forbidden`, `jira_project_not_found`, plus the call codes) |
| `tokens.ts`                           | `createJiraTokens`: seals and opens the pair, refreshes before a call, `request` (a call to a site's Jira API that renews on 401 and repeats once)                                                                                                                                                                                                                                     |
| `service.ts`                          | `createJiraService`: `startConnect`, `completeCallback`, the choice among several sites (`readChoice`, `choose`), `remove`, `list`                                                                                                                                                                                                                                                     |
| `http.ts`, `shared.ts`, `assemble.ts` | The handlers of the routes below, the wiring of the running server, the wiring over a database (tests)                                                                                                                                                                                                                                                                                 |
| `rate-limits.ts`                      | The shared counters of "Connect Jira" (`start`, `callback`; per person and for the instance)                                                                                                                                                                                                                                                                                           |
| `ui/`                                 | The Jira card of the Integrations tab (`jira-section.tsx`), its data (`jira-page.ts`), the calls (`api.ts`) and the words (`messages.ts`)                                                                                                                                                                                                                                              |

The table is `jira_connections` (`src/db/migrations/20261114160000_create_jira_connections.ts`), read and written only through
`src/db/repositories/jira-connections-repository.ts`, created for one workspace.

## The flow

1. `POST /api/w/:workspace/jira/connect` (Owner or Admin; `{ connectionId }` to connect an existing one again): a signed
   `jira-connect` state (workspace, person, single-use nonce, 10 minutes, bound to the browser session) and the address of
   Atlassian's consent page (`audience`, the scopes, the callback, `prompt=consent`). No PKCE: Atlassian documents none for a web
   app's 3LO flow; the client secret authenticates the code exchange.
2. `GET /api/jira/callback?code&state`: the state is used up **first**; a forged, used, expired or foreign state refuses at once and
   nothing is exchanged. The person must still be an Owner or Admin. Then the code is exchanged, the Jira sites of the grant
   (`accessible-resources`, only entries with `read:jira-work`) and the account (`/me`) are read:
   - one site: the connection is saved (the same site again renews that row in place);
   - several: the sealed grant waits in the workspace's secrets (`jira_pending_grant`, 15 minutes, for that person) and
     `POST /api/w/:workspace/jira/choose { cloudId }` connects one; one round makes one connection, because the tokens of a grant
     are one rotating pair. `choose` takes the waiting grant in one statement (`delete ... returning`), so a double click stores
     the pair once; an expired grant is removed when it is read (there is no sweep of grants nobody reads yet);
   - none: `jira_no_site`; a reconnect whose grant does not cover the connection's site: `jira_site_mismatch`.
     The browser always lands on a fixed page: `/w/<slug>/settings/integrations?jira=<code>`, or `/` when no workspace can be named.
3. `GET /api/w/:workspace/jira/connections` (the action `start_implementer_task`, today every member): the connections as `JiraConnectionView`, never a token.
4. `DELETE /api/w/:workspace/jira/connections/:id` (Owner or Admin): removes the connection unless a project's ticket source names
   it, then `409 jira_connection_in_use` with the projects (`{ id, name }`; the name is the repository's full name).

## Tokens

- The pair `{ accessToken, refreshToken }` is ONE JSON sealed in the row (`tokens_*` columns, AAD: table, row id, `tokens`), so a
  refresh replaces both in one statement. `token_version` counts the writes; a write replaces only the version it read (compare
  and swap).
- `tokens.use(id)` / `tokens.request(id, path)`: renew when the access token ends within 5 minutes; a 401 renews and repeats once.
- Atlassian rotates the refresh token on every refresh, so the refresh of a connection is serialized: the row is locked
  (`withLockedTokens`, `select ... for update`) from the read of the pair to its write. A request that needs a refresh while
  another one runs waits, then reads the pair the first stored and uses it; it never sends a refresh token that is used up.
  The lock is held across the one call to the token endpoint (10 s timeout).
- Only `error: "invalid_grant"` from the token endpoint (the refresh token is revoked, expired or used) makes the connection
  `broken` with `jira_refresh_refused`. `invalid_client`, `unauthorized_client`, any other 400/401/403, a timeout and a 5xx are
  `jira_unavailable`: nothing is marked and the operator's log has `JIRA_TOKEN_ENDPOINT_REJECTED` (status and a short code, never
  a body), so a wrong client id or secret cannot break every connection for good. A pair this process cannot decrypt (another
  `APP_SECRET`) is `jira_unavailable` too, with `JIRA_TOKENS_UNREADABLE` in the log. A broken connection makes no call to
  Atlassian; a person connects it again (the settings page offers Reconnect).
- No answer, page, state, log line or error holds a token, the authorization code or the client secret (`#1037-T04` searches the
  answers, redirects, rows and logs of a whole life of a connection for the tokens the fake issued).

## The ticket source (#1038)

A project whose tickets are a Jira project stores `{ "provider": "jira", "repositoryId", "connectionId", "projectKey" }` in `projects.ticket_source`
(`repositoryId` is the GitHub repository the code lives in; there is no board). `removeUnlessUsed` reads exactly `provider` and `connectionId`.

- **The lock.** The one code that writes such a source is `ProjectsRepository.activate(repositoryId, { jira })`. It takes the connection's row
  `select ... for share` (in the workspace of the repository, so another workspace's connection is none) in the transaction that writes the
  source, after the repository's own lock. A removal (`for update`, then the check of the projects) therefore waits for the write and finds
  the project; an assignment that comes after a removal finds no row (`jira_connection_not_found`). Both orders are tested
  (`projects-repository.integration.test.ts`, "takes the connection's row for share…", "is refused when a removal holds the connection…").
- **What the dialog and the route check** before that: `POST /api/w/:workspace/projects` with `ticketSource: { provider: "jira", connectionId,
projectKey }` reads the projects of the connection's site now and refuses a key the site does not have (`unknown_jira_project`, with the keys
  it has), a connection the workspace does not have (`unknown_connection`; another workspace's is none), a broken one
  (`PROJECT_JIRA_CONNECTION_BROKEN`, 409) and a site that cannot be asked (`PROJECT_JIRA_UNAVAILABLE`, 503). The projects are also
  `GET /api/w/:workspace/jira/connections/:connectionId/projects` (`manage_projects`), for the dialog.
- **The statuses** are `JiraProjectReader.listStatuses`, read when a page is built: the lane editor's picker for `ticket.statusChanged`
  (`statusNamesFor` in `src/projects/create-shared.ts`) and the Setup tab of the project. Jira's own names, never mapped; a site that cannot be
  asked, or a broken connection, offers none and the editor takes a typed name.
- **What a Jira project does not have yet:** the ticket mirror (the webhook, #1039), tickets in the cockpit's Issues tab, and any write-back
  (#1040). `TrackerService` answers `TRACKER_SOURCE_NOT_MIRRORED` for it, the nightly resync leaves it out, and the first sync after creating it
  is not started; the issues of the code repository are not that project's tickets.
