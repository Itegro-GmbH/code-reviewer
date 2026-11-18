// SPDX-License-Identifier: LicenseRef-Proprietary

// The note on the page of an agent run (Implementer) that is a step of a lane run (#1080, epic #1077): which lane and step it belongs to
// and the way back to the run page of the lane, opened at that step (`?step=`). The lookup is the run service's (`laneStepOfAgentRun`, the
// workspace's own steps only), and the page that mounts this passes its result; a run no lane started has no note. The lane's name
// and the step id are words of the lane's author: rendered as text, in the link only as an encoded path segment and query value.
import Link from "next/link";
import { Button } from "../components/button.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { workspacePath } from "../workspaces/paths.ts";
import type { LaneStepOfAgentRunView } from "../workflow-runs/service.ts";
import { AGENT_RUN_LANE_COPY as COPY } from "./messages.ts";

/** The run page of the lane run, opened at the step. */
export function laneRunStepPath(
  workspaceSlug: string,
  step: LaneStepOfAgentRunView,
): string {
  return `${workspacePath(
    workspaceSlug,
    `/workflows/${encodeURIComponent(step.workflowId)}/runs/${encodeURIComponent(step.runId)}`,
  )}?step=${encodeURIComponent(step.stepId)}`;
}

export function AgentRunLaneNotice({
  workspaceSlug,
  step,
}: {
  workspaceSlug: string;
  step: LaneStepOfAgentRunView;
}) {
  return (
    <Alert
      variant="info"
      role="status"
      aria-label={COPY.label}
      className="mb-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="m-0 break-words">
        {COPY.belongsTo(step.laneName, step.stepId)}
      </p>
      <Button asChild variant="secondary" size="sm">
        <Link href={laneRunStepPath(workspaceSlug, step)}>{COPY.open}</Link>
      </Button>
    </Alert>
  );
}
