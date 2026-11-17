// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import { startMcpFake, type McpFake } from "../../../fakes/mcp/server.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import type { McpCallRecord } from "../db/repositories/job-mcp-calls-repository.ts";
import {
  createMcpCredentials,
  oauthCredentialProvider,
} from "./credentials.ts";
import type { McpCredentials } from "./credentials.ts";
import { SecretValue } from "../secrets/secret-value.ts";
import { createJobMcp, type JobMcpDeps, type McpJob } from "./job-proxy.ts";
import { createMcpProxy, type McpCallMeta } from "./proxy.ts";
import { sealHeaders } from "./service.ts";

const fakes: McpFake[] = [];
async function fake(...args: Parameters<typeof startMcpFake>) {
  const started = await startMcpFake(...args);
  fakes.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((started) => started.close()));
});

const APP_SECRET = "s".repeat(40);
const SECRET = "Bearer dummy-job-secret";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GONE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_WORKSPACE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const job: McpJob = { id: "job-1", workspaceId: "w1" };

function row(id: string, name: string, url: string): StoredMcpServer {
  return {
    id,
    workspaceId: "w1",
    name,
    transport: "streamable-http",
    url,
    authKind: "header",
    headerNames: ["Authorization"],
    revision: 1,
    testStatus: "ok",
    testedAt: null,
    testErrorCode: null,
    snapshot: null,
    createdBy: null,
    createdAt: "2026-11-17T10:00:00Z",
    updatedAt: "2026-11-17T10:00:00Z",
  };
}

/** A run whose lane names `ids`; the agent step `review` narrows to `stepIds` (left out: all of the lane's). */
function deps(options: {
  servers: StoredMcpServer[];
  lane: string[];
  stepIds?: string[];
  hasStep?: boolean;
  calls?: McpCallMeta[];
  /** Every read of the table of servers, by kind and id. */
  reads?: string[];
  lines?: string[];
  credentials?: McpCredentials;
  /** #1055: what is recorded for the run's trace outside the proxy (a refusal before the proxy). */
  recorded?: McpCallRecord[];
}): JobMcpDeps {
  const document = JSON.stringify({
    name: "Lane",
    mcp: options.lane,
    steps: [
      {
        id: "review",
        kind: "agent",
        ...(options.stepIds === undefined ? {} : { mcp: options.stepIds }),
      },
    ],
  });
  return {
    workflowRuns: {
      findStepByJob: (jobId) =>
        Promise.resolve(
          options.hasStep === false || jobId !== job.id
            ? undefined
            : ({ runId: "run-1", stepId: "review" } as never),
        ),
      getRun: () =>
        Promise.resolve({ workflowId: "wf-1", workflowVersion: 3 } as never),
    },
    workflows: {
      getVersion: () => Promise.resolve({ document } as never),
    },
    // The repository is scoped to the job's workspace: another workspace's rows are not in it.
    mcpServers: {
      get: (id) => {
        options.reads?.push(`get ${id}`);
        return Promise.resolve(
          options.servers.find((entry) => entry.id === id),
        );
      },
      readHeaders: (id) => {
        options.reads?.push(`readHeaders ${id}`);
        const server = options.servers.find((entry) => entry.id === id);
        return Promise.resolve(
          server === undefined
            ? undefined
            : {
                server,
                sealed:
                  server.authKind === "header"
                    ? sealHeaders(APP_SECRET, server.id, [
                        { name: "Authorization", value: SECRET },
                      ])
                    : null,
              },
        );
      },
    },
    credentials:
      options.credentials ?? createMcpCredentials({ appSecret: APP_SECRET }),
    log: (line) => options.lines?.push(line),
    recordCall: (_jobId, record) => options.recorded?.push(record),
    proxy: createMcpProxy({
      fetch: createGuardedFetch({ allowLoopback: true }),
      allowTestEndpoints: true,
      deadlineMs: 5000,
      onCall: (meta) => options.calls?.push(meta),
    }),
  };
}

const call = (method: string, id: number, params?: unknown) => ({
  method: "POST" as const,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  }),
  sessionId: null,
  protocolVersion: null,
});

