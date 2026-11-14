// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the encrypted credentials of ONE workspace (the table `workspace_secrets`; the factory takes the
// workspace id, see ../workspace-scope.ts). The module only moves rows: the encryption, the additional
// authenticated data and the rules for what may be shown are in src/secrets/workspace-store.ts. A secret of
// another workspace is simply not there: reading, replacing or removing it by name behaves like a missing name.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database, WorkspaceSecretsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** A stored secret as the database holds it: the sealed value, what it is bound to, and who saved it when. */
export type WorkspaceSecretRow = {
  name: string;
  /** What the secret was made for (the provider of an LLM key). */
  binding: string;
  ciphertext: string;
  nonce: string;
  keyVersion: number;
  /** The last four characters of the value if a hint was asked for; not a secret. */
  lastFour: string | null;
  updatedBy: string | null;
  updatedAt: string;
};

export type WorkspaceSecretsRepository = {
  get(name: string): Promise<WorkspaceSecretRow | undefined>;
  /** Inserts the secret or replaces it, recording who and when. */
  put(secret: Omit<WorkspaceSecretRow, "updatedAt">): Promise<void>;
  /** Removes the secret; false when there was none. */
  remove(name: string): Promise<boolean>;
  /** Removes the secret and hands it out in the same statement: of two callers only one gets it. Undefined when there was none. */
  take(name: string): Promise<WorkspaceSecretRow | undefined>;
  /** The names of the secrets this workspace holds, sorted; never a value. */
  names(): Promise<string[]>;
};

function toRow(row: WorkspaceSecretsTable): WorkspaceSecretRow {
  return {
    name: row.name,
    binding: row.binding,
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    keyVersion: row.key_version,
    lastFour: row.last_four,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export function createWorkspaceSecretsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): WorkspaceSecretsRepository {
  return {
    async get(name) {
      const row = await db
        .selectFrom("workspace_secrets")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("name", "=", name)
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    async put(secret) {
      const row: WorkspaceSecretsTable = {
        workspace_id: workspaceId,
        name: secret.name,
        binding: secret.binding,
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        key_version: secret.keyVersion,
        last_four: secret.lastFour,
        updated_by: secret.updatedBy,
        updated_at: formatTimestamp(now()),
      };
      await db
        .insertInto("workspace_secrets")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["workspace_id", "name"]).doUpdateSet({
            binding: row.binding,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            key_version: row.key_version,
            last_four: row.last_four,
            updated_by: row.updated_by,
            updated_at: row.updated_at,
          }),
        )
        .execute();
    },

    async names() {
      const rows = await db
        .selectFrom("workspace_secrets")
        .select("name")
        .where("workspace_id", "=", workspaceId)
        .orderBy("name")
        .execute();
      return rows.map((row) => row.name);
    },

    async take(name) {
      const row = await db
        .deleteFrom("workspace_secrets")
        .where("workspace_id", "=", workspaceId)
        .where("name", "=", name)
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toRow(row);
    },

    async remove(name) {
      const result = await db
        .deleteFrom("workspace_secrets")
        .where("workspace_id", "=", workspaceId)
        .where("name", "=", name)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
