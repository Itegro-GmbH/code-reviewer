// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira webhooks seen from outside every workspace (#1039). INSTANCE LEVEL, on purpose: a delivery of Jira names a connection (#1131; before
// that a registration) by the id in the address it was sent to, before anybody knows the workspace, and the nightly job extends the webhooks of every workspace. Both only
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

/** A connection as a delivery of the shared address needs it: its workspace and site, and what is kept of the address. */
export type DirectoryJiraEndpoint = {
  connectionId: string;
  workspaceId: string;
  cloudId: string;
  siteUrl: string;
  /** The generation whose derived secret the address carries. */
  generation: number;
  /** When a bearer token that verified was first seen on a delivery of the address; null while none was. */
  bearerSeenAt: string | null;
};

export type JiraWebhookDirectory = {
  /** The row a per-project address (before #1131) names by its id, whatever its workspace; undefined for none. */
  findById(id: string): Promise<DirectoryJiraWebhook | undefined>;
  /** The connection the shared address names by its id, whatever its workspace; undefined for none. */
  findConnection(
    connectionId: string,
  ): Promise<DirectoryJiraEndpoint | undefined>;
  /**
   * The projects the nightly job walks, of every workspace: those that have a webhook row, and the active projects whose ticket source is a
   * Jira project and that have none (a registration that never got as far as its row). At most `limit`: those with a row first, and of
   * those the ones that are not registered yet, then the ones that end first, so a run that is cut short leaves the ones with most time left.
   * With `due` only the rows that wait for a try that is due soon (the frequent run of the cron job, #1131): `pending` after a move of the
   * connection's webhooks or after Jira was unavailable, the oldest first. Rows that failed for another reason wait for the nightly run.
   */
  listProjects(
    limit: number,
    options?: { due?: boolean },
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

    async findConnection(connectionId) {
      const row = await db
        .selectFrom("jira_connections")
        .select([
          "id",
          "workspace_id",
          "cloud_id",
          "site_url",
          "webhook_generation",
          "webhook_bearer_seen_at",
        ])
        .where("id", "=", connectionId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            connectionId: row.id,
            workspaceId: row.workspace_id,
            cloudId: row.cloud_id,
            siteUrl: row.site_url,
            generation: row.webhook_generation,
            bearerSeenAt: row.webhook_bearer_seen_at,
          };
    },

    async listProjects(limit, options) {
      if (options?.due === true) {
        const { rows } = await sql<{
          workspace_id: string;
          project_id: string;
        }>`select workspace_id, project_id from jira_webhooks
          where status = 'pending' and jira_webhook_id is null
            and error_code in ('jira_webhook_move_pending', 'jira_unavailable')
          order by updated_at, id
          limit ${limit}`.execute(db);
        return rows.map((row) => ({
          workspaceId: row.workspace_id,
          projectId: row.project_id,
        }));
      }
      const { rows } = await sql<{ workspace_id: string; project_id: string }>`
        select workspace_id, project_id from (
          select workspace_id, project_id, 0 as rank, coalesce(expires_at, '') as at, id as tie from jira_webhooks
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