describe("the MCP servers of a job", () => {
  it("are the effective list of its agent step, resolved in the job's workspace", async () => {
    const servers = [
      row(A, "Issues", "https://a.example.com/mcp"),
      row(B, "Docs", "https://b.example.com/mcp"),
    ];
    const lane = await createJobMcp(deps({ servers, lane: [A, B] })).serversOf(
      job,
    );
    expect(lane.servers.map((server) => server.id)).toEqual([A, B]);
    expect(lane.unavailable).toBe(0);

    const narrowed = await createJobMcp(
      deps({ servers, lane: [A, B], stepIds: [B] }),
    ).serversOf(job);
    expect(narrowed.servers.map((server) => server.id)).toEqual([B]);

    const none = await createJobMcp(
      deps({ servers, lane: [A, B], stepIds: [] }),
    ).serversOf(job);
    expect(none).toEqual({ servers: [], unavailable: 0 });
  });

  it("tolerate a server that was removed: the step runs without it and the count says so", async () => {
    const servers = [row(A, "Issues", "https://a.example.com/mcp")];
    const result = await createJobMcp(
      deps({ servers, lane: [A, GONE] }),
    ).serversOf(job);
    expect(result.servers.map((server) => server.id)).toEqual([A]);
    expect(result.unavailable).toBe(1);
  });

  it("never come from another workspace: an id the workspace does not hold is unavailable, whatever exists elsewhere", async () => {
    // The scoped repository holds the rows of w1 only; the id of another workspace's server is simply not there.
    const result = await createJobMcp(
      deps({ servers: [], lane: [OTHER_WORKSPACE] }),
    ).serversOf(job);
    expect(result).toEqual({ servers: [], unavailable: 1 });
  });

  it("are none for a job that no workflow step started, and for a lane without servers", async () => {
    const servers = [row(A, "Issues", "https://a.example.com/mcp")];
    expect(
      await createJobMcp(
        deps({ servers, lane: [A], hasStep: false }),
      ).serversOf(job),
    ).toEqual({ servers: [], unavailable: 0 });
    expect(
      await createJobMcp(deps({ servers, lane: [] })).serversOf(job),
    ).toEqual({ servers: [], unavailable: 0 });
  });
});

describe("a call of the agent for a server of its job", () => {
  // #1067-T04: the OAuth provider of #1051 is registered, so a server of kind oauth works through the proxy.
  it("reaches an OAuth server with the fresh token of the OAuth provider, and a broken connection is mcp_credential_broken", async () => {
    const server = await fake({
      requiredHeaders: { authorization: "Bearer fresh-oauth-token" },
    });
    const oauthRow = {
      ...row(A, "Issues", server.url),
      authKind: "oauth" as const,
      headerNames: [],
    };
    const credentials = (broken: boolean) =>
      createMcpCredentials({
        appSecret: APP_SECRET,
        providers: {
          oauth: oauthCredentialProvider({
            use: () =>
              Promise.resolve(
                broken
                  ? { ok: false, error: "mcp_oauth_broken" as const }
                  : {
                      ok: true,
                      accessToken: new SecretValue("fresh-oauth-token"),
                    },
              ),
          }),
        },
      });

    const ok = await createJobMcp(
      deps({
        servers: [oauthRow],
        lane: [A],
        credentials: credentials(false),
      }),
    ).handle(job, A, call("tools/list", 1));
    expect(ok.status).toBe(200);
    expect(server.sawHeader("authorization", "Bearer fresh-oauth-token")).toBe(
      true,
    );

    const requestsBefore = server.requests().length;
    const refused = await createJobMcp(
      deps({
        servers: [oauthRow],
        lane: [A],
        credentials: credentials(true),
      }),
    ).handle(job, A, call("tools/list", 2));
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain("mcp_credential_broken");
    expect(server.requests().length, "the server was not called").toBe(
      requestsBefore,
    );
  });

  it("reaches the server with the credential of the server", async () => {
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const calls: McpCallMeta[] = [];
    const response = await createJobMcp(
      deps({ servers: [row(A, "Issues", server.url)], lane: [A], calls }),
    ).handle(job, A, call("tools/list", 1));
    expect(response.status).toBe(200);
    expect(server.sawHeader("authorization", SECRET)).toBe(true);
    expect(calls[0]).toMatchObject({
      jobId: job.id,
      serverId: A,
      rpcMethod: "tools/list",
    });
  });

  it("is refused for a server the step may not use, one that does not exist, and a lane that names none: the same answer", async () => {
    const server = await fake();
    const servers = [row(A, "Issues", server.url), row(B, "Docs", server.url)];
    const answers = await Promise.all([
      // B exists in the workspace but the step narrows to A.
      createJobMcp(deps({ servers, lane: [A, B], stepIds: [A] })).handle(
        job,
        B,
        call("tools/list", 1),
      ),
      // GONE does not exist.
      createJobMcp(deps({ servers, lane: [A, GONE] })).handle(
        job,
        GONE,
        call("tools/list", 1),
      ),
      // The lane names nothing.
      createJobMcp(deps({ servers, lane: [] })).handle(
        job,
        A,
        call("tools/list", 1),
      ),
    ]);
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(JSON.parse(await answer.text())).toMatchObject({
        error: { message: "mcp_server_unavailable" },
      });
    }
    expect(server.requests()).toEqual([]);
  });

  it("answers a broken credential with its code and does not call the server", async () => {
    const server = await fake();
    const broken = deps({ servers: [row(A, "Issues", server.url)], lane: [A] });
    const result = await createJobMcp({
      ...broken,
      credentials: createMcpCredentials({ appSecret: "x".repeat(40) }),
    }).handle(job, A, call("tools/list", 1));
    expect(result.status).toBe(503);
    expect(JSON.parse(await result.text())).toMatchObject({
      error: { message: "mcp_credential_broken" },
    });
    expect(server.requests()).toEqual([]);
  });
});

