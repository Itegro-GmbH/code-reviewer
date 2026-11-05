// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the turn a job runs for the engine (#844): its id, and, once the job is over, everything the outcome of the step is made from
// (the final status and code of the job, what the runner reported, the turn with its stored result, the session). One reader for the
// running server and the tests.
import type { ImplementerRepository } from "../db/repositories/implementer-repository.ts";
import type { JobsRepository } from "../db/repositories/jobs-repository.ts";
import type { TurnRead } from "./engine.ts";

const OVER = ["succeeded", "failed", "superseded", "cancelled"] as const;
type OverStatus = (typeof OVER)[number];

function isOver(status: string): status is OverStatus {
  return OVER.some((candidate) => candidate === status);
}

export function createTurnReader(deps: {
  jobs: Pick<JobsRepository, "get">;
  turns: Pick<ImplementerRepository, "getTurnByJob">;
}): { read(jobId: string): Promise<TurnRead | undefined> } {
  return {
    async read(jobId) {
      const job = await deps.jobs.get(jobId);
      const found = await deps.turns.getTurnByJob(jobId);
      if (job === undefined || found === undefined) return undefined;
      return {
        turnId: found.turn.id,
        ended: isOver(job.status)
          ? {
              jobStatus: job.status,
              jobErrorCode: job.errorCode,
              jobResult: job.result,
              turn: found.turn,
              session: found.session,
            }
          : undefined,
      };
    },
  };
}
