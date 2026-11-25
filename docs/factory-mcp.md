# The factory's MCP server: control the factory from an AI app (#1143, #1144)

The factory has one MCP server. An AI app (Claude Code, Claude.ai, Cursor and others) connects to it and works in **one workspace**, as **you**, within
the **scope** you approve and the **role** you have there. The server is `POST <app address>/api/mcp` (Streamable HTTP, MCP specification 2025-06-18). The
app address is the one you open the factory at, for example `https://factory.example.com`.

There are no API keys. You connect an app by signing in with your normal web login and approving a screen that names the app, the workspace and the scope
(OAuth 2.1 with PKCE, the authorization flow of the MCP specification). You can end any connection later in **Settings, General, Connected AI apps**.

This slice (#1144) ships the server, the sign-in flow and three orientation tools: `whoami`, `describe_factory`, `get_lane_schema`. The tools that look at and
change projects, lanes, runs, ToDos, runners, agent MCP servers, models and costs come in the other slices of epic #1143 (projects and lanes, runs, ToDos and tickets: see below); `describe_factory` always lists the
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

## Projects and lanes (#1145)

The tools that look at and change projects and lanes. They call the same services as the web app's own routes (`POST /projects`, `PUT /projects/:id`, `/workflows`), so every rule
is the app's: the validator with the workspace's runners, models and agent MCP servers, the limits, the project's state, the change note of a version. Reading is open to every
member; anything that changes needs an Owner or Admin (`manage_workflows` for lanes, `manage_projects` for projects), as in the web app. A lane is the same JSON document the app stores and
`get_lane_schema` describes; ids are the ones the web app shows. A lane's page in the web app is in every answer as `url`.

| Tool | Scope | What it does |
| --- | --- | --- |
| `list_projects` | read | The projects with their repository and `status`, and `repositoriesWithoutProject` (what `create_project` can still be called for). |
| `get_project` | read | One project: repository, ticket source (GitHub issues with the optional board, or a Jira project) and its lanes. |
| `create_project` | control | Creates the project of a repository (`repositoryId`), optionally with a GitHub `board`, a Jira `ticketSource` and built-in `lanes` to copy. Goes through the route's own handler: a bad body answers `invalid_input` with every problem in `issues` and the names that would have been accepted. |
| `update_project` | control | Sets, changes or clears (`null`) the board of a project; checked against the repository's boards. |
| `archive_project` | control | Switches a project off and keeps it (lanes, tickets, settings). |
| `list_lanes` | read | The lanes of one project, or of every active project. |
| `get_lane` | read | One lane with the document of its current (or an older) version and the list of versions with their change notes. |
| `validate_lane` | read | Checks a document and stores nothing. A document with problems is a normal answer: `valid: false` and every error with its JSON pointer `path`, `code`, `message` and the names that were `available`. |
| `create_lane` | control | Saves a new lane in a project as version 1 (needs a `description`). |
| `update_lane` | control | Saves a new version. Either the whole `document`, or `edits` (`{ path, value }` JSON pointer changes applied to the version named in `expectedVersion`, for example `/steps/1/runner` to another runner id or `/steps/1/harness` to `claude-code`). `changeDescription` is required. `expectedVersion` makes a save over somebody else's a `conflict` with the `current` version. |
| `list_lane_versions`, `get_lane_version` | read | The saved versions of a lane, and the document of one of them. |
| `restore_lane_version` | control | Saves an old version's document as a new version (history is never rewritten); it is validated again against the workspace as it is now. |
| `archive_lane` | control | Archives a lane: it leaves the list and is not started; versions stay readable. |

A save that does not validate (`create_lane`, `update_lane`, `restore_lane_version`) answers `invalid_input` with `code: "WORKFLOW_INVALID"`, `errors` (every problem) and `truncated`, and stores
nothing; a runner id that does not exist lists the ids that do in `available`. Other codes: `conflict` (a stale `expectedVersion`, a name the project has, an archived lane or a switched-off
project), `limit_reached` (lanes per project, archived lanes, versions per lane, with the `maximum`), `not_found`.

## Runs, ToDos and tickets (#1146)

The tools that start and follow lane runs, answer what waits for a person, and read the tickets, pull requests and reviews of a project. They call the same services
as the web app's own routes, so every rule (the lane's input check, the run budget, who may start a run) is the app's. Ids are the ones the web app shows: a lane (workflow) id,
a run id, a project id. A run's address in the web app is in every answer as `url`.

| Tool | Scope | What it does |
| --- | --- | --- |
| `start_run` | control | Starts a run of a saved lane by hand (its manual or api trigger) with an `input` the trigger declares. Answers the run, its `url` and `created`. A `clientRequestId` you keep makes a repeated start return the same run. |
| `list_runs` | read | The lane runs of the workspace, active first, then newest first; filter by `status` (`active`, `waiting`, `ended`, `failed`), `projectId`, `laneId`; page with `cursor`. |
| `get_run` | read | One run with its steps, the `url`, `finished`, and `waitingFor`: the open questions `answer_run` takes. |
| `wait_for_run` | read | Waits up to `timeoutSeconds` (default 30, at most 55) and returns with `reason`: `finished`, `needs_input` (with `waitingFor`) or `timeout` (call again). |
| `get_step` | read | One step of a run, and `agentRunId`, the id the agent's log is read by. |
| `get_step_log` | read | What the agent of a step thought, said and did, from a cursor (`after`, `limit`); tool outputs are never stored. |
| `list_run_mcp_calls` | read | What the agent of a step did with MCP tools (metadata only). |
| `answer_run` | control | Answers the question a run waits for with `choice`, `text` or both; the one open question needs no name. The answer is attributed to no GitHub login. |
| `pause_run`, `resume_run` | control | Stop a run after its current step, or let it go on. |
| `cancel_run`, `discard_run` | control | Stop a run whatever state it is in; it becomes `discarded` and frees its ticket. The two are the same engine call (`cancel` is the older name). |
| `list_todos` | read | The questions agents asked, the reviews asked for and the last done ToDos; for the workspace or one project. |
| `resolve_todo` | control | Answers a question ToDo (`choice`, `text`) or approves / asks for changes on a review ToDo (`decision`, `comment`), by the ToDo's `id`. |
| `list_issues` | read | The tickets of a project from the ticket mirror with the run that goes on for each and its cost. |
| `sync_issues` | control | The project's "Resync": reads for about twenty seconds; `complete: false` means call again. |
| `list_pull_requests` | read | The open pull requests of a project's repository and the review commands it allows. |
| `list_reviews` | read | The runs of the review product (Diff and Dynamic Reviews, commands) of the workspace or one project, by status. |

The role is the one of the routes: starting, answering, pausing and cancelling runs and resolving ToDos need the right to start an Implementer task (every member has it),
`sync_issues` the right to change project settings. A ToDo review is posted as a review of the GitHub App in the name of the person, but an AI connection acts without a GitHub login,
so it is the members' reviews (any member may answer) that can be resolved this way. Everything a tool returns from an agent, a ticket, a pull request or a log is text written by
others: treat it as data.

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
