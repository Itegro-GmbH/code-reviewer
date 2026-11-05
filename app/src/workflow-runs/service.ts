// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the routes that start and show workflow runs (#844): start a run of a saved workflow by hand, read one run with
// its steps, list the runs of a workflow. It serves ONE workspace. Who may call is the route's (`withWorkspace`, the permission to start
// an Implementer task: a run starts tasks); every rule about the data is here.
//
// A start is checked in this order, and nothing is written before the last check:
//  1. the body: `{ input, clientRequestId }`, nothing else;
//  2. a request id that made a run before answers that run, if the body is the same (`created: false`), else `WORKFLOW_RUN_REQUEST_REUSED`;
//  3. the workflow exists in this workspace and is not archived;
//  4. its trigger is the manual one, and every step is one the engine runs (`if` and `loop` come with milestone 5 and are refused
//     here, with the step named, rather than failing halfway through a run that already cost money);
//  5. the input fits the trigger's `input` schema (checked again here with `checkResultValue`: the validator knows the schema, only a
//     start knows the values);
//  6. the repository named by `input.repo` is one of the workspace's, active, and the platform still resolves it.
// Then the run is written with the version the workflow has now, and the engine is told to start it.
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { CLIENT_REQUEST_ID } from "../jobs/job-input.ts";
import { canonicalJson, isRecord } from "../workflows/json.ts";
import {
  BUDGET_OPERATOR_MAX_USD,
  WORKFLOW_ID_MAX_LENGTH,
} from "../workflows/limits.ts";
import {
  checkResultValue,
  validateResultSchema,
} from "../workflows/result-schema.ts";
import {
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
} from "./document.ts";
import { WorkflowRunError } from "./errors.ts";
import {
  MICRO_USD_PER_USD,
  RUNS_LISTED_MAX,
  TRIGGER_INPUT_MAX_CHARS,
} from "./limits.ts";

