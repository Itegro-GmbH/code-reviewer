// SPDX-License-Identifier: LicenseRef-Proprietary

// The settlement of a job (ADR 0006, 2.6 and 2.8; #498, reworked by #605). Called from the transaction that ENDS jobs, with the
// ids of the jobs whose usage record just reached its end: it prices each run (`classifyOutcome`, `priceRun`, the minutes of
// #493) and, unless the run is free or prices to nothing, writes ONE `usage` entry for it, which may take the balance below
// zero. Nothing was held at the claim, so there is no hold to give back.
//
// Which jobs: those whose record is `open` (a claim with billing on handed them out; `usage_records.billing_state`). A job
// claimed with billing off is never charged, and neither is one that ended while billing was off (the end paths call this only
// then, and #591 decided that such a run is not charged). Exactly once: the record goes `open` -> `settled` in an update whose
// row lock lets one of two racing settlements through, and the usage entry is keyed by the job besides.
//
// Old rows: a job that holds a reservation (written by the claim of an earlier release) is settled through it, with a release
// of the hold and the usage as before; the journal repository still has that path, and an instance that never took holds never
// meets it.
//
// Billing off: nothing here runs. The only thing read is the switch, which is an instance setting, never a billing table.
//
// A run that cannot be priced (damaged data: a rate, a cost) is charged nothing, with a log line of its stable code and the
// job id: a customer is never charged a number nobody could compute.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingJournalRepository,
  type BillingJournalRepository,
  type JobCharge,
} from "../db/repositories/billing-journal-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { tryDecodeJson } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import { jobKindOf, projectKindOf } from "../job-kind/job-kind.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";
import { readClaimBilling, type ClaimBilling } from "./claim-billing.ts";
import { classifyOutcome, type RunEnd } from "./outcome.ts";
import { PricingError, priceRun } from "./pricing.ts";

type EndedStatus = RunEnd["status"];
const ENDED_STATUSES: readonly string[] = [
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
];

/** The stable codes of the log lines of this module. */
export const SETTLE_LOG_CODES = [
  "BILLING_PRICING_FAILED",
  "BILLING_RATES_INCOMPLETE_AT_SETTLEMENT",
] as const;

function errorReasonOf(resultText: string | null): string | null {
  if (resultText === null) return null;
  const decoded = tryDecodeJson(resultText);
  if (!decoded.ok) return null;
  const result = decoded.value;
  if (typeof result !== "object" || result === null) return null;
  const reason = (result as { errorReason?: unknown }).errorReason;
  return typeof reason === "string" ? reason : null;
}

/**
 * The started minutes of a job that ends charged. A run with a VM of its final claim measures it (#493). A run of that claim
 * with none is never priced at 0 minutes silently (the gate of the review of #524): it ran, so its claim to its end is the
 * measure, flagged `claim_wall_clock` when a Dispatcher acknowledged the job (a VM was started and its report was lost, or the
 * Dispatcher is of an earlier release) and `job_wall_clock` for a runner with no VM at all. A job that was given back (it has
 * no claim) measures 0.
 */
async function minutesOf(
  trx: Kysely<Database>,
  workspaceId: string,
  jobId: string,
  now: () => Date,
): Promise<number> {
  const runs = createJobVmRunsRepository(trx, workspaceId, now);
  let measured = await runs.measure(jobId);
  if (measured.state === "measured" && measured.run === null) {
    const hosted =
      (await createJobDispatchesRepository(trx, now).get(jobId))?.ackedAt !=
      null;
    const recorded = await runs.recordWallClock(
      jobId,
      hosted ? "claim_wall_clock" : "job_wall_clock",
    );
    if (recorded !== "not_measurable") measured = await runs.measure(jobId);
  }
  return measured.state === "measured" ? measured.minutes : 0;
}

/**
 * What a settlement is told about a run besides its job and its usage record: the error code a superseded run's Worker
 * reported. The job of a superseded run keeps no error code of its own (it stays `superseded`), so the report is the only
 * place the code is, and it is given for the one settlement that follows the report.
 */
export type SettleOptions = {
  reportedErrorCodes?: ReadonlyMap<string, string>;
};

/**
 * Settles these jobs, which ended in the transaction `trx`. Jobs of any workspace; each is looked at under its own workspace.
 * Never throws for a job that is not billed.
 */
