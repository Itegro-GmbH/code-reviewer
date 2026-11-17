// SPDX-License-Identifier: LicenseRef-Proprietary

// What a person may enter for an MCP server (#1050): the name, the transport, the address and the authentication (none, or one or more
// headers). Pure: the form's JSON in, a checked value or ONE stable code out. The first problem is reported, in the order of the form.
// A header value is never echoed in a result and never part of a code. When a server is edited, a header may be kept without its value
// (`keep`): the stored, sealed value stays (the page only ever knows a name and a mask).
import type { McpInputCode } from "./errors.ts";
import { checkMcpUrl } from "./url.ts";

export const MCP_TRANSPORTS = ["streamable-http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** `oauth` is reserved for #1051: the column accepts it, the registry does not offer it yet. */
export const MCP_AUTH_KINDS = ["none", "header", "oauth"] as const;
export type McpAuthKind = (typeof MCP_AUTH_KINDS)[number];

export const MCP_NAME_MAX_LENGTH = 64;
export const MCP_HEADERS_MAX = 10;
export const MCP_HEADER_NAME_MAX_LENGTH = 100;
export const MCP_HEADER_VALUE_MAX_LENGTH = 4096;

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
// An HTTP token (RFC 9110, 5.6.2).
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// A header value is Latin-1 text (RFC 9110, 5.5: visible characters, space and tab; `fetch` refuses a character above U+00FF). No control
// character: a line break in a value would split the header.
const VALUE_CHARACTERS = /^[\t\u0020-\u007e\u00a0-\u00ff]*$/;

/** Names the client sets itself, or that would change what the request is. Compared in lower case. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "accept",
  "accept-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "cookie",
  "origin",
  "referer",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
]);

export type McpHeaderInput =
  { name: string; value: string } | { name: string; keep: true };

export type McpServerInput = {
  name: string;
  transport: McpTransport;
  url: string;
  auth:
    | { kind: "none" }
    | {
        kind: "header";
        /** In the order the person gave them; at least one. */
        headers: McpHeaderInput[];
      };
};

export type ParseMcpInputResult =
  { ok: true; value: McpServerInput } | { ok: false; code: McpInputCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The name of a server as it is saved, or null when it is not allowed. */
export function normalizeMcpName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || name.length > MCP_NAME_MAX_LENGTH) return null;
  return NAME.test(name) ? name : null;
}

function parseHeaders(
  raw: unknown,
  allowKeep: boolean,
): { ok: true; headers: McpHeaderInput[] } | { ok: false; code: McpInputCode } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MCP_HEADERS_MAX)
    return { ok: false, code: "mcp_headers_invalid" };
  const seen = new Set<string>();
  const headers: McpHeaderInput[] = [];
  for (const entry of raw as unknown[]) {
    if (!isRecord(entry) || typeof entry.name !== "string")
      return { ok: false, code: "mcp_headers_invalid" };
    const name = entry.name.trim();
    const lower = name.toLowerCase();
    if (
      name === "" ||
      name.length > MCP_HEADER_NAME_MAX_LENGTH ||
      !HEADER_NAME.test(name) ||
      seen.has(lower)
    )
      return { ok: false, code: "mcp_header_name_invalid" };
    if (
      FORBIDDEN_HEADERS.has(lower) ||
      lower.startsWith("proxy-") ||
      lower.startsWith("sec-")
    )
      return { ok: false, code: "mcp_header_name_forbidden" };
    seen.add(lower);
    if (entry.keep === true && entry.value === undefined) {
      if (!allowKeep) return { ok: false, code: "mcp_header_value_invalid" };
      headers.push({ name, keep: true });
      continue;
    }
    const value = entry.value;
    if (
      typeof value !== "string" ||
      value === "" ||
      value.length > MCP_HEADER_VALUE_MAX_LENGTH ||
      !VALUE_CHARACTERS.test(value) ||
      value !== value.trim()
    )
      return { ok: false, code: "mcp_header_value_invalid" };
    headers.push({ name, value });
  }
  return { ok: true, headers };
}

/**
 * Reads the JSON of the add or edit form. `allowKeep` is true when a server is edited: a header may then be `{ name, keep: true }`.
 * `allowTestEndpoints` is the test flag (`config.ts`).
 */
export function parseMcpServerInput(
  raw: unknown,
  options: { allowKeep: boolean; allowTestEndpoints: boolean },
): ParseMcpInputResult {
  if (!isRecord(raw)) return { ok: false, code: "mcp_name_invalid" };
  const name = normalizeMcpName(raw.name);
  if (name === null) return { ok: false, code: "mcp_name_invalid" };
  const transport = (MCP_TRANSPORTS as readonly unknown[]).includes(
    raw.transport,
  )
    ? (raw.transport as McpTransport)
    : null;
  if (transport === null) return { ok: false, code: "mcp_transport_invalid" };
  if (typeof raw.url !== "string")
    return { ok: false, code: "mcp_url_invalid" };
  const url = checkMcpUrl(raw.url, {
    allowTestEndpoints: options.allowTestEndpoints,
  });
  if (!url.ok) return { ok: false, code: url.code };
  if (!isRecord(raw.auth)) return { ok: false, code: "mcp_auth_invalid" };
  const kind = raw.auth.kind;
  if (kind === "oauth")
    return { ok: false, code: "mcp_auth_oauth_unavailable" };
  if (kind === "none")
    return {
      ok: true,
      value: { name, transport, url: url.url, auth: { kind: "none" } },
    };
  if (kind !== "header") return { ok: false, code: "mcp_auth_invalid" };
  const headers = parseHeaders(raw.auth.headers, options.allowKeep);
  if (!headers.ok) return { ok: false, code: headers.code };
  return {
    ok: true,
    value: {
      name,
      transport,
      url: url.url,
      auth: { kind: "header", headers: headers.headers },
    },
  };
}
