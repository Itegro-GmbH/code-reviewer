// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runners of ONE workspace as a lane step names them (#1105, ADR 0007): the hosted runners (rows of `implementer_environments`
// that have a `concurrency`, one for each type of the provided Vercel Sandbox) and the self-hosted ones (`runners`). The factory takes the
// workspace id (../workspace-scope.ts). The names are unique across both tables, which no database constraint can say without a third table:
// each table has its own partial unique index, and everything that makes or renames a runner takes the workspace's lock and asks
// `nameTaken` (below) first.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type {
  Database,
  ImplementerEnvironmentsTable,
  RunnersTable,
} from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";
import {
  labelsFromText,
  limitsFromText,
  manifestFromText,
} from "../../runner-identity/announcement.ts";
import {
  HOSTED_RUNNER_VCPUS,
  hostedRunnerDefaultConcurrency,
  hostedRunnerName,
  isHostedConcurrency,
} from "../../named-runners/hosted.ts";
import type {
  HostedRunner,
  NamedRunner,
  SelfHostedRunner,
} from "../../named-runners/types.ts";

export type NamedRunnersRepository = {
  /** The hosted runners (smallest first), then the self-hosted ones that are not revoked (by name, case ignored). */
  list(): Promise<NamedRunner[]>;
  /** One runner by its id, a revoked one too (it is the answer "revoked", not "unknown"); undefined for an id of no runner of the workspace. */
  find(id: string): Promise<NamedRunner | undefined>;
  /** Sets how many turns a hosted runner may run at the same time. False for an id that is no hosted runner of the workspace, or a bad number. */
  setHostedConcurrency(id: string, concurrency: number): Promise<boolean>;
};

function hostedFrom(
  row: Selectable<ImplementerEnvironmentsTable>,
): HostedRunner {
  return {
    kind: "hosted",
    id: row.id,
    name: row.name,
    // A hosted runner always has a size and a concurrency (the check of the table); the fallbacks only satisfy the types.
    vcpus: row.vcpus ?? 0,
    concurrency: row.concurrency ?? 1,
  };
}

function selfHostedFrom(row: Selectable<RunnersTable>): SelfHostedRunner {
  return {
    kind: "self_hosted",
    id: row.id,
    name: row.name,
    labels: labelsFromText(row.labels),
    baseVersion: row.base_version,
    manifest: manifestFromText(row.manifest),
    limits: limitsFromText(row.limits),
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

const ID_MAX_LENGTH = 128;

/** An id the database is not asked about: not text of a sane length, or with a NUL byte (Postgres refuses it as an error). */
function isUsableId(id: string): boolean {
  return id.length > 0 && id.length <= ID_MAX_LENGTH && !id.includes("\u0000");
}

export function createNamedRunnersRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): NamedRunnersRepository {
  return {
    async list() {
      const hosted = await db
        .selectFrom("implementer_environments")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("concurrency", "is not", null)
        .orderBy("vcpus")
        .orderBy("id")
        .execute();
      const own = await db
        .selectFrom("runners")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("revoked_at", "is", null)
        .orderBy((eb) => eb.fn("lower", ["name"]))
        .orderBy("id")
        .execute();
      return [...hosted.map(hostedFrom), ...own.map(selfHostedFrom)];
    },

    async find(id) {
      if (!isUsableId(id)) return undefined;
      const hosted = await db
        .selectFrom("implementer_environments")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("concurrency", "is not", null)
        .where("id", "=", id)
        .executeTakeFirst();
      if (hosted !== undefined) return hostedFrom(hosted);
      const own = await db
        .selectFrom("runners")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      return own === undefined ? undefined : selfHostedFrom(own);
    },

    async setHostedConcurrency(id, concurrency) {
      if (!isUsableId(id) || !isHostedConcurrency(concurrency)) return false;
      const result = await db
        .updateTable("implementer_environments")
        .set({ concurrency })
        .where("workspace_id", "=", workspaceId)
        .where("concurrency", "is not", null)
        .where("id", "=", id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
  };
}

/**
 * Takes the lock of the workspace's runner names: everything that makes a runner or renames one takes it first, so two of them cannot both
 * find a name free. A lock on the workspace row that does not block the foreign keys of the rows being inserted.
 */
export async function lockRunnerNames(
  trx: Kysely<Database>,
  workspaceId: WorkspaceId,
): Promise<void> {
  await trx
    .selectFrom("workspaces")
    .select("id")
    .where("id", "=", workspaceId)
    .forNoKeyUpdate()
    .executeTakeFirst();
}

/**
 * Whether a name is taken in the workspace, without regard to case, in either table (ADR 0007): by a runner that is not revoked, or by a
 * hosted runner. `exceptRunnerId` is the runner being renamed. Asked under `lockRunnerNames`.
 */
export async function nameTaken(
  trx: Kysely<Database>,
  workspaceId: WorkspaceId,
  name: string,
  exceptRunnerId?: string,
): Promise<boolean> {
  let runners = trx
    .selectFrom("runners")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("revoked_at", "is", null)
    .where(sql<boolean>`lower(name) = lower(${name})`);
  if (exceptRunnerId !== undefined)
    runners = runners.where("id", "<>", exceptRunnerId);
  if ((await runners.executeTakeFirst()) !== undefined) return true;
  const hosted = await trx
    .selectFrom("implementer_environments")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("concurrency", "is not", null)
    .where(sql<boolean>`lower(name) = lower(${name})`)
    .executeTakeFirst();
  return hosted !== undefined;
}

/**
 * Makes the hosted runner of every type the workspace does not have yet, each with the concurrency the operator set (a workspace made
 * later gets them with it; the migration made them for the workspaces that existed). Asked again it makes nothing. A name that an
 * environment of a person or a runner that is not revoked has is not taken from it: the hosted runner then gets " (hosted)" after it.
 */
export async function ensureHostedRunners(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: {
    now?: () => Date;
    newId?: () => string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const concurrency = hostedRunnerDefaultConcurrency(
    options.env ?? process.env,
  );
  const timestamp = formatTimestamp(now());
  const have = await executor
    .selectFrom("implementer_environments")
    .select("vcpus")
    .where("workspace_id", "=", workspaceId)
    .where("concurrency", "is not", null)
    .execute();
  const present = new Set(have.map((row) => row.vcpus));
  for (const vcpus of HOSTED_RUNNER_VCPUS) {
    if (present.has(vcpus)) continue;
    const base = hostedRunnerName(vcpus);
    const taken =
      (await executor
        .selectFrom("implementer_environments")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where(sql<boolean>`lower(name) = lower(${base})`)
        .executeTakeFirst()) !== undefined ||
      (await nameTaken(executor, workspaceId, base));
    await executor
      .insertInto("implementer_environments")
      .values({
        id: newId(),
        workspace_id: workspaceId,
        name: taken ? `${base} (hosted)` : base,
        vcpus,
        setup_script: "",
        kind: "hosted",
        labels: "",
        concurrency,
        created_by: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
}
