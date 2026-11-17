// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the MCP page (#1050). The routes answer with stable codes (`../errors.ts`); this is where a code becomes a sentence (the UI
// translates codes, never the other way round). Nothing a response carried is put into a sentence except the names of lanes (which are
// names a person gave them) and a number. `messages.test.ts` fails for a code of the routes or of a test result without a sentence.
import { CROSS_SITE_REQUEST_RELOAD_PAGE } from "../../copy/messages.ts";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import {
  MCP_ERROR_CODES,
  MCP_TEST_ERROR_CODES,
  type McpErrorCode,
  type McpTestErrorCode,
} from "../errors.ts";
import {
  isMcpOAuthResultCode,
  MCP_OAUTH_FAILURE_CODES,
  type McpOAuthFailureCode,
  type McpOAuthResultCode,
} from "../oauth/errors.ts";

export const PAGE_COPY = {
  title: "MCP",
  description:
    "Remote MCP servers your agents may use. Add the address of a server, test the connection and see which tools it offers. The keys stay on the server: an agent never sees them.",
  loading: "Loading",
  tryAgain: "Try again",
  empty: "No MCP server yet. Owners and Admins can add one.",
  count: (count: number) => `MCP servers · ${String(count)}`,
  add: "Add MCP server",
  addFromCatalog: "Add from catalog",
  catalogTitle: "MCP server catalog",
  catalogDescription:
    "Servers that vendors run themselves, with the address read from their own documentation. Choosing one only fills in the form: nothing is saved until you save it.",
  catalogOpen: "Choose",
  catalogOauth: "OAuth",
  catalogHeader: (name: string) => `Header ${name}`,
  catalogChecked: (day: string) => `Checked ${day}`,
  catalogDocs: "Vendor documentation",
  fromCatalog: (name: string) => `From the catalog: ${name}`,
  catalogOauthNext:
    "After saving you are asked to connect: the browser goes to the vendor's authorization server once you confirm.",
  catalogHeaderNext: (name: string) =>
    `Enter the value of the ${name} header below. It is stored sealed and never shown again.`,
  edit: "Edit",
  remove: "Remove",
  test: "Test connection",
  testing: "Testing…",
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  added: "The server was added.",
  saved: "The server was saved.",
  removed: "The server was removed.",
  removeTitle: "Remove this MCP server?",
  removeNote:
    "Its stored keys are deleted. A lane that uses it has to stop using it first.",
  removeConfirm: "Remove",
  inUse: (lanes: string) =>
    `A lane still uses this server: ${lanes}. Take it out of the lane first.`,
  transport: "Transport",
  address: "Address",
  authentication: "Authentication",
  headers: "Headers",
  headersHint:
    "Keys and tokens belong here, in a header, and not in the address or its path: a header value is stored sealed and never shown again.",
  noHeaders: "None",
  lastTest: "Last test",
  neverTested: "Not tested yet. Test the connection to see its tools.",
  testedAt: "Tested",
  tools: (count: number, truncated: boolean) =>
    `${truncated ? "First " : ""}${String(count)} ${count === 1 ? "tool" : "tools"}${truncated ? " (the list is cut)" : ""}`,
  noTools: "The server lists no tools.",
  serverIs: "Server",
  mask: "••••••••",
  formAddTitle: "Add MCP server",
  formEditTitle: "Edit MCP server",
  formDescription:
    "Remote servers only: Streamable HTTP or SSE, over https. Local servers started by a command are not supported.",
  nameLabel: "Name",
  nameHint: "Letters, digits, spaces, dots, dashes and underscores.",
  transportLabel: "Transport",
  urlLabel: "Address",
  urlHint:
    "An https address without a key in it, not even in its path: keys belong in a header below, where they are stored sealed.",
  authLabel: "Authentication",
  headerNameLabel: "Header name",
  headerValueLabel: "Header value",
  headerKept: "Stored. Leave empty to keep it.",
  headerReenter:
    "The address or the transport changed: enter this value again.",
  addHeader: "Add header",
  removeHeader: "Remove header",
  connect: "Connect",
  reconnect: "Reconnect",
  connecting: "Opening the consent page…",
  oauthUnconnected: "Not connected yet. Connect to grant access.",
  oauthConnected: "Connected.",
  oauthBroken:
    "The authorization server ended the grant. Reconnect to grant access again.",
  oauthClient: "OAuth client",
  oauthClientRegistered: "Registered by this server when it connects",
  oauthClientManual: "Entered by an Owner or Admin",
  oauthScopes: "Scopes",
  oauthClientIssuer: "Issuer",
  oauthClientIssuerLabel: "Issuer (required with a client ID)",
  oauthClientIssuerHint:
    "The https address of the authorization server the client belongs to. The client secret is sent only to this server: Connect refuses when the MCP server names another one.",
  oauthClientIdLabel: "OAuth client ID (optional)",
  oauthClientSecretLabel: "OAuth client secret (optional)",
  oauthClientHint:
    "Leave both empty: the server registers this application itself. Enter a client only if its authorization server has no dynamic registration.",
  oauthCallbackHint: (callbackUrl: string) =>
    `Register this redirect address for the client: ${callbackUrl}`,
  oauthSecretKept: "Stored. Leave empty to keep it.",
  oauthSecretReenter:
    "The address, the transport, the client ID or the issuer changed: enter the secret again.",
  consentTitle: (host: string) => `Continue to ${host}?`,
  consentBody: (server: string, host: string) =>
    `You are about to be sent to ${host} to let this workspace use ${server}. Check that this is the authorization server you expect.`,
  consentScopes: "Access asked for",
  consentNoScopes: "No scope is named; the authorization server decides.",
  consentContinue: "Continue",
  consentCancel: "Cancel",
  oauthChangeNote:
    "Changing the address, the transport or the client ends the connection: connect again afterwards.",
} as const;

