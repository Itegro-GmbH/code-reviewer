// SPDX-License-Identifier: LicenseRef-Proprietary

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpFake, type McpFake } from "../../../fakes/mcp/server.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import {
  createMcpProxy,
  type McpCallMeta,
  type McpProxyOptions,
  type McpProxyRequest,
} from "./proxy.ts";

const fakes: McpFake[] = [];
async function fake(...args: Parameters<typeof startMcpFake>) {
  const started = await startMcpFake(...args);
  fakes.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((started) => started.close()));
});

const SECRET = "Bearer dummy-proxy-secret-1";

function stored(
  url: string,
  transport: "streamable-http" | "sse" = "streamable-http",
): StoredMcpServer {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "w1",
    name: "Issues",
    transport,
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

function setup(overrides: Partial<McpProxyOptions> = {}) {
  const calls: McpCallMeta[] = [];
  const proxy = createMcpProxy({
    fetch: createGuardedFetch({ allowLoopback: true }),
    allowTestEndpoints: true,
    deadlineMs: 5000,
    onCall: (meta) => calls.push(meta),
    ...overrides,
  });
  return { proxy, calls };
}

const rpc = (method: string, id: number | null, params?: unknown) =>
  JSON.stringify({
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    ...(params === undefined ? {} : { params }),
  });

const post = (
  body: string,
  extra: Partial<Pick<McpProxyRequest, "sessionId" | "protocolVersion">> = {},
): McpProxyRequest => ({
  method: "POST",
  body,
  sessionId: null,
  protocolVersion: null,
  ...extra,
});

describe("the MCP proxy over Streamable HTTP", () => {
  // #1053-T01
  it("adds the credential on the way to the server and never gives it to the agent's side", async () => {
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const { proxy } = setup();
    const call = (body: string) =>
      proxy.forward({
        server: stored(server.url),
        headers: { Authorization: SECRET },
        request: post(body),
      });

    const init = await call(
      rpc("initialize", 1, {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent", version: "1" },
      }),
    );
    expect(init.status).toBe(200);
    const initText = await init.text();
    const session = init.headers.get("mcp-session-id");
    expect(session).toMatch(/^session-/);

    const listed = await proxy.forward({
      server: stored(server.url),
      headers: { Authorization: SECRET },
      request: post(rpc("tools/list", 2), { sessionId: session }),
    });
    const listedText = await listed.text();
    expect(JSON.parse(listedText)).toMatchObject({
      result: { tools: [{ name: "search_issues" }, { name: "get_issue" }] },
    });
    const result = await proxy.forward({
      server: stored(server.url),
      headers: { Authorization: SECRET },
      request: post(rpc("tools/call", 3, { name: "get_issue" }), {
        sessionId: session,
      }),
    });
    expect(JSON.parse(await result.text())).toMatchObject({
      result: { content: [{ text: "called get_issue" }] },
    });

    expect(server.sawHeader("authorization", SECRET)).toBe(true);
    expect(server.requests().every((request) => request.authorized)).toBe(true);
    expect(server.calledTools()).toEqual(["get_issue"]);
    for (const text of [initText, listedText])
      expect(text).not.toContain("dummy-proxy-secret");
    for (const response of [init, listed, result])
      expect([...response.headers.values()].join(" ")).not.toContain(
        "dummy-proxy-secret",
      );
  });

  it("answers a notification with 202 and an event stream answer as a stream", async () => {
    const server = await fake({ answerAs: "sse" });
    const { proxy } = setup();
    const notified = await proxy.forward({
      server: stored(server.url),
      headers: {},
      request: post(rpc("notifications/initialized", null)),
    });
    expect(notified.status).toBe(202);
    const streamed = await proxy.forward({
      server: stored(server.url),
      headers: {},
      request: post(rpc("tools/list", 1)),
    });
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toContain('"search_issues"');
  });

  it("offers no stream of its own: a GET is 405, so the agent's client uses plain requests", async () => {
    const server = await fake();
    const { proxy } = setup();
    const response = await proxy.forward({
      server: stored(server.url),
      headers: {},
      request: { method: "GET", body: null, sessionId: null, protocolVersion: null },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, DELETE");
    expect(server.requests()).toEqual([]);
  });

  it("ends the session of the server on DELETE", async () => {
    const server = await fake();
    const { proxy } = setup();
    const init = await proxy.forward({
      server: stored(server.url),
      headers: {},
      request: post(rpc("initialize", 1, {})),
    });
    const session = init.headers.get("mcp-session-id");
    expect(server.openSessions()).toBe(1);
    const ended = await proxy.forward({
      server: stored(server.url),
      headers: {},
      request: { method: "DELETE", body: null, sessionId: session, protocolVersion: null },
    });
    expect(ended.status).toBe(200);
    expect(server.openSessions()).toBe(0);
  });
});

describe("what the agent's side sees when the server fails", () => {
  const failure = async (response: Response) => {
    const text = await response.text();
    const body = JSON.parse(text) as {
      id: unknown;
      error: { code: number; message: string };
    };
    return { status: response.status, code: body.error.message, id: body.id };
  };

  it("never passes a 401 or 403 on (a client would start its own sign-in): a stable code, and no challenge header", async () => {
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const { proxy, calls } = setup();
    const response = await proxy.forward({
      server: stored(server.url),
      headers: { Authorization: "Bearer wrong" },
      request: post(rpc("tools/list", 7)),
    });
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await failure(response)).toEqual({
      status: 502,
      code: "mcp_proxy_unauthorized",
      id: 7,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outcome: "mcp_proxy_unauthorized",
      status: 502,
      rpcMethod: "tools/list",
    });
  });

  it("maps another error status, an unreachable server and a timeout to codes", async () => {
    const server = await fake();
    server.script("tools/list", { kind: "status", status: 500 });
    const { proxy } = setup({ deadlineMs: 300 });
    expect(
      await failure(
        await proxy.forward({
          server: stored(server.url),
          headers: {},
          request: post(rpc("tools/list", 1)),
        }),
      ),
    ).toMatchObject({ status: 502, code: "mcp_proxy_http_error" });

    server.script("tools/call", { kind: "hang" });
    expect(
      await failure(
        await proxy.forward({
          server: stored(server.url),
          headers: {},
          request: post(rpc("tools/call", 2, { name: "x" })),
        }),
      ),
    ).toMatchObject({ status: 504, code: "mcp_proxy_timeout" });

    const dead = await fake();
    const url = dead.url;
    await dead.close();
    fakes.pop();
    expect(
      await failure(
        await proxy.forward({
          server: stored(url),
          headers: {},
          request: post(rpc("tools/list", 3)),
        }),
      ),
    ).toMatchObject({ status: 502, code: "mcp_proxy_unreachable" });
  });

  it("refuses an address that is not allowed any more, at the call", async () => {
    const { proxy } = setup({ allowTestEndpoints: false });
    expect(
      await failure(
        await proxy.forward({
          server: stored("http://127.0.0.1:9/mcp"),
          headers: { Authorization: SECRET },
          request: post(rpc("tools/list", 1)),
        }),
      ),
    ).toMatchObject({ status: 502, code: "mcp_proxy_address_refused" });
  });

  it("refuses an answer that is too large and a request that is too large", async () => {
    const server = await fake();
    server.script("tools/list", { kind: "oversized", bytes: 5000 });
    const { proxy } = setup({ maxResponseBytes: 1000, maxRequestBytes: 200 });
    expect(
      await failure(
        await proxy.forward({
          server: stored(server.url),
          headers: {},
          request: post(rpc("tools/list", 1)),
        }),
      ),
    ).toMatchObject({ code: "mcp_proxy_response_too_large" });
    expect(
      await failure(
        await proxy.forward({
          server: stored(server.url),
          headers: {},
          request: post(rpc("tools/call", 2, { name: "x".repeat(500) })),
        }),
      ),
    ).toMatchObject({ status: 413, code: "mcp_proxy_request_too_large" });
  });

  it("refuses a body that is not a JSON-RPC message", async () => {
    const server = await fake();
    const { proxy } = setup();
    for (const body of ["not json", "[]", '"text"', '{"method":5}', "{}"])
      expect(
        await failure(
          await proxy.forward({
            server: stored(server.url),
            headers: {},
            request: post(body),
          }),
        ),
      ).toMatchObject({ status: 400, code: "mcp_proxy_request_invalid" });
    expect(server.requests()).toEqual([]);
  });
});

describe("what the proxy may reach", () => {
  it("follows a redirect on the server's own origin and keeps the credential there", async () => {
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const { proxy } = setup();
    const response = await proxy.forward({
      server: stored(`${server.origin}/moved`),
      headers: { Authorization: SECRET },
      request: post(rpc("tools/list", 1)),
    });
    expect(response.status).toBe(200);
    expect(server.requests().every((request) => request.authorized)).toBe(true);
  });

  it("does not follow a redirect to another origin, and the credential does not go there", async () => {
    const elsewhere = await fake();
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const { proxy } = setup();
    const response = await proxy.forward({
      server: stored(
        `${server.origin}/redirect-to?to=${encodeURIComponent(`${elsewhere.origin}/mcp`)}`,
      ),
      headers: { Authorization: SECRET },
      request: post(rpc("tools/list", 1)),
    });
    expect(response.status).toBe(502);
    expect(JSON.parse(await response.text())).toMatchObject({
      error: { message: "mcp_proxy_redirect_refused" },
    });
    expect(elsewhere.requests()).toEqual([]);
  });

  it("does not follow a redirect that loops", async () => {
    const server = await fake();
    const { proxy } = setup();
    const response = await proxy.forward({
      server: stored(`${server.origin}/loop`),
      headers: {},
      request: post(rpc("tools/list", 1)),
    });
    expect(JSON.parse(await response.text())).toMatchObject({
      error: { message: "mcp_proxy_redirect_refused" },
    });
  });
});

describe("the legacy SSE transport behind the same endpoint", () => {
  it("answers each request of the agent from a short session of its own, with the credential on both legs", async () => {
    const server = await fake({ requiredHeaders: { authorization: SECRET } });
    const { proxy } = setup();
    const target = stored(server.sseUrl, "sse");
    const init = await proxy.forward({
      server: target,
      headers: { Authorization: SECRET },
      request: post(rpc("initialize", 1, { protocolVersion: "2025-06-18" })),
    });
    expect(JSON.parse(await init.text())).toMatchObject({
      result: { serverInfo: { name: "fake-mcp" } },
    });
    const note = await proxy.forward({
      server: target,
      headers: { Authorization: SECRET },
      request: post(rpc("notifications/initialized", null)),
    });
    expect(note.status).toBe(202);
    const call = await proxy.forward({
      server: target,
      headers: { Authorization: SECRET },
      request: post(rpc("tools/call", 4, { name: "search_issues" })),
    });
    expect(call.status).toBe(200);
    expect(JSON.parse(await call.text())).toMatchObject({
      id: 4,
      result: { content: [{ text: "called search_issues" }] },
    });
    expect(server.calledTools()).toEqual(["search_issues"]);
    expect(server.requests().every((request) => request.authorized)).toBe(true);
    // The server wants an initialize on every session of its own: the proxy made one before the call.
    const rpcMethods = server.requests().map((request) => request.rpcMethod);
    expect(rpcMethods).toContain("tools/call");
    expect(rpcMethods.filter((method) => method === "initialize")).toHaveLength(
      2,
    );
  });

  it("does not post to an endpoint the server names on another origin, and the credential does not go there", async () => {
    const elsewhere = await fake();
    const liar = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: endpoint\ndata: ${elsewhere.origin}/messages?sessionId=x\n\n`,
      );
    });
    await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
    try {
      const origin = `http://127.0.0.1:${String((liar.address() as AddressInfo).port)}`;
      const { proxy } = setup();
      const response = await proxy.forward({
        server: stored(`${origin}/sse`, "sse"),
        headers: { Authorization: SECRET },
        request: post(rpc("tools/list", 1)),
      });
      expect(response.status).toBe(502);
      expect(JSON.parse(await response.text())).toMatchObject({
        error: { message: "mcp_proxy_protocol_error" },
      });
      expect(elsewhere.requests()).toEqual([]);
    } finally {
      liar.closeAllConnections();
      await new Promise<void>((resolve) => liar.close(() => resolve()));
    }
  });
});

describe("what is recorded for each call", () => {
  // #1055 hook: server, method, tool name, duration, status, sizes; no arguments, no result.
  it("records the metadata and nothing of the arguments or the answer", async () => {
    const server = await fake();
    const { proxy, calls } = setup();
    const response = await proxy.forward({
      server: stored(server.url),
      headers: { Authorization: SECRET },
      request: post(
        rpc("tools/call", 9, {
          name: "get_issue",
          arguments: { secretish: "needle-argument" },
        }),
      ),
    });
    await response.text();
    expect(calls).toHaveLength(1);
    const meta = calls[0] as McpCallMeta;
    expect(meta).toMatchObject({
      serverId: "11111111-1111-4111-8111-111111111111",
      transport: "streamable-http",
      rpcMethod: "tools/call",
      tool: "get_issue",
      status: 200,
      outcome: "ok",
    });
    expect(meta.requestBytes).toBeGreaterThan(0);
    expect(meta.responseBytes).toBeGreaterThan(0);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(meta)).not.toContain("needle-argument");
    expect(JSON.stringify(meta)).not.toContain("called get_issue");
    expect(JSON.stringify(meta)).not.toContain("dummy-proxy-secret");
  });
});