describe("what a call costs the database and what a refusal leaves in the log", () => {
  // #1053-T10
  it("reads one row for each server of the step at the claim, never the whole table", async () => {
    const reads: string[] = [];
    const servers = [
      row(A, "Issues", "https://a.example.com/mcp"),
      row(B, "Docs", "https://b.example.com/mcp"),
    ];
    await createJobMcp(
      deps({ servers, lane: [A, B], stepIds: [B], reads }),
    ).serversOf(job);
    expect(reads).toEqual([`get ${B}`]);
  });

  it("reads the credential of the called server only, and nothing at all for a server the step does not name", async () => {
    const server = await fake();
    const reads: string[] = [];
    const servers = [row(A, "Issues", server.url), row(B, "Docs", server.url)];
    const mcp = createJobMcp(
      deps({ servers, lane: [A, B], stepIds: [A], reads }),
    );
    expect((await mcp.handle(job, A, call("tools/list", 1))).status).toBe(200);
    expect(reads).toEqual([`readHeaders ${A}`]);
    reads.length = 0;
    expect((await mcp.handle(job, B, call("tools/list", 2))).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it("answers a GET with 405 before the lane is read and before a credential is opened", async () => {
    const reads: string[] = [];
    const lane = deps({
      servers: [row(A, "Issues", "https://a.example.com/mcp")],
      lane: [A],
      reads,
    });
    let asked = 0;
    const mcp = createJobMcp({
      ...lane,
      workflowRuns: {
        ...lane.workflowRuns,
        findStepByJob: (...args) => {
          asked++;
          return lane.workflowRuns.findStepByJob(...args);
        },
      },
    });
    const answer = await mcp.handle(job, A, {
      method: "GET",
      body: null,
      sessionId: null,
      protocolVersion: null,
    });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST, DELETE");
    expect(reads).toEqual([]);
    expect(asked).toBe(0);
  });

  // #1053-T11
  it("refuses a server that was removed while the run is going, at the call: the lane still names it, the workspace no longer holds it", async () => {
    const server = await fake();
    const servers = [row(A, "Issues", server.url)];
    const mcp = createJobMcp(deps({ servers, lane: [A] }));
    expect((await mcp.handle(job, A, call("tools/list", 1))).status).toBe(200);
    const before = server.requests().length;
    servers.splice(0); // removed in the registry
    const answer = await mcp.handle(job, A, call("tools/list", 2));
    expect(answer.status).toBe(404);
    expect(JSON.parse(await answer.text())).toMatchObject({
      error: { message: "mcp_server_unavailable" },
    });
    expect(server.requests()).toHaveLength(before);
  });

  // #1053-T12
  it("logs each refusal before the proxy with the job, the server id and the code, and no value", async () => {
    const server = await fake();
    const lines: string[] = [];
    const servers = [row(A, "Issues", server.url)];
    const broken = deps({ servers, lane: [A], lines });
    await createJobMcp(broken).handle(job, GONE, call("tools/list", 1));
    await createJobMcp({
      ...broken,
      credentials: createMcpCredentials({ appSecret: "x".repeat(40) }),
    }).handle(job, A, call("tools/list", 2));
    await createJobMcp(broken).handle(job, "../etc/passwd", call("x", 3));
    expect(lines).toEqual([
      `[mcp-proxy] job=job-1 server=${GONE} refused: mcp_server_unavailable`,
      `[mcp-proxy] job=job-1 server=${A} refused: mcp_credential_broken`,
      "[mcp-proxy] job=job-1 server=- refused: mcp_server_unavailable",
    ]);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(server.url);
  });
});

// #1055-T06: a refusal before the proxy is recorded for the run's trace as such, with the status and the code the agent's side got.
describe("what a refusal before the proxy leaves in the run's trace", () => {
  const rpcCall = (name: string) =>
    call("tools/call", 1, { name, arguments: { needle: "secret-argument" } });

  it("records a server the step may not use (404) with the tool that was asked for, and no argument", async () => {
    const recorded: McpCallRecord[] = [];
    const mcp = createJobMcp(
      deps({
        servers: [row(A, "Issues", "https://a.example.com/mcp")],
        lane: [A],
        recorded,
      }),
    );
    const answer = await mcp.handle(job, GONE, rpcCall("get_issue"));
    expect(answer.status).toBe(404);
    expect(recorded).toEqual([
      {
        serverId: GONE,
        serverName: "",
        rpcMethod: "tools/call",
        tool: "get_issue",
        status: 404,
        outcome: "mcp_server_unavailable",
        durationMs: 0,
        requestBytes: expect.any(Number),
        responseBytes: 0,
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("secret-argument");
  });

  it("records a broken credential (503) with the name of the server, and the server is not called", async () => {
    const server = await fake();
    const recorded: McpCallRecord[] = [];
    const broken = deps({
      servers: [row(A, "Issues", server.url)],
      lane: [A],
      recorded,
    });
    const answer = await createJobMcp({
      ...broken,
      credentials: createMcpCredentials({ appSecret: "x".repeat(40) }),
    }).handle(job, A, rpcCall("get_issue"));
    expect(answer.status).toBe(503);
    expect(recorded).toMatchObject([
      {
        serverId: A,
        serverName: "Issues",
        tool: "get_issue",
        status: 503,
        outcome: "mcp_credential_broken",
      },
    ]);
    expect(server.requests()).toEqual([]);
  });

  it("records a refusal of the route (a limit) through `refused`, once, with the code and its status", async () => {
    const recorded: McpCallRecord[] = [];
    const mcp = createJobMcp(
      deps({
        servers: [row(A, "Issues", "https://a.example.com/mcp")],
        lane: [A],
        recorded,
      }),
    );
    mcp.refused(job, A, "mcp_call_limit_reached", rpcCall("get_issue").body);
    mcp.refused(job, A, "mcp_too_many_concurrent_calls", null);
    expect(recorded).toMatchObject([
      { status: 429, outcome: "mcp_call_limit_reached", tool: "get_issue" },
      { status: 429, outcome: "mcp_too_many_concurrent_calls", tool: null },
    ]);
  });

  it("does not record a call the route did not count as one: a GET and a server id that is not one", async () => {
    const recorded: McpCallRecord[] = [];
    const mcp = createJobMcp(
      deps({
        servers: [row(A, "Issues", "https://a.example.com/mcp")],
        lane: [A],
        recorded,
      }),
    );
    await mcp.handle(job, A, {
      method: "GET",
      body: null,
      sessionId: null,
      protocolVersion: null,
    });
    mcp.refused(job, "../not-an-id", "mcp_server_unavailable", null);
    expect(recorded).toEqual([]);
  });
});
