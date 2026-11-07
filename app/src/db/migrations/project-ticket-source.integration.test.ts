// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the project as one ticket source. The migration adds `projects.ticket_source` and `workflows.project_id`, gives every workflow to a
// project (the repository its newest run used, else the only active project of its workspace) and archives and logs the ones it cannot
// place, fills the project of the mirror's rows, and holds the name of a lane once per project. Expand only; `down` takes it back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261107190000_project_ticket_source.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107190000_project_ticket_source";
const T = "2026-11-06T08:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

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

async function workspace(
  db: Kysely<Database>,
  id: string,
  repositories: Array<{ id: string; name: string; project?: "on" | "off" }>,
) {
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values (${id}, ${id}, ${id}, 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values (${`i-${id}`}, ${id}, 'github_app', ${id}, ${`ext-${id}`}, '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  for (const repository of repositories) {
    await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
      values (${repository.id}, ${id}, ${`i-${id}`}, ${`ext-${repository.id}`}, ${repository.name}, ${`https://github.test/${repository.name}`}, 1, ${T}, ${T})`.execute(
      db,
    );
    if (repository.project !== undefined)
      await sql`insert into projects (id, repository_id, active, settings, created_at, updated_at)
        values (${`p-${repository.id}`}, ${repository.id}, ${repository.project === "on" ? 1 : 0}, '{}', ${T}, ${T})`.execute(
        db,
      );
  }
}

async function workflow(
  db: Kysely<Database>,
  id: string,
  workspaceId: string,
  options: { archived?: boolean } = {},
) {
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at, archived_at)
    values (${id}, ${workspaceId}, ${`Lane ${id}`}, 1, 'u-1', ${T}, ${T}, ${options.archived === true ? T : null})`.execute(
    db,
  );
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values (${id}, 1, ${workspaceId}, '{}', 'u-1', ${T})`.execute(db);
}

async function run(
  db: Kysely<Database>,
  id: string,
  workflowId: string,
  workspaceId: string,
  repositoryId: string,
  createdAt: string,
) {
  await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, trigger_kind, created_at, updated_at)
    values (${id}, ${workspaceId}, ${workflowId}, 1, ${repositoryId}, 'main', '{}', 'running', 1000000, ${`req-${id}`}, 'u-1', 'octocat', 'manual', ${createdAt}, ${createdAt})`.execute(
    db,
  );
}

/** The state of a factory before #922: workspaces of every kind, with lanes that belong to no project yet. */
async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  // Two active projects: a lane goes where its newest run went; one that never ran cannot be placed.
  await workspace(db, "w-two", [
    { id: "r-a", name: "acme/a", project: "on" },
    { id: "r-b", name: "acme/b", project: "on" },
  ]);
  await workflow(db, "wf-ran-in-b", "w-two");
  await run(
    db,
    "run-1",
    "wf-ran-in-b",
    "w-two",
    "r-a",
    "2026-11-05T08:00:00.000Z",
  );
  await run(
    db,
    "run-2",
    "wf-ran-in-b",
    "w-two",
    "r-b",
    "2026-11-06T08:00:00.000Z",
  );
  await workflow(db, "wf-never-ran", "w-two");
  // The playground: one project, one lane that never ran.
  await workspace(db, "w-playground", [
    { id: "r-playground", name: "acme/playground", project: "on" },
    { id: "r-without-project", name: "acme/plain" },
  ]);
  await workflow(db, "wf-playground", "w-playground");
  await workflow(db, "wf-archived", "w-playground", { archived: true });
  // A repository with a project that is switched off is no "only active project".
  await workspace(db, "w-off", [
    { id: "r-off", name: "acme/off", project: "off" },
  ]);
  await workflow(db, "wf-in-off-workspace", "w-off");
  // No project at all.
  await workspace(db, "w-none", [{ id: "r-none", name: "acme/none" }]);
  await workflow(db, "wf-orphan", "w-none");
  // The mirror.
  await sql`insert into tracker_items (workspace_id, repository_id, project_id, provider, repo, number, node_id, kind, state, title, updated_at, synced_at)
    values ('w-two', 'r-a', null, 'github', 'acme/a', 1, 'I_1', 'issue', 'open', 'Issue', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into tracker_sync_state (repository_id, workspace_id, project_id, updated_at)
    values ('r-a', 'w-two', null, ${T})`.execute(db);
}

async function projectsOfWorkflows(db: Kysely<Database>) {
  const rows = await db
    .selectFrom("workflows")
    .select(["id", "project_id", "archived_at"])
    .orderBy("id")
    .execute();
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      { project: row.project_id, archived: row.archived_at !== null },
    ]),
  );
}

