// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the workflow routes (#833): validate a document without storing it, and list, read, create, save new
// versions of and archive the workflows of ONE workspace. Who may call is the route's (`withWorkspace`); every rule about the data is here.
// Saving runs the validator first, with the environments of the workspace, and refuses an invalid document with the same list of
// errors the validate call gives. The document is stored as the JSON text that was validated; every save is a new version.
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowsRepository,
} from "../db/repositories/workflows-repository.ts";
import { WorkflowError } from "./errors.ts";
import {
  ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
  BUDGET_OPERATOR_MAX_USD,
  DOCUMENT_MAX_BYTES,
  VERSIONS_PER_WORKFLOW_MAX,
  WORKFLOW_ID_MAX_LENGTH,
  WORKFLOWS_PER_WORKSPACE_MAX,
} from "./limits.ts";
import { createResolver } from "./resolver.ts";
import { validateWorkflow, type ValidationResult } from "./validate.ts";

export type WorkflowSummaryView = {
  id: string;
  name: string;
  /** The current version. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** When the workflow was archived: not listed, takes no new version, never started. `null` while it is not. */
  archivedAt: string | null;
};

export type WorkflowList = {
  workflows: WorkflowSummaryView[];
  /** How many workflows the workspace may hold. */
  maximum: number;
};

export type WorkflowVersionInfo = { version: number; savedAt: string };

export type WorkflowView = WorkflowSummaryView & {
  /** The version the `document` is: the current one unless an older was asked for. */
  documentVersion: number;
  document: unknown;
  /** Every saved version, the newest first. */
  versions: WorkflowVersionInfo[];
};

export type WorkflowService = {
  /** Checks a document against the format and the workspace's environments. Stores nothing. */
  validate(body: unknown): Promise<ValidationResult>;
  list(): Promise<WorkflowList>;
  /** The workflow with its current version, or with the version asked for. */
  get(id: string, version?: number): Promise<WorkflowView>;
  create(user: { id: string }, body: unknown): Promise<WorkflowView>;
  /** Saves `body` as the next version. `expectedVersion`: only if that is still the current one. */
  update(
    user: { id: string },
    id: string,
    body: unknown,
    expectedVersion?: number,
  ): Promise<WorkflowView>;
  /**
   * Archives a workflow: it leaves the list and the count of the workspace, takes no new version and is not started; its name is
   * free again and its versions stay readable. Asked again, it answers the same. A workspace holds a bounded number of archived
   * workflows: past it, an archive is `WORKFLOW_ARCHIVE_LIMIT_REACHED`.
   */
  archive(id: string): Promise<WorkflowView>;
};

export type WorkflowServiceDependencies = {
  workflows: WorkflowsRepository;
  environments: ImplementerEnvironmentsRepository;
  /** The most a workflow may be given to spend. Until the operator can set it: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
  /** The most archived workflows a workspace may hold: `ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX`. */
  archivedMax?: number;
};

function summaryOf(workflow: StoredWorkflow): WorkflowSummaryView {
  return {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    archivedAt: workflow.archivedAt,
  };
}

