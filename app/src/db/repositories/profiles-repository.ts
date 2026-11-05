// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the profiles of ONE workspace (the tables `profiles` and `profile_versions`; the factory takes the workspace id, see
// ../workspace-scope.ts). A profile is a name and a list of versions; every save adds a version and makes it the current one, no
// version is ever changed (the database refuses an update; only the erasure of a workspace deletes), and the name never changes. A
// profile is never deleted by the user but archived: hidden from the list, no new version, not started, not counted against the
// maximum, its name free for a new profile, its versions kept (a turn may have run with one); a bounded number of them per
// workspace, so archiving and creating again cannot grow the rows for ever. A row of another workspace is simply not there. The
// rules that need the database live here: a name once per workspace, a bounded count of profiles and of versions, and the next
// version number, all decided under a lock on the profile (or, for a new one, on the workspace row) so that two writers cannot both
// take the same place. What a profile may say is the validator's (src/profiles/); the repository stores what it is given. The default
// result schema is kept as the JSON text that was validated, so this layer imports nothing from the workflow format.
import "server-only";
import { type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import {
  decodeModelChoice,
  encodeModelChoice,
  type ModelChoice,
} from "../implementer-model-choice.ts";
import type {
  Database,
  ProfilesTable,
  ProfileVersionsTable,
} from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type StoredProfile = {
  id: string;
  workspaceId: string;
  name: string;
  /** The number of the current version. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** When the profile was archived, `null` while it is not. */
  archivedAt: string | null;
};

/** What a version says. */
export type ProfileContent = {
  description: string;
  model: ModelChoice;
  /** The system-level text the agent is given; empty for none. */
  instructions: string;
  /** Whole US cents per turn; null: the operator's maximum alone. */
  costLimitCents: number | null;
  canPush: boolean;
  /** The JSON text of the default result schema, or null for none. */
  defaultResult: string | null;
};

export type StoredProfileVersion = {
  profileId: string;
  version: number;
  content: ProfileContent;
  createdBy: string;
  createdAt: string;
};

/** A version without its content: for the list of versions of a profile. */
export type ProfileVersionSummary = Omit<StoredProfileVersion, "content">;

export type NewProfile = {
  name: string;
  content: ProfileContent;
  createdBy: string;
};

export type NewProfileVersion = {
  content: ProfileContent;
  createdBy: string;
  /** Save only if this is still the current version; otherwise `version_conflict`. */
  expectedVersion?: number;
};

export type CreateOutcome =
  | { ok: true; profile: StoredProfile; saved: StoredProfileVersion }
  | { ok: false; reason: "name_taken" | "limit_reached" };

export type SaveOutcome =
  | { ok: true; profile: StoredProfile; saved: StoredProfileVersion }
  | {
      ok: false;
      reason:
        "not_found" | "archived" | "version_conflict" | "version_limit_reached";
      /** On `version_conflict`: the version that is current. */
      current?: number;
    };

export type ArchiveOutcome =
  | { ok: true; profile: StoredProfile }
  | { ok: false; reason: "not_found" | "limit_reached" };

/** What the validator of a workflow asks of a version it runs. */
export type ProfileVersionFactsRow = {
  profileId: string;
  version: number;
  canPush: boolean;
  /** The JSON text of the default result schema, or null. */
  defaultResult: string | null;
  /** Whether the version's model is a managed one: a catalog entry on the platform's key (#854). */
  managedModel: boolean;
};

export type ProfilesRepository = {
  /** The profiles of the workspace that are not archived, by name, without their versions' content. */
  list(): Promise<StoredProfile[]>;
  /** The names of the archived profiles, each once, by name: what the validator of a workflow says is archived and not unknown. */
  archivedNames(): Promise<string[]>;
  /** The profile with its current version, also when it is archived (its versions stay readable). */
  get(
    id: string,
  ): Promise<
    { profile: StoredProfile; current: StoredProfileVersion } | undefined
  >;
  /** One saved version of a profile. */
  getVersion(
    id: string,
    version: number,
  ): Promise<StoredProfileVersion | undefined>;
  /** The versions of a profile, the newest first. Empty for an id that is not there. */
  listVersions(id: string): Promise<ProfileVersionSummary[]>;
  /**
   * A profile that is not archived by its name, with the version asked for or the newest. Undefined for a name that is free or
   * archived, and for a version that does not exist. This is how a turn is started with a profile.
   */
  findByName(
    name: string,
    version?: number,
  ): Promise<
    { profile: StoredProfile; version: StoredProfileVersion } | undefined
  >;
  /** The facts of the versions asked for (`profileId` and `version`); the ones that do not exist are left out. */
  versionFacts(
    versions: readonly { profileId: string; version: number }[],
  ): Promise<ProfileVersionFactsRow[]>;
  /** `maximum` is how many profiles the workspace may hold, counted with the new one. Saved as version 1. */
  create(input: NewProfile, maximum: number): Promise<CreateOutcome>;
  /** Saves a new version (the next number) and makes it current; the name stays. */
  saveVersion(
    id: string,
    input: NewProfileVersion,
    maximumVersions: number,
  ): Promise<SaveOutcome>;
  /**
   * Archives a profile. Asked again, it answers the same (the first time stays). `maximum` is how many archived profiles the
   * workspace may hold, counted with this one: one more is `limit_reached`, and the profile stays as it is.
   */
  archive(id: string, maximum: number): Promise<ArchiveOutcome>;
};

function profileFrom(row: Selectable<ProfilesTable>): StoredProfile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    version: row.current_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function contentFrom(row: Selectable<ProfileVersionsTable>): ProfileContent {
  return {
    description: row.description,
    model: decodeModelChoice(row.model_choice),
    instructions: row.instructions,
    costLimitCents: row.cost_limit_cents,
    canPush: row.can_push === 1,
    defaultResult: row.default_result,
  };
}

function versionFrom(
  row: Selectable<ProfileVersionsTable>,
): StoredProfileVersion {
  return {
    profileId: row.profile_id,
    version: row.version,
    content: contentFrom(row),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createProfilesRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date; newId?: () => string } = {},
): ProfilesRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const inTransaction = <T>(
    run: (trx: Kysely<Database>) => Promise<T>,
  ): Promise<T> => (db.isTransaction ? run(db) : db.transaction().execute(run));

  const versionValues = (
    id: string,
    version: number,
    content: ProfileContent,
    createdBy: string,
    timestamp: string,
  ) => ({
    profile_id: id,
    version,
    workspace_id: workspaceId,
    description: content.description,
    model_choice: encodeModelChoice(content.model),
    instructions: content.instructions,
    cost_limit_cents: content.costLimitCents,
    can_push: content.canPush ? 1 : 0,
    default_result: content.defaultResult,
    created_by: createdBy,
    created_at: timestamp,
  });

  return {
    async list() {
      const rows = await db
        .selectFrom("profiles")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("archived_at", "is", null)
        .orderBy("name")
        .orderBy("id")
        .execute();
      return rows.map(profileFrom);
    },

    async archivedNames() {
      const rows = await db
        .selectFrom("profiles")
        .select("name")
        .distinct()
        .where("workspace_id", "=", workspaceId)
        .where("archived_at", "is not", null)
        .orderBy("name")
        .execute();
      return rows.map((row) => row.name);
    },

    async get(id) {
      const profile = await db
        .selectFrom("profiles")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (profile === undefined) return undefined;
      const version = await db
        .selectFrom("profile_versions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("profile_id", "=", id)
        .where("version", "=", profile.current_version)
        .executeTakeFirstOrThrow();
      return { profile: profileFrom(profile), current: versionFrom(version) };
    },

    async getVersion(id, version) {
      const row = await db
        .selectFrom("profile_versions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("profile_id", "=", id)
        .where("version", "=", version)
        .executeTakeFirst();
      return row === undefined ? undefined : versionFrom(row);
    },

    async listVersions(id) {
      const rows = await db
        .selectFrom("profile_versions")
        .select(["profile_id", "version", "created_by", "created_at"])
        .where("workspace_id", "=", workspaceId)
        .where("profile_id", "=", id)
        .orderBy("version", "desc")
        .execute();
      return rows.map((row) => ({
        profileId: row.profile_id,
        version: row.version,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }));
    },

    async findByName(name, version) {
      const profile = await db
        .selectFrom("profiles")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("name", "=", name)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (profile === undefined) return undefined;
      const row = await db
        .selectFrom("profile_versions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("profile_id", "=", profile.id)
        .where("version", "=", version ?? profile.current_version)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return { profile: profileFrom(profile), version: versionFrom(row) };
    },

    async versionFacts(versions) {
      if (versions.length === 0) return [];
      const rows = await db
        .selectFrom("profile_versions")
        .select([
          "profile_id",
          "version",
          "can_push",
          "default_result",
          "model_choice",
        ])
        .where("workspace_id", "=", workspaceId)
        .where((eb) =>
          eb.or(
            versions.map((v) =>
              eb.and([
                eb("profile_id", "=", v.profileId),
                eb("version", "=", v.version),
              ]),
            ),
          ),
        )
        .orderBy("profile_id")
        .orderBy("version")
        .execute();
      return rows.map((row) => ({
        profileId: row.profile_id,
        version: row.version,
        canPush: row.can_push === 1,
        defaultResult: row.default_result,
        managedModel: "entryId" in decodeModelChoice(row.model_choice),
      }));
    },

    create(input, maximum) {
      return inTransaction(async (trx): Promise<CreateOutcome> => {
        // Creators of one workspace take turns. A lock that does not block the foreign keys of the rows being inserted.
        await trx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        const { count } = await trx
          .selectFrom("profiles")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("archived_at", "is", null)
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const timestamp = formatTimestamp(now());
        // `do nothing` instead of a raised violation: a name that is taken is an answer and must not abort a caller's transaction.
        const row = await trx
          .insertInto("profiles")
          .values({
            id: newId(),
            workspace_id: workspaceId,
            name: input.name,
            current_version: 1,
            created_by: input.createdBy,
            created_at: timestamp,
            updated_at: timestamp,
          })
          .onConflict((conflict) => conflict.doNothing())
          .returningAll()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "name_taken" };
        const saved = await trx
          .insertInto("profile_versions")
          .values(
            versionValues(row.id, 1, input.content, input.createdBy, timestamp),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          ok: true,
          profile: profileFrom(row),
          saved: versionFrom(saved),
        };
      });
    },

    async saveVersion(id, input, maximumVersions) {
      return inTransaction(async (trx): Promise<SaveOutcome> => {
        // The profile row is the lock: writers of one profile take turns, so the next number is never taken twice.
        const row = await trx
          .selectFrom("profiles")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "not_found" };
        if (row.archived_at !== null) return { ok: false, reason: "archived" };
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== row.current_version
        )
          return {
            ok: false,
            reason: "version_conflict",
            current: row.current_version,
          };
        if (row.current_version >= maximumVersions)
          return { ok: false, reason: "version_limit_reached" };
        const timestamp = formatTimestamp(now());
        const version = row.current_version + 1;
        const saved = await trx
          .insertInto("profile_versions")
          .values(
            versionValues(
              id,
              version,
              input.content,
              input.createdBy,
              timestamp,
            ),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        const updated = await trx
          .updateTable("profiles")
          .set({ current_version: version, updated_at: timestamp })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          ok: true,
          profile: profileFrom(updated),
          saved: versionFrom(saved),
        };
      });
    },

    async archive(id, maximum) {
      return inTransaction(async (trx): Promise<ArchiveOutcome> => {
        // Archivers (and creators) of one workspace take turns, so two of them cannot both pass the count.
        await trx
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        const row = await trx
          .selectFrom("profiles")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "not_found" };
        if (row.archived_at !== null)
          return { ok: true, profile: profileFrom(row) };
        const { count } = await trx
          .selectFrom("profiles")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("archived_at", "is not", null)
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const timestamp = formatTimestamp(now());
        const archived = await trx
          .updateTable("profiles")
          .set({ archived_at: timestamp, updated_at: timestamp })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { ok: true, profile: profileFrom(archived) };
      });
    },
  };
}
