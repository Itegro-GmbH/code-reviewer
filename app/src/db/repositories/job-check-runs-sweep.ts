// SPDX-License-Identifier: LicenseRef-Proprietary

// The jobs whose check run on the platform is behind, for the reconciler that serves the whole instance (#405).
// Instance level on purpose, like the sweep of the refusal notices: it reads the rows of every workspace, only the
// ones that are due, and every answer names its workspace; whatever is done next goes through the scoped repository
// (job-check-runs-repository.ts).
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type JobWithCheckWork = { jobId: string; workspaceId: string };

/**
 * Jobs that need a sync, oldest first, at most `limit`, from two reads that each use their own index:
 * - a job with an `active` row whose lease or back-off is over and that is behind: the check run (unless it was
 *   dropped) shows another status than the job has now (a lease that ran out, a timeout, a give-up or a switch-off
 *   ended it without a request of its own), or the job succeeded and its verdict is not decided yet; the retry of a
 *   sync that failed is one of these, so a hosted deployment whose sweep runs every two hours still reaches it;
 * - a waiting or running job that has no row yet (its first sync never started or never finished).
 * A job that ended before it had a row (for example before this feature) is not listed: nothing was ever shown.
 * The two are merged one from each in turn, so neither starves the other when there is a backlog.
 */
export async function listJobsWithCheckWork(
  db: Kysely<Database>,
  now: Date,
  options: { limit: number },
): Promise<JobWithCheckWork[]> {
  const timestamp = formatTimestamp(now);
  const behind = await db
    .selectFrom("job_check_runs")
    .innerJoin("jobs", "jobs.id", "job_check_runs.job_id")
    .select(["jobs.id as jobId", "jobs.workspace_id as workspaceId"])
    // #752: a turn of the Implementer (no pull request) never has a check run, here or below.
    .where("jobs.review_kind", "<>", "implementer")
    .where("job_check_runs.state", "=", "active")
    .where("job_check_runs.next_attempt_at", "<=", timestamp)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("job_check_runs.check_state", "=", "active"),
          eb.or([
            eb("job_check_runs.synced_status", "is", null),
            eb("job_check_runs.synced_status", "<>", eb.ref("jobs.status")),
          ]),
        ]),
        eb.and([
          eb("jobs.status", "=", "succeeded"),
          eb("job_check_runs.review_state", "=", "pending"),
        ]),
      ]),
    )
    .orderBy("job_check_runs.next_attempt_at")
    .orderBy("jobs.id")
    .limit(options.limit)
    .execute();
  const fresh = await db
    .selectFrom("jobs")
    .leftJoin("job_check_runs", "job_check_runs.job_id", "jobs.id")
    .select(["jobs.id as jobId", "jobs.workspace_id as workspaceId"])
    .where("job_check_runs.job_id", "is", null)
    .where("jobs.review_kind", "<>", "implementer")
    .where("jobs.status", "in", ["queued", "running"])
    .orderBy("jobs.updated_at")
    .orderBy("jobs.id")
    .limit(options.limit)
    .execute();
  // One from each read in turn: a backlog of the one never starves the other.
  const merged: JobWithCheckWork[] = [];
  const seen = new Set<string>();
  for (let n = 0; merged.length < options.limit; n += 1) {
    const next = [behind[n], fresh[n]];
    if (next.every((item) => item === undefined)) break;
    for (const item of next) {
      if (item === undefined || seen.has(item.jobId)) continue;
      if (merged.length >= options.limit) break;
      seen.add(item.jobId);
      merged.push({ jobId: item.jobId, workspaceId: item.workspaceId });
    }
  }
  return merged;
}
