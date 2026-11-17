// SPDX-License-Identifier: LicenseRef-Proprietary

// The connection test of an MCP server (#1050): this server acts as an MCP client (spec revision 2025-06-18), runs `initialize`, sends
// `notifications/initialized` and asks `tools/list`, over one of the two remote transports:
//   - Streamable HTTP: every message is a POST to the address; the answer is JSON or a short event stream; the `Mcp-Session-Id` the server
//     names is sent on the calls after it, and the session is ended with a DELETE at the end (best effort);
//   - SSE (the older HTTP+SSE transport): a GET opens the event stream, whose first event `endpoint` names where to POST; the answers arrive
//     on the stream. The endpoint must be on the origin of the stream, so a stream cannot send the credential somewhere else.
// A small client of its own and no library: three messages, no sessions kept, and every limit and every address rule is in this file.
// Bounds: ONE deadline for the whole test, a cap on every body and on the event stream, at most `maxTools` tools of at most `maxPages`
// pages, and names and descriptions cut to a length. Addresses: every address (the first and each redirect) goes through `checkMcpUrl`,
// redirects are followed by hand (at most `MAX_REDIRECTS`), the credential headers are dropped when a redirect leaves the origin, and the
// connection itself is made by the guarded fetch that is passed in (`dispatch/guarded-fetch.ts`: the name is resolved once and every address is
// judged, so a name that resolves to a private place is refused at the socket, whatever the text said).
// Nothing here keeps or logs a header value, an address, a body or an error text; a failure is one stable code (`errors.ts`).
import {
  createSseEventReader,
  SseTooLargeError,
  type SseEventReader,
} from "./sse.ts";
import type { McpTestErrorCode } from "./errors.ts";
import type { McpTransport } from "./input.ts";
import { checkMcpUrl } from "./url.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_TEST_DEADLINE_MS = 15_000;
export const MCP_TEST_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MCP_TEST_MAX_TOOLS = 500;
export const MCP_TEST_MAX_PAGES = 20;
export const MCP_TOOL_NAME_MAX_LENGTH = 200;
export const MCP_TOOL_DESCRIPTION_MAX_LENGTH = 1000;
const MAX_REDIRECTS = 3;
/** The code a guarded connection's error carries when it refused an address (`dispatch/guarded-fetch.ts`). */
const REFUSED_ADDRESS_CODE = "DELIVERY_ADDRESS_INTERNAL";

export type McpToolInfo = { name: string; description: string };

export type McpTestResult =
  | {
      ok: true;
      serverName: string | null;
      serverVersion: string | null;
      protocolVersion: string | null;
      tools: McpToolInfo[];
      /** More tools were announced than the test keeps. */
      truncated: boolean;
    }
  | { ok: false; code: McpTestErrorCode };

export type McpTestTarget = {
  url: string;
  transport: McpTransport;
  /** The credential headers, by name. */
  headers: Readonly<Record<string, string>>;
};

export type McpTestOptions = {
  /** The guarded fetch (it refuses an internal address at the connection). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The test flag (`config.ts`): plain http and this machine. */
  allowTestEndpoints: boolean;
  deadlineMs?: number;
  maxResponseBytes?: number;
  maxTools?: number;
};

class McpTestFailure extends Error {
  readonly code: McpTestErrorCode;
  constructor(code: McpTestErrorCode) {
    super(code);
    this.name = "McpTestFailure";
    this.code = code;
  }
}

