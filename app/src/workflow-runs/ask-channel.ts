// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the question of an agent is shown and how an answer is acknowledged (#920): the ticket of the run, else the pull request it opened,
// else nowhere (the run page shows it, always). The engine calls this after the lock of the run is released; a failure of one call is the
// engine's to log, and the question is stored with the step whatever happens to its comment.
//
//  - A question is a comment of the App with a hidden marker (`ask-comment.ts`), the question, the numbered options, how to answer, and the
//    members of the workspace as @-mentions; the ticket gets the label `agent waiting` and loses `agent working`. A call that is made again
//    finds the comment by its marker and writes no second one.
//  - An answer edits that comment (the marker says `answered`, and who answered what) and puts the labels back. An answer from the page
//    also writes a comment in the name of the person ("Answer by @login: ..."), so the ticket holds the whole record, which a `/answer`
//    comment already is. A question that was never posted (the answer came first) is posted as answered, never as an open question.
//  - A run that is stopped while the question is open edits the comment the same way (the marker says `cancelled`) and takes the label
//    `agent waiting` off.
//  - A run a member discards (#921) edits the comment of its open question the same way (the marker says `discarded`). The labels
//    `agent working` and `agent waiting` come off the ticket only when the discard frees it: the run was going on and no other run that
//    goes on holds the ticket (the engine decides, `freeTicket`). A run that was over has no label of its own to take off.
//  - Labels and the edit are best effort: the question and the answer are what matter, and a repository that refuses a label does not
//    stop a run.
import type {
  StoredStepRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { StepAsk } from "./ask.ts";
import {
  LABEL_WAITING,
  LABEL_WORKING,
  answerRecordComment,
  answeredComment,
  cancelledComment,
  discardedComment,
  markerOf,
  supersededComment,
  mentionsOf,
  questionComment,
} from "./ask-comment.ts";
import type { AskChannel } from "./engine.ts";
import type { GithubActionTarget } from "./github-connectors.ts";
import { placeOf, type Place } from "./ask-place.ts";
import type { TicketTarget } from "./ticket-target.ts";

export type AskChannelDependencies = {
  /** The GitHub connection and repository of the run, for a question that sits on its pull request; undefined when it is gone or has no active connection. */
  targetOf(run: StoredWorkflowRun): Promise<GithubActionTarget | undefined>;
  /** The ticket provider and container of the run (#1035), for a question that sits on its ticket; undefined when there is none. */
  ticketTargetOf(run: StoredWorkflowRun): Promise<TicketTarget | undefined>;
  /** The steps of the run, for a pull request an earlier step opened. */
  listSteps(runId: string): Promise<readonly StoredStepRun[]>;
  /** The GitHub logins of the members of the workspace, to ask them. */
  memberLogins(): Promise<readonly string[]>;
  /** The address of the page of the run in this app. */
  runLink(run: StoredWorkflowRun): Promise<string>;
  /** Whether the run is discarded now (#921): an answer that comes as a member discards the run puts no label back. */
  isDiscarded(runId: string): Promise<boolean>;
};

export function createGithubAskChannel(
  deps: AskChannelDependencies,
): AskChannel {
  /** The ids that name a question in its comment. */
  const identityOf = (
    run: StoredWorkflowRun,
    step: StoredStepRun,
    ask: StepAsk,
  ) => ({
    runId: run.id,
    stepId: step.stepId,
    n: ask.n,
  });

  /**
   * What a question can do where it is shown: write and edit a comment, and change labels. The ticket of the run is written through the ticket
   * provider of its project's source, a pull request through the git provider (#1035). A call the provider has not got is undefined.
   */
  type Surface = {
    comment?: (
      body: string,
      options: { marker: string },
    ) => Promise<{ id?: string }>;
    edit?: (commentId: string, body: string) => Promise<void>;
    labels?: (change: { add: string[]; remove: string[] }) => Promise<unknown>;
  };

  async function surfaceOf(
    run: StoredWorkflowRun,
    place: Place | undefined,
  ): Promise<Surface | undefined> {
    if (place?.kind === "ticket") {
      const target = await deps.ticketTargetOf(run);
      if (target === undefined) return undefined;
      const { provider, scope } = target;
      const { key } = place;
      const comment = provider.commentOnTicket?.bind(provider);
      const edit = provider.updateTicketComment?.bind(provider);
      const change = provider.changeTicketLabels?.bind(provider);
      return {
        ...(comment === undefined
          ? {}
          : { comment: (body, options) => comment(scope, key, body, options) }),
        ...(edit === undefined
          ? {}
          : { edit: (commentId, body) => edit(scope, key, commentId, body) }),
        ...(change === undefined
          ? {}
          : { labels: (labels) => change(scope, key, labels) }),
      };
    }
    const target = await deps.targetOf(run);
    if (target === undefined) return undefined;
    const { provider, integration, repo } = target;
    const number = Number(place?.key);
    const comment = provider.commentOnIssue?.bind(provider);
    const edit = provider.updateIssueComment?.bind(provider);
    const change = provider.changeIssueLabels?.bind(provider);
    return {
      ...(comment === undefined
        ? {}
        : {
            comment: (body, options) =>
              comment(integration, repo, number, body, options),
          }),
      ...(edit === undefined
        ? {}
        : {
            edit: (commentId, body) => edit(integration, repo, commentId, body),
          }),
      ...(change === undefined
        ? {}
        : { labels: (labels) => change(integration, repo, number, labels) }),
    };
  }

  async function labels(
    surface: Surface,
    change: { add: string[]; remove: string[] },
  ): Promise<void> {
    if (surface.labels === undefined) return;
    try {
      await surface.labels(change);
    } catch {
      // A label is a hint for people; the question does not depend on it.
    }
  }

  /** Whether the run is discarded now; a failure to find out counts as no. */
  async function isDiscarded(run: StoredWorkflowRun): Promise<boolean> {
    try {
      return await deps.isDiscarded(run.id);
    } catch {
      return false;
    }
  }

  return {
    async asked(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const surface =
        place === undefined ? undefined : await surfaceOf(run, place);
      if (place === undefined || surface?.comment === undefined)
        return undefined;
      const identity = identityOf(run, step, ask);
      const body = questionComment({
        identity,
        ask,
        link: await deps.runLink(run),
        mentions: mentionsOf(await deps.memberLogins()),
      });
      const posted = await surface.comment(body, {
        marker: markerOf("ask", identity),
      });
      await labels(surface, { add: [LABEL_WAITING], remove: [LABEL_WORKING] });
      return posted.id === undefined ? undefined : { commentId: posted.id };
    },

    async answered(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const surface =
        place === undefined ? undefined : await surfaceOf(run, place);
      if (place === undefined || surface === undefined) return;
      const identity = identityOf(run, step, ask);
      if (step.waitingOnCommentId !== null) {
        // The comment of the question says it was answered, and by whom.
        if (surface.edit !== undefined)
          try {
            await surface.edit(
              step.waitingOnCommentId,
              answeredComment({ identity, ask }),
            );
          } catch {
            // The answer is stored; a comment that cannot be edited stays as it is.
          }
      } else if (surface.comment !== undefined) {
        // A question that was never posted is written down as answered (the marker keeps a repeat from writing it twice); that comment is
        // the whole record, so the one in the name of the person below is not written as well.
        try {
          await surface.comment(answeredComment({ identity, ask }), {
            marker: markerOf("answered", identity),
          });
        } catch {
          // As above.
        }
      }
      // An answer on the page is written down on the ticket in the name of the person; a `/answer` comment is that record itself.
      if (
        ask.answer?.via === "ui" &&
        step.waitingOnCommentId !== null &&
        surface.comment !== undefined
      )
        try {
          await surface.comment(answerRecordComment({ identity, ask }), {
            marker: `<!-- factory answer run=${run.id} step=${step.stepId} q=${String(ask.n)} -->`,
          });
        } catch {
          // As above.
        }
      // Looked at last: a discard that came while the comment was edited has taken the labels off, and none is put back for it.
      if (!(await isDiscarded(run)))
        await labels(surface, {
          add: [LABEL_WORKING],
          remove: [LABEL_WAITING],
        });
    },

    async cancelled(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const surface =
        place === undefined ? undefined : await surfaceOf(run, place);
      if (place === undefined || surface === undefined) return;
      if (step.waitingOnCommentId !== null && surface.edit !== undefined)
        try {
          await surface.edit(
            step.waitingOnCommentId,
            cancelledComment({ identity: identityOf(run, step, ask), ask }),
          );
        } catch {
          // The run is over either way; a comment that cannot be edited stays as it is.
        }
      // Nobody works on the ticket any more, so only the one that said somebody had to answer goes.
      await labels(surface, { add: [], remove: [LABEL_WAITING] });
    },

    async discarded(run, open, { freeTicket }) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const surface =
        place === undefined ? undefined : await surfaceOf(run, place);
      if (place === undefined || surface === undefined) return;
      if (
        open !== undefined &&
        open.step.waitingOnCommentId !== null &&
        surface.edit !== undefined
      )
        try {
          await surface.edit(
            open.step.waitingOnCommentId,
            discardedComment({
              identity: identityOf(run, open.step, open.ask),
              ask: open.ask,
            }),
          );
        } catch {
          // The run is over either way; a comment that cannot be edited stays as it is.
        }
      // Nobody works on the ticket any more, and nobody has to answer: both labels go, unless another run holds the ticket.
      if (freeTicket)
        await labels(surface, {
          add: [],
          remove: [LABEL_WAITING, LABEL_WORKING],
        });
    },

    async superseded(run, step, ask, commentId) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const surface = await surfaceOf(run, place);
      if (surface?.edit === undefined) return;
      try {
        await surface.edit(
          commentId,
          supersededComment({ identity: identityOf(run, step, ask) }),
        );
      } catch {
        // Two comments is the cost of a failed edit; the question is the one the step records, and the page of the run shows it.
      }
    },
  };
}
