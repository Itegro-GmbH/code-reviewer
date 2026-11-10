// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to `job_rings` (#972): where the doorbell of one job stands for ONE webhook dispatcher of a customer, and which
// (job, dispatcher) pairs there are to ring. The platform's own dispatcher keeps `job_dispatches` (one row per job); a customer's
// dispatchers are many, so a row here is a pair. Instance level, like `job-dispatches-repository.ts`: the sender, the sweep and the events
// serve the whole instance and work from ids they hold. The table holds ids and counters, no repository data. The rules (when to ring,
// what an answer means) are in src/dispatch/; this module only moves rows and answers "which pairs".
//
// Which dispatcher a job can go to is the rule of the claim (`jobs-claim.ts`) written as a join: a turn of a runner environment, a runner
// of the same workspace that announced a webhook, and every label the job requires among the runner's. The harness and the version are
// the service's to judge (a pair that fails is stored as `stopped`, so it is not listed again).
import "server-only";
import { sql, type Kysely } from "kysely";
import {
  DISPATCH_RESULT_CODES,
  DISPATCH_STATES,
  type DispatchResultCode,
  type DispatchState,
  type DispatchUpdate,
} from "../../dispatch/outcome.ts";
import { jobKindOf, type JobKind } from "../../job-kind/job-kind.ts";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import { accessRule, customerAccess } from "../../runner-identity/access.ts";
import {
  labelsFromText,
  manifestFromText,
  type RunnerManifest,
} from "../../runner-identity/announcement.ts";
import {
  WAITING_DISPATCH_CODES,
  WAITING_MIN_GAP_MS,
  type DispatchRow,
} from "./job-dispatches-repository.ts";

/** The address and the key of one dispatcher's doorbell; the secret is still sealed. */
export type RingDelivery = {
  url: string;
  keyId: string;
  /** The sealed secret (`sealDeliverySecret`); opened by the service. */
  sealedSecret: string;
};

/** One job and one dispatcher it could go to. */
export type RingPair = {
  jobId: string;
  reviewKind: JobKind;
  /** The job's lost attempts so far; the call carries the number of the attempt it is on (this plus one). */
  jobAttempts: number;
  runnerId: string;
  baseVersion: string;
  manifest: RunnerManifest;
  delivery: RingDelivery;
};

/** The labels a freed slot of a group can serve: the workspace of the jobs that ended and the labels the group has. */
export type LabelGroup = { workspaceId: string; labels: readonly string[] };

/** What a job that ended tells about the group it frees a slot in. */
export type EndedJobGroup = {
  jobId: string;
  workspaceId: string;
  /** The labels the job required (`cr:` labels dropped); empty for a job that is none of a customer's. */
  requiredLabels: string[];
  /** The labels the runner that held the job announced, when it was a customer's runner. */
  holderLabels: string[];
};

/** A customer's dispatcher that holds a job: where its stop call goes. The secret is still sealed. */
export type HolderDelivery = RingDelivery & { runnerId: string };

