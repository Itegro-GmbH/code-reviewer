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
import { ImplementerError } from "../implementer/errors.ts";
import type { ImplementerService } from "../implementer/service.ts";
import { INSTRUCTION_MAX_LENGTH } from "../implementer/start-input.ts";
import { isRecord } from "../workflows/json.ts";
import { parseProfileRef } from "../workflows/resolver.ts";
import {
  ActionInputError,
  resolveActionInputs,
  specOf,
  type ConnectorRegistry,
} from "./connectors.ts";
import { readRunDocument, type RunDocument } from "./document.ts";
import {
  ACTION_TIMEOUT_MS,
  ERROR_MESSAGE_MAX_CHARS,
  MICRO_USD_COLUMN_MAX,
  MICRO_USD_PER_CENT,
  MOVES_PER_CALL_MAX,
  STEP_GIVE_UP_MS,
  STEP_STALE_MS,
} from "./limits.ts";
import { nextMove, type MachineState } from "./machine.ts";
import { renderText, TemplateError, type RunValues } from "./templates.ts";
import { outcomeOfTurn, type EndedTurn } from "./turn-facts.ts";

/** A turn as the engine reads it: its id, and the whole of it once its job is over. */
export type TurnRead = { turnId: string; ended: EndedTurn | undefined };
/** A turn found by the request id it was started under. */
export type RequestedTurn = TurnRead & { jobId: string };

export type EngineDependencies = {
  runs: WorkflowRunsRepository;
  workflows: Pick<WorkflowsRepository, "getVersion">;
  profiles: Pick<ProfilesRepository, "findByName">;
  environments: Pick<ImplementerEnvironmentsRepository, "listSummaries">;
  implementer: Pick<ImplementerService, "startTask">;
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
  /** For an agent step with no job that has been claimed for a while: the turn its request id started, if any (by step id). */
  started: Map<string, RequestedTurn | undefined>;
  profiles: Map<string, Resolved>;
};

type Decision =
  | { kind: "done" }
  | { kind: "again" }
  | { kind: "execute"; stepRun: StoredStepRun; takeOver: boolean }
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
  extra: { costMicroUsd?: number } = {},
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

/** What a reference can reach: the input of the trigger and the output of every step that succeeded. */
function valuesOf(
  run: StoredWorkflowRun,
  steps: readonly StoredStepRun[],
): RunValues {
  const input = parseOutput(run.triggerInput);
  return {
    trigger: { input: isRecord(input) ? input : {} },
    steps: Object.fromEntries(
      steps.flatMap((step) =>
        step.status === "succeeded"
          ? [[step.stepId, parseOutput(step.output) ?? {}] as const]
          : [],
      ),
    ),
  };
}

