// SPDX-License-Identifier: LicenseRef-Proprietary

// The admission of a claimed job (#277): inside the transaction of the queue's claim, after a job was taken and
// before its usage record is reserved, it resolves the entitlements of the job's workspace and decides whether
// the job may run (`decideAdmission`, src/usage/enforce-entitlements.ts). INSTANCE LEVEL like the claim it
// belongs to: it serves whichever workspace the oldest due job is in, and every statement it makes goes through
// repositories created for that workspace.
//
// Exactness: the claim runs under the exclusive gate lock of the queue, so two claims never read the count at once.
// The workspace row is locked as well (`for no key update`, which an insert that only references the row does not wait on), so the count stays
// exact if the gate is ever narrowed. A workspace without limits reads no usage and takes no lock.
import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  decideAdmission,
  ignoresCostLimit,
  readsUsage,
  type Admission,
  type AdmissionOptions,
  type AdmissionUsage,
} from "../../usage/enforce-entitlements.ts";
import { databaseDriver } from "../driver.ts";
import type { Database, JobsTable } from "../schema.ts";
import { createUsageRecordsRepository } from "./usage-records-repository.ts";
import {
  jobKindOf,
  projectKindOf,
  type JobKind,
} from "../../job-kind/job-kind.ts";
import { readEffectiveEntitlements } from "../../workspaces/effective-entitlements.ts";
import { keyModeAtClaim } from "../../billing/claim-key-mode.ts";
import type { KeyMode } from "../../workspaces/entitlements.ts";

/** What the claim did to a job it refused; handed to `onRefused` once the transaction has committed. */
export type ClaimRefusal = {
  jobId: string;
  workspaceId: string;
  /** The pull request of the job, for the notice on it (#281). */
  repositoryId: string;
  prNumber: number;
  /** What started the job (`webhook` is an automatic review), for the notice on a draft (#281). */
  triggerKind: string;
  /** The kind of the job: a turn of the Implementer has no pull request, so no notice and no check run (#752). */
  reviewKind: JobKind;
  errorCode: string;
  detail?: string;
  /**
   * The start of the period the refusal was decided under (#281, the pull request notice). Absent for entitlements
   * that cannot be read: they have no period, and no notice.
   */
  periodStart?: string;
};

/** The decision and whether the job already had a usage record (a job claimed again after a lost lease). */
export type ClaimAdmission = {
  admission: Admission;
  hadRecord: boolean;
  /** The entitlements hold a cost limit next to the own key, which nothing reads (#277). */
  ignoredCostLimit: boolean;
  /** Whose key the job runs on, as far as the claim knows it: what the hold of #498 depends on (`keyModeAtClaim`). */
  keyMode: KeyMode;
};

export async function admitClaimedJob(
  trx: Kysely<Database>,
  job: Pick<Selectable<JobsTable>, "id" | "workspace_id" | "review_kind">,
  now: () => Date,
  options: AdmissionOptions & {
    /** Whether billing is on, as the claim read it: the key mode of the workspace follows its choice then (#496). */
    billingOn?: boolean;
  } = {},
): Promise<ClaimAdmission> {
  const workspaceId = job.workspace_id;
  const records = createUsageRecordsRepository(trx, workspaceId, now);
  const own = await records.get(job.id);
  const hadRecord = own !== undefined;

  // The key mode is decided here, in the transaction of the claim, from the workspace's choice while billing is on (#496); the same
  // function serves the claim route and the LLM access afterwards, so the admission and the key a job is given cannot differ.
  const entitlements = await readEffectiveEntitlements(
    trx,
    workspaceId,
    now,
    options.billingOn === undefined ? undefined : { on: options.billingOn },
  );
  const keyMode = keyModeAtClaim(entitlements);
  if (entitlements.kind === "unlimited")
    return {
      admission: { allow: true },
      hadRecord,
      ignoredCostLimit: false,
      keyMode,
    };
  const ignoredCostLimit = ignoresCostLimit(entitlements);

  // #752: a turn counts against the plan, is priced and chooses its model as a Dynamic Review; its record keeps its own kind.
  const reviewKind = projectKindOf(jobKindOf(job.review_kind));
  // A limit that applies to this job is the only reason to count and to lock; a suspension needs neither.
  if (
    readsUsage(entitlements, reviewKind, options) &&
    databaseDriver(trx) === "postgres"
  )
    await sql`select id from workspaces where id = ${workspaceId} for no key update`.execute(
      trx,
    );

  const usage: AdmissionUsage = {
    // A job claimed again keeps its record and is not counted twice: its own unit is not held against it.
    async runsSince(kind, since) {
      const counted = (await records.countByKind(since))[kind];
      const ownCounts =
        own !== undefined &&
        projectKindOf(own.reviewKind) === kind &&
        own.state !== "void" &&
        own.reservedAt >= since;
      return ownCounts ? counted - 1 : counted;
    },
    costSince: (keyMode, since) =>
      records.sumSettledCostMicroUsd(since, keyMode),
  };
  return {
    admission: await decideAdmission(entitlements, reviewKind, usage, options),
    hadRecord,
    ignoredCostLimit,
    keyMode,
  };
}
