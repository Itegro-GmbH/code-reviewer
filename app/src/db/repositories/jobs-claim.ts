// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim of a job: the one place in the job queue that is written for the database engine.
//
// One `UPDATE ... WHERE id = (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, so two runners
// do not wait on each other's candidate. `SKIP LOCKED` alone is not enough: two queued jobs of one
// pull request have no running job to skip on, so both runners can pick one each. The partial unique
// index `jobs_one_running_per_pull_request_unique` is what keeps the rule; the second `UPDATE` then
// fails with a unique violation, which this code treats as "skip this job, try the next". A savepoint
// makes that recoverable: a Postgres transaction that hit an error cannot run another statement until
// it is rolled back to a savepoint.
import { sql, type Kysely, type Selectable } from "kysely";
import type { JobKind } from "../../job-kind/job-kind.ts";
import { formatTimestamp } from "../codecs.ts";
import { errorCode, UNIQUE_VIOLATION } from "../errors.ts";
import type { Database, JobsTable } from "../schema.ts";
import {
  isReservedLabel,
  MANAGED_LABEL,
  PLATFORM_LABELS,
} from "../../runner-identity/labels.ts";

/** Everything a claim writes onto the job it hands out. */
export type JobClaim = {
  runnerId: string;
  leaseToken: string;
  /** #397: the holder understands that its run can be superseded (the feature `supersede`). */
  acceptsSupersede?: boolean;
  now: Date;
  leaseExpiresAt: Date;
};

/**
 * Who is claiming (#854, #971). Every job requires labels and a claim takes a job only when its caller has all of them (`labelRule`).
 * A claim without a scope is the platform identity's (the Dispatcher's shared token, the poll mode's): its labels are the reserved ones
 * (`PLATFORM_LABELS`), so it takes the hosted jobs (`cr:managed` and a size) and never a job that asks for a label of a customer.
 * A customer's runner takes only the jobs of its own workspace that require labels it has; it has no reserved label, whatever it once
 * announced, so it never takes a hosted job. Both follow from the one rule: neither has a special case. What stays outside the labels
 * is the harness (#856): a customer's runner takes only a turn whose profile's harness it announces as ready (OpenCode alone when it
 * names none), and nobody else takes a turn that runs on the harness `claude-code`: it needs the login of a customer's device.
 */
export type ClaimScope = {
  customerRunner: {
    workspaceId: string;
    labels: readonly string[];
    harnesses?: readonly string[];
  };
};

/** Enough for every pull request in the queue to be tried; a bug fails instead of looping. */
const MAX_CLAIM_ATTEMPTS = 100;

/**
 * Hands the oldest due job to `runnerId`, or returns undefined when there is none.
 *
 * A job is due when it is `queued`, its `run_after` has passed and its review kind (#195) is one the
 * runner's engines can run. A pull request with a running job is skipped, so at most one job runs per
 * pull request; the first eligible job of another pull request goes instead. An unsupported job is
 * never selected, so it keeps waiting without an attempt being counted or credentials being created.
 * With `jobId` (#322) only that job can be selected, under every rule above: a job that is not due, not
 * queued, of another kind or blocked by a running job of its pull request is not claimed, and the answer
 * is undefined. Call it inside a transaction, after expired leases have been dealt with.
 *
 * A unique violation (the running slot of that pull request was taken by another runner at the same moment)
 * makes it try the next due job instead of failing the transaction.
 */
export async function claimOldestDueJob(
  executor: Kysely<Database>,
  claim: JobClaim,
  reviewKinds: readonly JobKind[],
  jobId?: string,
  scope?: ClaimScope,
): Promise<Selectable<JobsTable> | undefined> {
  // One savepoint for the whole attempt loop: a rolled-back-to savepoint stays usable, and the outer
  // transaction can keep going after each unique violation.
  await sql`savepoint claim_attempt`.execute(executor);
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      const { rows } = await claimQuery(executor, claim, reviewKinds, {
        jobId,
        scope,
      });
      return rows[0];
    } catch (error) {
      if (errorCode(error) !== UNIQUE_VIOLATION) throw error;
      // The pull request of the candidate now has a running job (visible after the savepoint is
      // rolled back), so the next attempt picks another pull request, or nothing.
      await sql`rollback to savepoint claim_attempt`.execute(executor);
    }
  }
  // Every due job was contended at its own moment; the runner polls again.
  return undefined;
}

