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
//     start knows the values); a lane of a project whose input declares `repo` is given the project's repository when the start names
//     neither a `repo` nor a `ticket` (#937), before the input is checked;
//  6. the repository is one of the workspace's, active, and the platform still resolves it: that of the `ticket` input when the trigger
//     has one (the ticket is read through the provider and handed to the steps as `trigger.ticket`), else the one named by `input.repo`;
//  7. the repository is the ticket source of the project the lane belongs to (#922; `WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT` for a ticket,
//     `WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT` for `input.repo`). A lane without a project (archived, or written by an older version) is not held to it.
// Then the run is written with the version the workflow has now, and the engine is told to start it.
import type {
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  ProjectsRepository,
  StoredProject,
} from "../db/repositories/projects-repository.ts";
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
  type ResultSchema,
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
import { parseStepAsk, type StepAsk } from "./ask.ts";
import type { WorkflowEngine } from "./engine.ts";
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
  /**
   * #920: the question the step's turn ended with and what became of it (`open` while the step is `waiting`, `answered` with who answered
   * and how); null for a step that never asked. Agent text and a person's: shown as plain text.
   */
  ask: StepAsk | null;
  /** #920: the id of the comment that carries the question on the ticket or the pull request, once it is posted; null otherwise. */
  waitingOnCommentId: string | null;
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
  /** When a member asked for the run to stop (#891), or null. Legacy: only runs of before #921 have it; a member discards a run now. */
  cancelRequestedAt: string | null;
  /** When a member discarded the run (#921), or null; the status is then `discarded`. */
  discardedAt: string | null;
  /** When a member asked the run to stop after its current step (#921), or null. No new step starts until it is resumed. */
  pauseRequestedAt: string | null;
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
 * What discarding a run came to (#921). `discarded`: the run was active or over and is `discarded` now. `already_discarded`: it was
 * discarded before; nothing changed.
 */
export type DiscardedRun = {
  run: RunView;
  outcome: "discarded" | "already_discarded";
};

/**
 * What pausing or resuming a run came to (#921). `changed`: the run is marked as one to pause after its current step (or the mark is gone).
 * `unchanged`: it was so already, or the run is over, and nothing changed.
 */
export type PausedRun = { run: RunView; outcome: "changed" | "unchanged" };

export type WorkflowRunService = {
  /** Starts a run of the workflow by hand. Throws a `WorkflowRunError`. */
  start(
    user: { id: string; githubLogin: string },
    workflowId: string,
    body: unknown,
  ): Promise<StartedRun>;
  get(workflowId: string, runId: string): Promise<RunView>;
  /**
   * #921: discards a run, whatever state it is in (running, waiting, or over). Whoever may start a run may. The run is `discarded` at once and
   * frees its ticket; a turn that runs is asked to stop, the comment of an open question says it was discarded, the labels `agent working`
   * and `agent waiting` come off, and `onFailure` does not run. A repeat changes nothing and says so. Throws `WORKFLOW_RUN_NOT_FOUND`.
   * The cancel route of #891 forwards here (`cancel` is the same call).
   */
  discard(workflowId: string, runId: string): Promise<DiscardedRun>;
  /** #891, forwarded (#921): the same as `discard`. */
  cancel(workflowId: string, runId: string): Promise<DiscardedRun>;
  /**
   * #921: asks a run that is active to stop after its current step: the step that runs goes on, and none starts until `resume`. A run that is
   * over or paused already changes nothing and says so. Throws `WORKFLOW_RUN_NOT_FOUND`.
   */
  pause(workflowId: string, runId: string): Promise<PausedRun>;
  /** #921: takes the pause off: the engine starts the next step. */
  resume(workflowId: string, runId: string): Promise<PausedRun>;
  /**
   * #920: answers the question the run waits for, from the page of the run: an option by its number (from 1) and/or a text. Whoever may start
   * a run may answer one. The answer is recorded with the person's GitHub login, or with none (`by: null`) for an account without one: an
   * email address is never written on a ticket. The step and the run go on (the engine starts the turn that continues the session). Throws `WORKFLOW_RUN_NOT_FOUND`,
   * `WORKFLOW_RUN_REQUEST_INVALID` for a body that is no answer, `WORKFLOW_RUN_NOT_WAITING`, `WORKFLOW_RUN_QUESTION_CHANGED` (the body's
   * `question` is not the one that waits) and `WORKFLOW_RUN_ANSWER_INVALID`.
   */
  answer(
    user: { id: string; githubLogin: string | null },
    workflowId: string,
    runId: string,
    body: unknown,
  ): Promise<{ run: RunView }>;
  /** The newest runs of a workflow, without their steps. */
  list(workflowId: string): Promise<{ runs: RunSummaryView[] }>;
};

export type WorkflowRunServiceDependencies = {
  runs: WorkflowRunsRepository;
  /** #920: the engine that takes the answer, and (#921) discards a run. Left out: the service has neither `answer` nor `discard`. */
  engine?: Pick<WorkflowEngine, "answer" | "discard">;
  workflows: Pick<WorkflowsRepository, "get">;
  /** The projects of the workspace (#922): the lane's project says which repository its runs may work in. */
  projects: Pick<ProjectsRepository, "getById">;
  /** The full name of a repository of the workspace (`owner/name`), or undefined when there is none; names the project's repository in a refusal. */
  repositoryName(repositoryId: string): Promise<string | undefined>;
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
    discardedAt: run.discardedAt,
    pauseRequestedAt: run.pauseRequestedAt,
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
    ask: parseStepAsk(step.ask) ?? null,
    waitingOnCommentId: step.waitingOnCommentId,
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

const ANSWER_REFUSALS = {
  answer_empty: "The answer is empty: choose an option or write a text.",
  answer_too_long: "The answer is too long.",
  option_unknown: "The question has no such option.",
} as const;

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
  /**
   * `input`, with `repo` set to the repository of the project when the input of the trigger declares `repo`, the caller names neither a
   * `repo` nor a `ticket`, and the lane belongs to a project (#937). Anything else is returned as it is.
   */
  async function withProjectRepository(
    input: Record<string, unknown>,
    schema: ResultSchema,
    project: StoredProject | undefined,
  ): Promise<Record<string, unknown>> {
    if (
      project === undefined ||
      input.repo !== undefined ||
      input[TICKET_INPUT] !== undefined ||
      !Object.hasOwn(schema.properties, "repo")
    )
      return input;
    const name = await deps.repositoryName(project.ticketSource.repositoryId);
    return name === undefined ? input : { ...input, repo: name };
  }

  function sameRequest(
    earlier: StoredWorkflowRun,
    workflowId: string,
    trigger: string | undefined,
    input: Record<string, unknown>,
  ): StoredWorkflowRun {
    const { [TICKET_INPUT]: ticket, ...rest } = input;
    // A `repo` the project filled in (#937) is not in a replay that left it out.
    const { repo: filledRepo, ...earlierWithoutRepo } = inputHandedIn(earlier);
    const earlierRest =
      rest.repo === undefined
        ? earlierWithoutRepo
        : { ...earlierWithoutRepo, repo: filledRepo };
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

  /** The run of this workflow. Throws `WORKFLOW_RUN_NOT_FOUND` for none, or one of another workflow. */
  async function ofWorkflow(
    workflowId: string,
    runId: string,
  ): Promise<StoredWorkflowRun> {
    const found = await deps.runs.getRun(runId);
    if (found === undefined || found.workflowId !== workflowId)
      throw new WorkflowRunError(
        "WORKFLOW_RUN_NOT_FOUND",
        "There is no such run of this workflow.",
      );
    return found;
  }

  async function discard(
    workflowId: string,
    runId: string,
  ): Promise<DiscardedRun> {
    checkId(workflowId);
    await ofWorkflow(workflowId, runId);
    if (deps.engine === undefined)
      throw new Error("the run service has no engine to discard with");
    // The engine does it under the lock of the run: of two calls one discards, the other finds the run discarded.
    const done = await deps.engine.discard(runId);
    return {
      run: await view(await ofWorkflow(workflowId, runId)),
      outcome: done.outcome === "discarded" ? "discarded" : "already_discarded",
    };
  }

  async function setPause(
    workflowId: string,
    runId: string,
    paused: boolean,
  ): Promise<PausedRun> {
    checkId(workflowId);
    const found = await ofWorkflow(workflowId, runId);
    // Under the lock of the run, like every decision about it: of two calls one marks the run, the other finds the mark.
    const changed = await deps.runs.lockRun(runId, (lock) =>
      lock.setPause(paused),
    );
    // A resumed run is looked at at once; the first kick may also have been lost.
    if (!paused) deps.kick(runId);
    return {
      run: await view((await deps.runs.getRun(runId)) ?? found),
      outcome: changed === true ? "changed" : "unchanged",
    };
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
      // #937: a lane of a project works in the repository of the project, so a manual or api start that declares `repo` and leaves it out
      // is given the project's repository (a start that names one still is held to it, below); a start that has a `ticket` has its repository.
      const project =
        found.workflow.projectId === null
          ? undefined
          : await deps.projects.getById(found.workflow.projectId);
      const given = await withProjectRepository(input, schema, project);
      const problems = checkResultValue(schema, given);
      if (problems.length > 0)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_INPUT_INVALID",
          "The input does not fit the input of the trigger.",
          { errors: problems },
        );

      // The repository of the run: the ticket's when the input has one, else the one named by `input.repo`.
      const { [TICKET_INPUT]: ticketText, ...handedIn } = given;
      const ref =
        typeof ticketText === "string" ? parseTicketRef(ticketText) : undefined;
      if (ref !== undefined && !ref.ok)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_INPUT_INVALID",
          "The ticket is not a reference like github:owner/repo#128.",
          { errors: [] },
        );
      const repoName = ref === undefined ? given.repo : ref.ref.repo;
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
      // #922: a lane works within the ticket source of its project; checked before the platform is asked about the ticket.
      if (
        project !== undefined &&
        project.ticketSource.repositoryId !== repository.id
      ) {
        const sourceName = await deps.repositoryName(
          project.ticketSource.repositoryId,
        );
        const available = sourceName === undefined ? [] : [sourceName];
        const ticketGiven = ref !== undefined;
        throw new WorkflowRunError(
          ticketGiven
            ? "WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT"
            : "WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT",
          ticketGiven
            ? "The ticket is not in the ticket source of the project of this lane."
            : "The repository is not the ticket source of the project of this lane.",
          {
            issues: [
              {
                path: ticketGiven ? "input.ticket" : "input.repo",
                code: ticketGiven
                  ? "ticket_outside_project"
                  : "repository_outside_project",
                message: ticketGiven
                  ? "The ticket must be an issue of the repository the project takes its tickets from."
                  : "The repository must be the one the project takes its tickets from.",
                available,
              },
            ],
          },
        );
      }
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

    discard,
    // #891: the old route and its method are the same call as a discard.
    cancel: discard,
    pause: (workflowId, runId) => setPause(workflowId, runId, true),
    resume: (workflowId, runId) => setPause(workflowId, runId, false),

    async answer(user, workflowId, runId, body) {
      checkId(workflowId);
      const invalid = (message: string) =>
        new WorkflowRunError("WORKFLOW_RUN_REQUEST_INVALID", message);
      if (!isRecord(body)) throw invalid("The body must be a JSON object.");
      for (const key of Object.keys(body))
        if (key !== "choice" && key !== "text" && key !== "question")
          throw invalid(`The body has no field ${key.slice(0, 40)}.`);
      const { choice, text, question } = body;
      if (
        !isRecord(question) ||
        typeof question.stepRunId !== "string" ||
        question.stepRunId === "" ||
        question.stepRunId.length > 128 ||
        typeof question.n !== "number" ||
        !Number.isSafeInteger(question.n)
      )
        throw invalid(
          "question must name the question that is answered: { stepRunId, n }.",
        );
      if (
        choice !== undefined &&
        (typeof choice !== "number" || !Number.isSafeInteger(choice))
      )
        throw invalid("choice must be the number of an option, from 1.");
      if (text !== undefined && typeof text !== "string")
        throw invalid("text must be a text.");
      const found = await deps.runs.getRun(runId);
      if (found === undefined || found.workflowId !== workflowId)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_FOUND",
          "There is no such run of this workflow.",
        );
      if (deps.engine === undefined)
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_WAITING",
          "This run does not wait for an answer.",
        );
      const answered = await deps.engine.answer(runId, {
        question: { stepRunId: question.stepRunId, n: question.n },
        ...(choice === undefined ? {} : { choice }),
        ...(text === undefined ? {} : { text }),
        by: user.githubLogin,
        via: "ui",
      });
      if (answered.outcome === "refused") {
        if (answered.code === "question_changed")
          throw new WorkflowRunError(
            "WORKFLOW_RUN_QUESTION_CHANGED",
            "This question was already answered or replaced.",
          );
        throw new WorkflowRunError(
          "WORKFLOW_RUN_ANSWER_INVALID",
          ANSWER_REFUSALS[answered.code],
        );
      }
      if (answered.outcome === "not_waiting")
        throw new WorkflowRunError(
          "WORKFLOW_RUN_NOT_WAITING",
          "This run does not wait for an answer: it was answered already, or it is being stopped.",
        );
      // The turn that goes on starts after the response, like the first steps of a run.
      deps.kick(runId);
      return { run: await view((await deps.runs.getRun(runId)) ?? found) };
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
