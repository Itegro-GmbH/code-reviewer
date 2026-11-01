// SPDX-License-Identifier: LicenseRef-Proprietary

// The deletion of ONE workspace (#658; the factory takes the workspace id, see ../workspace-scope.ts). It is the only
// code that removes a workspace's data as a whole, and every statement filters by that workspace, directly or through
// the repositories and jobs that belong to it. The caller (src/workspaces/delete-workspace.ts) runs it inside one
// transaction, with the repositories created on that transaction, after it has taken the locks, locked the workspace and
// checked the balance; nothing here decides whether a deletion is allowed except the facts it can read (`hasRunningJobs`,
// `hasOpenPayment`). `lockActiveJobs` is the lock that makes `hasRunningJobs` true to the end of the transaction.
//
// What goes and what stays (the reasons are in src/workspaces/README.md, "Deleting a workspace"):
// - goes: the members, invitations, connections (the GitHub installation is released), repositories, projects, jobs with
//   everything that hangs off a job (queue entries, comments, check runs, dispatches, claimed keys, VM runs, usage
//   records, refusal notices), the settings, the stored keys, the entitlements, the hand-over tokens, the link requests,
//   the billing limit and notification state, and the billing profile's personal fields (legal name, address, VAT id);
// - stays: the `workspaces` row itself, anonymised and marked with `deleted_at`, the billing journal (append-only, the
//   database refuses a delete, and it carries what accountants need: amounts, minutes, provider references), the
//   cached balances and the top-up intents that explain the credit, the start credit memory (it must keep a deleted
//   workspace from earning the credit twice) and the payment provider's customer reference (`customer_ref` on an emptied
//   billing profile row), which a refund or a dispute of an earlier payment may still need. The provider is the merchant of
//   record and keeps the invoices.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import { lockJobRowsInOrder } from "../dynamic-review-lock.ts";
import { databaseDriver } from "../driver.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** A check run on the platform that still shows a waiting review of a job the deletion removes. */
export type OpenCheck = {
  jobId: string;
  headSha: string;
  /** The id of the check run on the platform, or null when an attempt to make it may have worked without its id being kept. */
  checkRunId: string | null;
  /** The repository the job belongs to, as the platform knows it. */
  repo: {
    integrationId: string;
    externalId: string;
    fullName: string;
    url: string;
  };
};

export type WorkspaceErasure = {
  /**
   * Locks what a job needs to become `running`: the repositories of the workspace and then its waiting, running
   * and superseded jobs, `FOR UPDATE`, in the order every writer of the queue uses (the repository, then the jobs by id; the
   * Dynamic gate comes before both, `lockDynamicReviewGate`). A claim that is in flight holds one of those rows, so this waits
   * for it and `hasRunningJobs` then sees its result.
   */
  lockActiveJobs(): Promise<void>;
  /**
   * Whether a job of the workspace is running, or is a superseded run whose Worker still drains under its lease (it will
   * report to a workspace that is gone).
   */
  hasRunningJobs(now: Date): Promise<boolean>;
  /**
   * Whether a top-up checkout of the workspace was started at or after `since` and has not reached an end (`paid`, `failed`):
   * a payment may still arrive for it, an asynchronous one even after its checkout page expired.
   */
  hasOpenPayment(since: Date): Promise<boolean>;
  /** The check runs that show a waiting review of a job the deletion removes: to be completed on the platform afterwards. */
  openChecks(): Promise<OpenCheck[]>;
  /** Removes the data listed above and turns the workspace row into the tombstone. */
  erase(tombstone: {
    name: string;
    slug: string;
    deletedAt: Date;
  }): Promise<void>;
};

/** The statuses of a job that is not over: it can still become, or be, a run. */
const ACTIVE_JOB_STATUSES = ["queued", "running", "superseded"] as const;

