// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the Jira webhooks of ONE workspace (#1039; the table `jira_webhooks`; the factory takes the workspace id, see
// ../workspace-scope.ts): the dynamic webhook the factory registered at a Jira site for a project's ticket source. The module only moves
// rows; what a registration does and when is in src/jira/ (`webhook-registrar.ts`). Since #1131 the webhooks of one Jira connection share ONE
// address (Jira allows one per app and user): its secret is derived from the app secret, the connection id and `webhook_generation` of the
// connection's row (never stored), and this module also keeps that generation, the start of the address and the first verified bearer token
// of the connection. A row from before keeps the hash of the secret of its own per-project address (`address` = `project`) until it moves. The
// delivery route finds a row or a connection by its id before it knows the workspace: that read is the instance-level
// `jira-webhook-directory-repository.ts`.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, JiraWebhooksTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export const JIRA_WEBHOOK_STATUSES = ["pending", "active", "removing"] as const;
export type JiraWebhookStatus = (typeof JIRA_WEBHOOK_STATUSES)[number];

/** `project`: registered under its own per-project address (before #1131); `connection`: under the address the connection's webhooks share. */
export const JIRA_WEBHOOK_ADDRESSES = ["project", "connection"] as const;
export type JiraWebhookAddress = (typeof JIRA_WEBHOOK_ADDRESSES)[number];

/** What is kept of the address a connection's webhooks share. */
export type JiraWebhookEndpoint = {
  connectionId: string;
  /** The generation whose derived secret the address carries (1 until a rotation). */
  generation: number;
  /** When the address was put in place, that is when its generation began; null until a webhook is first registered under it. */
  addressAt: string | null;
  /** The SHA-256 of the derived secret the address was registered with; null until a webhook is registered under it (or it is unknown). */
  secretFingerprint: string | null;
  /** When a bearer token that verified was first seen on a delivery of the address; null while none was. */
  bearerSeenAt: string | null;
};

export type StoredJiraWebhook = {
  id: string;
  workspaceId: string;
  projectId: string;
  connectionId: string;
  projectKey: string;
  /** The hash of the secret of its own per-project address; null for a row under the shared address of the connection. */
  secretHash: string | null;
  /** The hash of the secret of a registration under way under the per-project address, accepted next to `secretHash`; null otherwise. */
  pendingSecretHash: string | null;
  address: JiraWebhookAddress;
  /** The marker of a registration under way (the compare-and-set of two reconciles at the same moment); null otherwise. */
  registrationAttempt: string | null;
  status: JiraWebhookStatus;
  /** Jira's id of the registered webhook; null until it is registered. */
  jiraWebhookId: string | null;
  /** When Jira ends the webhook unless it is extended; null until it is registered. */
  expiresAt: string | null;
  /** When the webhook was registered (what its secret is rotated by); null until it is. */
  registeredAt: string | null;
  /** When a bearer token that verified was first seen on a delivery of this per-project address; from then on one without a token is refused; null while none was. */
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
  /**
   * Only for a row under the old per-project address (`address` = `project`), which production code no longer makes: the hash of the secret of
   * that address. Left out, the row is under the shared address of the connection.
   */
  legacySecretHash?: string;
};

