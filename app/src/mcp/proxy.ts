// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP proxy (#1053, epic #1049): what an agent's MCP call becomes on its way to the server. The agent's harness talks to a local endpoint at
// the sandbox door; the door sends the call to the app with the credential of the job (`worker-api.ts`, route `.../jobs/:id/mcp/:server`), and
// THIS module makes the call to the server with the credential of the server added. So the credential exists only here, in the headers of one
// outgoing request, and never in the sandbox.
//
// Threat model, in the order the rules below answer it:
// - The agent cannot name an address. The call names a server of the job (an id, resolved from the job's lane in `job-proxy.ts`); the address
//   is the stored one, checked again here as text and at the connection (the guarded fetch resolves a name once and refuses every address that is
//   not public; plain http and this machine only behind the test flag). There is no open proxy: nothing of the request but the JSON-RPC message,
//   the session id and the protocol version reaches the server, and the credential headers are never taken from the caller.
// - A redirect cannot lead the credential away: only a redirect on the server's own origin is followed (at most 3), any other is refused, so
//   the credential never goes to a second origin. The endpoint a legacy SSE server names for its POSTs must be on the origin of its stream.
// - What a server answers cannot start a sign-in in the agent's client: 401 and 403 are never passed on (a stable code, no challenge header).
// - The call is bounded: one deadline for the whole call, the size of the request and of the answer, a body that is one JSON-RPC message.
// - The proxy keeps no state between calls: a replay needs the credential of a running job (`worker-api.ts` checks it on every call).
// - What is recorded for each call (`McpCallMeta`, for the run's view and trace, #1055) holds the server id, the method, the name of a called
//   tool, the status, the duration and the sizes: never an argument, an answer, a header or an address.
//
// Transports toward the server:
// - Streamable HTTP: the POST is passed on; the answer is JSON or an event stream, passed on with the same limits. There is no stream of the
//   server's own to the agent (a GET is 405, as the specification allows), so every call stands for itself.
// - SSE (legacy): the server needs a session (a stream and an endpoint) for every conversation. The proxy keeps none between calls, so each
//   call opens a short session of its own: stream, endpoint, `initialize` and `notifications/initialized` (answered by the proxy for the
//   agent's own copies), the call, the answer from the stream, close. Three more round trips per call, and a server that keeps state across
//   calls of one session sees a new session each time. A limit of the legacy transport, written in `docs/`.
import { INTERNAL_ADDRESS_CODE } from "../dispatch/guarded-fetch.ts";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import { cleanText, MCP_PROTOCOL_VERSION } from "./client.ts";
import { createSseEventReader, SseTooLargeError } from "./sse.ts";
import { checkMcpUrl } from "./url.ts";

/**
 * One call may take this long, whatever it is doing. It is shorter than `maxDuration` of the Worker API's functions (60 s, `vercel.json`;
 * `proxy.test.ts` holds the two together), so a slow server ends in our own code `mcp_proxy_timeout` and never in the platform's gateway error.
 */
export const MCP_PROXY_DEADLINE_MS = 55_000;
export const MCP_PROXY_MAX_REQUEST_BYTES = 256 * 1024;
export const MCP_PROXY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const EVENT_MAX_LENGTH = 1024 * 1024;
const TOOL_NAME_MAX_LENGTH = 100;
const METHOD_MAX_LENGTH = 100;

/** What the agent's side is told. Stable words; never a value, an address or a body of the server. */
export const MCP_PROXY_ERROR_CODES = [
  "mcp_proxy_request_invalid",
  "mcp_proxy_request_too_large",
  "mcp_proxy_address_refused",
  "mcp_proxy_unreachable",
  "mcp_proxy_timeout",
  /** The server answered 401 or 403: the credential is wrong, revoked or too weak. */
  "mcp_proxy_unauthorized",
  "mcp_proxy_http_error",
  "mcp_proxy_redirect_refused",
  "mcp_proxy_response_too_large",
  "mcp_proxy_protocol_error",
] as const;
export type McpProxyErrorCode = (typeof MCP_PROXY_ERROR_CODES)[number];

