// SPDX-License-Identifier: LicenseRef-Proprietary

// The service behind the routes that start and show workflow runs (#844): start a run of a saved workflow by hand, read one run with
// its steps, list the runs of a workflow. It serves ONE workspace. Who may call is the route's (`withWorkspace`, the permission to start
// an Implementer task: a run starts tasks); every rule about the data is here.
//
// A start is checked in this order, and nothing is written before the last check:
//  1. the body: `{ trigger, input, clientRequestId }`, nothing else (`trigger` may be left out when the workflow has one trigger a
//     person or a script can start);
//  2. a request id that made a run before answers that run, if the body is the same (`created: false`), else `WORKFLOW_RUN_REQUEST_REUSED`;
//  3. the workflow exists in this workspace and is not archived;
//  4. the trigger is one of its `manual` or `api` triggers, and every step the run would go through (the pre-steps of that trigger and
//     the shared steps) is one the engine runs (only a kind the engine does not run is refused here, with the step named, rather than
//     failing halfway through a run that already cost money);
//  5. the input fits the trigger's `input` schema (checked again here with `checkResultValue`: the validator knows the schema, only a
//     start knows the values);
//  6. the repository is one of the workspace's, active, and the platform still resolves it: that of the `ticket` input when the trigger
//     has one (the ticket is read through the provider and handed to the steps as `trigger.ticket`), else the one named by `input.repo`.
// Then the run is written with the version the workflow has now, and the engine is told to start it.
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { CLIENT_REQUEST_ID } from "../jobs/job-input.ts";
import { canonicalJson, isRecord } from "../workflows/json.ts";
import { ID_PATTERN } from "../workflows/check-steps.ts";
import {
  BUDGET_OPERATOR_MAX_USD,
  WORKFLOW_ID_MAX_LENGTH,
} from "../workflows/limits.ts";
import {
  checkResultValue,
  validateResultSchema,
} from "../workflows/result-schema.ts";
import { formatTicketRef, parseTicketRef } from "../workflows/ticket-ref.ts";
import { TICKET_INPUT, isStartableKind } from "../workflows/triggers.ts";
import {
  forTrigger,
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
  type RunTrigger,
} from "./document.ts";
import { WorkflowRunError } from "./errors.ts";
import {
  MICRO_USD_PER_USD,
  RUNS_LISTED_MAX,
  TRIGGER_INPUT_MAX_CHARS,
} from "./limits.ts";
import {
  readStoredInput,
  storedInputOf,
  ticketValue,
  type TicketValue,
} from "./ticket.ts";

