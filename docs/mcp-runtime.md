# MCP servers at run time: the credential-injecting proxy (#1053, epic #1049)

An agent step of a lane may use the MCP servers its lane names (#1052). **No credential enters the sandbox**: the agent's harness talks to a
local endpoint at the sandbox's door, the door calls the app, and the app calls the MCP server with the server's credential added.

```
agent (sandbox) ──▶ local endpoint at the door ──▶ app: POST /api/workers/v1/jobs/{job}/mcp/{server} ──▶ MCP server
   no credential        holds the JOB credential           adds the SERVER credential, guarded fetch        (public https)
```

## Decision: where the credential lives

Options weighed: (A) a per-run capability that the door presents to an app endpoint, which proxies to the server; (B) the decrypted credential
handed to the trusted door process (the hosted Dispatcher side, the Incus instance A).

**Chosen: A, with the credential of the job as the capability.** The door side already holds the per-job Worker credential (`crj_…`, valid for one
job, checked against the running claim on every call); the app holds the sealed server credential and opens it only inside the call it forwards.

- The server credential exists in exactly one place besides the database: the headers of one outgoing request in the app. It is never in the job
  document, the sandbox, an environment, a file, a log, a trace, the door's memory, or instance A or B.
- OAuth (#1051) needs a refresh with rotation and a lock; one writer (the app, next to its table) can do that, a door per run cannot.
- The door needs one known destination (the app, which the Worker already reaches), not a public egress to every MCP host with its own SSRF
  guard. The guard of #1050 (`guarded-fetch.ts`) is reused as it is.
- Revocation is immediate: the app checks the claim and `running` on every call, so a replay after the run ended (a copied credential, a
  recorded request) is `401`/`409`.
- Cost: a call goes through a serverless function (`maxDuration` 60 s, hence a call deadline of 55 s, held by a test) and the app sees the
  traffic. The legacy SSE transport costs three more round trips per call (below).

**The MCP host is not in the sandbox's network rule.** The agent never talks to it; the proxy (outside the sandbox) does. So the rule of an
environment is not changed, and the sandbox reaches MCP only through the local endpoint. The text of #1053 ("the MCP host is added to the run's
network rule") is replaced by this: _the sandbox's network rule is unchanged; only the local endpoint is reachable for MCP_.

## Threat model

| Threat                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent reads the credential                                           | It is not there: not in the job (`ImplementerMcp` has id, name, transport only, a closed object; `contracts/runner-api.v1.json`), not in the harness configuration (the endpoint URLs only), not in the sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The agent asks the proxy for another origin                              | It cannot name one. The call names a server id of the job; the address is the stored one. Nothing of the request but the JSON-RPC message, `Mcp-Session-Id` and `MCP-Protocol-Version` goes on (`runner-api/mcp-call.ts`, a test holds the key set).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The agent calls a server its step may not use, or another workspace's    | The id must be in the effective list of the job's step in the lane version of the run, looked up in the job's own workspace at the time of the call. Not there, removed, never existed, other workspace: one answer, `404 mcp_server_unavailable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A redirect leads the credential away                                     | Only a redirect on the server's own origin is followed (at most 3); another origin is `mcp_proxy_redirect_refused` and the credential goes nowhere else. The endpoint a legacy SSE server names for its POSTs must be on the stream's origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SSRF: the stored address points inside                                   | Checked as text when saved (#1050) and again at the call; at the connection the name is resolved once and every address must be public (guarded fetch). Plain http and loopback only behind the test flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The server's `401`/`403` makes the agent's client start its own sign-in  | Never passed on: `503 mcp_proxy_unauthorized` (the app answers no 502 or 504: a proxy in front replaces their bodies), no `WWW-Authenticate`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A slow or huge server ties the function up                               | One deadline (55 s), request cap 256 KiB, answer cap 4 MiB (an event stream ends with an error at the cap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Replay after the run                                                     | The job credential is only valid while the job holds its claim and runs (`worker-api.ts`); the server credential is never handed out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A secret in a log                                                        | `[mcp-proxy]` lines hold job, server id, method, tool name, status, outcome, duration and sizes: no argument, answer, header or address (`logMcpCall`, tested).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The credential of the job is shared by everything that can read it       | `crj_…` opens this one job's route and nothing else (it does not open another job's, a lease operation other than the Worker API's, or the server credential), and only while the claim runs. The door holds it **outside the agent's sandbox**: the agent must never read it (not in its environment, a file, the process list or the harness configuration; #1067, #1068). A copy that leaks is bounded by the call cap and the concurrency cap below, and dies with the run. The `Mcp-Session-Id` of a server is a shared secret of the same kind: a session of the server belongs to the credential that opened it, and the door ends it (`DELETE`) when the step ends, so a leaked session id is not a standing handle. |
| A runaway agent (a loop of calls) uses someone else's server in our name | At most **2000 calls per claim** (`jobs.mcp_calls`, counted in one statement across all instances; `429 mcp_call_limit_reached`) and at most **4 calls in flight per job** on an instance (`429 mcp_too_many_concurrent_calls`; best effort, see "Limits").                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A forged line in the log through the method or the tool of a call        | `method` and `tool` come from the agent: both are cleaned (no control character, no line break, no hidden character) and cut to 100 characters before they are recorded or logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A broken credential (master key changed, kind without provider)          | `503 mcp_credential_broken` / `mcp_credential_unsupported`; the agent sees a tool error; the server is not called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## What the agent's side gets: codes, statuses, retry

Every refusal of the route is a JSON-RPC-shaped error, `{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"<code>"}}` (the 413 as well), with `cache-control: no-store`. The proxy answers with the `id` of the call where it has one. Codes are stable words; none holds a value, an address or a body of the server.

**Never retry a 503 automatically: a `tools/call` may have run on the server before the error (a timeout, a cut stream, a server that failed after it acted). The agent decides, with the error in front of it.** The same goes for the door: it passes a 503 on and does not repeat the request.

| Code (`error.message`)          | HTTP | Meaning                                                                                                 | Retry?                                                   |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `WORKER_CREDENTIAL_INVALID`     | 401  | No credential, not the job's, or the claim ended                                                        | No                                                       |
| `RUNNER_JOB_ENDED`              | 409  | The job is not running any more                                                                         | No                                                       |
| (no body)                       | 405  | A method other than POST or DELETE (a GET asks for a stream of the server's own, which is not offered)  | No                                                       |
| `mcp_server_unavailable`        | 404  | Not a server of this step: removed, never existed, another workspace's, not a server id, or no MCP here | No                                                       |
| `mcp_proxy_request_invalid`     | 400  | Not one JSON-RPC message, or a session id or protocol version that is not a plain token                 | No: fix the request                                      |
| `mcp_proxy_request_too_large`   | 413  | The request is larger than 256 KiB                                                                      | No: send less                                            |
| `mcp_call_limit_reached`        | 429  | The claim made 2000 calls                                                                               | No: no more for this claim                               |
| `mcp_too_many_concurrent_calls` | 429  | 4 calls of this job are in flight on this instance (`Retry-After: 1`)                                   | Yes, in a moment: the call was not made                  |
| `mcp_credential_broken`         | 503  | The stored credential cannot be used (master key changed; a connection that needs a new sign-in)        | No: an admin fixes the server; the server was not called |
| `mcp_credential_unsupported`    | 503  | The server's kind of authentication has no provider here                                                | No; the server was not called                            |
| `mcp_proxy_address_refused`     | 503  | The stored address is not allowed (any more)                                                            | No; the server was not called                            |
| `mcp_proxy_unreachable`         | 503  | The connection failed                                                                                   | **Not automatically** (the call may have been sent)      |
| `mcp_proxy_timeout`             | 503  | The 55 s deadline of the call ended it, also in the middle of an event stream                           | **Not automatically** (the call may have run)            |
| `mcp_proxy_unauthorized`        | 503  | The server answered 401 or 403 (its challenge is never passed on)                                       | No: the credential is wrong, revoked or too weak         |
| `mcp_proxy_http_error`          | 503  | The server answered another error status                                                                | **Not automatically** (it may have acted)                |
| `mcp_proxy_redirect_refused`    | 503  | A redirect to another origin, one that loops, or more than 3                                            | No                                                       |
| `mcp_proxy_response_too_large`  | 503  | The answer is larger than 4 MiB (a stream ends with an error at the cap)                                | **Not automatically** (the call has run)                 |
| `mcp_proxy_protocol_error`      | 503  | The server's answer is not what its transport says                                                      | **Not automatically**                                    |
| `RUNNER_INTERNAL_ERROR`         | 500  | A failure of the app itself                                                                             | **Not automatically** (the call may have been made)      |

The app never answers 502 or 504 (a proxy in front replaces their bodies); every failure on the way to the server is a 503 with one of the codes above.

## Limits of the route

- **Per claim: 2000 calls** (`MCP_MAX_CALLS_PER_CLAIM`). `jobs.mcp_calls` is counted in one SQL statement on the job row, next to the lease token it belongs to, so it holds across all function instances; a new claim starts at zero. Every POST that passes the credential, the method and the server-id checks counts; whether the server then exists or not. A DELETE (ending a session) does not count, so the door can end its sessions when the cap is used up; it is still held to the places per job and to the running claim (`409` after the claim ended).
- **In flight per job: 4** (`MCP_MAX_CONCURRENT_CALLS_PER_JOB`), **best effort per instance**: the app runs as many function instances, each counting for itself in memory (nothing is stored), so the cap bounds what one instance does for one job; the count per claim is the bound that holds everywhere. An event stream answer counts until its stream has ended or the consumer let go. A call refused for this reason was not counted and not made.
- The deadline (55 s), the request cap (256 KiB) and the answer cap (4 MiB) are per call (see the threat model).
- A refusal before the proxy leaves one log line with the job, the server id where there is one, and the code (`[worker-api] mcp job=… refused: <code>`, `[mcp-proxy] job=… server=… refused: <code>`); never a value.

## Parts

| Part                                                                                      | Where                                                                     | State                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Credential providers (none, header, OAuth #1051)                                          | `app/src/mcp/credentials.ts`, `job-shared.ts`                             | #1069, #1067                 |
| The proxy (Streamable HTTP, legacy SSE adapter, limits, call metadata)                    | `app/src/mcp/proxy.ts`                                                    | this PR                      |
| Servers of a job (workspace-bound, tolerant of removed servers) and the call handler      | `app/src/mcp/job-proxy.ts`                                                | this PR                      |
| `implementer.mcp` in the job, claim feature `implementer_mcp`                             | `app/src/runner-api/mcp-block.ts`, `contracts/runner-api.v1.json`         | this PR                      |
| Worker API route `POST/DELETE /api/workers/v1/jobs/{id}/mcp/{server}`                     | `app/src/runner-api/worker-api.ts`, `mcp-call.ts`                         | this PR                      |
| Limits of the route: calls per claim (`jobs.mcp_calls`, expand-only migration), in flight | `app/src/mcp/in-flight.ts`, `runner-jobs-repository.ts`                   | this PR                      |
| Local endpoint at the hosted door, OpenCode and Claude Code configuration, the run's note | `runner/.../implementer/mcpdoor/`, `mcpdoor_launcher.py`, `mcp_config.py` | #1067 (see "The door" below) |
| The same at Incus instance A (and the endpoint through the inner wall)                    | `runner/…/incus/`                                                         | follow-up                    |

## Rules of the proxy

- **Removed servers.** A lane version a run is pinned to (retry, re-run) may name a server that was removed. The claim leaves it out and counts it
  (`implementer.mcp.unavailable`); the step runs without it and the runner shows a note. A call for it is `404 mcp_server_unavailable`. Nothing
  resolves across workspaces.
- **The endpoint is a Streamable HTTP server with no stream of its own.** `GET` is `405` (the specification allows it), before the job's lane is
  read, a call is counted or a credential is opened, so the agent's client makes one request and gets one answer.
- **Legacy SSE servers.** The proxy keeps no state between calls, so each call opens a short session: stream, endpoint, its own `initialize` and
  `initialized`, the call, the answer from the stream, close. The agent's own `initialized` is answered by the proxy. A server that keeps state
  across the calls of one session sees a new session each time.
- **Header and OAuth authentication.** `createMcpCredentials({ providers: { oauth } })` is where OAuth tokens (#1051) plug in, and `job-shared.ts`
  registers `oauthCredentialProvider` there (#1067): it asks the token store for a fresh access token of the server (renewed before it ends, under
  the row lock) and answers `Authorization: Bearer <token>`. A connection that gives no token (not connected, broken, the authorization server or
  the key unavailable, a failing database) is `mcp_credential_broken`, never an exception and never a text of the failure.
- **Per-call metadata** (`McpCallMeta`: job, server id, method, tool name, status, outcome, duration, sizes; never arguments or results) goes to
  `onCall`; today it is the log line, and #1055 hooks the live view and the trace in the same place. An event stream answer is recorded once, when
  its body has ended, whatever the way: `ok`, `cancelled` (the consumer let go; the server's stream is closed with it), or the code of the
  failure (`mcp_proxy_timeout` when the deadline cut it, `mcp_proxy_response_too_large` at the cap).
- **Cost of a call and of a claim.** The claim looks at `implementer_mcp` before it reads anything, and a lane without `mcp` costs it no query of
  the servers; a failure while resolving the servers at the claim is logged and the turn runs without the tools (it does not fail the claim). A
  call reads the lane's list of the step and then the called server only (`get` by id, never the list of all servers).
- **Servers of the legacy SSE transport** close the short session they opened for a call whatever happens to the call (the answer, an error, the
  deadline).
- **A job that no workflow step started has no servers.** The claim sends `implementer.mcp` only to a Worker that named `implementer_mcp` and only
  for such a turn; for any other caller the turn runs without MCP tools (not refused: nothing widens).

## The door: the local endpoint at the sandbox (#1067)

On a hosted sandbox (and on every VM of the Firecracker backend, which has the same placement) a step with MCP servers gets **a third container on
the model network**, the MCP door, next to the model door (`10.213.77.2`) and the network door (`10.213.77.3`): `10.213.77.5:3129`
(`model_door_route.py`, `mcpdoor_launcher.py`). It is made like the other doors (hardened by construction, no environment variable, no mount, no
published port, the same egress table: DNS, port 443 of public addresses, nothing private and nothing of the model network; with the host's
outer-wall proxy that proxy only), and it is the one place outside the agent's sandbox that holds the job credential.

```
claim: implementer.mcp = [{id, name, transport}], unavailable        (worker announces implementer_mcp)
job host (Worker, holds crj_…) ──stdin of the job process: mcpAccess {appUrl, jobId, credential}──▶ Control (job process)
Control ──stdin of the MCP door container: start document {…, credential, servers}──▶ door (mcpdoor/service.py)
agent harness ──http://10.213.77.5:3129/mcp/<server id>──▶ door ──POST|DELETE /api/workers/v1/jobs/{job}/mcp/{server id} (Bearer crj_…)──▶ app
```

**How the credential is kept from the agent.** It travels on stdin only: the Worker puts it into the job process's stdin (as it does the git token and the
environment-control token), Control writes it to the door's stdin, and the door keeps it in memory. It is in no argument, no environment variable, no file,
no mount and no label of any container, so neither `docker inspect`, nor the door's process list, nor the agent's environment, files, `ps` or
`/proc/*/{cmdline,environ}` shows it; the agent's container shares no namespace and no volume with the door and reaches it only through the one port.
The harness files (OpenCode `mcp`, Claude Code `--mcp-config`) hold the local endpoint URLs and nothing else: no header, no token, no address of a real
server. Tests: `test_mcp_door_service.py` (a real door process; greps its `/proc` files, `ps`, its temp files, its output), `test_mcp_door_launcher.py`
(no request to the daemon holds it), `test_implementer_mcp.py` (neither harness's configuration, argument list or environment holds it; the agent's
container definition does not change but for the proxy exemption).

**What the door does** (`mcpdoor/relay.py`), and nothing else:

- A path other than `/mcp/<server id of the step>` is `404 mcp_server_unavailable`, with no request to the app. `GET` is `405` (as the app answers).
- It forwards the JSON-RPC message (at most 256 KiB), `Mcp-Session-Id` and `MCP-Protocol-Version` (each a plain token, else `400`), and nothing else
  (the agent's `Authorization`, cookies and any other header are dropped); it relays back the status, the content type, `Mcp-Session-Id` and the body
  (an event stream as it arrives; when the agent lets go, the request to the app ends with it). No `Retry-After` goes back to the agent: the door has
  retried once itself.
- **Never an automatic retry of a `503`** (the door's own `503 mcp_proxy_unreachable` for a connection that failed is not repeated either). The only
  retry is a `429 mcp_too_many_concurrent_calls` with `Retry-After` (the call was not made): once, after the wait (at most 5 s). `429 mcp_call_limit_reached`
  and every other status pass as they are.
- **Sessions end with the step.** The door remembers every `Mcp-Session-Id` the app handed out; when the step ends (success, failure, cancel: Control
  stops it after the agent's container is gone, and the end of its stdin does the same if Control dies) it sends a `DELETE` for each one the agent did not
  end itself, at most 3 at a time (the app allows 4 calls of a job at once; a `429 mcp_too_many_concurrent_calls` is asked once more, like any call;
  5 s each, 8 s all), says how many it ended, drops the credential and exits. Only a `2xx`, `404` or `405` ends a session: any other answer (a `409`
  after a cancel, a `5xx`, a broken connection) leaves it open, and so is a session beyond the 64 the door tracks. All of these are `sessionsLeft` of
  the final status and a note of the run; the server's own timeout ends them. The agent's own `DELETE` stops the tracking only on the same statuses.
- **Sockets are bounded.** An idle or slow connection is closed after 30 s, at most 32 connections are served at once (one more is `429
mcp_too_many_concurrent_calls` and closed), a body that is not a plain length is `400`, and an answer of the app that breaks off is a `503`, never
  an empty `200`.

**The sandbox's network rule is not changed.** The agent reaches the door like it reaches the model door; the door's address is added to the agent's
`NO_PROXY` only for a turn that has the door, so the network door never sees it. A turn without MCP servers is exactly what it was (the same container
definition, environment and configuration; tests hold it).

**Harness configuration** (`mcp_config.py`; a key is the server's name as a plain token `[A-Za-z0-9_-]`, unique, never `finish` and never a name that could build the name of a built-in tool or permission, such as `finish_submit` or `doom`, which get a number):

| Harness     | Where                                                  | Entry                                                                  | Tool names           |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------- |
| OpenCode    | `mcp` in `/etc/code-reviewer/opencode.json` (hosted)   | `{type: "remote", url: <door>/mcp/<id>, oauth: false, timeout: 30000}` | `<key>_<tool>`       |
| Claude Code | `--mcp-config` (`mcpServers`, next to the finish tool) | `{type: "http", url: <door>/mcp/<id>}`                                 | `mcp__<key>__<tool>` |

OpenCode's default-deny permission gets `<key>_*: allow` for the servers of the step only; Claude Code runs with `bypassPermissions` and `--strict-mcp-config`.

**Notes of the run.** `implementer.mcp.unavailable > 0` is the note "N MCP servers of this lane are no longer available; the step runs without them"; a door
that cannot be started, a job that holds no access and a runner without a door are notes too ("… could not be reached …", "… holds no access", "… not
available on this runner yet"): none of them fails the turn.

**Not here.** The door's egress is the shared table (DNS and port 443 of public addresses), not the app's address alone: the app's address is a name behind a CDN, which an `nft` table cannot pin; narrowing it (a resolved set, or the host's proxy for the app) is a follow-up. The Incus backend (instance A holds the door, a port through the inner wall, `no_proxy`) is #1068: its placement has no MCP door yet, so a
turn there runs without MCP tools and says so (`Placement.mcp_supported`). The door's code (`mcpdoor/`) takes the bind address as an argument for it.
