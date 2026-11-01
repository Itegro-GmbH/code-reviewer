// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the LLM keys that were handed to runners with the claim of a job (the table `job_claimed_keys`,
// src/runner-api/claimed-keys.ts). Instance level, like the lease side of the queue: runners serve the whole
// instance, and the one reader (completing a job) holds the job and knows the job's workspace. This module only
// moves sealed rows; the encryption is in the caller.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

export type JobClaimedKeyRow = {
  jobId: string;
  ciphertext: string;
  nonce: string;
  keyVersion: number;
};

/** A turn of the Implementer as far as the write tokens of its claims are concerned (#753). */
export type TokenJob = {
  id: string;
  reviewKind: "implementer";
  workspaceId: string;
  repositoryId: string;
};

export type JobClaimedKeysRepository = {
  get(jobId: string): Promise<JobClaimedKeyRow | undefined>;
  /**
   * The row of the job, locked until the end of the transaction (`FOR UPDATE`), so that a read-modify-write of its content cannot
   * lose a concurrent one (#753). Only meaningful inside a transaction; the row must exist (`putIfAbsent` first).
   */
  getForUpdate(jobId: string): Promise<JobClaimedKeyRow | undefined>;
  /** Inserts the row unless the job has one already. Answers nothing: the caller locks and reads the row that is there. */
  putIfAbsent(row: JobClaimedKeyRow): Promise<void>;
  /** Inserts the key of the job or replaces it (a later claim of the same job). */
  put(row: JobClaimedKeyRow): Promise<void>;
  /** Of these jobs, the turns of the Implementer (#753). */
  implementerJobs(jobIds: readonly string[]): Promise<TokenJob[]>;
  /**
   * The turns of the Implementer that ended at or after `since` and have a row (#753): the ones whose write tokens may still be
   * waiting to be switched off. At most `limit`, oldest first.
   */
  endedImplementerJobsWithRows(since: Date, limit: number): Promise<TokenJob[]>;
  /** Removes the keys of the jobs that finished at or before `cutoff`. Returns how many. */
  deleteFinishedBefore(cutoff: Date): Promise<number>;
};

function tokenJobOf(row: {
  id: string;
  workspace_id: string;
  repository_id: string;
}): TokenJob {
  return {
    id: row.id,
    reviewKind: "implementer",
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
  };
}

export function createJobClaimedKeysRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): JobClaimedKeysRepository {
  return {
    async get(jobId) {
      const row = await db
        .selectFrom("job_claimed_keys")
        .selectAll()
        .where("job_id", "=", jobId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            jobId: row.job_id,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            keyVersion: row.key_version,
          };
    },

    async getForUpdate(jobId) {
      const row = await db
        .selectFrom("job_claimed_keys")
        .selectAll()
        .where("job_id", "=", jobId)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            jobId: row.job_id,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            keyVersion: row.key_version,
          };
    },

    async putIfAbsent(row) {
      await db
        .insertInto("job_claimed_keys")
        .values({
          job_id: row.jobId,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          key_version: row.keyVersion,
          created_at: formatTimestamp(now()),
        })
        .onConflict((conflict) => conflict.column("job_id").doNothing())
        .execute();
    },

    async implementerJobs(jobIds) {
      if (jobIds.length === 0) return [];
      const rows = await db
        .selectFrom("jobs")
        .select(["id", "workspace_id", "repository_id"])
        .where("id", "in", [...jobIds])
        .where("review_kind", "=", "implementer")
        .execute();
      return rows.map(tokenJobOf);
    },

    async endedImplementerJobsWithRows(since, limit) {
      const rows = await db
        .selectFrom("jobs")
        .innerJoin("job_claimed_keys", "job_claimed_keys.job_id", "jobs.id")
        .select(["jobs.id", "jobs.workspace_id", "jobs.repository_id"])
        .where("jobs.review_kind", "=", "implementer")
        .where("jobs.finished_at", ">=", formatTimestamp(since))
        .orderBy("jobs.finished_at")
        .limit(limit)
        .execute();
      return rows.map(tokenJobOf);
    },

    async put(row) {
      const created_at = formatTimestamp(now());
      await db
        .insertInto("job_claimed_keys")
        .values({
          job_id: row.jobId,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          key_version: row.keyVersion,
          created_at,
        })
        .onConflict((conflict) =>
          conflict.column("job_id").doUpdateSet({
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            key_version: row.keyVersion,
            created_at,
          }),
        )
        .execute();
    },

    async deleteFinishedBefore(cutoff) {
      // ISO 8601 UTC text sorts like time, so the comparison is done on the text.
      const result = await db
        .deleteFrom("job_claimed_keys")
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.finished_at", "<=", formatTimestamp(cutoff)),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}
