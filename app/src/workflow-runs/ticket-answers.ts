// SPDX-License-Identifier: LicenseRef-Proprietary

// An answer on a ticket or a pull request (#920): the webhook hands over a comment `/answer <n>` or `/answer <text>` of somebody with write
// access (the same check as `/review`, made by the parser of the webhook; a bot never counts), and this finds the run that waits for it and
// answers it. It serves ONE workspace.
//
//  - The run is found in the database, never by what a comment says: the runs of the workspace that wait, whose question is open and whose
//    ticket is the one the comment is on (`workflow_runs.ticket_ref`, #923), else the runs about no ticket whose pull request is. A run
//    waits for one question at a time and a ticket has one run per workflow, so the newest waiting run wins when two workflows wait on
//    the same ticket. A comment on anything else starts nothing.
//  - The answer belongs to ONE question: a comment answers it only when it was written after the question was asked (its id is greater than
//    the id of the comment that carries the question, and it is not older than the moment the step began to wait). A late or redelivered
//    comment from before never answers a question that came later, whatever it says.
//  - `/answer <n>` is an option by its number, a note may follow. A question without that option takes the whole text as a free answer
//    (`/answer 3 retries` is a text where the question has no option 3).
//  - The answer goes through `engine.answer`, under the lock of the run: of two answers at once one wins. Then the engine is kicked (the
//    turn that goes on starts after the response, like the first steps of a run).
//  - A comment that should have answered something and could not (an empty or too long text, nothing waits, it was answered first) gets a
//    short reply of the App on the ticket, in fixed words that repeat nothing of the comment. A commenter without write access never gets
//    this far (the webhook's parser ignores them), so that is silent by design, and so is a comment that is too old for the question.
import type {
  StoredWorkflowRun,
  StoredStepRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { TicketAnswer } from "../integrations/types.ts";
import { parseStepAsk, type StepAsk } from "./ask.ts";
import { placeOf } from "./ask-channel.ts";
import { formatTicketRef } from "../workflows/ticket-ref.ts";
import type { WorkflowEngine } from "./engine.ts";

/** What an answer on a ticket came to; the webhook records `answered` as its outcome and logs the rest. */
export type TicketAnswerResult =
  | { outcome: "answered"; runId: string }
  /** No run of the workspace waits for an answer on this ticket or pull request (or the repository is not an active one). */
  | { outcome: "no_run" }
  /**
   * A run waits, and the answer cannot be used (an empty text, too long, an option that is not there), or somebody answered first, or the
   * comment is older than the question (`stale`).
   */
  | { outcome: "not_taken"; reason: "refused" | "not_waiting" | "stale" };

export type TicketAnswers = {
  answer(deliveryId: string, answer: TicketAnswer): Promise<TicketAnswerResult>;
};

export type TicketAnswersDependencies = {
  /** The active repository of the workspace the comment is in, or undefined. */
  activeRepository(
    repo: TicketAnswer["repo"],
  ): Promise<{ id: string } | undefined>;
  /** The runs that wait and are about the ticket (`github:owner/repo#128`, `workflow_runs.ticket_ref`), newest first. */
  listWaitingForTicket(ticketRef: string): Promise<StoredWorkflowRun[]>;
  /** The runs that wait on a repository and are about no ticket (their question is on a pull request), newest first. */
  listWaitingWithoutTicket(repositoryId: string): Promise<StoredWorkflowRun[]>;
  listSteps(runId: string): Promise<StoredStepRun[]>;
  engine: Pick<WorkflowEngine, "answer">;
  kick(runId: string): void;
  /**
   * Writes a reply of the App below the ticket of a comment that could not answer. `text` is ours (never the commenter's); `key` names the
   * comment, so a redelivery does not reply twice. The reply is a courtesy: a failure of it is swallowed here.
   */
  reply?(
    repositoryId: string,
    answer: TicketAnswer,
    text: string,
    key: string,
  ): Promise<void>;
};

/** What the App says to a comment that could not answer. Fixed words: nothing of the comment is repeated. */
export const ANSWER_REPLIES = {
  answer_empty:
    "That answer is empty. Reply with `/answer <n>` for one of the options, or `/answer <your answer>`.",
  answer_too_long: "That answer is too long. Please shorten it and try again.",
  option_unknown:
    "The question has no such option. Reply with `/answer <your answer>` instead.",
  not_waiting:
    "No question is waiting for an answer on this ticket any more: it was answered already, or the run was stopped.",
  no_run: "No question is waiting for an answer on this ticket.",
} as const;

/**
 * Whether a comment is older than the question: its id is not greater than the id of the comment that carries the question (ids of the
 * provider grow with time; compared only where both are numbers), or it was written before the step began to wait.
 */
export function isOlderThanQuestion(
  answer: Pick<TicketAnswer, "commentId" | "createdAt">,
  question: { commentId: string | null; ask: Pick<StepAsk, "askedAt"> },
): boolean {
  if (question.commentId !== null) {
    const asked = Number(question.commentId);
    const written = Number(answer.commentId);
    if (
      Number.isSafeInteger(asked) &&
      Number.isSafeInteger(written) &&
      written <= asked
    )
      return true;
  }
  if (answer.createdAt !== undefined && question.ask.askedAt !== undefined) {
    const written = Date.parse(answer.createdAt);
    const asked = Date.parse(question.ask.askedAt);
    if (!Number.isNaN(written) && !Number.isNaN(asked) && written < asked)
      return true;
  }
  return false;
}

export function createTicketAnswers(
  deps: TicketAnswersDependencies,
): TicketAnswers {
  async function reply(
    repositoryId: string,
    answer: TicketAnswer,
    text: string,
  ): Promise<void> {
    try {
      await deps.reply?.(
        repositoryId,
        answer,
        text,
        `<!-- factory answer-reply comment=${answer.commentId.replace(/[^0-9A-Za-z_-]/g, "")} -->`,
      );
    } catch {
      // A courtesy; the comment itself is what the person wrote, and the page of the run says the rest.
    }
  }

  return {
    async answer(_deliveryId, answer) {
      const repository = await deps.activeRepository(answer.repo);
      if (repository === undefined) return { outcome: "no_run" };
      let stale = false;
      const candidates = [
        ...(await deps.listWaitingForTicket(
          formatTicketRef({
            provider: "github",
            repo: answer.repo.fullName,
            number: answer.number,
          }),
        )),
        ...(await deps.listWaitingWithoutTicket(repository.id)),
      ];
      for (const run of candidates) {
        if (run.repositoryId !== repository.id) continue;
        const steps = await deps.listSteps(run.id);
        const waiting = steps.findLast((step) => step.status === "waiting");
        const ask = parseStepAsk(waiting?.ask ?? null);
        if (waiting === undefined || ask === undefined || ask.state !== "open")
          continue;
        if (placeOf(run, steps)?.number !== answer.number) continue;
        // A comment from before the question is none to it; another run on the ticket may still be the one it was meant for.
        if (
          isOlderThanQuestion(answer, {
            commentId: waiting.waitingOnCommentId,
            ask,
          })
        ) {
          stale = true;
          continue;
        }
        // A number the question has no option for is part of a text.
        const asOption =
          answer.choice !== undefined &&
          (ask.options?.length ?? 0) >= answer.choice;
        const taken = await deps.engine.answer(run.id, {
          ...(asOption && answer.choice !== undefined
            ? { choice: answer.choice }
            : {}),
          text: asOption ? (answer.text ?? "") : answer.raw,
          by: answer.actor.login,
          via: "comment",
        });
        if (taken.outcome !== "answered") {
          await reply(
            repository.id,
            answer,
            taken.outcome === "refused"
              ? ANSWER_REPLIES[taken.code]
              : ANSWER_REPLIES.not_waiting,
          );
          return {
            outcome: "not_taken",
            reason: taken.outcome === "refused" ? "refused" : "not_waiting",
          };
        }
        deps.kick(run.id);
        return { outcome: "answered", runId: run.id };
      }
      if (stale) return { outcome: "not_taken", reason: "stale" };
      await reply(repository.id, answer, ANSWER_REPLIES.no_run);
      return { outcome: "no_run" };
    },
  };
}
