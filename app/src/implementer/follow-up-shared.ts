// SPDX-License-Identifier: LicenseRef-Proprietary

// The starter of queued instructions as the running server has it (#841): the real database and the Implementer service of each
// workspace. The routes that end a turn call `startQueuedFollowUps()` after their response, and the cron route hands the starter to the
// sweep as a step. Only routes (`src/app`) import this module: the queues and the sweep are imported by the Implementer, so they cannot
// import it back (`src/ci/import-cycles`).
import "server-only";
import { getCapabilities } from "../capabilities/shared.ts";
import { sessionsWithQueuedInstruction } from "../db/repositories/implementer-sessions-sweep.ts";
import { getDatabase } from "../db/startup.ts";
import {
  createQueuedFollowUpStarter,
  type QueuedFollowUpStarter,
} from "./follow-up-starter.ts";
import { implementerServiceFor } from "./shared.ts";

export function getQueuedFollowUpStarter(): QueuedFollowUpStarter {
  return createQueuedFollowUpStarter({
    due: (limit) => sessionsWithQueuedInstruction(getDatabase(), limit),
    // The service of the instruction's workspace on that workspace's job queue, which wakes the Dispatcher like any submit.
    start: (workspaceId, sessionId) =>
      implementerServiceFor(workspaceId).startQueued(sessionId),
  });
}

/**
 * Starts the instructions that waited for a turn which has just ended. Called by the routes that end a turn, after their response, and
 * never rejects (a failure is counted and logged by the starter). A deployment without the capability has none.
 */
export async function startQueuedFollowUps(): Promise<void> {
  if (!getCapabilities().has("implementer")) return;
  await getQueuedFollowUpStarter().startDue();
}
