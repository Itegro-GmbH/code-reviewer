// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the runs of the workflows of ONE workspace (the tables `workflow_runs` and `workflow_step_runs`; the factory takes the
// workspace id, see ../workspace-scope.ts). A run is one start of a saved workflow version; its steps are written one after the other,
// in the order the steps run. A row of another workspace is simply not there.
//
// What the engine needs from the database lives here: a start that is repeated with the same request id answers the first run
// (`createRun`), and every decision about the next step is made under a lock on the run row (`lockRun`), so two events for one run
// (a job that ended and the sweep that noticed it, two Workers reporting the same result) take turns and the second finds what the first
// did. Nothing here knows what a step means; the engine (src/workflow-runs/) decides, the repository stores.
import "server-only";
import { type Kysely, type Selectable } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { UNIQUE_VIOLATION, errorCode } from "../errors.ts";
import type {
  Database,
  WorkflowRunsTable,
  WorkflowStepRunsTable,
} from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

export type WorkflowRunStatus =
  "running" | "succeeded" | "failed" | "cancelled";
export type StepRunStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped";
/** `if` and `loop` are written by the engine when it decides them: the row holds the decision as its output (#846). */
export type StepRunKind = "agent" | "action" | "if" | "loop";
/**
 * What started a run: a person by hand (`manual`) or through the API (`api`), a label on a ticket (`ticket.labeled`; rows written before
 * #916 say `github.issueLabeled`, the same trigger under its old name), or one of the reserved kinds no engine starts yet (#845, #916).
 */
export type RunTriggerKind =
  | "manual"
  | "api"
  | "ticket.labeled"
  | "github.issueLabeled"
  | "pullRequest.pushed"
  | "schedule";
/**
 * Where the cost charged to a step comes from: the runner's figure, an estimate from the token counts, the cap the turn ran under, or
 * (#856) Claude Code's estimate for a turn on a customer device's login, which is not billed.
 */
export type StepCostBasis = "reported" | "estimated" | "limit" | "subscription";