/** The request id an agent step starts its turn under, and the idempotency key of an action: stable for the step of a run. */
const requestIdOf = (
  run: Pick<StoredWorkflowRun, "id">,
  step: Pick<StoredStepRun, "position">,
): string => `wf-${run.id}-${step.position}`;

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
    return version === undefined
      ? undefined
      : readRunDocument(version.document);
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
    if (outcome.costBasis !== "reported")
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
          }
        : failed(outcome.code, outcome.message, { costMicroUsd: cost }),
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
      const next = document.steps[steps.length];
      if (
        (last === undefined || last.status === "succeeded") &&
        next?.kind === "agent" &&
        typeof next.profile === "string"
      )
        pre.profiles.set(next.profile, await resolveProfile(next));
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
    const state: MachineState = {
      runStatus: run.status,
      budgetMicroUsd: run.budgetMicroUsd,
      spentMicroUsd: run.spentMicroUsd,
      steps: lock.steps.map((step) => ({
        status: step.status,
        kind: step.kind,
        hasJob: step.jobId !== null,
        createdAt: step.createdAt,
        startedAt: step.startedAt,
      })),
      nodes: document.steps.map((node) => node.kind),
      now: now(),
      staleMs: STEP_STALE_MS,
      giveUpMs: STEP_GIVE_UP_MS,
    };
    const move = nextMove(state);
    switch (move.move) {
      case "idle":
        return { kind: "done" };
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
        const node = document.steps[move.position];
        if (node === undefined) return { kind: "done" };
        const ref = node.profile;
        if (
          move.kind === "agent" &&
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
            : typeof ref === "string"
              ? pre.profiles.get(ref)
              : undefined;
        const stepRun = await lock.addStep({
          position: move.position,
          stepId: node.id,
          kind: move.kind,
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
      case "fail_step": {
        const stepRun = lock.steps[move.position];
        if (stepRun === undefined) return { kind: "done" };
        // A step is never given up while its turn exists: the claimant may have died between the start of the turn and the record of
        // it, and a turn nobody reads would run on and count in no budget. The turn is attached, and the next move reads it.
        if (move.code === "agent_start_failed") {
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
        }
        await lock.finishStep(
          stepRun.id,
          failed(
            move.code,
            move.code === "action_interrupted"
              ? "The engine was interrupted while the action ran; whether it happened is not known, so it was not repeated."
              : "The turn of this step could not be started.",
          ),
        );
        return { kind: "again" };
      }
    }
  }

  async function startAgent(
    run: StoredWorkflowRun,
    step: StoredStepRun,
    node: RunDocument["steps"][number],
    values: RunValues,
  ): Promise<StepOutcome | undefined> {
    if (step.profile === null)
      return failed("profile_not_found", "The step has no profile version.");
    const environmentName =
      typeof node.environment === "string" ? node.environment : "";
    const environment = (await deps.environments.listSummaries()).find(
      (candidate) =>
        candidate.name.toLowerCase() === environmentName.toLowerCase(),
    );
    if (environment === undefined)
      return failed(
        "environment_not_found",
        "The environment of this step is not one of the workspace.",
      );
    // The instruction is built from the values of earlier steps. They are text in it and nothing else: the profile, the environment,
    // the repository and the branch are not.
    const text =
      typeof node.instruction === "string"
        ? node.instruction
        : isRecord(node.instruction) &&
            typeof node.instruction.first === "string"
          ? node.instruction.first
          : "";
    const instruction = renderText(text, values, INSTRUCTION_MAX_LENGTH);
    let started: { runId: string };
    try {
      started = await deps.implementer.startTask(
        { id: run.createdBy, githubLogin: run.actorLogin },
        {
          repositoryId: run.repositoryId,
          baseBranch: run.baseBranch,
          // One branch for each step of each run: nothing else can hold the name.
          branch: `workflow/${run.id}/${step.stepId}`,
          instruction,
          environmentId: environment.id,
          profile: `${step.profile.name}@${step.profile.version}`,
          ...(node.result === undefined ? {} : { result: node.result }),
          clientRequestId: requestIdOf(run, step),
        },
        { costCapCents: capCents(step.capMicroUsd) },
      );
    } catch (error) {
      if (!(error instanceof ImplementerError)) throw error;
      // The step is about to be given up: not while a turn exists under its request id (a repeat of the request that no longer fits it).
      const existing = await deps.turns.findByRequest(requestIdOf(run, step));
      if (existing === undefined)
        return failed("agent_start_failed", `${error.code}: ${error.message}`);
      started = { runId: existing.jobId };
    }
    const turn = await deps.turns.read(started.runId);
    const attached = await deps.runs.attachTurn(step.id, {
      jobId: started.runId,
      turnId: turn?.turnId ?? null,
    });
    // Somebody ended the step while the turn was started; the turn runs on, and no step reads it.
    if (!attached)
      log(
        `[workflow-runs] STEP_TURN_ORPHANED run=${run.id} step=${step.stepId} job=${started.runId}`,
      );
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
            inputs,
            idempotencyKey: requestIdOf(run, step),
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
          "The connector did not answer in time; whether the action happened is not known, so it was not repeated.",
        );
      return failed(
        "action_failed",
        error instanceof Error ? error.message : "The connector failed.",
      );
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
    let outcome: StepOutcome | undefined;
    try {
      const document = await documentOf(run);
      const node = document?.steps[claimed.position];
      if (node === undefined) {
        outcome = failed("turn_unreadable", "The step is not in the document.");
      } else {
        const values = valuesOf(run, await deps.runs.listSteps(run.id));
        outcome =
          claimed.kind === "agent"
            ? await startAgent(run, claimed, node, values)
            : await runAction(run, claimed, node, values);
      }
    } catch (error) {
      if (error instanceof TemplateError)
        outcome = failed(error.code, error.message);
      // Anything else is not the step's fault (the database or the platform failed): the claim is left as it is, the step is taken
      // over later, and an agent step started under its request id cannot start twice.
      else throw error;
    }
    if (outcome !== undefined)
      await deps.runs.settleOwnStep(claimed.id, outcome);
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
