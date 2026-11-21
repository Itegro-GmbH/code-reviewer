// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105 (ADR 0007, release A): the hosted runners migration is expand only. It adds the nullable `concurrency` to the environments, makes
// the hosted runner of every supported type in every workspace that is not deleted (no row of a person is touched, a taken name is not taken
// from its owner), makes the names of the runners that are not revoked unique within a workspace (the oldest keeps its name), and can be
// taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261121100000_add_hosted_runners";
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

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  for (const [id, slug, deleted] of [
    ["w-1", "acme", null],
    ["w-2", "beta", null],
    ["w-3", "gone", T],
  ] as const)
    await sql`insert into workspaces (id, name, slug, created_by, created_at, deleted_at)
      values (${id}, ${slug}, ${slug}, 'u-1', ${T}, ${deleted})`.execute(db);
  // w-1 has an environment of a person that already has the name of a hosted runner.
  await sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
    values ('env-1', 'w-1', 'vercel sandbox 4 vcpu', 4, 'npm ci', 'u-1', ${T}, ${T})`.execute(
    db,
  );
  const runner = (
    id: string,
    workspace: string,
    name: string,
    at: string,
    revoked: string | null,
  ) =>
    sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at, revoked_at)
      values (${id}, ${workspace}, ${name}, '', '1.0.0', '{}', '{}', ${`hash-${id}`}, ${at}, ${at}, ${revoked})`.execute(
      db,
    );
  // Three runners of one name in w-1 (two that are alive, one revoked), one more that is called like a hosted runner, one in w-2.
  await runner(
    "run-aaaa1111",
    "w-1",
    "DevBox",
    "2026-11-01T00:00:00.000Z",
    null,
  );
  await runner(
    "run-bbbb2222",
    "w-1",
    "devbox",
    "2026-11-02T00:00:00.000Z",
    null,
  );
  await runner("run-cccc3333", "w-1", "DEVBOX", "2026-11-03T00:00:00.000Z", T);
  await runner(
    "run-dddd4444",
    "w-1",
    "Vercel Sandbox 8 vCPU",
    "2026-11-04T00:00:00.000Z",
    null,
  );
  await runner(
    "run-eeee5555",
    "w-2",
    "DevBox",
    "2026-11-01T00:00:00.000Z",
    null,
  );
}

describe("the hosted runners migration", () => {
  // #1105-M01
  it("makes a hosted runner for every type in every workspace that is not deleted, and touches no environment of a person", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    const hosted = await db
      .selectFrom("implementer_environments")
      .select(["workspace_id", "name", "vcpus", "concurrency", "created_by"])
      .where("concurrency", "is not", null)
      .orderBy("workspace_id")
      .orderBy("vcpus")
      .execute();
    expect(hosted.map((row) => [row.workspace_id, row.vcpus])).toEqual([
      ["w-1", 2],
      ["w-1", 4],
      ["w-1", 6],
      ["w-1", 8],
      ["w-2", 2],
      ["w-2", 4],
      ["w-2", 6],
      ["w-2", 8],
    ]);
    for (const row of hosted) {
      expect(row.concurrency).toBe(2);
      expect(row.created_by).toBeNull();
    }
    // A name that is taken is not taken from its owner: the environment of a person and the runner keep theirs.
    expect(
      hosted.filter((row) => row.workspace_id === "w-1").map((row) => row.name),
    ).toEqual([
      "Vercel Sandbox 2 vCPU",
      "Vercel Sandbox 4 vCPU (hosted)",
      "Vercel Sandbox 6 vCPU",
      "Vercel Sandbox 8 vCPU (hosted)",
    ]);
    expect(
      hosted.filter((row) => row.workspace_id === "w-2").map((row) => row.name),
    ).toEqual([
      "Vercel Sandbox 2 vCPU",
      "Vercel Sandbox 4 vCPU",
      "Vercel Sandbox 6 vCPU",
      "Vercel Sandbox 8 vCPU",
    ]);
    expect(
      await db
        .selectFrom("implementer_environments")
        .select(["id", "name", "setup_script", "concurrency"])
        .where("concurrency", "is", null)
        .execute(),
    ).toEqual([
      {
        id: "env-1",
        name: "vercel sandbox 4 vcpu",
        setup_script: "npm ci",
        concurrency: null,
      },
    ]);
  });

  // #1105-M02
  it("makes the names of the runners that are not revoked unique: the oldest keeps its name, a later one gets the start of its id, a revoked one and another workspace are left alone", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    const names = await db
      .selectFrom("runners")
      .select(["id", "name"])
      .orderBy("id")
      .execute();
    expect(names).toEqual([
      { id: "run-aaaa1111", name: "DevBox" },
      { id: "run-bbbb2222", name: "devbox (run-bbbb)" },
      { id: "run-cccc3333", name: "DEVBOX" },
      { id: "run-dddd4444", name: "Vercel Sandbox 8 vCPU" },
      { id: "run-eeee5555", name: "DevBox" },
    ]);
    // And the database holds it from now on.
    await expect(
      sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at)
        values ('x', 'w-1', 'DEVBOX', '', '1.0.0', '{}', '{}', 'hash-x', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  // #1105-M03
  it("holds a hosted runner to a hosted environment with a size and a place of at least one", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
      values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);

    // A workspace on an empty table: a runner needs a size, a place of at least one, and a hosted kind.
    await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'a', 'a', 'u-1', ${T})`.execute(
      db,
    );
    await expect(
      sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, concurrency, created_at, updated_at)
        values ('e', 'w-1', 'zero', 2, 'hosted', 0, ${T}, ${T})`.execute(db),
    ).rejects.toThrow();
    await expect(
      sql`insert into implementer_environments (id, workspace_id, name, kind, labels, concurrency, created_at, updated_at)
        values ('e2', 'w-1', 'box', 'runner', 'linux', 1, ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  // #1105-M04
  it("can be taken back: the hosted runners go, nothing of a person goes", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    const migrations = await migrationProvider.getMigrations();
    const migration = migrations[THIS];
    if (migration === undefined) throw new Error("migration missing");
    await migration.down?.(db);

    expect(
      await db.selectFrom("implementer_environments").select("id").execute(),
    ).toEqual([{ id: "env-1" }]);
    const columns = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
      where table_name = 'implementer_environments' and column_name = 'concurrency'`.execute(
      db,
    );
    expect(columns.rows).toEqual([]);
  });
});
