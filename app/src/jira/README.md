# Jira Cloud connection

A workspace connects Jira Cloud sites to the factory with OAuth 2.0 (3LO) and the factory's own Atlassian app (epic #1034,
issue #1037). This folder is the connection only: Jira as a project's ticket source (#1038), the inbound webhook (#1039) and the
write-back come on top and call Jira through `JiraTokens.request`. How an owner registers the Atlassian app:
[`docs/jira-cloud-setup.md`](../../../docs/jira-cloud-setup.md).

| File                                  | Role                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                           | `readAtlassianConfig(env)` (`ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`, both or the feature is off; the test-only addresses need `ALLOW_TEST_ATLASSIAN_ENDPOINTS`), `JIRA_SCOPES`, `jiraCallbackUrl`, the start-up problems and the one start line |
| `errors.ts`                           | The stable codes: refusals, why a connection is broken (`jira_refresh_refused`, `jira_tokens_unreadable`), what a call can fail with, what a flow can end with                                                                                              |
| `client.ts`                           | The calls to Atlassian (consent address, code exchange, refresh, accessible resources, the account): values, never exceptions; a failure holds nothing of the answer                                                                                        |
| `tokens.ts`                           | `createJiraTokens`: seals and opens the pair, refreshes before a call, `request` (a call to a site's Jira API that renews on 401 and repeats once)                                                                                                          |
| `service.ts`                          | `createJiraService`: `startConnect`, `completeCallback`, the choice among several sites (`readChoice`, `choose`), `remove`, `list`                                                                                                                          |
| `http.ts`, `shared.ts`, `assemble.ts` | The handlers of the routes below, the wiring of the running server, the wiring over a database (tests)                                                                                                                                                      |
| `rate-limits.ts`                      | The shared counters of "Connect Jira" (`start`, `callback`; per person and for the instance)                                                                                                                                                                |
| `ui/`                                 | The Jira card of the Integrations tab (`jira-section.tsx`), its data (`jira-page.ts`), the calls (`api.ts`) and the words (`messages.ts`)                                                                                                                   |

The table is `jira_connections` (`src/db/migrations/20261114150000_create_jira_connections.ts`), read and written only through
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
     are one rotating pair;
   - none: `jira_no_site`; a reconnect whose grant does not cover the connection's site: `jira_site_mismatch`.
     The browser always lands on a fixed page: `/w/<slug>/settings/integrations?jira=<code>`, or `/` when no workspace can be named.
3. `GET /api/w/:workspace/jira/connections` (any member): the connections as `JiraConnectionView`, never a token.
4. `DELETE /api/w/:workspace/jira/connections/:id` (Owner or Admin): removes the connection unless a project's ticket source names
   it, then `409 jira_connection_in_use` with the projects (`{ id, name }`; the name is the repository's full name).

## Tokens

- The pair `{ accessToken, refreshToken }` is ONE JSON sealed in the row (`tokens_*` columns, AAD: table, row id, `tokens`), so a
  refresh replaces both in one statement. `token_version` counts the writes; a write replaces only the version it read (compare
  and swap).
- `tokens.use(id)` / `tokens.request(id, path)`: renew when the access token ends within 5 minutes; a 401 renews and repeats once.
- Atlassian rotates the refresh token on every refresh. Two requests that refresh at once: the first pair wins, the other request
  finds a newer version (its own refresh was refused because the first used the token up) and uses that. Only a refusal for the
  pair that is still the current one makes the connection `broken` with `jira_refresh_refused`; a timeout or a 5xx changes nothing
  (`jira_unavailable`). A pair that cannot be decrypted is `broken` with `jira_tokens_unreadable`. A broken connection makes no
  call to Atlassian; a person connects it again (the settings page offers Reconnect).
- No answer, page, state, log line or error holds a token, the authorization code or the client secret (`#1037-T04` searches the
  answers, redirects, rows and logs of a whole life of a connection for the tokens the fake issued).

## For the ticket source (#1038)

A project that uses a connection stores `{ "provider": "jira", "connectionId": "<id>", ... }` in `projects.ticket_source`;
`removeUnlessUsed` reads exactly these two keys. The code that sets such a source must take the connection's row lock
(`select ... for share` on `jira_connections`) in the transaction that writes the source, so a removal cannot slip in between.
