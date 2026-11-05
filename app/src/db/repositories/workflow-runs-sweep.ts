// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow runs that run and were not looked at for a while (#844), for the reconciler of the workflow engine. Instance level on
// purpose (`scoping.test.ts`, `README.md` "Workspace scoping"): a job can end without anybody reporting it (its lease ran out, a
// Dispatcher never started it), so no event reaches the engine, and the sweep that serves the whole instance asks for the runs that
// may be waiting for such a job. It only reads and every answer names its workspace; the engine then works through the scoped
// workflow runs repository of that workspace.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

export type DueWorkflowRun = { workspaceId: string; runId: string };

/** The runs that run and were last touched before `olderThan`, the ones that waited longest first, at most `limit`. */
export async function dueWorkflowRuns(
  db: Kysely<Database>,
  options: { olderThan: string; limit: number },
): Promise<DueWorkflowRun[]> {
  const rows = await db
    .selectFrom("workflow_runs")
    .select(["id", "workspace_id"])
    .where("status", "=", "running")
    .where("updated_at", "<", options.olderThan)
    .orderBy("updated_at")
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ workspaceId: row.workspace_id, runId: row.id }));
}
