// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the MCP servers of ONE workspace (#1050, epic #1049; the table `mcp_servers`; the factory takes the workspace id, see
// ../workspace-scope.ts). The module only moves rows: the checking of what a person enters (src/mcp/input.ts), the sealing of the header values
// and the connection test (src/mcp/) are not here. The sealed headers are never part of a `StoredMcpServer` (what the pages and the API read);
// only `readHeaders` hands them out, to the code that unseals them for a test or, later (#1053), for the proxy at the sandbox's door.
//
// Rules that need the database and are decided here, under a lock:
// - a name once per workspace whatever its case, and at most `maximum` servers per workspace (counted under the lock of the workspace row,
//   so two creations at once cannot both take the last place);
// - a change of the configuration (`update`) is a compare and swap on `revision`, and so is the record of a test result (`recordTest`): a
//   result about the address that was tested is not stored over an edit made while the test ran. An edit that changes the address, the
//   transport or the credentials makes the last test stale (status `untested`, the tool list is dropped);
// - `removeUnlessUsed` is the one way to delete a server: it locks the row and refuses while a lane's current version names the server.
//   A lane names servers in its document under the key `mcp` (a lane's own, or a step's; #1052 adds the field). Which shape the field takes is
//   #1052's to decide: the check reads EVERY string under a key `mcp` anywhere in the document, so a list of ids, a list of objects holding an
//   id, or a per-step list are all found. A lane that is archived does not count. #1052, which lets a lane name a server, takes that row lock
//   (`for key share`, which `for update` waits for) in the transaction that saves the document, so the check and the delete cannot interleave.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, McpServersTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  dropMcpOAuth,
  replaceManualMcpOAuthClient,
  type McpOAuthChange,
  type McpOAuthClient,
  type StoredMcpOAuth,
} from "./mcp-oauth-repository.ts";

export const MCP_TEST_STATUSES = ["untested", "ok", "failed"] as const;
export type McpTestStatus = (typeof MCP_TEST_STATUSES)[number];

/** What the last successful test listed. */
export type McpToolsSnapshot = {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: { name: string; description: string }[];
  truncated: boolean;
};

