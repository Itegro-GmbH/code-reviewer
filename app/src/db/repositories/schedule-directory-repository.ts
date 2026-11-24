// SPDX-License-Identifier: LicenseRef-Proprietary

// The workspaces that have a lane with a schedule trigger (#1140), seen from outside every workspace. INSTANCE LEVEL, on purpose: the
// hourly tick that starts scheduled runs goes over all workspaces, and only has to know WHICH ones have something to look at. It reads
// workspace ids and nothing else; the lanes, their documents and everything done for them go through repositories created for that
// workspace (`workflows-repository.ts`, `listWithScheduleTrigger`).
import "server-only";
import type { Kysely } from "kysely";
import { encodeBoolean } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type ScheduleDirectory = {
  /**
   * The ids of the workspaces that have a lane that is not archived, in an active project, whose current version's document names a
   * schedule trigger. A text match, like the lane list that follows it (a document that only mentions the word comes back too); the
   * ids are in a fixed order.
   */
  listWorkspaces(): Promise<string[]>;
};

export function createScheduleDirectory(
  db: Kysely<Database>,
): ScheduleDirectory {
  return {
    async listWorkspaces() {
      const rows = await db
        .selectFrom("workflows")
        .innerJoin("projects", "projects.id", "workflows.project_id")
        .innerJoin("workflow_versions", (join) =>
          join
            .onRef(
              "workflow_versions.workspace_id",
              "=",
              "workflows.workspace_id",
            )
            .onRef("workflow_versions.workflow_id", "=", "workflows.id")
            .onRef(
              "workflow_versions.version",
              "=",
              "workflows.current_version",
            ),
        )
        .select("workflows.workspace_id")
        .distinct()
        .where("workflows.archived_at", "is", null)
        .where("projects.active", "=", encodeBoolean(true))
        .where("workflow_versions.document", "like", '%"schedule"%')
        .orderBy("workflows.workspace_id")
        .execute();
      return rows.map((row) => row.workspace_id);
    },
  };
}
