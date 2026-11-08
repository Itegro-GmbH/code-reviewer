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

/**
 * The runs that run (or wait and were asked to stop, or wait with a question that is shown nowhere yet) and were last touched before
 * `olderThan`, the ones that waited longest first, at most `limit`.
 */
export async function dueWorkflowRuns(
  db: Kysely<Database>,
  options: { olderThan: string; limit: number },
): Promise<DueWorkflowRun[]> {
  const rows = await db
    .selectFrom("workflow_runs")
    .select(["id", "workspace_id"])
    // #920: a run that waits for an answer has nothing to do, unless somebody asked it to stop or its question has no comment yet (it is
    // announced again, which the marker of the comment makes harmless).
    .where((eb) =>
      eb.or([
        eb("status", "=", "running"),
        eb.and([
          eb("status", "=", "waiting"),
          eb.or([
            eb("cancel_requested_at", "is not", null),
            eb.exists(
              eb
                .selectFrom("workflow_step_runs")
                .select("workflow_step_runs.id")
                .whereRef("workflow_step_runs.run_id", "=", "workflow_runs.id")
                .where("workflow_step_runs.status", "=", "waiting")
                .where("workflow_step_runs.waiting_on_comment_id", "is", null)
                // The engine stopped announcing it (`StepAsk.announce.ended`): a key of ours, since the quotes inside a text of the
                // agent are escaped in the stored JSON and never form this.
                .where((step) =>
                  step.or([
                    step("workflow_step_runs.ask", "is", null),
                    step("workflow_step_runs.ask", "not like", '%"ended":%'),
                  ]),
                ),
            ),
          ]),
        ]),
      ]),
    )
    .where("updated_at", "<", options.olderThan)
    .orderBy("updated_at")
    .limit(options.limit)
    .execute();
  return rows.map((row) => ({ workspaceId: row.workspace_id, runId: row.id }));
}
