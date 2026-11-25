// SPDX-License-Identifier: LicenseRef-Proprietary

// The services of the run tools (#1146): the SAME ones the routes below `/api/w/:workspace/workflows/:id/runs`, `/workflow-runs` and
// `/runs/:id/steps` build, for the workspace of the token. A tool asks `context.services.use(...)` for one of these factories.
import { createWorkflowRunsRepository } from "../../../db/repositories/workflow-runs-repository.ts";
import { jiraTicketProvider } from "../../../jira/shared.ts";
import {
  runMcpCallsServiceFor,
  runStepsServiceFor,
} from "../../../runs/shared.ts";
import type { RunMcpCallsService } from "../../../runs/mcp-calls-service.ts";
import type { RunStepsService } from "../../../runs/steps-service.ts";
import {
  WorkflowRunError,
  type WorkflowRunErrorCode,
} from "../../../workflow-runs/errors.ts";
import type {
  RunView,
  WorkflowRunService,
} from "../../../workflow-runs/service.ts";
import { workflowRunServiceFor } from "../../../workflow-runs/shared.ts";
import { ToolError, type ToolErrorCode } from "../errors.ts";
import type { ToolContext } from "../context.ts";
import type { ServiceFactory } from "../services.ts";

/** The run service the routes use (with the Jira ticket provider, as the start route wires it). */
export const workflowRunsService: ServiceFactory<WorkflowRunService> = ({
  access,
}) => workflowRunServiceFor(access.workspace.id, [jiraTicketProvider]);

/** The agent steps of a run of the Implementer (what the agent thought, said and did), as the live view reads them. */
export const runStepsService: ServiceFactory<RunStepsService> = ({ access }) =>
  runStepsServiceFor(access.workspace.id);

/** The MCP calls the agent of a step made. */
export const runMcpCallsService: ServiceFactory<RunMcpCallsService> = ({
  access,
}) => runMcpCallsServiceFor(access.workspace.id);

/** Finds the lane (workflow) of a run: the run service takes both ids, a caller of the tools only knows the run's. */
export type RunLookup = {
  /** The id of the lane the run belongs to, or undefined for a run this workspace does not have (another workspace's id answers the same). */
  laneOf(runId: string): Promise<string | undefined>;
};

export const runLookup: ServiceFactory<RunLookup> = ({ access, database }) => {
  const runs = createWorkflowRunsRepository(database(), access.workspace.id);
  return {
    async laneOf(runId) {
      // Ids are uuids; anything else is no run (and never reaches the database as a malformed value).
      if (!RUN_ID.test(runId)) return undefined;
      return (await runs.getRun(runId))?.workflowId;
    },
  };
};

const RUN_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const NOT_A_RUN = "There is no such run in this workspace.";

/** The lane of a run, or a `not_found`. */
export async function laneOfRun(
  context: ToolContext,
  runId: string,
): Promise<string> {
  const laneId = await context.services.use(runLookup).laneOf(runId);
  if (laneId === undefined) throw new ToolError("not_found", NOT_A_RUN);
  return laneId;
}

const CODE_OF: Record<WorkflowRunErrorCode, ToolErrorCode> = {
  WORKFLOW_RUN_REQUEST_INVALID: "invalid_input",
  WORKFLOW_RUN_CROSS_SITE_REQUEST: "internal_error",
  WORKFLOW_RUN_WORKFLOW_NOT_FOUND: "not_found",
  WORKFLOW_RUN_NOT_FOUND: "not_found",
  WORKFLOW_RUN_REPOSITORY_NOT_FOUND: "not_found",
  WORKFLOW_RUN_TRIGGER_UNKNOWN: "not_found",
  WORKFLOW_RUN_TICKET_NOT_FOUND: "not_found",
  WORKFLOW_RUN_WORKFLOW_ARCHIVED: "conflict",
  WORKFLOW_RUN_PROJECT_INACTIVE: "conflict",
  WORKFLOW_RUN_NOT_WAITING: "conflict",
  WORKFLOW_RUN_QUESTION_CHANGED: "conflict",
  WORKFLOW_RUN_REQUEST_REUSED: "conflict",
  WORKFLOW_RUN_BODY_TOO_LARGE: "invalid_input",
  WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED: "internal_error",
  WORKFLOW_RUN_TRIGGER_NOT_MANUAL: "invalid_input",
  WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT: "invalid_input",
  WORKFLOW_RUN_TICKET_PROVIDER_UNSUPPORTED: "invalid_input",
  WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT: "invalid_input",
  WORKFLOW_RUN_PROJECT_REQUIRED: "invalid_input",
  WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED: "invalid_input",
  WORKFLOW_RUN_INPUT_INVALID: "invalid_input",
  WORKFLOW_RUN_ANSWER_INVALID: "invalid_input",
  WORKFLOW_RUN_DOCUMENT_UNUSABLE: "internal_error",
  WORKFLOW_RUN_GITHUB_UNAVAILABLE: "unavailable",
};

/**
 * Runs a call of the run service and turns its own refusal into the tool's code: a missing run or lane is `not_found`, a run in the wrong
 * state (nothing to answer, a lane archived) is `conflict`, an input the lane does not take is `invalid_input` with the validator's
 * `errors`, GitHub being unreachable is `unavailable`. The service's code is kept in `details.code`.
 */
export async function runService<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof WorkflowRunError)) throw error;
    const code = CODE_OF[error.code];
    // A code that means a bug of this server (the engine's own checks of the request we built) is never shown.
    if (code === "internal_error") throw error;
    throw new ToolError(code, error.message, {
      code: error.code,
      ...(error.errors.length > 0 ? { errors: error.errors } : {}),
      ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      ...(error.runId === undefined ? {} : { runId: error.runId }),
      ...(error.step === undefined ? {} : { step: error.step }),
    });
  }
}

/** The page of a run in the web app: an address a person can open (the workspace is the slug, the host is the deployment's). */
export function runUrl(
  context: ToolContext,
  run: { id: string; workflowId: string },
): string {
  return `${context.environment.baseUrl.replace(/\/+$/, "")}/w/${context.workspace.slug}/workflows/${run.workflowId}/runs/${run.id}`;
}

/** The statuses after which a run does not change by itself. */
export const FINISHED_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "discarded",
] as const;

/** A question a run waits for, as `answer_run` takes it back: the step run and the number of the question. */
export type OpenQuestion = {
  stepRunId: string;
  n: number;
  question: string;
  context: string | null;
  options: string[];
};

/** What a person has to answer before the run goes on: the open question of every step that waits (the agent's words: untrusted text). */
export function openQuestionsOf(run: RunView): OpenQuestion[] {
  return run.steps.flatMap((step) =>
    step.status === "waiting" && step.ask !== null && step.ask.state === "open"
      ? [
          {
            stepRunId: step.id,
            n: step.ask.n,
            question: step.ask.question,
            context: step.ask.context ?? null,
            options: step.ask.options ?? [],
          },
        ]
      : [],
  );
}

/** A run as the tools answer it: the run service's view, the address of its page, and what it waits for. */
export function runAnswer(
  context: ToolContext,
  run: RunView,
): Record<string, unknown> {
  return {
    run,
    url: runUrl(context, run),
    finished: (FINISHED_RUN_STATUSES as readonly string[]).includes(run.status),
    waitingFor: openQuestionsOf(run),
  };
}