/** A server as the pages and the API may know it: everything but the sealed header values. */
export type StoredMcpServer = {
  id: string;
  workspaceId: string;
  name: string;
  transport: string;
  url: string;
  authKind: string;
  /** The names of the sealed headers, in the order they were given; empty unless the kind is `header`. */
  headerNames: string[];
  revision: number;
  testStatus: McpTestStatus;
  testedAt: string | null;
  /** Why the last test failed (a code of `src/mcp/errors.ts`); null unless it did. */
  testErrorCode: string | null;
  /** What the last successful test listed; null before one. */
  snapshot: McpToolsSnapshot | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The header values as the database holds them: sealed (src/crypto/secret-box.ts). */
export type SealedHeaders = {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
};

export type McpServerFields = {
  name: string;
  transport: string;
  url: string;
  authKind: string;
  headerNames: string[];
};

export type NewMcpServer = McpServerFields & {
  /** The id the headers were sealed for (the row id is bound into the ciphertext). */
  id: string;
  /** The sealed headers; null unless the kind is `header`. */
  sealed: SealedHeaders | null;
  /** For the kind `oauth`: the client an Owner or Admin entered (the fallback when the authorization server has no dynamic registration). */
  oauthClient?: McpOAuthClient;
  createdBy: string | null;
};

export type McpServerChange = McpServerFields & {
  /** The new sealed headers; undefined keeps the stored ones (the kind stays `header` and no value changed). */
  sealed?: SealedHeaders | null;
  /** What happens to the OAuth connection in the same transaction (#1051); undefined leaves it alone. Any change makes the last test stale. */
  oauth?: McpOAuthChange;
};

/** The row an update starts from, read under the row lock: the server and its sealed headers. */
export type CurrentMcpServer = {
  server: StoredMcpServer;
  sealed: SealedHeaders | null;
  /** The client of the OAuth connection the server has (#1051), without any sealed value; null when it has none. */
  oauth: Pick<
    StoredMcpOAuth,
    "clientSource" | "clientId" | "hasClientSecret" | "registeredIssuer"
  > | null;
};

/**
 * Makes the change from the row as it is under the lock (so a kept header value is read in the same transaction that writes), or refuses it:
 * `refused` is a code of `src/mcp/errors.ts` and is handed back as `{ reason: "refused", code }`.
 */
export type McpChangeBuilder = (
  current: CurrentMcpServer,
) => McpServerChange | { refused: string };

/** The key under which a lane's document names MCP servers (#1052 writes it; `mcpReferencesIn` reads every string below it). */
export const MCP_LANE_DOCUMENT_KEY = "mcp";

export type LaneUsingMcpServer = {
  /** The id of the lane. */
  id: string;
  name: string;
  /** The project the lane belongs to; null for a lane without one. */
  projectId: string | null;
  /** What the project is called: the full name of its repository; null when there is none. */
  projectName: string | null;
};

export type CreateMcpServerResult =
  | { ok: true; server: StoredMcpServer }
  | { ok: false; reason: "name_taken" | "limit_reached" };

export type UpdateMcpServerResult =
  | { ok: true; server: StoredMcpServer }
  | { ok: false; reason: "not_found" | "name_taken" | "changed" }
  | { ok: false; reason: "refused"; code: string };

export type RecordMcpTest =
  { ok: true; snapshot: McpToolsSnapshot } | { ok: false; code: string };

export type RemoveMcpServerResult =
  | { removed: true }
  | { removed: false; reason: "not_found" }
  | { removed: false; reason: "in_use"; lanes: LaneUsingMcpServer[] };

export type McpServersRepository = {
  /** The servers of the workspace, by name (case ignored). */
  list(): Promise<StoredMcpServer[]>;
  get(id: string): Promise<StoredMcpServer | undefined>;
  /** The server with its sealed headers (null for a server without any). */
  readHeaders(
    id: string,
  ): Promise<
    { server: StoredMcpServer; sealed: SealedHeaders | null } | undefined
  >;
  /** `maximum` is how many servers the workspace may hold, counted with the new one. */
  create(input: NewMcpServer, maximum: number): Promise<CreateMcpServerResult>;
  /** Changes the configuration when the server is still at `expectedRevision`; a builder is called with the locked row (see `McpChangeBuilder`). */
  update(
    id: string,
    expectedRevision: number,
    change: McpServerChange | McpChangeBuilder,
  ): Promise<UpdateMcpServerResult>;
  /** Stores a test result when the server is still at `revision`; false when it was changed (or removed) in the meantime. */
  recordTest(
    id: string,
    revision: number,
    result: RecordMcpTest,
  ): Promise<boolean>;
  /** The lanes whose current version names the server. */
  lanesUsing(id: string): Promise<LaneUsingMcpServer[]>;
  /** Removes the server unless a lane uses it. */
  removeUnlessUsed(id: string): Promise<RemoveMcpServerResult>;
};

function parseNames(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseSnapshot(text: string | null): McpToolsSnapshot | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<McpToolsSnapshot> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray(value.tools)
    )
      return null;
    return {
      serverName: value.serverName ?? null,
      serverVersion: value.serverVersion ?? null,
      protocolVersion: value.protocolVersion ?? null,
      tools: value.tools,
      truncated: value.truncated === true,
    };
  } catch {
    return null;
  }
}

function toStored(row: Selectable<McpServersTable>): StoredMcpServer {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    authKind: row.auth_kind,
    headerNames: parseNames(row.header_names),
    revision: row.revision,
    testStatus:
      row.test_status === "ok" || row.test_status === "failed"
        ? row.test_status
        : "untested",
    testedAt: row.tested_at,
    testErrorCode: row.test_error_code,
    snapshot: parseSnapshot(row.tools_snapshot),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sealedOf(row: Selectable<McpServersTable>): SealedHeaders | null {
  if (
    row.headers_ciphertext === null ||
    row.headers_nonce === null ||
    row.headers_key_version === null
  )
    return null;
  return {
    ciphertext: row.headers_ciphertext,
    nonce: row.headers_nonce,
    keyVersion: row.headers_key_version,
  };
}

/** Every string under a key `mcp` anywhere in a lane document: the servers the lane names (its own list and its steps'). */
export function mcpReferencesIn(documentText: string): Set<string> {
  const found = new Set<string>();
  let document: unknown;
  try {
    document = JSON.parse(documentText);
  } catch {
    return found;
  }
  // Iterative: the document is data a person wrote, and a deep one must not overflow the stack.
  const pending: { value: unknown; inside: boolean }[] = [
    { value: document, inside: false },
  ];
  while (pending.length > 0) {
    const { value, inside } = pending.pop() ?? { value: null, inside: false };
    if (typeof value === "string") {
      if (inside) found.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value as unknown[])
        pending.push({ value: child, inside });
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const [key, child] of Object.entries(value))
      pending.push({
        value: child,
        inside: inside || key === MCP_LANE_DOCUMENT_KEY,
      });
  }
  return found;
}

