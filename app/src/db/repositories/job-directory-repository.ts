// SPDX-License-Identifier: LicenseRef-Proprietary

// The jobs of every workspace, for the instance admin's job view (#541). Instance level on purpose
// (`scoping.test.ts`, `README.md` "Workspace scoping"): the operator who runs the instance looks at a
// run by its id without being a member of the workspace it belongs to, to see what a run did. It only
// reads, never lists more than a page, and every answer names its workspace. A member of a workspace
// never reaches it: the only callers are the pages and routes of the admin portal, behind the admin
// guard. What a member sees of a run goes through the scoped runs repository.
import "server-only";
import type { Kysely } from "kysely";
import type { Job } from "../../jobs/job-types.ts";
import type { Database } from "../schema.ts";
import {
  decodeJobVocabulary,
  decodeReviewKind,
  toJob,
} from "./jobs-repository.ts";
import type { JobKind } from "../../job-kind/job-kind.ts";
import type { JobStatus } from "../job-status.ts";
import { NOT_DELETED } from "./workspaces-repository.ts";

/** One line of the admin's list: the listed fields only, never the result or the arguments. */
export type DirectoryRunRow = {
  id: string;
  workspaceSlug: string;
  workspaceName: string;
  project: string;
  prNumber: number;
  reviewKind: JobKind;
  status: JobStatus;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
};

/** A job with the names of its workspace and its repository. */
export type DirectoryRun = {
  job: Job;
  project: string;
  workspaceSlug: string;
  workspaceName: string;
};

export type JobDirectoryRepository = {
  /** The newest jobs of the instance first (creation time, then id); `hasMore` says the list is cut. */
  list(limit: number): Promise<{ runs: DirectoryRunRow[]; hasMore: boolean }>;
  /** One job by its id; undefined for an id nobody has. */
  get(id: string): Promise<DirectoryRun | undefined>;
};

export function createJobDirectoryRepository(
  db: Kysely<Database>,
): JobDirectoryRepository {
  return {
    async list(limit) {
      const bound = Math.max(1, Math.trunc(limit));
      const rows = await db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .innerJoin("workspaces", "workspaces.id", "jobs.workspace_id")
        .select([
          "jobs.id",
          "jobs.pr_number",
          "jobs.review_kind",
          "jobs.command",
          "jobs.trigger_kind",
          "jobs.status",
          "jobs.created_at",
          "jobs.claimed_at",
          "jobs.finished_at",
          "jobs.error_code",
          "repositories.full_name as project",
          "workspaces.slug as workspace_slug",
          "workspaces.name as workspace_name",
        ])
        .where(NOT_DELETED)
        .orderBy("jobs.created_at", "desc")
        .orderBy("jobs.id", "desc")
        .limit(bound + 1)
        .execute();
      return {
        runs: rows.slice(0, bound).map((row) => ({
          id: row.id,
          workspaceSlug: row.workspace_slug,
          workspaceName: row.workspace_name,
          project: row.project,
          prNumber: row.pr_number,
          reviewKind: decodeReviewKind(row),
          status: decodeJobVocabulary(row).status,
          createdAt: row.created_at,
          claimedAt: row.claimed_at,
          finishedAt: row.finished_at,
          errorCode: row.error_code,
        })),
        hasMore: rows.length > bound,
      };
    },

    async get(id) {
      const row = await db
        .selectFrom("jobs")
        .innerJoin("repositories", "repositories.id", "jobs.repository_id")
        .innerJoin("workspaces", "workspaces.id", "jobs.workspace_id")
        .selectAll("jobs")
        .select([
          "repositories.full_name as project",
          "workspaces.slug as workspace_slug",
          "workspaces.name as workspace_name",
        ])
        .where("jobs.id", "=", id)
        .where(NOT_DELETED)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        job: toJob(row),
        project: row.project,
        workspaceSlug: row.workspace_slug,
        workspaceName: row.workspace_name,
      };
    },
  };
}
