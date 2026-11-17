// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import { startMcpFake, type McpFake } from "../../../fakes/mcp/server.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import { createMcpCredentials } from "./credentials.ts";
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
      list: () => Promise.resolve(options.servers),
      readHeaders: (id) => {
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
    credentials: createMcpCredentials({ appSecret: APP_SECRET }),
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