export type JiraWebhooksRepository = {
  /** The webhook row of the project, if it has one. */
  getByProject(projectId: string): Promise<StoredJiraWebhook | undefined>;
  /** The webhook rows of the workspace, oldest first. */
  list(): Promise<StoredJiraWebhook[]>;
  /** The rows of the connection for a Jira project (not those being removed), oldest first: the projects a delivery of that project is for. */
  listByProjectKey(
    connectionId: string,
    projectKey: string,
  ): Promise<StoredJiraWebhook[]>;
  /** What is kept of the shared address of the connection; undefined when it is none of this workspace's. */
  getEndpoint(connectionId: string): Promise<JiraWebhookEndpoint | undefined>;
  /** A delivery of the connection's address carried a bearer token that verified: noted once (the first time stays). */
  markEndpointBearerSeen(connectionId: string): Promise<boolean>;
  /**
   * Moves every webhook of the connection to the shared address after the caller deleted them at Jira (Jira allows one address per user, so
   * they cannot be registered next to each other): the rows that were registered become `pending` again, marked with `errorCode` until they
   * are registered (a failure on the way leaves them visible and due), those that were being removed go, the address starts now, and with
   * `rotate` the generation counts up (a new secret). What the first bearer token of a per-project address proved is carried over to the
   * connection. Compare-and-set, so two callers that read the same rows move them ONCE: with `rotate` only while the connection still has the
   * generation the caller read, without it only while a row is still under its per-project address. Answers whether it moved (the other
   * caller's move stands otherwise, and nothing is written).
   */
  moveToSharedAddress(
    connectionId: string,
    options: {
      rotate: boolean;
      expectedGeneration: number;
      errorCode: string;
    },
  ): Promise<boolean>;
  /**
   * Adds the row, `pending`, under the shared address of the connection. Undefined when the project has a row already, or the connection is none of this workspace's: the foreign key
   * would accept another workspace's connection, so the insert selects it from the workspace's own.
   */
  create(input: NewJiraWebhook): Promise<StoredJiraWebhook | undefined>;
  /**
   * Starts a registration at Jira: `attempt` marks it. Only while the row still has the Jira id the caller read (`expectedJiraWebhookId`, null
   * for none) and is not being removed, so a registration another caller finished meanwhile is not started over (an extra webhook would be
   * left at Jira). Answers whether it began. A second caller overwrites the marker: the first one then finds `markRegistered` refused and
   * takes its webhook back.
   */
  beginRegistration(
    id: string,
    attempt: string,
    expectedJiraWebhookId: string | null,
  ): Promise<boolean>;
  /**
   * The webhook is registered at Jira under the shared address: `active`, with Jira's id and the end of its life; the per-project secrets of an
   * old row are dropped, the error is cleared, `secretFingerprint` (the SHA-256 of the secret the address carries) is kept on the connection,
   * and the start of the address is set if it has none yet (it begins with a generation, see `moveToSharedAddress`).
   * Only while `attempt` is still the one this registration began with and the row is not being removed: if another registration began
   * meanwhile, or the row is being removed, nothing is written and the answer is false (the caller deletes the webhook it made).
   */
  markRegistered(
    id: string,
    jiraWebhookId: string,
    expiresAt: string,
    attempt: string,
    secretFingerprint: string,
  ): Promise<boolean>;
  /** A delivery of the per-project address of the registration carried a bearer token that verified: noted once (the first time stays). */
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
    address: row.address === "connection" ? "connection" : "project",
    registrationAttempt: row.registration_attempt,
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

/** Thrown inside the transaction of `moveToSharedAddress` to undo it when another caller moved the rows first. */
class NotMoved extends Error {}

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
          id, workspace_id, project_id, connection_id, project_key, secret_hash, pending_secret_hash, address, registration_attempt, registered_at,
          bearer_seen_at, status, jira_webhook_id, expires_at, error_code, created_at, updated_at
        )
        select ${input.id}::text, c.workspace_id, ${input.projectId}::text, c.id, ${input.projectKey}::text, ${input.legacySecretHash ?? null}::text,
          null, ${input.legacySecretHash === undefined ? "connection" : "project"}::text, null, null, null, 'pending', null, null, null,
          ${at}::text, ${at}::text
        from jira_connections c
        where c.id = ${input.connectionId} and c.workspace_id = ${workspaceId}
        on conflict (project_id) do nothing
        returning *`.execute(db);
      const row = rows[0];
      return row === undefined ? undefined : toStoredJiraWebhook(row);
    },

    async listByProjectKey(connectionId, projectKey) {
      const rows = await db
        .selectFrom("jira_webhooks")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("connection_id", "=", connectionId)
        .where("project_key", "=", projectKey)
        .where("status", "<>", "removing")
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(toStoredJiraWebhook);
    },

    async getEndpoint(connectionId) {
      const row = await db
        .selectFrom("jira_connections")
        .select([
          "id",
          "webhook_generation",
          "webhook_address_at",
          "webhook_bearer_seen_at",
          "webhook_secret_fingerprint",
        ])
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", connectionId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            connectionId: row.id,
            generation: row.webhook_generation,
            addressAt: row.webhook_address_at,
            bearerSeenAt: row.webhook_bearer_seen_at,
            secretFingerprint: row.webhook_secret_fingerprint,
          };
    },

    async markEndpointBearerSeen(connectionId) {
      return changed(
        await db
          .updateTable("jira_connections")
          .set({ webhook_bearer_seen_at: stamp() })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", connectionId)
          .where("webhook_bearer_seen_at", "is", null)
          .executeTakeFirst(),
      );
    },

    async moveToSharedAddress(connectionId, options) {
      const at = stamp();
      try {
        await db.transaction().execute(async (trx) => {
          // The first token of a per-project address proves what Atlassian sends for this app: kept for the connection (before the rows change).
          const moved = await sql`update jira_connections
            set webhook_generation = ${options.rotate ? options.expectedGeneration + 1 : options.expectedGeneration},
              webhook_address_at = ${at},
              webhook_secret_fingerprint = null,
              webhook_bearer_seen_at = coalesce(webhook_bearer_seen_at, (
                select min(w.bearer_seen_at) from jira_webhooks w
                where w.connection_id = ${connectionId} and w.workspace_id = ${workspaceId} and w.bearer_seen_at is not null))
            where workspace_id = ${workspaceId} and id = ${connectionId} and webhook_generation = ${options.expectedGeneration}`.execute(
            trx,
          );
          if (Number(moved.numAffectedRows ?? 0) === 0) throw new NotMoved();
          let reset = trx
            .updateTable("jira_webhooks")
            .set({
              status: "pending",
              address: "connection",
              secret_hash: null,
              pending_secret_hash: null,
              registration_attempt: null,
              jira_webhook_id: null,
              expires_at: null,
              registered_at: null,
              error_code: options.errorCode,
              updated_at: at,
            })
            .where("workspace_id", "=", workspaceId)
            .where("connection_id", "=", connectionId)
            .where("status", "<>", "removing")
            .where("jira_webhook_id", "is not", null);
          // A move that is not a rotation is for the rows still under their own address: a row another mover already moved (and registered
          // again) is left alone, or its fresh webhook would be orphaned at Jira.
          if (!options.rotate) reset = reset.where("address", "=", "project");
          const resetRows = Number(
            (await reset.executeTakeFirst()).numUpdatedRows,
          );
          const goneRows = Number(
            (
              await trx
                .deleteFrom("jira_webhooks")
                .where("workspace_id", "=", workspaceId)
                .where("connection_id", "=", connectionId)
                .where("status", "=", "removing")
                .executeTakeFirst()
            ).numDeletedRows,
          );
          // Nothing left to move: another mover was first. Undo the connection's update too.
          if (!options.rotate && resetRows + goneRows === 0)
            throw new NotMoved();
        });
        return true;
      } catch (error) {
        if (error instanceof NotMoved) return false;
        throw error;
      }
    },

    async beginRegistration(id, attempt, expectedJiraWebhookId) {
      let update = own(id)
        .set({ registration_attempt: attempt, updated_at: stamp() })
        .where("status", "<>", "removing");
      update =
        expectedJiraWebhookId === null
          ? update.where("jira_webhook_id", "is", null)
          : update.where("jira_webhook_id", "=", expectedJiraWebhookId);
      return changed(await update.executeTakeFirst());
    },

    async markRegistered(
      id,
      jiraWebhookId,
      expiresAt,
      attempt,
      secretFingerprint,
    ) {
      const at = stamp();
      const row = await own(id)
        .set({
          status: "active",
          address: "connection",
          secret_hash: null,
          pending_secret_hash: null,
          registration_attempt: null,
          jira_webhook_id: jiraWebhookId,
          expires_at: expiresAt,
          registered_at: at,
          error_code: null,
          updated_at: at,
        })
        .where("status", "<>", "removing")
        .where("registration_attempt", "=", attempt)
        .returning("connection_id")
        .executeTakeFirst();
      if (row === undefined) return false;
      // The address is as old as its generation: set by the move that began it, or here for the first webhook ever registered under it.
      await sql`update jira_connections
        set webhook_address_at = coalesce(webhook_address_at, ${at}), webhook_secret_fingerprint = ${secretFingerprint}
        where id = ${row.connection_id} and workspace_id = ${workspaceId}`.execute(
        db,
      );
      return true;
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
