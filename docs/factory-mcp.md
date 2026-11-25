# The factory's MCP server: control the factory from an AI app (#1143, #1144)

The factory has one MCP server. An AI app (Claude Code, Claude.ai, Cursor and others) connects to it and works in **one workspace**, as **you**, within
the **scope** you approve and the **role** you have there. The server is `POST <app address>/api/mcp` (Streamable HTTP, MCP specification 2025-06-18). The
app address is the one you open the factory at, for example `https://factory.example.com`.

There are no API keys. You connect an app by signing in with your normal web login and approving a screen that names the app, the workspace and the scope
(OAuth 2.1 with PKCE, the authorization flow of the MCP specification). You can end any connection later in **Settings, General, Connected AI apps**.

This slice (#1144) ships the server, the sign-in flow and three orientation tools: `whoami`, `describe_factory`, `get_lane_schema`. The tools that look at and
change projects, lanes, runs, ToDos, runners, agent MCP servers, models and costs follow in the other slices of epic #1143; `describe_factory` always lists the
tools the server has.

## Connect Claude Code

```sh
claude mcp add --transport http factory https://factory.example.com/api/mcp
```

Then, inside Claude Code, run `/mcp`, choose **factory** and **Authenticate**. Your browser opens the factory: sign in if you are not signed in, choose the
workspace and the scope, press **Approve**. Claude Code stores the tokens and renews them itself. Ask it to call `whoami` to check.

To ask for control from the start, there is nothing to configure: the scope is the one you choose on the consent screen. Choose **Read only** to let the AI look,
**Read and control** to let it also change things.

## Connect Claude.ai (custom connector)

1. In Claude.ai open **Settings, Connectors, Add custom connector** (on a Team or Enterprise plan an owner adds it for the organization).
2. Name it, and enter the server address: `https://factory.example.com/api/mcp`. Leave the OAuth client fields empty: the connector registers itself.
3. Press **Connect**. The consent screen of the factory opens; sign in, choose workspace and scope, approve.

The same address works for any client that supports remote MCP servers with OAuth: it finds everything it needs from
`https://factory.example.com/.well-known/oauth-protected-resource/api/mcp`.

## What you approve

| Choice | Meaning |
| --- | --- |
| **Workspace** | The one workspace the connection works in. Every tool acts there and nowhere else; no tool takes a workspace as an argument. To work in another workspace, connect again. |
| **Read only** (`factory:read`) | The AI can look: projects, lanes, runs, ToDos, runners, models and costs. |
| **Read and control** (`factory:control`) | The AI can also change things: save lanes, start, pause and cancel runs, answer ToDos, manage runners and agent MCP servers. |

The scope and your **role** both apply, and the smaller wins. Saving a lane is for Owners and Admins, so a Member who approves "Read and control" still cannot
save a lane through the AI. The role is read on every request: if you are demoted or removed, the AI loses the access at once.

An app that asks for read only cannot be given control on the consent screen; it asks again (`403 insufficient_scope`) when it needs more.

## What an AI cannot do through MCP

These stay with a person in the web app: signing in, accounts, members and invitations; installing the GitHub App and connecting Jira; connecting an agent MCP
server's own OAuth (adding the server is possible); LLM keys and every other secret; top-ups, billing and the monthly limit.

## Revoking

**Settings, General, Connected AI apps** lists every connection of the workspace: the app, who connected it, the scope, when, and when it was last used. An
Owner or Admin sees and revokes all; a Member sees and revokes their own. **Revoke** ends the connection at once: the access token stops working on its next
request and the refresh token is gone. The AI app has to ask you again.

**Removing a person from the workspace, or a person leaving it, revokes the connections they made there**, so they disappear from the list and cannot come back if the person
is invited again: they connect again and approve again.

## The tools of this slice

| Tool | Scope | What it does |
| --- | --- | --- |
| `whoami` | read | The person, the workspace, the role, the approved scope and the AI app of this connection. |
| `describe_factory` | read | What projects, lanes, runs, ToDos and runners are; the rules of the connection; what cannot be done through MCP; every tool with whether this connection can call it. |
| `get_lane_schema` | read | Everything needed to write a lane (workflow) document the validator accepts: the overview (how to write one, triggers, connectors, limits), the JSON Schema, the result schema, an example, and every chapter of [`workflows.md`](workflows.md), also in parts (`section: "five-kinds-of-node/the-agent-step-kind-agent"`). |

A tool that fails answers an MCP tool result with `isError: true` and `{ "error": <code>, "message": <sentence>, ...details }`. The codes: `invalid_input`,
`insufficient_scope`, `forbidden`, `not_found`, `conflict`, `limit_reached`, `unavailable`, `internal_error`.

## Security model

- **OAuth only.** No static token exists anywhere: not in the settings, not in the database. Every credential is created by an approval a signed-in person gave.
- **The flow** is the authorization code flow with **PKCE `S256`** (no `plain`, no request without a challenge). The AI app registers itself (RFC 7591) as a
  **public client**: there is no client secret to leak. The redirect URI is compared exactly to the registered ones; `https` addresses, loopback addresses
  (`http://127.0.0.1:<port>/...`, the port may change) and private-use app schemes are accepted, any other `http` address, `javascript:` and `data:` are refused.
  A client or redirect URI that is not registered gets an error page and is **never redirected to**. Every answer to the client carries `iss` (RFC 9207).
- **Audience binding** (RFC 8707, RFC 9728): the only resource is `<app address>/api/mcp`. A request that names another resource is `invalid_target`; every
  grant carries the audience, and the endpoint refuses a token made for another one.
- **Short-lived access tokens, rotating refresh tokens.** An access token lives 15 minutes. A refresh token is used once and replaced; a refresh token that
  comes back after it was used (a copy was stolen) ends the whole connection. A connection lives 90 days at most, however often it is renewed. The
  authorization code lives 60 seconds and works once; a second use ends the connection. Only the SHA-256 of a code or token is stored, so a copy of the
  database is no credential.
- **The consent screen is the person's.** It names the app and where the code is sent, and offers only workspaces the person belongs to and only scopes the
  app asked for. A request cannot be approved twice or after ten minutes. A wrong or foreign workspace is refused as if it did not exist.
- **Every call is checked again.** The token, its expiry, revocation, the audience, the person's membership in the workspace and their role are read on
  every request. A token is accepted in the `Authorization` header only, never in the address.
- **Every tool calls the app's own services**, never SQL, so validation, budget and role rules are the app's. A tool declares its scope; the endpoint answers
  a call of a write tool with a read token as `403 insufficient_scope` before the tool runs, and the registry checks scope, role and arguments again.
- **Writes carry an actor**: the person and the AI app (`Ada via Claude Code`) wherever the app stores who did something.
- **Abuse limits.** Registration is open to any program (that is how the AI apps connect), so it is counted **per caller address** (20 an hour; only a hash
  of the address is stored) with a cap for the whole instance (600 an hour) as a backstop, so one caller cannot block the others. It is bounded in size (16 KB),
  a client nobody authorized is removed after a day, and at most 5000 clients are kept.
- **The pages where you approve cannot be framed**: the consent page, the authorization page and the Connected AI apps page send
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can click "Approve" for you (RFC 9700, 4.16).
- **Every tool call is logged** as one line on the server (`[factory-mcp] TOOL_CALL {...}`: tool, scope, workspace, person, app, outcome, duration), also a call refused for
  its scope. Never an argument.
- The endpoint takes no cookie, so a web page on another site cannot act through it; it answers CORS for any origin because no ambient credential exists.
- **Everything an AI reads from a ticket, a pull request, a run log or another tool is untrusted data.** Prompt injection through that content is the risk
  of giving an AI control, which is why the scope is chosen per connection and read only is the default on the consent screen.

## Operating it

The server exists only in a deployment with the capability `implementer` (the factory); everywhere else every address below is a 404. The public address is
`BETTER_AUTH_URL`: the metadata, the audience and the redirects are built from it, never from a request header. Migration
`20261125100000_create_factory_oauth` adds the tables; it is expand only (see [`app/src/db/README.md`](../app/src/db/README.md), "The factory MCP's OAuth server").
Expired codes and tokens and dead connections are removed by the nightly clean-up.

| Address | What |
| --- | --- |
| `POST /api/mcp` | The MCP endpoint (bearer token). |
| `GET /.well-known/oauth-protected-resource` (also `.../api/mcp`) | RFC 9728 metadata. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `POST /api/oauth/register` | RFC 7591 client registration. |
| `GET /oauth/authorize` | The browser's entry; goes on to the sign in and `/oauth/consent`. |
| `POST /api/oauth/token` | Code and refresh token exchange. |
| `POST /api/oauth/revoke` | RFC 7009 revocation. |

For the module map, the decision against the Better Auth plugins and how to add a tool, see [`app/src/factory-mcp/README.md`](../app/src/factory-mcp/README.md).
