// SPDX-License-Identifier: LicenseRef-Proprietary

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool } from "../define.ts";
import { runAnswer, runService, workflowRunsService } from "./services.ts";

/** What the run list shows as the one who started it: the person and the app, short (display only, the app decides nothing by it). */
const STARTED_BY_MAX = 100;

export const startRun = defineTool({
  name: "start_run",
  title: "Start a lane run",
  description:
    "Starts a run of a saved lane by hand (a lane with a manual or api trigger) and returns the run, its address in the web app and what it waits for. `input` is what the trigger's input declares (for example a `ticket` or a `repo`); a wrong one answers `invalid_input` listing every problem. Pass a `clientRequestId` you keep, so asking again after a lost answer returns the same run instead of starting a second one. Then follow it with `wait_for_run`.",
  scope: "factory:control",
  action: "start_implementer_task",
  input: {
    laneId: z
      .string()
      .min(1)
      .max(128)
      .describe("The id of the lane (workflow)."),
    trigger: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "The id of the manual or api trigger. Needed only when the lane has several that can be started by hand.",
      ),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The values of the trigger's input, as an object. Left out for a trigger that declares no input.",
      ),
    clientRequestId: z
      .string()
      .regex(
        /^[\x21-\x7e]{1,200}$/,
        "1 to 200 printable ASCII characters, no space",
      )
      .optional()
      .describe(
        "Your own id for this start. The same id with the same body returns the run it made before; with another body it is `conflict`. Generated when left out.",
      ),
  },
  async handler(context, args) {
    const service = context.services.use(workflowRunsService);
    const started = await runService(() =>
      service.start(
        {
          id: context.user.id,
          githubLogin: context.actor.label.slice(0, STARTED_BY_MAX),
        },
        args.laneId,
        {
          ...(args.trigger === undefined ? {} : { trigger: args.trigger }),
          input: args.input ?? {},
          clientRequestId: args.clientRequestId ?? randomUUID(),
        },
      ),
    );
    return { ...runAnswer(context, started.run), created: started.created };
  },
});
