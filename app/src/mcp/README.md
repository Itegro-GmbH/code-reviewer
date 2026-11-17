# MCP servers of a workspace

A workspace keeps a list of **remote MCP servers** its agents may use (epic #1049, this folder is issue #1050: the registry, the **MCP** tab and the
connection test). Owners and Admins add, change, test and remove them (`manage_mcp`); every member sees the list. Factory only: the page and the routes
exist in a deployment with the capability `implementer` (`src/capabilities/routes.ts`). Local servers started by a command (stdio) are out of scope.

| File                   | Role                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors.ts`            | The stable codes: refusals (`MCP_ERROR_CODES`, with the field of the form each belongs to), and how a test ended (`MCP_TEST_ERROR_CODES`)                                                      |
| `config.ts`            | `mcpTestEndpointsAllowed(env)`: `ALLOW_TEST_MCP_ENDPOINTS=true`, the test stack's switch for plain http and loopback                                                                           |
| `url.ts`               | `checkMcpUrl`: https only, no credentials, no fragment, no query, no host that is this machine, private, link-local, reserved or the metadata service                                          |
| `input.ts`             | `parseMcpServerInput`: the form (name, transport, address, authentication `none` or `header` with one to ten headers); the first problem is one code; a header may be kept on an edit (`keep`) |
| `sse.ts`               | The reader of an event stream, with a limit on what it reads                                                                                                                                   |
| `client.ts`            | `testMcpServer`: this server as an MCP client over Streamable HTTP or SSE: `initialize`, `notifications/initialized`, `tools/list` (paged); one deadline, size caps, redirects by hand         |
| `service.ts`           | `createMcpService`: list, create, update, remove, test; seals the header values, rate limits the test, stores the result for the revision that was tested                                      |
| `http.ts`, `shared.ts` | The handlers of the routes below and the wiring of the running server (guarded fetch, master key)                                                                                              |
| `ui/`                  | The page: `mcp-panel.tsx` (list, test, remove), `server-dialog.tsx` (add and change), `api.ts`, `messages.ts` (the copy of every code)                                                         |

## Routes

| Route                                               | Who          | What                                                                                           |
| --------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `GET /api/w/:workspace/mcp/servers`                 | every member | The servers: address, transport, the NAMES of the headers, last test, tool list                |
| `POST /api/w/:workspace/mcp/servers`                | Owner, Admin | Adds a server                                                                                  |
| `PUT /api/w/:workspace/mcp/servers/:serverId`       | Owner, Admin | Changes a server; a header sent as `{ name, keep: true }` keeps its stored value               |
| `DELETE /api/w/:workspace/mcp/servers/:serverId`    | Owner, Admin | Removes a server; 409 `mcp_server_in_use`, naming the lanes, while a lane uses it              |
| `POST /api/w/:workspace/mcp/servers/:serverId/test` | Owner, Admin | Connects as an MCP client, stores and returns the tool list (30 tests per workspace in 10 min) |

## Rules that hold

- **A secret never leaves the server.** Header values are sealed with AES-256-GCM (`src/crypto/secret-box.ts`; table `mcp_servers`, the row id and the field `headers`
  are bound into the ciphertext). No answer, log line or page holds a value: a server is shown with the NAMES of its headers and a mask. Only the connection test
  (and, later, the proxy at the sandbox's door, #1053) opens them. **No credential goes into the agent's sandbox.**
- **The address is guarded twice.** As text when it is saved (`url.ts`), and at the connection: the name is resolved once and every address must be public
  (`src/dispatch/guarded-fetch.ts`), redirects are followed by hand (at most 3, each target checked again, the credential dropped when the origin changes), and the endpoint
  an SSE server names must be on the origin of the stream. Plain http and this machine are accepted only behind `ALLOW_TEST_MCP_ENDPOINTS` (test stack only; a private
  network and the metadata service stay refused).
- **A test is bounded.** One deadline of 15 s for the whole test, 1 MiB per body, at most 500 tools of 20 pages, names cut to 200 and descriptions to 1000 characters.
  It ends in a result code, never in an exception or an error text.
- **A test result belongs to a revision.** An edit that changes the address, the transport or the credentials makes the last test stale (`untested`, tool list dropped);
  a test that started before an edit does not overwrite it.

## For the issues that follow

- **Lanes (#1052)** name servers in their document under the key `mcp`. `removeUnlessUsed` (`src/db/repositories/mcp-servers-repository.ts`) reads EVERY string under a key
  `mcp` anywhere in the current version of a lane that is not archived, so a list of ids, a list of objects holding an id and a per-step list are all found. #1052
  takes `for key share` on the server's row in the transaction that saves a document, and may narrow `mcpReferencesIn` to its field.
- **OAuth (#1051)**: the kind `oauth` is in the column's check list and refused by `parseMcpServerInput` (`mcp_auth_oauth_unavailable`). Its tokens and client registration go
  into a table of their own keyed by `mcp_servers.id`; this table does not change.
- **The proxy (#1053)** reads a server with `readHeaders` and `openHeaders` (`service.ts`); `tools_snapshot` is what a lane's editor may offer to narrow.
- **The catalog (#1054)**: a preset is a prefilled form; nothing is added to the table.

Tests: unit (`url`, `input`, `sse`, `client` against `fakes/mcp`, the page), integration against Postgres (`mcp.integration.test.ts`, the repository, the migration,
`scoped-isolation.integration.test.ts`, `integration-tests/http/workspace-isolation.integration.test.ts`).
