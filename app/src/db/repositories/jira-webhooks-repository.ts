// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the Jira webhooks of ONE workspace (#1039; the table `jira_webhooks`; the factory takes the workspace id, see
// ../workspace-scope.ts): the dynamic webhook the factory registered at a Jira site for a project's ticket source. The module only moves
// rows; what a registration does and when is in src/jira/ (`webhook-registrar.ts`). The hash of the secret in the webhook's address is kept
// (never the secret). The delivery route finds a row by its id before it knows the workspace: that read is the instance-level
// `jira-webhook-directory-repository.ts`.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, JiraWebhooksTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export const JIRA_WEBHOOK_STATUSES = ["pending", "active", "removing"] as const;
export type JiraWebhookStatus = (typeof JIRA_WEBHOOK_STATUSES)[number];

export type StoredJiraWebhook = {
  id: string;
  workspaceId: string;
  projectId: string;
  connectionId: string;
  projectKey: string;
  secretHash: string;
  /** The hash of the secret of a registration under way, accepted next to `secretHash`; null otherwise. */
  pendingSecretHash: string | null;
  status: JiraWebhookStatus;
  /** Jira's id of the registered webhook; null until it is registered. */
  jiraWebhookId: string | null;
  /** When Jira ends the webhook unless it is extended; null until it is registered. */
  expiresAt: string | null;
  /** When the webhook was registered (what its secret is rotated by); null until it is. */
  registeredAt: string | null;
  /** When a bearer token that verified was first seen on a delivery; from then on one without a token is refused; null while none was. */
  bearerSeenAt: string | null;
  /** Why the last registration or extension failed; null after a success. */
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewJiraWebhook = {
  id: string;
  projectId: string;
  connectionId: string;
  projectKey: string;
  secretHash: string;
};

export type JiraWebhooksRepository = {
  /** The webhook row of the project, if it has one. */
  getByProject(projectId: string): Promise<StoredJiraWebhook | undefined>;
  /** The webhook rows of the workspace, oldest first. */
  list(): Promise<StoredJiraWebhook[]>;
  /**
   * Adds the row, `pending`. Undefined when the project has a row already, or the connection is none of this workspace's: the foreign key
   * would accept another workspace's connection, so the insert selects it from the workspace's own.
   */
  create(input: NewJiraWebhook): Promise<StoredJiraWebhook | undefined>;
  /**
   * Starts a registration at Jira: the secret of its address (`pendingSecretHash`) is accepted from now on, next to the current one. Only
   * while the row still has the Jira id the caller read (`expectedJiraWebhookId`, null for none) and is not being removed, so a
   * registration another caller finished meanwhile is not started over (an extra webhook would be left at Jira). Answers whether it began.
   * A second caller overwrites the pending secret: the first one then finds `markRegistered` refused and takes its webhook back.
   */
  beginRegistration(
    id: string,
    pendingSecretHash: string,
    expectedJiraWebhookId: string | null,
  ): Promise<boolean>;
  /**
   * The webhook is registered at Jira: `active`, with Jira's id, the end of its life and the pending secret as THE secret; clears the error.
   * Only while `pendingSecretHash` is still the one this registration began with and the row is not being removed: if another registration
   * began meanwhile, or the row is being removed, nothing is written and the answer is false (the caller deletes the webhook it made).
   */
  markRegistered(
    id: string,
    jiraWebhookId: string,
    expiresAt: string,
    pendingSecretHash: string,
  ): Promise<boolean>;
  /** A delivery of the registration carried a bearer token that verified: noted once (the first time stays). */
  markBearerSeen(id: string): Promise<boolean>;
  /** Jira extended the webhook: the new end of its life; clears the error. */
  markExtended(id: string, expiresAt: string): Promise<boolean>;
  /** A registration or an extension failed: the code why; the row stays as it was otherwise. */
  markError(id: string, errorCode: string): Promise<boolean>;
  /** The source of the project is gone: the webhook at Jira is to be deleted, then the row goes (`remove`). */
  markRemoving(projectId: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
};

export function toStoredJiraWebhook(
  row: Selectable<JiraWebhooksTable>,
): StoredJiraWebhook {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    projectKey: row.project_key,
    secretHash: row.secret_hash,
    pendingSecretHash: row.pending_secret_hash,
    status:
      row.status === "active" || row.status === "removing"
        ? row.status
        : "pending",
    jiraWebhookId: row.jira_webhook_id,
    expiresAt: row.expires_at,
    registeredAt: row.registered_at,
    bearerSeenAt: row.bearer_seen_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createJiraWebhooksRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JiraWebhooksRepository {
  const own = (id: string) =>
    db
      .updateTable("jira_webhooks")
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);
  const stamp = () => formatTimestamp(now());
  const changed = (result: { numUpdatedRows: bigint }) =>
    Number(result.numUpdatedRows) > 0;

  return {
    async getByProject(projectId) {
      const row = await db
        .selectFrom("jira_webhooks")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStoredJiraWebhook(row);
    },

    async list() {
      const rows = await db
        .selectFrom("jira_webhooks")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toStoredJiraWebhook);
    },

    async create(input) {
      const at = stamp();
      const { rows } = await sql<Selectable<JiraWebhooksTable>>`
        insert into jira_webhooks (
          id, workspace_id, project_id, connection_id, project_key, secret_hash, pending_secret_hash, registered_at, bearer_seen_at, status,
          jira_webhook_id, expires_at, error_code, created_at, updated_at
        )
        select ${input.id}::text, c.workspace_id, ${input.projectId}::text, c.id, ${input.projectKey}::text, ${input.secretHash}::text,
          null, null, null, 'pending', null, null, null, ${at}::text, ${at}::text
        from jira_connections c
        where c.id = ${input.connectionId} and c.workspace_id = ${workspaceId}
        on conflict (project_id) do nothing
        returning *`.execute(db);
      const row = rows[0];
      return row === undefined ? undefined : toStoredJiraWebhook(row);
    },

    async beginRegistration(id, pendingSecretHash, expectedJiraWebhookId) {
      let update = own(id)
        .set({ pending_secret_hash: pendingSecretHash, updated_at: stamp() })
        .where("status", "<>", "removing");
      update =
        expectedJiraWebhookId === null
          ? update.where("jira_webhook_id", "is", null)
          : update.where("jira_webhook_id", "=", expectedJiraWebhookId);
      return changed(await update.executeTakeFirst());
    },

    async markRegistered(id, jiraWebhookId, expiresAt, pendingSecretHash) {
      const at = stamp();
      return changed(
        await own(id)
          .set({
            status: "active",
            secret_hash: pendingSecretHash,
            pending_secret_hash: null,
            jira_webhook_id: jiraWebhookId,
            expires_at: expiresAt,
            registered_at: at,
            error_code: null,
            updated_at: at,
          })
          .where("status", "<>", "removing")
          .where("pending_secret_hash", "=", pendingSecretHash)
          .executeTakeFirst(),
      );
    },

    async markBearerSeen(id) {
      return changed(
        await own(id)
          .set({ bearer_seen_at: stamp() })
          .where("bearer_seen_at", "is", null)
          .executeTakeFirst(),
      );
    },

    async markExtended(id, expiresAt) {
      return changed(
        await own(id)
          .set({ expires_at: expiresAt, error_code: null, updated_at: stamp() })
          .where("status", "=", "active")
          .executeTakeFirst(),
      );
    },

    async markError(id, errorCode) {
      return changed(
        await own(id)
          .set({ error_code: errorCode, updated_at: stamp() })
          .executeTakeFirst(),
      );
    },

    async markRemoving(projectId) {
      return changed(
        await db
          .updateTable("jira_webhooks")
          .set({ status: "removing", updated_at: stamp() })
          .where("workspace_id", "=", workspaceId)
          .where("project_id", "=", projectId)
          .executeTakeFirst(),
      );
    },

    async remove(id) {
      const result = await db
        .deleteFrom("jira_webhooks")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
