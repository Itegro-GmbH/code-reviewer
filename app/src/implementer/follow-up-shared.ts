// SPDX-License-Identifier: LicenseRef-Proprietary

// The starter of queued instructions as the running server has it (#841): the real database and the Implementer service of each
// workspace. The hook at the end of a turn (`workflow-runs/shared.ts`, beside the workflow engine's) calls `startQueuedFollowUps()` after the response, and the cron route hands the starter to the
// sweep as a step. Only routes (`src/app`) import this module: the queues and the sweep are imported by the Implementer, so they cannot
// import it back (`src/ci/import-cycles`).
import "server-only";
import { getCapabilities } from "../capabilities/shared.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { sessionsWithQueuedInstruction } from "../db/repositories/implementer-sessions-sweep.ts";
import { getDatabase } from "../db/startup.ts";
import type { Job } from "../jobs/job-types.ts";
import {
  createQueuedFollowUpStarter,
  type QueuedFollowUpStarter,
} from "./follow-up-starter.ts";
import { implementerServiceFor } from "./shared.ts";

export function getQueuedFollowUpStarter(): QueuedFollowUpStarter {
  return createQueuedFollowUpStarter({
    due: (limit, retryAfter) =>
      sessionsWithQueuedInstruction(getDatabase(), limit, retryAfter),
    sessionOfJob: async (workspaceId, jobId) =>
      (
        await createImplementerRepository(
          getDatabase(),
          workspaceId,
        ).getTurnByJob(jobId)
      )?.session.id,
    // The service of the instruction's workspace on that workspace's job queue, which wakes the Dispatcher like any submit.
    start: (workspaceId, sessionId) =>
      implementerServiceFor(workspaceId).startQueued(sessionId),
  });
}

/**
 * Starts the instruction that waited for the turn which has just ended: the one of that turn's session and no other (the sweep takes
 * the rest, with its backoff, so a rate-limited platform is not asked once per event). Called by the hook at the end of a turn, after
 * the response, and never rejects (a failure is counted and logged by the starter). A deployment without the capability has none.
 */
export async function startQueuedFollowUps(
  job: Pick<Job, "id" | "workspaceId">,
): Promise<void> {
  if (!getCapabilities().has("implementer")) return;
  await getQueuedFollowUpStarter().startForJob(job);
}
