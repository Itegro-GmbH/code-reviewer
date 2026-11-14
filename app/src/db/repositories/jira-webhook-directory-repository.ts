// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira webhooks seen from outside every workspace (#1039). INSTANCE LEVEL, on purpose: a delivery of Jira names a registration by the id
// in the address it was sent to, before anybody knows the workspace, and the nightly job extends the webhooks of every workspace. Both only
// read; every answer carries `workspaceId` (and the site of the connection), and everything done next goes through repositories created
// for that workspace. Writing webhook rows is the job of jira-webhooks-repository.ts, which is always scoped.
import "server-only";
import { sql, type Kysely } from "kysely";
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
  /**
   * The projects the nightly job walks, of every workspace: those that have a webhook row, and the active projects whose ticket source is a
   * Jira project and that have none (a registration that never got as far as its row). At most `limit`, those with a row first.
   */
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
      const { rows } = await sql<{ workspace_id: string; project_id: string }>`
        select workspace_id, project_id from (
          select workspace_id, project_id, 0 as rank, created_at as at, id as tie from jira_webhooks
          union all
          select r.workspace_id, p.id, 1, p.created_at, p.id
          from projects p
          join repositories r on r.id = p.repository_id
          where p.active = 1
            and json_or_null(p.ticket_source) ->> 'provider' = 'jira'
            and not exists (select 1 from jira_webhooks w where w.project_id = p.id)
        ) walked
        order by rank, at, tie
        limit ${limit}`.execute(db);
      return rows.map((row) => ({
        workspaceId: row.workspace_id,
        projectId: row.project_id,
      }));
    },
  };
}
