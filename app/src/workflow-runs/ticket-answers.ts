// SPDX-License-Identifier: LicenseRef-Proprietary

// An answer on a ticket or a pull request (#920): the webhook hands over a comment `/answer <n>` or `/answer <text>` of somebody with write
// access (the same check as `/review`, made by the parser of the webhook; a bot never counts), and this finds the run that waits for it and
// answers it. It serves ONE workspace.
//
//  - The run is found in the database, never by what a comment says: the runs of the workspace that wait, on the repository of the comment,
//    whose question is open and whose ticket (or, failing that, whose pull request) is the number the comment is on. A run waits for one
//    question at a time and a ticket has one run per workflow, so the newest waiting run wins when two workflows wait on the same ticket.
//    A comment on anything else starts nothing and says nothing.
//  - `/answer <n>` is an option by its number, a note may follow. A question without that option takes the whole text as a free answer
//    (`/answer 3 retries` is a text where the question has no option 3).
//  - The answer goes through `engine.answer`, under the lock of the run: of two answers at once one wins. Then the engine is kicked (the
//    turn that goes on starts after the response, like the first steps of a run).
import type {
  StoredWorkflowRun,
  StoredStepRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type { TicketAnswer } from "../integrations/types.ts";
import { parseStepAsk } from "./ask.ts";
import { placeOf } from "./ask-channel.ts";
import type { WorkflowEngine } from "./engine.ts";

/** What an answer on a ticket came to; the webhook records `answered` as its outcome and logs the rest. */
export type TicketAnswerResult =
  | { outcome: "answered"; runId: string }
  /** No run of the workspace waits for an answer on this ticket or pull request (or the repository is not an active one). */
  | { outcome: "no_run" }
  /** A run waits, and the answer cannot be used (an empty text, too long, an option that is not there), or somebody answered first. */
  | { outcome: "not_taken"; reason: "refused" | "not_waiting" };

export type TicketAnswers = {
  answer(deliveryId: string, answer: TicketAnswer): Promise<TicketAnswerResult>;
};

export type TicketAnswersDependencies = {
  /** The active repository of the workspace the comment is in, or undefined. */
  activeRepository(
    repo: TicketAnswer["repo"],
  ): Promise<{ id: string } | undefined>;
  /** The runs that wait on a repository, newest first. */
  listWaiting(repositoryId: string): Promise<StoredWorkflowRun[]>;
  listSteps(runId: string): Promise<StoredStepRun[]>;
  engine: Pick<WorkflowEngine, "answer">;
  kick(runId: string): void;
};

export function createTicketAnswers(
  deps: TicketAnswersDependencies,
): TicketAnswers {
  return {
    async answer(_deliveryId, answer) {
      const repository = await deps.activeRepository(answer.repo);
      if (repository === undefined) return { outcome: "no_run" };
      for (const run of await deps.listWaiting(repository.id)) {
        const steps = await deps.listSteps(run.id);
        const waiting = steps.findLast((step) => step.status === "waiting");
        const ask = parseStepAsk(waiting?.ask ?? null);
        if (ask === undefined || ask.state !== "open") continue;
        if (placeOf(run, steps)?.number !== answer.number) continue;
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
        if (taken.outcome !== "answered")
          return {
            outcome: "not_taken",
            reason: taken.outcome === "refused" ? "refused" : "not_waiting",
          };
        deps.kick(run.id);
        return { outcome: "answered", runId: run.id };
      }
      return { outcome: "no_run" };
    },
  };
}
