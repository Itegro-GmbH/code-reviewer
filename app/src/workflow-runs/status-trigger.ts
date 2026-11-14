// SPDX-License-Identifier: LicenseRef-Proprietary

// The status trigger (#1036, sub-issue 2 of epic #1034): a ticket moved into a status starts the workflows of the workspace that wait for
// exactly this status. For GitHub the status is the Status of the project board; the webhook hands over the move (`projects_v2_item`,
// the Status field changed) once the ticket mirror has taken it, and this decides which workflows start and writes their runs. It serves
// ONE workspace.
//
//  - A workflow starts when one of its triggers is `ticket.statusChanged` with `to` equal to the new status (the board's spelling; case
//    counts, as it does for `ticket.setStatus`) and, when the trigger names a `from`, the old status equal to it; the ticket is an issue
//    the ticket mirror holds, in an active repository of the workspace, and the workflow is a lane of the active project whose ticket
//    source is that repository. A project that chose a board takes the moves of that board only (the mirror's rule); one that chose none
//    follows every board. A move that clears the status starts nothing. The run starts through that trigger; a workflow with two
//    triggers for one move starts once, through the first.
//  - Whoever made the move starts it (owner decision, 2026-11-14): there is NO guard against the factory's own status changes. The
//    login of the mover is kept as the run's `actor_login`, to be shown, and decides nothing. A lane that moves a ticket into its own
//    trigger status starts itself again once its run has ended; the validator warns (`status_retriggers_workflow`) and the docs say it.
//  - A delivery starts each workflow at most once (`gh-<delivery id>-<workflow id>`, as for a label), and a workflow has at most ONE
//    running run for one ticket (`triggerKey`, the key of the label trigger: the repository and the ticket's key), whichever trigger
//    started it. A second move into the status while the run goes on starts nothing; when the run has ended the next move starts the
//    next one. The database holds it (a partial unique index), so two deliveries that race for it write one run.
//  - The platform is asked only once a workflow matched, once for all of them: the ticket (the webhook of a board item carries none of
//    its fields) and the repository's default branch. The run's input is `{ ticket, status: { from, to } }`, stored bounded as the
//    run's `trigger_input`; the ticket is the same value a label trigger yields (`ticket.ts`).
import type {
  RunTriggerKind,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import {
  BUDGET_OPERATOR_MAX_USD,
  STATUS_NAME_MAX_LENGTH,
} from "../workflows/limits.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import {
  forTrigger,
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
} from "./document.ts";
import { ACTOR_LOGIN_MAX_CHARS, BRANCH_MAX_CHARS } from "./limits.ts";
import { bounded, ticketValue, type TicketValue } from "./ticket.ts";

/** What a run a status change started is recorded as. */
export const STATUS_TRIGGER_KIND =
  "ticket.statusChanged" satisfies RunTriggerKind;

/** The ticket as a platform read it: what `ticketValue` bounds. */
export type StatusTicket = Parameters<typeof ticketValue>[0];

/** An item of a project board that got another status, as the webhook of the platform says it. */
export type BoardMove = {
  /** The platform's id of the item's ticket. */
  nodeId: string;
  /** The status the item had before; null when it had none. */
  from: string | null;
  /** The status it has now; null when it was cleared (that starts nothing). */
  to: string | null;
  /** The platform's id of the board; absent when the delivery names none. */
  projectId?: string;
  /** Who moved it; absent when the delivery does not say. */
  actor?: { login: string; externalId: string };
};

/** What one move made of the workflows of the workspace. */
export type StatusTriggerResult = {
  /** The workflows whose trigger is this move. */
  matched: number;
  /** The runs this call wrote. */
  started: number;
  /** The runs an earlier try of the same delivery had written. */
  existing: number;
  /** Matched workflows that start nothing now (a step the engine does not run, a document it cannot read). */
  skipped: number;
  /** Matched workflows that already have a running run for this ticket: they start nothing. */
  busy: number;
};

export type StatusTrigger = {
  /**
   * Starts the workflows the move starts for the ticket, except those that have a running run for it. Throws what the database or the
   * platform throws: the delivery is then tried again, which is safe, a workflow that has its run is not started twice.
   */
  start(deliveryId: string, move: BoardMove): Promise<StatusTriggerResult>;
};

export type StatusTriggerDependencies = {
  runs: Pick<WorkflowRunsRepository, "createRun">;
  /** The lanes of the project whose ticket source is the repository that wait for a status. */
  workflows: Pick<WorkflowsRepository, "listWithStatusTrigger">;
  /** The ticket the board item names, as the ticket mirror holds it; undefined for none and for a pull request. */
  ticketOfNode(
    nodeId: string,
  ): Promise<
    { provider: string; repositoryId: string; key: string } | undefined
  >;
  /** The provider's id of the board the active project of the repository chose; undefined for none. */
  boardOf(repositoryId: string): Promise<string | undefined>;
  /** The repository when it is an active one of the workspace, with its default branch; undefined otherwise. */
  repositoryOf(
    repositoryId: string,
  ): Promise<
    { id: string; fullName: string; defaultBranch: string } | undefined
  >;
  /** The ticket as the platform has it now; undefined when there is none. Throws when the platform cannot be asked. */
  readTicket(
    repositoryId: string,
    key: string,
  ): Promise<StatusTicket | undefined>;
  /** Tells the engine the run exists; it runs the first steps after the response. Never throws. */
  kick(runId: string): void;
  /** The most a workflow may be given to spend: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
  /** One line per move or workflow left out; never a value of the ticket. */
  log?: (line: string) => void;
};

