// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira webhooks seen from outside every workspace (#1039). INSTANCE LEVEL, on purpose: a delivery of Jira names a registration by the id
// in the address it was sent to, before anybody knows the workspace, and the nightly job extends the webhooks of every workspace. Both only
// read; every answer carries `workspaceId` (and the site of the connection), and everything done next goes through repositories created
// for that workspace. Writing webhook rows is the job of jira-webhooks-repository.ts, which is always scoped.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";
import {
  toStoredJiraWebhook,
  type StoredJiraWebhook,
} from "./jira-webhooks-repository.ts";

/** A webhook row with the site of its connection, what a delivery needs to be read and attributed. */
export type DirectoryJiraWebhook = StoredJiraWebhook & {
  cloudId: string;
  siteUrl: string;
};

export type JiraWebhookDirectory = {
  /** The row an address names by its id, whatever its workspace; undefined for none. */
  findById(id: string): Promise<DirectoryJiraWebhook | undefined>;
  /** The projects that have a webhook row, of every workspace: what the nightly job walks. At most `limit`, oldest first. */
  listProjects(
    limit: number,
  ): Promise<{ workspaceId: string; projectId: string }[]>;
};

export function createJiraWebhookDirectory(
  db: Kysely<Database>,
): JiraWebhookDirectory {
  return {
    async findById(id) {
      const row = await db
        .selectFrom("jira_webhooks")
        .innerJoin(
          "jira_connections",
          "jira_connections.id",
          "jira_webhooks.connection_id",
        )
        .selectAll("jira_webhooks")
        .select(["jira_connections.cloud_id", "jira_connections.site_url"])
        .where("jira_webhooks.id", "=", id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const { cloud_id, site_url, ...webhook } = row;
      return {
        ...toStoredJiraWebhook(webhook),
        cloudId: cloud_id,
        siteUrl: site_url,
      };
    },

    async listProjects(limit) {
      const rows = await db
        .selectFrom("jira_webhooks")
        .select(["workspace_id", "project_id"])
        .orderBy("created_at")
        .orderBy("id")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        projectId: row.project_id,
      }));
    },
  };
}