export const TRANSPORT_COPY: Record<string, string> = {
  "streamable-http": "Streamable HTTP",
  sse: "SSE (older)",
};

export const AUTH_COPY: Record<string, string> = {
  none: "No authentication",
  header: "Header (API key or token)",
  oauth: "OAuth",
};

const failureCopy = (): Record<McpErrorCode, string> => ({
  mcp_name_invalid:
    "The name is empty, longer than 64 characters, or has characters other than letters, digits, spaces, dots, dashes and underscores.",
  mcp_name_taken: "Another server of this workspace has this name.",
  mcp_transport_invalid: "Choose Streamable HTTP or SSE.",
  mcp_url_invalid:
    "This is not a usable address. Enter an https address without a fragment.",
  mcp_url_not_https: "Only https addresses are allowed.",
  mcp_url_credentials:
    "The address must not hold a user name or a password. Use a header for the key.",
  mcp_url_query:
    "The address must not have a query string, because a key in it would be shown to everybody. Use a header for the key.",
  mcp_url_private:
    "The address names this machine or a private or internal network. Only public servers can be used.",
  mcp_auth_invalid: "Choose no authentication, a header or OAuth.",
  mcp_oauth_client_invalid:
    "The client ID or secret is empty where it must not be, too long, or has characters other than visible ASCII. A secret needs a client ID.",
  mcp_oauth_issuer_invalid:
    "The issuer must be the https address of the authorization server the client ID belongs to, without a query or fragment.",
  mcp_oauth_secret_required:
    "A stored client secret is only kept for the same address, transport, client ID and issuer. Enter the secret again.",
  mcp_headers_invalid: "Add at least one header, and at most ten.",
  mcp_header_name_invalid:
    "A header name has characters that are not allowed, or appears twice.",
  mcp_header_name_forbidden:
    "This header is set by the connection itself (for example Host, Content-Type or Accept). Choose another name.",
  mcp_header_value_invalid:
    "A header value is empty, has spaces at its ends, a line break or another control character, a character outside Latin-1 (such as an emoji or a typographic quote), or is longer than 4096 characters.",
  mcp_header_unknown:
    "A header kept without a value is not stored any more. Enter its value again.",
  mcp_header_value_required:
    "The address or the transport changed. A stored key is only sent to the address it was entered for, so enter the header values again.",
  forbidden: "Only an Owner or an Admin can change MCP servers.",
  mcp_server_not_found: "This server does not exist any more. Reload the page.",
  mcp_server_in_use:
    "A lane still uses this server. Take it out of the lane first.",
  mcp_limit_reached: "The workspace holds as many MCP servers as it may.",
  mcp_revision_required:
    "The form is out of date. Reload the page and try again.",
  mcp_server_changed:
    "The server was changed by someone else while you worked. Reload the page and try again.",
  rate_limited: "Too many connection tests. Wait a few minutes and try again.",
  unavailable: "The server could not be changed right now. Try again.",
});

/** Why starting "Connect" did not work: what is wrong with the server or its authorization server. */
const oauthFailureCopy: Record<McpOAuthFailureCode, string> = {
  mcp_oauth_not_oauth:
    "This server does not use OAuth. Change its authentication first.",
  mcp_oauth_discovery_failed:
    "The server does not say which authorization server to use, or its answer is not what the OAuth standards describe. Check the address and that the server supports OAuth.",
  mcp_oauth_address_refused:
    "An address the server named for OAuth is private, internal or not https, so it was not called.",
  mcp_oauth_pkce_unsupported:
    "The authorization server does not support PKCE with S256, so it cannot be used safely.",
  mcp_oauth_client_required:
    "The authorization server cannot register this application by itself. Edit the server and enter a client ID (and secret) from its authorization server.",
  mcp_oauth_registration_failed:
    "The authorization server refused to register this application. Edit the server and enter a client ID (and secret) instead.",
  mcp_oauth_unreachable:
    "The authorization server could not be reached or did not answer in time. Try again.",
  mcp_oauth_issuer_mismatch:
    "The client ID and secret you entered are for another authorization server than the one this server names, so they were not sent there. Edit the server and enter the issuer of the authorization server the client belongs to.",
};