export type StoredWorkflowRun = {
  id: string;
  workspaceId: string;
  workflowId: string;
  workflowVersion: number;
  repositoryId: string;
  baseBranch: string;
  /** The input of the trigger as JSON text. */
  triggerInput: string;
  status: WorkflowRunStatus;
  errorCode: string | null;
  budgetMicroUsd: number;
  spentMicroUsd: number;
  clientRequestId: string;
  triggerKind: RunTriggerKind;
  /** #916: the id of the trigger of the document that started the run; null for a run written before, found by the kind. */
  triggerId: string | null;
  /** The person who started the run by hand; null for a run a trigger started. */
  createdBy: string | null;
  /** The login the run acts as and shows: the person who started it, or who put the label on. Display only. */
  actorLogin: string;
  /** #891: when a member asked for the run to stop; null when nobody did. The run stays `running` until its turn has ended. */
  cancelRequestedAt: string | null;
  /**
   * #902: how the run ends and why, as JSON text, once the steps of `onFailure` have begun; null before, and for a workflow without them.
   * The run stays `running` until they are over.
   */
  failure: string | null;
  /** #923: the ticket the run is about (`github:owner/repo#128`); null when it is about none. */
  ticketRef: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type StoredStepRun = {
  id: string;
  runId: string;
  workspaceId: string;
  position: number;
  stepId: string;
  kind: StepRunKind;
  status: StepRunStatus;
  /** How often the step has run in the run, from 1: the rounds of a loop. */
  round: number;
  profile: { name: string; version: number } | null;
  jobId: string | null;
  turnId: string | null;
  capMicroUsd: number | null;
  costMicroUsd: number | null;
  /** Where `costMicroUsd` comes from; null when the step was charged nothing (an action) or ended before this was kept. */
  costBasis: StepCostBasis | null;
  /** JSON text: the values later steps refer to. */
  output: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type NewWorkflowRun = {
  workflowId: string;
  workflowVersion: number;
  repositoryId: string;
  baseBranch: string;
  triggerInput: string;
  budgetMicroUsd: number;
  clientRequestId: string;
  /** Left out: `manual`. */
  triggerKind?: RunTriggerKind;
  /** #916: the id of the trigger of the document that starts the run. */
  triggerId?: string;
  /** Needed for `manual` and `api`, null for a run a trigger started (the database holds that rule). */
  createdBy: string | null;
  actorLogin: string;
  /**
   * What a trigger started the run for. A workflow has at most one `running` run for one key: a start for a key that is taken answers
   * `busy` with the run that holds it. Left out for a run by hand.
   */
  triggerKey?: string;
  /** #923: the ticket the run is about (`github:owner/repo#128`); left out for a run that is about none. */
  ticketRef?: string;
};

/** What the runs of one ticket add up to (#923): the money they spent and the run that is going on for it, if one is. */
export type TicketRunSummary = {
  ticketRef: string;
  /** The sum of `spentMicroUsd` over every run of the ticket, whatever its status. */
  spentMicroUsd: number;
  /** The newest `running` run of the ticket; null when none is running. */
  activeRun: {
    runId: string;
    /** The name of the workflow: the lane. */
    workflowName: string;
    /** The step that runs now, or the next one that waits; null before the first step is written. */
    stepId: string | null;
    status: WorkflowRunStatus;
  } | null;
};

export type CreateRunOutcome =
  | { status: "created"; run: StoredWorkflowRun }
  | { status: "existing"; run: StoredWorkflowRun }
  /** The key of the start is held by a running run of the workflow (`run`); nothing was written. */
  | { status: "busy"; run: StoredWorkflowRun };

export type NewStepRun = {
  position: number;
  stepId: string;
  kind: StepRunKind;
  /** How often the step has run in the run, counting this time (1 for its first). */
  round: number;
  profile: { name: string; version: number } | null;
  capMicroUsd: number | null;
};

/** A step that is over when it is written: a decision of a control step, or a step in a branch that was not taken. */
export type NewFinishedStep = {
  position: number;
  stepId: string;
  kind: StepRunKind;
  round: number;
  status: "succeeded" | "skipped";
  /** JSON text: what a control step decided; null for a skipped step. */
  output: string | null;
};

export type StepOutcome =
  /** #891: the step did not run because the run was stopped; it ends without an output, a cost or a code. */
  | { status: "skipped" }
  | {
      status: "succeeded";
      output: string | null;
      costMicroUsd: number | null;
      costBasis?: StepCostBasis | null;
    }
  | {
      status: "failed";
      errorCode: string;
      errorMessage: string | null;
      output?: string | null;
      costMicroUsd?: number | null;
      costBasis?: StepCostBasis | null;
    };

/** The run, held under a lock until `lockRun`'s callback returns. Everything it does is part of one transaction. */
export type RunLock = {
  run: StoredWorkflowRun;
  /** The steps written so far, by position. */
  steps: StoredStepRun[];
  addStep(input: NewStepRun): Promise<StoredStepRun>;
  /** Writes steps that are over at once (one write, one touch): the decision of an `if` with the steps it skips, or the end of a `loop`. */
  addFinished(inputs: readonly NewFinishedStep[]): Promise<StoredStepRun[]>;
  /**
   * Records a turn found for a step under the lock: the step then reads that turn instead of being given up. Only a `running` step
   * without a job takes one; returns whether it was written.
   */
  attachTurn(
    stepRunId: string,
    turn: { jobId: string; turnId: string | null },
  ): Promise<boolean>;
  /** Ends a step that is not over yet; the money it cost is added to the run. */
  finishStep(stepRunId: string, outcome: StepOutcome): Promise<void>;
  finishRun(outcome: {
    status: "succeeded" | "failed" | "cancelled";
    errorCode: string | null;
  }): Promise<void>;
  /**
   * #891: marks the run as one a member asked to stop, unless that was done before. Returns whether this call set it. A run that is over is
   * not marked.
   */
  requestCancel(): Promise<boolean>;
  /**
   * #902: stores how the run ends (`failure`, JSON text) and keeps it `running`, unless that was done before. Returns whether this call stored
   * it. A run that is over takes none.
   */
  beginFailure(failure: string): Promise<boolean>;
  /** Marks the run as looked at without changing anything else: the sweep takes the runs that waited longest first. */
  touch(): Promise<void>;
};

export type WorkflowRunsRepository = {
  /**
   * Writes the run, or answers the run that this request id made before (`existing`), or, for a start with a trigger key, the running
   * run of the workflow that holds the key (`busy`). The caller compares the body.
   */
  createRun(input: NewWorkflowRun): Promise<CreateRunOutcome>;
  getRun(id: string): Promise<StoredWorkflowRun | undefined>;
  /** The run a client request id made, or undefined. */
  findByRequest(
    clientRequestId: string,
  ): Promise<StoredWorkflowRun | undefined>;
  /** The runs of one workflow, newest first. */
  listRuns(workflowId: string, limit: number): Promise<StoredWorkflowRun[]>;
  /**
   * What the runs of each of these tickets (`github:owner/repo#128`) add up to (#923); a ticket without a run is not in the answer.
   * Read at the moment of the question, never stored.
   */
  summarizeTickets(ticketRefs: readonly string[]): Promise<TicketRunSummary[]>;
  listSteps(runId: string): Promise<StoredStepRun[]>;
  /** The step an Implementer job belongs to, if a workflow started it. */
  findStepByJob(jobId: string): Promise<StoredStepRun | undefined>;
  /**
   * Runs `work` with the run's row locked, or answers `undefined` when the run is not this workspace's. Two callers for one run take
   * turns; what the first wrote is what the second reads.
   */
  lockRun<T>(
    runId: string,
    work: (lock: RunLock) => Promise<T>,
  ): Promise<T | undefined>;
  /**
   * Takes the right to do what a step says: a `pending` step becomes `running`; with `staleBefore`, a `running` step with no job whose
   * claim is older than that is taken over too (the one that held it did not finish). Returns the step, or undefined when somebody else
   * has it.
   */
  claimStep(
    stepRunId: string,
    options?: { staleBefore?: string },
  ): Promise<StoredStepRun | undefined>;
  /** Records the turn an agent step started. Only a `running` step without a job takes one; returns whether it was written. */
  attachTurn(
    stepRunId: string,
    turn: { jobId: string; turnId: string | null },
  ): Promise<boolean>;
  /** Ends a step that is `running` and has no job (an action, or an agent step that could not be started); returns whether it was written. */
  settleOwnStep(stepRunId: string, outcome: StepOutcome): Promise<boolean>;
};

function runFrom(row: Selectable<WorkflowRunsTable>): StoredWorkflowRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    repositoryId: row.repository_id,
    baseBranch: row.base_branch,
    triggerInput: row.trigger_input,
    status: row.status as WorkflowRunStatus,
    errorCode: row.error_code,
    budgetMicroUsd: row.budget_micro_usd,
    spentMicroUsd: row.spent_micro_usd,
    clientRequestId: row.client_request_id,
    triggerKind: row.trigger_kind as RunTriggerKind,
    triggerId: row.trigger_id,
    createdBy: row.created_by,
    actorLogin: row.actor_login,
    cancelRequestedAt: row.cancel_requested_at,
    failure: row.failure,
    ticketRef: row.ticket_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function stepFrom(row: Selectable<WorkflowStepRunsTable>): StoredStepRun {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    position: row.position,
    stepId: row.step_id,
    kind: row.kind as StepRunKind,
    status: row.status as StepRunStatus,
    round: row.round,
    profile:
      row.profile_name === null || row.profile_version === null
        ? null
        : { name: row.profile_name, version: row.profile_version },
    jobId: row.job_id,
    turnId: row.turn_id,
    capMicroUsd: row.cap_micro_usd,
    costMicroUsd: row.cost_micro_usd,
    costBasis: row.cost_basis as StepCostBasis | null,
    output: row.output,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createWorkflowRunsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  options: { now?: () => Date; newId?: () => string } = {},
): WorkflowRunsRepository {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());

  const inTransaction = <T>(
    run: (trx: Kysely<Database>) => Promise<T>,
  ): Promise<T> => (db.isTransaction ? run(db) : db.transaction().execute(run));

  const stepsOf = async (
    executor: Kysely<Database>,
    runId: string,
  ): Promise<StoredStepRun[]> =>
    (
      await executor
        .selectFrom("workflow_step_runs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("run_id", "=", runId)
        .orderBy("position")
        .execute()
    ).map(stepFrom);

  const selectRun = (executor: Kysely<Database>, id: string) =>
    executor
      .selectFrom("workflow_runs")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id);

  /** The columns an outcome sets on a step that ends. */
  const endValues = (outcome: StepOutcome, at: string) => {
    if (outcome.status === "skipped")
      return {
        status: "skipped",
        output: null,
        cost_micro_usd: null,
        cost_basis: null,
        error_code: null,
        error_message: null,
        finished_at: at,
      };
    return {
      status: outcome.status,
      output: outcome.output ?? null,
      cost_micro_usd: outcome.costMicroUsd ?? null,
      // The check of the table: a basis needs a cost.
      cost_basis:
        outcome.costMicroUsd === undefined || outcome.costMicroUsd === null
          ? null
          : (outcome.costBasis ?? null),
      error_code: outcome.status === "failed" ? outcome.errorCode : null,
      error_message: outcome.status === "failed" ? outcome.errorMessage : null,
      finished_at: at,
    };
  };

  return {
    async createRun(input) {
      const at = formatTimestamp(now());
      const row = {
        id: newId(),
        workspace_id: workspaceId,
        workflow_id: input.workflowId,
        workflow_version: input.workflowVersion,
        repository_id: input.repositoryId,
        base_branch: input.baseBranch,
        trigger_input: input.triggerInput,
        status: "running",
        error_code: null,
        budget_micro_usd: input.budgetMicroUsd,
        client_request_id: input.clientRequestId,
        trigger_kind: input.triggerKind ?? "manual",
        trigger_id: input.triggerId ?? null,
        trigger_key: input.triggerKey ?? null,
        created_by: input.createdBy,
        actor_login: input.actorLogin,
        cancel_requested_at: null,
        failure: null,
        ticket_ref: input.ticketRef ?? null,
        created_at: at,
        updated_at: at,
        finished_at: null,
      };
      try {
        await db.insertInto("workflow_runs").values(row).execute();
      } catch (error) {
        if (errorCode(error) !== UNIQUE_VIOLATION) throw error;
        const earlier = await db
          .selectFrom("workflow_runs")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("client_request_id", "=", input.clientRequestId)
          .executeTakeFirst();
        if (earlier !== undefined)
          return { status: "existing", run: runFrom(earlier) };
        // Not the request id: the key is held (the one index that is left). Which of the two indexes reports first when both are
        // violated is not defined, so the request id is looked at first: a retry of the start finds its own run, never `busy`.
        const holder =
          input.triggerKey === undefined
            ? undefined
            : await db
                .selectFrom("workflow_runs")
                .selectAll()
                .where("workspace_id", "=", workspaceId)
                .where("workflow_id", "=", input.workflowId)
                .where("trigger_key", "=", input.triggerKey)
                .where("status", "=", "running")
                .executeTakeFirst();
        if (holder === undefined) throw error;
        return { status: "busy", run: runFrom(holder) };
      }
      const created = await selectRun(db, row.id).executeTakeFirstOrThrow();
      return { status: "created", run: runFrom(created) };
    },

    async getRun(id) {
      const row = await selectRun(db, id).executeTakeFirst();
      return row === undefined ? undefined : runFrom(row);
    },

    async findByRequest(clientRequestId) {
      const row = await db
        .selectFrom("workflow_runs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("client_request_id", "=", clientRequestId)
        .executeTakeFirst();
      return row === undefined ? undefined : runFrom(row);
    },

    async listRuns(workflowId, limit) {
      const rows = await db
        .selectFrom("workflow_runs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("workflow_id", "=", workflowId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(runFrom);
    },

    async summarizeTickets(ticketRefs) {
      if (ticketRefs.length === 0) return [];
      const runs = await db
        .selectFrom("workflow_runs")
        .select([
          "id",
          "ticket_ref",
          "workflow_id",
          "status",
          "spent_micro_usd",
          "created_at",
        ])
        .where("workspace_id", "=", workspaceId)
        .where("ticket_ref", "in", [...ticketRefs])
        .execute();
      if (runs.length === 0) return [];
      const workflowIds = [...new Set(runs.map((run) => run.workflow_id))];
      const names = new Map(
        (
          await db
            .selectFrom("workflows")
            .select(["id", "name"])
            .where("workspace_id", "=", workspaceId)
            .where("id", "in", workflowIds)
            .execute()
        ).map((row) => [row.id, row.name]),
      );
      const running = runs.filter((run) => run.status === "running");
      const steps =
        running.length === 0
          ? []
          : await db
              .selectFrom("workflow_step_runs")
              .select(["run_id", "step_id", "status", "position"])
              .where("workspace_id", "=", workspaceId)
              .where(
                "run_id",
                "in",
                running.map((run) => run.id),
              )
              .where("status", "in", ["running", "pending"])
              .orderBy("position")
              .execute();
      const stepOf = (runId: string): string | null => {
        const own = steps.filter((step) => step.run_id === runId);
        return (
          (own.find((step) => step.status === "running") ?? own[0])?.step_id ??
          null
        );
      };
      const summaries = new Map<string, TicketRunSummary>();
      for (const run of runs) {
        const ref = run.ticket_ref as string;
        const summary = summaries.get(ref) ?? {
          ticketRef: ref,
          spentMicroUsd: 0,
          activeRun: null,
        };
        summary.spentMicroUsd += run.spent_micro_usd;
        summaries.set(ref, summary);
      }
      // The newest running run of a ticket is its active one.
      for (const run of [...running].sort((a, b) =>
        a.created_at < b.created_at ? 1 : -1,
      )) {
        const summary = summaries.get(run.ticket_ref as string);
        if (summary === undefined || summary.activeRun !== null) continue;
        summary.activeRun = {
          runId: run.id,
          workflowName: names.get(run.workflow_id) ?? "",
          stepId: stepOf(run.id),
          status: "running",
        };
      }
      return [...summaries.values()];
    },

    listSteps: (runId) => stepsOf(db, runId),

    async findStepByJob(jobId) {
      const row = await db
        .selectFrom("workflow_step_runs")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      return row === undefined ? undefined : stepFrom(row);
    },

    lockRun(runId, work) {
      return inTransaction(async (trx) => {
        const locked = await selectRun(trx, runId)
          .forUpdate()
          .executeTakeFirst();
        if (locked === undefined) return undefined;
        const lock: RunLock = {
          run: runFrom(locked),
          steps: await stepsOf(trx, runId),
          async addStep(input) {
            const row = {
              id: newId(),
              run_id: runId,
              workspace_id: workspaceId,
              position: input.position,
              step_id: input.stepId,
              kind: input.kind,
              status: "pending",
              round: input.round,
              profile_name: input.profile?.name ?? null,
              profile_version: input.profile?.version ?? null,
              job_id: null,
              turn_id: null,
              cap_micro_usd: input.capMicroUsd,
              cost_micro_usd: null,
              cost_basis: null,
              output: null,
              error_code: null,
              error_message: null,
              created_at: formatTimestamp(now()),
              started_at: null,
              finished_at: null,
            };
            await trx.insertInto("workflow_step_runs").values(row).execute();
            const added = stepFrom(
              await trx
                .selectFrom("workflow_step_runs")
                .selectAll()
                .where("id", "=", row.id)
                .executeTakeFirstOrThrow(),
            );
            lock.steps.push(added);
            await lock.touch();
            return added;
          },
          async addFinished(inputs) {
            if (inputs.length === 0) return [];
            const at = formatTimestamp(now());
            const rows = inputs.map((input) => ({
              id: newId(),
              run_id: runId,
              workspace_id: workspaceId,
              position: input.position,
              step_id: input.stepId,
              kind: input.kind,
              status: input.status,
              round: input.round,
              profile_name: null,
              profile_version: null,
              job_id: null,
              turn_id: null,
              cap_micro_usd: null,
              cost_micro_usd: null,
              cost_basis: null,
              output: input.output,
              error_code: null,
              error_message: null,
              created_at: at,
              started_at: null,
              finished_at: at,
            }));
            const written = (
              await trx
                .insertInto("workflow_step_runs")
                .values(rows)
                .returningAll()
                .execute()
            )
              .map(stepFrom)
              .toSorted((a, b) => a.position - b.position);
            lock.steps.push(...written);
            await lock.touch();
            return written;
          },
          async attachTurn(stepRunId, turn) {
            const attached = await trx
              .updateTable("workflow_step_runs")
              .set({ job_id: turn.jobId, turn_id: turn.turnId })
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", stepRunId)
              .where("status", "=", "running")
              .where("job_id", "is", null)
              .returningAll()
              .executeTakeFirst();
            if (attached === undefined) return false;
            const index = lock.steps.findIndex((step) => step.id === stepRunId);
            if (index !== -1) lock.steps[index] = stepFrom(attached);
            await lock.touch();
            return true;
          },
          async finishStep(stepRunId, outcome) {
            const at = formatTimestamp(now());
            const ended = await trx
              .updateTable("workflow_step_runs")
              .set(endValues(outcome, at))
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", stepRunId)
              .where("status", "in", ["pending", "running"])
              .returningAll()
              .executeTakeFirst();
            if (ended === undefined) return;
            const index = lock.steps.findIndex((step) => step.id === stepRunId);
            if (index !== -1) lock.steps[index] = stepFrom(ended);
            const cost =
              outcome.status === "skipped" ? 0 : (outcome.costMicroUsd ?? 0);
            if (cost > 0) {
              const spent = await trx
                .updateTable("workflow_runs")
                .set((eb) => ({
                  spent_micro_usd: eb("spent_micro_usd", "+", cost),
                  updated_at: at,
                }))
                .where("workspace_id", "=", workspaceId)
                .where("id", "=", runId)
                .returning("spent_micro_usd")
                .executeTakeFirstOrThrow();
              lock.run = { ...lock.run, spentMicroUsd: spent.spent_micro_usd };
            } else await lock.touch();
          },
          async finishRun(outcome) {
            const at = formatTimestamp(now());
            await trx
              .updateTable("workflow_runs")
              .set({
                status: outcome.status,
                error_code: outcome.errorCode,
                finished_at: at,
                updated_at: at,
              })
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", runId)
              .where("status", "=", "running")
              .execute();
            lock.run = {
              ...lock.run,
              status: outcome.status,
              errorCode: outcome.errorCode,
              finishedAt: at,
              updatedAt: at,
            };
          },
          async requestCancel() {
            const at = formatTimestamp(now());
            const marked = await trx
              .updateTable("workflow_runs")
              .set({ cancel_requested_at: at, updated_at: at })
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", runId)
              .where("status", "=", "running")
              .where("cancel_requested_at", "is", null)
              .returning("id")
              .executeTakeFirst();
            if (marked === undefined) return false;
            lock.run = { ...lock.run, cancelRequestedAt: at, updatedAt: at };
            return true;
          },
          async beginFailure(failure) {
            const at = formatTimestamp(now());
            const stored = await trx
              .updateTable("workflow_runs")
              .set({ failure, updated_at: at })
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", runId)
              .where("status", "=", "running")
              .where("failure", "is", null)
              .returning("id")
              .executeTakeFirst();
            if (stored === undefined) return false;
            lock.run = { ...lock.run, failure, updatedAt: at };
            return true;
          },
          async touch() {
            const at = formatTimestamp(now());
            await trx
              .updateTable("workflow_runs")
              .set({ updated_at: at })
              .where("workspace_id", "=", workspaceId)
              .where("id", "=", runId)
              .execute();
            lock.run = { ...lock.run, updatedAt: at };
          },
        };
        return work(lock);
      });
    },

    async claimStep(stepRunId, claim = {}) {
      const at = formatTimestamp(now());
      const taken = await db
        .updateTable("workflow_step_runs")
        .set({ status: "running", started_at: at })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", stepRunId)
        .where((eb) =>
          claim.staleBefore === undefined
            ? eb("status", "=", "pending")
            : eb.or([
                eb("status", "=", "pending"),
                eb.and([
                  eb("status", "=", "running"),
                  eb("job_id", "is", null),
                  eb("started_at", "<", claim.staleBefore),
                ]),
              ]),
        )
        .returningAll()
        .executeTakeFirst();
      return taken === undefined ? undefined : stepFrom(taken);
    },

    async attachTurn(stepRunId, turn) {
      const result = await db
        .updateTable("workflow_step_runs")
        .set({ job_id: turn.jobId, turn_id: turn.turnId })
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", stepRunId)
        .where("status", "=", "running")
        .where("job_id", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async settleOwnStep(stepRunId, outcome) {
      const result = await db
        .updateTable("workflow_step_runs")
        .set(endValues(outcome, formatTimestamp(now())))
        .where("workspace_id", "=", workspaceId)
        .where("id", "=", stepRunId)
        .where("status", "=", "running")
        .where("job_id", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },
  };
}
