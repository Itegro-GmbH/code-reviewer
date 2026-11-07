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
  markerOf,
  supersededComment,
  mentionsOf,
  questionComment,
} from "./ask-comment.ts";
import type { AskChannel } from "./engine.ts";
import type { GithubActionTarget } from "./github-connectors.ts";
import { placeOf, type Place } from "./ask-place.ts";

export type AskChannelDependencies = {
  /** The GitHub connection and repository of the run; undefined when it is gone or has no active connection. */
  targetOf(run: StoredWorkflowRun): Promise<GithubActionTarget | undefined>;
  /** The steps of the run, for a pull request an earlier step opened. */
  listSteps(runId: string): Promise<readonly StoredStepRun[]>;
  /** The GitHub logins of the members of the workspace, to ask them. */
  memberLogins(): Promise<readonly string[]>;
  /** The address of the page of the run in this app. */
  runLink(run: StoredWorkflowRun): Promise<string>;
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

  async function labels(
    target: GithubActionTarget,
    place: Place,
    change: { add: string[]; remove: string[] },
  ): Promise<void> {
    const { provider, integration, repo } = target;
    if (provider.changeIssueLabels === undefined) return;
    try {
      await provider.changeIssueLabels(integration, repo, place.number, change);
    } catch {
      // A label is a hint for people; the question does not depend on it.
    }
  }

  return {
    async asked(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const target = place === undefined ? undefined : await deps.targetOf(run);
      if (place === undefined || target === undefined) return undefined;
      const { provider, integration, repo } = target;
      if (provider.commentOnIssue === undefined) return undefined;
      const identity = identityOf(run, step, ask);
      const body = questionComment({
        identity,
        ask,
        link: await deps.runLink(run),
        mentions: mentionsOf(await deps.memberLogins()),
      });
      const posted = await provider.commentOnIssue(
        integration,
        repo,
        place.number,
        body,
        {
          marker: markerOf("ask", identity),
        },
      );
      await labels(target, place, {
        add: [LABEL_WAITING],
        remove: [LABEL_WORKING],
      });
      return posted.id === undefined ? undefined : { commentId: posted.id };
    },

    async answered(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const target = place === undefined ? undefined : await deps.targetOf(run);
      if (place === undefined || target === undefined) return;
      const { provider, integration, repo } = target;
      const identity = identityOf(run, step, ask);
      if (step.waitingOnCommentId !== null) {
        // The comment of the question says it was answered, and by whom.
        if (provider.updateIssueComment !== undefined)
          try {
            await provider.updateIssueComment(
              integration,
              repo,
              step.waitingOnCommentId,
              answeredComment({ identity, ask }),
            );
          } catch {
            // The answer is stored; a comment that cannot be edited stays as it is.
          }
      } else if (provider.commentOnIssue !== undefined) {
        // A question that was never posted is written down as answered (the marker keeps a repeat from writing it twice); that comment is
        // the whole record, so the one in the name of the person below is not written as well.
        try {
          await provider.commentOnIssue(
            integration,
            repo,
            place.number,
            answeredComment({ identity, ask }),
            { marker: markerOf("answered", identity) },
          );
        } catch {
          // As above.
        }
      }
      // An answer on the page is written down on the ticket in the name of the person; a `/answer` comment is that record itself.
      if (
        ask.answer?.via === "ui" &&
        step.waitingOnCommentId !== null &&
        provider.commentOnIssue !== undefined
      )
        try {
          await provider.commentOnIssue(
            integration,
            repo,
            place.number,
            answerRecordComment({ identity, ask }),
            {
              marker: `<!-- factory answer run=${run.id} step=${step.stepId} q=${String(ask.n)} -->`,
            },
          );
        } catch {
          // As above.
        }
      await labels(target, place, {
        add: [LABEL_WORKING],
        remove: [LABEL_WAITING],
      });
    },

    async cancelled(run, step, ask) {
      const place = placeOf(run, await deps.listSteps(run.id));
      const target = place === undefined ? undefined : await deps.targetOf(run);
      if (place === undefined || target === undefined) return;
      const { provider, integration, repo } = target;
      if (
        step.waitingOnCommentId !== null &&
        provider.updateIssueComment !== undefined
      )
        try {
          await provider.updateIssueComment(
            integration,
            repo,
            step.waitingOnCommentId,
            cancelledComment({ identity: identityOf(run, step, ask), ask }),
          );
        } catch {
          // The run is over either way; a comment that cannot be edited stays as it is.
        }
      // Nobody works on the ticket any more, so only the one that said somebody had to answer goes.
      await labels(target, place, { add: [], remove: [LABEL_WAITING] });
    },

    async superseded(run, step, ask, commentId) {
      const target = await deps.targetOf(run);
      if (target === undefined) return;
      const { provider, integration, repo } = target;
      if (provider.updateIssueComment === undefined) return;
      try {
        await provider.updateIssueComment(
          integration,
          repo,
          commentId,
          supersededComment({ identity: identityOf(run, step, ask) }),
        );
      } catch {
        // Two comments is the cost of a failed edit; the question is the one the step records, and the page of the run shows it.
      }
    },
  };
}