export type RunnerDispatchesRepository = {
  get(jobId: string, runnerId: string): Promise<DispatchRow | undefined>;
  /** Makes the row of a pair, unless there is one. Returns whether this call made it. */
  create(
    jobId: string,
    runnerId: string,
    nextDispatchAt: Date,
  ): Promise<boolean>;
  /** Takes the right to ring for everyone else and counts the attempt (a compare and set on `next_dispatch_at`, as `claimSend` of `job_dispatches`). */
  claimSend(
    jobId: string,
    runnerId: string,
    expectedNextDispatchAt: string,
    leaseUntil: Date,
  ): Promise<boolean>;
  /** Stores what the ring came to, and when the pair is to be looked at next. */
  record(
    jobId: string,
    runnerId: string,
    update: DispatchUpdate,
    at: Date,
  ): Promise<void>;
  /**
   * The pairs a ring is due for: the job is queued and due (and not younger than `minAgeMs`, which leaves it to the request that queued
   * it), the dispatcher announced a webhook and has every label the job requires, and the pair has no row yet or its row is due and
   * not stopped. Oldest job first. With `jobId` only that job's pairs.
   */
  listDue(
    now: Date,
    limit: number,
    options?: { minAgeMs?: number; jobId?: string },
  ): Promise<RingPair[]>;
  /**
   * The pairs of the waiting jobs a freed slot of `group` can serve: queued, due, requiring only labels of the group, whose last ring
   * was answered "not now" (`WAITING_DISPATCH_CODES`, `busy` among them) at least `WAITING_MIN_GAP_MS` ago, whatever time their row says.
   */
  listWaiting(now: Date, limit: number, group: LabelGroup): Promise<RingPair[]>;
  /**
   * The pairs of one job that a lapsed lease put back in the queue: queued and due, and whose pair has no row yet, was acknowledged (its
   * dispatcher took the job and lost the claim) or is pending and due. A pair that is stopped, or waits for a back-off or a slot, is left
   * to the event or the sweep that its answer named.
   */
  listRequeued(now: Date, limit: number, jobId: string): Promise<RingPair[]>;
  /**
   * Whether the last call to the dispatcher (the most recent attempt of any of its pairs) found its endpoint unreachable (a network error or
   * a timeout) at or after `since`. A call that was answered, however it was answered, says the endpoint is up.
   */
  endpointFailedSince(runnerId: string, since: Date): Promise<boolean>;
  /** The labels and the holder of jobs whose claim ended, for the groups they free a slot in. Jobs that are none of a runner environment's are left out. */
  endedGroups(jobIds: readonly string[]): Promise<EndedJobGroup[]>;
  /** The webhook delivery of the customer's runner that holds the job, or undefined when none does (a polling runner, a hosted job). */
  holderDelivery(jobId: string): Promise<HolderDelivery | undefined>;
  /** Makes the `stopped` pairs that were stopped at or before `stoppedBefore` pending again (a dispatcher may have been updated since). Returns how many. */
  reviveStopped(stoppedBefore: Date, at: Date): Promise<number>;
  /** Removes the rows of jobs that finished at or before `cutoff`. Returns how many. */
  deleteFinishedBefore(cutoff: Date): Promise<number>;
};

function isState(value: string): value is DispatchState {
  return (DISPATCH_STATES as readonly string[]).includes(value);
}

function isCode(value: string): value is DispatchResultCode {
  return (DISPATCH_RESULT_CODES as readonly string[]).includes(value);
}

/** The labels of a job as the claim reads them (`jobs-claim.ts`): the stored ones, else those of its runner environment without `cr:` labels. */
const REQUIRED = sql`coalesce(
  string_to_array(j.required_labels, E'\n'),
  (select array(
      select environment_label
        from unnest(string_to_array(t.environment_labels, E'\n')) as environment_label
       where lower(btrim(environment_label)) not like 'cr:%')))`;

type PairRow = {
  job_id: string;
  review_kind: string;
  job_attempts: number;
  runner_id: string;
  base_version: string;
  manifest: string;
  delivery_url: string;
  delivery_key_id: string;
  delivery_secret: string;
};

function toPair(row: PairRow): RingPair {
  return {
    jobId: row.job_id,
    // A kind this version does not know fails loudly, as in `job-dispatches-repository.ts`.
    reviewKind: jobKindOf(row.review_kind),
    jobAttempts: row.job_attempts,
    runnerId: row.runner_id,
    baseVersion: row.base_version,
    manifest: manifestFromText(row.manifest),
    delivery: {
      url: row.delivery_url,
      keyId: row.delivery_key_id,
      sealedSecret: row.delivery_secret,
    },
  };
}

