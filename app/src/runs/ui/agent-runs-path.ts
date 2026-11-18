// SPDX-License-Identifier: LicenseRef-Proprietary

// The address of the Agent runs tab of the Runs page (#1078). With the capability `implementer` the page opens on the Lane runs tab, and
// the Agent runs tab is `?view=agents`; every link to the agent runs, and every filter written into their address, has to carry it, or
// it lands on the other tab. Without the capability the page is the agent runs whatever `view` says, so the parameter does no harm.
import { workspacePath } from "../../workspaces/paths.ts";

/** The `view` of the Agent runs tab. */
export const AGENT_RUNS_VIEW = "agents";

/** The Agent runs tab of a workspace, with the filter in `params` (project as `repository`, and `status`). */
export function agentRunsPath(
  workspaceSlug: string,
  params: Record<string, string | undefined> = {},
): string {
  const query = [
    ["view", AGENT_RUNS_VIEW],
    ...Object.entries(params).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  ]
    .map(([name, value]) => `${name}=${encodeURIComponent(value ?? "")}`)
    .join("&");
  return `${workspacePath(workspaceSlug, "/runs")}?${query}`;
}
