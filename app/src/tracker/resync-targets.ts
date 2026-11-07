// SPDX-License-Identifier: LicenseRef-Proprietary

// Which projects the nightly resync walks (#932): the active projects of the workspaces whose installation is active. Every read goes
// through the repositories of the project's own workspace (`shared.ts` wires them); a workspace whose projects cannot be read is
// logged and left out, the others still run.
import type { ProjectListEntry } from "../db/repositories/projects-repository.ts";
import type { TrackerSyncState } from "../db/repositories/tracker-repository.ts";
import type { Integration } from "../integrations/types.ts";

/** An active project whose repository the mirror holds. */
export type ResyncTarget = {
  workspaceId: string;
  repositoryId: string;
  /** The installation the repository belongs to: what a rate limit of the platform is counted against. */
  integrationId: string;
  /** When its sync state was last written (ISO 8601): the last page of a sync, or its end; null for a project never synced. */
  lastAttemptAt: string | null;
  /** True when its last sync did not end (a cursor is left: the budget ran out or the platform failed). */
  unfinished: boolean;
};

export type ResyncTargetDependencies = {
  integrations: () => Promise<Pick<Integration, "workspaceId" | "status">[]>;
  projectsOf: (workspaceId: string) => Promise<ProjectListEntry[]>;
  syncStateOf: (
    workspaceId: string,
    repositoryId: string,
  ) => Promise<TrackerSyncState | undefined>;
  logFailure?: (line: string) => void;
};

export async function listResyncTargets(
  deps: ResyncTargetDependencies,
): Promise<ResyncTarget[]> {
  const logFailure = deps.logFailure ?? ((line: string) => console.error(line));
  const workspaces = new Set(
    (await deps.integrations())
      .filter((integration) => integration.status === "active")
      .map((integration) => integration.workspaceId),
  );
  const targets: ResyncTarget[] = [];
  for (const workspaceId of workspaces) {
    try {
      for (const entry of await deps.projectsOf(workspaceId)) {
        if (
          entry.status !== "active" ||
          entry.repository.integration.status !== "active"
        )
          continue;
        const state = await deps.syncStateOf(workspaceId, entry.repository.id);
        targets.push({
          workspaceId,
          repositoryId: entry.repository.id,
          integrationId: entry.repository.integration.id,
          lastAttemptAt: state?.updatedAt ?? null,
          unfinished: state?.cursor != null,
        });
      }
    } catch {
      logFailure(
        `[tracker] TRACKER_RESYNC_WORKSPACE_FAILED: the projects of workspace=${workspaceId} could not be listed; the other workspaces go on.`,
      );
    }
  }
  return targets;
}
