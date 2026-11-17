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

| Threat                                                                  | Answer                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agent reads the credential                                          | It is not there: not in the job (`ImplementerMcp` has id, name, transport only, a closed object; `contracts/runner-api.v1.json`), not in the harness configuration (the endpoint URLs only), not in the sandbox.                                     |
| The agent asks the proxy for another origin                             | It cannot name one. The call names a server id of the job; the address is the stored one. Nothing of the request but the JSON-RPC message, `Mcp-Session-Id` and `MCP-Protocol-Version` goes on (`runner-api/mcp-call.ts`, a test holds the key set). |
| The agent calls a server its step may not use, or another workspace's   | The id must be in the effective list of the job's step in the lane version of the run, looked up in the job's own workspace at the time of the call. Not there, removed, never existed, other workspace: one answer, `404 mcp_server_unavailable`.   |
| A redirect leads the credential away                                    | Only a redirect on the server's own origin is followed (at most 3); another origin is `mcp_proxy_redirect_refused` and the credential goes nowhere else. The endpoint a legacy SSE server names for its POSTs must be on the stream's origin.        |
| SSRF: the stored address points inside                                  | Checked as text when saved (#1050) and again at the call; at the connection the name is resolved once and every address must be public (guarded fetch). Plain http and loopback only behind the test flag.                                           |
| The server's `401`/`403` makes the agent's client start its own sign-in | Never passed on: `502 mcp_proxy_unauthorized`, no `WWW-Authenticate`.                                                                                                                                                                                |
| A slow or huge server ties the function up                              | One deadline (55 s), request cap 256 KiB, answer cap 4 MiB (an event stream ends with an error at the cap).                                                                                                                                          |
| Replay after the run                                                    | The job credential is only valid while the job holds its claim and runs (`worker-api.ts`); the server credential is never handed out.                                                                                                                |
| A secret in a log                                                       | `[mcp-proxy]` lines hold job, server id, method, tool name, status, outcome, duration and sizes: no argument, answer, header or address (`logMcpCall`, tested).                                                                                      |
| A broken credential (master key changed, kind without provider)         | `502 mcp_credential_broken` / `mcp_credential_unsupported`; the agent sees a tool error; the server is not called.                                                                                                                                   |

## Parts

| Part                                                                                      | Where                                                             | State     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| Credential providers (none, header; OAuth plugs in, #1051)                                | `app/src/mcp/credentials.ts`                                      | this PR   |
| The proxy (Streamable HTTP, legacy SSE adapter, limits, call metadata)                    | `app/src/mcp/proxy.ts`                                            | this PR   |
| Servers of a job (workspace-bound, tolerant of removed servers) and the call handler      | `app/src/mcp/job-proxy.ts`                                        | this PR   |
| `implementer.mcp` in the job, claim feature `implementer_mcp`                             | `app/src/runner-api/mcp-block.ts`, `contracts/runner-api.v1.json` | this PR   |
| Worker API route `POST/DELETE /api/workers/v1/jobs/{id}/mcp/{server}`                     | `app/src/runner-api/worker-api.ts`, `mcp-call.ts`                 | this PR   |
| Local endpoint at the hosted door, OpenCode and Claude Code configuration, the run's note | `runner/`                                                         | follow-up |
| The same at Incus instance A (and the endpoint through the inner wall)                    | `runner/…/incus/`                                                 | follow-up |

## Rules of the proxy

- **Removed servers.** A lane version a run is pinned to (retry, re-run) may name a server that was removed. The claim leaves it out and counts it
  (`implementer.mcp.unavailable`); the step runs without it and the runner shows a note. A call for it is `404 mcp_server_unavailable`. Nothing
  resolves across workspaces.
- **The endpoint is a Streamable HTTP server with no stream of its own.** `GET` is `405` (the specification allows it), so the agent's client
  makes one request and gets one answer.
- **Legacy SSE servers.** The proxy keeps no state between calls, so each call opens a short session: stream, endpoint, its own `initialize` and
  `initialized`, the call, the answer from the stream, close. The agent's own `initialized` is answered by the proxy. A server that keeps state
  across the calls of one session sees a new session each time.
- **Header authentication only today.** `createMcpCredentials({ providers: { oauth } })` is where OAuth tokens (#1051) plug in: the provider
  receives the server and returns the headers for this call, or `mcp_credential_broken` when the connection needs a new sign-in.
- **Per-call metadata** (`McpCallMeta`: job, server id, method, tool name, status, outcome, duration, sizes; never arguments or results) goes to
  `onCall`; today it is the log line, and #1055 hooks the live view and the trace in the same place.
- **A job that no workflow step started has no servers.** The claim sends `implementer.mcp` only to a Worker that named `implementer_mcp` and only
  for such a turn; for any other caller the turn runs without MCP tools (not refused: nothing widens).