/** How the way back from the authorization server ended (shown once on the page). */
const oauthResultCopy: Record<McpOAuthResultCode, string> = {
  connected: "Connected. The server's tools are being listed.",
  state_invalid:
    "The connection was not made: the link was used before, expired, or was started in another browser session. Start again.",
  access_denied: "Access was not granted.",
  mcp_oauth_authorization_refused:
    "The authorization server did not grant access. Start again.",
  mcp_oauth_client_refused:
    "The authorization server does not accept the OAuth client. Check the client ID and secret.",
  workspace_role_required: "Only an Owner or an Admin can connect a server.",
  mcp_server_not_found: "This server does not exist any more.",
  mcp_server_changed:
    "The server was changed while you were at the consent page. Start again.",
  mcp_oauth_unreachable:
    "The authorization server could not be reached or did not answer in time. Try again.",
  mcp_oauth_address_refused:
    "An address of the authorization server is private, internal or not https, so it was not called.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "The connection could not be made right now. Try again.",
};

/** The sentence for the result code in the address of the page, or null when it is none of ours. */
export function describeMcpOAuthResult(code: unknown): string | null {
  return isMcpOAuthResultCode(code) ? oauthResultCopy[code] : null;
}

const CROSS_SITE_CODES = ["cross_site_request"];
const TOO_LARGE_CODES = ["body_too_large"];

export type McpFailure = {
  code: string;
  status?: number | null;
  /** On `mcp_server_in_use`: the lanes that name the server (the names and projects a person gave them). */
  lanes?: { name: string; projectName: string | null }[];
};

export function describeLanes(
  lanes: { name: string; projectName: string | null }[],
): string {
  return lanes
    .map((lane) =>
      lane.projectName === null
        ? lane.name
        : `${lane.name} (${lane.projectName})`,
    )
    .join(", ");
}

function hasCopy(code: string): code is McpErrorCode {
  return (MCP_ERROR_CODES as readonly string[]).includes(code);
}

/** The sentence for the code an answer carried (or a transport code). */
export function describeMcpFailure(
  product: ProductIdentity,
  failure: McpFailure,
): string {
  if (failure.code === "mcp_server_in_use" && (failure.lanes?.length ?? 0) > 0)
    return PAGE_COPY.inUse(describeLanes(failure.lanes ?? []));
  if (hasCopy(failure.code)) return failureCopy()[failure.code];
  if ((MCP_OAUTH_FAILURE_CODES as readonly string[]).includes(failure.code))
    return oauthFailureCopy[failure.code as McpOAuthFailureCode];
  if (CROSS_SITE_CODES.includes(failure.code))
    return CROSS_SITE_REQUEST_RELOAD_PAGE;
  if (TOO_LARGE_CODES.includes(failure.code))
    return "The form is too large to send.";
  if (
    failure.code === "unsupported_content_type" ||
    failure.code === "invalid_input"
  )
    return "The form could not be read. Reload the page and try again.";
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}

const testCopy: Record<McpTestErrorCode, string> = {
  mcp_test_unreachable:
    "The server could not be reached. Check the address and that the server is up.",
  mcp_test_timeout: "The server did not answer in time.",
  mcp_test_address_refused:
    "The address leads to a private or internal place and was not connected to.",
  mcp_test_redirect_refused:
    "The server redirected to an address that is not allowed, or too often.",
  mcp_test_unauthorized:
    "The server refused the credentials (401 or 403). Check the headers.",
  mcp_test_http_error:
    "The server answered with an error status. Check the address and the transport.",
  mcp_test_protocol_error:
    "The server did not answer like an MCP server of this transport. Check the address and the transport.",
  mcp_test_rejected: "The server rejected the MCP request.",
  mcp_test_too_large: "The server's answer is larger than the test reads.",
  mcp_test_credentials_unreadable:
    "The stored headers cannot be read any more. Enter them again.",
  mcp_test_oauth_not_connected: "Not connected yet. Connect the server first.",
  mcp_test_oauth_broken:
    "The authorization server ended the grant. Reconnect the server.",
  mcp_test_oauth_unavailable:
    "The access could not be renewed right now. Try again; if it keeps failing, the operator's log says why.",
};

/** The sentence for how a test ended; an unknown code (a newer server) is a plain failure. */
export function describeTestFailure(code: string | null): string {
  if (
    code !== null &&
    (MCP_TEST_ERROR_CODES as readonly string[]).includes(code)
  )
    return testCopy[code as McpTestErrorCode];
  return "The test failed.";
}