const STATUS_OF: Record<McpProxyErrorCode, number> = {
  mcp_proxy_request_invalid: 400,
  mcp_proxy_request_too_large: 413,
  mcp_proxy_address_refused: 503,
  mcp_proxy_unreachable: 503,
  mcp_proxy_timeout: 503,
  mcp_proxy_unauthorized: 503,
  mcp_proxy_http_error: 503,
  mcp_proxy_redirect_refused: 503,
  mcp_proxy_response_too_large: 503,
  mcp_proxy_protocol_error: 503,
};

/** What is recorded for one call (#1055 reads it). Never an argument, an answer, a header or an address. */
export type McpCallMeta = {
  /** The job the call belongs to; null where the caller gave none. */
  jobId: string | null;
  serverId: string;
  /** The name of the server as it is now (the run's trace keeps it: the server may be renamed or removed later). */
  serverName: string;
  transport: string;
  /** The JSON-RPC method of the call (`tools/call`, `tools/list`, …), cleaned and cut to 100 characters like a tool name; null for a DELETE. */
  rpcMethod: string | null;
  /** The name of the tool, for `tools/call`, cut to 100 characters. */
  tool: string | null;
  /** The status the agent's side got. */
  status: number;
  /**
   * `ok`, the code the call ended with, or `cancelled`: the agent's side let go of an answer that was still arriving (the answer was passed on
   * up to there; `responseBytes` says how far).
   */
  outcome: "ok" | "cancelled" | McpProxyErrorCode;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
};

export type McpProxyRequest = {
  method: "POST" | "GET" | "DELETE";
  /** The JSON-RPC message of a POST; null for the others. */
  body: string | null;
  /** `Mcp-Session-Id` of the agent's client (a session the server made), passed on to a Streamable HTTP server. */
  sessionId: string | null;
  /** `MCP-Protocol-Version` of the agent's client. */
  protocolVersion: string | null;
};

export type McpProxyCall = {
  /** For the record of the call only. */
  jobId?: string;
  server: StoredMcpServer;
  /** The credential headers of the server (`credentials.ts`); they live in this call and nowhere else. */
  headers: Readonly<Record<string, string>>;
  request: McpProxyRequest;
};

export type McpProxyOptions = {
  /** The guarded fetch (it refuses an internal address at the connection). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The test flag (`config.ts`): plain http and this machine. */
  allowTestEndpoints: boolean;
  deadlineMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Called once for each call that reached the server's address (or failed on its way), when it is over. */
  onCall?: (meta: McpCallMeta) => void;
};

export type McpProxy = {
  forward(call: McpProxyCall): Promise<Response>;
};

