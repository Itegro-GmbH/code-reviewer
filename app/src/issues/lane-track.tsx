// SPDX-License-Identifier: LicenseRef-Proprietary

// The compact step track of the lane run that is on a ticket (#1080, epic #1077): the track of the Runs list (`workflow-pages/run-track`),
// drawn from the nodes (once for each lane version, `TicketList.laneNodes`, #1087) and the step summaries the list of tickets carries for each active run, so the board needs no read for each ticket.
// The board and the drawer both draw it, and both link to the run page of the lane (`laneRunPath`).
import { RunTrackView } from "../workflow-pages/run-track.tsx";
import { trackOf } from "../workflow-pages/run-track.ts";
import type { TicketLane, TicketList } from "../tracker/service.ts";
import { laneNodesFor } from "../workflow-runs/lane-nodes.ts";
import { workspacePath } from "../workspaces/paths.ts";

/**
 * The run page of the lane run on a ticket: the address the Runs list links to, opened at the step the run is at (`?step=`), so the page
 * lands where the work is. A run with no step yet opens at the page's own default.
 */
export function laneRunPath(workspaceSlug: string, lane: TicketLane): string {
  const path = workspacePath(
    workspaceSlug,
    `/workflows/${encodeURIComponent(lane.workflowId)}/runs/${encodeURIComponent(lane.runId)}`,
  );
  return lane.step === null
    ? path
    : `${path}?step=${encodeURIComponent(lane.step)}`;
}

/** The track of the run, or nothing when the lane version of the run cannot be read (no nodes to draw it on). */
export function LaneTrack({
  lane,
  laneNodes,
}: {
  lane: TicketLane;
  /** Absent in the response of an older server (#1087): no track then. */
  laneNodes: TicketList["laneNodes"] | undefined;
}) {
  const nodes = laneNodesFor(laneNodes, lane.nodesKey);
  if (nodes.length === 0) return null;
  return <RunTrackView track={trackOf(nodes, lane.steps, lane.status)} />;
}
