// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the Jira Cloud connections of ONE workspace (#1037; the table `jira_connections`; the factory takes the workspace id, see
// ../workspace-scope.ts). The module only moves rows: the sealing of the tokens, the refresh and the rules of the flow are in src/jira/.
// The sealed pair is never part of a `StoredJiraConnection` (what the pages and the API read); only `readTokens` hands it out, to the code
// that unseals it.
//
// A token write is a compare and swap on `token_version` (`replaceTokens`, `markBroken`): Atlassian rotates the refresh token on every
// refresh, so of two requests that refresh at once only the first may store its pair.
//
// `removeUnlessUsed` is the one way to delete a connection: it locks the row and refuses while a project's ticket source names it
// (`projects.ticket_source` is JSON text `{ "provider": "jira", "connectionId", ... }`, set by #1038; a project that names the connection
// is named in the refusal). #1038, which points a project at a connection, must take that row lock (`for share`) in the transaction that writes the source,
// so the check and the delete cannot interleave with it.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, JiraConnectionsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export const JIRA_CONNECTION_STATUSES = ["connected", "broken"] as const;
export type JiraConnectionStatus = (typeof JIRA_CONNECTION_STATUSES)[number];

/** A connection as the pages and the API may know it: everything but the token pair. */
export type StoredJiraConnection = {
  id: string;
  workspaceId: string;
  cloudId: string;
  siteUrl: string;
  siteName: string;
  accountId: string;
  accountName: string;
  scopes: string[];
  status: JiraConnectionStatus;
  /** Why the connection is broken (a code of `src/jira/errors.ts`); null while it is connected. */
  errorCode: string | null;
  /** When the access token ends. */
  accessExpiresAt: string;
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The token pair as the database holds it: sealed (src/crypto/secret-box.ts). */
export type SealedTokens = {
  ciphertext: string;
  nonce: string;
  keyVersion: number;
};

export type SaveJiraConnection = {
  /** The id the tokens were sealed for (the row id is bound into the ciphertext). */
  id: string;
  cloudId: string;
  siteUrl: string;
  siteName: string;
  accountId: string;
  accountName: string;
  scopes: string[];
  sealed: SealedTokens;
  accessExpiresAt: Date;
  connectedBy: string | null;
};

export type ProjectUsingConnection = {
  /** The id of the project. */
  id: string;
  /** What the project is called: the full name of its repository. */
  name: string;
};

export type RemoveJiraConnectionResult =
  | { removed: true }
  | { removed: false; reason: "not_found" }
  | { removed: false; reason: "in_use"; projects: ProjectUsingConnection[] };

export type JiraConnectionsRepository = {
  /** The connections of the workspace, oldest first. */
  list(): Promise<StoredJiraConnection[]>;
  get(id: string): Promise<StoredJiraConnection | undefined>;
  findBySite(cloudId: string): Promise<StoredJiraConnection | undefined>;
  /** The connection with its sealed pair and the version of the pair. */
  readTokens(
    id: string,
  ): Promise<
    | {
        connection: StoredJiraConnection;
        sealed: SealedTokens;
        tokenVersion: number;
      }
    | undefined
  >;
  /**
   * Makes the connection to a site, or connects the site again: a row of the same site is replaced (new tokens, connected, no error)
   * when it has the id the tokens were sealed for. Undefined when the site has a row under another id (somebody connected it in the
   * meantime): the caller reads it and seals again.
   */
  save(input: SaveJiraConnection): Promise<StoredJiraConnection | undefined>;
  /** Replaces the pair when it is still the version the caller read; false when another request replaced it first. */
  replaceTokens(
    id: string,
    expectedVersion: number,
    sealed: SealedTokens,
    accessExpiresAt: Date,
  ): Promise<boolean>;
  /** Marks the connection broken when the pair is still the version the caller read. */
  markBroken(
    id: string,
    expectedVersion: number,
    errorCode: string,
  ): Promise<boolean>;
  /** The projects that use the connection as their ticket source. */
  projectsUsing(id: string): Promise<ProjectUsingConnection[]>;
  /** Removes the connection unless a project uses it. */
  removeUnlessUsed(id: string): Promise<RemoveJiraConnectionResult>;
};

function toStored(row: Selectable<JiraConnectionsTable>): StoredJiraConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    siteName: row.site_name,
    accountId: row.account_id,
    accountName: row.account_name,
    scopes: row.scopes === "" ? [] : row.scopes.split(" "),
    status: row.status === "broken" ? "broken" : "connected",
    errorCode: row.error_code,
    accessExpiresAt: row.access_expires_at,
    connectedBy: row.connected_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The projects of the workspace whose ticket source is the connection; `executor` is the database or the transaction it runs in. */
async function projectsOf(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  id: string,
): Promise<ProjectUsingConnection[]> {
  const { rows } = await sql<{ id: string; name: string }>`
    select projects.id as id, repositories.full_name as name
    from projects
    join repositories on repositories.id = projects.repository_id
    where repositories.workspace_id = ${workspaceId}
      and json_or_null(projects.ticket_source) ->> 'provider' = 'jira'
      and json_or_null(projects.ticket_source) ->> 'connectionId' = ${id}
    order by repositories.full_name, projects.id`.execute(executor);
  return rows;
}

export function createJiraConnectionsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JiraConnectionsRepository {
  return {
    async list() {
      const rows = await db
        .selectFrom("jira_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toStored);
    },

    async get(id) {
      const row = await db
        .selectFrom("jira_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async findBySite(cloudId) {
      const row = await db
        .selectFrom("jira_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("cloud_id", "=", cloudId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async readTokens(id) {
      const row = await db
        .selectFrom("jira_connections")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        connection: toStored(row),
        sealed: {
          ciphertext: row.tokens_ciphertext,
          nonce: row.tokens_nonce,
          keyVersion: row.tokens_key_version,
        },
        tokenVersion: row.token_version,
      };
    },

    async save(input) {
      const at = formatTimestamp(now());
      const row = await db
        .insertInto("jira_connections")
        .values({
          id: input.id,
          workspace_id: workspaceId,
          cloud_id: input.cloudId,
          site_url: input.siteUrl,
          site_name: input.siteName,
          account_id: input.accountId,
          account_name: input.accountName,
          scopes: input.scopes.join(" "),
          status: "connected",
          error_code: null,
          tokens_ciphertext: input.sealed.ciphertext,
          tokens_nonce: input.sealed.nonce,
          tokens_key_version: input.sealed.keyVersion,
          access_expires_at: formatTimestamp(input.accessExpiresAt),
          connected_by: input.connectedBy,
          created_at: at,
          updated_at: at,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["workspace_id", "cloud_id"])
            .doUpdateSet((eb) => ({
              site_url: input.siteUrl,
              site_name: input.siteName,
              account_id: input.accountId,
              account_name: input.accountName,
              scopes: input.scopes.join(" "),
              status: "connected",
              error_code: null,
              tokens_ciphertext: input.sealed.ciphertext,
              tokens_nonce: input.sealed.nonce,
              tokens_key_version: input.sealed.keyVersion,
              token_version: eb("jira_connections.token_version", "+", 1),
              access_expires_at: formatTimestamp(input.accessExpiresAt),
              connected_by: input.connectedBy,
              updated_at: at,
            }))
            // The tokens are sealed for the id of the row: another id would leave them unreadable.
            .where("jira_connections.id", "=", input.id),
        )
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async replaceTokens(id, expectedVersion, sealed, accessExpiresAt) {
      const result = await db
        .updateTable("jira_connections")
        .set((eb) => ({
          tokens_ciphertext: sealed.ciphertext,
          tokens_nonce: sealed.nonce,
          tokens_key_version: sealed.keyVersion,
          token_version: eb("token_version", "+", 1),
          access_expires_at: formatTimestamp(accessExpiresAt),
          status: "connected",
          error_code: null,
          updated_at: formatTimestamp(now()),
        }))
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("token_version", "=", expectedVersion)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    async markBroken(id, expectedVersion, errorCode) {
      const result = await db
        .updateTable("jira_connections")
        .set({
          status: "broken",
          error_code: errorCode,
          updated_at: formatTimestamp(now()),
        })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("token_version", "=", expectedVersion)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },

    projectsUsing: (id) => projectsOf(db, workspaceId, id),

    async removeUnlessUsed(id) {
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("jira_connections")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { removed: false, reason: "not_found" };
        const projects = await projectsOf(trx, workspaceId, id);
        if (projects.length > 0)
          return { removed: false, reason: "in_use", projects };
        await trx
          .deleteFrom("jira_connections")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .execute();
        return { removed: true };
      });
    },
  };
}