export type StepView = {
  id: string;
  position: number;
  kind: StoredStepRun["kind"];
  status: StoredStepRun["status"];
  /** How often the step has run in the run, counting this time, from 1: the rounds of a loop. */
  round: number;
  profile: { name: string; version: number } | null;
  jobId: string | null;
  turnId: string | null;
  /** What the step was charged, in US dollars; null while it runs. */
  costUsd: number | null;
  /**
   * Where `costUsd` comes from (#873): `reported` (the runner's figure), `estimated` (the token counts at the catalog price) or `limit`
   * (the whole cap the turn ran under, because nothing better was known), or `subscription` (#856: Claude Code's estimate at API prices
   * of a turn on a customer device's login; it was not charged). null for a step that was charged nothing.
   */
  costBasis: "reported" | "estimated" | "limit" | "subscription" | null;
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
  /** What started the run: a person by hand (`manual`), a script (`api`) or a label on a ticket (`ticket.labeled`, `github.issueLabeled` before #916). */
  trigger: StoredWorkflowRun["triggerKind"];
  /** The id of the trigger of the workflow that started it; null for a run written before triggers had ids. */
  triggerId: string | null;
  status: StoredWorkflowRun["status"];
  errorCode: string | null;
  /** When a member asked for the run to stop (#891), or null. A run that runs and has this is stopping: it ends `cancelled` when its turn has. */
  cancelRequestedAt: string | null;
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

/**
 * What stopping a run came to (#891). `requested`: the run is marked; its turn stops at its runner's next heartbeat and the run ends `cancelled`
 * when it has. `already_requested`: it was marked before. `already_ended`: the run is over, however it ended; nothing changed.
 */
export type CancelledRun = {
  run: RunView;
  outcome: "requested" | "already_requested" | "already_ended";
};

export type WorkflowRunService = {
  /** Starts a run of the workflow by hand. Throws a `WorkflowRunError`. */
  start(
    user: { id: string; githubLogin: string },
    workflowId: string,
    body: unknown,
  ): Promise<StartedRun>;
  get(workflowId: string, runId: string): Promise<RunView>;
  /**
   * #891: stops a run. Whoever may start one may (the route's right). It marks the run and tells the engine, which asks the turn that runs to
   * stop; the engine ends the run `cancelled` once the turn has ended, so no step starts any more and the steps that did not start are skipped.
   * A repeat and a run that is over change nothing and say so. Throws `WORKFLOW_RUN_NOT_FOUND`.
   */
  cancel(workflowId: string, runId: string): Promise<CancelledRun>;
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
  ): Promise<
    { id: string; fullName: string; defaultBranch: string } | undefined
  >;
  /**
   * #916: the issue `number` of the repository (as `resolveRepository` answered it) as a ticket, or undefined when there is none (or it is
   * a pull request). The texts are those of whoever opened it. Throws `WORKFLOW_RUN_GITHUB_UNAVAILABLE` when the platform cannot be asked.
   */
  readTicket(
    repositoryId: string,
    number: number,
  ): Promise<
    | {
        number: number;
        title: string;
        body: string;
        url: string;
        labels: string[];
        assignees: string[];
        type: string;
      }
    | undefined
  >;
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
    trigger: run.triggerKind,
    triggerId: run.triggerId,
    status: run.status,
    errorCode: run.errorCode,
    cancelRequestedAt: run.cancelRequestedAt,
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
    round: step.round,
    profile: step.profile,
    jobId: step.jobId,
    turnId: step.turnId,
    costUsd: step.costMicroUsd === null ? null : usd(step.costMicroUsd),
    costBasis: step.costBasis,
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

/** The body of a start: `{ trigger?, input, clientRequestId }` and nothing else. */
function readBody(body: unknown): {
  trigger?: string;
  input: Record<string, unknown>;
  clientRequestId: string;
} {
  const invalid = (message: string) =>
    new WorkflowRunError("WORKFLOW_RUN_REQUEST_INVALID", message);
  if (!isRecord(body)) throw invalid("The body must be a JSON object.");
  for (const key of Object.keys(body))
    if (key !== "trigger" && key !== "input" && key !== "clientRequestId")
      throw invalid(`The body has no field ${key.slice(0, 40)}.`);
  const { trigger, input, clientRequestId } = body;
  if (
    typeof clientRequestId !== "string" ||
    !CLIENT_REQUEST_ID.test(clientRequestId)
  )
    throw invalid(
      "clientRequestId must be 1 to 200 printable ASCII characters without a space.",
    );
  if (input !== undefined && !isRecord(input))
    throw invalid("input must be a JSON object.");
  if (
    trigger !== undefined &&
    (typeof trigger !== "string" || !ID_PATTERN.test(trigger))
  )
    throw invalid("trigger must be the id of a trigger of the workflow.");
  return {
    ...(trigger === undefined ? {} : { trigger }),
    input: input ?? {},
    clientRequestId,
  };
}

/** The input of a run as the caller handed it in (without the ticket, which is stored resolved), from what a run stored. */
function inputHandedIn(run: StoredWorkflowRun): Record<string, unknown> {
  return readStoredInput(jsonOrNull(run.triggerInput)).input;
}

/** The trigger the caller means: the one it names, or the only one that can be started. */
function startedTrigger(
  triggers: readonly RunTrigger[],
  named: string | undefined,
): RunTrigger {
  const startable = triggers.filter((trigger) => isStartableKind(trigger.kind));
  if (named !== undefined) {
    const found = triggers.find((trigger) => trigger.id === named);
    if (found === undefined)
      throw new WorkflowRunError(
        "WORKFLOW_RUN_TRIGGER_UNKNOWN",
        `The workflow has no trigger ${named}. Triggers that can be started: ${startable.map((t) => t.id).join(", ") || "none"}.`,
      );
    if (!isStartableKind(found.kind))
      throw new WorkflowRunError(
        "WORKFLOW_RUN_TRIGGER_NOT_MANUAL",
        `The trigger ${named} is not started by hand: only a trigger of the kind manual or api is.`,
      );
    return found;
  }
  const [only, ...others] = startable;
  if (only === undefined)
    throw new WorkflowRunError(
      "WORKFLOW_RUN_TRIGGER_NOT_MANUAL",
      "Only a workflow with a manual or api trigger is started by hand.",
    );
  if (others.length > 0)
    throw new WorkflowRunError(
      "WORKFLOW_RUN_REQUEST_INVALID",
      `The workflow has several triggers that can be started; name one as "trigger": ${startable.map((t) => t.id).join(", ")}.`,
    );
  return only;
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
   * written with its keys in another order is the same request. A body that names a trigger must name the one the run was started by;
   * a ticket is the same when it names the same issue (the repository's letters are not told apart).
   */
  function sameRequest(
    earlier: StoredWorkflowRun,
    workflowId: string,
    trigger: string | undefined,
    input: Record<string, unknown>,
  ): StoredWorkflowRun {
    const { [TICKET_INPUT]: ticket, ...rest } = input;
    const earlierRest = inputHandedIn(earlier);
    const resolved = readStoredInput(jsonOrNull(earlier.triggerInput)).ticket;
    const earlierName = isRecord(resolved?.repo)
      ? `${String(resolved.repo.fullName).toLowerCase()}#${String(resolved.number)}`
      : undefined;
    const parsed =
      typeof ticket === "string" ? parseTicketRef(ticket) : undefined;
    const name =
      parsed?.ok === true
        ? `${parsed.ref.repo.toLowerCase()}#${String(parsed.ref.number)}`
        : undefined;
    if (
      earlier.workflowId !== workflowId ||
      (trigger !== undefined &&
        earlier.triggerId !== null &&
        earlier.triggerId !== trigger) ||
      canonicalJson(earlierRest) !== canonicalJson(rest) ||
      (ticket === undefined) !== (earlierName === undefined) ||
      (name !== undefined && name !== earlierName)
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
      const { trigger: named, input, clientRequestId } = readBody(body);
      if (JSON.stringify(input).length > TRIGGER_INPUT_MAX_CHARS)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REQUEST_INVALID",
          "The input is too large.",
        );
      checkId(workflowId);

      // A request that was accepted before is answered with what it made, before anything else is looked at.
      const earlier = await deps.runs.findByRequest(clientRequestId);
      if (earlier !== undefined)
        return {
          run: await view(sameRequest(earlier, workflowId, named, input)),
          created: false,
        };

      const found = await deps.workflows.get(workflowId);
      if (found === undefined) throw notFound();
      if (found.workflow.archivedAt !== null)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_WORKFLOW_ARCHIVED",
          "The workflow is archived and is not started.",
        );
      const read = readRunDocument(found.current.document);
      if (read === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_DOCUMENT_UNUSABLE",
          "The saved workflow cannot be read.",
        );
      const trigger = startedTrigger(read.triggers, named);
      const document = forTrigger(read, { id: trigger.id, kind: trigger.kind });
      if (document === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_DOCUMENT_UNUSABLE",
          "The saved workflow cannot be read.",
        );
      const unsupported = unsupportedStep(document);
      if (unsupported !== undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED",
          `The step ${unsupported.id.slice(0, 64)} is of the kind ${unsupported.kind.slice(0, 20)}, which the engine does not run (agent, action, if and loop).`,
          { step: { id: unsupported.id, kind: unsupported.kind } },
        );

      const schema = validateResultSchema(trigger.input, "", {
        allowTicket: true,
      }).schema;
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

      // The repository of the run: the ticket's when the input has one, else the one named by `input.repo`.
      const { [TICKET_INPUT]: ticketText, ...handedIn } = input;
      const ref =
        typeof ticketText === "string" ? parseTicketRef(ticketText) : undefined;
      if (ref !== undefined && !ref.ok)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_INPUT_INVALID",
          "The ticket is not a reference like github:owner/repo#128.",
          { errors: [] },
        );
      const repoName = ref === undefined ? input.repo : ref.ref.repo;
      if (typeof repoName !== "string" || !REPO_NAME.test(repoName))
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
          "input.repo must be a repository of the workspace, as owner/name.",
        );
      const repository = await deps.resolveRepository(repoName);
      if (repository === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
          "There is no such repository in this workspace.",
        );
      let ticket: TicketValue | undefined;
      if (ref !== undefined) {
        const issue = await deps.readTicket(repository.id, ref.ref.number);
        if (issue === undefined)
          throw new WorkflowRunError(
            "WORKFLOW_RUN_TICKET_NOT_FOUND",
            "There is no such ticket in that repository (a pull request is none).",
          );
        ticket = ticketValue(issue, repository);
      }
      // Without a ticket the input is stored as it always was: a version that still runs during a deploy reads it as `trigger.input`.
      const triggerInput = JSON.stringify(storedInputOf(handedIn, ticket));
      if (triggerInput.length > TRIGGER_INPUT_MAX_CHARS)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_REQUEST_INVALID",
          "The input is too large.",
        );

      const created = await deps.runs.createRun({
        workflowId,
        workflowVersion: found.current.version,
        repositoryId: repository.id,
        baseBranch: repository.defaultBranch,
        triggerInput,
        budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
        clientRequestId,
        triggerKind: trigger.kind,
        triggerId: trigger.id,
        // #923: the ticket the run is about, in the form the label trigger writes it (the mirror reads the runs of a ticket by it).
        ...(ticket === undefined
          ? {}
          : {
              ticketRef: formatTicketRef({
                provider: "github",
                repo: ticket.repo.fullName,
                number: ticket.number,
              }),
            }),
        createdBy: user.id,
        actorLogin: user.githubLogin,
      });
      if (created.status === "existing")
        return {
          run: await view(sameRequest(created.run, workflowId, named, input)),
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

    async cancel(workflowId, runId) {
      checkId(workflowId);
      const found = await deps.runs.getRun(runId);
      if (found === undefined || found.workflowId !== workflowId)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_FOUND",
          "There is no such run of this workflow.",
        );
      if (found.status !== "running")
        return { run: await view(found), outcome: "already_ended" };
      // Under the lock of the run, like every decision about it: of two calls one marks the run, the other finds the mark.
      const marked = await deps.runs.lockRun(runId, (lock) =>
        lock.requestCancel(),
      );
      // Always, also for a repeat: the first kick may have been lost, and the engine does nothing twice.
      deps.kick(runId);
      const current = (await deps.runs.getRun(runId)) ?? found;
      return {
        run: await view(current),
        outcome:
          marked === true
            ? "requested"
            : current.status === "running"
              ? "already_requested"
              : "already_ended",
      };
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