/** The one claim statement. */
function claimQuery(
  executor: Kysely<Database>,
  claim: JobClaim,
  reviewKinds: readonly JobKind[],
  {
    jobId,
    scope,
  }: { jobId: string | undefined; scope: ClaimScope | undefined },
) {
  const now = formatTimestamp(claim.now);
  // #195: the runner only gets jobs of a kind one of its engines can run. A caller with no engines is
  // a previous-release runner and the caller passes `DEFAULT_ENGINES` (`pr-agent`); an empty list
  // would select nothing, so it is never built here.
  const kinds = sql.join(
    reviewKinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
  // #971: the labels of the caller. The platform identity has the reserved ones and a customer's runner its own, from which the reserved
  // namespace is dropped again here: it is the identity that may carry them, never the text a runner once announced.
  const callerLabels =
    scope === undefined
      ? [...PLATFORM_LABELS]
      : scope.customerRunner.labels.filter((label) => !isReservedLabel(label));
  const labels =
    callerLabels.length === 0
      ? sql`'{}'::text[]`
      : sql`array[${sql.join(
          callerLabels.map((label) => sql`${label}`),
          sql`, `,
        )}]::text[]`;
  // The labels a job requires. A job written before the labels (null) is a turn of a runner environment that requires the labels of its
  // environment, or any other job, which is the platform's: `cr:managed`.
  const required = sql`coalesce(
    string_to_array(due.required_labels, E'\n'),
    (select string_to_array(legacy.environment_labels, E'\n')
       from implementer_turns as legacy
      where legacy.job_id = due.id and legacy.environment_kind = 'runner'
      limit 1),
    array[${MANAGED_LABEL}]::text[]
  )`;
  const harnesses = sql`array[${sql.join(
    (scope?.customerRunner.harnesses ?? ["opencode"]).map(
      (harness) => sql`${harness}`,
    ),
    sql`, `,
  )}]::text[]`;
  const routing =
    scope === undefined
      ? sql`and ${required} <@ ${labels}
        and not exists (
          select 1 from implementer_turns as routed
          where routed.job_id = due.id and routed.profile_harness = 'claude-code'
        )`
      : sql`and ${required} <@ ${labels}
        and due.workspace_id = ${scope.customerRunner.workspaceId}
        and exists (
          select 1 from implementer_turns as routed
          where routed.job_id = due.id
            and coalesce(routed.profile_harness, 'opencode') = any(${harnesses})
        )`;
  return sql<Selectable<JobsTable>>`
    update jobs
    set status = 'running',
        runner_id = ${claim.runnerId},
        lease_token = ${claim.leaseToken},
        worker_fetches = 0,
        accepts_supersede = ${claim.acceptsSupersede === true ? 1 : 0},
        claimed_at = ${now},
        heartbeat_at = ${now},
        lease_expires_at = ${formatTimestamp(claim.leaseExpiresAt)},
        updated_at = ${now}
    where id = (
      select due.id
      from jobs as due
      where due.status = 'queued'
        and due.command = 'review'
        and due.review_kind in (${kinds})
        ${jobId === undefined ? sql`` : sql`and due.id = ${jobId}`}
        ${routing}
        and due.run_after <= ${now}
        and not exists (
          select 1
          from jobs as busy
          where busy.status = 'running'
            and busy.repository_id = due.repository_id
            and busy.pr_number = due.pr_number
        )
      order by due.created_at, due.id
      limit 1
      for update skip locked
    )
    returning *`.execute(executor);
}