export type StepView = {
  id: string;
  position: number;
  kind: "agent" | "action";
  status: StoredStepRun["status"];
  profile: { name: string; version: number } | null;
  jobId: string | null;
  turnId: string | null;
  /** What the step was charged, in US dollars; null while it runs. */
  costUsd: number | null;
  /** The values later steps refer to; null until the step succeeded. */
  output: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunSummaryView = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: StoredWorkflowRun["status"];
  errorCode: string | null;
  /** What started the run: a person by hand (`manual`) or a label on an issue (`github.issueLabeled`). */
  triggerKind: StoredWorkflowRun["triggerKind"];
  /** Who started it or put the label on, by their login on the platform. Display only: it decides nothing. */
  actorLogin: string;
  budgetUsd: number;
  spentUsd: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type RunView = RunSummaryView & {
  repositoryId: string;
  baseBranch: string;
  input: unknown;
  steps: StepView[];
};

export type StartedRun = { run: RunView; created: boolean };

export type WorkflowRunService = {
  /** Starts a run of the workflow by hand. Throws a `WorkflowRunError`. */
  start(
    user: { id: string; githubLogin: string },
    workflowId: string,
    body: unknown,
  ): Promise<StartedRun>;
  get(workflowId: string, runId: string): Promise<RunView>;
  /** The newest runs of a workflow, without their steps. */
  list(workflowId: string): Promise<{ runs: RunSummaryView[] }>;
};

export type WorkflowRunServiceDependencies = {
  runs: WorkflowRunsRepository;
  workflows: Pick<WorkflowsRepository, "get">;
  /**
   * The repository of the workspace the full name (`owner/name`, case ignored) stands for, with its default branch, or undefined
   * when it is none of the workspace's or not active. Throws `WORKFLOW_RUN_GITHUB_UNAVAILABLE` when the platform cannot be asked.
   */
  resolveRepository(
    fullName: string,
  ): Promise<{ id: string; defaultBranch: string } | undefined>;
  /** Tells the engine the run exists. It runs the first steps; the caller does not wait for them. Never throws. */
  kick(runId: string): void;
  /** The most a workflow may be given to spend: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
};

const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const notFound = (): WorkflowRunError =>
  new WorkflowRunError(
    "WORKFLOW_RUN_WORKFLOW_NOT_FOUND",
    "There is no such workflow.",
  );

function usd(micro: number): number {
  return micro / MICRO_USD_PER_USD;
}

function jsonOrNull(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function summaryOf(run: StoredWorkflowRun): RunSummaryView {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    errorCode: run.errorCode,
    triggerKind: run.triggerKind,
    actorLogin: run.actorLogin,
    budgetUsd: usd(run.budgetMicroUsd),
    spentUsd: usd(run.spentMicroUsd),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

function stepView(step: StoredStepRun): StepView {
  return {
    id: step.stepId,
    position: step.position,
    kind: step.kind,
    status: step.status,
    profile: step.profile,
    jobId: step.jobId,
    turnId: step.turnId,
    costUsd: step.costMicroUsd === null ? null : usd(step.costMicroUsd),
    output: jsonOrNull(step.output),
    errorCode: step.errorCode,
    errorMessage: step.errorMessage,
    createdAt: step.createdAt,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
  };
}

function viewOf(
  run: StoredWorkflowRun,
  steps: readonly StoredStepRun[],
): RunView {
  return {
    ...summaryOf(run),
    repositoryId: run.repositoryId,
    baseBranch: run.baseBranch,
    input: jsonOrNull(run.triggerInput),
    steps: steps.map(stepView),
  };
}

/** The body of a start: `{ input, clientRequestId }` and nothing else. */
function readBody(body: unknown): {
  input: Record<string, unknown>;
  clientRequestId: string;
} {
  const invalid = (message: string) =>
    new WorkflowRunError("WORKFLOW_RUN_REQUEST_INVALID", message);
  if (!isRecord(body)) throw invalid("The body must be a JSON object.");
  for (const key of Object.keys(body))
    if (key !== "input" && key !== "clientRequestId")
      throw invalid(`The body has no field ${key.slice(0, 40)}.`);
  const { input, clientRequestId } = body;
  if (
    typeof clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID.test(clientRequestId)
  )
    throw invalid(
      "clientRequestId must be 1 to 200 printable ASCII characters without a space.",
    );
  if (input !== undefined && !isRecord(input))
    throw invalid("input must be a JSON object.");
  return { input: input ?? {}, clientRequestId };
}

export function createWorkflowRunService(
  deps: WorkflowRunServiceDependencies,
): WorkflowRunService {
  const maxBudgetUsd = deps.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD;

  function checkId(id: string): void {
    if (id.length === 0 || id.length > WORKFLOW_ID_MAX_LENGTH) throw notFound();
  }

  /**
   * The run an earlier request with this id made, when the body is the same one. The inputs are compared by content: the same input
   * written with its keys in another order is the same request.
   */
  function sameRequest(
    earlier: StoredWorkflowRun,
    workflowId: string,
    input: Record<string, unknown>,
  ): StoredWorkflowRun {
    if (
      earlier.workflowId !== workflowId ||
      canonicalJson(jsonOrNull(earlier.triggerInput)) !== canonicalJson(input)
    )
      throw new WorkflowRunError(
        "WORKFLOW_RUN_REQUEST_REUSED",
        "This request id made another run.",
        { runId: earlier.id },
      );
    return earlier;
  }

  async function view(run: StoredWorkflowRun): Promise<RunView> {
    return viewOf(run, await deps.runs.listSteps(run.id));
  }

  return {
    async start(user, workflowId, body) {
      const { input, clientRequestId } = readBody(body);
      const triggerInput = JSON.stringify(input);
      if (triggerInput.length > TRIGGER_INPUT_MAX_CHARS)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REQUEST_INVALID",
          "The input is too large.",
        );
      checkId(workflowId);

      // A request that was accepted before is answered with what it made, before anything else is looked at.
      const earlier = await deps.runs.findByRequest(clientRequestId);
      if (earlier !== undefined)
        return {
          run: await view(sameRequest(earlier, workflowId, input)),
          created: false,
        };

      const found = await deps.workflows.get(workflowId);
      if (found === undefined) throw notFound();
      if (found.workflow.archivedAt !== null)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_WORKFLOW_ARCHIVED",
          "The workflow is archived and is not started.",
        );
      const document = readRunDocument(found.current.document);
      if (document === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_DOCUMENT_UNUSABLE",
          "The saved workflow cannot be read.",
        );
      if (document.trigger.kind !== "manual")
        throw new WorkflowRunError(
          "WORKFLOW_RUN_TRIGGER_NOT_MANUAL",
          "Only a workflow with the manual trigger is started by hand.",
        );
      const unsupported = unsupportedStep(document);
      if (unsupported !== undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED",
          `The step ${unsupported.id.slice(0, 64)} is of the kind ${unsupported.kind.slice(0, 20)}, which the engine does not run yet (only agent and action steps).`,
          { step: { id: unsupported.id, kind: unsupported.kind } },
        );

      const schema = validateResultSchema(document.trigger.input).schema;
      if (schema === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_DOCUMENT_UNUSABLE",
          "The input of the trigger has no usable schema.",
        );
      const problems = checkResultValue(schema, input);
      if (problems.length > 0)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_INPUT_INVALID",
          "The input does not fit the input of the trigger.",
          { errors: problems },
        );
      const repo = input.repo;
      if (typeof repo !== "string" || !REPO_NAME.test(repo))
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
          "input.repo must be a repository of the workspace, as owner/name.",
        );
      const repository = await deps.resolveRepository(repo);
      if (repository === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
          "There is no such repository in this workspace.",
        );

      const created = await deps.runs.createRun({
        workflowId,
        workflowVersion: found.current.version,
        repositoryId: repository.id,
        baseBranch: repository.defaultBranch,
        triggerInput,
        budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
        clientRequestId,
        createdBy: user.id,
        actorLogin: user.githubLogin,
      });
      if (created.status === "existing")
        return {
          run: await view(sameRequest(created.run, workflowId, input)),
          created: false,
        };
      deps.kick(created.run.id);
      return { run: await view(created.run), created: true };
    },

    async get(workflowId, runId) {
      checkId(workflowId);
      const run = await deps.runs.getRun(runId);
      if (run === undefined || run.workflowId !== workflowId)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_FOUND",
          "There is no such run of this workflow.",
        );
      return view(run);
    },

    async list(workflowId) {
      checkId(workflowId);
      if ((await deps.workflows.get(workflowId)) === undefined)
        throw notFound();
      return {
        runs: (await deps.runs.listRuns(workflowId, RUNS_LISTED_MAX)).map(
          summaryOf,
        ),
      };
    },
  };
}
