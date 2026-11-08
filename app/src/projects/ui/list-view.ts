// SPDX-License-Identifier: LicenseRef-Proprietary

// What the project list shows, worked out from the project service: one row per repository the
// GitHub App can read (plus the ones that disappeared but kept a project), with its installation,
// its state and the status of its last run. Plain data: the components render it and the page only
// wires the services in, so nothing here depends on Next.js.
import type {
  ProjectListEntry,
  ProjectStatus,
} from "../../db/repositories/projects-repository.ts";
import type { ProjectService } from "../service.ts";
import type { JobStatus } from "../../db/job-status.ts";
import { webAddress } from "../../ui/web-address.ts";

export type LastRun = {
  status: JobStatus;
  /** ISO 8601 time the run last changed (finished, or started when it is still going). */
  at: string;
};

/**
 * The last run of each repository, by repository id; a repository without a run is not in the map.
 * The running server uses the jobs table (`getLastRunSource()` in src/runs/shared.ts); without a
 * source the list says "No run yet".
 */
export type LastRunSource = (
  repositoryIds: readonly string[],
) => Promise<ReadonlyMap<string, LastRun>>;

export const noRunsYet: LastRunSource = async () => new Map();

export type ProjectRowView = {
  repositoryId: string;
  /** The id of the project the repository is; none while it is not one yet. */
  projectId: string | null;
  fullName: string;
  /** The repository's address at the platform when it is a web address, otherwise null. */
  url: string | null;
  /** The installation the repository comes from (the account that installed the app). */
  installation: string;
  status: ProjectStatus;
  /** Whether the project is switched on (also for a repository that is unavailable). */
  switchedOn: boolean;
  lastRun: LastRun | null;
};

export type ProjectListView = { rows: ProjectRowView[] };

function toRowView(
  { repository, project, status }: ProjectListEntry,
  lastRun: LastRun | null,
): ProjectRowView {
  return {
    repositoryId: repository.id,
    projectId: project?.id ?? null,
    fullName: repository.fullName,
    url: webAddress(repository.url),
    installation: repository.integration.displayName,
    status,
    switchedOn: project?.active ?? false,
    lastRun,
  };
}

export async function loadProjectList(deps: {
  projects: Pick<ProjectService, "listProjects">;
  lastRuns?: LastRunSource;
}): Promise<ProjectListView> {
  const entries = await deps.projects.listProjects();
  const lastRuns = await (deps.lastRuns ?? noRunsYet)(
    entries.map((entry) => entry.repository.id),
  );
  return {
    rows: entries.map((entry) =>
      toRowView(entry, lastRuns.get(entry.repository.id) ?? null),
    ),
  };
}

/** One row of the list (without the status of its last run), or undefined for an unknown repository. */
export async function loadProjectRow(
  repositoryId: string,
  deps: { projects: Pick<ProjectService, "findProject"> },
): Promise<ProjectRowView | undefined> {
  const entry = await deps.projects.findProject(repositoryId);
  return entry === undefined ? undefined : toRowView(entry, null);
}
