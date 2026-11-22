// SPDX-License-Identifier: LicenseRef-Proprietary

// The label trigger of a Jira project (#1129, epic #1034): a person put a label on an issue of the Jira project a project's ticket source
// names (the `labels` item of the changelog of `jira:issue_updated`, or the labels a created issue starts with), and the lanes of THAT
// project that wait for this label start. The rules are those of the GitHub front (`label-trigger.ts`) and of the Jira status front
// (`jira-status-trigger.ts`, whose way of finding the project and of writing the runs this shares):
//
//  - Only an ADDED label starts a run; a label that was taken off, or that the issue kept, starts nothing. An issue that is created with the
//    label starts the lane as well (GitHub does the same for a label from an issue template, which it reports as a label put on).
//  - A lane waits for a label by its spelling in the lane (`ticket.labeled`, or `github.issueLabeled`, its name before #916). Jira labels
//    cannot contain whitespace and the factory writes a label with a space as a hyphen (`ticket-writer.ts`), so the lane label "ready for
//    agent" is the Jira label "ready-for-agent" (`workflows/label-match.ts`). Case counts, as it does on GitHub.
//  - Whoever put the label on starts it (no check of our own; Jira decides who may label, as GitHub does). The factory writes to Jira as the
//    person who connected it, so a label it writes cannot be told from a person's: a lane that adds the label that starts it is warned about
//    by the validator (`label_retriggers_workflow`) and, when it happens through a pre-step, stopped by the rule below. The name of the person
//    is kept as the run's `actor_login`, to be shown, and decides nothing.
//  - The lanes are found through the PROJECT: the Jira delivery names a registration, the registration a project, and the project's source must
//    still be that Jira project (a project whose source changed or that is off starts nothing).
//  - The stale guard: Jira is asked for the issue once a lane matched, and it must STILL have the label (as the status front checks the status):
//    a late or repeated delivery for a label that was taken off since starts nothing. Jira that cannot be asked fails the delivery (it is
//    tried again: Jira retries 5xx; a run that exists is not written twice).
//  - A delivery starts each lane at most once (`jira-label-<registration>-<identifier>-<workflow>`), and a lane has at most one running run per
//    ticket (`<repository id>#<KEY-7>`, the key of the other fronts), which also holds back a run a pre-step's own label would start. The run's
//    input is `{ ticket }` (the ticket with Jira's own status name; `key` is `PROJ-12`, `number` is 0).
import { laneLabelIsAmong } from "../workflows/label-match.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { BUDGET_OPERATOR_MAX_USD } from "../workflows/limits.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import {
  forTrigger,
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
} from "./document.ts";
import { LABEL_TRIGGER_KIND } from "./label-trigger.ts";
import { ACTOR_LOGIN_MAX_CHARS } from "./limits.ts";
import {
  writeStatusRuns,
  type MatchedStatusLane,
  type StatusTicket,
  type StatusTriggerDependencies,
  type StatusTriggerResult,
} from "./status-trigger.ts";
import { bounded, ticketValue, type TicketValue } from "./ticket.ts";

/** Labels put on an issue of a Jira project, as the webhook of Jira says it. */
export type JiraLabelsAdded = {
  /** The project the delivery's registration serves. */
  projectId: string;
  /** What the registration watches: the connection and the Jira project key of its project's source. */
  connectionId: string;
  projectKey: string;
  issueKey: string;
  /** The labels the delivery put on, as Jira spells them (no spaces). */
  labels: readonly string[];
  /** Who put them on; absent when the delivery does not say. */
  actor?: { accountId: string; name: string };
};

export type JiraLabelTrigger = {
  /**
   * Starts the lanes the labels start, except those that have a running run for the issue. Throws what the database throws or when Jira
   * cannot be asked: the delivery is then tried again, which is safe.
   */
  start(
    deliveryId: string,
    added: JiraLabelsAdded,
  ): Promise<StatusTriggerResult>;
};

export type JiraLabelTriggerDependencies = Pick<
  StatusTriggerDependencies,
  "runs" | "kick" | "maxBudgetUsd" | "log" | "repositoryOf"
