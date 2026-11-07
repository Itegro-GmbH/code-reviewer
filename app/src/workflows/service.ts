// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the workflow routes (#833): validate a document without storing it, and list, read, create, save new
// versions of and archive the workflows of ONE workspace. Who may call is the route's (`withWorkspace`); every rule about the data is here.
// Saving runs the validator first, with the environments of the workspace, and refuses an invalid document with the same list of
// errors the validate call gives. The document is stored as the JSON text that was validated; every save is a new version.
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { ProjectsRepository } from "../db/repositories/projects-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
  WorkflowsRepository,
} from "../db/repositories/workflows-repository.ts";
import { builtInLaneDocument, type BuiltInLaneKey } from "./built-in-lanes.ts";
import {
  WorkflowError,
  type WorkflowErrorCode,
  type WorkflowRequestIssue,
} from "./errors.ts";
import type { Issue } from "./issues.ts";
import {
  ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
  BUDGET_OPERATOR_MAX_USD,
  DOCUMENT_MAX_BYTES,
  VERSIONS_PER_WORKFLOW_MAX,
  WORKFLOW_ID_MAX_LENGTH,
  WORKFLOWS_PER_WORKSPACE_MAX,
} from "./limits.ts";
import { TARGET_ROOTS, type TargetRoot } from "./connectors.ts";
import { isRecord } from "./json.ts";
import { profileInfosOf, profileRefsIn } from "./profile-refs.ts";
import {
  REACH_WANTS,
  reachAt,
  type ReachSamples,
  type ReachWants,
  type ScopeAnswer,
} from "./reach.ts";
import { createResolver, type WorkflowResolver } from "./resolver.ts";
import { validateWorkflow, type ValidationResult } from "./validate.ts";

export type WorkflowSummaryView = {
  id: string;
  /** The project the lane belongs to (#922); null for a lane no project could take. */
  projectId: string | null;
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

/** What copying one built-in lane into a project came to (#922): the lane that was saved, or why it was not. */
export type BuiltInLaneResult =
  | { key: BuiltInLaneKey; ok: true; workflow: WorkflowSummaryView }
  | {
      key: BuiltInLaneKey;
      ok: false;
      code: WorkflowErrorCode;
      errors: readonly Issue[];
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
  /**
   * The values a step of an unsaved document can reach (#927), by the validator's own scope rules. The body is
   * `{ document, at, targetRoots?, wants?, workflowId? }`: `at` is a JSON pointer into the document, `targetRoots` the roots a target input
   * takes (only those values are listed), `workflowId` the lane whose latest run gives the samples.
   */
  scope(body: unknown): Promise<ScopeAnswer>;
  /** The lanes of one project (#922). Throws `WORKFLOW_PROJECT_REQUIRED` when `projectId` is missing or no project of the workspace. */
  list(projectId: string | undefined): Promise<WorkflowList>;
  /** The workflow with its current version, or with the version asked for. */
  get(id: string, version?: number): Promise<WorkflowView>;
  /** Saves a new lane in a project (#922); the project must be one of the workspace and switched on. */
  create(
    user: { id: string },
    projectId: string | undefined,
    body: unknown,
  ): Promise<WorkflowView>;
  /**
   * Copies built-in lanes into a project (#922), each as a lane like any other: validated against the workspace's profiles and
   * environments (the first environment by name is the one the agent steps run in), then saved as version 1. A lane that does not pass
   * (a profile or an environment is missing) or whose name the project has is reported and the others are still copied.
   */
  copyBuiltIn(
    user: { id: string },
    projectId: string,
    keys: readonly BuiltInLaneKey[],
  ): Promise<BuiltInLaneResult[]>;
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
  /** The projects of the workspace (#922): a lane belongs to one of them. */
  projects: Pick<ProjectsRepository, "getById" | "list">;
  environments: ImplementerEnvironmentsRepository;
  /** The profiles of the workspace (#843): the names and versions a step may run, and what a version is (may it push, its default result). */
  profiles: Pick<ProfilesRepository, "list" | "versionFacts" | "archivedNames">;
  /** The most a workflow may be given to spend. Until the operator can set it: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
  /** The most archived workflows a workspace may hold: `ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX`. */
  archivedMax?: number;
  /** What the latest run of a workflow held, for the samples of the scope lookup (#927); none: no samples. */
  samples?: (workflowId: string) => Promise<ReachSamples | undefined>;
};

function summaryOf(workflow: StoredWorkflow): WorkflowSummaryView {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    name: workflow.name,
    version: workflow.version,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    archivedAt: workflow.archivedAt,
  };
}

