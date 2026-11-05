// SPDX-License-Identifier: LicenseRef-Proprietary

// Keeps the sessions of the Implementer from staying `running` when their turn is over (#752, a finding of the review of #751).
// The status of a turn is the status of its job, but the status of its SESSION is only `recordTurnResult`, which the completion
// of a turn calls when the runner reports. A job can also end WITHOUT a report: the lease ran out, the runner was shut down or
// the Dispatcher never started it, no capable runner claimed it, the claim was refused, its holder cancelled it. Nobody calls
// `recordTurnResult` then, so the session would stay `running` for good and refuse the next turn.
//
// Instance level on purpose, like the code that ends jobs (usage-records-sweep.ts, which calls this): one statement over the
// sessions that are `running`, whatever the workspace. It changes no field but the status and the time, so a result that a later
// report records (head commit, summary, the saved OpenCode session) is still recorded by `recordTurnResult` in full, and a report
// that arrives late for a job that is settled already changes nothing in the session, as before.
import "server-only";
import { sql, type Kysely } from "kysely";
import type { Database } from "../schema.ts";

/**
 * Sets `idle` every `running` session that has no turn whose job is still waiting or running. Returns how many. A database
 * without Implementer sessions (code-review.com's) has none, so the statement reads an empty table.
 */
export async function idleSessionsOfEndedTurns(
  executor: Kysely<Database>,
  at: string,
): Promise<number> {
  const result = await executor
    .updateTable("implementer_sessions")
    .set({ status: "idle", updated_at: at })
    // A literal, not a bound value, like the sweeps of the usage records.
    .where("status", "=", sql.lit("running"))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("implementer_turns")
            .innerJoin("jobs", "jobs.id", "implementer_turns.job_id")
            .select("implementer_turns.id")
            .whereRef(
              "implementer_turns.session_id",
              "=",
              "implementer_sessions.id",
            )
            .where("jobs.status", "in", ["queued", "running"]),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** A session whose queued instruction waits for a start (#841). */
export type DueFollowUp = { workspaceId: string; sessionId: string };

/**
 * The idle sessions that hold a queued instruction (#841), whatever the workspace, oldest first, at most `limit`. A turn that ends
 * starts the instruction itself, right after its report; this finds the ones that event did not reach (the process was stopped, the
 * platform could not be asked, the turn ended without a report). Instance level like the sweep above: it reads nothing but the ids.
 */
export async function sessionsWithQueuedInstruction(
  executor: Kysely<Database>,
  limit: number,
): Promise<DueFollowUp[]> {
  const rows = await executor
    .selectFrom("implementer_sessions")
    .select(["workspace_id", "id"])
    .where("status", "=", sql.lit("idle"))
    .where("queued_instruction", "is not", null)
    .orderBy("updated_at")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    sessionId: row.id,
  }));
}
