// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the workflows of ONE workspace (the tables `workflows` and `workflow_versions`; the factory takes the workspace id,
// see ../workspace-scope.ts). A workflow is a name and a list of versions; every save adds a version and makes it the current one,
// no version is ever changed (the database refuses an update; only the erasure of a workspace deletes). A workflow is never deleted
// by the user but archived: hidden from the list, no new version, not counted against the maximum, its name free for a new workflow,
// its versions kept; a bounded number of them per workspace, so archiving and creating again cannot grow the rows for ever. A row of another workspace is simply not there. The rules that need the database live here: a name
// once per project (#922; per workspace for a lane without one) whatever its case, a bounded count of workflows and of versions, and the next version number, all decided
// under a lock on the workflow (or, for a new one, on the workspace row) so that two writers cannot both take the same place.
// What the document says is the validator's (src/workflows/); the repository stores the text it is given.
import "server-only";
import { type Kysely, type Selectable } from "kysely";
import { encodeBoolean, formatTimestamp } from "../codecs.ts";
import { UNIQUE_VIOLATION, errorCode } from "../errors.ts";
import type { Database, WorkflowsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type StoredWorkflow = {
  id: string;
  workspaceId: string;
  /** The project the lane belongs to (#922); null for an archived lane no project could take and for one an older version wrote. */
  projectId: string | null;
  name: string;
  /** The number of the current version. */
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** When the workflow was archived, `null` while it is not. */
  archivedAt: string | null;
};

export type StoredWorkflowVersion = {
  workflowId: string;
  version: number;
  /** The JSON text as it was saved. */
  document: string;
  createdBy: string;
  createdAt: string;
};

/** A version without its document: for the list of versions of a workflow. */
export type WorkflowVersionSummary = Omit<StoredWorkflowVersion, "document">;

export type NewWorkflow = {
  name: string;
  document: string;
  createdBy: string;
  /** The project the lane belongs to (#922). */
  projectId?: string;
};

export type NewVersion = NewWorkflow & {
  /** Save only if this is still the current version; otherwise `version_conflict`. */
  expectedVersion?: number;
};

export type CreateOutcome =
  | { ok: true; workflow: StoredWorkflow; saved: StoredWorkflowVersion }
  | {
      ok: false;
      /** `project_not_found`: the project is not one of this workspace (#922). */
      reason: "name_taken" | "limit_reached" | "project_not_found";
    };

export type SaveOutcome =
  | { ok: true; workflow: StoredWorkflow; saved: StoredWorkflowVersion }
  | {
      ok: false;
      reason:
        | "not_found"
        | "archived"
        | "name_taken"
        | "version_conflict"
        | "version_limit_reached";
      /** On `version_conflict`: the version that is current. */
      current?: number;
    };

export type ArchiveOutcome =
  | { ok: true; workflow: StoredWorkflow }
  | { ok: false; reason: "not_found" | "limit_reached" };

export type WorkflowsRepository = {
  /**
   * The workflows of the workspace that are not archived, by name (case ignored), without their documents; with `projectId` only the
   * lanes of that project (#922).
   */
  list(filter?: { projectId?: string }): Promise<StoredWorkflow[]>;
  /**
   * The workflows that are not archived, with their current version, whose document names the label trigger, `ticket.labeled` or its old
   * name `github.issueLabeled` (#845, #916), and that belong to the active project whose ticket source is the repository
   * `repositoryId` (#922): a lane of another project, and a lane without a project, are not there.
   * A text match, not a reading of the JSON: the caller reads the document and decides, a document that only mentions the name
   * (a description) comes back too.
   */
  listWithIssueTrigger(
    repositoryId: string,
  ): Promise<{ workflow: StoredWorkflow; current: StoredWorkflowVersion }[]>;
  /** The workflow with its current version, also when it is archived (its versions stay readable). */
  get(
    id: string,
  ): Promise<
    { workflow: StoredWorkflow; current: StoredWorkflowVersion } | undefined
  >;
  /** One saved version of a workflow. */
  getVersion(
    id: string,
    version: number,
  ): Promise<StoredWorkflowVersion | undefined>;
  /** The versions of a workflow, the newest first. Empty for an id that is not there. */
  listVersions(id: string): Promise<WorkflowVersionSummary[]>;
  /** `maximum` is how many workflows the project may hold (the lanes without a project: together), counted with the new one. Saved as version 1. */
  create(input: NewWorkflow, maximum: number): Promise<CreateOutcome>;
  /** Saves a new version (the next number) and makes it current; the name of the workflow becomes `input.name`. */
  saveVersion(
    id: string,
    input: NewVersion,
    maximumVersions: number,
  ): Promise<SaveOutcome>;
  /**
   * Archives a workflow. Asked again, it answers the same (the first time stays). `maximum` is how many archived workflows the
   * workspace may hold, counted with this one: one more is `limit_reached`, and the workflow stays as it is.
   */
  archive(id: string, maximum: number): Promise<ArchiveOutcome>;
};

function workflowFrom(row: Selectable<WorkflowsTable>): StoredWorkflow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    name: row.name,
    version: row.current_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function versionFrom(row: {
  workflow_id: string;
  version: number;
  document: string;
  created_by: string;
  created_at: string;
}): StoredWorkflowVersion {
  return {
    workflowId: row.workflow_id,
    version: row.version,
    document: row.document,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createWorkflowsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date; newId?: () => string } = {},
): WorkflowsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const inTransaction = <T>(
    run: (trx: Kysely<Database>) => Promise<T>,
  ): Promise<T> => (db.isTransaction ? run(db) : db.transaction().execute(run));

  return {
    async list(filter = {}) {
      let query = db
        .selectFrom("workflows")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("archived_at", "is", null);
      if (filter.projectId !== undefined)
        query = query.where("project_id", "=", filter.projectId);
      const rows = await query
        .orderBy((eb) => eb.fn("lower", ["name"]))
        .orderBy("id")
        .execute();
      return rows.map(workflowFrom);
    },

    async listWithIssueTrigger(repositoryId) {
      const rows = await db
        .selectFrom("workflows")
        .innerJoin("projects", "projects.id", "workflows.project_id")
        .innerJoin("workflow_versions", (join) =>
          join
            .onRef("workflow_versions.workflow_id", "=", "workflows.id")
            .onRef(
              "workflow_versions.version",
              "=",
              "workflows.current_version",
            ),
        )
        .selectAll("workflows")
        .select([
          "workflow_versions.workflow_id as version_workflow_id",
          "workflow_versions.version as version_number",
          "workflow_versions.document as version_document",
          "workflow_versions.created_by as version_created_by",
          "workflow_versions.created_at as version_created_at",
        ])
        .where("workflows.workspace_id", "=", workspaceId)
        .where("workflow_versions.workspace_id", "=", workspaceId)
        .where("workflows.archived_at", "is", null)
        // The project row is one per repository: its repository is the repository of its ticket source (`ticket_source.repositoryId`).
        .where("projects.repository_id", "=", repositoryId)
        .where("projects.active", "=", encodeBoolean(true))
        .where((eb) =>
          eb.or([
            eb("workflow_versions.document", "like", '%"ticket.labeled"%'),
            eb("workflow_versions.document", "like", '%"github.issueLabeled"%'),
          ]),
        )
        .orderBy("workflows.created_at")
        .orderBy("workflows.id")
        .execute();
      return rows.map((row) => ({
        workflow: workflowFrom(row),
        current: versionFrom({
          workflow_id: row.version_workflow_id,
          version: row.version_number,
          document: row.version_document,
          created_by: row.version_created_by,
          created_at: row.version_created_at,
        }),
      }));
    },

    async get(id) {
      const workflow = await db
        .selectFrom("workflows")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (workflow === undefined) return undefined;
      const version = await db
        .selectFrom("workflow_versions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("workflow_id", "=", id)
        .where("version", "=", workflow.current_version)
        .executeTakeFirstOrThrow();
      return {
        workflow: workflowFrom(workflow),
        current: versionFrom(version),
      };
    },

    async getVersion(id, version) {
      const row = await db
        .selectFrom("workflow_versions")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("workflow_id", "=", id)
        .where("version", "=", version)
        .executeTakeFirst();
      return row === undefined ? undefined : versionFrom(row);
    },

    async listVersions(id) {
      const rows = await db
        .selectFrom("workflow_versions")
        .select(["workflow_id", "version", "created_by", "created_at"])
        .where("workspace_id", "=", workspaceId)
        .where("workflow_id", "=", id)
        .orderBy("version", "desc")
        .execute();
      return rows.map((row) => ({
        workflowId: row.workflow_id,
        version: row.version,
        createdBy: row.created_by,
        createdAt: row.created_at,
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
        // The project is one of this workspace's (a project belongs to the workspace of its repository).
        if (input.projectId !== undefined) {
          const project = await trx
            .selectFrom("projects")
            .innerJoin(
              "repositories",
              "repositories.id",
              "projects.repository_id",
            )
            .select("projects.id")
            .where("repositories.workspace_id", "=", workspaceId)
            .where("projects.id", "=", input.projectId)
            .executeTakeFirst();
          if (project === undefined)
            return { ok: false, reason: "project_not_found" };
        }
        // The maximum is held per project (#937); the lanes without a project count together.
        const { count } = await trx
          .selectFrom("workflows")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("archived_at", "is", null)
          .$call((query) =>
            input.projectId === undefined
              ? query.where("project_id", "is", null)
              : query.where("project_id", "=", input.projectId),
          )
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const timestamp = formatTimestamp(now());
        // `do nothing` instead of a raised violation: a name that is taken is an answer and must not abort a caller's transaction.
        const row = await trx
          .insertInto("workflows")
          .values({
            id: newId(),
            workspace_id: workspaceId,
            project_id: input.projectId ?? null,
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
          .insertInto("workflow_versions")
          .values({
            workflow_id: row.id,
            version: 1,
            workspace_id: workspaceId,
            document: input.document,
            created_by: input.createdBy,
            created_at: timestamp,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          ok: true,
          workflow: workflowFrom(row),
          saved: versionFrom(saved),
        };
      });
    },

    async saveVersion(id, input, maximumVersions) {
      try {
        return await inTransaction(async (trx): Promise<SaveOutcome> => {
          // The workflow row is the lock: writers of one workflow take turns, so the next number is never taken twice.
          const row = await trx
            .selectFrom("workflows")
            .selectAll()
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", id)
            .forUpdate()
            .executeTakeFirst();
          if (row === undefined) return { ok: false, reason: "not_found" };
          if (row.archived_at !== null)
            return { ok: false, reason: "archived" };
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
          const taken = await trx
            .selectFrom("workflows")
            .select("id")
            .where("workspace_id", "=", workspaceId)
            .where("id", "<>", id)
            .where("archived_at", "is", null)
            // The name is held once per project (#922); lanes without a project hold it among themselves.
            .where((eb) =>
              row.project_id === null
                ? eb("project_id", "is", null)
                : eb("project_id", "=", row.project_id),
            )
            .where((eb) =>
              eb(eb.fn("lower", ["name"]), "=", input.name.toLowerCase()),
            )
            .executeTakeFirst();
          if (taken !== undefined) return { ok: false, reason: "name_taken" };
          const timestamp = formatTimestamp(now());
          const version = row.current_version + 1;
          const saved = await trx
            .insertInto("workflow_versions")
            .values({
              workflow_id: id,
              version,
              workspace_id: workspaceId,
              document: input.document,
              created_by: input.createdBy,
              created_at: timestamp,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const updated = await trx
            .updateTable("workflows")
            .set({
              name: input.name,
              current_version: version,
              updated_at: timestamp,
            })
            .where("workspace_id", "=", workspaceId)
            .where("id", "=", id)
            .returningAll()
            .executeTakeFirstOrThrow();
          return {
            ok: true,
            workflow: workflowFrom(updated),
            saved: versionFrom(saved),
          };
        });
      } catch (error) {
        // Another workflow took the name between the check and the update: the unique index. Outside a transaction only; inside
        // one the caller's transaction is aborted already.
        if (errorCode(error) === UNIQUE_VIOLATION && !db.isTransaction)
          return { ok: false, reason: "name_taken" };
        throw error;
      }
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
          .selectFrom("workflows")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { ok: false, reason: "not_found" };
        if (row.archived_at !== null)
          return { ok: true, workflow: workflowFrom(row) };
        const { count } = await trx
          .selectFrom("workflows")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("archived_at", "is not", null)
          .executeTakeFirstOrThrow();
        if (Number(count) >= maximum)
          return { ok: false, reason: "limit_reached" };
        const timestamp = formatTimestamp(now());
        const archived = await trx
          .updateTable("workflows")
          .set({ archived_at: timestamp, updated_at: timestamp })
          .where("workspace_id", "=", workspaceId)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { ok: true, workflow: workflowFrom(archived) };
      });
    },
  };
}
