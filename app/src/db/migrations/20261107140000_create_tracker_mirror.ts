// SPDX-License-Identifier: LicenseRef-Proprietary

// The ticket mirror (#923, epic #915): a read cache of the issues and pull requests of a repository, rebuilt from GitHub at any time and
// never the source of truth (`docs/ticket-mirror.md`). Three changes:
//  - `tracker_items`: one row per issue or pull request, in the shape GitHub delivers it (state, type and board status are stored as
//    GitHub names them, nothing is mapped);
//  - `tracker_sync_state`: where a full sync stands (the cursor of the phase it is in) and when the last one ended;
//  - `workflow_runs.ticket_ref`: the ticket a run is about (`github:owner/repo#128`), which the cache is enriched with at read time.
//    Runs started by the label trigger and runs started with a `ticket` input get it from their trigger input here; runs written afterwards
//    get it when they are written.
//
// Expand only, safe for the version that is still running (it never reads the new tables or the new column) and for the live database:
//  - two tables are added; their foreign keys to `workspaces` and `repositories` take a short lock on those tables;
//  - one nullable column without a default is added to `workflow_runs`, which Postgres does without rewriting the table; the backfill
//    touches only the rows of the label trigger (a handful: the trigger exists since #845) and the rows started with a ticket (since
//    #916), and the input of those is JSON that the platform itself wrote (a text that is none is read as "no ticket" instead of
//    stopping the batch);
//  - the wait for the locks is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`)
//    and the deployment can be run again.
//
// `project_id` is nullable and has no foreign key: a project is the review project of a repository today and becomes the ticket source
// with #922, which decides what the column points at. Until then the rows are keyed by the repository.
//
// `down` drops the tables (the cache is rebuilt by the next sync) and the column (the tickets of the runs are read from their input again).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await db.schema
      .createTable("tracker_items")
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("repository_id", "text", (column) =>
        column.notNull().references("repositories.id"),
      )
      // Reserved for #922 (the project as the ticket source); null until then.
      .addColumn("project_id", "text")
      .addColumn("provider", "text", (column) => column.notNull())
      // "owner/name" as the provider names the repository.
      .addColumn("repo", "text", (column) => column.notNull())
      .addColumn("number", "integer", (column) => column.notNull())
      // The provider's global id: how a board item (which names its content by node id) finds its row.
      .addColumn("node_id", "text", (column) => column.notNull())
      .addColumn("kind", "text", (column) => column.notNull())
      // `open` or `closed`, as GitHub says it; a merged pull request is `closed` with the reason `merged`.
      .addColumn("state", "text", (column) => column.notNull())
      .addColumn("state_reason", "text")
      // The issue type as the organization named it (`Bug`, `Task`, ...); null for none and for a pull request.
      .addColumn("type", "text")
      .addColumn("title", "text", (column) => column.notNull())
      .addColumn("body_excerpt", "text", (column) =>
        column.notNull().defaultTo(""),
      )
      // JSON text: `[{ "name", "color" }]`.
      .addColumn("labels", "text", (column) => column.notNull().defaultTo("[]"))
      // JSON text: `[{ "login" }]`.
      .addColumn("assignees", "text", (column) =>
        column.notNull().defaultTo("[]"),
      )
      // The value of the Status field of the project board, as the board names it; null when the item is on no board.
      .addColumn("board_status", "text")
      .addColumn("parent_number", "integer")
      // JSON text: the numbers of the pull requests that close this issue (an issue) ...
      .addColumn("pull_requests", "text", (column) =>
        column.notNull().defaultTo("[]"),
      )
      // ... and the numbers of the issues this pull request closes (a pull request); what `pull_requests` is computed from.
      .addColumn("closes", "text", (column) => column.notNull().defaultTo("[]"))
      // The state of the checks of an open pull request, as GitHub names it (`success`, `failure`, `in_progress`, ...).
      .addColumn("checks_state", "text")
      // GitHub's own time of the last change (the newest one the row has taken: an older delivery does not replace it), and when this
      // row was last written from GitHub.
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addColumn("synced_at", "text", (column) => column.notNull())
      // The tombstone of an issue GitHub deleted or moved: the row stays, hidden from every read, so that a delivery older than the
      // deletion cannot bring the issue back. Null for a ticket that exists.
      .addColumn("deleted_at", "text")
      // When a board last said something about the item (a full sync or a delivery): what a full sync of the board resets by, so that the
      // statuses it did not see are emptied at its end and not before it has read anything.
      .addColumn("board_seen_at", "text")
      .addPrimaryKeyConstraint("tracker_items_pkey", [
        "repository_id",
        "number",
      ])
      .addCheckConstraint(
        "tracker_items_shape_check",
        sql`kind in ('issue', 'pull_request')
          and state in ('open', 'closed')
          and number > 0
          and char_length(title) <= 1024
          and char_length(body_excerpt) <= 4096
          and char_length(labels) <= 65536
          and char_length(assignees) <= 65536
          and char_length(pull_requests) <= 65536
          and char_length(closes) <= 65536`,
      )
      .execute();

    // The list of a repository: the newest change first, ties by the higher number (`listItems`), tombstones left out.
    await sql`create index tracker_items_list_index
      on tracker_items (workspace_id, repository_id, state, updated_at desc, number desc)
      where deleted_at is null`.execute(db);
    await sql`create index tracker_items_node_index
      on tracker_items (workspace_id, node_id)`.execute(db);

    await db.schema
      .createTable("tracker_sync_state")
      .addColumn("repository_id", "text", (column) =>
        column.primaryKey().references("repositories.id"),
      )
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      // Reserved for #922; null until then.
      .addColumn("project_id", "text")
      // JSON text: the phase of a full sync that is under way and where it stands; null when none is.
      .addColumn("cursor", "text")
      // When the sync under way began: rows not written since are gone from GitHub and are removed when it ends.
      .addColumn("started_at", "text")
      .addColumn("last_full_sync_at", "text")
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "tracker_sync_state_cursor_check",
        sql`"cursor" is null or char_length("cursor") <= 4096`,
      )
      .execute();
    await sql`create index tracker_sync_state_workspace_index
      on tracker_sync_state (workspace_id)`.execute(db);

    await sql`alter table workflow_runs add column if not exists ticket_ref text`.execute(
      db,
    );
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_ticket_ref_check`.execute(
      db,
    );
    await sql`alter table workflow_runs add constraint workflow_runs_ticket_ref_check
      check (ticket_ref is null or char_length(ticket_ref) <= 512) not valid`.execute(
      db,
    );
    await sql`alter table workflow_runs validate constraint workflow_runs_ticket_ref_check`.execute(
      db,
    );
    // The input of a run is JSON that the platform wrote, but a text that is none must not stop the batch: `pg_temp.try_jsonb` answers null
    // for it (the run then names no ticket). The candidates are picked by their trigger first, in a CTE that is materialized, so that
    // the input of no other run is read at all.
    await sql`create function pg_temp.try_jsonb(input text) returns jsonb
      language plpgsql immutable as $$
      begin
        return input::jsonb;
      exception when others then
        return null;
      end;
      $$`.execute(db);
    // The label trigger stored the issue and the repository as JSON (`label-trigger.ts`; since #916 the ticket next to them, and under the
    // kind `ticket.labeled`): the ticket is `github:<repo>#<number>`.
    await sql`with candidates as materialized (
        select id, pg_temp.try_jsonb(trigger_input) as input
        from workflow_runs
        where trigger_kind in ('github.issueLabeled', 'ticket.labeled')
          and ticket_ref is null
      )
      update workflow_runs r
      set ticket_ref = 'github:' || (c.input -> 'repo' ->> 'fullName') || '#' || (c.input -> 'issue' ->> 'number')
      from candidates c
      where r.id = c.id
        and (c.input -> 'repo' ->> 'fullName') is not null
        and (c.input -> 'issue' ->> 'number') is not null`.execute(db);
    // A run started by hand or through the API with a `ticket` input stored `{ input, ticket }` (#916, `readStoredInput`): exactly those two
    // fields, both records. Any other input (every run without a ticket stored it as handed in, and may have fields of its own called
    // `input`, `ticket` or `repo`) names no ticket.
    await sql`with candidates as materialized (
        select id, pg_temp.try_jsonb(trigger_input) as input
        from workflow_runs
        where trigger_kind in ('manual', 'api')
          and ticket_ref is null
      )
      update workflow_runs r
      set ticket_ref = 'github:' || (c.input -> 'ticket' -> 'repo' ->> 'fullName') || '#' || (c.input -> 'ticket' ->> 'number')
      from candidates c
      where r.id = c.id
        and case when jsonb_typeof(c.input) = 'object'
          then (c.input - 'input' - 'ticket') = '{}'::jsonb
            and jsonb_typeof(c.input -> 'input') = 'object'
            and jsonb_typeof(c.input -> 'ticket') = 'object'
            and jsonb_typeof(c.input -> 'ticket' -> 'repo' -> 'fullName') = 'string'
            and jsonb_typeof(c.input -> 'ticket' -> 'number') = 'number'
          else false end`.execute(db);
    await sql`drop function pg_temp.try_jsonb(text)`.execute(db);
    // The enrichment of a list of tickets reads the runs of each (cost so far, the active run).
    await sql`create index if not exists workflow_runs_ticket_index
      on workflow_runs (workspace_id, ticket_ref) where ticket_ref is not null`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`drop index if exists workflow_runs_ticket_index`.execute(db);
    await sql`alter table workflow_runs drop constraint if exists workflow_runs_ticket_ref_check`.execute(
      db,
    );
    await sql`alter table workflow_runs drop column if exists ticket_ref`.execute(
      db,
    );
    await db.schema.dropTable("tracker_sync_state").ifExists().execute();
    await db.schema.dropTable("tracker_items").ifExists().execute();
  },
};
