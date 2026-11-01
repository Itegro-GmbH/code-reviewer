// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to where the infrastructure of the jobs of ONE workspace began and ended (the table `job_vm_runs`; the factory
// takes the workspace id, see ../workspace-scope.ts): src/billing/README.md, "Billable minutes". It only measures: no
// price, no journal entry. One row per VM the Dispatcher reported (the first report of a VM wins), or one
// `job_wall_clock` row for a job that had no VM. The VM of the final claim of a job is the one that counts; VMs of lost
// attempts are kept for audit and are never billed. A row of another workspace is simply not there.
import "server-only";
import type { Kysely, Selectable } from "kysely";
import {
  backstopEnd,
  billableMinutes,
  boundedEnd,
  type VmEndSource,
} from "../billing-minutes.ts";
import { maxVmMinutes } from "../../billing/hold.ts";
import { JOB_KINDS, jobKindOf } from "../../job-kind/job-kind.ts";
import { decodeBoolean, encodeBoolean, formatTimestamp } from "../codecs.ts";
import type { Database, JobVmRunsTable } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** The name a wall clock row has instead of a VM's. */
export const WALL_CLOCK_NAME = "job_wall_clock";

/**
 * How many VMs are kept for one claim (the review of #524, N-1). A Dispatcher starts one VM per claim; the others are a
 * repeat, a hygiene limit against a holder of the Dispatcher's secret filling the table.
 */
export const MAX_VMS_PER_CLAIM = 4;

/** The ends that measure a job's time on a runner, not a VM: a VM's own end is better evidence when there is one. */
const WALL_CLOCK_SOURCES: readonly VmEndSource[] = [
  "job_wall_clock",
  "claim_wall_clock",
];

const REVIEW_KINDS = JOB_KINDS;

/** Whether a VM name is one of our own naming for this job (`cr-<kind>-<job id>-<random>`, launchers/sandbox.ts). */
function isVmOfJob(name: string, jobId: string): boolean {
  const lower = name.toLowerCase();
  return REVIEW_KINDS.some((kind) =>
    lower.startsWith(`cr-${kind}-${jobId.toLowerCase()}-`),
  );
}

/** A row as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type StoredVmRun = {
  jobId: string;
  vmName: string;
  workspaceId: string;
  attempt: number;
  claimedAt: string;
  startedAt: string;
  reportedAt: string;
  vmTimeoutSeconds: number | null;
  endedAt: string | null;
  endSource: VmEndSource | null;
  /** True for the run that counts for the job's bill (the final claim's). */
  billable: boolean;
  billableMinutes: number | null;
};

/** What the VM of a job cost in minutes, as far as the App knows it. */
export type JobMinutes =
  /** The job is still waiting or running, or it is not a job of this workspace: there are no final minutes yet. */
  | { state: "not_ended" }
  /** `run` is the run that counts; null (and 0 minutes) when no VM or Worker ever ran for the final claim. */
  | { state: "measured"; minutes: number; run: StoredVmRun | null };

export type RecordStartInput = {
  jobId: string;
  vmName: string;
  /** `jobs.claimed_at` of the claim the VM was started for. */
  claimedAt: string;
  /** The lost attempts of the job at the time of the report, plus one. */
  attempt: number;
  /** The start as the Dispatcher says it; kept between the claim and the report. */
  startedAt: Date;
  vmTimeoutSeconds: number;
};

