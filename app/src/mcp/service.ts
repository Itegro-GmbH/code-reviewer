// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP registry of ONE workspace (#1050, epic #1049): add, change, test and remove the remote MCP servers the workspace's agents may use.
// The service takes the repository of the workspace, the key to seal the header values with, and the fetch the connection test uses, so
// tests wire the real service over a test database and the fake MCP server, and the running server wires the guarded fetch (`shared.ts`).
//
// What it keeps true, on top of the repository:
// - what a person enters is checked once (`input.ts`), the first problem answered with one stable code;
// - the header values are sealed here with the table, the row id and the field bound into the ciphertext (`sealHeaders`), and opened only to
//   keep a value on an edit, for a connection test, and (#1053) for the proxy at the sandbox's door. A `McpServerView` (what the pages and
//   the API read) holds the NAMES of the headers and never a value; nothing here logs a value, an address or a body;
// - a test is rate limited per workspace (it makes this server connect to an address a person entered) and its result is stored only for the
//   revision of the server that was tested;
// - removing a server is refused while a lane names it, and the answer names the lanes.
// Who may do what is the route's (src/mcp/http.ts: `manage_mcp` for everything but the list).
import {
  decryptSecret,
  encryptSecret,
  SecretBoxError,
} from "../crypto/secret-box.ts";
import type {
  CurrentMcpServer,
  LaneUsingMcpServer,
  McpServerChange,
  McpServersRepository,
  McpToolsSnapshot,
  McpTestStatus,
  SealedHeaders,
  StoredMcpServer,
} from "../db/repositories/mcp-servers-repository.ts";
import type { RateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { secondsLeft } from "../auth/sign-in-limit.ts";
import { testMcpServer, type McpTestOptions } from "./client.ts";
import type { McpErrorCode } from "./errors.ts";
import { parseMcpServerInput, type McpServerInput } from "./input.ts";

/** How many servers a workspace may hold. */
export const MCP_SERVERS_MAX = 50;
export const MCP_TEST_WINDOW_MS = 10 * 60 * 1000;
export const MCP_TEST_WORKSPACE_MAX = 30;
export const MCP_TEST_INSTANCE_MAX = 2000;

const TABLE = "mcp_servers";
const FIELD = "headers";

/** A server as the page and the API show it: the names of the headers, never a value. */
export type McpServerView = {
  id: string;
  name: string;
  transport: string;
  url: string;
  auth: string;
  /** The names of the sealed headers; their values are never read out. */
  headers: string[];
  revision: number;
  status: McpTestStatus;
  testedAt: string | null;
  testErrorCode: string | null;
  /** What the last successful test listed. */
  tools: McpToolsSnapshot | null;
  createdAt: string;
  updatedAt: string;
};

export function toView(server: StoredMcpServer): McpServerView {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    auth: server.authKind,
    headers: server.headerNames,
    revision: server.revision,
    status: server.testStatus,
    testedAt: server.testedAt,
    testErrorCode: server.testErrorCode,
    tools: server.snapshot,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export type McpServiceFailure = {
  ok: false;
  error: McpErrorCode;
  /** On `mcp_server_in_use`: the lanes that name the server. */
  lanes?: LaneUsingMcpServer[];
  retryAfterSeconds?: number;
};

export type McpServiceResult<T> = { ok: true; value: T } | McpServiceFailure;

export type McpService = {
  list(): Promise<McpServerView[]>;
  create(
    actor: { id: string },
    raw: unknown,
  ): Promise<McpServiceResult<McpServerView>>;
  /** `raw` is the form; `raw.revision` is the revision the form was made from and is required (`mcp_revision_required`). */
  update(id: string, raw: unknown): Promise<McpServiceResult<McpServerView>>;
  remove(id: string): Promise<McpServiceResult<{ removed: true }>>;
  /** Connects to the server as an MCP client, stores what it found and returns the server with the result. */
  test(id: string): Promise<McpServiceResult<McpServerView>>;
};

export type McpServiceOptions = {
  workspaceId: string;
  repository: McpServersRepository;
  rateLimits: RateLimitsRepository;
  appSecret: string;
  /** The guarded fetch of the connection test. */
  fetch: McpTestOptions["fetch"];
  /** The test flag (`config.ts`). */
  allowTestEndpoints: boolean;
  /** Limits of the test; tests make them small. */
  testLimits?: Pick<
    McpTestOptions,
    "deadlineMs" | "maxResponseBytes" | "maxTools"
  >;
  now?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
};

/** Seals the headers of a server for its row: the table, the row id and the field are bound into the ciphertext. */
export function sealHeaders(
  appSecret: string,
  serverId: string,
  headers: readonly { name: string; value: string }[],
): SealedHeaders {
  const sealed = encryptSecret(
    appSecret,
    { table: TABLE, rowId: serverId, field: FIELD },
    JSON.stringify(headers.map((header) => [header.name, header.value])),
  );
  return {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    keyVersion: sealed.keyVersion,
  };
}

/** The headers of a server as name and value in the order they were given, or null when they cannot be read. */
export function openHeaders(
  appSecret: string,
  serverId: string,
  sealed: SealedHeaders,
): { name: string; value: string }[] | null {
  try {
    const value: unknown = JSON.parse(
      decryptSecret(
        appSecret,
        { table: TABLE, rowId: serverId, field: FIELD },
        sealed,
      ),
    );
    if (!Array.isArray(value)) return null;
    const headers: { name: string; value: string }[] = [];
    for (const entry of value as unknown[]) {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string"
      )
        return null;
      headers.push({ name: entry[0], value: entry[1] });
    }
    return headers;
  } catch (error) {
    if (error instanceof SecretBoxError || error instanceof SyntaxError)
      return null;
    throw error;
  }
}

const fail = (
  error: McpErrorCode,
  more: Partial<McpServiceFailure> = {},
): McpServiceFailure => ({
  ok: false,
  error,
  ...more,
});

const fieldsOf = (input: McpServerInput) => ({
  name: input.name,
  transport: input.transport,
  url: input.url,
  authKind: input.auth.kind,
  headerNames:
    input.auth.kind === "header"
      ? input.auth.headers.map((header) => header.name)
      : [],
});

/**
 * The change an edit makes to the row it is applied to (the row as it is under the lock, so a kept value is read in the same transaction that
 * writes), or the code it is refused with. A header value is sealed for the address it was entered for: when the address or the transport
 * changes, `keep` is refused and every value has to be entered again, so an edit cannot send a stored key to another place.
 */
export function planMcpUpdate(
  appSecret: string,
  serverId: string,
  current: CurrentMcpServer,
  input: McpServerInput,
  log: (line: string) => void,
): McpServerChange | { refused: McpErrorCode } {
  const { auth } = input;
  if (auth.kind === "none") return { ...fieldsOf(input), sealed: null };
  const keeps = auth.headers.some((header) => "keep" in header);
  if (!keeps)
    return {
      ...fieldsOf(input),
      sealed: sealHeaders(
        appSecret,
        serverId,
        auth.headers as { name: string; value: string }[],
      ),
    };
  if (
    current.server.url !== input.url ||
    current.server.transport !== input.transport
  )
    return { refused: "mcp_header_value_required" };
  const opened =
    current.sealed === null
      ? null
      : openHeaders(appSecret, serverId, current.sealed);
  if (opened === null) {
    log(`[mcp] MCP_HEADERS_UNREADABLE: server ${serverId} (kept headers).`);
    return { refused: "mcp_header_unknown" };
  }
  const byName = new Map(
    opened.map((header) => [header.name.toLowerCase(), header.value]),
  );
  const resolved: { name: string; value: string }[] = [];
  for (const entry of auth.headers) {
    if ("value" in entry) {
      resolved.push(entry);
      continue;
    }
    const value = byName.get(entry.name.toLowerCase());
    if (value === undefined) return { refused: "mcp_header_unknown" };
    resolved.push({ name: entry.name, value });
  }
  // Nothing to seal again when every header is kept, in the same order.
  const unchanged =
    current.server.authKind === "header" &&
    auth.headers.every(
      (header, index) =>
        "keep" in header && header.name === current.server.headerNames[index],
    ) &&
    auth.headers.length === current.server.headerNames.length;
  return unchanged
    ? fieldsOf(input)
    : {
        ...fieldsOf(input),
        sealed: sealHeaders(appSecret, serverId, resolved),
      };
}

export function createMcpService(options: McpServiceOptions): McpService {
  const {
    workspaceId,
    repository,
    rateLimits,
    appSecret,
    allowTestEndpoints,
    now = () => new Date(),
    newId = () => crypto.randomUUID(),
    log = (line) => console.error(line),
  } = options;

  async function hitTestLimit(): Promise<McpServiceFailure | null> {
    const instance = await rateLimits.hit("mcp-test:all", MCP_TEST_WINDOW_MS);
    const own =
      instance.count > MCP_TEST_INSTANCE_MAX
        ? instance
        : await rateLimits.hit(
            `mcp-test:workspace:${workspaceId}`,
            MCP_TEST_WINDOW_MS,
          );
    const limited =
      instance.count > MCP_TEST_INSTANCE_MAX ||
      own.count > MCP_TEST_WORKSPACE_MAX;
    if (!limited) return null;
    if (own !== instance) await rateLimits.refund("mcp-test:all");
    return fail("rate_limited", {
      retryAfterSeconds: secondsLeft(
        own.windowStartedAt,
        MCP_TEST_WINDOW_MS,
        now(),
      ),
    });
  }

  return {
    async list() {
      return (await repository.list()).map(toView);
    },

    async create(actor, raw) {
      const parsed = parseMcpServerInput(raw, {
        allowKeep: false,
        allowTestEndpoints,
      });
      if (!parsed.ok) return fail(parsed.code);
      const id = newId();
      const { auth } = parsed.value;
      const created = await repository.create(
        {
          id,
          ...fieldsOf(parsed.value),
          sealed:
            auth.kind === "header"
              ? sealHeaders(
                  appSecret,
                  id,
                  auth.headers as { name: string; value: string }[],
                )
              : null,
          createdBy: actor.id,
        },
        MCP_SERVERS_MAX,
      );
      if (!created.ok)
        return fail(
          created.reason === "name_taken"
            ? "mcp_name_taken"
            : "mcp_limit_reached",
        );
      return { ok: true, value: toView(created.server) };
    },

    async update(id, raw) {
      const parsed = parseMcpServerInput(raw, {
        allowKeep: true,
        allowTestEndpoints,
      });
      if (!parsed.ok) return fail(parsed.code);
      // The form says which revision it was made from; without it a change could silently replace one the person never saw.
      const asked =
        typeof raw === "object" && raw !== null && "revision" in raw
          ? (raw as { revision: unknown }).revision
          : undefined;
      if (typeof asked !== "number" || !Number.isInteger(asked) || asked < 1)
        return fail("mcp_revision_required");
      const changed = await repository.update(id, asked, (current) =>
        planMcpUpdate(appSecret, id, current, parsed.value, log),
      );
      if (!changed.ok) {
        if (changed.reason === "refused")
          return fail(changed.code as McpErrorCode);
        return fail(
          changed.reason === "name_taken"
            ? "mcp_name_taken"
            : changed.reason === "changed"
              ? "mcp_server_changed"
              : "mcp_server_not_found",
        );
      }
      return { ok: true, value: toView(changed.server) };
    },

    async remove(id) {
      const removed = await repository.removeUnlessUsed(id);
      if (removed.removed) return { ok: true, value: { removed: true } };
      if (removed.reason === "not_found") return fail("mcp_server_not_found");
      return fail("mcp_server_in_use", { lanes: removed.lanes });
    },

    async test(id) {
      const stored = await repository.readHeaders(id);
      if (stored === undefined) return fail("mcp_server_not_found");
      const limited = await hitTestLimit();
      if (limited !== null) return limited;
      const { server } = stored;
      let headers: { name: string; value: string }[] = [];
      let unreadable = false;
      if (server.authKind === "header") {
        const opened =
          stored.sealed === null
            ? null
            : openHeaders(appSecret, id, stored.sealed);
        if (opened === null) {
          unreadable = true;
          log(`[mcp] MCP_HEADERS_UNREADABLE: server ${id} (test).`);
        } else headers = opened;
      }
      const result = unreadable
        ? ({ ok: false, code: "mcp_test_credentials_unreadable" } as const)
        : await testMcpServer(
            {
              url: server.url,
              transport: server.transport === "sse" ? "sse" : "streamable-http",
              headers: Object.fromEntries(
                headers.map((header) => [header.name, header.value]),
              ),
            },
            {
              fetch: options.fetch,
              allowTestEndpoints,
              ...options.testLimits,
            },
          );
      const recorded = await repository.recordTest(
        id,
        server.revision,
        result.ok
          ? {
              ok: true,
              snapshot: {
                serverName: result.serverName,
                serverVersion: result.serverVersion,
                protocolVersion: result.protocolVersion,
                tools: result.tools,
                truncated: result.truncated,
              },
            }
          : { ok: false, code: result.code },
      );
      if (!recorded) return fail("mcp_server_changed");
      const fresh = await repository.get(id);
      return fresh === undefined
        ? fail("mcp_server_not_found")
        : { ok: true, value: toView(fresh) };
    },
  };
}
