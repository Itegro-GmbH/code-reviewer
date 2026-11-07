// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the projects table of ONE workspace (the factory takes the workspace id; see
// ../workspace-scope.ts; a project belongs to the workspace of its repository). The only code that
// reads or writes it. A project is a repository the instance reviews. The row is created by the first
// activation or by the first save of settings (then switched off), and never deleted: deactivating
// sets `active` to 0, and activating again switches the same row back on, so the settings a project
// collected in between survive. Only an active row is ever reviewed; a row that is off is just a place
// for settings. A repository the platform stopped listing keeps its row too; it is "unavailable" and
// cannot be activated (the repositories table says so, not this one).
import "server-only";
import { lockDynamicReviewGate } from "../dynamic-review-lock.ts";
import { sql, type Kysely } from "kysely";
import type {
  IntegrationStatus,
  IntegrationType,
  JsonValue,
} from "../../integrations/types.ts";
import {
  decodeBoolean,
  tryDecodeJson,
  encodeBoolean,
  encodeJson,
  formatTimestamp,
} from "../codecs.ts";
import type { Database, ProjectsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type ProjectSettings = { [key: string]: JsonValue };

/** The GitHub Project (projects_v2) that is the board of a project's tickets (#922): its node id and the node id of its `Status` field. */
export type TicketBoard = { projectV2Id: string; statusFieldId: string };

/**
 * What a project is in the factory (#922): the GitHub issues of one repository and, optionally, the GitHub Project that is their board.
 * `repositoryId` is always the repository of the project row (one project per repository), repeated so that a reader of the source
 * needs nothing else.
 */
export type TicketSource = {
  provider: "github";
  repositoryId: string;
  board: TicketBoard | null;
};

/** What a row without a stored source (every project an older version wrote) is: the issues of its repository, no board. */
export function defaultTicketSource(repositoryId: string): TicketSource {
  return { provider: "github", repositoryId, board: null };
}

/**
 * The ticket source of a row. Damaged or foreign text reads as the default with a warning that names the project (never the text), like
 * damaged settings; the repository is always the row's.
 */
function readTicketSource(
  text: string | null,
  repositoryId: string,
  projectId: string,
  warn: (message: string) => void,
): TicketSource {
  if (text === null) return defaultTicketSource(repositoryId);
  const decoded = tryDecodeJson<unknown>(text);
  const value = decoded.ok ? decoded.value : undefined;
  const board =
    typeof value === "object" && value !== null && "board" in value
      ? value.board
      : undefined;
  const wellFormed =
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    value.provider === "github" &&
    (board === null ||
      (typeof board === "object" &&
        board !== null &&
        "projectV2Id" in board &&
        typeof board.projectV2Id === "string" &&
        "statusFieldId" in board &&
        typeof board.statusFieldId === "string"));
  if (!wellFormed) {
    warn(
      `[db] PROJECT_TICKET_SOURCE_UNREADABLE: the stored ticket source of project ${projectId} is not usable and reads as the issues of its repository without a board.`,
    );
    return defaultTicketSource(repositoryId);
  }
  return {
    provider: "github",
    repositoryId,
    board:
      board === null
        ? null
        : {
            projectV2Id: (board as TicketBoard).projectV2Id,
            statusFieldId: (board as TicketBoard).statusFieldId,
          },
  };
}

/** A project as stored. */
export type StoredProject = {
  id: string;
  repositoryId: string;
  active: boolean;
  /** The tickets the project is about (#922); the issues of its repository unless a board was set. */
  ticketSource: TicketSource;
  /** The project's setting overrides (src/review-settings); empty until some are saved. */
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
};

/**
 * What the list shows for a repository:
 * - `active`: a project exists, is switched on, and the platform still lists the repository;
 * - `inactive`: no project yet, or it was switched off;
 * - `unavailable`: the platform no longer lists the repository, or its integration is suspended or
 *   removed (the project row, if any, is kept).
 */
export const PROJECT_STATUSES = ["active", "inactive", "unavailable"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** One repository of the list, with the integration it belongs to and its project, if it has one. */
export type ProjectListEntry = {
  repository: {
    id: string;
    externalId: string;
    fullName: string;
    url: string;
    /** False once the platform no longer lists the repository or its integration is disabled. */
    available: boolean;
    integration: {
      id: string;
      type: IntegrationType;
      displayName: string;
      status: IntegrationStatus;
    };
  };
  project: StoredProject | null;
  status: ProjectStatus;
};

/**
 * What a project created in the factory says beyond the switch (#922): `board` is the GitHub Project that is its board, or `null` for none.
 * Left out (the review switch of every other deployment), the stored ticket source is not touched.
 */
export type ActivateOptions = { board?: TicketBoard | null };

export type ActivateResult =
  | {
      kind: "activated";
      project: StoredProject;
      /**
       * `created`: no row existed; `reactivated`: the row was off (deactivated, or only created to hold
       * settings saved before the first activation); `unchanged`: it was on already.
       */
      outcome: "created" | "reactivated" | "unchanged";
    }
  | { kind: "repository_not_found" }
  | { kind: "repository_unavailable" }
  /** The repository is listed, but its integration is suspended or removed (status `disabled`). */
  | { kind: "integration_unavailable" };

export type DeactivateResult =
  | {
      kind: "deactivated";
      /** The project after the call; undefined when the repository never had one. */
      project: StoredProject | undefined;
      /** False when there was nothing to switch off (no project, or already off). */
      changed: boolean;
    }
  | { kind: "repository_not_found" };

/**
 * Runs inside the deactivation's transaction, with the project as it is now and the executor to use
 * for its own queries (never the outer connection, see src/db/README.md). A failure rolls the
 * deactivation back.
 */
export type AfterDeactivate = (
  project: StoredProject,
  executor: Kysely<Database>,
) => Promise<void>;

/** Computes the next settings from the stored ones, inside the write transaction (`updateSettingsWith`). */
export type ChangeProjectSettings = (
  current: ProjectSettings,
) => ProjectSettings;

/**
 * Runs inside the settings write transaction, with the project after the change and the executor to
 * use for its own queries. A failure rolls the write back, so no partial setting change is left.
 */
export type AfterSettingsChange = (
  project: StoredProject,
  executor: Kysely<Database>,
) => Promise<void>;

export type ProjectsRepository = {
  /** The project of a repository, switched on or not. */
  get(repositoryId: string): Promise<StoredProject | undefined>;
  /** The project of a repository when it is switched on and the platform still lists the repository. */
  findActiveForRepository(
    repositoryId: string,
  ): Promise<StoredProject | undefined>;
  /** Same, found by the platform's id of the repository (what a webhook carries). */
  findActiveForExternalRepository(
    integrationId: string,
    externalId: string,
  ): Promise<StoredProject | undefined>;
  /**
   * Switches the project of a repository on, creating it the first time, in one transaction. A
   * repository the platform no longer lists, or that does not exist, is refused without a write.
   */
  activate(
    repositoryId: string,
    options?: ActivateOptions,
  ): Promise<ActivateResult>;
  /** A project by its own id (#922), switched on or not; undefined for an id of another workspace. */
  getById(projectId: string): Promise<StoredProject | undefined>;
  /**
   * Switches the project of a repository off and keeps the row; an unknown repository is reported.
   * `afterDeactivate` runs in the same
   * transaction whenever the repository has a project (also when it was off already, so a repeated
   * call can finish cleaning up).
   */
  deactivate(
    repositoryId: string,
    afterDeactivate?: AfterDeactivate,
  ): Promise<DeactivateResult>;
  /**
   * Replaces the settings (the overrides of the review settings) of the project of a repository and
   * moves `updatedAt`. Works for a project that is switched off too. A repository without a project
   * gets one that is switched off, so settings can be saved before the first activation. Returns
   * the project after the change, or undefined (nothing written) when the repository does not exist
   * or the platform no longer lists it and it has no project.
   *
   * `afterChange` runs in the same transaction, so a change and whatever it triggers commit together
   * or not at all (`AfterSettingsChange`).
   */
  updateSettings(
    repositoryId: string,
    settings: ProjectSettings,
    afterChange?: AfterSettingsChange,
  ): Promise<StoredProject | undefined>;
  /**
   * Like `updateSettings`, but the next settings are computed from the stored ones inside the
   * transaction: `change` reads what is stored and returns what should be stored. This is the one
   * way a save can preserve fields it does not touch without a lost update between two savers.
   */
  updateSettingsWith(
    repositoryId: string,
    change: ChangeProjectSettings,
    afterChange?: AfterSettingsChange,
  ): Promise<StoredProject | undefined>;
  /**
   * Every repository the platform lists, plus the ones that disappeared but have a project, joined
   * with their integration and project, ordered by name.
   */
  list(): Promise<ProjectListEntry[]>;
  /**
   * `list`, read inside the given transaction after every repository row of the workspace was locked `FOR UPDATE` in
   * ascending id: the lock a project's own save and a job's enqueue take first, so the list agrees with what they see
   * and a write that must reach every project (the workspace review defaults, #676) cannot miss a concurrent enqueue.
   */
  listLocked(executor: Kysely<Database>): Promise<ProjectListEntry[]>;
  /** One entry of the list, found by the id of its repository; undefined when the list has none. */
  find(repositoryId: string): Promise<ProjectListEntry | undefined>;
};

/**
 * The settings of a project as an object. Damaged text (not JSON) must not take the project list, the
 * claim and every review down: it reads as no settings, and a warning names the project (never the
 * text). Saving settings again replaces it.
 */
function readSettings(
  text: string,
  projectId: string,
  warn: (message: string) => void,
): ProjectSettings {
  const decoded = tryDecodeJson<ProjectSettings>(text);
  if (decoded.ok) return decoded.value;
  warn(
    `[db] PROJECT_SETTINGS_UNREADABLE: the stored settings of project ${projectId} are not valid JSON and are ignored.`,
  );
  return {};
}

function toStoredProject(
  row: ProjectsTable,
  warn: (message: string) => void,
): StoredProject {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    active: decodeBoolean(row.active),
    ticketSource: readTicketSource(
      row.ticket_source,
      row.repository_id,
      row.id,
      warn,
    ),
    settings: readSettings(row.settings, row.id, warn),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The settings of a project row that is being created (#656), read inside the transaction that creates it. */
export type NewProjectSettings = (
  executor: Kysely<Database>,
  workspaceId: WorkspaceId,
) => Promise<ProjectSettings>;

export function createProjectsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
  newId: () => string = () => crypto.randomUUID(),
  warn: (message: string) => void = console.warn,
  /**
   * The settings a project row starts with when it is created (#656): the instance decides inside the write
   * transaction, so the default review kind of a new project is read together with the row it is written to. A project
   * that exists is never given them. Default: none.
   */
  newProjectSettings: NewProjectSettings = async () => ({}),
): ProjectsRepository {
  const toStored = (row: ProjectsTable): StoredProject =>
    toStoredProject(row, warn);

  // A transaction cannot start another one; inside one, just use it.
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    const guarded = async (trx: Kysely<Database>) => {
      await lockDynamicReviewGate(trx, false);
      return run(trx);
    };
    return db.isTransaction ? guarded(db) : db.transaction().execute(guarded);
  }

  async function findActive(
    where: (
      query: ReturnType<typeof baseActiveQuery>,
    ) => ReturnType<typeof baseActiveQuery>,
  ): Promise<StoredProject | undefined> {
    const row = await where(baseActiveQuery()).executeTakeFirst();
    return row === undefined ? undefined : toStored(row);
  }

  // The project columns of a switched-on project whose repository the platform still lists and whose
  // integration is not suspended or removed.
  function baseActiveQuery() {
    return db
      .selectFrom("projects")
      .innerJoin("repositories", "repositories.id", "projects.repository_id")
      .innerJoin(
        "integrations",
        "integrations.id",
        "repositories.integration_id",
      )
      .select([
        "projects.id",
        "projects.repository_id",
        "projects.active",
        "projects.settings",
        "projects.ticket_source",
        "projects.created_at",
        "projects.updated_at",
      ])
      .where("repositories.workspace_id", "=", workspaceId)
      .where("projects.active", "=", encodeBoolean(true))
      .where("repositories.active", "=", encodeBoolean(true))
      .where("integrations.status", "=", "active");
  }

  function entryQuery(executor: Kysely<Database> = db) {
    return (
      executor
        .selectFrom("repositories")
        .innerJoin(
          "integrations",
          "integrations.id",
          "repositories.integration_id",
        )
        .leftJoin("projects", "projects.repository_id", "repositories.id")
        .select([
          "repositories.id as repository_id",
          "repositories.external_id as repository_external_id",
          "repositories.full_name as repository_full_name",
          "repositories.url as repository_url",
          "repositories.active as repository_active",
          "integrations.id as integration_id",
          "integrations.type as integration_type",
          "integrations.display_name as integration_display_name",
          "integrations.status as integration_status",
          "projects.id as project_id",
          "projects.active as project_active",
          "projects.settings as project_settings",
          "projects.ticket_source as project_ticket_source",
          "projects.created_at as project_created_at",
          "projects.updated_at as project_updated_at",
        ])
        .where("repositories.workspace_id", "=", workspaceId)
        // A repository that disappeared and never had a project is of no interest to anybody.
        .where((eb) =>
          eb.or([
            eb("repositories.active", "=", encodeBoolean(true)),
            eb("projects.id", "is not", null),
          ]),
        )
        // Case-insensitive, with the id as the tie-breaker: names that differ only by case keep a stable place.
        .orderBy(sql`lower(repositories.full_name)`)
        .orderBy("repositories.id")
    );
  }

  function toEntry(
    row: Awaited<ReturnType<ReturnType<typeof entryQuery>["execute"]>>[number],
  ): ProjectListEntry {
    const available =
      decodeBoolean(row.repository_active) &&
      row.integration_status === "active";
    const project: StoredProject | null =
      row.project_id === null ||
      row.project_active === null ||
      row.project_settings === null ||
      row.project_created_at === null ||
      row.project_updated_at === null
        ? null
        : {
            id: row.project_id,
            repositoryId: row.repository_id,
            active: decodeBoolean(row.project_active),
            ticketSource: readTicketSource(
              row.project_ticket_source,
              row.repository_id,
              row.project_id,
              warn,
            ),
            settings: readSettings(row.project_settings, row.project_id, warn),
            createdAt: row.project_created_at,
            updatedAt: row.project_updated_at,
          };
    const status: ProjectStatus = !available
      ? "unavailable"
      : project?.active === true
        ? "active"
        : "inactive";
    return {
      repository: {
        id: row.repository_id,
        externalId: row.repository_external_id,
        fullName: row.repository_full_name,
        url: row.repository_url,
        available,
        integration: {
          id: row.integration_id,
          type: row.integration_type as IntegrationType,
          displayName: row.integration_display_name,
          status: row.integration_status as IntegrationStatus,
        },
      },
      project,
      status,
    };
  }

  /**
   * The one settings write: replaces or creates the project row of a repository with the settings
   * `change` computes from the stored ones, in one transaction. The stored settings are read under a
   * lock on the workspace-scoped repository row (`FOR UPDATE`, taken before the read), so a concurrent
   * `change` cannot lose an update. `afterChange` runs in that same transaction, so the
   * write and whatever it triggers commit together or roll back together.
   */
  function applySettings(
    repositoryId: string,
    change: ChangeProjectSettings,
    afterChange?: AfterSettingsChange,
  ): Promise<StoredProject | undefined> {
    return inTransaction(async (trx) => {
      const timestamp = formatTimestamp(now());
      // Lock the repository row (of this workspace) before reading the project. It exists for every
      // settings save, project row or not, so it covers the first save too.
      const repositoryQuery = trx
        .selectFrom("repositories")
        .select(["id", "active"])
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", repositoryId);
      const repository = await repositoryQuery.forUpdate().executeTakeFirst();
      if (repository === undefined) return undefined;

      const existing = await trx
        .selectFrom("projects")
        .selectAll()
        .where("repository_id", "=", repositoryId)
        .executeTakeFirst();
      if (existing !== undefined) {
        const next = change(readSettings(existing.settings, existing.id, warn));
        const row = await trx
          .updateTable("projects")
          .set({ settings: encodeJson(next), updated_at: timestamp })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const project = toStored(row);
        if (afterChange !== undefined) await afterChange(project, trx);
        return project;
      }

      // No project yet: make one that is switched off. The repository must be one the list shows
      // (the platform still lists it). Unlike activating, a suspended or removed installation does
      // not matter: the row is off and only keeps settings, which is also what the settings page
      // of an unavailable repository promises ("its settings are kept").
      if (!decodeBoolean(repository.active)) return undefined;
      const row = await trx
        .insertInto("projects")
        .values({
          id: newId(),
          repository_id: repositoryId,
          active: encodeBoolean(false),
          settings: encodeJson(
            change(await newProjectSettings(trx, workspaceId)),
          ),
          created_at: timestamp,
          updated_at: timestamp,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const project = toStored(row);
      if (afterChange !== undefined) await afterChange(project, trx);
      return project;
    });
  }

  return {
    async get(repositoryId) {
      const row = await db
        .selectFrom("projects")
        .innerJoin("repositories", "repositories.id", "projects.repository_id")
        .selectAll("projects")
        .where("repositories.workspace_id", "=", workspaceId)
        .where("projects.repository_id", "=", repositoryId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    async getById(projectId) {
      const row = await db
        .selectFrom("projects")
        .innerJoin("repositories", "repositories.id", "projects.repository_id")
        .selectAll("projects")
        .where("repositories.workspace_id", "=", workspaceId)
        .where("projects.id", "=", projectId)
        .executeTakeFirst();
      return row === undefined ? undefined : toStored(row);
    },

    findActiveForRepository(repositoryId) {
      return findActive((query) =>
        query.where("projects.repository_id", "=", repositoryId),
      );
    },

    findActiveForExternalRepository(integrationId, externalId) {
      return findActive((query) =>
        query
          .where("repositories.integration_id", "=", integrationId)
          .where("repositories.external_id", "=", externalId),
      );
    },

    activate(repositoryId, options = {}) {
      // The repository row is locked (`FOR UPDATE`, only that row, not the integration's) before anything is read:
      // the check of the repository and the write happen under it, so a sync that deactivates the repository cannot
      // slip in between, two activations cannot both insert, and a first settings save (which takes the same lock)
      // cannot insert next to an activation.
      return inTransaction(async (trx): Promise<ActivateResult> => {
        const repository = await trx
          .selectFrom("repositories")
          .innerJoin(
            "integrations",
            "integrations.id",
            "repositories.integration_id",
          )
          .select([
            "repositories.id",
            "repositories.active",
            "integrations.status as integration_status",
          ])
          .where("repositories.workspace_id", "=", workspaceId)
          .where("repositories.id", "=", repositoryId)
          .forUpdate("repositories")
          .executeTakeFirst();
        if (repository === undefined) return { kind: "repository_not_found" };
        if (!decodeBoolean(repository.active))
          return { kind: "repository_unavailable" };
        if (repository.integration_status !== "active")
          return { kind: "integration_unavailable" };

        const timestamp = formatTimestamp(now());
        const existing = await trx
          .selectFrom("projects")
          .selectAll()
          .where("repository_id", "=", repositoryId)
          .executeTakeFirst();
        const ticketSource =
          options.board === undefined
            ? undefined
            : encodeJson({
                provider: "github",
                repositoryId,
                board: options.board,
              });

        if (existing === undefined) {
          const row = await trx
            .insertInto("projects")
            .values({
              id: newId(),
              repository_id: repositoryId,
              active: encodeBoolean(true),
              settings: encodeJson(await newProjectSettings(trx, workspaceId)),
              ...(ticketSource === undefined
                ? {}
                : { ticket_source: ticketSource }),
              created_at: timestamp,
              updated_at: timestamp,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return {
            kind: "activated",
            project: toStored(row),
            outcome: "created",
          };
        }

        if (decodeBoolean(existing.active) && ticketSource === undefined)
          return {
            kind: "activated",
            project: toStored(existing),
            outcome: "unchanged",
          };

        const row = await trx
          .updateTable("projects")
          .set({
            active: encodeBoolean(true),
            ...(ticketSource === undefined
              ? {}
              : { ticket_source: ticketSource }),
            updated_at: timestamp,
          })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          kind: "activated",
          project: toStored(row),
          outcome: "reactivated",
        };
      });
    },

    deactivate(repositoryId, afterDeactivate) {
      return inTransaction(async (trx): Promise<DeactivateResult> => {
        const repository = await trx
          .selectFrom("repositories")
          .select("id")
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", repositoryId)
          .forUpdate()
          .executeTakeFirst();
        if (repository === undefined) return { kind: "repository_not_found" };
        const existing = await trx
          .selectFrom("projects")
          .selectAll()
          .where("repository_id", "=", repositoryId)
          .executeTakeFirst();
        if (existing === undefined)
          return { kind: "deactivated", project: undefined, changed: false };

        const changed = decodeBoolean(existing.active);
        const row = changed
          ? await trx
              .updateTable("projects")
              .set({
                active: encodeBoolean(false),
                updated_at: formatTimestamp(now()),
              })
              .where("id", "=", existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : existing;
        const project = toStored(row);
        if (afterDeactivate !== undefined) await afterDeactivate(project, trx);
        return { kind: "deactivated", project, changed };
      });
    },

    updateSettings(repositoryId, settings, afterChange) {
      return applySettings(repositoryId, () => settings, afterChange);
    },

    updateSettingsWith(repositoryId, change, afterChange) {
      return applySettings(repositoryId, change, afterChange);
    },

    async list() {
      const rows = await entryQuery().execute();
      return rows.map(toEntry);
    },

    async listLocked(executor) {
      if (!executor.isTransaction)
        throw new Error("listLocked requires a transaction.");
      await executor
        .selectFrom("repositories")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .orderBy("id")
        .forUpdate()
        .execute();
      const rows = await entryQuery(executor).execute();
      return rows.map(toEntry);
    },

    async find(repositoryId) {
      const row = await entryQuery()
        .where("repositories.id", "=", repositoryId)
        .executeTakeFirst();
      return row === undefined ? undefined : toEntry(row);
    },
  };
}
