// SPDX-License-Identifier: LicenseRef-Proprietary

// One call to an address the authorization flow was told about (#1051): a discovery document, the registration endpoint, the token endpoint,
// or the MCP server's own first answer. EVERY such address is judged before the call (`checkMcpUrl`: https only, no credentials, no host that is
// this machine, private, link-local, reserved or the metadata service; the test flag opens plain http and loopback, nothing else), and the
// connection itself is made by the guarded fetch (`dispatch/guarded-fetch.ts`: the name is resolved once and every address is judged, so a name
// that resolves to a private place is refused at the socket whatever the text said). The authorization server may be on another origin than
// the MCP server, so this is asked of each address, not once. A redirect is NOT followed: a discovery document or an endpoint that moves is an
// answer to report, not a way to reach an address nobody checked. One deadline per call and a cap on the body. Nothing here logs an address, a
// header, a body or a token; a failure is a kind.
import { checkMcpUrl } from "../url.ts";

export const OAUTH_CALL_DEADLINE_MS = 10_000;
export const OAUTH_MAX_BODY_BYTES = 256 * 1024;
/** The code a guarded connection's error carries when it refused an address (`dispatch/guarded-fetch.ts`). */
const REFUSED_ADDRESS_CODE = "DELIVERY_ADDRESS_INTERNAL";

export type OAuthHttp = {
  /** The guarded fetch. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The test flag (`../config.ts`): plain http and this machine. */
  allowTestEndpoints: boolean;
  deadlineMs?: number;
  maxBytes?: number;
};

export type CallFailure = "address_refused" | "unreachable" | "too_large";

export type CallResult =
  | {
      ok: true;
      status: number;
      headers: Headers;
      text: string;
      /** The answer was a redirect: it was not followed and has no body. */
      redirect: boolean;
    }
  | { ok: false; kind: CallFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusedAddress(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 5 && current !== undefined && current !== null;
    depth++
  ) {
    if (isRecord(current) && current.code === REFUSED_ADDRESS_CODE) return true;
    current = isRecord(current) ? current.cause : undefined;
  }
  return false;
}

/** Whether an address may be called at all (text only; the connection judges the addresses a name resolves to). */
export function addressAllowed(url: string, http: OAuthHttp): boolean {
  return checkMcpUrl(url, {
    allowTestEndpoints: http.allowTestEndpoints,
    allowQuery: true,
  }).ok;
}

export async function callEndpoint(
  http: OAuthHttp,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    /** Only the status and the headers matter: the body (it may be a stream that never ends) is let go unread. */
    headersOnly?: boolean;
  },
): Promise<CallResult> {
  if (!addressAllowed(url, http)) return { ok: false, kind: "address_refused" };
  const signal = AbortSignal.timeout(http.deadlineMs ?? OAUTH_CALL_DEADLINE_MS);
  const maxBytes = http.maxBytes ?? OAUTH_MAX_BODY_BYTES;
  let response: Response;
  try {
    response = await http.fetch(url, {
      method: init.method,
      headers: init.headers ?? {},
      redirect: "manual",
      signal,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch (error) {
    return {
      ok: false,
      kind: refusedAddress(error) ? "address_refused" : "unreachable",
    };
  }
  if (
    init.headersOnly === true ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      text: "",
      redirect: init.headersOnly !== true,
    };
  }
  if (response.body === null)
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      text: "",
      redirect: false,
    };
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
        return { ok: false, kind: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return { ok: false, kind: "unreachable" };
  }
  return {
    ok: true,
    status: response.status,
    headers: response.headers,
    text: text + decoder.decode(),
    redirect: false,
  };
}

/** The JSON object a text holds, or undefined. */
export function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