/** The lanes of the workspace that are not archived and whose current version names the server. `executor` is the database or the transaction. */
async function lanesOf(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  id: string,
): Promise<LaneUsingMcpServer[]> {
  const rows = await executor
    .selectFrom("workflows")
    .innerJoin("workflow_versions", (join) =>
      join
        .onRef("workflow_versions.workflow_id", "=", "workflows.id")
        .onRef("workflow_versions.version", "=", "workflows.current_version"),
    )
    .leftJoin("projects", "projects.id", "workflows.project_id")
    .leftJoin("repositories", "repositories.id", "projects.repository_id")
    .select([
      "workflows.id as id",
      "workflows.name as name",
      "workflows.project_id as project_id",
      "repositories.full_name as project_name",
      "workflow_versions.document as document",
    ])
    .where("workflows.workspace_id", "=", workspaceId)
    .where("workflow_versions.workspace_id", "=", workspaceId)
    .where("workflows.archived_at", "is", null)
    // A prefilter on the text; the reading of the document below decides.
    .where("workflow_versions.document", "like", `%"${MCP_LANE_DOCUMENT_KEY}"%`)
    .orderBy("workflows.name")
    .orderBy("workflows.id")
    .execute();
  return rows
    .filter((row) => mcpReferencesIn(row.document).has(id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      projectName: row.project_name,
    }));
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";

