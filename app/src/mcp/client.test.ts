// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_MCP_PROTOCOL_VERSION,
  startMcpFake,
  type McpFake,
} from "../../../fakes/mcp/server.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import {
  MCP_TOOL_DESCRIPTION_MAX_LENGTH,
  MCP_TOOL_NAME_MAX_LENGTH,
  testMcpServer,
  type McpTestOptions,
} from "./client.ts";

const fakes: McpFake[] = [];
async function fake(...args: Parameters<typeof startMcpFake>) {
  const started = await startMcpFake(...args);
  fakes.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((started) => started.close()));
});

const options = (overrides: Partial<McpTestOptions> = {}): McpTestOptions => ({
  fetch: createGuardedFetch({ allowLoopback: true }),
  allowTestEndpoints: true,
  deadlineMs: 5000,
  ...overrides,
});

describe("the connection test of an MCP server over Streamable HTTP", () => {
  // #1050-T01
  it("runs initialize, the initialized notification and tools/list, and returns the tools with the server's name", async () => {
    const server = await fake({
      requiredHeaders: { authorization: "Bearer fake-secret-1" },
      serverName: "Fake Issues",
      serverVersion: "9.0.1",
    });

    const result = await testMcpServer(
      {
        url: server.url,
        transport: "streamable-http",
        headers: { Authorization: "Bearer fake-secret-1" },
      },
      options(),
    );

    expect(result).toEqual({
      ok: true,
      serverName: "Fake Issues",
      serverVersion: "9.0.1",
      protocolVersion: FAKE_MCP_PROTOCOL_VERSION,
      tools: [
        {
          name: "search_issues",
          description: "Search the issues of a project.",
        },
        { name: "get_issue", description: "Read one issue by its key." },
      ],
      truncated: false,
    });
    expect(server.sawHeader("authorization", "Bearer fake-secret-1")).toBe(
      true,
    );
    expect(
      server.requests().map((entry) => entry.rpcMethod ?? entry.method),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "DELETE",
    ]);
    // The session and the negotiated version are carried on the calls after initialize.
    const afterInit = server.requests().slice(1, 3);
    expect(afterInit.every((entry) => entry.sessionId === "session-1")).toBe(
      true,
    );
    expect(
      afterInit.every(
        (entry) => entry.protocolVersion === FAKE_MCP_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    expect(server.openSessions()).toBe(0);
  });

  it("reads an answer that comes as an event stream, and follows the pages of the tool list", async () => {
    const tools = Array.from({ length: 5 }, (_, index) => ({
      name: `tool_${String(index)}`,
      description: `Tool ${String(index)}`,
    }));
    const server = await fake({ answerAs: "sse", tools, toolsPageSize: 2 });

    const result = await testMcpServer(
      { url: server.url, transport: "streamable-http", headers: {} },
      options(),
    );

    expect(result.ok && result.tools.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
  });

  it("stops at the most tools it keeps and says so", async () => {
    const tools = Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${String(index)}`,
    }));
    const server = await fake({ tools });

    const result = await testMcpServer(
      { url: server.url, transport: "streamable-http", headers: {} },
      options({ maxTools: 10 }),
    );

    expect(result.ok && result.tools).toHaveLength(10);
    expect(result.ok && result.truncated).toBe(true);
  });

  it("cuts a long description and tolerates a tool without one", async () => {
    const server = await fake({
      tools: [
        { name: "long", description: "d".repeat(5000) },
        { name: "bare" },
      ],
    });

    const result = await testMcpServer(
      { url: server.url, transport: "streamable-http", headers: {} },
      options(),
    );

    expect(result.ok && result.tools[0]?.description).toHaveLength(
      MCP_TOOL_DESCRIPTION_MAX_LENGTH,
    );
    expect(result.ok && result.tools[1]).toEqual({
      name: "bare",
      description: "",
    });
  });

  it("reports 401 as unauthorized when the headers are wrong, and sends no tool list", async () => {
    const server = await fake({ requiredHeaders: { "x-api-key": "right" } });

    const result = await testMcpServer(
      {
        url: server.url,
        transport: "streamable-http",
        headers: { "X-Api-Key": "wrong" },
      },
      options(),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_unauthorized" });
  });

  it("names the other ways a test ends: http error, protocol error, JSON-RPC error, too large", async () => {
    const server = await fake();
    const run = () =>
      testMcpServer(
        { url: server.url, transport: "streamable-http", headers: {} },
        options({ maxResponseBytes: 10_000 }),
      );

    server.script("initialize", { kind: "status", status: 503 });
    expect(await run()).toEqual({ ok: false, code: "mcp_test_http_error" });

    server.script("initialize", { kind: "text", body: "<html>hello</html>" });
    expect(await run()).toEqual({ ok: false, code: "mcp_test_protocol_error" });

    server.script("tools/list", {
      kind: "rpc-error",
      code: -32000,
      message: "no",
    });
    expect(await run()).toEqual({ ok: false, code: "mcp_test_rejected" });

    server.script("initialize", { kind: "oversized", bytes: 20_000 });
    expect(await run()).toEqual({ ok: false, code: "mcp_test_too_large" });
  });

  it("gives up on a server that does not answer, at the deadline", async () => {
    const server = await fake();
    server.script("initialize", { kind: "hang" });

    const started = Date.now();
    const result = await testMcpServer(
      { url: server.url, transport: "streamable-http", headers: {} },
      options({ deadlineMs: 300 }),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("reports a server that is not there as unreachable", async () => {
    const server = await fake();
    const url = server.url;
    await server.close();

    expect(
      await testMcpServer(
        { url, transport: "streamable-http", headers: {} },
        options(),
      ),
    ).toEqual({ ok: false, code: "mcp_test_unreachable" });
  });
});

describe("the connection test of an MCP server over SSE", () => {
  // #1050-T01
  it("reads the endpoint event, posts the messages there and reads the answers from the stream", async () => {
    const server = await fake({
      requiredHeaders: { "x-api-key": "fake-key-2" },
    });

    const result = await testMcpServer(
      {
        url: server.sseUrl,
        transport: "sse",
        headers: { "X-Api-Key": "fake-key-2" },
      },
      options(),
    );

    expect(result.ok && result.tools.map((tool) => tool.name)).toEqual([
      "search_issues",
      "get_issue",
    ]);
    // The credential goes on the stream and on every post.
    expect(server.requests().every((entry) => entry.authorized)).toBe(true);
    expect(
      server.requests().map((entry) => entry.rpcMethod ?? entry.method),
    ).toEqual(["GET", "initialize", "notifications/initialized", "tools/list"]);
  });

  it("reports an SSE server that never names an endpoint as a protocol error", async () => {
    const server = await fake();
    server.script("sse", {
      kind: "text",
      body: "event: message\ndata: {}\n\n",
      contentType: "text/event-stream",
    });

    expect(
      await testMcpServer(
        { url: server.sseUrl, transport: "sse", headers: {} },
        options(),
      ),
    ).toEqual({ ok: false, code: "mcp_test_protocol_error" });
  });

  it("refuses an endpoint on another origin, so the stream cannot send the credential elsewhere", async () => {
    const server = await fake();
    server.script("sse", {
      kind: "text",
      body: "event: endpoint\ndata: http://127.0.0.1:1/messages\n\n",
      contentType: "text/event-stream",
    });

    expect(
      await testMcpServer(
        { url: server.sseUrl, transport: "sse", headers: {} },
        options(),
      ),
    ).toEqual({ ok: false, code: "mcp_test_protocol_error" });
  });
});

describe("the address rules of the connection test", () => {
  // #1050-T02
  it("reports a connection that the guard refused (a name that resolved to a private or metadata address) as a refused address", async () => {
    // The guard of the connection (`dispatch/guarded-fetch.ts`, tested there) fails the call with this code; undici wraps it in `fetch failed`.
    const refusing = () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("delivery address is internal"), {
            code: "DELIVERY_ADDRESS_INTERNAL",
          }),
        }),
      );

    const result = await testMcpServer(
      {
        url: "https://mcp.example.test/mcp",
        transport: "streamable-http",
        headers: {},
      },
      { fetch: refusing, allowTestEndpoints: false, deadlineMs: 2000 },
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_address_refused" });
  });

  // #1050-T02
  it("refuses an address literal that is internal at the connection too, with the real guarded fetch", async () => {
    const guarded = createGuardedFetch({ allowLoopback: false });

    const result = await testMcpServer(
      {
        url: "https://mcp.example.test/mcp",
        transport: "streamable-http",
        headers: {},
      },
      {
        // The address passes the text rules; only the connection can know where it leads.
        fetch: (_url, init) => guarded("https://[::1]/mcp", init),
        allowTestEndpoints: false,
        deadlineMs: 2000,
      },
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_address_refused" });
  });

  // #1050-T02
  it("refuses an address that is private as text without a connection", async () => {
    const result = await testMcpServer(
      {
        url: "https://10.1.2.3/mcp",
        transport: "streamable-http",
        headers: {},
      },
      { ...options(), allowTestEndpoints: false },
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_address_refused" });
  });

  // #1050-T02
  it("refuses a redirect to a private address and to plain http, and does not follow one that loops", async () => {
    const server = await fake();
    const run = (to: string) =>
      testMcpServer(
        {
          url: `${server.origin}/redirect-to?to=${encodeURIComponent(to)}`,
          transport: "streamable-http",
          headers: { "X-Key": "k" },
        },
        // Plain http to loopback is the test flag's; a private network is refused even with it.
        options(),
      );

    expect(await run("http://169.254.169.254/latest/meta-data")).toEqual({
      ok: false,
      code: "mcp_test_redirect_refused",
    });
    expect(await run("http://10.0.0.5/mcp")).toEqual({
      ok: false,
      code: "mcp_test_redirect_refused",
    });
    expect(await run(`${server.origin}/loop`)).toEqual({
      ok: false,
      code: "mcp_test_redirect_refused",
    });
    // Nothing reached the address the redirect named.
    expect(
      server
        .requests()
        .every((entry) => ["/redirect-to", "/loop"].includes(entry.path)),
    ).toBe(true);
  });

  it("follows a redirect to an allowed address and keeps the credential on the same origin", async () => {
    const server = await fake({ requiredHeaders: { "x-key": "k" } });

    const result = await testMcpServer(
      {
        url: `${server.origin}/moved`,
        transport: "streamable-http",
        headers: { "X-Key": "k" },
      },
      options(),
    );

    expect(result.ok).toBe(true);
  });

  it("does not send the credential to another origin it was redirected to", async () => {
    const target = await fake({ requiredHeaders: { "x-key": "k" } });
    const origin = await fake();
    // `localhost` is another origin than `127.0.0.1` for the same fake.
    const other = target.url.replace("127.0.0.1", "localhost");

    const result = await testMcpServer(
      {
        url: `${origin.origin}/redirect-to?to=${encodeURIComponent(other)}`,
        transport: "streamable-http",
        headers: { "X-Key": "k" },
      },
      options(),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_unauthorized" });
    expect(target.sawHeader("x-key", "k")).toBe(false);
  });
});

describe("what a tool list may put into the stored result", () => {
  it("keeps the caps of what every list of the page ships small", () => {
    expect(MCP_TOOL_NAME_MAX_LENGTH).toBeLessThanOrEqual(100);
    expect(MCP_TOOL_DESCRIPTION_MAX_LENGTH).toBeLessThanOrEqual(300);
  });

  it("strips control and bidirectional characters from names and descriptions", async () => {
    const server = await fake({
      serverName: "Evil\u202eServer",
      tools: [
        {
          name: "read\u202e_file\u0000\u200f",
          description:
            "Line one\nline\ttwo \u2066hidden\u2069 \u001b[31mred\u0007",
        },
      ],
    });

    const result = await testMcpServer(
      { url: server.url, transport: "streamable-http", headers: {} },
      options(),
    );

    expect(result.ok && result.serverName).toBe("EvilServer");
    expect(result.ok && result.tools).toEqual([
      { name: "read_file", description: "Line one line two hidden [31mred" },
    ]);
  });
});

/** A fetch that answers from a list and records what it was asked, for the cases that need no server. */
function stubFetch(
  answer: (call: { url: string; headers: Headers; method: string }) => Response,
) {
  const calls: { url: string; headers: Headers; method: string }[] = [];
  const fetch: McpTestOptions["fetch"] = (url, init) => {
    const call = {
      url,
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

const redirect = (to: string) =>
  new Response(null, { status: 302, headers: { location: to } });

describe("where the credential goes when a server redirects", () => {
  // The origin is scheme, host and port: a change of any of them is another origin.
  it.each([
    ["the port", "https://mcp.example.com:8443/mcp"],
    ["the scheme", "http://mcp.example.com/mcp"],
    ["the host", "https://other.example.com/mcp"],
  ])("drops the credential when the redirect changes %s", async (_what, to) => {
    const { fetch, calls } = stubFetch((call) =>
      call.url === "https://mcp.example.com/mcp"
        ? redirect(to)
        : new Response("{}", { status: 401 }),
    );

    const result = await testMcpServer(
      {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: { "X-Key": "secret" },
      },
      options({ fetch }),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_unauthorized" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.get("x-key")).toBe("secret");
    expect(calls[1]?.url).toBe(to);
    expect(calls[1]?.headers.get("x-key")).toBeNull();
  });

  it("keeps the credential for a redirect inside the origin", async () => {
    const { fetch, calls } = stubFetch((call) =>
      call.url === "https://mcp.example.com/mcp"
        ? redirect("/other/path")
        : new Response("{}", { status: 401 }),
    );

    await testMcpServer(
      {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: { "X-Key": "secret" },
      },
      options({ fetch }),
    );

    expect(calls[1]?.url).toBe("https://mcp.example.com/other/path");
    expect(calls[1]?.headers.get("x-key")).toBe("secret");
  });

  it("drops the credential when the event stream of an SSE server is behind a redirect to another origin", async () => {
    const target = await fake({ requiredHeaders: { "x-key": "k" } });
    const origin = await fake();
    // `localhost` is another origin than `127.0.0.1` for the same fake.
    const other = target.sseUrl.replace("127.0.0.1", "localhost");

    const result = await testMcpServer(
      {
        url: `${origin.origin}/redirect-to?to=${encodeURIComponent(other)}`,
        transport: "sse",
        headers: { "X-Key": "k" },
      },
      options(),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_unauthorized" });
    expect(target.sawHeader("x-key", "k")).toBe(false);
  });

  it("follows an SSE redirect and posts to the endpoint on the origin the stream ended up on", async () => {
    const target = await fake();
    const origin = await fake();
    const other = target.sseUrl.replace("127.0.0.1", "localhost");

    const result = await testMcpServer(
      {
        url: `${origin.origin}/redirect-to?to=${encodeURIComponent(other)}`,
        transport: "sse",
        headers: { "X-Key": "k" },
      },
      options(),
    );

    expect(result.ok && result.tools.map((tool) => tool.name)).toEqual([
      "search_issues",
      "get_issue",
    ]);
    expect(
      origin.requests().every((entry) => entry.path === "/redirect-to"),
    ).toBe(true);
    expect(target.sawHeader("x-key", "k")).toBe(false);
  });
});

describe("answers that stop or fail halfway", () => {
  /** A body that sends a few bytes and then waits until the request is aborted, as a real connection does. */
  function stallingBody(signal: AbortSignal | null | undefined) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"jsonrpc":"2.0","id":1,'),
        );
        signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
  }

  it("gives up on a JSON body that stalls in the middle, at the deadline", async () => {
    const fetch: McpTestOptions["fetch"] = (_url, init) =>
      Promise.resolve(
        new Response(stallingBody(init.signal), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const started = Date.now();
    const result = await testMcpServer(
      {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: {},
      },
      options({ fetch, deadlineMs: 300 }),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives up on an event stream that stalls in the middle of an event, at the deadline", async () => {
    const fetch: McpTestOptions["fetch"] = (_url, init) =>
      Promise.resolve(
        new Response(stallingBody(init.signal), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );

    const result = await testMcpServer(
      {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: {},
      },
      options({ fetch, deadlineMs: 300 }),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_timeout" });
  });

  it("lets the body of an error answer go instead of leaving the connection open", async () => {
    let cancelled = false;
    const fetch: McpTestOptions["fetch"] = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("error page"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        ),
      );

    const result = await testMcpServer(
      {
        url: "https://mcp.example.com/mcp",
        transport: "streamable-http",
        headers: {},
      },
      options({ fetch }),
    );

    expect(result).toEqual({ ok: false, code: "mcp_test_http_error" });
    expect(cancelled).toBe(true);
  });
});
