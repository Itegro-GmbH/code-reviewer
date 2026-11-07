// SPDX-License-Identifier: LicenseRef-Proprietary

// The engine of the workflows (#844, milestone 3a): it drives a run from step to step. One engine works for ONE workspace (its
// repositories are created for it).
//
// How it stays correct when events repeat, arrive late or arrive together:
//  - Every decision is made under a lock on the run row (`lockRun`), by `nextMove` (machine.ts) from the state the lock shows. A second
//    event waits for the first, then finds the state the first left and is told `idle`.
//  - The work itself (a request to start a turn, an action) is done outside the lock, after the step was claimed by a guarded update
//    (`pending` to `running`): of several workers one wins. An agent step is started under a request id made from the run and the
//    position, so starting it twice yields one turn; an action that was interrupted is NOT repeated (it may have happened).
//  - What ends a step is read from the database, not from the event: the event only says which run to look at (`jobEnded`). A job that
//    ended without anybody reporting it is found by the sweep (`advance` for the runs that were not touched for a while).
//
// Control (#846): the steps of a run are written one row each in the order they run, and `nextMove` replays the rows against the
// document (machine.ts), so a `loop` that runs its body again and an `if` that leaves a branch out need nothing but rows. The engine
// evaluates the condition of a control step under the lock, from the values the rows hold, and writes what it decided.
//
// A failure of the engine never reaches the code that ended the turn: `jobEnded` catches everything and logs a code.
import type { ProfilesRepository } from "../db/repositories/profiles-repository.ts";
import type { ImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type {
  RunLock,
  StepOutcome,
  StoredStepRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type { WorkspaceMembersRepository } from "../db/repositories/workspace-members-repository.ts";
import { ImplementerError } from "../implementer/errors.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { ImplementerService } from "../implementer/service.ts";
import { INSTRUCTION_MAX_LENGTH } from "../implementer/start-input.ts";
import { canonicalJson, isRecord } from "../workflows/json.ts";
import { parseProfileRef } from "../workflows/resolver.ts";
import {
  canonicalTriggerKind,
  legacyTriggerId,
  type TriggerKind,
} from "../workflows/triggers.ts";
import {
  ActionInputError,
  ConnectorError,
  MAY_HAVE_HAPPENED,
  resolveActionInputs,
  specOf,
  type ConnectorRegistry,
} from "./connectors.ts";
import { conditionHolds } from "./conditions.ts";
import {
  forTrigger,
  machineNodes,
  nodesById,
  readRunDocument,
  type RunDocument,
} from "./document.ts";
import {
  ACTION_TIMEOUT_MS,
  ERROR_MESSAGE_MAX_CHARS,
  MICRO_USD_COLUMN_MAX,
  MICRO_USD_PER_CENT,
  MOVES_PER_CALL_MAX,
  STEP_GIVE_UP_MS,
  STEP_STALE_MS,
} from "./limits.ts";
import {
  contextOf,
  nextMove,
  type FailureRecord,
  type MachineState,
  type MachineStep,
  type RoundContext,
} from "./machine.ts";
import { WORKFLOW_OWNER_GONE_TEXT } from "./errors.ts";
import {
  renderText,
  resolveValue,
  TemplateError,
  type RunValues,
} from "./templates.ts";
import { outcomeOfTurn, type CostBasis, type EndedTurn } from "./turn-facts.ts";

/** A turn as the engine reads it: its id, and the whole of it once its job is over. */
export type TurnRead = { turnId: string; ended: EndedTurn | undefined };
/** A turn found by the request id it was started under. */
export type RequestedTurn = TurnRead & { jobId: string };

export type EngineDependencies = {
  runs: WorkflowRunsRepository;
  workflows: Pick<WorkflowsRepository, "getVersion">;
  /** The members of the workspace: a run a label started belongs to the account that owns the workflow, who must still be one. */
  members: Pick<WorkspaceMembersRepository, "get">;
  profiles: Pick<ProfilesRepository, "findByName">;
  environments: Pick<ImplementerEnvironmentsRepository, "listSummaries">;
  implementer: Pick<
    ImplementerService,
    "startTask" | "continueSession" | "discardRequested"
  >;
  /**
   * #891: asks the job of a turn to stop (a waiting one ends at once, a running one is told by its next heartbeat). Repeating it is harmless.
   * The `JobQueue` of the workspace does this.
   */
  jobs: Pick<JobQueue, "requestCancel">;
  /** The turn a job runs, or undefined for a job that is no turn of this workspace. `ended` is set once the job is over. */
  turns: {
    read(jobId: string): Promise<TurnRead | undefined>;
    /** The turn a request id started (`wf-<run>-<position>`), or undefined. Looked at before a step is given up. */
    findByRequest(clientRequestId: string): Promise<RequestedTurn | undefined>;
  };
  connectors: ConnectorRegistry;
  /** The full name of the repository of a run, for the call of an action. */
  repositoryName(repositoryId: string): Promise<string | undefined>;
  now?: () => Date;
  /** The most one call of a connector may take; `ACTION_TIMEOUT_MS` unless a test shortens it. */
  actionTimeoutMs?: number;
  /** One line per notable event; never a value, a token or the text of an error. */
  log?: (line: string) => void;
};

export type WorkflowEngine = {
  /** Takes the run as far as it can go: writes and does the next steps until it waits for a job, or is over. Idempotent. */
  advance(runId: string): Promise<void>;
  /**
   * The Implementer job `jobId` has ended. If a workflow step ran it, the run goes on. Never throws and never waits for long: the code
   * that ended the turn must not fail or slow down because of the engine.
   */
  jobEnded(jobId: string): Promise<void>;
};

type Resolved = { name: string; version: number } | undefined;

/**
 * What the decision under the lock needs from other tables, read BEFORE the lock is taken. A decision runs inside a transaction that
 * holds a connection; reading through a second connection from inside it would let `poolMax` concurrent decisions each hold one (the
 * others wait for the row lock, and hold one too) and wait for another, which starves the pool until the connect times out (#875). A
 * value missing here is never read inside: the decision answers `fetch` before it wrote anything, the value is read after the lock was
 * released, and the decision is made again (the state changed between the two reads).
 */
type Prefetched = {
  document?: { value: RunDocument | undefined };
  turns: Map<string, TurnRead | undefined>;
  /** For a run a label started that has no step yet: whether the owner of the workflow has left the workspace. */
  ownerGone?: boolean;
  /** For an agent step with no job that has been claimed for a while: the turn its request id started, if any (by step id). */
  started: Map<string, RequestedTurn | undefined>;
  /** The agent steps (by step run id) whose queued instruction was discarded before the step was given up. */
  discarded: Set<string>;
  profiles: Map<string, Resolved>;
};

type Decision =
  | { kind: "done" }
  | { kind: "again" }
  | { kind: "execute"; stepRun: StoredStepRun; takeOver: boolean }
  /** #891: the run was asked to stop and the turn of this step still runs: its job is asked to stop, after the lock is released. */
  | { kind: "cancel_job"; jobId: string }
  /** The decision needs a value that was not read; `read` puts it into `Prefetched`. Nothing was written. */
  | { kind: "fetch"; read: (pre: Prefetched) => Promise<void> };

/**
 * How many times one move may leave the lock to read what it lacked. Each read fills one value that the next try finds, and one state
 * of the run needs two at most (the document, then one of turn, profile or request); the rest is room for a state that changes between
 * tries. More means it keeps changing: the move ends without writing, and the sweep looks at the run again.
 */
const FETCHES_PER_MOVE_MAX = 8;

const clip = (text: string): string =>
  text.length <= ERROR_MESSAGE_MAX_CHARS
    ? text
    : `${text.slice(0, ERROR_MESSAGE_MAX_CHARS - 1)}…`;

function failed(
  errorCode: string,
  errorMessage: string,
  extra: { costMicroUsd?: number; costBasis?: CostBasis } = {},
): StepOutcome {
  return {
    status: "failed",
    errorCode,
    errorMessage: clip(errorMessage),
    ...extra,
  };
}

function parseOutput(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * What `{{trigger.*}}` holds for a run (#916): its `id` and `kind`, and what the trigger stored when it started the run. A run started
 * by hand or through the API stored `{ input, ticket? }`; a run a label started stored `{ ticket, issue, repo }` (`label-trigger.ts`).
 * A run written before triggers had ids stored a manual run's input as handed in, which is read as `{ input }`.
 *
 * TODO(#923): `workflow_runs.ticket_ref` (the ticket's reference, `github:owner/repo#128`) comes with the ticket mirror of #923, in a
 * migration of its own. This change does not add the column; once it exists, `createRun` of the label trigger and of the start service
 * set it from the ticket they hold (`ticket.ts`).
 */
function triggerValueOf(run: StoredWorkflowRun): Record<string, unknown> {
  const stored = parseOutput(run.triggerInput);
  const record = isRecord(stored) ? stored : {};
  const kind = canonicalTriggerKind(run.triggerKind as TriggerKind);
  const facts = { id: run.triggerId ?? legacyTriggerId(kind), kind };
  if (run.triggerId === null && kind === "manual")
    return { ...facts, input: record };
  return { ...facts, ...record };
}

/**
 * What a reference can reach: the trigger and the output of every step that succeeded (of a step that ran in several rounds, the
 * latest), and `previous.<step>`, what a direct step of the loop body had in the round before (`context`).
 */
function valuesOf(
  run: StoredWorkflowRun,
  steps: readonly StoredStepRun[],
  context?: RoundContext,
): RunValues {
  const failure = failureOf(run);
  return {
    trigger: triggerValueOf(run),
    // The facts of the failure exist for the steps of `onFailure` only: once the run has begun them.
    ...(failure === undefined
      ? {}
      : {
          failure: {
            status: failure.status,
            stepId: failure.stepId,
            code: failure.code,
            message: failure.message,
          },
        }),
    steps: Object.fromEntries(
      steps.flatMap((step) =>
        step.status === "succeeded"
          ? [[step.stepId, parseOutput(step.output) ?? {}] as const]
          : [],
      ),
    ),
    previous: Object.fromEntries(
      Object.entries(context?.previous ?? {}).flatMap(([stepId, index]) => {
        const step = steps[index];
        return step?.status === "succeeded"
          ? [[stepId, parseOutput(step.output) ?? {}] as const]
          : [];
      }),
    ),
    agentSteps: new Set(
      steps.filter((step) => step.kind === "agent").map((step) => step.stepId),
    ),
  };
}

/** How a run ended while its `onFailure` steps run, as the engine stored it; undefined before, or for text that is not a record of it. */
function failureOf(
  run: Pick<StoredWorkflowRun, "failure">,
): FailureRecord | undefined {
  const parsed = parseOutput(run.failure);
  if (!isRecord(parsed)) return undefined;
  const { status, errorCode, stepId, code, message } = parsed;
  if (
    (status !== "failed" && status !== "cancelled") ||
    (errorCode !== null && typeof errorCode !== "string") ||
    typeof stepId !== "string" ||
    typeof code !== "string" ||
    typeof message !== "string"
  )
    return undefined;
  return {
    status,
    errorCode: errorCode as FailureRecord["errorCode"],
    stepId,
    code,
    message,
  };
}

/** The request id an agent step starts its turn under, and the idempotency key of an action: stable for the step of a run. */
const requestIdOf = (
  run: Pick<StoredWorkflowRun, "id">,
  step: Pick<StoredStepRun, "position">,
): string => `wf-${run.id}-${step.position}`;

/** The branch an `if` row took, from its output. */
function takenOf(step: StoredStepRun): "then" | "else" | undefined {
  const output = parseOutput(step.output);
  return isRecord(output) &&
    (output.taken === "then" || output.taken === "else")
    ? output.taken
    : undefined;
}

/** The rows as the state machine reads them. */
function machineStepsOf(steps: readonly StoredStepRun[]): MachineStep[] {
  return steps.map((step) => {
    const taken = takenOf(step);
    return {
      stepId: step.stepId,
      status: step.status,
      kind: step.kind,
      hasJob: step.jobId !== null,
      createdAt: step.createdAt,
      startedAt: step.startedAt,
      errorCode: step.errorCode,
      errorMessage: step.errorMessage,
      ...(taken === undefined ? {} : { taken }),
    };
  });
}

/**
 * The earlier run of the agent step whose session this step goes on in (`session.continue`), or undefined: the step starts a new session
 * (it names none, or it is the first round of a step that continues itself, and no run of the target is over yet). Of several runs of the
 * target the latest wins. `before`: only the rows written before this one count.
 */
function continuedStep(
  node: RunDocument["steps"][number],
  steps: readonly StoredStepRun[],
  before: number,
): StoredStepRun | undefined {
  const target = isRecord(node.session) ? node.session.continue : undefined;
  if (typeof target !== "string") return undefined;
  return steps
    .slice(0, before)
    .findLast(
      (step) =>
        step.stepId === target &&
        step.kind === "agent" &&
        step.status === "succeeded" &&
        step.jobId !== null,
    );
}

/** The text of the instruction for this round: `first` in round one and outside a loop, `next` from round two on. */
function instructionOf(
  node: RunDocument["steps"][number],
  context: RoundContext,
): string {
  const { instruction } = node;
  if (typeof instruction === "string") return instruction;
  if (!isRecord(instruction)) return "";
  const text =
    context.loopRound >= 2 && typeof instruction.next === "string"
      ? instruction.next
      : instruction.first;
  return typeof text === "string" ? text : "";
}

/**
 * The branch of a session of its own: one for each run of each step, so nothing else can hold the name. A step that runs again in a later
 * round gets its own, `<step id>.r<round>`: a step id never holds a `.`, so no step can be named like another step's later round.
 */
export function sessionBranchOf(
  run: Pick<StoredWorkflowRun, "id">,
  step: Pick<StoredStepRun, "stepId" | "round">,
): string {
  return `workflow/${run.id}/${step.stepId}${step.round > 1 ? `.r${String(step.round)}` : ""}`;
}

/** The `branch` of an agent step with its reference filled in: a text, else the step ends. A missing value fails the step (`TemplateError`). */
function startBranchOf(
  branch: unknown,
  values: RunValues,
): string | StepOutcome {
  const resolved =
    typeof branch === "string" ? resolveValue(branch, values) : undefined;
  return typeof resolved === "string" && resolved !== ""
    ? resolved
    : failed(
        "template_invalid",
        "The branch of this step is not the name of a branch.",
      );
}

class ActionTimeout extends Error {}

/** Resolves with what the work yields, or rejects with `ActionTimeout` once `ms` have passed; the work gets a signal that is aborted then. */
function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new ActionTimeout());
    }, ms);
  });
  // The work is started inside a promise, so that one that throws before it returns still ends the race and clears the timer.
  const working = Promise.resolve().then(() => work(abort.signal));
  return Promise.race([working, expired]).finally(() => clearTimeout(timer));
}

