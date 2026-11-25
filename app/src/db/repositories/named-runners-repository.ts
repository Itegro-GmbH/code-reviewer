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
  cloudflareRunnerVcpus,
  HOSTED_RUNNER_VCPUS,
  hostedRunnerDefaultConcurrency,
  hostedRunnerName,
  isHostedConcurrency,
} from "../../named-runners/hosted.ts";
import type { HostedPlacement } from "../../runner-identity/labels.ts";
import type {
  HostedRunner,
  NamedRunner,
  SelfHostedRunner,
} from "../../named-runners/types.ts";

export type NamedRunnersRepository = {
  /**
   * The hosted runners (smallest first), then the self-hosted ones that are not revoked (by name, case ignored). A workspace that lacks a
   * hosted runner (the previous release deleted one through its environments, or made the workspace after the migration) gets it here,
   * under the workspace's lock (`ensureHostedRunners`): the hosted runners repair themselves where they are read.
   */
  list(): Promise<NamedRunner[]>;
  /** One runner by its id, a revoked one too (it is the answer "revoked", not "unknown"); undefined for an id of no runner of the workspace. */
  find(id: string): Promise<NamedRunner | undefined>;
  /** Sets how many turns a hosted runner may run at the same time. False for an id that is no hosted runner of the workspace, or a bad number. */
  setHostedConcurrency(id: string, concurrency: number): Promise<boolean>;
};

/** The types a workspace has when it is whole: every Vercel size, and the Cloudflare sizes the operator enabled (#1158). */
function wantedTypes(
  env: Record<string, string | undefined>,
): { placement: HostedPlacement; vcpus: number }[] {
  return [
    ...HOSTED_RUNNER_VCPUS.map((vcpus) => ({
      placement: "vercel" as const,
      vcpus,
    })),
    ...cloudflareRunnerVcpus(env).map((vcpus) => ({
      placement: "cloudflare" as const,
      vcpus,
    })),
  ];
}

function placementOf(row: Selectable<ImplementerEnvironmentsTable>) {
  return row.placement === "cloudflare" ? "cloudflare" : "vercel";
}

function hostedFrom(
  row: Selectable<ImplementerEnvironmentsTable>,
  env: Record<string, string | undefined>,
): HostedRunner {
  const placement = placementOf(row);
  return {
    kind: "hosted",
    id: row.id,
    name: row.name,
    // A hosted runner always has a size and a concurrency (the check of the table); the fallbacks only satisfy the types.
    vcpus: row.vcpus ?? 0,
    placement,
    // A Cloudflare runner is offered only for a size the operator enabled; a size switched off later keeps its row (lanes name it).
    available:
      placement === "vercel" ||
      cloudflareRunnerVcpus(env).includes(row.vcpus ?? 0),
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
  repair: HostedRunnerOptions = {},
): NamedRunnersRepository {
  const env = repair.env ?? process.env;
  const readHosted = () =>
    db
      .selectFrom("implementer_environments")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("concurrency", "is not", null)
      .orderBy("vcpus")
      // Vercel before Cloudflare within one size (the order of the list the validator and the Setup page show).
      .orderBy("placement", "desc")
      .orderBy("id")
      .execute();
  return {
    async list() {
      let hosted = await readHosted();
      const present = new Set(
        hosted.map((row) => `${placementOf(row)}:${String(row.vcpus)}`),
      );
      if (
        wantedTypes(env).some(
          (type) => !present.has(`${type.placement}:${String(type.vcpus)}`),
        )
      ) {
        // A type is missing. Make it under the workspace's lock (another reader may be doing the same: the second finds it made), then read again.
        const run = async (trx: Kysely<Database>) => {
          await lockRunnerNames(trx, workspaceId);
          await ensureHostedRunners(trx, workspaceId, repair);
        };
        if (db.isTransaction) await run(db);
        else await db.transaction().execute(run);
        hosted = await readHosted();
      }
      const own = await db
        .selectFrom("runners")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("revoked_at", "is", null)
        .orderBy((eb) => eb.fn("lower", ["name"]))
        .orderBy("id")
        .execute();
      return [
        ...hosted.map((row) => hostedFrom(row, env)),
        ...own.map(selfHostedFrom),
      ];
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
      if (hosted !== undefined) return hostedFrom(hosted, env);
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

export type HostedRunnerOptions = {
  now?: () => Date;
  newId?: () => string;
  env?: Record<string, string | undefined>;
};

/** How many names " (hosted)", " (hosted 2)", ... are tried before the name clash is raised. */
const HOSTED_NAME_TRIES = 50;

/**
 * Makes the hosted runner of every type the workspace does not have yet, each with the concurrency the operator set (a workspace made
 * later gets them with it; the migration made them for the workspaces that existed; `NamedRunnersRepository.list` repairs a workspace that
 * lacks one). Asked again it makes nothing. A name that an environment of a person or a runner that is not revoked has is not taken from it:
 * the hosted runner then gets " (hosted)" after it, or " (hosted 2)" and so on if that is taken too. Only a second hosted runner of the
 * same type is ignored (the conflict target below); any other clash of names is an error, never a silently missing type. Asked under
 * `lockRunnerNames` where it matters (`list` does).
 */
export async function ensureHostedRunners(
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: HostedRunnerOptions = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const concurrency = hostedRunnerDefaultConcurrency(
    options.env ?? process.env,
  );
  const timestamp = formatTimestamp(now());
  const have = await executor
    .selectFrom("implementer_environments")
    .select(["vcpus", "placement"])
    .where("workspace_id", "=", workspaceId)
    .where("concurrency", "is not", null)
    .execute();
  const present = new Set(
    have.map((row) => `${row.placement}:${String(row.vcpus)}`),
  );
  const nameInUse = async (name: string) =>
    (await executor
      .selectFrom("implementer_environments")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst()) !== undefined ||
    (await nameTaken(executor, workspaceId, name));
  for (const { placement, vcpus } of wantedTypes(options.env ?? process.env)) {
    if (present.has(`${placement}:${String(vcpus)}`)) continue;
    const base = hostedRunnerName(vcpus, placement);
    let name = base;
    for (let attempt = 0; await nameInUse(name); attempt += 1) {
      // After the tries the last name is used as it is: the insert then raises the clash on the name index.
      if (attempt >= HOSTED_NAME_TRIES) break;
      name = `${base} (hosted${attempt === 0 ? "" : ` ${String(attempt + 1)}`})`;
    }
    await executor
      .insertInto("implementer_environments")
      .values({
        id: newId(),
        workspace_id: workspaceId,
        name,
        vcpus,
        setup_script: "",
        kind: "hosted",
        labels: "",
        placement,
        concurrency,
        created_by: null,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["workspace_id", "placement", "vcpus"])
          .where("concurrency", "is not", null)
          .doNothing(),
      )
      .execute();
  }
}
