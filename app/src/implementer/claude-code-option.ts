// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the harness `claude-code` can log in for a workspace (#1150), for the model list of the Implementer: the Claude Code OAuth token the
// workspace keeps in the app (any model Claude Code reads: the aliases `sonnet`, `opus`, `haiku`), and the logins of the devices of its
// online self-hosted runners (the models each announces; none listed means any). A runner that announces the harness only as able to run on the
// token of the workspace (`app-key`) adds nothing of its own: it has no login. Pure over what it is given.
import type { OnlineRunner } from "../runner-identity/announced.ts";
import {
  CLAUDE_CODE_SUBSCRIPTION_MODELS,
  type ClaudeCodeOption,
} from "./models.ts";
import { CLAUDE_CODE_HARNESS } from "../runner-identity/harness.ts";

export async function claudeCodeOptionFor({
  token,
  runners,
}: {
  /** Whether the workspace has a Claude Code OAuth token it can use. */
  token(): Promise<boolean>;
  /** The online runners of the workspace with what each announces. */
  runners(): Promise<readonly OnlineRunner[]>;
}): Promise<ClaudeCodeOption | null> {
  const models: string[] = [];
  const add = (names: readonly string[]) => {
    for (const name of names) if (!models.includes(name)) models.push(name);
  };
  const withToken = await token();
  if (withToken) add(CLAUDE_CODE_SUBSCRIPTION_MODELS);
  let withRunner = false;
  for (const runner of await runners())
    for (const entry of runner.access) {
      if (
        entry.harness !== CLAUDE_CODE_HARNESS ||
        entry.auth !== "subscription"
      )
        continue;
      withRunner = true;
      add(entry.models ?? CLAUDE_CODE_SUBSCRIPTION_MODELS);
    }
  if (!withToken && !withRunner) return null;
  return {
    harness: CLAUDE_CODE_HARNESS,
    models,
    source:
      withToken && withRunner
        ? "both"
        : withToken
          ? "workspace_token"
          : "runner_login",
  };
}
