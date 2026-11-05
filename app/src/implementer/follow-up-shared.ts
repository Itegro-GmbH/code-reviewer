// SPDX-License-Identifier: LicenseRef-Proprietary

// The starter of queued instructions as the running server has it (#841): the real database, one job queue for each workspace that wakes
// the Dispatcher, and the Implementer service of that workspace. The queues of the server call `startQueuedFollowUps()` after a claim
// ended, and the cron sweep calls it as a step. It builds its queue itself and does not import `jobs/shared.ts` (which imports this
// module).
import "server-only";
import { getCapabilities } from "../capabilities/shared.ts";
import { sessionsWithQueuedInstruction } from "../db/repositories/implementer-sessions-sweep.ts";
import { getDatabase } from "../db/startup.ts";
import { dispatchHook } from "../dispatch/shared.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import {
  createQueuedFollowUpStarter,
  type QueuedFollowUpStarter,
} from "./follow-up-starter.ts";
import { implementerServiceWith } from "./service-wiring.ts";

export function getQueuedFollowUpStarter(): QueuedFollowUpStarter {
  const db = getDatabase();
  const capabilities = getCapabilities();
  return createQueuedFollowUpStarter({
    due: (limit) => sessionsWithQueuedInstruction(db, limit),
    start: (workspaceId, sessionId) => {
      const dispatch = dispatchHook();
      const queue = createJobQueue(db, workspaceId, {
        onEnqueued: (result) => dispatch?.(result),
        kindAllowed: (kind) => capabilities.allowsReviewKind(kind),
      });
      return implementerServiceWith(workspaceId, queue).startQueued(sessionId);
    },
  });
}

/**
 * Starts the instructions that waited for a turn which has just ended. Called after the commit that ended it, scheduled after the
 * response; a deployment without the capability has none. Never rejects.
 */
export async function startQueuedFollowUps(): Promise<void> {
  if (!getCapabilities().has("implementer")) return;
  await getQueuedFollowUpStarter().startDue();
}
