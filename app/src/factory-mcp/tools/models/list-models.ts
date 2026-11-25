// SPDX-License-Identifier: LicenseRef-Proprietary

import { defineTool } from "../define.ts";
import { modelsService } from "./services.ts";

export const listModels = defineTool({
  name: "list_models",
  title: "List models",
  description:
    'The models a lane step\'s `model` can name in this workspace. `keyMode: "own"`: `providers`, each with its catalog models, step form `{ "provider": "<id>", "model": "<model id>" }`. `keyMode: "managed"`: `entries` the platform runs, step form `{ "entryId": "<id>" }`. `claudeCode`, when present, says the harness `claude-code` can log in here (a Claude Code token of the workspace and/or an online runner\'s login; `source`) and its model names, step form `{ "provider": "claude-code", "model": "<name>" }` with `"harness": "claude-code"` on a self-hosted runner. `keyMode: "unreadable"` means nothing is offered.',
  scope: "factory:read",
  action: "start_implementer_task",
  input: {},
  async handler(context) {
    return { ...(await context.services.use(modelsService).options()) };
  },
});
