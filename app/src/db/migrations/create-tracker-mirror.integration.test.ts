// SPDX-License-Identifier: LicenseRef-Proprietary

// #923: the ticket mirror migration is expand only. It adds two empty tables and one nullable column to a database made by the previous
// release's migrations (the live one has runs of the label trigger), changes no existing row but fills the ticket of those runs, and can
// be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261107140000_create_tracker_mirror.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107140000_create_tracker_mirror";
const T = "2026-11-06T08:00:00.000Z";

function upTo(include: (name: string) => boolean): MigrationProvider {
  return {
    async getMigrations() {
      return Object.fromEntries(
        Object.entries(await migrationProvider.getMigrations()).filter(
          ([name]) => include(name),
        ),
      );
    },
  };
}

async function seedRuns(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'Implement', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
  const run = (
    id: string,
    kind: string,
    input: string,
    createdBy: string | null,
  ) =>
    sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, trigger_kind, created_at, updated_at)
      values (${id}, 'w-1', 'wf-1', 1, 'r-1', 'main', ${input}, 'running', 1000000, ${`req-${id}`}, ${createdBy}, 'octocat', ${kind}, ${T}, ${T})`.execute(
      db,
    );
  await run(
    "run-label",
    "github.issueLabeled",
    JSON.stringify({
      issue: { number: 12 },
      repo: { fullName: "acme/widgets" },
    }),
    null,
  );
  await run(
    "run-manual",
    "manual",
    JSON.stringify({
      issue: { number: 13 },
      repo: { fullName: "acme/widgets" },
    }),
    "u-1",
  );
  // #916: a run a label started stores the ticket next to the issue and the repository, under the new kind.
  await run(
    "run-label-ticket",
    "ticket.labeled",
    JSON.stringify({
      ticket: { number: 14, repo: { fullName: "acme/widgets" } },
      issue: { number: 14 },
      repo: { fullName: "acme/widgets" },
    }),
    null,
  );
  // #916: a run started with a `ticket` input stores `{ input, ticket }`, by hand or through the API.
  await run(
    "run-manual-ticket",
    "manual",
    JSON.stringify({
      input: {},
      ticket: { number: 15, repo: { fullName: "acme/widgets" } },
    }),
    "u-1",
  );
  await run(
    "run-api-ticket",
    "api",
    JSON.stringify({
      input: { note: "x" },
      ticket: { number: 16, repo: { fullName: "acme/widgets" } },
    }),
    "u-1",
  );
  // A raw input of a run without a ticket names none, whatever fields it has: its own `ticket`, or `input` next to other fields.
  await run(
    "run-api-own-ticket",
    "api",
    JSON.stringify({ ticket: "github:acme/widgets#17", repo: "acme/widgets" }),
    "u-1",
  );
  await run(
    "run-manual-own-input",
    "manual",
    JSON.stringify({
      input: {},
      ticket: { number: 18, repo: { fullName: "acme/widgets" } },
      topic: "x",
    }),
    "u-1",
  );
}

describe("the ticket mirror migration", () => {
  // #923-T99
  it("adds the two tables empty and the column of the tickets of runs, and fills it for the runs of the label trigger and the runs started with a ticket, from both shapes of their input", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seedRuns(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    const runs = await db
      .selectFrom("workflow_runs")
      .select(["id", "ticket_ref"])
      .orderBy("id")
      .execute();
    expect(runs).toEqual([
      { id: "run-api-own-ticket", ticket_ref: null },
      { id: "run-api-ticket", ticket_ref: "github:acme/widgets#16" },
      { id: "run-label", ticket_ref: "github:acme/widgets#12" },
      { id: "run-label-ticket", ticket_ref: "github:acme/widgets#14" },
      { id: "run-manual", ticket_ref: null },
      { id: "run-manual-own-input", ticket_ref: null },
      { id: "run-manual-ticket", ticket_ref: "github:acme/widgets#15" },
    ]);
    expect(await db.selectFrom("tracker_items").selectAll().execute()).toEqual(
      [],
    );
    expect(
      await db.selectFrom("tracker_sync_state").selectAll().execute(),
    ).toEqual([]);
    await db.destroy();
  });

  // #923-T100
  it("is undone by `down`, and the tables and the column come back by running it again", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    await migration.down?.(db);
    const gone = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'tracker_%'`.execute(
      db,
    );
    const column = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'workflow_runs' and column_name = 'ticket_ref'`.execute(
      db,
    );
    expect(gone.rows).toEqual([]);
    expect(column.rows).toEqual([]);

    await migration.up(db);
    const back = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'tracker_%' order by 1`.execute(
      db,
    );
    expect(back.rows.map((row) => row.name)).toEqual([
      "tracker_items",
      "tracker_sync_state",
    ]);
    await db.destroy();
  });

  // #923-T101
  it("refuses a ticket reference that is too long", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await seedRuns(db);

    await expect(
      sql`update workflow_runs set ticket_ref = ${"x".repeat(513)} where id = 'run-manual'`.execute(
        db,
      ),
    ).rejects.toThrow();
    await db.destroy();
  });
});
