// SPDX-License-Identifier: LicenseRef-Proprietary

// The rule for the address of an MCP server (#1050): what may be saved, and what a redirect may lead to. Text only; the check that counts
// for a name is made at the connection (`guarded-fetch.ts`: the name is resolved once and every address goes through the same rule).
// https only, no credentials, no fragment, and no host that names this machine,
// a private, link-local or reserved place or the metadata service. The test flag (`config.ts`) allows plain http and loopback, nothing else.
// A query string is allowed (#1122, the owner's decision): some servers name a connection in it (`?connection=<id>`).
import { isInternalHost } from "../runner-identity/delivery.ts";
import type { McpInputCode } from "./errors.ts";

export const MCP_URL_MAX_LENGTH = 2048;

export type McpUrlCheck =
  | { ok: true; url: string }
  | {
      ok: false;
      code: Extract<
        McpInputCode,
        | "mcp_url_invalid"
        | "mcp_url_not_https"
        | "mcp_url_credentials"
        | "mcp_url_private"
      >;
    };

export type McpUrlPolicy = {
  /** Plain http and this machine (the test stack only). */
  allowTestEndpoints: boolean;
};

export function checkMcpUrl(
  text: string,
  { allowTestEndpoints }: McpUrlPolicy,
): McpUrlCheck {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MCP_URL_MAX_LENGTH)
    return { ok: false, code: "mcp_url_invalid" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, code: "mcp_url_invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return { ok: false, code: "mcp_url_invalid" };
  if (url.hash !== "") return { ok: false, code: "mcp_url_invalid" };
  if (url.protocol === "http:" && !allowTestEndpoints)
    return { ok: false, code: "mcp_url_not_https" };
  if (url.username !== "" || url.password !== "")
    return { ok: false, code: "mcp_url_credentials" };
  if (isInternalHost(url.hostname, { allowLoopback: allowTestEndpoints }))
    return { ok: false, code: "mcp_url_private" };
  return { ok: true, url: url.toString() };
}