export function createWorkflowService({
  workflows,
  projects,
  environments,
  profiles,
  maxBudgetUsd = BUDGET_OPERATOR_MAX_USD,
  archivedMax = ARCHIVED_WORKFLOWS_PER_WORKSPACE_MAX,
  samples,
}: WorkflowServiceDependencies): WorkflowService {
  /** The resolver of the workspace for a document: its environments, and the profiles (with the facts) the document runs. */
  async function resolverFor(body: unknown): Promise<WorkflowResolver> {
    const known = await environments.listSummaries();
    // The profiles of the workspace, with the facts of the versions the document runs and no others.
    const live = (await profiles.list()).map((profile) => ({
      id: profile.id,
      name: profile.name,
      version: profile.version,
    }));
    const { wanted, build } = profileInfosOf(live, profileRefsIn(body));
    const facts = await profiles.versionFacts(wanted);
    return createResolver({
      environments: known,
      profiles: build(facts),
      archivedProfiles: await profiles.archivedNames(),
    });
  }

  async function validateDocument(body: unknown): Promise<ValidationResult> {
    return validateWorkflow(body, await resolverFor(body), { maxBudgetUsd });
  }

  const badScope = (
    issue: WorkflowRequestIssue,
    message: string,
  ): WorkflowError =>
    new WorkflowError("WORKFLOW_REQUEST_INVALID", message, {
      issues: [issue],
    });

  async function scopeOf(body: unknown): Promise<ScopeAnswer> {
    if (!isRecord(body) || typeof body.at !== "string")
      throw badScope(
        {
          path: "at",
          code: "body_invalid",
          message:
            "The body is {document, at}: at is the JSON pointer of the step, like /steps/1.",
          available: [],
        },
        "The body must be an object with document and at.",
      );
    const roots = body.targetRoots;
    if (
      roots !== undefined &&
      (!Array.isArray(roots) ||
        !roots.every(
          (root): root is TargetRoot =>
            typeof root === "string" &&
            (TARGET_ROOTS as readonly string[]).includes(root),
        ))
    )
      throw badScope(
        {
          path: "targetRoots",
          code: "scope_target_unknown",
          message: "targetRoots is a list of the roots a target input takes.",
          available: [...TARGET_ROOTS],
        },
        "targetRoots names a root the format does not have.",
      );
    const wants = body.wants;
    if (
      wants !== undefined &&
      !(REACH_WANTS as readonly unknown[]).includes(wants)
    )
      throw badScope(
        {
          path: "wants",
          code: "scope_wants_unknown",
          message:
            "wants is the kind of value the field takes: text, comparable or emptiable.",
          available: [...REACH_WANTS],
        },
        "wants names a kind of value the format does not have.",
      );
    const workflowId =
      typeof body.workflowId === "string" &&
      body.workflowId.length > 0 &&
      body.workflowId.length <= WORKFLOW_ID_MAX_LENGTH
        ? body.workflowId
        : undefined;
    const held =
      workflowId === undefined ? undefined : await samples?.(workflowId);
    const reach = reachAt(
      body.document,
      await resolverFor(body.document),
      body.at,
      {
        maxBudgetUsd,
        ...(roots === undefined
          ? {}
          : { target: { input: "this field", roots: roots as TargetRoot[] } }),
        ...(wants === undefined ? {} : { wants: wants as ReachWants }),
        ...(held === undefined ? {} : { samples: held }),
      },
    );
    if (reach === undefined)
      throw badScope(
        {
          path: "at",
          code: "scope_at_unknown",
          message: "at is not a step of the document.",
          available: [],
        },
        "at is not a step of the document.",
      );
    return { ...reach, sampled: held !== undefined };
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

  /** The project of the request: one of this workspace, or the refusal that names what is missing and which projects there are. */
  async function projectOf(projectId: string | undefined) {
    const project =
      projectId === undefined || projectId === ""
        ? undefined
        : await projects.getById(projectId);
    if (project !== undefined) return project;
    const available = (await projects.list()).flatMap((entry) =>
      entry.project === null ? [] : [entry.project.id],
    );
    throw new WorkflowError(
      projectId === undefined || projectId === ""
        ? "WORKFLOW_PROJECT_REQUIRED"
        : "WORKFLOW_PROJECT_NOT_FOUND",
      projectId === undefined || projectId === ""
        ? "A lane belongs to a project: name it with projectId."
        : "There is no such project in this workspace.",
      {
        issues: [
          {
            path: "projectId",
            code:
              projectId === undefined || projectId === ""
                ? "project_required"
                : "project_unknown",
            message:
              projectId === undefined || projectId === ""
                ? "projectId is required: the lanes are listed and created within one project."
                : "projectId is not a project of this workspace.",
            available: available.slice(0, 50),
          },
        ],
      },
    );
  }

  function checkId(id: string): void {
    if (id.length === 0 || id.length > WORKFLOW_ID_MAX_LENGTH) throw notFound();
  }

  async function createLane(
    user: { id: string },
    projectId: string | undefined,
    body: unknown,
  ): Promise<WorkflowView> {
    const project = await projectOf(projectId);
    if (!project.active)
      throw new WorkflowError(
        "WORKFLOW_PROJECT_INACTIVE",
        "The project is switched off and takes no new lane.",
      );
    const { name, text } = await acceptable(body);
    const created = await workflows.create(
      { name, document: text, createdBy: user.id, projectId: project.id },
      WORKFLOWS_PER_WORKSPACE_MAX,
    );
    if (!created.ok) {
      // Cannot happen after `projectOf`, which read the project of this workspace; the repository says it anyway.
      if (created.reason === "project_not_found")
        throw new WorkflowError(
          "WORKFLOW_PROJECT_NOT_FOUND",
          "There is no such project in this workspace.",
          {
            issues: [
              {
                path: "projectId",
                code: "project_unknown",
                message: "projectId is not a project of this workspace.",
                available: [],
              },
            ],
          },
        );
      if (created.reason === "name_taken")
        throw new WorkflowError(
          "WORKFLOW_NAME_TAKEN",
          "The project has a lane of that name.",
        );
      throw new WorkflowError(
        "WORKFLOW_LIMIT_REACHED",
        "The workspace holds the most workflows it may.",
        { maximum: WORKFLOWS_PER_WORKSPACE_MAX },
      );
    }
    return viewOf(created.workflow, created.saved);
  }

  return {
    validate: validateDocument,

    scope: scopeOf,

    async list(projectId) {
      const project = await projectOf(projectId);
      return {
        workflows: (await workflows.list({ projectId: project.id })).map(
          summaryOf,
        ),
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

    create: createLane,

    async copyBuiltIn(user, projectId, keys) {
      const [first] = [...(await environments.listSummaries())].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const environment = first?.name ?? "node";
      const results: BuiltInLaneResult[] = [];
      for (const key of keys) {
        try {
          const view = await createLane(
            user,
            projectId,
            builtInLaneDocument(key, environment),
          );
          results.push({
            key,
            ok: true,
            workflow: {
              id: view.id,
              projectId: view.projectId,
              name: view.name,
              version: view.version,
              createdAt: view.createdAt,
              updatedAt: view.updatedAt,
              archivedAt: view.archivedAt,
            },
          });
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          results.push({
            key,
            ok: false,
            code: error.code,
            errors: error.errors,
          });
        }
      }
      return results;
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
            "The project has a lane of that name.",
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
