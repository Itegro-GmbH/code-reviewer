// SPDX-License-Identifier: LicenseRef-Proprietary

// The Worker API's MCP route (#1053): who may call, what of the request goes on, what comes back. The proxy itself is tested in
// `mcp/proxy.test.ts`; here it is a recorder, so the test sees exactly what the route handed over.
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import {
  newWorkerCredential,
  workerLeaseToken,
} from "../jobs/worker-credential.ts";
import type { McpProxyRequest } from "../mcp/proxy.ts";
import { createWorkerApi, type WorkerApiDeps } from "./worker-api.ts";

vi.mock("server-only", () => ({}));

const SERVER = "11111111-1111-4111-8111-111111111111";
const credential = newWorkerCredential();

function setup(
  options: {
    status?: Job["status"];
    holding?: boolean;
    runtime?: boolean;
  } = {},
) {
  const handled: {
    jobId: string;
    serverId: string;
    request: McpProxyRequest;
  }[] = [];
  const workspaces: string[] = [];
  const job = {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: "w1",
    status: options.status ?? "running",
  } as unknown as Job;
  const deps = {
    queue: {
      holding: (_id: string, lease: string) =>
        Promise.resolve(
          options.holding === false || lease !== workerLeaseToken(credential)
            ? undefined
            : job,
        ),
    },
    logger: { info: () => {}, error: () => {} },
    ...(options.runtime === false
      ? {}
      : {
          jobMcp: (workspaceId: string) => {
            workspaces.push(workspaceId);
            return {
              serversOf: () => Promise.resolve({ servers: [], unavailable: 0 }),
              handle: (
                handledJob: { id: string },
                serverId: string,
                request: McpProxyRequest,
              ) => {
                handled.push({ jobId: handledJob.id, serverId, request });
                return Promise.resolve(
                  new Response('{"ok":true}', { status: 200 }),
                );
              },
            };
          },
        }),
  } as unknown as WorkerApiDeps;
  return { api: createWorkerApi(deps), handled, workspaces, job };
}

const url = `https://app.example.com/api/workers/v1/jobs/22222222-2222-4222-8222-222222222222/mcp/${SERVER}`;
const authorized = (init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { authorization: `Bearer ${credential}`, ...(init.headers ?? {}) },
  });

describe("the MCP route of the Worker API", () => {
  // #1053-T01
  it("hands the JSON-RPC message and the two MCP headers to the job's workspace, and nothing else of the request", async () => {
    const { api, handled, workspaces, job } = setup();
    const response = await api.mcp(
      authorized({
        method: "POST",
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        headers: {
          "mcp-session-id": "session-1",
          "mcp-protocol-version": "2025-06-18",
          cookie: "a=b",
          "x-forwarded-for": "10.0.0.1",
        },
      }),
      job.id,
      SERVER,
    );
    expect(response.status).toBe(200);
    expect(workspaces).toEqual(["w1"]);
    expect(handled).toEqual([
      {
        jobId: job.id,
        serverId: SERVER,
        request: {
          method: "POST",
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          sessionId: "session-1",
          protocolVersion: "2025-06-18",
        },
      },
    ]);
    // The request type has no field for a header, an address or the job's credential.
    expect(Object.keys(handled[0]!.request).sort()).toEqual([
      "body",
      "method",
      "protocolVersion",
      "sessionId",
    ]);
    expect(JSON.stringify(handled)).not.toContain(credential);
  });

  it("passes a DELETE and a GET on without a body, and refuses other methods with 405", async () => {
    const { api, handled, job } = setup();
    await api.mcp(authorized({ method: "DELETE" }), job.id, SERVER);
    await api.mcp(authorized({ method: "GET" }), job.id, SERVER);
    expect(
      handled.map((entry) => [entry.request.method, entry.request.body]),
    ).toEqual([
      ["DELETE", null],
      ["GET", null],
    ]);
    const put = await api.mcp(
      authorized({ method: "PUT", body: "{}" }),
      job.id,
      SERVER,
    );
    expect(put.status).toBe(405);
    expect(handled).toHaveLength(2);
  });

  it("needs the credential of a job that still holds its claim and runs: a replay after the run is refused", async () => {
    const none = setup();
    expect(
      (
        await none.api.mcp(
          new Request(url, { method: "POST", body: "{}" }),
          none.job.id,
          SERVER,
        )
      ).status,
    ).toBe(401);
    const wrong = setup();
    expect(
      (
        await wrong.api.mcp(
          new Request(url, {
            method: "POST",
            body: "{}",
            headers: { authorization: `Bearer ${newWorkerCredential()}` },
          }),
          wrong.job.id,
          SERVER,
        )
      ).status,
    ).toBe(401);
    // The claim is gone (the job was finished or taken back).
    const lost = setup({ holding: false });
    expect(
      (
        await lost.api.mcp(
          authorized({ method: "POST", body: "{}" }),
          lost.job.id,
          SERVER,
        )
      ).status,
    ).toBe(401);
    // The job ended: 409, and the proxy is not asked.
    const ended = setup({ status: "succeeded" });
    const answer = await ended.api.mcp(
      authorized({ method: "POST", body: "{}" }),
      ended.job.id,
      SERVER,
    );
    expect(answer.status).toBe(409);
    expect(ended.handled).toEqual([]);
  });

  it("answers a body that is too large with 413 and does not hand it on", async () => {
    const { api, handled, job } = setup();
    const response = await api.mcp(
      authorized({ method: "POST", body: "x".repeat(300_000) }),
      job.id,
      SERVER,
    );
    expect(response.status).toBe(413);
    expect(handled).toEqual([]);
  });

  it("answers a deployment without the MCP runtime and a path that is no server id the same way: 404 mcp_server_unavailable", async () => {
    const without = setup({ runtime: false });
    const bare = await without.api.mcp(
      authorized({ method: "POST", body: "{}" }),
      without.job.id,
      SERVER,
    );
    expect(bare.status).toBe(404);
    expect(await bare.json()).toMatchObject({
      error: { message: "mcp_server_unavailable" },
    });
    const { api, job, handled } = setup();
    const odd = await api.mcp(
      authorized({ method: "POST", body: "{}" }),
      job.id,
      "../../etc/passwd",
    );
    expect(odd.status).toBe(404);
    expect(handled).toEqual([]);
  });
});
