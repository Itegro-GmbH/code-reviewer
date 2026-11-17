// SPDX-License-Identifier: LicenseRef-Proprietary

// The Worker API's MCP route (#1053): who may call, what of the request goes on, what comes back. The proxy itself is tested in
// `mcp/proxy.test.ts`; here it is a recorder, so the test sees exactly what the route handed over.
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import {
  newWorkerCredential,
  workerLeaseToken,
} from "../jobs/worker-credential.ts";
import {
  MCP_MAX_CALLS_PER_CLAIM,
  createInFlightGate,
} from "../mcp/in-flight.ts";
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
    /** What `countMcpCall` answers; default `counted`. */
    counted?: "counted" | "exhausted" | "not_holder";
    /** What the runtime answers; default a plain 200. */
    answer?: () => Promise<Response>;
    maxConcurrent?: number;
  } = {},
) {
  const holds: { opened: number; ended: number } = { opened: 0, ended: 0 };
  const counts: { jobId: string; limit: number }[] = [];
  const lines: string[] = [];
  const gate = createInFlightGate(options.maxConcurrent);
  const handled: {
    jobId: string;
    serverId: string;
    request: McpProxyRequest;
  }[] = [];
  const workspaces: string[] = [];
  const refusals: { serverId: string; code: string; body: string | null }[] =
    [];
  const job = {
    id: "22222222-2222-4222-8222-222222222222",
    workspaceId: "w1",
    status: options.status ?? "running",
  } as unknown as Job;
  const deps = {
    queue: {
      // The real semantics: the token belongs to ONE job, and only that job is found with it.
      holding: (id: string, lease: string) =>
        Promise.resolve(
          options.holding === false ||
            id !== job.id ||
            lease !== workerLeaseToken(credential)
            ? undefined
            : job,
        ),
      countMcpCall: (id: string, _lease: string, limit: number) => {
        counts.push({ jobId: id, limit });
        return Promise.resolve(options.counted ?? "counted");
      },
    },
    mcpInFlight: gate,
    logger: {
      info: (line: string) => lines.push(line),
      error: () => {},
    },
    ...(options.runtime === false
      ? {}
      : {
          jobMcp: (workspaceId: string) => {
            workspaces.push(workspaceId);
            return {
              serversOf: () => Promise.resolve({ servers: [], unavailable: 0 }),
              refused: (
                _job: unknown,
                serverId: string,
                code: string,
                body: string | null,
              ) => {
                refusals.push({ serverId, code, body });
              },
              holdOpen: () => {
                holds.opened += 1;
                return () => {
                  holds.ended += 1;
                };
              },
              handle: (
                handledJob: { id: string },
                serverId: string,
                request: McpProxyRequest,
              ) => {
                handled.push({ jobId: handledJob.id, serverId, request });
                return (
                  options.answer?.() ??
                  Promise.resolve(new Response('{"ok":true}', { status: 200 }))
                );
              },
            };
          },
        }),
  } as unknown as WorkerApiDeps;
  return {
    api: createWorkerApi(deps),
    handled,
    workspaces,
    refusals,
    job,
    counts,
    lines,
    gate,
    holds,
  };
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

  it("passes a DELETE on without a body, and answers a GET and any other method with 405 before anything is looked up or counted", async () => {
    const { api, handled, job, counts, workspaces } = setup();
    await api.mcp(authorized({ method: "DELETE" }), job.id, SERVER);
    expect(
      handled.map((entry) => [entry.request.method, entry.request.body]),
    ).toEqual([["DELETE", null]]);
    for (const method of ["GET", "PUT"]) {
      const answer = await api.mcp(
        authorized({ method, ...(method === "PUT" ? { body: "{}" } : {}) }),
        job.id,
        SERVER,
      );
      expect(answer.status).toBe(405);
      expect(answer.headers.get("allow")).toBe("POST, DELETE");
    }
    // Only the DELETE reached the runtime; a DELETE is not counted against the cap.
    expect(handled).toHaveLength(1);
    expect(counts).toHaveLength(0);
    expect(workspaces).toHaveLength(1);
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

  it("answers a body that is too large with a JSON-RPC shaped 413 and does not hand it on", async () => {
    const { api, handled, job } = setup();
    const response = await api.mcp(
      authorized({ method: "POST", body: "x".repeat(300_000) }),
      job.id,
      SERVER,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "mcp_proxy_request_too_large" },
    });
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

describe("the credential of one job cannot reach another job's servers", () => {
  const JOB_A = "22222222-2222-4222-8222-222222222222";
  const JOB_B = "33333333-3333-4333-8333-333333333333";
  const credentialA = newWorkerCredential();
  const credentialB = newWorkerCredential();

  function twoJobs() {
    const handled: string[] = [];
    const jobs = new Map<string, { job: Job; credential: string }>([
      [
        JOB_A,
        {
          job: { id: JOB_A, workspaceId: "w1", status: "running" } as Job,
          credential: credentialA,
        },
      ],
      [
        JOB_B,
        {
          job: { id: JOB_B, workspaceId: "w2", status: "running" } as Job,
          credential: credentialB,
        },
      ],
    ]);
    const deps = {
      queue: {
        // The real `holding`: the lease token must be the one of THE job asked for.
        holding: (id: string, lease: string) => {
          const entry = jobs.get(id);
          return Promise.resolve(
            entry !== undefined && workerLeaseToken(entry.credential) === lease
              ? entry.job
              : undefined,
          );
        },
        countMcpCall: () => Promise.resolve("counted" as const),
      },
      mcpInFlight: createInFlightGate(),
      logger: { info: () => {}, error: () => {} },
      jobMcp: () => ({
        serversOf: () => Promise.resolve({ servers: [], unavailable: 0 }),
        refused: () => {},
        holdOpen: () => () => {},
        handle: (handledJob: { id: string }) => {
          handled.push(handledJob.id);
          return Promise.resolve(new Response("{}", { status: 200 }));
        },
      }),
    } as unknown as WorkerApiDeps;
    return { api: createWorkerApi(deps), handled };
  }

  const callOf = (jobId: string, bearer: string) =>
    new Request(
      `https://app.example.com/api/workers/v1/jobs/${jobId}/mcp/${SERVER}`,
      {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${bearer}` },
      },
    );

  it("answers 401 for the credential of job A on the path of job B, and the runtime is never asked", async () => {
    const { api, handled } = twoJobs();
    expect(
      (await api.mcp(callOf(JOB_B, credentialA), JOB_B, SERVER)).status,
    ).toBe(401);
    expect(
      (await api.mcp(callOf(JOB_A, credentialB), JOB_A, SERVER)).status,
    ).toBe(401);
    expect(handled).toEqual([]);
    // Each job reaches its own.
    expect(
      (await api.mcp(callOf(JOB_A, credentialA), JOB_A, SERVER)).status,
    ).toBe(200);
    expect(
      (await api.mcp(callOf(JOB_B, credentialB), JOB_B, SERVER)).status,
    ).toBe(200);
    expect(handled).toEqual([JOB_A, JOB_B]);
  });
});

describe("the limits of the MCP route", () => {
  const post = () => authorized({ method: "POST", body: "{}" });

  // #1053-T04
  it("counts every call against the claim and refuses past the cap with a stable code, a 429 and no call of the runtime", async () => {
    const { api, job, handled, counts, lines } = setup({
      counted: "exhausted",
    });
    const answer = await api.mcp(post(), job.id, SERVER);
    expect(answer.status).toBe(429);
    expect(await answer.json()).toMatchObject({
      error: { message: "mcp_call_limit_reached" },
    });
    expect(handled).toEqual([]);
    expect(counts).toEqual([{ jobId: job.id, limit: MCP_MAX_CALLS_PER_CLAIM }]);
    expect(lines.join("\n")).toContain(`job=${job.id}`);
    expect(lines.join("\n")).toContain("mcp_call_limit_reached");
  });

  // #1055-T06
  it("hands each refusal of a limit to the runtime for the run's trace, with the server and the code", async () => {
    const exhausted = setup({ counted: "exhausted" });
    await exhausted.api.mcp(post(), exhausted.job.id, SERVER);
    expect(exhausted.refusals).toEqual([
      { serverId: SERVER, code: "mcp_call_limit_reached", body: null },
    ]);

    const busy = setup({ maxConcurrent: 1 });
    busy.gate.enter(busy.job.id);
    await busy.api.mcp(post(), busy.job.id, SERVER);
    expect(busy.refusals).toEqual([
      { serverId: SERVER, code: "mcp_too_many_concurrent_calls", body: null },
    ]);
  });

  it("counts a call that is allowed, and a claim that ended since the credential was checked is 409", async () => {
    const counted = setup();
    expect((await counted.api.mcp(post(), counted.job.id, SERVER)).status).toBe(
      200,
    );
    expect(counted.counts).toHaveLength(1);
    const lost = setup({ counted: "not_holder" });
    expect((await lost.api.mcp(post(), lost.job.id, SERVER)).status).toBe(409);
    expect(lost.handled).toEqual([]);
  });

  // #1067 review: the door ends every open session with a DELETE at the end of the step; that must work with the cap used up.
  it("does not count a DELETE of a session against the cap of the claim, so a step whose cap is used up can still end its sessions", async () => {
    const { api, job, handled, counts } = setup({ counted: "exhausted" });
    const answer = await api.mcp(
      authorized({ method: "DELETE", headers: { "mcp-session-id": "s-1" } }),
      job.id,
      SERVER,
    );
    expect(answer.status).toBe(200);
    expect(counts).toEqual([]);
    expect(handled.map((call) => call.request.method)).toEqual(["DELETE"]);
  });

  it("still gates a DELETE by the places of the job, and still refuses it for a claim that ended", async () => {
    const full = setup({ maxConcurrent: 0 });
    const refused = await full.api.mcp(
      authorized({ method: "DELETE", headers: { "mcp-session-id": "s-1" } }),
      full.job.id,
      SERVER,
    );
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      error: { message: "mcp_too_many_concurrent_calls" },
    });
    expect(full.handled).toEqual([]);
    // #1055: the refusal of the door's DELETE is a row of the run's trace like any other refusal.
    expect(full.refusals.map((entry) => entry.code)).toEqual([
      "mcp_too_many_concurrent_calls",
    ]);

    const ended = setup({ status: "cancelled" });
    const gone = await ended.api.mcp(
      authorized({ method: "DELETE", headers: { "mcp-session-id": "s-1" } }),
      ended.job.id,
      SERVER,
    );
    expect(gone.status).toBe(409);
    expect(ended.handled).toEqual([]);
  });

  it("does not count a call that is refused before (wrong credential, ended job, 405)", async () => {
    const { api, job, counts } = setup({ status: "succeeded" });
    await api.mcp(post(), job.id, SERVER);
    await api.mcp(authorized({ method: "GET" }), job.id, SERVER);
    expect(counts).toEqual([]);
  });

  it("refuses a call while the job has all its places taken, with a 429 and a code that says to try again, and gives the place back when the answer is over", async () => {
    let finish: (() => void) | undefined;
    const slow = () =>
      new Promise<Response>((resolve) => {
        finish = () => resolve(new Response("{}", { status: 200 }));
      });
    const { api, job, handled, counts, gate } = setup({
      maxConcurrent: 1,
      answer: slow,
    });
    const first = api.mcp(post(), job.id, SERVER);
    await vi.waitFor(() => expect(handled).toHaveLength(1));
    expect(gate.inFlight(job.id)).toBe(1);
    const second = await api.mcp(post(), job.id, SERVER);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(await second.json()).toMatchObject({
      error: { message: "mcp_too_many_concurrent_calls" },
    });
    // The refused call was neither counted nor handed on.
    expect(counts).toHaveLength(1);
    expect(handled).toHaveLength(1);
    finish?.();
    expect((await first).status).toBe(200);
    expect(gate.inFlight(job.id)).toBe(0);
  });

  it("keeps the place of an event stream answer until the stream has ended, and gives it back when the consumer goes away", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streaming = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const { api, job, gate } = setup({ answer: streaming });
    const response = await api.mcp(post(), job.id, SERVER);
    expect(response.status).toBe(200);
    expect(gate.inFlight(job.id)).toBe(1);
    await response.body?.cancel();
    await vi.waitFor(() => expect(gate.inFlight(job.id)).toBe(0));

    const second = await api.mcp(post(), job.id, SERVER);
    expect(gate.inFlight(job.id)).toBe(1);
    controller?.enqueue(new TextEncoder().encode("data: x\n\n"));
    controller?.close();
    await second.text();
    await vi.waitFor(() => expect(gate.inFlight(job.id)).toBe(0));
  });

  // #1055-T01: the record of an event stream call is written when the stream ends, after the handler has returned
  it("keeps the function alive for the record of an event stream call: registered before the response goes out, let go when the stream has ended", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const streaming = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const { api, job, holds } = setup({ answer: streaming });

    const response = await api.mcp(post(), job.id, SERVER);

    expect(holds).toEqual({ opened: 1, ended: 0 });
    controller?.enqueue(new TextEncoder().encode("data: x\n\n"));
    controller?.close();
    await response.text();
    await vi.waitFor(() => expect(holds.ended).toBe(1));
  });

  // #1055-T01
  it("lets go of the hold when the consumer cancels the stream, after the stream behind it has been let go of", async () => {
    const order: string[] = [];
    const streaming = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              order.push("stream cancelled");
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const { api, job, holds } = setup({ answer: streaming });
    const response = await api.mcp(post(), job.id, SERVER);

    await response.body?.cancel();

    await vi.waitFor(() => expect(holds.ended).toBe(1));
    expect(order).toEqual(["stream cancelled"]);
  });

  // #1055-T01
  it("holds nothing for an answer that is already complete", async () => {
    const { api, job, holds } = setup();

    await api.mcp(post(), job.id, SERVER);

    expect(holds).toEqual({ opened: 0, ended: 0 });
  });

  it("gives the place back when the runtime fails", async () => {
    const { api, job, gate } = setup({
      answer: () => Promise.reject(new Error("boom")),
    });
    expect((await api.mcp(post(), job.id, SERVER)).status).toBe(500);
    expect(gate.inFlight(job.id)).toBe(0);
  });

  it("logs a refusal before the proxy with the job and the code, never a value", async () => {
    const { api, job, lines } = setup({ runtime: false });
    await api.mcp(post(), job.id, SERVER);
    const text = lines.join("\n");
    expect(text).toContain(`job=${job.id}`);
    expect(text).toContain("mcp_server_unavailable");
    expect(text).not.toContain(credential);
  });
});
