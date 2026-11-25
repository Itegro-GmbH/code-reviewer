// SPDX-License-Identifier: LicenseRef-Proprietary

import { z } from "zod";
import { defineTool, type FactoryTool } from "../define.ts";
import {
  FINISHED_RUN_STATUSES,
  laneOfRun,
  runAnswer,
  runService,
  workflowRunsService,
} from "./services.ts";

/** The longest a call waits: a request of the endpoint is one HTTP call, so it stays well inside the time a host allows. */
export const WAIT_MAX_SECONDS = 55;
export const WAIT_DEFAULT_SECONDS = 30;
export const POLL_MS = 2000;

export type WaitClock = {
  sleep(ms: number): Promise<void>;
  now(): number;
};

const realClock: WaitClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** `wait_for_run` over a clock (tests pass their own). */
export function createWaitForRun(clock: WaitClock = realClock): FactoryTool {
  return defineTool({
    name: "wait_for_run",
    title: "Wait for a run",
    description:
      "Waits for a run (at most `timeoutSeconds`, 55 at most) and returns when it finished (`reason: finished`: succeeded, failed, cancelled or discarded), or needs an answer (`reason: needs_input`, with `waitingFor`: use `answer_run`), or the time is over (`reason: timeout`, the run goes on: call again). The answer is the run as `get_run` gives it.",
    scope: "factory:read",
    action: "start_implementer_task",
    input: {
      runId: z.string().min(1).max(128).describe("The id of the run."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(WAIT_MAX_SECONDS)
        .optional()
        .describe(
          `How long to wait at most (default ${WAIT_DEFAULT_SECONDS}).`,
        ),
    },
    async handler(context, args) {
      const laneId = await laneOfRun(context, args.runId);
      const service = context.services.use(workflowRunsService);
      const deadline =
        clock.now() + (args.timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000;
      for (;;) {
        const run = await runService(() => service.get(laneId, args.runId));
        const answer = runAnswer(context, run);
        if ((FINISHED_RUN_STATUSES as readonly string[]).includes(run.status))
          return { ...answer, reason: "finished" };
        if (
          run.status === "waiting" ||
          (answer.waitingFor as unknown[]).length > 0
        )
          return { ...answer, reason: "needs_input" };
        const left = deadline - clock.now();
        if (left <= 0) return { ...answer, reason: "timeout" };
        await clock.sleep(Math.min(POLL_MS, left));
      }
    },
  });
}

export const waitForRun = createWaitForRun();