const fail = (code: McpTestErrorCode): never => {
  throw new McpTestFailure(code);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (chain.length < 5 && current !== undefined && current !== null) {
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

/** What a failed call means: the deadline, a refused address, or nothing that could be reached. */
function failureOf(error: unknown, signal: AbortSignal): McpTestFailure {
  if (error instanceof McpTestFailure) return error;
  if (error instanceof SseTooLargeError)
    return new McpTestFailure("mcp_test_too_large");
  if (signal.aborted) return new McpTestFailure("mcp_test_timeout");
  for (const entry of errorChain(error))
    if (isRecord(entry) && entry.code === REFUSED_ADDRESS_CODE)
      return new McpTestFailure("mcp_test_address_refused");
  for (const entry of errorChain(error))
    if (
      isRecord(entry) &&
      (entry.name === "TimeoutError" || entry.name === "AbortError")
    )
      return new McpTestFailure("mcp_test_timeout");
  return new McpTestFailure("mcp_test_unreachable");
}

type Sent = { response: Response; finalUrl: URL };

export async function testMcpServer(
  target: McpTestTarget,
  options: McpTestOptions,
): Promise<McpTestResult> {
  const signal = AbortSignal.timeout(
    options.deadlineMs ?? MCP_TEST_DEADLINE_MS,
  );
  const maxBytes = options.maxResponseBytes ?? MCP_TEST_MAX_RESPONSE_BYTES;
  const maxTools = options.maxTools ?? MCP_TEST_MAX_TOOLS;
  const policy = { allowTestEndpoints: options.allowTestEndpoints };
  let credentials: Record<string, string> = { ...target.headers };
  let nextId = 1;
  let session: string | null = null;
  let negotiated: string | null = null;
  let stream: SseEventReader | null = null;
  let postUrl: URL | null = null;

  /** One request with the redirects followed by hand; the credential stays on the origin it was meant for. */
  async function send(
    url: URL,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Sent> {
    let current = url;
    for (let hop = 0; ; hop++) {
      const first = hop === 0;
      if (first) {
        const checked = checkMcpUrl(current.toString(), {
          ...policy,
          allowQuery: true,
        });
        if (!checked.ok) return fail("mcp_test_address_refused");
      }
      const headers: Record<string, string> = {
        ...init.headers,
        ...credentials,
      };
      let response: Response;
      try {
        response = await options.fetch(current.toString(), {
          method: init.method,
          headers,
          redirect: "manual",
          signal,
          ...(init.body === undefined ? {} : { body: init.body }),
        });
      } catch (error) {
        throw failureOf(error, signal);
      }
      if (
        response.status < 300 ||
        response.status >= 400 ||
        response.status === 304
      )
        return { response, finalUrl: current };
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null || hop >= MAX_REDIRECTS)
        return fail("mcp_test_redirect_refused");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return fail("mcp_test_redirect_refused");
      }
      if (!checkMcpUrl(next.toString(), { ...policy, allowQuery: true }).ok)
        return fail("mcp_test_redirect_refused");
      // A credential is meant for the address it was entered for: another origin gets none.
      if (next.origin !== current.origin) credentials = {};
      current = next;
    }
  }

  function statusFailure(response: Response): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403)
      fail("mcp_test_unauthorized");
    fail("mcp_test_http_error");
  }

  /** The whole body as text, up to the cap. */
  async function readText(response: Response): Promise<string> {
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return fail("mcp_test_too_large");
        }
        text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      throw failureOf(error, signal);
    }
    return text + decoder.decode();
  }

  function protocolHeaders(): Record<string, string> {
    return {
      ...(negotiated === null ? {} : { "mcp-protocol-version": negotiated }),
      ...(session === null ? {} : { "mcp-session-id": session }),
    };
  }

  /** The JSON-RPC response with `id` among what a body holds (an object, or a batch). */
  function pickResponse(
    value: unknown,
    id: number,
  ): Record<string, unknown> | undefined {
    const candidates = Array.isArray(value) ? (value as unknown[]) : [value];
    return candidates.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) &&
        entry.id === id &&
        ("result" in entry || "error" in entry),
    );
  }

  /** The `result` of a JSON-RPC answer; an error answer is `mcp_test_rejected`, anything else `mcp_test_protocol_error`. */
  function resultOf(
    answer: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (answer === undefined) return fail("mcp_test_protocol_error");
    if ("error" in answer) return fail("mcp_test_rejected");
    return isRecord(answer.result)
      ? answer.result
      : fail("mcp_test_protocol_error");
  }

  function parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return fail("mcp_test_protocol_error");
    }
  }

  const jsonHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...protocolHeaders(),
  });

  const message = (method: string, params: unknown, id: number | null) =>
    JSON.stringify({
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    });

  /** Streamable HTTP: POST the request, read the answer from the body (JSON or an event stream). */
  async function callHttp(
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const id = nextId++;
    const { response } = await send(new URL(target.url), {
      method: "POST",
      headers: jsonHeaders(),
      body: message(method, params, id),
    });
    statusFailure(response);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (method === "initialize")
      session = response.headers.get("mcp-session-id");
    if (type.startsWith("application/json"))
      return resultOf(pickResponse(parseJson(await readText(response)), id));
    if (type.startsWith("text/event-stream") && response.body !== null) {
      const events = createSseEventReader(response.body, maxBytes);
      try {
        for (
          let event = await events.next();
          event !== null;
          event = await events.next()
        ) {
          if (event.event !== "message") continue;
          const answer = pickResponse(parseJson(event.data), id);
          if (answer !== undefined) return resultOf(answer);
        }
      } catch (error) {
        throw failureOf(error, signal);
      } finally {
        await events.close();
      }
      return fail("mcp_test_protocol_error");
    }
    await response.body?.cancel().catch(() => undefined);
    return fail("mcp_test_protocol_error");
  }

  async function notifyHttp(method: string): Promise<void> {
    const { response } = await send(new URL(target.url), {
      method: "POST",
      headers: jsonHeaders(),
      body: message(method, undefined, null),
    });
    statusFailure(response);
    await readText(response);
  }

  /** SSE: open the stream and wait for the endpoint event. */
  async function openStream(): Promise<void> {
    const { response, finalUrl } = await send(new URL(target.url), {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    statusFailure(response);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!type.startsWith("text/event-stream") || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      return fail("mcp_test_protocol_error");
    }
    stream = createSseEventReader(response.body, maxBytes * 2);
    for (;;) {
      let event;
      try {
        event = await stream.next();
      } catch (error) {
        throw failureOf(error, signal);
      }
      if (event === null) return fail("mcp_test_protocol_error");
      if (event.event !== "endpoint") continue;
      let endpoint: URL;
      try {
        endpoint = new URL(event.data.trim(), finalUrl);
      } catch {
        return fail("mcp_test_protocol_error");
      }
      if (endpoint.origin !== finalUrl.origin)
        return fail("mcp_test_protocol_error");
      if (!checkMcpUrl(endpoint.toString(), { ...policy, allowQuery: true }).ok)
        return fail("mcp_test_address_refused");
      postUrl = endpoint;
      return;
    }
  }

  async function postToEndpoint(body: string): Promise<void> {
    if (postUrl === null) return fail("mcp_test_protocol_error");
    const { response } = await send(postUrl, {
      method: "POST",
      headers: jsonHeaders(),
      body,
    });
    statusFailure(response);
    await readText(response);
  }

  async function callSse(
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    const id = nextId++;
    await postToEndpoint(message(method, params, id));
    if (stream === null) return fail("mcp_test_protocol_error");
    for (;;) {
      let event;
      try {
        event = await stream.next();
      } catch (error) {
        throw failureOf(error, signal);
      }
      if (event === null) return fail("mcp_test_protocol_error");
      if (event.event !== "message") continue;
      const answer = pickResponse(parseJson(event.data), id);
      if (answer !== undefined) return resultOf(answer);
    }
  }

  const call = (method: string, params?: unknown) =>
    target.transport === "sse"
      ? callSse(method, params)
      : callHttp(method, params);
  const notify = (method: string) =>
    target.transport === "sse"
      ? postToEndpoint(message(method, undefined, null))
      : notifyHttp(method);

  const text = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  try {
    if (target.transport === "sse") await openStream();
    const init = await call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "code-reviewer", version: "1" },
    });
    negotiated =
      typeof init.protocolVersion === "string" ? init.protocolVersion : null;
    const info = isRecord(init.serverInfo) ? init.serverInfo : {};
    await notify("notifications/initialized");

    const tools: McpToolInfo[] = [];
    let truncated = false;
    let cursor: string | undefined;
    for (let page = 0; page < MCP_TEST_MAX_PAGES; page++) {
      const result = await call(
        "tools/list",
        cursor === undefined ? undefined : { cursor },
      );
      if (!Array.isArray(result.tools)) return fail("mcp_test_protocol_error");
      for (const entry of result.tools as unknown[]) {
        if (
          !isRecord(entry) ||
          typeof entry.name !== "string" ||
          entry.name === ""
        )
          continue;
        if (tools.length >= maxTools) {
          truncated = true;
          break;
        }
        tools.push({
          name: text(entry.name, MCP_TOOL_NAME_MAX_LENGTH),
          description: text(entry.description, MCP_TOOL_DESCRIPTION_MAX_LENGTH),
        });
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor !== ""
          ? result.nextCursor
          : undefined;
      if (cursor === undefined || truncated) break;
      if (page === MCP_TEST_MAX_PAGES - 1) truncated = true;
    }

    // The session ends politely; whether the server cares is not a result of the test.
    if (target.transport === "streamable-http" && session !== null)
      await send(new URL(target.url), {
        method: "DELETE",
        headers: protocolHeaders(),
      })
        .then(({ response }) => response.body?.cancel())
        .catch(() => undefined);

    return {
      ok: true,
      serverName: text(info.name, 200) || null,
      serverVersion: text(info.version, 100) || null,
      protocolVersion: negotiated,
      tools,
      truncated,
    };
  } catch (error) {
    return { ok: false, code: failureOf(error, signal).code };
  } finally {
    const open: SseEventReader | null = stream;
    await open?.close();
  }
}