> & {
  workflows: Pick<WorkflowsRepository, "listProjectWithIssueTrigger">;
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
export const jiraLabelRequestId = (
  deliveryId: string,
  workflowId: string,
): string => `jira-label-${deliveryId}-${workflowId}`;

/** What the steps of a run a label started read: `trigger.ticket`. Bounded. */
export function jiraLabelTriggerInput(
  ticket: StatusTicket,
  repo: { fullName: string; defaultBranch: string },
): { ticket: TicketValue } {
  return { ticket: ticketValue(ticket, repo) };
}

export function createJiraLabelTrigger(
  deps: JiraLabelTriggerDependencies,
): JiraLabelTrigger {
  const maxBudgetUsd = deps.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD;
  const log = deps.log ?? ((line) => console.info(line));

  return {
    async start(deliveryId, added) {
      const result: StatusTriggerResult = {
        matched: 0,
        started: 0,
        existing: 0,
        skipped: 0,
        busy: 0,
      };
      if (added.labels.length === 0) return result;
      const project = await deps.projectOf(added.projectId);
      if (
        project === undefined ||
        !project.active ||
        project.jira === null ||
        project.jira.connectionId !== added.connectionId ||
        project.jira.projectKey !== added.projectKey
      ) {
        log(
          `[label-trigger] delivery=${deliveryId} starts no run: the project is off or its ticket source is no longer the Jira project of the webhook`,
        );
        return result;
      }

      const put = new Set(added.labels);
      const matching: (MatchedStatusLane & { label: string })[] = [];
      for (const {
        workflow,
        current,
      } of await deps.workflows.listProjectWithIssueTrigger(project.id)) {
        const read = readRunDocument(current.document);
        const trigger = read?.triggers.find(
          (candidate) =>
            candidate.kind === LABEL_TRIGGER_KIND &&
            candidate.label !== undefined &&
            laneLabelIsAmong(candidate.label, put),
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
            `[label-trigger] workflow=${workflow.id} starts no run: the step ${unsupported.id.slice(0, 64)} is of the kind ${unsupported.kind.slice(0, 20)}, which the engine does not run`,
          );
          continue;
        }
        matching.push({
          workflowId: workflow.id,
          version: current.version,
          trigger: { id: trigger.id, kind: LABEL_TRIGGER_KIND },
          budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
          label: trigger.label ?? "",
        });
      }
      if (matching.length === 0) return result;

      const repository = await deps.repositoryOf(project.repositoryId);
      if (repository === undefined) {
        result.skipped += matching.length;
        log(
          `[label-trigger] delivery=${deliveryId} starts no run: the repository the code lives in is no active one of the workspace`,
        );
        return result;
      }
      const ticket = await deps.readTicket(
        { ...project.jira, repositoryId: project.repositoryId },
        added.issueKey,
      );
      if (ticket === undefined) {
        result.skipped += matching.length;
        log(
          `[label-trigger] delivery=${deliveryId} starts no run: Jira has no issue ${added.issueKey.slice(0, 40)} in the project`,
        );
        return result;
      }
      // A delivery that is late or comes again: the issue must still have the label (a label taken off since starts nothing).
      const has = new Set(ticket.labels);
      const standing = matching.filter((lane) =>
        laneLabelIsAmong(lane.label, has),
      );
      if (standing.length < matching.length) {
        result.skipped += matching.length - standing.length;
        log(
          `[label-trigger] delivery=${deliveryId} starts no run for ${matching.length - standing.length} lane(s): the issue no longer has the label of the delivery`,
        );
      }
      if (standing.length === 0) return result;

      await writeStatusRuns(deps, {
        matching: standing,
        result,
        repository,
        triggerInput: JSON.stringify(jiraLabelTriggerInput(ticket, repository)),
        triggerKey: `${repository.id}#${added.issueKey}`,
        ticketRef: formatTicketRef({
          provider: "jira",
          repo: repository.fullName,
          key: added.issueKey,
        }),
        actorLogin: bounded(
          added.actor?.name || added.actor?.accountId || "unknown",
          ACTOR_LOGIN_MAX_CHARS,
          false,
        ),
        ticketKey: added.issueKey,
        requestId: (workflowId) => jiraLabelRequestId(deliveryId, workflowId),
        triggerKind: LABEL_TRIGGER_KIND,
        logPrefix: "[label-trigger]",
      });
      return result;
    },
  };
}
