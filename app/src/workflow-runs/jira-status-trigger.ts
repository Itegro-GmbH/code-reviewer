// SPDX-License-Identifier: LicenseRef-Proprietary

// The status trigger of a Jira project (#1039, epic #1034): an issue of the Jira project a project's ticket source names changed its status
// (the changelog of `jira:issue_updated`), and the lanes of THAT project that wait for the new status start. The rules are those of the
// GitHub front (`status-trigger.ts`, which this uses for matching the lanes and for writing the runs):
//
//  - Whoever made the change starts it (owner decision, 2026-11-14): no guard against the factory's own transitions. The name of the person is
//    kept as the run's `actor_login` and decides nothing.
//  - The lanes are found through the PROJECT: the Jira delivery names a registration, the registration a project, and the project's source must
//    still be that Jira project (the lanes of a project whose source changed or that is off start nothing). A Jira source has no repository
//    of its own, so `listWithStatusTrigger` (by repository) is not used.
//  - The stale guard: Jira is asked for the issue once a lane matched, and its CURRENT status must still be the one of the delivery. A late
//    or repeated delivery names a status the issue no longer has (it was moved on): it starts nothing. Jira that cannot be asked fails the
//    delivery (it is tried again: Jira retries 5xx; a run that exists is not written twice).
//  - A delivery starts each lane at most once (`jira-<registration>-<identifier>-<workflow>`), and a lane has at most one running run per
//    ticket (`<repository id>#<KEY-7>`). The run's input is `{ ticket, status: { from, to } }`, the ticket with Jira's own status name.
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import { jiraSourceOf } from "../db/repositories/projects-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { BUDGET_OPERATOR_MAX_USD } from "../workflows/limits.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import { ACTOR_LOGIN_MAX_CHARS } from "./limits.ts";
import {
  matchStatusLanes,
  statusTriggerInput,
  writeStatusRuns,
  type StatusTicket,
  type StatusTriggerDependencies,
  type StatusTriggerResult,
} from "./status-trigger.ts";
import { bounded } from "./ticket.ts";

/** An issue of a Jira project that got another status, as the webhook of Jira says it. */
export type JiraStatusMove = {
  /** The project the delivery's registration serves. */
  projectId: string;
  /** What the registration watches: the connection and the Jira project key of its project's source. */
  connectionId: string;
  projectKey: string;
  issueKey: string;
  /** The status the issue had before; null when the changelog names none. */
  from: string | null;
  to: string;
  /** Who made the change; absent when the delivery does not say. */
  actor?: { accountId: string; name: string };
};

export type JiraStatusTrigger = {
  /**
   * Starts the lanes the change starts, except those that have a running run for the issue. Throws what the database throws or when Jira
   * cannot be asked: the delivery is then tried again, which is safe.
   */
  start(deliveryId: string, move: JiraStatusMove): Promise<StatusTriggerResult>;
};

export type JiraStatusTriggerDependencies = Pick<
  StatusTriggerDependencies,
  "runs" | "kick" | "maxBudgetUsd" | "log" | "repositoryOf"
> & {
  workflows: Pick<WorkflowsRepository, "listProjectWithStatusTrigger">;
  /** The project with its Jira source (null for another source); undefined for none. */
  projectOf(projectId: string): Promise<
    | (Pick<StoredProject, "id" | "active" | "repositoryId"> & {
        jira: { connectionId: string; projectKey: string } | null;
      })
    | undefined
  >;
  /** The issue as Jira has it now; undefined when there is none. Throws when Jira cannot be asked. */
  readTicket(
    source: { connectionId: string; projectKey: string; repositoryId: string },
    key: string,
  ): Promise<StatusTicket | undefined>;
};

/** The request id a delivery starts a lane under: the same delivery never makes a second run of the same workflow. */
export const jiraStatusRequestId = (
  deliveryId: string,
  workflowId: string,
): string => `jira-${deliveryId}-${workflowId}`;

/** Adapts a stored project to what `projectOf` answers. */
export function jiraProjectView(project: StoredProject) {
  return {
    id: project.id,
    active: project.active,
    repositoryId: project.repositoryId,
    jira: jiraSourceOf(project.ticketSource),
  };
}

export function createJiraStatusTrigger(
  deps: JiraStatusTriggerDependencies,
): JiraStatusTrigger {
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
      const project = await deps.projectOf(move.projectId);
      if (
        project === undefined ||
        !project.active ||
        project.jira === null ||
        project.jira.connectionId !== move.connectionId ||
        project.jira.projectKey !== move.projectKey
      ) {
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the project is off or its ticket source is no longer the Jira project of the webhook`,
        );
        return result;
      }
      const matching = matchStatusLanes(
        await deps.workflows.listProjectWithStatusTrigger(project.id),
        { to: move.to, from: move.from },
        { maxBudgetUsd, log, result },
      );
      if (matching.length === 0) return result;

      const repository = await deps.repositoryOf(project.repositoryId);
      if (repository === undefined) {
        result.skipped += matching.length;
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the repository the code lives in is no active one of the workspace`,
        );
        return result;
      }
      const ticket = await deps.readTicket(
        { ...project.jira, repositoryId: project.repositoryId },
        move.issueKey,
      );
      if (ticket === undefined) {
        result.skipped += matching.length;
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: Jira has no issue ${move.issueKey.slice(0, 40)} in the project`,
        );
        return result;
      }
      // A delivery that is late or comes again: the issue must still have the status the delivery names.
      if (ticket.status !== move.to) {
        result.skipped += matching.length;
        log(
          `[status-trigger] delivery=${deliveryId} starts no run: the issue no longer has the status of the delivery`,
        );
        return result;
      }

      await writeStatusRuns(deps, {
        matching,
        result,
        repository,
        triggerInput: JSON.stringify(
          statusTriggerInput(ticket, repository, {
            from: move.from ?? "",
            to: move.to,
          }),
        ),
        triggerKey: `${repository.id}#${move.issueKey}`,
        ticketRef: formatTicketRef({
          provider: "jira",
          repo: repository.fullName,
          key: move.issueKey,
        }),
        actorLogin: bounded(
          move.actor?.name || move.actor?.accountId || "unknown",
          ACTOR_LOGIN_MAX_CHARS,
          false,
        ),
        ticketKey: move.issueKey,
        requestId: (workflowId) => jiraStatusRequestId(deliveryId, workflowId),
      });
      return result;
    },
  };
}
