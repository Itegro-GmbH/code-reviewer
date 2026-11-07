// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Issues tab of a project needs from the server (#925): the project the address names, the first list of its tickets (the board
// polls from there) and the lanes a person can start from an issue. A repository that is no project, or whose tickets are not mirrored
// yet, has no list: the tab says so. Everything is read through the services, so a test hands in fakes.
import type { ProjectService } from "../projects/service.ts";
import { TrackerError } from "../tracker/errors.ts";
import type { TicketList, TrackerService } from "../tracker/service.ts";
import type { WorkflowService } from "../workflows/service.ts";
import { ISSUES_LISTED } from "./api.ts";
import { startLaneOf, type StartLane } from "./start-lanes.ts";

export type IssuesPageData = {
  /** The project of the repository, or null when the repository is no project. */
  projectId: string | null;
  /** The first list, or null when the tickets are not mirrored (no active project, or no repository). */
  initial: TicketList | null;
  lanes: StartLane[];
};

export async function loadIssuesPage(
  repositoryId: string,
  deps: {
    projects: Pick<ProjectService, "findProject">;
    tracker: Pick<TrackerService, "listIssues">;
    workflows: Pick<WorkflowService, "list" | "get">;
  },
): Promise<IssuesPageData> {
  const entry = await deps.projects.findProject(repositoryId);
  const projectId = entry?.project?.id ?? null;
  if (projectId === null) return { projectId: null, initial: null, lanes: [] };
  let initial: TicketList | null = null;
  try {
    initial = await deps.tracker.listIssues(repositoryId, {
      state: "all",
      limit: ISSUES_LISTED,
      offset: 0,
    });
  } catch (error) {
    if (!(error instanceof TrackerError)) throw error;
  }
  const lanes: StartLane[] = [];
  for (const workflow of (await deps.workflows.list(projectId)).workflows) {
    if (workflow.archivedAt !== null) continue;
    try {
      const view = await deps.workflows.get(workflow.id);
      const lane = startLaneOf(workflow.id, workflow.name, view.document);
      if (lane !== undefined) lanes.push(lane);
    } catch {
      // A lane that cannot be read is not offered; the Lanes tab shows it.
    }
  }
  return { projectId, initial, lanes };
}
