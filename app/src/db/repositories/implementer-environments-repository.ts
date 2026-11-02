// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the Implementer's environments of ONE workspace (the table `implementer_environments`; the factory takes the
// workspace id, see ../workspace-scope.ts). An environment is a name, a size and a setup script. A row of another workspace is
// simply not there. The rules that need the database live here: a name once per workspace whatever its case, and a bounded
// count, checked under a lock on the workspace row so that two creators cannot both take the last place. Everything about the
// shape of the input (the size list, the script bound) is the service's.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { UNIQUE_VIOLATION, errorCode } from "../errors.ts";
import type { Database, ImplementerEnvironmentsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type StoredEnvironment = {
  id: string;
  workspaceId: string;
  name: string;
  vcpus: number;
  setupScript: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** An environment without its script: what a picker needs. `hasScript` is whether the script is not empty. */
export type EnvironmentSummary = {
  id: string;
  name: string;
  vcpus: number;
  hasScript: boolean;
};

export type EnvironmentFields = {
  name: string;
  vcpus: number;
  setupScript: string;
};

export type NewEnvironment = EnvironmentFields & { createdBy: string };

export type CreateOutcome =
  | { ok: true; environment: StoredEnvironment }
  | { ok: false; reason: "name_taken" | "limit_reached" };

export type UpdateOutcome =
  | { ok: true; environment: StoredEnvironment }
  | { ok: false; reason: "name_taken" | "not_found" };

export type ImplementerEnvironmentsRepository = {
  /** All environments of the workspace by name (case ignored). */
  list(): Promise<StoredEnvironment[]>;
  /**
   * The same environments, by name, without reading their scripts (up to 64 KB each): only whether one is there. For a picker, which
   * has no use for the text.
   */
  listSummaries(): Promise<EnvironmentSummary[]>;
  get(id: string): Promise<StoredEnvironment | undefined>;
  /** `maximum` is how many the workspace may hold, counted with the new one. */
  create(environment: NewEnvironment, maximum: number): Promise<CreateOutcome>;
  update(id: string, fields: EnvironmentFields): Promise<UpdateOutcome>;
  /** Whether there was one to delete. Nothing else is touched: past and running turns hold their own copy. */
  remove(id: string): Promise<boolean>;
};

function environmentFrom(
  row: Selectable<ImplementerEnvironmentsTable>,
): StoredEnvironment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    vcpus: row.vcpus,
    setupScript: row.setup_script,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createImplementerEnvironmentsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date; newId?: () => string } = {},
): ImplementerEnvironmentsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  return {
    async list() {
      const rows = await db
        .selectFrom("implementer_environments")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .orderBy((eb) => eb.fn("lower", ["name"]))
        .orderBy("id")
        .execute();
      return rows.map(environmentFrom);
    },

    async listSummaries() {
      const rows = await db
        .selectFrom("implementer_environments")
        .select([
          "id",
          "name",
          "vcpus",
          sql<boolean>`octet_length(setup_script) > 0`.as("has_script"),
        ])
        .where("workspace_id", "=", workspaceId)
        .orderBy((eb) => eb.fn("lower", ["name"]))
        .orderBy("id")
        .execute();
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        vcpus: row.vcpus,
        hasScript: row.has_script,
      }));
    },

    async get(id) {
      const row = await db
        .selectFrom("implementer_environments")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row === undefined ? undefined : environmentFrom(row);
    },

    create(environment, maximum) {
      const run = async (trx: Kysely<Database>): Promise<CreateOutcome> => {
        // Creators of one workspace take turns. A lock that does not block the foreign keys of the rows being inserted.
        await trx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        const { count } = await trx
          .selectFrom("implementer_environments")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const timestamp = formatTimestamp(now());
        // `do nothing` instead of a raised violation: a name that is taken is an answer and must not abort a caller's transaction.
        const row = await trx
          .insertInto("implementer_environments")
          .values({
            id: newId(),
            workspace_id: workspaceId,
            name: environment.name,
            vcpus: environment.vcpus,
            setup_script: environment.setupScript,
            created_by: environment.createdBy,
            created_at: timestamp,
            updated_at: timestamp,
          })
          .onConflict((conflict) => conflict.doNothing())
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "name_taken" };
        return { ok: true, environment: environmentFrom(row) };
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },

    async update(id, fields) {
      try {
        const row = await db
          .updateTable("implementer_environments")
          .set({
            name: fields.name,
            vcpus: fields.vcpus,
            setup_script: fields.setupScript,
            updated_at: formatTimestamp(now()),
          })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "not_found" };
        return { ok: true, environment: environmentFrom(row) };
      } catch (error) {
        // The unique index on the lower case of the name. Outside a transaction only; inside one it would be aborted already.
        if (errorCode(error) === UNIQUE_VIOLATION)
          return { ok: false, reason: "name_taken" };
        throw error;
      }
    },

    async remove(id) {
      const result = await db
        .deleteFrom("implementer_environments")
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numDeletedRows) > 0;
    },
  };
}
