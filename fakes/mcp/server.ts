// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake MCP server (loopback only, in memory) for the tests of the MCP registry (#1050, epic #1049). It speaks the two remote transports
// of the Model Context Protocol, in their shapes, so the production client runs unchanged against it:
//   POST /mcp          Streamable HTTP: one JSON-RPC message per request. `initialize` answers with the server info and a `Mcp-Session-Id`;
//                      `notifications/initialized` answers 202; `tools/list` answers the tools (paged by `cursor`, `toolsPageSize`). The
//                      answer is `application/json`, or a `text/event-stream` with one `message` event (`answerAs: "sse"`).
//   DELETE /mcp        ends the session (200).
//   GET  /sse          the legacy HTTP+SSE transport: an event stream that starts with an `endpoint` event (`/messages?sessionId=...`)
//   POST /messages     a JSON-RPC message of that session: answers 202 and the answer arrives on the event stream
//   GET  /redirect-to  `?to=<url>` answers 302 to it (a test of the redirect rules); GET /moved answers 301 to `/mcp`; GET /loop redirects to itself
// Header authentication: with `requiredHeaders` every request needs those headers with exactly those values, otherwise 401. The fake never
// stores a value of a header it was not told to expect, but it can say whether a request carried one (`sawHeader`): tests prove that the
// credential reached the server and look for it nowhere else. Dummy values only.
// What a test may do (`McpFake`): set the tools, script the next answer of a kind (a status, a hang, an answer that is not JSON-RPC, a JSON-RPC
// error, an oversized body) and read the recorded requests. Started by a test through `startMcpFake`.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { keepConnectionsOpen } from "../keep-alive.ts";
import { isLoopbackHostname } from "../stripe/loopback.ts";

export const FAKE_MCP_PROTOCOL_VERSION = "2025-06-18";

export type FakeMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type FakeMcpOptions = {
  host?: string;
  /** Every request needs these headers with these values (names compared in lower case); otherwise 401. */
  requiredHeaders?: Record<string, string>;
  tools?: FakeMcpTool[];
  serverName?: string;
  serverVersion?: string;
  /** Streamable HTTP: how a POST is answered. Default `json`. */
  answerAs?: "json" | "sse";
  /** `tools/list` returns this many tools per page (and a `nextCursor`); default: all of them in one page. */
  toolsPageSize?: number;
};

/** What a test can make the next matching request do instead of the normal answer. */
export type ScriptedAnswer =
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "text"; body: string; contentType?: string }
  | { kind: "rpc-error"; code: number; message: string }
  | { kind: "oversized"; bytes: number };

/** What a request was about, for `script`: the JSON-RPC method of a POST, `sse` for the GET of the event stream. */
export type ScriptTarget = string;

export type RecordedMcpRequest = {
  method: string;
  path: string;
  /** The JSON-RPC method of a POST, when it had one. */
  rpcMethod: string | null;
  /** Whether the required headers were right (always true when none are required). */
  authorized: boolean;
  /** The names of the headers, lower case; never a value. */
  headerNames: string[];
  sessionId: string | null;
  protocolVersion: string | null;
};

export type McpFake = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The Streamable HTTP endpoint. */
  url: string;
  /** The legacy SSE endpoint. */
  sseUrl: string;
  setTools(tools: FakeMcpTool[]): void;
  /** The next request of this kind gets `answer` instead of the normal one (queued, one each). */
  script(target: ScriptTarget, answer: ScriptedAnswer): void;
  requests(): readonly RecordedMcpRequest[];
  /** Whether any request carried the header with exactly this value. */
  sawHeader(name: string, value: string): boolean;
  /** Streamable HTTP sessions that are open. */
  openSessions(): number;
  close(): Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

type RpcRequest = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

