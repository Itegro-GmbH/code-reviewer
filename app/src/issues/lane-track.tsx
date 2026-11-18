// SPDX-License-Identifier: LicenseRef-Proprietary

// The compact step track of the lane run that is on a ticket (#1080, epic #1077): the track of the Runs list (`workflow-pages/run-track`),
// drawn from the nodes and the step summaries the list of tickets carries for each active run, so the board needs no read for each ticket.
// The board and the drawer both draw it, and both link to the run page of the lane (`laneRunPath`).
import { RunTrackView } from "../workflow-pages/run-track.tsx";
import { trackOf } from "../workflow-pages/run-track.ts";
import type { TicketLane } from "../tracker/service.ts";
import { workspacePath } from "../workspaces/paths.ts";

/** The run page of the lane run on a ticket: the same address the Runs list links to. */
export function laneRunPath(workspaceSlug: string, lane: TicketLane): string {
  return workspacePath(
    workspaceSlug,
    `/workflows/${encodeURIComponent(lane.workflowId)}/runs/${encodeURIComponent(lane.runId)}`,
  );
}

/** The track of the run, or nothing when the lane version of the run cannot be read (no nodes to draw it on). */
export function LaneTrack({ lane }: { lane: TicketLane }) {
  if (lane.nodes.length === 0) return null;
  return <RunTrackView track={trackOf(lane.nodes, lane.steps, lane.status)} />;
}