export function createWorkspaceErasureRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
): WorkspaceErasure {
  const ownJobs = () =>
    db.selectFrom("jobs").select("id").where("workspace_id", "=", workspaceId);
  const ownRepositories = () =>
    db
      .selectFrom("repositories")
      .select("id")
      .where("workspace_id", "=", workspaceId);

  return {
    async lockActiveJobs() {
      if (databaseDriver(db) !== "postgres") return;
      await ownRepositories().orderBy("id").forUpdate().execute();
      await lockJobRowsInOrder(
        db,
        ownJobs().where("status", "in", ACTIVE_JOB_STATUSES),
      );
    },

    async hasRunningJobs(now) {
      const row = await db
        .selectFrom("jobs")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where((eb) =>
          eb.or([
            eb("status", "=", "running"),
            eb.and([
              eb("status", "=", "superseded"),
              eb("lease_expires_at", ">", formatTimestamp(now)),
            ]),
          ]),
        )
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async hasOpenPayment(since) {
      const row = await db
        .selectFrom("billing_topup_intents")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("state", "not in", ["paid", "failed"])
        .where("created_at", ">=", formatTimestamp(since))
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async openChecks() {
      const rows = await db
        .selectFrom("job_check_runs")
        .innerJoin("jobs", "jobs.id", "job_check_runs.job_id")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .select([
          "jobs.id as job_id",
          "jobs.head_sha as head_sha",
          "job_check_runs.check_run_id as check_run_id",
          "repositories.integration_id as integration_id",
          "repositories.external_id as external_id",
          "repositories.full_name as full_name",
          "repositories.url as url",
        ])
        .where("job_check_runs.workspace_id", "=", workspaceId)
        .where("jobs.workspace_id", "=", workspaceId)
        .where("jobs.status", "=", "queued")
        .where("job_check_runs.check_state", "=", "active")
        .where((eb) =>
          eb.or([
            eb("job_check_runs.check_run_id", "is not", null),
            eb("job_check_runs.check_create_attempts", ">", 0),
          ]),
        )
        .orderBy("jobs.id")
        .execute();
      return rows.map((row) => ({
        jobId: row.job_id,
        headSha: row.head_sha,
        checkRunId: row.check_run_id,
        repo: {
          integrationId: row.integration_id,
          externalId: row.external_id,
          fullName: row.full_name,
          url: row.url,
        },
      }));
    },

    async erase({ name, slug, deletedAt }) {
      // Everything that hangs off a job first, then the jobs (the foreign keys point from the leaves to the roots).
      await db
        .deleteFrom("job_claimed_keys")
        .where("job_id", "in", ownJobs())
        .execute();
      await db
        .deleteFrom("job_dispatches")
        .where("job_id", "in", ownJobs())
        .execute();
      await db
        .deleteFrom("job_comments")
        .where("job_id", "in", ownJobs())
        .execute();
      // The Implementer's turns point at jobs and sessions, its sessions at repositories (#751): turns first.
      for (const table of [
        "implementer_turns",
        "implementer_sessions",
        "job_check_runs",
        "job_vm_runs",
        "usage_records",
        "refusal_notices",
      ] as const)
        await db
          .deleteFrom(table)
          .where("workspace_id", "=", workspaceId)
          .execute();
      // A job may point at the job that superseded it; both are this workspace's and go in one statement.
      await db
        .deleteFrom("jobs")
        .where("workspace_id", "=", workspaceId)
        .execute();

      await db
        .deleteFrom("projects")
        .where("repository_id", "in", ownRepositories())
        .execute();
      await db
        .deleteFrom("repositories")
        .where("workspace_id", "=", workspaceId)
        .execute();
      await db
        .deleteFrom("integrations")
        .where("workspace_id", "=", workspaceId)
        .execute();

      for (const table of [
        "installation_link_requests",
        "invitations",
        "workspace_members",
        "app_settings",
        "workspace_secrets",
        "workspace_entitlements",
        "plan_handoff_tokens",
        "billing_workspace_settings",
        "billing_notifications",
      ] as const)
        await db
          .deleteFrom(table)
          .where("workspace_id", "=", workspaceId)
          .execute();

      // The billing profile: a profile that never reached the payment provider has nothing to keep and goes. One that did keeps
      // the provider's customer reference (a refund or a dispute of an earlier payment may still need it) and the time and the
      // terms of the business confirmation; the legal name, the address, the VAT id and the person who confirmed are erased.
      await db
        .deleteFrom("billing_profiles")
        .where("workspace_id", "=", workspaceId)
        .where("customer_ref", "is", null)
        .execute();
      await db
        .updateTable("billing_profiles")
        .set({
          legal_name: "",
          country: "",
          address_line1: "",
          address_line2: null,
          postal_code: "",
          city: "",
          vat_id: null,
          confirmed_by: null,
        })
        .where("workspace_id", "=", workspaceId)
        .execute();

      // The tombstone: nobody can find the workspace by its name or address any more, and the address is free again.
      await db
        .updateTable("workspaces")
        .set({
          name,
          slug,
          created_by: null,
          deleted_at: formatTimestamp(deletedAt),
        })
        .where("id", "=", workspaceId)
        .execute();
    },
  };
}
