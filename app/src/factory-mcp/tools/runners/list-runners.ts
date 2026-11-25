// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import {
  fleetService,
  namedRunnersService,
  runnerAnswer,
  runnerFleetService,
  statusById,
} from "./services.ts";

export const listRunners = defineTool({
  name: "list_runners",
  title: "List runners",
  description:
    'Every runner a lane step can name in its `runner` field: the hosted runners (Vercel Sandbox and Cloudflare Container types of a fixed size; `available`, or `unavailable` for a Cloudflare size the operator switched off) AND the self-hosted runners the workspace registered (machines of its own, not revoked). Each has `id` (use it in `update_lane` as `{ "path": "/steps/1/runner", "value": "<id>" }`), `name`, `kind` (`hosted` or `self_hosted`), `placement`, the size (`vcpus` and `concurrency` for hosted; `labels` and `limits` for self-hosted) and `status` (`available`, or `online`, `update_needed`, `offline` for a self-hosted runner). Use `get_runner` for what a machine announces.',
  scope: "factory:read",
  action: "start_implementer_task",
  input: {},
  async handler(context) {
    const named = context.services.use(namedRunnersService);
    const fleet = context.services.use(runnerFleetService);
    const [runners, status] = await Promise.all([
      named.list(),
      fleetService(() => statusById(fleet)),
    ]);
    return {
      runners: runners.map((runner) => runnerAnswer(runner, status, false)),
    };
  },
});
