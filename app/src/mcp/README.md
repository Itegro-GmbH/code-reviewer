# MCP servers of a workspace

A workspace keeps a list of **remote MCP servers** its agents may use (epic #1049, this folder is issue #1050: the registry, the **MCP** tab and the
connection test; `oauth/` is issue #1051: OAuth for servers that need it). Owners and Admins add, change, test and remove them (`manage_mcp`); every member sees the list. Factory only: the page and the routes
exist in a deployment with the capability `implementer` (`src/capabilities/routes.ts`). Local servers started by a command (stdio) are out of scope.

| File                   | Role                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors.ts`            | The stable codes: refusals (`MCP_ERROR_CODES`, with the field of the form each belongs to), and how a test ended (`MCP_TEST_ERROR_CODES`)                                                                                              |
| `config.ts`            | `mcpTestEndpointsAllowed(env)`: `ALLOW_TEST_MCP_ENDPOINTS=true`, the test stack's switch for plain http and loopback; ignored when `VERCEL_ENV=production`, and logged at the start                                                    |
| `url.ts`               | `checkMcpUrl`: https only, no credentials, no fragment, no query, no host that is this machine, private, link-local, reserved or the metadata service                                                                                  |
| `input.ts`             | `parseMcpServerInput`: the form (name, transport, address, authentication `none` or `header` with one to ten headers); the first problem is one code; a header may be kept on an edit (`keep`), never for another address or transport |
| `sse.ts`               | The reader of an event stream, with a limit on what it reads                                                                                                                                                                           |
| `client.ts`            | `testMcpServer`: this server as an MCP client over Streamable HTTP or SSE: `initialize`, `notifications/initialized`, `tools/list` (paged); one deadline, size caps, redirects by hand                                                 |
| `service.ts`           | `createMcpService`: list, create, update, remove, test; seals the header values, rate limits the test, stores the result for the revision that was tested                                                                              |
| `http.ts`, `shared.ts` | The handlers of the routes below and the wiring of the running server (guarded fetch, master key)                                                                                                                                      |
| `oauth/`               | OAuth for a server of the kind `oauth` (#1051): see the section below                                                                                                                                                                  |
| `catalog/`             | The catalog of presets (#1054): `entries.ts` (the list, `CATALOG_VERSION`), `preset.ts` (a preset as the first values of the dialog and as the form the route reads)                                                                   |
| `ui/`                  | The page: `mcp-panel.tsx` (list, test, remove), `server-dialog.tsx` (add and change), `api.ts`, `messages.ts` (the copy of every code)                                                                                                 |

## Routes

| Route                                                  | Who          | What                                                                                                             |
| ------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/w/:workspace/mcp/servers`                    | every member | The servers: address, transport, the NAMES of the headers, last test, tool list                                  |
| `POST /api/w/:workspace/mcp/servers`                   | Owner, Admin | Adds a server                                                                                                    |
| `PUT /api/w/:workspace/mcp/servers/:serverId`          | Owner, Admin | Changes a server; `revision` is required; a header `{ name, keep: true }` keeps its value                        |
| `DELETE /api/w/:workspace/mcp/servers/:serverId`       | Owner, Admin | Removes a server; 409 `mcp_server_in_use`, naming the lanes, while a lane uses it                                |
| `POST /api/w/:workspace/mcp/servers/:serverId/test`    | Owner, Admin | Connects as an MCP client, stores and returns the tool list (30 tests per workspace in 10 min)                   |
| `POST /api/w/:workspace/mcp/servers/:serverId/connect` | Owner, Admin | OAuth servers: discovery, client, signed state; answers `{ url }`, the consent page (20 per person in 10 min)    |
| `GET /api/mcp/oauth/callback`                          | signed in    | Where the authorization server sends the browser (`?code&state`); ends on `/w/<slug>/mcp?mcp=<code>&server=<id>` |

## Rules that hold

- **A secret never leaves the server.** Header values are sealed with AES-256-GCM (`src/crypto/secret-box.ts`; table `mcp_servers`, the row id and the field `headers`
  are bound into the ciphertext). No answer, log line or page holds a value: a server is shown with the NAMES of its headers and a mask. Only the connection test
  (and, later, the proxy at the sandbox's door, #1053) opens them. **No credential goes into the agent's sandbox.**
- **The address is guarded twice.** As text when it is saved (`url.ts`), and at the connection: the name is resolved once and every address must be public
  (`src/dispatch/guarded-fetch.ts`), redirects are followed by hand (at most 3, each target checked again, the credential dropped when the origin changes), and the endpoint
  an SSE server names must be on the origin of the stream. Plain http and this machine are accepted only behind `ALLOW_TEST_MCP_ENDPOINTS` (test stack only; a private
  network and the metadata service stay refused).
- **A test is bounded.** One deadline of 15 s for the whole test, 1 MiB per body (512 KiB per event of an event stream), at most 100 tools of 20 pages, names cut to 100 and descriptions to 300 characters (every GET of the list ships them for up to 50 servers), control and bidirectional characters removed.
  It ends in a result code, never in an exception or an error text.
- **A test result belongs to a revision.** An edit that changes the address, the transport or the credentials makes the last test stale (`untested`, tool list dropped);
  a test that started before an edit does not overwrite it.

- **Secrets belong in headers, never in the address.** The address may not hold a user name, a query or a fragment, and the form says that a key in the path is not stored
  sealed and is shown to every member. A header value is Latin-1 text without control characters (`mcp_header_value_invalid`).
- **A stored value goes only where it was entered for.** An edit that changes the address (the full normalised address) or the transport may not keep a header value
  (`mcp_header_value_required`): the values are entered again, so an Admin cannot point a server at their own host and press Test to collect the stored key. The kept values
  are read in the transaction that writes, and a change needs the `revision` of the form (`mcp_revision_required`).

## OAuth for remote servers (#1051)

A server of the kind `oauth` is connected with a click ("Connect" on the MCP tab) by the authorization code flow with PKCE of the MCP authorization specification.
`oauth/` is the whole of it; the rows are in `mcp_oauth_connections` (`src/db/README.md`).

| File                                                   | Role                                                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth/errors.ts`                                      | The stable codes: why starting failed, how the round trip ended (shown once on the page), why a token cannot be given out, why a connection is broken                                          |
| `oauth/endpoint-http.ts`                               | One call to an address the flow was told about: the address is judged first (`checkMcpUrl`), the connection is the guarded fetch, redirects are NOT followed, a deadline and a cap on the body |
| `oauth/discovery.ts`                                   | The 401 of the server and `resource_metadata` (RFC 9728), the well-known places, the authorization server's metadata (RFC 8414 or OpenID Connect discovery), S256 required                     |
| `oauth/registration.ts`                                | Dynamic client registration (RFC 7591) as a public client; without it an Owner or Admin enters a client id (and secret) in the form                                                            |
| `oauth/authorization-url.ts`, `oauth/pkce.ts`          | The consent address: PKCE S256, `state`, `redirect_uri`, `resource` (RFC 8707), `scope`                                                                                                        |
| `oauth/token-endpoint.ts`                              | The exchange of the code and the refresh, with the client authentication the registration says; a failure is `refused`, `client`, `unavailable` or `address_refused`                           |
| `oauth/tokens.ts`                                      | Sealing, and `use`: the access token renewed BEFORE it ends (`min(5 min, half its lifetime)`), the refresh serialized per server under the row lock; the sealed pair names its grant           |
| `oauth/flow.ts`, `oauth/issuer.ts`                     | What a started flow keeps in its state (discovery, client); the issuer of an entered client in the form discovery uses                                                                         |
| `oauth/service.ts`, `oauth/http.ts`, `oauth/shared.ts` | `startConnect` and `completeCallback`, the two routes, the wiring of the running server                                                                                                        |

Rules that hold:

- **Every address is checked, each one.** The server's address, the metadata address a 401 names (it can be on any host), the authorization server's issuer, and its authorization, token and
  registration endpoints go through the same rule as a server address (https only, no private, link-local, reserved or metadata address) and the guarded fetch. The authorization server
  may be on another origin than the MCP server; that is checked, not assumed. A redirect of a discovery document or an endpoint is not followed. The test flag opens plain http and loopback only.
- **The metadata has to be about this server.** The `resource` of the protected-resource metadata must be the server's address, the `issuer` of the authorization server's metadata must be the
  issuer it was found for, and a response with `iss` (RFC 9207) must carry the discovered issuer (and must have one where the metadata announces it).
- **The state is the person's and the session's.** `mcp-connect`, single use, 10 minutes, bound to the person and the browser session; the PKCE verifier stays server side with it; it names the
  server and its REVISION: an edit between the start and the callback ends the flow (`mcp_server_changed`) and the tokens are saved only for that revision (the row is locked `for share`).
  The state also carries what discovery found and the client of THIS flow (`oauth/flow.ts`; a client secret only as the sealed value). The callback uses these, never the row and never a second
  discovery, and the row takes discovery, client and tokens together in ONE statement (`saveConnection`): a Reconnect that is abandoned, or that finds another authorization server, leaves a
  connection that works as it was, and two flows at once each exchange at their own endpoint with their own client. The callback's rate limit is hit before the state is used up.
- **An entered client is for one authorization server.** The form needs the issuer with a client id; it is kept as `registered_issuer`, and Connect refuses (`mcp_oauth_issuer_mismatch`,
  nothing is sent) when the discovery names another one, so an Admin cannot point the metadata somewhere else to collect the secret. A kept secret needs the same address, transport,
  client id and issuer. Connect answers with the host of the authorization server and the scopes, and the page asks the person to confirm before the browser leaves. A registered
  (dynamic) client whose secret this process cannot open is registered again; an entered one is the operator's to mend (`unavailable`).
- **Tokens are for one resource and one client.** An edit of the address, the transport, the kind or the OAuth client deletes the connection in the same transaction (`McpOAuthChange`); the
  connection records the resource and `use` refuses a server whose address is not it. The sealed pair also records the issuer, the token endpoint and the client id of its grant, and `use`
  refuses (`MCP_OAUTH_GRANT_MISMATCH`, nothing is sent) a row whose discovery or client says otherwise. The test sends the token only to the address it was made for (the credential is dropped when a redirect leaves the origin).
- **Refresh is early but not constant.** The margin is `min(5 minutes, half the token's lifetime)`, so a token that lives a few minutes is not renewed on every use.
- **Refresh is serialized, and only the grant's end is sticky.** `invalid_grant` marks the server `broken` (`mcp_oauth_refresh_refused`, shown as "Reconnect"), as does an expired access token
  without a refresh token (`mcp_oauth_expired`). A client the authorization server does not accept, a 5xx, a timeout, an address that is no longer allowed or a pair this process cannot open
  (another `APP_SECRET`) change nothing: `mcp_oauth_unavailable`, and the operator's log says why (`MCP_OAUTH_REFRESH_FAILED`, `MCP_OAUTH_TOKENS_UNREADABLE`, `MCP_OAUTH_CLIENT_REFUSED`).
- **A secret never leaves the server.** The access and refresh token and the client secret are sealed (table, server id and field bound into the ciphertext); a view holds the state, the scopes
  and an entered client id, never a token or a secret; a log line holds a code and the server id.
- **No scope is invented.** The scopes asked for are the `scope` of the 401, else the `scopes_supported` of the metadata, else none.

## For the issues that follow

- **Lanes (#1052, done)** name servers by id in their document under the key `mcp` (`MCP_LANE_DOCUMENT_KEY`; `lane-contract.test.ts` fails when another key is chosen without changing it): `mcp: [id…]` on the lane and `mcp: [id…]` on an agent step (a subset of the lane's;
  absent = all of the lane's, empty = none). Format, codes and the pure effective-list functions: `src/workflows/mcp.ts`, `mcp-check.ts`, `docs/workflows.md` ("MCP servers of a lane"). Saving a lane (a new lane or a new version) that names servers
  takes `for key share` on their rows in the same transaction and refuses one that is not a server of the workspace (`workflows-repository.ts`, `mcpServerIds`); `removeUnlessUsed` takes `for update`, so a removal waits for a save in flight and then finds the lane.
  Editing a server (`for no key update`) never waits for a save. `removeUnlessUsed` still reads EVERY string under a key `mcp` anywhere in a current lane document (a superset of the exact field, on purpose: it can only refuse more).
- **OAuth (#1051)** is done: see "OAuth for remote servers" below. For the proxy (#1053): `createMcpOAuthTokens(...).use(serverId, { serverUrl })` (`oauth/tokens.ts`) gives a fresh
  access token (`SecretValue`) or a code (`mcp_oauth_not_connected`, `mcp_oauth_broken`, `mcp_oauth_unavailable`); a 401 from the server is passed back as `rejected` for one renewal.
- **The proxy (#1053)** asks which servers an agent step may use with `effectiveMcpServers(document, stepId)` (`src/workflows/mcp.ts`) or, in the engine, `effectiveMcpServersOfNode(runDocument, node)` (`src/workflow-runs/document.ts`; `RunDocument.mcpServers` is the lane's list), where the engine starts a turn (`workflow-runs/engine.ts`, next to `turnTimeLimitMinutes`). It reads a server with `readHeaders` and `openHeaders` (`service.ts`); an OAuth server's access token comes from `createMcpOAuthTokens(...).use` (`oauth/tokens.ts`); `tools_snapshot` is what a lane's editor may offer to narrow (the lane editor of #1052 narrows per server, not per tool; descriptions stay cut at 300 characters in the list: a detail read of one server is the way if an editor ever needs more, not larger caps).
- **The catalog (#1054, done)**: a preset is a prefilled form; nothing is added to the table. `catalog/entries.ts` holds, per vendor, the address, transport, auth kind (`header` with the header name, `oauth`, `none`), a monogram (no logos), a scope note, the vendor page the endpoint was read from (`docsUrl`) and the day (`checkedOn`). Rules for an entry: only an endpoint the vendor's own public docs name; no query string or secret in the address (the registry refuses it, so the vendors' `?readonly=true` variants are not presets; a documented path like `/readonly` is); one kind of authentication; a new or changed entry bumps `CATALOG_VERSION`. "Add from catalog" (manage_mcp) opens the same add dialog prefilled; an OAuth entry goes straight on to Connect after saving, a header entry asks for the value of the named header. `catalog/entries.test.ts` (every entry passes `checkMcpUrl` and `parseMcpServerInput`) and `ui/catalog.test.tsx` (same posted form as the dialog by hand) keep it honest.

Tests: unit (`url`, `input`, `sse`, `client` against `fakes/mcp`, `oauth/` against `fakes/mcp/oauth.ts`, the page), integration against Postgres (`mcp.integration.test.ts`,
`oauth/oauth.integration.test.ts`, the repositories, the migrations, `scoped-isolation.integration.test.ts`, `integration-tests/http/workspace-isolation.integration.test.ts`).