class ProxyFailure extends Error {
  readonly code: McpProxyErrorCode;
  constructor(code: McpProxyErrorCode) {
    super(code);
    this.name = "ProxyFailure";
    this.code = code;
  }
}
const fail = (code: McpProxyErrorCode): never => {
  throw new ProxyFailure(code);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON-RPC id of a message, for the answer of an error (a request's id; null otherwise). */
type RpcMessage = {
  method: string;
  /** What is recorded of the method: it comes from the agent, so no control character and no line break, and short. */
  label: string;
  id: string | number | undefined;
  tool: string | null;
  text: string;
};

function parseMessage(body: string | null, maxBytes: number): RpcMessage {
  if (body === null || body === "") return fail("mcp_proxy_request_invalid");
  if (Buffer.byteLength(body, "utf8") > maxBytes)
    return fail("mcp_proxy_request_too_large");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return fail("mcp_proxy_request_invalid");
  }
  if (
    !isRecord(value) ||
    typeof value.method !== "string" ||
    value.method === ""
  )
    return fail("mcp_proxy_request_invalid");
  const id = value.id;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number")
    return fail("mcp_proxy_request_invalid");
  const params = isRecord(value.params) ? value.params : {};
  const tool =
    value.method === "tools/call" && typeof params.name === "string"
      ? cleanText(params.name).slice(0, TOOL_NAME_MAX_LENGTH)
      : null;
  return {
    method: value.method,
    label: cleanText(value.method).slice(0, METHOD_MAX_LENGTH),
    id,
    tool,
    text: body,
  };
}

const SESSION_ID = /^[!-~]{1,256}$/;
const PROTOCOL_VERSION = /^[0-9A-Za-z.-]{1,32}$/;

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function failureOf(error: unknown, signal: AbortSignal): ProxyFailure {
  if (error instanceof ProxyFailure) return error;
  if (signal.aborted) return new ProxyFailure("mcp_proxy_timeout");
  if (error instanceof SseTooLargeError)
    return new ProxyFailure("mcp_proxy_response_too_large");
  for (const entry of errorChain(error))
    if (isRecord(entry) && entry.code === INTERNAL_ADDRESS_CODE)
      return new ProxyFailure("mcp_proxy_address_refused");
  return new ProxyFailure("mcp_proxy_unreachable");
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

function errorResponse(
  code: McpProxyErrorCode,
  id: string | number | undefined,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32000, message: code },
    }),
    { status: STATUS_OF[code], headers: JSON_HEADERS },
  );
}

/** How the body of a passed-on answer ended. */
type StreamEnd =
  | { how: "end" }
  | { how: "cancelled" }
  | { how: "too_large" }
  | { how: "failed"; error: unknown };

/**
 * The body of a response, passed on as it arrives, ending with an error when it is longer than the cap. `done` is told the bytes and how it
 * ended, once, whatever the way: read to the end, past the cap, cut by the server or the deadline, or let go of by the consumer (which also lets go
 * of the server's stream: it is not left open).
 */
