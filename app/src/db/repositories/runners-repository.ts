// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the runners and the registration tokens of ONE workspace (#854; the tables `runners` and `runner_registration_tokens`;
// the factory takes the workspace id, see ../workspace-scope.ts). A member makes a token, the list shows the runners, a revoked
// runner is refused from then on. Taking a token and finding a runner by its credential happen before the workspace is known and are
// in runner-credentials-repository.ts.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, RunnersTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  labelsFromText,
  limitsFromText,
  manifestFromText,
  type RunnerLimits,
  type RunnerManifest,
} from "../../runner-identity/announcement.ts";

export type StoredRunner = {
  id: string;
  workspaceId: string;
  name: string;
  labels: string[];
  baseVersion: string;
  manifest: RunnerManifest;
  limits: RunnerLimits;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type NewRegistrationToken = {
  tokenHash: string;
  createdBy: string;
  expiresAt: Date;
};

export type TokenOutcome =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; reason: "limit_reached" };

export type RunnersRepository = {
  /** The runners that were not revoked, oldest first. */
  list(): Promise<StoredRunner[]>;
  /** Makes a token. `maximum` is how many unused, unexpired tokens the workspace may hold, counted with the new one. */
  createToken(
    token: NewRegistrationToken,
    maximum: number,
  ): Promise<TokenOutcome>;
  /** Whether there was a runner of this workspace, not yet revoked, to revoke. */
  revoke(id: string): Promise<boolean>;
};

export function runnerFrom(row: Selectable<RunnersTable>): StoredRunner {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    labels: labelsFromText(row.labels),
    baseVersion: row.base_version,
    manifest: manifestFromText(row.manifest),
    limits: limitsFromText(row.limits),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function createRunnersRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date; newId?: () => string } = {},
): RunnersRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  return {
    async list() {
      const rows = await db
        .selectFrom("runners")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("revoked_at", "is", null)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      return rows.map(runnerFrom);
    },

    createToken(token, maximum) {
      const run = async (trx: Kysely<Database>): Promise<TokenOutcome> => {
        // Creators of one workspace take turns. A lock that does not block the foreign keys of the rows being inserted.
        await trx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        const timestamp = formatTimestamp(now());
        const { count } = await trx
          .selectFrom("runner_registration_tokens")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("used_at", "is", null)
          .where("expires_at", ">", timestamp)
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const id = newId();
        const expiresAt = formatTimestamp(token.expiresAt);
        await trx
          .insertInto("runner_registration_tokens")
          .values({
            id,
            workspace_id: workspaceId,
            token_hash: token.tokenHash,
            created_by: token.createdBy,
            created_at: timestamp,
            expires_at: expiresAt,
            used_at: null,
            runner_id: null,
          })
          .execute();
        return { ok: true, id, expiresAt };
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    async revoke(id) {
      const result = await db
        .updateTable("runners")
        .set({ revoked_at: formatTimestamp(now()) })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
  };
}