describe("the project as one ticket source migration", () => {
  // #922-T01
  it("gives each workflow to the project its newest run used, else to the only active project of its workspace, and archives and logs the rest", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(await projectsOfWorkflows(db)).toEqual({
      // Its newest run worked in acme/b.
      "wf-ran-in-b": { project: "p-r-b", archived: false },
      // Two active projects and no run: it cannot be placed.
      "wf-never-ran": { project: null, archived: true },
      // The existing lane goes to the playground project.
      "wf-playground": { project: "p-r-playground", archived: false },
      // Already archived: left as it was.
      "wf-archived": { project: null, archived: true },
      // The only project of the workspace is switched off.
      "wf-in-off-workspace": { project: null, archived: true },
      "wf-orphan": { project: null, archived: true },
    });
    // The log names each lane that was archived, one line each, never a document.
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(3);
    for (const id of ["wf-never-ran", "wf-in-off-workspace", "wf-orphan"])
      expect(lines.filter((line) => line.includes(id))).toHaveLength(1);
    expect(lines.every((line) => line.includes(THIS))).toBe(true);
    await db.destroy();
  });

  // #922-T02
  it("points the rows of the mirror at the project of their repository and leaves the projects without a stored source", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db
        .selectFrom("tracker_items")
        .select(["repository_id", "project_id"])
        .execute(),
    ).toEqual([{ repository_id: "r-a", project_id: "p-r-a" }]);
    expect(
      await db
        .selectFrom("tracker_sync_state")
        .select(["repository_id", "project_id"])
        .execute(),
    ).toEqual([{ repository_id: "r-a", project_id: "p-r-a" }]);
    const sources = await db
      .selectFrom("projects")
      .select("ticket_source")
      .execute();
    expect(sources.every((row) => row.ticket_source === null)).toBe(true);
    await db.destroy();
  });

  // #922-T03
  it("holds the name of a lane once per project: the same name in two projects is fine, in one project it is not", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
    await workspace(db, "w-1", [
      { id: "r-1", name: "acme/one", project: "on" },
      { id: "r-2", name: "acme/two", project: "on" },
    ]);
    const lane = (id: string, project: string | null, name: string) =>
      sql`insert into workflows (id, workspace_id, project_id, name, current_version, created_by, created_at, updated_at)
        values (${id}, 'w-1', ${project}, ${name}, 1, 'u-1', ${T}, ${T})`.execute(
        db,
      );

    await lane("a", "p-r-1", "Issue to PR");
    await lane("b", "p-r-2", "issue to pr");
    await expect(lane("c", "p-r-1", "ISSUE TO PR")).rejects.toThrow(
      /workflows_workspace_name_unique/,
    );
    // Lanes of no project keep the rule of the workspace among themselves.
    await lane("d", null, "Old");
    await expect(lane("e", null, "old")).rejects.toThrow(
      /workflows_workspace_name_unique/,
    );
    await db.destroy();
  });

  // #922-T04
  it("refuses a lane whose project does not exist and a ticket source that is too long", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
    await workspace(db, "w-1", [
      { id: "r-1", name: "acme/one", project: "on" },
    ]);

    await expect(
      sql`insert into workflows (id, workspace_id, project_id, name, current_version, created_by, created_at, updated_at)
        values ('x', 'w-1', 'no-such-project', 'X', 1, 'u-1', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
    await expect(
      sql`update projects set ticket_source = ${"x".repeat(4097)} where id = 'p-r-1'`.execute(
        db,
      ),
    ).rejects.toThrow();
    await db.destroy();
  });

  // #922-T05
  it("is undone by `down`, and comes back by running it again", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    await migration.down?.(db);
    const columns = sql<{
      name: string;
    }>`select table_name || '.' || column_name as name from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'projects' and column_name = 'ticket_source') or
        (table_name = 'workflows' and column_name = 'project_id'))
      order by 1`;
    expect((await columns.execute(db)).rows).toEqual([]);

    await migration.up(db);
    expect((await columns.execute(db)).rows.map((row) => row.name)).toEqual([
      "projects.ticket_source",
      "workflows.project_id",
    ]);
    await db.destroy();
  });
});