function cappedStream(
  body: ReadableStream<Uint8Array>,
  max: number,
  done: (bytes: number, end: StreamEnd) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  let told = false;
  const tell = (end: StreamEnd) => {
    if (told) return;
    told = true;
    done(total, end);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        tell({ how: "failed", error });
        controller.error(error);
        return;
      }
      if (chunk.done) {
        tell({ how: "end" });
        controller.close();
        return;
      }
      total += chunk.value.length;
      if (total > max) {
        tell({ how: "too_large" });
        await reader.cancel().catch(() => undefined);
        controller.error(new SseTooLargeError());
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      tell({ how: "cancelled" });
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export function createMcpProxy(options: McpProxyOptions): McpProxy {
  const deadlineMs = options.deadlineMs ?? MCP_PROXY_DEADLINE_MS;
  const maxRequest = options.maxRequestBytes ?? MCP_PROXY_MAX_REQUEST_BYTES;
  const maxResponse = options.maxResponseBytes ?? MCP_PROXY_MAX_RESPONSE_BYTES;
  const policy = {
    allowTestEndpoints: options.allowTestEndpoints,
    allowQuery: true,
  };

  async function forward({
    jobId,
    server,
    headers: credential,
    request,
  }: McpProxyCall): Promise<Response> {
    // The agent's side has no stream of its own to offer: every call is one request and one answer.
    if (request.method === "GET")
      return new Response(null, {
        status: 405,
        headers: { allow: "POST, DELETE", "cache-control": "no-store" },
      });

    const started = Date.now();
    const signal = AbortSignal.timeout(deadlineMs);
    let message: RpcMessage | undefined;
    let requestBytes = 0;
    let responseBytes = 0;

    const record = (status: number, outcome: McpCallMeta["outcome"]): void => {
      options.onCall?.({
        jobId: jobId ?? null,
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        rpcMethod: message?.label ?? null,
        tool: message?.tool ?? null,
        status,
        outcome,
        durationMs: Date.now() - started,
        requestBytes,
        responseBytes,
      });
    };

    try {
      if (request.sessionId !== null && !SESSION_ID.test(request.sessionId))
        return fail("mcp_proxy_request_invalid");
      if (
        request.protocolVersion !== null &&
        !PROTOCOL_VERSION.test(request.protocolVersion)
      )
        return fail("mcp_proxy_request_invalid");
      if (request.method === "POST") {
        message = parseMessage(request.body, maxRequest);
        requestBytes = Buffer.byteLength(message.text, "utf8");
      }
      const address = checkMcpUrl(server.url, policy);
      if (!address.ok) return fail("mcp_proxy_address_refused");
      const base = new URL(address.url);

      /** One request with redirects on the server's own origin followed by hand; the credential goes to that origin only. */
      async function send(
        url: URL,
        init: {
          method: string;
          headers: Record<string, string>;
          body?: string;
        },
      ): Promise<{ response: Response; finalUrl: URL }> {
        let current = url;
        for (let hop = 0; ; hop++) {
          let response: Response;
          try {
            response = await options.fetch(current.toString(), {
              method: init.method,
              headers: { ...init.headers, ...credential },
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
            return fail("mcp_proxy_redirect_refused");
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return fail("mcp_proxy_redirect_refused");
          }
          if (
            next.origin !== base.origin ||
            !checkMcpUrl(next.toString(), policy).ok
          )
            return fail("mcp_proxy_redirect_refused");
          current = next;
        }
      }

      async function release(response: Response): Promise<void> {
        await response.body?.cancel().catch(() => undefined);
      }

      /** An error status ends the call; the body of a server's error answer is never passed on. */
      async function statusFailure(response: Response): Promise<void> {
        if (response.ok) return;
        await release(response);
        if (response.status === 401 || response.status === 403)
          fail("mcp_proxy_unauthorized");
        fail("mcp_proxy_http_error");
      }

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
            if (total > maxResponse) {
              await reader.cancel().catch(() => undefined);
              return fail("mcp_proxy_response_too_large");
            }
            text += decoder.decode(value, { stream: true });
          }
        } catch (error) {
          throw failureOf(error, signal);
        }
        responseBytes = total;
        return text + decoder.decode();
      }

      const finished = (response: Response): Response => {
        record(response.status, "ok");
        return response;
      };

      // ---- Streamable HTTP ----
      async function viaStreamableHttp(): Promise<Response> {
        const upstream: Record<string, string> = {
          ...(request.method === "POST"
            ? {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              }
            : {}),
          ...(request.protocolVersion === null
            ? {}
            : { "mcp-protocol-version": request.protocolVersion }),
          ...(request.sessionId === null
            ? {}
            : { "mcp-session-id": request.sessionId }),
        };
        const { response } = await send(base, {
          method: request.method,
          headers: upstream,
          ...(message === undefined ? {} : { body: message.text }),
        });
        if (request.method === "DELETE" && response.status === 405) {
          await release(response);
          return finished(new Response(null, { status: 405 }));
        }
        await statusFailure(response);
        const session = response.headers.get("mcp-session-id");
        const extra: Record<string, string> =
          session !== null && SESSION_ID.test(session)
            ? { "mcp-session-id": session }
            : {};
        if (response.status === 202 || response.status === 204) {
          await release(response);
          return finished(
            new Response(null, { status: response.status, headers: extra }),
          );
        }
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (request.method === "DELETE") {
          await release(response);
          return finished(
            new Response("{}", { status: 200, headers: JSON_HEADERS }),
          );
        }
        if (type.startsWith("application/json")) {
          const text = await readText(response);
          return finished(
            new Response(text, {
              status: 200,
              headers: { ...JSON_HEADERS, ...extra },
            }),
          );
        }
        if (type.startsWith("text/event-stream") && response.body !== null) {
          // Passed on as it arrives, bounded; the call is recorded when the stream has ended.
          const body = cappedStream(
            response.body,
            maxResponse,
            (bytes, end) => {
              responseBytes = bytes;
              record(
                200,
                end.how === "end"
                  ? "ok"
                  : end.how === "cancelled"
                    ? "cancelled"
                    : end.how === "too_large"
                      ? "mcp_proxy_response_too_large"
                      : failureOf(end.error, signal).code,
              );
            },
          );
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              ...extra,
            },
          });
        }
        await release(response);
        return fail("mcp_proxy_protocol_error");
      }

      // ---- SSE (legacy): a short session for the call ----
      async function viaSse(): Promise<Response> {
        const call = message;
        if (call === undefined) return fail("mcp_proxy_request_invalid");
        // The agent's own initialized notification is the proxy's to answer: the session it would belong to is gone before the next call.
        if (call.method === "notifications/initialized")
          return finished(new Response(null, { status: 202 }));
        const { response, finalUrl } = await send(base, {
          method: "GET",
          headers: { accept: "text/event-stream" },
        });
        await statusFailure(response);
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (!type.startsWith("text/event-stream") || response.body === null) {
          await release(response);
          return fail("mcp_proxy_protocol_error");
        }
        const stream = createSseEventReader(
          response.body,
          maxResponse * 2,
          Math.min(maxResponse, EVENT_MAX_LENGTH),
        );
        try {
          let endpoint: URL | undefined;
          while (endpoint === undefined) {
            const event = await stream.next().catch((error: unknown) => {
              throw failureOf(error, signal);
            });
            if (event === null) return fail("mcp_proxy_protocol_error");
            if (event.event !== "endpoint") continue;
            let target: URL;
            try {
              target = new URL(event.data.trim(), finalUrl);
            } catch {
              return fail("mcp_proxy_protocol_error");
            }
            if (target.origin !== finalUrl.origin)
              return fail("mcp_proxy_protocol_error");
            const checked = checkMcpUrl(target.toString(), policy);
            if (!checked.ok) return fail("mcp_proxy_address_refused");
            endpoint = target;
          }
          const postUrl = endpoint;

          async function postMessage(text: string): Promise<void> {
            const { response: posted } = await send(postUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: text,
            });
            await statusFailure(posted);
            await readText(posted);
          }

          async function answerTo(id: string | number): Promise<string> {
            for (;;) {
              const event = await stream.next().catch((error: unknown) => {
                throw failureOf(error, signal);
              });
              if (event === null) return fail("mcp_proxy_protocol_error");
              if (event.event !== "message") continue;
              let value: unknown;
              try {
                value = JSON.parse(event.data);
              } catch {
                return fail("mcp_proxy_protocol_error");
              }
              if (
                isRecord(value) &&
                value.id === id &&
                ("result" in value || "error" in value)
              ) {
                const text = JSON.stringify(value);
                responseBytes = Buffer.byteLength(text, "utf8");
                return text;
              }
            }
          }

          if (call.method !== "initialize") {
            await postMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                id: "proxy-initialize",
                method: "initialize",
                params: {
                  protocolVersion: MCP_PROTOCOL_VERSION,
                  capabilities: {},
                  clientInfo: { name: "code-reviewer", version: "1" },
                },
              }),
            );
            await answerTo("proxy-initialize");
            await postMessage(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              }),
            );
          }
          await postMessage(call.text);
          if (call.id === undefined)
            return finished(new Response(null, { status: 202 }));
          return finished(
            new Response(await answerTo(call.id), {
              status: 200,
              headers: JSON_HEADERS,
            }),
          );
        } finally {
          await stream.close();
        }
      }

      return server.transport === "sse"
        ? await viaSse()
        : await viaStreamableHttp();
    } catch (error) {
      const failure = failureOf(error, signal);
      record(STATUS_OF[failure.code], failure.code);
      return errorResponse(failure.code, message?.id);
    }
  }

  return { forward };
}