/** The micro dollars of the budget to whole cents a task's limit is made of, at least one. */
function capCents(capMicroUsd: number | null): number {
  return Math.max(1, Math.floor((capMicroUsd ?? 0) / MICRO_USD_PER_CENT));
}

export function createWorkflowEngine(deps: EngineDependencies): WorkflowEngine {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line) => console.info(line));

  async function documentOf(
    run: StoredWorkflowRun,
  ): Promise<RunDocument | undefined> {
    const version = await deps.workflows.getVersion(
      run.workflowId,
      run.workflowVersion,
    );
    if (version === undefined) return undefined;
    // The pre-steps of the trigger that started the run come before the shared steps; the machine walks one list (#916).
    const document = readRunDocument(version.document);
    return document === undefined
      ? undefined
      : forTrigger(document, { id: run.triggerId, kind: run.triggerKind });
  }

  /** The state the machine decides from: the rows, the nodes of the document, and how a condition is told from the values of the run. */
  function machineStateOf(
    run: StoredWorkflowRun,
    steps: readonly StoredStepRun[],
    document: RunDocument,
    logFailures: boolean,
  ): MachineState {
    const byId = nodesById(document);
    return {
      runStatus: run.status,
      cancelRequested: run.cancelRequestedAt !== null,
      budgetMicroUsd: run.budgetMicroUsd,
      spentMicroUsd: run.spentMicroUsd,
      steps: machineStepsOf(steps),
      nodes: machineNodes(document.steps),
      onFailure: machineNodes(document.onFailure),
      failure: failureOf(run) ?? null,
      holds(nodeId, context) {
        const node = byId.get(nodeId);
        const condition =
          node?.kind === "if"
            ? node.when
            : node?.kind === "loop"
              ? node.until
              : undefined;
        try {
          return conditionHolds(condition, valuesOf(run, steps, context));
        } catch (error) {
          if (logFailures)
            log(
              `[workflow-runs] CONDITION_FAILED run=${run.id} step=${nodeId}: ${error instanceof Error ? error.message : "unknown"}`,
            );
          throw error;
        }
      },
      now: now(),
      staleMs: STEP_STALE_MS,
      giveUpMs: STEP_GIVE_UP_MS,
    };
  }

  /** Ends a step the engine looked at under the lock because its turn is over. */
  async function endAgentStep(
    lock: RunLock,
    step: StoredStepRun,
    pre: Prefetched,
  ): Promise<"ended" | "waiting" | Decision> {
    if (step.jobId === null) return "waiting";
    const { jobId } = step;
    if (!pre.turns.has(jobId))
      return {
        kind: "fetch",
        read: async (into) => {
          into.turns.set(jobId, await deps.turns.read(jobId));
        },
      };
    const read = pre.turns.get(jobId);
    if (read === undefined) {
      await lock.finishStep(
        step.id,
        failed("turn_unreadable", "The turn of this step cannot be found."),
      );
      return "ended";
    }
    if (read.ended === undefined) return "waiting";
    const outcome = outcomeOfTurn(
      read.ended,
      Math.min(step.capMicroUsd ?? 0, MICRO_USD_COLUMN_MAX),
    );
    const cost = Math.min(outcome.costMicroUsd, MICRO_USD_COLUMN_MAX);
    // A subscription turn has no cost to report (#856): its estimate is on the page, nothing is left to watch.
    if (
      outcome.costBasis !== "reported" &&
      outcome.costBasis !== "subscription"
    )
      log(
        `[workflow-runs] cost not reported run=${step.runId} step=${step.stepId} charged=${outcome.costBasis}`,
      );
    await lock.finishStep(
      step.id,
      outcome.ok
        ? {
            status: "succeeded",
            output: JSON.stringify(outcome.output),
            costMicroUsd: cost,
            costBasis: outcome.costBasis,
          }
        : failed(outcome.code, outcome.message, {
            costMicroUsd: cost,
            costBasis: outcome.costBasis,
          }),
    );
    if (!outcome.ok && outcome.detail !== undefined)
      log(
        `[workflow-runs] STEP_TURN_FAILED run=${step.runId} step=${step.stepId} code=${outcome.code} detail=${outcome.detail}`,
      );
    return "ended";
  }

  /** The profile an agent step runs with: the version it names, or the newest one at this moment (and then that one for good). */
  async function resolveProfile(
    node: RunDocument["steps"][number],
  ): Promise<Resolved> {
    const ref =
      typeof node.profile === "string"
        ? parseProfileRef(node.profile)
        : undefined;
    if (ref === undefined) return undefined;
    const found = await deps.profiles.findByName(ref.name, ref.version);
    return found === undefined
      ? undefined
      : { name: found.profile.name, version: found.version.version };
  }

  /** Reads what the next decision about a run will need, outside the lock; see `Prefetched`. Never throws. */
  async function prefetch(runId: string): Promise<Prefetched> {
    const pre: Prefetched = {
      turns: new Map(),
      started: new Map(),
      discarded: new Set(),
      profiles: new Map(),
    };
    try {
      const run = await deps.runs.getRun(runId);
      if (run === undefined || run.status !== "running") return pre;
      const document = await documentOf(run);
      pre.document = { value: document };
      if (document === undefined) return pre;
      const steps = await deps.runs.listSteps(runId);
      const last = steps[steps.length - 1];
      if (last?.status === "running" && last.jobId !== null)
        pre.turns.set(last.jobId, await deps.turns.read(last.jobId));
      if (
        last?.status === "running" &&
        last.kind === "agent" &&
        last.jobId === null &&
        last.startedAt !== null &&
        now().getTime() - Date.parse(last.startedAt) >= STEP_STALE_MS
      )
        pre.started.set(
          last.id,
          await deps.turns.findByRequest(requestIdOf(run, last)),
        );
      // The profile of the step the next move writes, if it is an agent step that starts a session of its own.
      const move = nextMove(machineStateOf(run, steps, document, false));
      const node =
        move.move === "add_step" && move.kind === "agent"
          ? nodesById(document).get(move.stepId)
          : undefined;
      if (
        node !== undefined &&
        typeof node.profile === "string" &&
        continuedStep(node, steps, steps.length) === undefined
      )
        pre.profiles.set(node.profile, await resolveProfile(node));
    } catch {
      // What is missing is read again after the lock, by the decision's own fetch, where a failure is the move's to deal with.
    }
    return pre;
  }

  async function decide(lock: RunLock, pre: Prefetched): Promise<Decision> {
    const { run } = lock;
    if (run.status !== "running") return { kind: "done" };
    if (pre.document === undefined)
      return {
        kind: "fetch",
        read: async (into) => {
          into.document = { value: await documentOf(run) };
        },
      };
    const document = pre.document.value;
    if (document === undefined) {
      await lock.finishRun({
        status: "failed",
        errorCode: "document_unusable",
      });
      return { kind: "done" };
    }
    // A run a label started belongs to the author of the workflow version it uses. If that person has left the workspace, the run ends before
    // it does anything: nobody who is still a member put the workflow in charge of the issue.
    if (run.createdBy === null && lock.steps.length === 0) {
      if (pre.ownerGone === undefined)
        return {
          kind: "fetch",
          read: async (into) => {
            into.ownerGone = !(await ownerIsMember(run));
          },
        };
      if (pre.ownerGone) {
        await lock.finishRun({
          status: "failed",
          errorCode: "workflow_owner_gone",
        });
        log(
          `[workflow-runs] run failed run=${run.id} code=workflow_owner_gone`,
        );
        return { kind: "done" };
      }
    }
    const move = nextMove(machineStateOf(run, lock.steps, document, true));
    switch (move.move) {
      case "idle":
        return { kind: "done" };
      case "begin_failure": {
        // The run stays `running` while the steps of `onFailure` run; it ends with the status stored here.
        await lock.beginFailure(JSON.stringify(move.failure));
        log(
          `[workflow-runs] run failing run=${run.id} status=${move.failure.status} code=${move.failure.code}`,
        );
        return { kind: "again" };
      }
      case "finish_run":
        await lock.finishRun({
          status: move.status,
          errorCode: move.errorCode,
        });
        log(
          `[workflow-runs] run ${move.status} run=${run.id}${move.errorCode === null ? "" : ` code=${move.errorCode}`}`,
        );
        return { kind: "done" };
      case "add_step": {
        const node = nodesById(document).get(move.stepId);
        if (node === undefined) return { kind: "done" };
        // A step that goes on in an earlier session runs with the profile that session had.
        const continued =
          move.kind === "agent"
            ? continuedStep(node, lock.steps, lock.steps.length)
            : undefined;
        const ref = node.profile;
        if (
          move.kind === "agent" &&
          continued === undefined &&
          typeof ref === "string" &&
          !pre.profiles.has(ref)
        )
          return {
            kind: "fetch",
            read: async (into) => {
              into.profiles.set(ref, await resolveProfile(node));
            },
          };
        const profile =
          move.kind !== "agent"
            ? undefined
            : continued !== undefined
              ? (continued.profile ?? undefined)
              : typeof ref === "string"
                ? pre.profiles.get(ref)
                : undefined;
        const stepRun = await lock.addStep({
          position: move.position,
          stepId: node.id,
          kind: move.kind,
          round: move.round,
          profile: profile ?? null,
          capMicroUsd: move.capMicroUsd,
        });
        if (move.kind === "agent" && profile === undefined) {
          await lock.finishStep(
            stepRun.id,
            failed(
              "profile_not_found",
              "The profile of this step is gone, archived or has no such version.",
            ),
          );
          return { kind: "again" };
        }
        return { kind: "execute", stepRun, takeOver: false };
      }
      case "add_if": {
        await lock.addFinished([
          {
            position: move.position,
            stepId: move.stepId,
            kind: "if",
            round: move.round,
            status: "succeeded",
            output: JSON.stringify({ taken: move.taken }),
          },
          // The steps of the branch that was not taken are written as skipped, so the run shows what did not run.
          ...move.skipped.map((skipped, index) => ({
            position: move.position + 1 + index,
            stepId: skipped.stepId,
            kind: skipped.kind,
            round: skipped.round,
            status: "skipped" as const,
            output: null,
          })),
        ]);
        return { kind: "again" };
      }
      case "end_loop": {
        await lock.addFinished([
          {
            position: move.position,
            stepId: move.stepId,
            kind: "loop",
            round: move.round,
            status: "succeeded",
            output: JSON.stringify({ exit: move.exit, rounds: move.rounds }),
          },
        ]);
        log(
          `[workflow-runs] loop ended run=${run.id} step=${move.stepId} exit=${move.exit} rounds=${String(move.rounds)}`,
        );
        return { kind: "again" };
      }
      case "execute": {
        const stepRun = lock.steps[move.position];
        return stepRun === undefined
          ? { kind: "done" }
          : { kind: "execute", stepRun, takeOver: move.takeOver };
      }
      case "read_job": {
        const stepRun = lock.steps[move.position];
        if (stepRun === undefined) return { kind: "done" };
        const ended = await endAgentStep(lock, stepRun, pre);
        if (typeof ended === "object") return ended;
        return ended === "ended" ? { kind: "again" } : { kind: "done" };
      }
      case "cancel_job": {
        const stepRun = lock.steps[move.position];
        if (stepRun?.jobId == null) return { kind: "done" };
        // A turn that is over already ends its step (as it would for any run); one that runs is asked to stop once the lock is released.
        const ended = await endAgentStep(lock, stepRun, pre);
        if (typeof ended === "object") return ended;
        return ended === "ended"
          ? { kind: "again" }
          : { kind: "cancel_job", jobId: stepRun.jobId };
      }
      case "skip_step": {
        const stepRun = lock.steps[move.position];
        if (stepRun === undefined) return { kind: "done" };
        await lock.finishStep(stepRun.id, { status: "skipped" });
        return { kind: "again" };
      }
      case "fail_step": {
        const stepRun = lock.steps[move.position];
        if (stepRun === undefined) return { kind: "done" };
        // A step is never given up while its turn exists: the claimant may have died between the start of the turn and the record of
        // it, and a turn nobody reads would run on and count in no budget. The turn is attached, and the next move reads it.
        if (move.code === "agent_start_failed" || move.code === "cancelled") {
          // What was read before the lock is used as it is: a lookup here would take a second connection while the lock holds one,
          // and parallel claimants would starve the pool.
          if (!pre.started.has(stepRun.id))
            return {
              kind: "fetch",
              read: async (into) => {
                into.started.set(
                  stepRun.id,
                  await deps.turns.findByRequest(requestIdOf(run, stepRun)),
                );
              },
            };
          const found = pre.started.get(stepRun.id);
          if (
            found !== undefined &&
            (await lock.attachTurn(stepRun.id, {
              jobId: found.jobId,
              turnId: found.turnId,
            }))
          ) {
            log(
              `[workflow-runs] turn adopted run=${run.id} step=${stepRun.stepId}`,
            );
            return { kind: "again" };
          }
          // A step that waited behind a turn of its session has its instruction queued there. Given up, it must not start later with
          // no step to read it and no budget behind it: the instruction is discarded first, and the turn it may have started in that
          // moment is looked for again.
          const node = nodesById(document).get(stepRun.stepId);
          const target =
            found === undefined && node !== undefined
              ? continuedStep(node, lock.steps, stepRun.position)
              : undefined;
          if (target !== undefined && !pre.discarded.has(stepRun.id))
            return {
              kind: "fetch",
              read: async (into) => {
                await discardQueuedInstruction(run, stepRun, target);
                into.started.set(
                  stepRun.id,
                  await deps.turns.findByRequest(requestIdOf(run, stepRun)),
                );
                into.discarded.add(stepRun.id);
              },
            };
        }
        await lock.finishStep(
          stepRun.id,
          failed(
            move.code,
            move.code === "action_interrupted"
              ? "The engine was interrupted while the action ran; whether it happened is not known, so it was not repeated."
              : move.code === "cancelled"
                ? "The run was stopped before the turn of this step started."
                : "The turn of this step could not be started.",
          ),
        );
        return { kind: "again" };
      }
    }
  }

  /**
   * The account that owns a run a label started: the author of the workflow version the run uses. Saving the workflow again makes a
   * new version, so whoever saves it takes over the runs that start afterwards.
   */
  async function workflowOwner(
    run: StoredWorkflowRun,
  ): Promise<string | undefined> {
    return (
      await deps.workflows.getVersion(run.workflowId, run.workflowVersion)
    )?.createdBy;
  }

  /** Whether the account that owns the workflow of a run is still a member of the workspace. */
  async function ownerIsMember(run: StoredWorkflowRun): Promise<boolean> {
    const owner = await workflowOwner(run);
    return owner !== undefined && (await deps.members.get(owner)) !== undefined;
  }

  /**
   * The account an agent step's session belongs to, and the login its job shows. A run started by hand belongs to the person who
   * started it. A run a label started has no person (`created_by` is null); its turns belong to the account that owns the workflow,
   * the author of the version the run uses, and their job shows the login of whoever put the label on: the Implementer records the
   * creator of a session for the Runs page, and decides nothing by it.
   */
  async function sessionOwner(
    run: StoredWorkflowRun,
  ): Promise<
    { id: string; githubLogin: string } | { missing: "account" | "membership" }
  > {
    if (run.createdBy !== null)
      return { id: run.createdBy, githubLogin: run.actorLogin };
    const owner = await workflowOwner(run);
    if (owner === undefined) return { missing: "account" };
    // The owner may have left after the run began (the check at its start is for the first step only).
    if ((await deps.members.get(owner)) === undefined)
      return { missing: "membership" };
    return { id: owner, githubLogin: run.actorLogin };
  }

  /** Takes the instruction a waiting step queued out of the session it was queued in (the session of `target`, a step that ended). */
  async function discardQueuedInstruction(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    target: StoredStepRun,
  ): Promise<void> {
    const read =
      target.jobId === null ? undefined : await deps.turns.read(target.jobId);
    if (read?.ended === undefined) return;
    await deps.implementer.discardRequested(
      read.ended.session.id,
      requestIdOf(run, step),
    );
  }

  /** What starting an agent step came to: a turn (its job), an instruction that waits behind a running turn, or the end of the step. */
  type Begun = { runId: string } | { queued: true } | { outcome: StepOutcome };

  /** A turn in a session of its own: the profile, the environment and the instruction of the step, on a branch the platform names. */
  async function beginSession(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    node: RunDocument["steps"][number],
    values: RunValues,
    context: RoundContext,
    profile: { name: string; version: number },
  ): Promise<Begun> {
    const environmentName =
      typeof node.environment === "string" ? node.environment : "";
    const environment = (await deps.environments.listSummaries()).find(
      (candidate) =>
        candidate.name.toLowerCase() === environmentName.toLowerCase(),
    );
    if (environment === undefined)
      return {
        outcome: failed(
          "environment_not_found",
          "The environment of this step is not one of the workspace.",
        ),
      };
    // The instruction is built from the values of earlier steps. They are text in it and nothing else: the profile, the environment,
    // the repository and the branch are not.
    const instruction = renderText(
      instructionOf(node, context),
      values,
      INSTRUCTION_MAX_LENGTH,
    );
    // The base of the session is always the run's: the branch the work is compared with and merged into. The branch the session starts
    // from is the step's own (`branch`, a target the validator held to a literal, a trigger value or the branch of an earlier agent
    // step), else the tip of the base (#909).
    const start =
      node.branch === undefined
        ? undefined
        : startBranchOf(node.branch, values);
    if (typeof start === "object") return { outcome: start };
    const owner = await sessionOwner(run);
    if ("missing" in owner)
      return { outcome: failed("agent_start_failed", ownerMissingText(owner)) };
    try {
      const started = await deps.implementer.startTask(
        owner,
        {
          repositoryId: run.repositoryId,
          baseBranch: run.baseBranch,
          ...(start === undefined ? {} : { startBranch: start }),
          branch: sessionBranchOf(run, step),
          instruction,
          environmentId: environment.id,
          profile: `${profile.name}@${profile.version}`,
          ...(node.result === undefined ? {} : { result: node.result }),
          clientRequestId: requestIdOf(run, step),
        },
        { costCapCents: capCents(step.capMicroUsd) },
      );
      return { runId: started.runId };
    } catch (error) {
      return resolvedStartFailure(error, run, step);
    }
  }

  /**
   * The next turn of a session an earlier run of a step started (`session.continue`): the Implementer's follow-up, the same path as the
   * "Continue" form. It refuses a second turn while one runs (the instruction is queued, one at most). The turn keeps the model, the
   * environment, the profile and the result schema of the session's last turn; only the cost limit is held to what is left of the budget.
   */
  async function continueSessionOf(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    node: RunDocument["steps"][number],
    values: RunValues,
    context: RoundContext,
    target: StoredStepRun,
    byId: ReadonlyMap<string, RunDocument["steps"][number]>,
  ): Promise<Begun> {
    // A session keeps the result schema of its last turn, so a step that goes on in another step's session must ask for the same result.
    if (
      target.stepId !== node.id &&
      canonicalJson(node.result ?? null) !==
        canonicalJson(byId.get(target.stepId)?.result ?? null)
    )
      return {
        outcome: failed(
          "agent_start_failed",
          "This step goes on in the session of another step, and a session keeps the result of its last turn: both steps must declare the same result.",
        ),
      };
    const instruction = renderText(
      instructionOf(node, context),
      values,
      INSTRUCTION_MAX_LENGTH,
    );
    const read =
      target.jobId === null ? undefined : await deps.turns.read(target.jobId);
    if (read?.ended === undefined)
      return {
        outcome: failed(
          "turn_unreadable",
          "The session of the step to go on with cannot be read.",
        ),
      };
    const owner = await sessionOwner(run);
    if ("missing" in owner)
      return { outcome: failed("agent_start_failed", ownerMissingText(owner)) };
    try {
      const continued = await deps.implementer.continueSession(
        owner,
        read.ended.session.id,
        {
          instruction,
          clientRequestId: requestIdOf(run, step),
          costLimitCents: Math.max(
            1,
            Math.min(
              capCents(step.capMicroUsd),
              read.ended.turn.costLimitCents ?? Number.MAX_SAFE_INTEGER,
            ),
          ),
        },
      );
      return continued.runId === null
        ? { queued: true }
        : { runId: continued.runId };
    } catch (error) {
      // The session holds an instruction somebody else queued (the Continue form): this step waits its turn like one behind a running
      // turn, and asks again later, instead of failing. It is given up after `STEP_GIVE_UP_MS` like any step that cannot start.
      if (
        error instanceof ImplementerError &&
        error.code === "IMPLEMENTER_SESSION_BUSY"
      ) {
        const existing = await deps.turns.findByRequest(requestIdOf(run, step));
        if (existing !== undefined) return { runId: existing.jobId };
        return { queued: true };
      }
      return resolvedStartFailure(error, run, step);
    }
  }

  /** The Implementer refused: the step is about to be given up, not while a turn exists under its request id (a repeat of the request that no longer fits it). */
  async function resolvedStartFailure(
    error: unknown,
    run: StoredWorkflowRun,
    step: StoredStepRun,
  ): Promise<Begun> {
    if (!(error instanceof ImplementerError)) throw error;
    const existing = await deps.turns.findByRequest(requestIdOf(run, step));
    if (existing !== undefined) return { runId: existing.jobId };
    // The code and the message are for the log: the step keeps a sentence, and the code is its `errorCode`.
    log(
      `[workflow-runs] STEP_START_FAILED run=${run.id} step=${step.stepId} code=${error.code} message=${error.message}`,
    );
    return {
      outcome: failed("agent_start_failed", "The agent could not be started."),
    };
  }

  function ownerMissingText(owner: {
    missing: "account" | "membership";
  }): string {
    return owner.missing === "membership"
      ? WORKFLOW_OWNER_GONE_TEXT
      : "The workflow that started this run no longer has an account the turn can belong to.";
  }

  async function startAgent(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    node: RunDocument["steps"][number],
    values: RunValues,
    context: RoundContext,
    steps: readonly StoredStepRun[],
    byId: ReadonlyMap<string, RunDocument["steps"][number]>,
  ): Promise<StepOutcome | undefined> {
    if (step.profile === null)
      return failed("profile_not_found", "The step has no profile version.");
    const target = continuedStep(node, steps, step.position);
    const begun =
      target === undefined
        ? await beginSession(run, step, node, values, context, step.profile)
        : await continueSessionOf(
            run,
            step,
            node,
            values,
            context,
            target,
            byId,
          );
    if ("outcome" in begun) return begun.outcome;
    // An instruction behind a turn that still runs starts when that turn ends. The step stays as it is, claimed and without a job; a
    // later look repeats the request, which is the same one, and finds the turn once it exists.
    if ("queued" in begun) {
      log(
        `[workflow-runs] STEP_CONTINUE_QUEUED run=${run.id} step=${step.stepId}`,
      );
      return undefined;
    }
    const turn = await deps.turns.read(begun.runId);
    const attached = await deps.runs.attachTurn(step.id, {
      jobId: begun.runId,
      turnId: turn?.turnId ?? null,
    });
    // Somebody ended the step while the turn was started; the turn runs on, and no step reads it.
    if (!attached)
      log(
        `[workflow-runs] STEP_TURN_ORPHANED run=${run.id} step=${step.stepId} job=${begun.runId}`,
      );
    // #891: a stop that was asked for while the turn was being started could not find the job, which did not exist for the run yet. It is asked
    // now, so no turn runs on that no run wants: one a stopped run left without a step (it was not attached), or one that started after the stop.
    const current = await deps.runs.getRun(run.id);
    if (
      current === undefined ||
      current.cancelRequestedAt !== null ||
      current.status !== "running"
    ) {
      await deps.jobs.requestCancel(begun.runId);
      log(
        `[workflow-runs] STEP_TURN_CANCELLED run=${run.id} step=${step.stepId} job=${begun.runId}`,
      );
    }
    return undefined;
  }

  async function runAction(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    node: RunDocument["steps"][number],
    values: RunValues,
  ): Promise<StepOutcome> {
    const connectorName =
      typeof node.connector === "string" ? node.connector : "";
    const spec = specOf(connectorName);
    const connector = deps.connectors.get(connectorName);
    if (spec === undefined || connector === undefined)
      return failed(
        "connector_unavailable",
        `The action ${connectorName} is not available on this server yet.`,
      );
    let inputs;
    try {
      inputs = resolveActionInputs(node, spec, values);
    } catch (error) {
      if (error instanceof ActionInputError)
        return failed("action_input_invalid", error.message);
      throw error;
    }
    const fullName = await deps.repositoryName(run.repositoryId);
    if (fullName === undefined)
      return failed(
        "action_failed",
        "The repository of the run is no longer one of the workspace.",
      );
    try {
      const output = await withTimeout(
        (signal) =>
          connector.run({
            workspaceId: run.workspaceId,
            runId: run.id,
            stepId: step.stepId,
            repository: { id: run.repositoryId, fullName },
            baseBranch: run.baseBranch,
            inputs,
            idempotencyKey: requestIdOf(run, step),
            stepCreatedAt: step.createdAt,
            signal,
          }),
        deps.actionTimeoutMs ?? ACTION_TIMEOUT_MS,
      );
      return {
        status: "succeeded",
        output: JSON.stringify(isRecord(output) ? output : {}),
        costMicroUsd: null,
      };
    } catch (error) {
      if (error instanceof ActionTimeout)
        return failed(
          "action_timeout",
          connector.idempotent === true
            ? "The connector did not answer in time; whether the action happened is not known, so it was not repeated."
            : `The connector did not answer in time and the action was not repeated. ${MAY_HAVE_HAPPENED}`,
        );
      if (error instanceof ConnectorError)
        return failed(error.code, error.message);
      if (error instanceof ActionInputError)
        return failed("action_input_invalid", error.message);
      // Whatever else the connector threw is not for people to read: it goes to the log, the step keeps a sentence.
      log(
        `[workflow-runs] ACTION_FAILED run=${run.id} step=${step.stepId} connector=${connectorName} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return failed("action_failed", "The action failed.");
    }
  }

  /** Does what a pending step says. Whoever claims it does it; the others leave it alone. */
  async function execute(
    run: StoredWorkflowRun,
    stepRun: StoredStepRun,
    takeOver: boolean,
  ): Promise<void> {
    const claimed = await deps.runs.claimStep(
      stepRun.id,
      takeOver
        ? {
            staleBefore: new Date(
              now().getTime() - STEP_STALE_MS,
            ).toISOString(),
          }
        : undefined,
    );
    if (claimed === undefined) return;
    // #891: a stop that was asked for between the decision and the claim: the step does not start. Not a step of `onFailure` (#902): it
    // runs after the stop, or after a failure, and a stop asked for meanwhile changes neither.
    const current = await deps.runs.getRun(run.id);
    if (current?.cancelRequestedAt != null && current.failure === null) {
      await deps.runs.settleOwnStep(claimed.id, { status: "skipped" });
      return;
    }
    let outcome: StepOutcome | undefined;
    // The step whose session this one goes on in: its instruction may be queued there, whatever ends the step.
    let target: StoredStepRun | undefined;
    try {
      const document = await documentOf(run);
      const byId = document === undefined ? undefined : nodesById(document);
      const node = byId?.get(claimed.stepId);
      if (document === undefined || byId === undefined || node === undefined) {
        outcome = failed("turn_unreadable", "The step is not in the document.");
      } else {
        const steps = await deps.runs.listSteps(run.id);
        // Where in its loop the step is, from the rows: its round, and the rows of the round before that `previous.*` reads.
        const context = contextOf(
          machineNodes(document.steps),
          machineNodes(document.onFailure),
          machineStepsOf(steps),
          claimed.position,
        );
        // The rows do not match the document (the machine found the same before it wrote this row): a guess at round one would run the
        // step with the wrong `previous` and the wrong instruction, so the run ends instead. A step of `onFailure` ends alone: the run
        // is over its failure already, and ends the way it was going to.
        if (context === undefined) {
          if (run.failure !== null) {
            outcome = failed(
              "turn_unreadable",
              "The step does not fit the document of the run.",
            );
          } else {
            await deps.runs.lockRun(run.id, async (lock) => {
              await lock.finishStep(
                claimed.id,
                failed(
                  "turn_unreadable",
                  "The step does not fit the document of the run.",
                ),
              );
              await lock.finishRun({
                status: "failed",
                errorCode: "document_unusable",
              });
            });
            log(
              `[workflow-runs] run failed run=${run.id} code=document_unusable`,
            );
            return;
          }
        } else {
          const values = valuesOf(run, steps, context);
          if (claimed.kind === "agent")
            target = continuedStep(node, steps, claimed.position);
          outcome =
            claimed.kind === "agent"
              ? await startAgent(
                  run,
                  claimed,
                  node,
                  values,
                  context,
                  steps,
                  byId,
                )
              : await runAction(run, claimed, node, values);
        }
      }
    } catch (error) {
      if (error instanceof TemplateError)
        outcome = failed(error.code, error.message);
      // Anything else is not the step's fault (the database or the platform failed): the claim is left as it is, the step is taken
      // over later, and an agent step started under its request id cannot start twice.
      else throw error;
    }
    if (outcome === undefined) return;
    // A step that ends here without a turn (the owner has left, the Implementer refused) may have its own instruction queued behind a
    // turn of the session it goes on in. It is discarded first: left there, the end of that turn would start it with no step to read it
    // and no budget behind it. A turn it started in that moment is the step's after all, as it is when the step is given up.
    if (outcome.status === "failed" && target !== undefined) {
      const started = await discardAndFindTurn(run, claimed, target);
      if (
        started !== undefined &&
        (await deps.runs.attachTurn(claimed.id, {
          jobId: started.jobId,
          turnId: started.turnId,
        }))
      ) {
        log(
          `[workflow-runs] turn adopted run=${run.id} step=${claimed.stepId}`,
        );
        return;
      }
    }
    await deps.runs.settleOwnStep(claimed.id, outcome);
  }

  /** Discards the instruction a waiting step queued, then looks once more for the turn it may have started before that. */
  async function discardAndFindTurn(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    target: StoredStepRun,
  ): Promise<RequestedTurn | undefined> {
    await discardQueuedInstruction(run, step, target);
    return deps.turns.findByRequest(requestIdOf(run, step));
  }

  async function advance(runId: string): Promise<void> {
    for (let moves = 0; moves < MOVES_PER_CALL_MAX; moves += 1) {
      let latest: StoredWorkflowRun | undefined;
      const pre = await prefetch(runId);
      let decision: Decision | undefined;
      for (let fetches = 0; ; fetches += 1) {
        decision = await deps.runs.lockRun(runId, async (lock) => {
          latest = lock.run;
          return decide(lock, pre);
        });
        if (decision?.kind !== "fetch") break;
        if (fetches >= FETCHES_PER_MOVE_MAX) {
          log(
            `[workflow-runs] FETCH_LIMIT run=${runId}: the move kept lacking a value, the sweep looks at the run again`,
          );
          return;
        }
        // Outside the lock: the connection of the decision is released, so this read takes any connection the pool has.
        await decision.read(pre);
      }
      if (decision === undefined || decision.kind === "done") return;
      if (decision.kind === "cancel_job") {
        // Outside the lock: the queue takes its own. A turn that was waiting ends at once and the run goes on; one that runs is told by its
        // next heartbeat, and its end reaches the engine like any end of a turn.
        const asked = await deps.jobs.requestCancel(decision.jobId);
        log(
          `[workflow-runs] cancel asked run=${runId} job=${decision.jobId} outcome=${asked.status}`,
        );
        if (
          asked.status === "requested" ||
          asked.status === "already_requested"
        )
          return;
        continue;
      }
      if (decision.kind === "execute" && latest !== undefined)
        await execute(latest, decision.stepRun, decision.takeOver);
    }
  }

  return {
    advance,
    async jobEnded(jobId) {
      try {
        const step = await deps.runs.findStepByJob(jobId);
        if (step === undefined) return;
        await advance(step.runId);
      } catch {
        // Nothing a database or a platform said is logged: a connection string can be in it. The sweep looks at the run again.
        log(`[workflow-runs] ENGINE_EVENT_FAILED job=${jobId}`);
      }
    },
  };
}
