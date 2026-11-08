// SPDX-License-Identifier: LicenseRef-Proprietary

// The label trigger (#845, milestone 4 of epic #833): a label put on an issue starts the workflows of the workspace that are started by
// exactly this label. The webhook (`src/webhooks/`) hands the issue over once the signature, the delivery id and the installation are
// settled; this decides which workflows start and writes their runs. It serves ONE workspace.
//
//  - A workflow starts when one of its triggers is `ticket.labeled` (or `github.issueLabeled`, its name before #916) with exactly this
//    label (the spelling GitHub reports; case counts), the repository of the issue is an active repository of the workspace, and the
//    workflow is a lane of the active project whose ticket source is that repository (#922): a lane of another project, and a lane
//    without a project, wait for no label here. The run starts through that trigger: its pre-steps run first, then the shared steps. A
//    workflow with two triggers for one label starts once, through the first. The format has no repository of its own for a label
//    trigger: the run works on the repository the ticket is in (`trigger.ticket.repo`), which is the project's.
//    A workflow with a step the engine does not run (a kind the validator refuses, so none that was saved) is left out and says so in
//    the log: a run that ends halfway through, after its first action already changed the issue, is worse than none.
//  - There is no check of our own about who put the label on (owner decision 2 of the plan): GitHub decides who may label. The login
//    of the person is stored as the run's `actor_login`, to be shown, and decides nothing. A label from a bot never gets here (the
//    parser of the webhook leaves it out: the connectors label issues with the App's token, and a label would start the next run).
//  - A delivery starts each workflow at most once: the run's request id is `gh-<delivery id>-<workflow id>`. A retry of the delivery
//    (GitHub's redelivery, a second request that raced the first) finds the runs it made and writes none; a workflow that was saved
//    in between starts with the retry, as it would have with the first try.
//  - A workflow has at most ONE running run for one issue (`triggerKey`: the repository and the issue number). The label put on, taken
//    off and put on again while the first run goes on starts nothing, so that a person (or a script) cannot start a run with a full
//    budget as often as they like; when the run has ended, the next label starts the next one. The database holds it (a partial unique
//    index), so two deliveries that race for it write one run. The skipped start is logged with its reason.
//  - The run's input is the ticket (`trigger.ticket`: number, title, body, url, labels, type, assignees, repo), and for workflows
//    written before #916 the same as `trigger.issue` (number, title, body, url, labels) and `trigger.repo` (fullName, owner, name,
//    defaultBranch), stored bounded as the run's `trigger_input`. The texts are those of whoever opened the issue. They are
//    data like any value: a text is never read as a reference (`templates.ts`), and where they go into the text of an action (a comment, a
//    pull request) they are defused like what an agent wrote (`OUTSIDER_TRIGGER_FIELDS`).
import type { IssueLabeled } from "../integrations/types.ts";
import type {
  RunTriggerKind,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type { WorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { BUDGET_OPERATOR_MAX_USD } from "../workflows/limits.ts";
import {
  forTrigger,
  readRunDocument,
  runBudgetMicroUsd,
  unsupportedStep,
} from "./document.ts";
import { ACTOR_LOGIN_MAX_CHARS, BRANCH_MAX_CHARS } from "./limits.ts";
import { bounded, ticketValue, type TicketValue } from "./ticket.ts";

/** What a run a label started is recorded as. Runs written before #916 say `github.issueLabeled`, the same trigger under its old name. */
export const LABEL_TRIGGER_KIND = "ticket.labeled" satisfies RunTriggerKind;

/** What one label put on one issue made of the workflows of the workspace. */
export type LabelTriggerResult = {
  /** The workflows whose trigger is this label. */
  matched: number;
  /** The runs this call wrote. */
  started: number;
  /** The runs an earlier try of the same delivery had written. */
  existing: number;
  /** Matched workflows that start nothing now (a step the engine does not run, a document it cannot read). */
  skipped: number;
  /** Matched workflows that already have a running run for this issue (a label put on again): they start nothing. */
  busy: number;
};

export type LabelTrigger = {
  /**
   * Starts the workflows the label starts for the issue, except those that have a running run for it. Throws what the database
   * throws: the delivery is then tried again, which is safe, a workflow that has its run is not started twice.
   */
  start(deliveryId: string, labeled: IssueLabeled): Promise<LabelTriggerResult>;
};

export type LabelTriggerDependencies = {
  runs: Pick<WorkflowRunsRepository, "createRun">;
  /** The lanes of the project whose ticket source is the repository (#922) that wait for a label. */
  workflows: Pick<WorkflowsRepository, "listWithIssueTrigger">;
  /** The repository of the workspace the delivery is about, or undefined when it is none of the workspace's or not active. */
  activeRepository(
    repo: IssueLabeled["repo"],
  ): Promise<{ id: string } | undefined>;
  /** Tells the engine the run exists; it runs the first steps after the response. Never throws. */
  kick(runId: string): void;
  /** The most a workflow may be given to spend: `BUDGET_OPERATOR_MAX_USD`. */
  maxBudgetUsd?: number;
  /** One line per workflow left out; never a value of the issue. */
  log?: (line: string) => void;
};

/** What a run of a label is for: the issue, in the repository of the workspace. At most one running run of a workflow holds it. */
export const labelTriggerKey = (
  repositoryId: string,
  issueNumber: number,
): string => `${repositoryId}#${issueNumber}`;

/** The ticket a run of a label is about, in the form `workflow_runs.ticket_ref` has (#923): `github:owner/repo#128`. */
export const labelTicketRef = (
  repoFullName: string,
  issueNumber: number,
): string => `github:${repoFullName}#${issueNumber}`;

/** The request id a delivery starts a workflow under: the same delivery never makes a second run of the same workflow. */
export const labelRequestId = (
  deliveryId: string,
  workflowId: string,
): string => `gh-${deliveryId}-${workflowId}`;

/**
 * What the steps of a run a label started read: `trigger.ticket`, and `trigger.issue` and `trigger.repo` as workflows written before
 * #916 read them. All bounded (`ticket.ts`).
 */
export function labelTriggerInput(labeled: IssueLabeled): {
  ticket: TicketValue;
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
    labels: string[];
  };
  repo: TicketValue["repo"];
} {
  const ticket = ticketValue(
    { ...labeled.issue },
    { fullName: labeled.repo.fullName, defaultBranch: labeled.defaultBranch },
  );
  return {
    ticket,
    issue: {
      number: ticket.number,
      title: ticket.title,
      body: ticket.body,
      url: ticket.url,
      labels: ticket.labels,
    },
    repo: ticket.repo,
  };
}

export function createLabelTrigger(
  deps: LabelTriggerDependencies,
): LabelTrigger {
  const maxBudgetUsd = deps.maxBudgetUsd ?? BUDGET_OPERATOR_MAX_USD;
  const log = deps.log ?? ((line) => console.info(line));

  return {
    async start(deliveryId, labeled) {
      const result: LabelTriggerResult = {
        matched: 0,
        started: 0,
        existing: 0,
        skipped: 0,
        busy: 0,
      };
      // A repository that is not an active one of the workspace starts nothing, whatever the workflows say.
      const repository = await deps.activeRepository(labeled.repo);
      if (repository === undefined) return result;

      const triggerKey = labelTriggerKey(repository.id, labeled.issue.number);
      const triggerInput = JSON.stringify(labelTriggerInput(labeled));
      const actorLogin = bounded(
        labeled.actor.login,
        ACTOR_LOGIN_MAX_CHARS,
        false,
      );
      let failure: { error: unknown } | undefined;
      for (const {
        workflow,
        current,
      } of await deps.workflows.listWithIssueTrigger(repository.id)) {
        const read = readRunDocument(current.document);
        const trigger = read?.triggers.find(
          (candidate) =>
            candidate.kind === "ticket.labeled" &&
            candidate.label === labeled.label,
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
        // The other workflows still start when one of them cannot be written; the delivery is tried again and each finds its own run.
        try {
          const created = await deps.runs.createRun({
            workflowId: workflow.id,
            workflowVersion: current.version,
            repositoryId: repository.id,
            baseBranch: bounded(labeled.defaultBranch, BRANCH_MAX_CHARS, false),
            triggerInput,
            budgetMicroUsd: runBudgetMicroUsd(document, maxBudgetUsd),
            clientRequestId: labelRequestId(deliveryId, workflow.id),
            triggerKind: LABEL_TRIGGER_KIND,
            triggerId: trigger.id,
            triggerKey,
            ticketRef: labelTicketRef(
              labeled.repo.fullName,
              labeled.issue.number,
            ),
            createdBy: null,
            actorLogin,
          });
          if (created.status === "busy") {
            result.busy += 1;
            log(
              `[label-trigger] workflow=${workflow.id} starts no run: run=${created.run.id} is still running for issue ${labeled.issue.number}`,
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