export async function settleEndedJobs(
  trx: Kysely<Database>,
  jobIds: readonly string[],
  now: () => Date,
  options: SettleOptions = {},
): Promise<void> {
  if (jobIds.length === 0) return;
  const billing = await readClaimBilling(trx);
  if (billing.state === "off") return;
  const jobs = await trx
    .selectFrom("jobs")
    .select([
      "id",
      "workspace_id",
      "status",
      "error_code",
      "result",
      "review_kind",
    ])
    .where("id", "in", [...new Set(jobIds)])
    // Workspace first: the balance row of each workspace is locked at its first write and held until the transaction ends,
    // and the switch-on takes the rows of up to a batch of old holds in the same order (`findStrandedHolds`, #591). Two
    // transactions that lock several workspaces in one global order cannot each wait for what the other holds.
    .orderBy("workspace_id")
    .orderBy("id")
    .execute();
  for (const job of jobs) {
    if (!ENDED_STATUSES.includes(job.status)) continue;
    const journal = createBillingJournalRepository(trx, job.workspace_id, now);
    const hasHold =
      (await journal.findByKey("reservation", job.id)) !== undefined;
    const record = await trx
      .selectFrom("usage_records")
      .select(["key_mode", "cost_micro_usd", "settled_reason", "billing_state"])
      .where("job_id", "=", job.id)
      .where("workspace_id", "=", job.workspace_id)
      .executeTakeFirst();
    // A job claimed with billing off, or settled before, has nothing to settle. An old hold is settled below.
    if (!hasHold && record?.billing_state !== "open") continue;
    // Settled or released before: nothing changes (a repeated completion, a sweep after it).
    if (hasHold && (await journal.findByKey("release", job.id)) !== undefined)
      continue;
    const records = createUsageRecordsRepository(trx, job.workspace_id, now);
    // The one settlement of the job: the update decides which of two racing callers goes on. An old hold is decided by its
    // release and its usage entry (the journal's own idempotency), and its record may never have been `open`.
    if (!hasHold && !(await records.closeBilling(job.id))) continue;
    if (hasHold) await records.closeBilling(job.id);

    // The charge for this run, or null: nothing is due (free, priced to nothing, or not priceable).
    const charge = await chargeOf(trx, billing, job, record, options, now);
    if (hasHold) await settleOldHold(journal, job.id, charge);
    else if (charge !== null) await journal.charge(job.id, charge);
  }
}

type EndedJob = {
  id: string;
  workspace_id: string;
  status: string;
  error_code: string | null;
  result: string | null;
  review_kind: string;
};

type RecordRow =
  | {
      key_mode: string;
      cost_micro_usd: number | null;
      settled_reason: string | null;
    }
  | undefined;

/** The price of a run as the journal takes it, or null when nothing is charged. */
async function chargeOf(
  trx: Kysely<Database>,
  billing: Exclude<ClaimBilling, { state: "off" }>,
  job: EndedJob,
  record: RecordRow,
  options: SettleOptions,
  now: () => Date,
): Promise<JobCharge | null> {
  if (billing.state === "rates_incomplete") {
    // The rates were removed after the claim: the run cannot be priced, and it is not charged.
    console.error(
      `[billing] BILLING_RATES_INCOMPLETE_AT_SETTLEMENT job=${job.id}`,
    );
    return null;
  }
  const keyMode: KeyMode = record?.key_mode === "managed" ? "managed" : "own";
  const reviewKind = jobKindOf(job.review_kind);
  const outcomeClass = classifyOutcome({
    status: job.status as EndedStatus,
    // The error of the job, else what the Worker of a superseded run reported: our error is free there as anywhere.
    errorCode:
      job.error_code ?? options.reportedErrorCodes?.get(job.id) ?? null,
    errorReason: errorReasonOf(job.result),
    settledReason: record?.settled_reason ?? null,
    keyMode,
    aiCostKnown: record?.cost_micro_usd != null,
  });
  // A run that is free is not measured: nothing is charged whatever it measures.
  if (outcomeClass === "free") return null;
  const minutes = await minutesOf(trx, job.workspace_id, job.id, now);
  try {
    const price = priceRun({
      keyMode,
      outcomeClass,
      costMicroUsd: record?.cost_micro_usd ?? null,
      billableMinutes: minutes,
      // #752: a turn of the Implementer is priced at the rate of Dynamic Review, the engine it runs on; its entry keeps its kind.
      reviewKind: projectKindOf(reviewKind),
      rates: billing.rates,
    });
    if (price.totalMicroUsd === 0) return null;
    return {
      aiMicroUsd: price.aiMicroUsd,
      infraMicroUsd: price.infraMicroUsd,
      minutes,
      reviewKind,
    };
  } catch (error) {
    if (!(error instanceof PricingError)) throw error;
    console.error(
      `[billing] BILLING_PRICING_FAILED job=${job.id} code=${error.code}`,
    );
    return null;
  }
}

/** A job that holds a reservation of an earlier release: the hold goes back, with the charge when there is one. */
async function settleOldHold(
  journal: BillingJournalRepository,
  jobId: string,
  charge: JobCharge | null,
): Promise<void> {
  if (charge === null) await journal.release(jobId);
  else await journal.settle(jobId, charge);
}