export async function startMcpFake(
  options: FakeMcpOptions = {},
): Promise<McpFake> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHostname(host))
    throw new Error(
      `The fake MCP server only listens on a loopback address, not ${host}.`,
    );
  let tools: FakeMcpTool[] = options.tools ?? [
    { name: "search_issues", description: "Search the issues of a project." },
    { name: "get_issue", description: "Read one issue by its key." },
  ];
  const required = Object.entries(options.requiredHeaders ?? {}).map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const answerAs = options.answerAs ?? "json";
  const recorded: RecordedMcpRequest[] = [];
  const seenHeaders: { name: string; value: string }[] = [];
  const scripted = new Map<string, ScriptedAnswer[]>();
  const sessions = new Set<string>();
  const streams = new Map<string, ServerResponse>();
  const hanging = new Set<ServerResponse>();
  let nextSession = 1;

  const take = (target: string): ScriptedAnswer | undefined =>
    scripted.get(target)?.shift();

  function serverInfo() {
    return {
      name: options.serverName ?? "fake-mcp",
      version: options.serverVersion ?? "1.2.3",
    };
  }

  function rpcResult(request: RpcRequest): unknown {
    if (request.method === "initialize")
      return {
        protocolVersion: FAKE_MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo(),
      };
    if (request.method === "tools/list") {
      const size = options.toolsPageSize ?? tools.length;
      const cursor = request.params?.cursor;
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      const page = tools.slice(start, start + Math.max(size, 1));
      const next = start + page.length;
      return {
        tools: page.map((tool) => ({
          inputSchema: { type: "object", properties: {} },
          ...tool,
        })),
        ...(next < tools.length ? { nextCursor: String(next) } : {}),
      };
    }
    return undefined;
  }

  function envelope(request: RpcRequest, scriptedAnswer?: ScriptedAnswer) {
    if (scriptedAnswer?.kind === "rpc-error")
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: scriptedAnswer.code, message: scriptedAnswer.message },
      };
    const result = rpcResult(request);
    if (result === undefined)
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      };
    return { jsonrpc: "2.0", id: request.id, result };
  }

  function reply(
    response: ServerResponse,
    status: number,
    body: string,
    contentType = "application/json",
    extra: Record<string, string> = {},
  ): void {
    response.writeHead(status, { "content-type": contentType, ...extra });
    response.end(body);
  }

  /** Applies a scripted answer that ends the request; false when the request goes on normally. */
  function applyScript(
    response: ServerResponse,
    answer: ScriptedAnswer | undefined,
  ): boolean {
    if (answer === undefined) return false;
    switch (answer.kind) {
      case "status":
        reply(response, answer.status, "{}");
        return true;
      case "hang":
        hanging.add(response);
        return true;
      case "text":
        reply(response, 200, answer.body, answer.contentType ?? "text/plain");
        return true;
      case "oversized":
        reply(response, 200, "x".repeat(answer.bytes), "application/json");
        return true;
      case "rpc-error":
        return false;
    }
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake.test");
    const lower: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string") lower[name] = value;
    const authorized = required.every(([name, value]) => lower[name] === value);
    for (const [name, value] of required)
      if (lower[name] === value) seenHeaders.push({ name, value });
    const body = request.method === "POST" ? await readBody(request) : "";
    let rpc: RpcRequest = {};
    try {
      rpc = body === "" ? {} : (JSON.parse(body) as RpcRequest);
    } catch {
      rpc = {};
    }
    const sessionId = lower["mcp-session-id"] ?? null;
    recorded.push({
      method: request.method ?? "GET",
      path: url.pathname,
      rpcMethod: typeof rpc.method === "string" ? rpc.method : null,
      authorized,
      headerNames: Object.keys(lower),
      sessionId,
      protocolVersion: lower["mcp-protocol-version"] ?? null,
    });

    if (url.pathname === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
      return;
    }
    if (url.pathname === "/moved") {
      response.writeHead(301, { location: "/mcp" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-to") {
      response.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
      response.end();
      return;
    }
    if (!authorized) {
      reply(response, 401, '{"error":"unauthorized"}', "application/json", {
        "www-authenticate": 'Bearer realm="fake-mcp"',
      });
      return;
    }

    if (url.pathname === "/mcp") {
      if (request.method === "DELETE") {
        if (sessionId !== null) sessions.delete(sessionId);
        reply(response, 200, "{}");
        return;
      }
      if (request.method !== "POST") {
        reply(response, 405, "{}");
        return;
      }
      const target = rpc.method ?? "unknown";
      const answer = take(target);
      if (applyScript(response, answer)) return;
      if (rpc.id === undefined) {
        // A notification has no answer.
        reply(response, 202, "");
        return;
      }
      const payload = JSON.stringify(envelope(rpc, answer));
      const extra: Record<string, string> = {};
      if (rpc.method === "initialize") {
        const id = `session-${String(nextSession++)}`;
        sessions.add(id);
        extra["mcp-session-id"] = id;
      }
      if (answerAs === "sse")
        reply(
          response,
          200,
          `: keep-alive\n\nevent: message\ndata: ${payload}\n\n`,
          "text/event-stream",
          extra,
        );
      else reply(response, 200, payload, "application/json", extra);
      return;
    }

    if (url.pathname === "/sse" && request.method === "GET") {
      const answer = take("sse");
      if (applyScript(response, answer)) return;
      const id = `legacy-${String(nextSession++)}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      streams.set(id, response);
      response.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      response.on("close", () => streams.delete(id));
      return;
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      const stream = streams.get(url.searchParams.get("sessionId") ?? "");
      if (stream === undefined) {
        reply(response, 404, "{}");
        return;
      }
      const target = rpc.method ?? "unknown";
      const answer = take(target);
      if (applyScript(response, answer)) return;
      reply(response, 202, "Accepted", "text/plain");
      if (rpc.id === undefined) return;
      stream.write(
        `event: message\ndata: ${JSON.stringify(envelope(rpc, answer))}\n\n`,
      );
      return;
    }

    reply(response, 404, "{}");
  }

  const server: Server = keepConnectionsOpen(
    createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    }),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, host, resolve);
  });
  const origin = `http://${host}:${String((server.address() as AddressInfo).port)}`;

  return {
    origin,
    url: `${origin}/mcp`,
    sseUrl: `${origin}/sse`,
    setTools(next) {
      tools = next;
    },
    script(target, answer) {
      scripted.set(target, [...(scripted.get(target) ?? []), answer]);
    },
    requests: () => recorded,
    sawHeader: (name, value) =>
      seenHeaders.some(
        (seen) => seen.name === name.toLowerCase() && seen.value === value,
      ),
    openSessions: () => sessions.size,
    async close() {
      for (const response of [...hanging, ...streams.values()])
        response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