export function createMcpServersRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): McpServersRepository {
  return {
    async list() {
      const rows = await db
        .selectFrom("mcp_servers")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy(sql`lower(name)`)
        .orderBy("id")
        .execute();
      return rows.map(toStored);
    },

    async get(id) {
      const row = await db
        .selectFrom("mcp_servers")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async readHeaders(id) {
      const row = await db
        .selectFrom("mcp_servers")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { server: toStored(row), sealed: sealedOf(row) };
    },

    async create(input, maximum) {
      const at = formatTimestamp(now());
      try {
        return await db.transaction().execute(async (trx) => {
          // The workspace row serialises the creations of one workspace; `for no key update` does not stop others from referencing it.
          await trx
            .selectFrom("workspaces")
            .select("id")
            .where("id", "=", workspaceId)
            .forNoKeyUpdate()
            .executeTakeFirst();
          const { count } = await trx
            .selectFrom("mcp_servers")
            .select((eb) => eb.fn.countAll<string>().as("count"))
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirstOrThrow();
          if (Number(count) >= maximum)
            return { ok: false as const, reason: "limit_reached" as const };
          const row = await trx
            .insertInto("mcp_servers")
            .values({
              id: input.id,
              workspace_id: workspaceId,
              name: input.name,
              transport: input.transport,
              url: input.url,
              auth_kind: input.authKind,
              header_names:
                input.authKind === "header"
                  ? JSON.stringify(input.headerNames)
                  : null,
              headers_ciphertext: input.sealed?.ciphertext ?? null,
              headers_nonce: input.sealed?.nonce ?? null,
              headers_key_version: input.sealed?.keyVersion ?? null,
              created_by: input.createdBy,
              created_at: at,
              updated_at: at,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          if (input.oauthClient !== undefined)
            await replaceManualMcpOAuthClient(
              trx,
              workspaceId,
              input.id,
              input.oauthClient,
              now(),
            );
          return { ok: true as const, server: toStored(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error))
          return { ok: false, reason: "name_taken" };
        throw error;
      }
    },

    async update(id, expectedRevision, requested) {
      const at = formatTimestamp(now());
      try {
        return await db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom("mcp_servers")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", id)
            // Not `for update`: a lane that saves a document naming this server (#1052) holds `for key share` on the row, which this lock
            // does not wait for, and the key of the row never changes here.
            .forNoKeyUpdate()
            .executeTakeFirst();
          if (current === undefined)
            return { ok: false as const, reason: "not_found" as const };
          if (current.revision !== expectedRevision)
            return { ok: false as const, reason: "changed" as const };
          const connection =
            typeof requested === "function"
              ? await trx
                  .selectFrom("mcp_oauth_connections")
                  .select([
                    "client_source",
                    "client_id",
                    "client_secret_ciphertext",
                    "registered_issuer",
                  ])
                  .where("workspace_id", "=", workspaceId)
                  .where("server_id", "=", id)
                  .executeTakeFirst()
              : undefined;
          const change =
            typeof requested === "function"
              ? requested({
                  server: toStored(current),
                  sealed: sealedOf(current),
                  oauth:
                    connection === undefined
                      ? null
                      : {
                          clientSource:
                            connection.client_source === "manual" ||
                            connection.client_source === "dynamic"
                              ? connection.client_source
                              : null,
                          clientId: connection.client_id,
                          registeredIssuer: connection.registered_issuer,
                          hasClientSecret:
                            connection.client_secret_ciphertext !== null,
                        },
                })
              : requested;
          if ("refused" in change)
            return {
              ok: false as const,
              reason: "refused" as const,
              code: change.refused,
            };
          const headerNames =
            change.authKind === "header"
              ? JSON.stringify(change.headerNames)
              : null;
          const reachChanged =
            current.url !== change.url ||
            current.transport !== change.transport ||
            current.auth_kind !== change.authKind ||
            current.header_names !== headerNames ||
            change.sealed !== undefined ||
            change.oauth !== undefined;
          const sealed =
            change.sealed === undefined ? sealedOf(current) : change.sealed;
          const row = await trx
            .updateTable("mcp_servers")
            .set({
              name: change.name,
              transport: change.transport,
              url: change.url,
              auth_kind: change.authKind,
              header_names: headerNames,
              headers_ciphertext: sealed?.ciphertext ?? null,
              headers_nonce: sealed?.nonce ?? null,
              headers_key_version: sealed?.keyVersion ?? null,
              revision: current.revision + 1,
              updated_at: at,
              // A test is about an address and its credentials: when they changed, the result is stale.
              ...(reachChanged
                ? {
                    test_status: "untested",
                    tested_at: null,
                    test_error_code: null,
                    tools_snapshot: null,
                  }
                : {}),
            })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirstOrThrow();
          // The tokens were issued for the address, the transport and the client the server had: they go with any change of these.
          if (change.oauth?.kind === "drop")
            await dropMcpOAuth(trx, workspaceId, id);
          else if (change.oauth?.kind === "replace-manual")
            await replaceManualMcpOAuthClient(
              trx,
              workspaceId,
              id,
              change.oauth.client,
              now(),
            );
          return { ok: true as const, server: toStored(row) };
        });
      } catch (error) {
        if (isUniqueViolation(error))
          return { ok: false, reason: "name_taken" };
        throw error;
      }
    },

    async recordTest(id, revision, result) {
      const at = formatTimestamp(now());
      const outcome = await db
        .updateTable("mcp_servers")
        .set(
          result.ok
            ? {
                test_status: "ok",
                tested_at: at,
                test_error_code: null,
                tools_snapshot: JSON.stringify(result.snapshot),
              }
            : {
                test_status: "failed",
                tested_at: at,
                test_error_code: result.code,
              },
        )
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("revision", "=", revision)
        .executeTakeFirst();
      return Number(outcome.numUpdatedRows) > 0;
    },

    lanesUsing: (id) => lanesOf(db, workspaceId, id),

    async removeUnlessUsed(id) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("mcp_servers")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { removed: false, reason: "not_found" };
        const lanes = await lanesOf(trx, workspaceId, id);
        if (lanes.length > 0)
          return { removed: false, reason: "in_use", lanes };
        await trx
          .deleteFrom("mcp_servers")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .execute();
        return { removed: true };
      });
    },
  };
}