function textArray(values: readonly string[]) {
  return values.length === 0
    ? sql`'{}'::text[]`
    : sql`array[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;
}

export function createRunnerDispatchesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
): RunnerDispatchesRepository {
  /**
   * What the webhook dispatchers of the workspaces that have a turn waiting can run, as a jsonb object `{ "<runner id>": [entries] }` for `accessRule`.
   * The manifest of a row is read here, in the app, with `manifestFromText` (the old map form included, a text that is none reads as no entry) and
   * `customerAccess` (never `managed`): the claim reads it the same way, so no second reading of the stored text exists in the database and one row
   * that cannot be read cannot fail the query for the others.
   */
  async function announcedAccess() {
    const { rows } = await sql<{ id: string; manifest: string }>`
      select r.id as id, r.manifest as manifest
      from runners as r
      where r.revoked_at is null
        and r.delivery_mode = 'webhook'
        and r.delivery_url is not null
        and r.delivery_key_id is not null
        and r.delivery_secret is not null
        and exists (
          select 1
          from jobs as waiting
          join implementer_turns as turn on turn.job_id = waiting.id and turn.environment_kind = 'runner'
          where waiting.workspace_id = r.workspace_id
            and waiting.status = 'queued'
            and waiting.command = 'review')`.execute(db);
    return sql`${JSON.stringify(
      Object.fromEntries(
        rows.map((row) => [
          row.id,
          customerAccess(manifestFromText(row.manifest).harnesses),
        ]),
      ),
    )}::jsonb`;
  }

  /** The pairs query: the join of the rule above, with the conditions of the caller in `where`. */
  async function pairs(
    where: ReturnType<typeof sql>,
    limit: number,
  ): Promise<RingPair[]> {
    const announced = await announcedAccess();
    const { rows } = await sql<PairRow>`
      select j.id as job_id, j.review_kind as review_kind, j.attempts as job_attempts,
             r.id as runner_id, r.base_version as base_version, r.manifest as manifest,
             r.delivery_url as delivery_url, r.delivery_key_id as delivery_key_id, r.delivery_secret as delivery_secret
      from jobs as j
      join implementer_turns as t on t.job_id = j.id and t.environment_kind = 'runner'
      join runners as r on r.workspace_id = j.workspace_id
        and r.revoked_at is null
        and r.delivery_mode = 'webhook'
        and r.delivery_url is not null
        and r.delivery_key_id is not null
        and r.delivery_secret is not null
      left join job_rings as d on d.job_id = j.id and d.runner_id = r.id
      where j.status = 'queued'
        and j.command = 'review'
        and cardinality(${REQUIRED}) > 0
        and ${REQUIRED} <@ string_to_array(r.labels, E'\n')
        and ${accessRule(sql`coalesce(${announced} -> r.id, '[]'::jsonb)`, "t")}
        and ${where}
      order by j.run_after, j.id, r.id
      limit ${limit}`.execute(db);
    return rows.map(toPair);
  }

  return {
    async get(jobId, runnerId) {
      const row = await db
        .selectFrom("job_rings")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("runner_id", "=", runnerId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      if (!isState(row.state))
        throw new Error(`Stored dispatch state ${row.state} is not known.`);
      return {
        jobId: row.job_id,
        state: row.state,
        attempts: row.attempts,
        consecutiveFailures: row.consecutive_failures,
        nextDispatchAt: row.next_dispatch_at,
        ackedAt: row.acked_at,
        lastAttemptAt: row.last_attempt_at,
        lastStatus: row.last_status,
        // A code a later release added reads as unknown rather than failing the reader.
        lastCode:
          row.last_code !== null && isCode(row.last_code)
            ? row.last_code
            : null,
      };
    },

    async create(jobId, runnerId, nextDispatchAt) {
      const timestamp = formatTimestamp(now());
      const result = await db
        .insertInto("job_rings")
        .values({
          job_id: jobId,
          runner_id: runnerId,
          state: "pending",
          attempts: 0,
          consecutive_failures: 0,
          next_dispatch_at: formatTimestamp(nextDispatchAt),
          acked_at: null,
          last_attempt_at: null,
          last_status: null,
          last_code: null,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .onConflict((conflict) =>
          conflict.columns(["job_id", "runner_id"]).doNothing(),
        )
        .executeTakeFirst();
      return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
    },

    async claimSend(jobId, runnerId, expectedNextDispatchAt, leaseUntil) {
      const result = await db
        .updateTable("job_rings")
        .set({
          attempts: sql<number>`attempts + 1`,
          next_dispatch_at: formatTimestamp(leaseUntil),
          last_attempt_at: formatTimestamp(now()),
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .where("runner_id", "=", runnerId)
        .where("next_dispatch_at", "=", expectedNextDispatchAt)
        .where("state", "<>", "stopped")
        .executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    },

    async record(jobId, runnerId, update, at) {
      await db
        .updateTable("job_rings")
        .set({
          state: update.state,
          consecutive_failures: update.consecutiveFailures,
          next_dispatch_at: formatTimestamp(update.nextDispatchAt),
          ...(update.acknowledged ? { acked_at: formatTimestamp(at) } : {}),
          last_status: update.lastStatus,
          last_code: update.lastCode,
          updated_at: formatTimestamp(now()),
        })
        .where("job_id", "=", jobId)
        .where("runner_id", "=", runnerId)
        .execute();
    },

    async listDue(at, limit, { minAgeMs = 0, jobId } = {}) {
      const timestamp = formatTimestamp(at);
      return pairs(
        sql`j.run_after <= ${timestamp}
          and j.updated_at <= ${formatTimestamp(new Date(at.getTime() - minAgeMs))}
          ${jobId === undefined ? sql`` : sql`and j.id = ${jobId}`}
          and (d.job_id is null
            or (d.state <> 'stopped' and d.next_dispatch_at <= ${timestamp}))`,
        limit,
      );
    },

    async listWaiting(at, limit, group) {
      return pairs(
        sql`j.run_after <= ${formatTimestamp(at)}
          and j.workspace_id = ${group.workspaceId}
          and ${REQUIRED} <@ ${textArray(group.labels)}
          and d.state = 'pending'
          and d.attempts > 0
          and d.last_code in (${sql.join(
            WAITING_DISPATCH_CODES.map((code) => sql`${code}`),
            sql`, `,
          )})
          and d.last_attempt_at <= ${formatTimestamp(new Date(at.getTime() - WAITING_MIN_GAP_MS))}`,
        limit,
      );
    },

    async listRequeued(at, limit, jobId) {
      const timestamp = formatTimestamp(at);
      return pairs(
        sql`j.run_after <= ${timestamp}
          and j.id = ${jobId}
          and (d.job_id is null
            or d.state = 'acked'
            or (d.state = 'pending' and d.next_dispatch_at <= ${timestamp}))`,
        limit,
      );
    },

    async endpointFailedSince(runnerId, since) {
      const latest = await db
        .selectFrom("job_rings")
        .select(["last_code", "last_attempt_at"])
        .where("runner_id", "=", runnerId)
        .where("last_attempt_at", "is not", null)
        .orderBy("last_attempt_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return (
        latest !== undefined &&
        (latest.last_code === "network_error" ||
          latest.last_code === "timeout") &&
        latest.last_attempt_at !== null &&
        latest.last_attempt_at >= formatTimestamp(since)
      );
    },

    async endedGroups(jobIds) {
      if (jobIds.length === 0) return [];
      const { rows } = await sql<{
        job_id: string;
        workspace_id: string;
        required: string[] | null;
        holder_labels: string | null;
      }>`
        select j.id as job_id, j.workspace_id as workspace_id,
               ${REQUIRED} as required,
               r.labels as holder_labels
        from jobs as j
        join implementer_turns as t on t.job_id = j.id and t.environment_kind = 'runner'
        left join runners as r on j.runner_id = 'runner:' || r.id and r.workspace_id = j.workspace_id
        where j.id in (${sql.join(
          jobIds.map((id) => sql`${id}`),
          sql`, `,
        )})`.execute(db);
      return rows.map((row) => ({
        jobId: row.job_id,
        workspaceId: row.workspace_id,
        requiredLabels: row.required ?? [],
        holderLabels:
          row.holder_labels === null ? [] : labelsFromText(row.holder_labels),
      }));
    },

    async holderDelivery(jobId) {
      const { rows } = await sql<{
        runner_id: string;
        delivery_url: string;
        delivery_key_id: string;
        delivery_secret: string;
      }>`
        select r.id as runner_id, r.delivery_url, r.delivery_key_id, r.delivery_secret
        from jobs as j
        join runners as r on j.runner_id = 'runner:' || r.id and r.workspace_id = j.workspace_id
        where j.id = ${jobId}
          and r.delivery_mode = 'webhook'
          and r.delivery_url is not null
          and r.delivery_key_id is not null
          and r.delivery_secret is not null`.execute(db);
      const row = rows[0];
      return row === undefined
        ? undefined
        : {
            runnerId: row.runner_id,
            url: row.delivery_url,
            keyId: row.delivery_key_id,
            sealedSecret: row.delivery_secret,
          };
    },

    async reviveStopped(stoppedBefore, at) {
      const timestamp = formatTimestamp(at);
      const result = await db
        .updateTable("job_rings")
        .set({
          state: "pending",
          consecutive_failures: 0,
          next_dispatch_at: timestamp,
          updated_at: timestamp,
        })
        .where("state", "=", "stopped")
        .where("updated_at", "<=", formatTimestamp(stoppedBefore))
        .where("job_id", "in", (eb) =>
          eb
            .selectFrom("jobs")
            .select("jobs.id")
            .where("jobs.status", "=", "queued"),
        )
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    async deleteFinishedBefore(cutoff) {
      const result = await db
        .deleteFrom("job_rings")
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