export function createWorkflowService({
  workflows,
  environments,
  maxBudgetUsd = BUDGET_OPERATOR_MAX_USD,
  archivedMax = ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
}: WorkflowServiceDependencies): WorkflowService {
  async function validateDocument(body: unknown): Promise<ValidationResult> {
    const known = await environments.listSummaries();
    return validateWorkflow(body, createResolver({ environments: known }), {
      maxBudgetUsd,
    });
  }

  async function viewOf(
    workflow: StoredWorkflow,
    shown: StoredWorkflowVersion,
  ): Promise<WorkflowView> {
    const versions = await workflows.listVersions(workflow.id);
    return {
      ...summaryOf(workflow),
      documentVersion: shown.version,
      document: JSON.parse(shown.document) as unknown,
      versions: versions.map((v) => ({
        version: v.version,
        savedAt: v.createdAt,
      })),
    };
  }

  /** Validates and returns the text to store; a document the validator refuses is `WORKFLOW_INVALID` with every error. */
  async function acceptable(
    body: unknown,
  ): Promise<{ name: string; text: string }> {
    const result = await validateDocument(body);
    if (!result.valid)
      throw new WorkflowError(
        "WORKFLOW_INVALID",
        "The workflow does not pass the validator.",
        { errors: result.errors, truncated: result.truncated },
      );
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, "utf8") > DOCUMENT_MAX_BYTES)
      throw new WorkflowError(
        "WORKFLOW_BODY_TOO_LARGE",
        "The workflow is too large.",
      );
    return { name: (body as { name: string }).name, text };
  }

  const notFound = (): WorkflowError =>
    new WorkflowError("WORKFLOW_NOT_FOUND", "There is no such workflow.");

  function checkId(id: string): void {
    if (id.length === 0 || id.length > WORKFLOW_ID_MAX_LENGTH) throw notFound();
  }

  return {
    validate: validateDocument,

    async list() {
      return {
        workflows: (await workflows.list()).map(summaryOf),
        maximum: WORKFLOWS_PER_WORKSPACE_MAX,
      };
    },

    async get(id, version) {
      checkId(id);
      const found = await workflows.get(id);
      if (found === undefined) throw notFound();
      if (version === undefined || version === found.current.version)
        return viewOf(found.workflow, found.current);
      const older = await workflows.getVersion(id, version);
      if (older === undefined)
        throw new WorkflowError(
          "WORKFLOW_VERSION_NOT_FOUND",
          "The workflow has no such version.",
        );
      return viewOf(found.workflow, older);
    },

    async create(user, body) {
      const { name, text } = await acceptable(body);
      const created = await workflows.create(
        { name, document: text, createdBy: user.id },
        WORKFLOWS_PER_WORKSPACE_MAX,
      );
      if (!created.ok) {
        if (created.reason === "name_taken")
          throw new WorkflowError(
            "WORKFLOW_NAME_TAKEN",
            "The workspace has a workflow of that name.",
          );
        throw new WorkflowError(
          "WORKFLOW_LIMIT_REACHED",
          "The workspace holds the most workflows it may.",
          { maximum: WORKFLOWS_PER_WORKSPACE_MAX },
        );
      }
      return viewOf(created.workflow, created.saved);
    },

    async archive(id) {
      checkId(id);
      const archived = await workflows.archive(id, archivedMax);
      if (!archived.ok) {
        if (archived.reason === "limit_reached")
          throw new WorkflowError(
            "WORKFLOW_ARCHIVE_LIMIT_REACHED",
            "The workspace holds the most archived workflows it may.",
            { maximum: archivedMax },
          );
        throw notFound();
      }
      const found = await workflows.get(id);
      if (found === undefined) throw notFound();
      return viewOf(found.workflow, found.current);
    },

    async update(user, id, body, expectedVersion) {
      checkId(id);
      const { name, text } = await acceptable(body);
      const saved = await workflows.saveVersion(
        id,
        {
          name,
          document: text,
          createdBy: user.id,
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        },
        VERSIONS_PER_WORKFLOW_MAX,
      );
      if (saved.ok) return viewOf(saved.workflow, saved.saved);
      switch (saved.reason) {
        case "not_found":
          throw notFound();
        case "archived":
          throw new WorkflowError(
            "WORKFLOW_ARCHIVED",
            "The workflow is archived and takes no new version.",
          );
        case "name_taken":
          throw new WorkflowError(
            "WORKFLOW_NAME_TAKEN",
            "The workspace has a workflow of that name.",
          );
        case "version_conflict":
          throw new WorkflowError(
            "WORKFLOW_VERSION_CONFLICT",
            "The workflow was saved since that version.",
            { current: saved.current },
          );
        case "version_limit_reached":
          throw new WorkflowError(
            "WORKFLOW_VERSION_LIMIT_REACHED",
            "The workflow holds the most versions it may.",
            { maximum: VERSIONS_PER_WORKFLOW_MAX },
          );
      }
    },
  };
}