export type JobVmRunsRepository = {
  /**
   * Records that the Dispatcher created the VM of the claim. `refused`: the job is not a job of this workspace, is not
   * running, or its running claim is not the one the VM was started for (nothing is stored; the backstop covers the
   * VM). `replayed`: the VM is known and nothing changes. The VM is the one that counts for its claim unless another
   * VM of the same claim was reported first; it takes the count from the VMs of earlier claims.
   */
  recordStart(
    input: RecordStartInput,
  ): Promise<"recorded" | "replayed" | "refused">;
  /**
   * The App's stop call was answered and named these VMs: they ended now (`at`, the App's clock, kept between the start
   * and the VM's timeout). Replaces a backstop; never replaces another confirmation. A VM of our own naming for this job that
   * has no row (its report never arrived) gets one now (#498, `app_stop_unreported`): from the claim of the job to `at`, at
   * most the longest a VM lives; a name of another job, and a job that was given back (no claim), make none. Returns how
   * many rows changed or were made.
   */
  confirmStopped(
    jobId: string,
    vmNames: readonly string[],
    at: Date,
  ): Promise<number>;
  /**
   * A job that ended with no VM row: its time on a runner, from the claim to the end. `job_wall_clock` for a self-hosted runner
   * or Compose (no VM exists); `claim_wall_clock` (#498) for a hosted job that ran and whose VM was never reported, so a
   * job that ran is never priced at 0 minutes silently. `not_measurable`: it has not ended, or it never had a claim.
   */
  recordWallClock(
    jobId: string,
    source?: Extract<VmEndSource, "job_wall_clock" | "claim_wall_clock">,
  ): Promise<"recorded" | "replayed" | "not_measurable">;
  /** Every row of the job, oldest start first. */
  list(jobId: string): Promise<StoredVmRun[]>;
  /**
   * The minutes of a job that has ended. Closes what is open: a VM of the final claim whose teardown nobody confirmed
   * gets the backstop (`timeout_backstop`, kept until a confirmation replaces it), and the count flag is set on the one
   * run of the final claim. Idempotent.
   */
  measure(jobId: string): Promise<JobMinutes>;
};

function toStored(row: Selectable<JobVmRunsTable>): StoredVmRun {
  return {
    jobId: row.job_id,
    vmName: row.vm_name,
    workspaceId: row.workspace_id,
    attempt: row.attempt,
    claimedAt: row.claimed_at,
    startedAt: row.started_at,
    reportedAt: row.reported_at,
    vmTimeoutSeconds: row.vm_timeout_seconds,
    endedAt: row.ended_at,
    endSource: row.end_source as VmEndSource | null,
    billable: decodeBoolean(row.billable),
    billableMinutes: row.billable_minutes,
  };
}

const OPEN_ENDS = [
  "timeout_backstop",
] as const satisfies readonly VmEndSource[];