/** The request id a delivery starts a workflow under: the same delivery never makes a second run of the same workflow. */
export const statusRequestId = (
  deliveryId: string,
  workflowId: string,
): string => `gh-${deliveryId}-${workflowId}`;

/** What the steps of a run a move started read: `trigger.ticket` and `trigger.status.from`, `.to`. All bounded. */
export function statusTriggerInput(
  ticket: StatusTicket,
  repo: { fullName: string; defaultBranch: string },
  status: { from: string; to: string },
): { ticket: TicketValue; status: { from: string; to: string } } {
  return {
    ticket: ticketValue(ticket, repo),
    status: {
      from: bounded(status.from, STATUS_NAME_MAX_LENGTH, false),
      to: bounded(status.to, STATUS_NAME_MAX_LENGTH, false),
    },
  };
}

export function createStatusTrigger(
  deps: StatusTriggerDependencies,
): StatusTrigger {
  const maxBudgetUsd = deps.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD;
  const log = deps.log ?? ((line) => console.info(line));

  return {
    async start(deliveryId, move) {
      const result: StatusTriggerResult = {
        matched: 0,
        started: 0,
        existing: 0,
        skipped: 0,
        busy: 0,
      };
      const { to } = move;
      if (to === null) return result;
      const ticket = await deps.ticketOfNode(move.nodeId);
      if (ticket === undefined) {
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the board item is no issue the ticket mirror holds`,
        );
        return result;
      }
      // The project's own board decides: another board's move of a ticket that is on both says nothing about it.
      const board = await deps.boardOf(ticket.repositoryId);
      if (
        board !== undefined &&
        move.projectId !== undefined &&
        move.projectId !== board
      )
        return result;

      const matching: {
        workflowId: string;
        version: number;
        trigger: { id: string; kind: typeof STATUS_TRIGGER_KIND };
        budgetMicroUsd: number;
      }[] = [];
      for (const {
        workflow,
        current,
      } of await deps.workflows.listWithStatusTrigger(ticket.repositoryId)) {
        const read = readRunDocument(current.document);
        const trigger = read?.triggers.find(
          (candidate) =>
            candidate.kind === STATUS_TRIGGER_KIND &&
            candidate.to === to &&
            (candidate.from === undefined || candidate.from === move.from),
        );
        const document =
          read === undefined || trigger === undefined
            ? undefined
            : forTrigger(read, { id: trigger.id, kind: trigger.kind });
        if (document === undefined || trigger === undefined) continue;
        result.matched += 1;
        const unsupported = unsupportedStep(document);
        if (unsupported !== undefined) {
          result.skipped += 1;
          log(
            `[status-trigger] workflow=${workflow.id} starts no run: the step ${unsupported.id.slice(0, 64)} is of the kind ${unsupported.kind.slice(0, 20)}, which the engine does not run`,
          );
          continue;
        }
        matching.push({
          workflowId: workflow.id,
          version: current.version,
          trigger: { id: trigger.id, kind: STATUS_TRIGGER_KIND },
          budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
        });
      }
      if (matching.length === 0) return result;

      const repository = await deps.repositoryOf(ticket.repositoryId);
      if (repository === undefined) {
        result.skipped += matching.length;
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the repository is no active one of the workspace`,
        );
        return result;
      }
      const read = await deps.readTicket(ticket.repositoryId, ticket.key);
      if (read === undefined) {
        result.skipped += matching.length;
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the platform has no ticket ${ticket.key.slice(0, 40)} (a pull request is none)`,
        );
        return result;
      }

      // The key of the label trigger (`label-trigger.ts`, `<repository id>#<ticket key>`): a workflow has one running run for one ticket,
      // whichever of its triggers started it.
      const triggerKey = `${repository.id}#${ticket.key}`;
      const triggerInput = JSON.stringify(
        statusTriggerInput(read, repository, { from: move.from ?? "", to }),
      );
      // The login is shown and decides nothing; a delivery that does not name the mover shows "unknown".
      const actorLogin = bounded(
        move.actor?.login ?? "unknown",
        ACTOR_LOGIN_MAX_CHARS,
        false,
      );
      const ticketRef = formatTicketRef({
        provider: ticket.provider,
        repo: repository.fullName,
        key: ticket.key,
      });
      let failure: { error: unknown } | undefined;
      for (const workflow of matching) {
        // The other workflows still start when one of them cannot be written; the delivery is tried again and each finds its own run.
        try {
          const created = await deps.runs.createRun({
            workflowId: workflow.workflowId,
            workflowVersion: workflow.version,
            repositoryId: repository.id,
            baseBranch: bounded(
              repository.defaultBranch,
              BRANCH_MAX_CHARS,
              false,
            ),
            triggerInput,
            budgetMicroUsd: workflow.budgetMicroUsd,
            clientRequestId: statusRequestId(deliveryId, workflow.workflowId),
            triggerKind: STATUS_TRIGGER_KIND,
            triggerId: workflow.trigger.id,
            triggerKey,
            ticketRef,
            createdBy: null,
            actorLogin,
          });
          if (created.status === "busy") {
            result.busy += 1;
            log(
              `[status-trigger] workflow=${workflow.workflowId} starts no run: run=${created.run.id} is still running for ticket ${ticket.key.slice(0, 40)}`,
            );
            continue;
          }
          if (created.status === "created") result.started += 1;
          else result.existing += 1;
          // A run an earlier try wrote may have lost its first push (the process ended between the write and the kick): `advance` does
          // nothing for a run that is moving, and takes it on where it stopped otherwise.
          if (created.status === "created" || created.run.status === "running")
            deps.kick(created.run.id);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== undefined) throw failure.error;
      return result;
    },
  };
}
