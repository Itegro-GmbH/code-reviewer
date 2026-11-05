// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the turn a job runs for the engine (#844): its id, and, once the job is over, everything the outcome of the step is made from
// (the final status and code of the job, what the runner reported, the turn with its stored result, the session, and the catalog price of
// the model when the runner reported no cost). One reader for the running server and the tests.
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type {
  ImplementerRepository,
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import type { JobsRepository } from "../db/repositories/jobs-repository.ts";
import type { Job } from "../jobs/job-types.ts";
import type { RequestedTurn, TurnRead } from "./engine.ts";
import { costOfResult, type TokenPrice } from "./turn-facts.ts";

const OVER = ["succeeded", "failed", "superseded", "cancelled"] as const;
type OverStatus = (typeof OVER)[number];

function isOver(status: string): status is OverStatus {
  return OVER.some((candidate) => candidate === status);
}

export function createTurnReader(deps: {
  jobs: Pick<JobsRepository, "get" | "findImplementerTurn">;
  turns: Pick<ImplementerRepository, "getTurnByJob">;
  /** The catalog price of a model, or undefined for one the catalog does not price. Left out: no estimate is made. */
  priceOf?: (choice: ModelChoice) => Promise<TokenPrice | undefined>;
}): {
  read(jobId: string): Promise<TurnRead | undefined>;
  /** The turn that a client request id made (`wf-<run>-<position>` for a step), or undefined. */
  findByRequest(clientRequestId: string): Promise<RequestedTurn | undefined>;
} {
  async function readFrom(
    job: Job,
    turn: StoredImplementerTurn,
    session: StoredImplementerSession,
  ): Promise<TurnRead> {
    if (!isOver(job.status)) return { turnId: turn.id, ended: undefined };
    // Only a turn whose cost is not known needs a price.
    const price =
      deps.priceOf === undefined || costOfResult(job.result) !== null
        ? undefined
        : await deps.priceOf(turn.modelChoice);
    return {
      turnId: turn.id,
      ended: {
        jobStatus: job.status,
        jobErrorCode: job.errorCode,
        jobResult: job.result,
        turn,
        session,
        price,
      },
    };
  }

  return {
    async read(jobId) {
      const job = await deps.jobs.get(jobId);
      const found = await deps.turns.getTurnByJob(jobId);
      if (job === undefined || found === undefined) return undefined;
      return readFrom(job, found.turn, found.session);
    },
    async findByRequest(clientRequestId) {
      const found = await deps.jobs.findImplementerTurn(clientRequestId);
      if (found === undefined) return undefined;
      return {
        jobId: found.job.id,
        ...(await readFrom(found.job, found.turn, found.session)),
      };
    },
  };
}