export function createJobVmRunsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): JobVmRunsRepository {
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  function jobOf(executor: Kysely<Database>, jobId: string) {
    return executor
      .selectFrom("jobs")
      .select([
        "id",
        "status",
        "claimed_at",
        "finished_at",
        "attempts",
        "review_kind",
      ])
      .where("id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
  }

  function rowsOf(executor: Kysely<Database>, jobId: string) {
    return executor
      .selectFrom("job_vm_runs")
      .selectAll()
      .where("job_id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .orderBy("started_at")
      .orderBy("vm_name")
      .execute();
  }

  /** Writes the end of one row and the minutes it makes, only while the row is open or a backstop. */
  async function setEnd(
    executor: Kysely<Database>,
    row: Selectable<JobVmRunsTable>,
    endedAt: Date,
    source: VmEndSource,
  ): Promise<number> {
    const minutes = billableMinutes({
      startedAt: new Date(row.started_at),
      endedAt,
    });
    const result = await executor
      .updateTable("job_vm_runs")
      .set({
        ended_at: formatTimestamp(endedAt),
        end_source: source,
        billable_minutes: minutes,
        updated_at: formatTimestamp(now()),
      })
      .where("job_id", "=", row.job_id)
      .where("vm_name", "=", row.vm_name)
      .where("workspace_id", "=", workspaceId)
      .where((eb) =>
        eb.or([
          eb("end_source", "is", null),
          eb("end_source", "in", [...OPEN_ENDS]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Makes `counted` the only run of the job with the flag (none of them when it is null: no run of the final claim). */
  async function setCounted(
    executor: Kysely<Database>,
    jobId: string,
    counted: { vmName: string } | null,
  ): Promise<void> {
    const stamp = formatTimestamp(now());
    let clear = executor
      .updateTable("job_vm_runs")
      .set({ billable: encodeBoolean(false), updated_at: stamp })
      .where("job_id", "=", jobId)
      .where("workspace_id", "=", workspaceId)
      .where("billable", "=", 1);
    if (counted !== null) clear = clear.where("vm_name", "!=", counted.vmName);
    await clear.execute();
    if (counted === null) return;
    await executor
      .updateTable("job_vm_runs")
      .set({ billable: encodeBoolean(true), updated_at: stamp })
      .where("job_id", "=", jobId)
      .where("vm_name", "=", counted.vmName)
      .where("workspace_id", "=", workspaceId)
      .where("billable", "=", 0)
      .execute();
  }

  async function insertRun(
    executor: Kysely<Database>,
    values: {
      jobId: string;
      vmName: string;
      attempt: number;
      claimedAt: string;
      startedAt: Date;
      vmTimeoutSeconds: number | null;
      end?: { at: Date; source: VmEndSource };
    },
  ): Promise<"recorded" | "replayed"> {
    const stamp = formatTimestamp(now());
    const sameClaim = await executor
      .selectFrom("job_vm_runs")
      .select("vm_name")
      .where("job_id", "=", values.jobId)
      .where("workspace_id", "=", workspaceId)
      .where("claimed_at", "=", values.claimedAt)
      .execute();
    // N-1: a claim has one VM; more than a few is a repeat or an abuse, answered like a repeat so a launch goes on.
    if (sameClaim.length >= MAX_VMS_PER_CLAIM) return "replayed";
    // N-3: this read and the insert below are not one statement, so two reports of different VMs of one claim that overlap on
    // Postgres can both be `billable`. That is repaired, not prevented: `measure` is the authority, it picks the one run that
    // counts (`setCounted`) every time it is asked, and nothing else reads the flag as a fact.
    const counts = sameClaim.length === 0;
    const minutes =
      values.end === undefined
        ? null
        : billableMinutes({
            startedAt: values.startedAt,
            endedAt: values.end.at,
          });
    const inserted = await executor
      .insertInto("job_vm_runs")
      .values({
        job_id: values.jobId,
        vm_name: values.vmName,
        workspace_id: workspaceId,
        attempt: values.attempt,
        claimed_at: values.claimedAt,
        started_at: formatTimestamp(values.startedAt),
        reported_at: stamp,
        vm_timeout_seconds: values.vmTimeoutSeconds,
        ended_at:
          values.end === undefined ? null : formatTimestamp(values.end.at),
        end_source: values.end?.source ?? null,
        billable: encodeBoolean(counts),
        billable_minutes: minutes,
        created_at: stamp,
        updated_at: stamp,
      })
      .onConflict((conflict) =>
        conflict.columns(["job_id", "vm_name"]).doNothing(),
      )
      .executeTakeFirst();
    if (Number(inserted.numInsertedOrUpdatedRows) === 0) return "replayed";
    if (counts)
      await setCounted(executor, values.jobId, { vmName: values.vmName });
    return "recorded";
  }

  return {
    recordStart(input) {
      return inTransaction(async (executor) => {
        const job = await jobOf(executor, input.jobId);
        if (
          job === undefined ||
          job.status !== "running" ||
          job.claimed_at !== input.claimedAt
        )
          return "refused";
        const claimedAt = new Date(input.claimedAt);
        const startedAt = new Date(
          Math.min(
            now().getTime(),
            Math.max(claimedAt.getTime(), input.startedAt.getTime()),
          ),
        );
        return insertRun(executor, {
          jobId: input.jobId,
          vmName: input.vmName,
          attempt: input.attempt,
          claimedAt: input.claimedAt,
          startedAt,
          vmTimeoutSeconds: input.vmTimeoutSeconds,
        });
      });
    },

    confirmStopped(jobId, vmNames, at) {
      if (vmNames.length === 0) return Promise.resolve(0);
      return inTransaction(async (executor) => {
        const rows = await rowsOf(executor, jobId);
        let changed = 0;
        // #498: a VM of this job that nobody reported. Its start is the claim (the VM was created after it), its end the stop.
        const known = new Set(rows.map((row) => row.vm_name));
        const job = await jobOf(executor, jobId);
        if (job !== undefined && job.claimed_at !== null) {
          const start = new Date(job.claimed_at);
          const latest = new Date(
            start.getTime() +
              maxVmMinutes(jobKindOf(job.review_kind)) * 60 * 1000,
          );
          for (const name of vmNames) {
            if (known.has(name) || !isVmOfJob(name, jobId)) continue;
            known.add(name);
            const end = new Date(
              Math.min(
                latest.getTime(),
                Math.max(start.getTime(), at.getTime()),
              ),
            );
            const made = await insertRun(executor, {
              jobId,
              vmName: name,
              attempt: job.attempts + 1,
              claimedAt: job.claimed_at,
              startedAt: start,
              vmTimeoutSeconds: null,
              end: { at: end, source: "app_stop_unreported" },
            });
            if (made === "recorded") changed += 1;
          }
        }
        for (const row of rows) {
          if (!vmNames.includes(row.vm_name)) continue;
          if (row.vm_timeout_seconds === null) continue;
          if (row.end_source !== null && row.end_source !== "timeout_backstop")
            continue;
          const end = boundedEnd({
            startedAt: new Date(row.started_at),
            timeoutSeconds: row.vm_timeout_seconds,
            at,
          });
          changed += await setEnd(executor, row, end, "app_stop_confirmed");
        }
        return changed;
      });
    },

    recordWallClock(jobId, source = "job_wall_clock") {
      return inTransaction(async (executor) => {
        const job = await jobOf(executor, jobId);
        if (
          job === undefined ||
          job.finished_at === null ||
          job.claimed_at === null
        )
          return "not_measurable";
        return insertRun(executor, {
          jobId,
          vmName: WALL_CLOCK_NAME,
          attempt: 1,
          claimedAt: job.claimed_at,
          startedAt: new Date(job.claimed_at),
          vmTimeoutSeconds: null,
          end: { at: new Date(job.finished_at), source },
        });
      });
    },

    async list(jobId) {
      return (await rowsOf(db, jobId)).map(toStored);
    },

    measure(jobId) {
      return inTransaction(async (executor): Promise<JobMinutes> => {
        const job = await jobOf(executor, jobId);
        if (job === undefined || job.finished_at === null)
          return { state: "not_ended" };
        const jobEndedAt = new Date(job.finished_at);
        let rows = await rowsOf(executor, jobId);
        // The VMs of the final claim: the one whose teardown nobody confirmed ends at the backstop.
        for (const row of rows) {
          if (row.ended_at !== null || row.vm_timeout_seconds === null)
            continue;
          if (row.claimed_at !== job.claimed_at) continue;
          await setEnd(
            executor,
            row,
            backstopEnd({
              startedAt: new Date(row.started_at),
              timeoutSeconds: row.vm_timeout_seconds,
              jobEndedAt,
            }),
            "timeout_backstop",
          );
        }
        rows = await rowsOf(executor, jobId);
        // The run of the final claim that counts: a VM's own end first, a wall clock only when it is all there is.
        const ofClaim =
          job.claimed_at === null
            ? []
            : rows.filter((row) => row.claimed_at === job.claimed_at);
        const counted =
          ofClaim.find(
            (row) =>
              !WALL_CLOCK_SOURCES.includes(row.end_source as VmEndSource),
          ) ?? ofClaim[0];
        await setCounted(
          executor,
          jobId,
          counted === undefined ? null : { vmName: counted.vm_name },
        );
        if (counted === undefined)
          return { state: "measured", minutes: 0, run: null };
        const fresh = (await rowsOf(executor, jobId)).find(
          (row) => row.vm_name === counted.vm_name,
        );
        if (fresh === undefined || fresh.billable_minutes === null)
          return { state: "measured", minutes: 0, run: null };
        return {
          state: "measured",
          minutes: fresh.billable_minutes,
          run: toStored(fresh),
        };
      });
    },
  };
}
