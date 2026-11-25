// SPDX-License-Identifier: LicenseRef-Proprietary

// #1158 (epic #1157): the placement of a hosted runner. The migration is expand only: `implementer_environments` gets `placement` (`vercel` on every row that
// exists, a check that only a hosted runner may be placed on Cloudflare), and the unique index of the hosted runners becomes one for each workspace, placement and
// size. It can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261125150000_add_hosted_runner_placement.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261125150000_add_hosted_runner_placement";
const T = "2026-11-25T08:00:00.000Z";

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
  await sql`insert into workspaces (id, name, slug, created_by, created_at)
    values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(db);
}

const hosted = (
  db: Kysely<Database>,
  id: string,
  vcpus: number,
  placement?: string,
) =>
  placement === undefined
    ? sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, concurrency, created_at, updated_at)
        values (${id}, 'w-1', ${id}, ${vcpus}, 'hosted', 2, ${T}, ${T})`.execute(
        db,
      )
    : sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, concurrency, placement, created_at, updated_at)
        values (${id}, 'w-1', ${id}, ${vcpus}, 'hosted', 2, ${placement}, ${T}, ${T})`.execute(
        db,
      );

describe("the hosted runner placement migration", () => {
  // #1158-M01
  it("gives every row that exists the placement vercel and changes nothing else", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db);
    await hosted(db, "h-4", 4);
    await sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, created_by, created_at, updated_at)
      values ('mine', 'w-1', 'Mine', 2, 'hosted', 'u-1', ${T}, ${T})`.execute(
      db,
    );

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(
      await db
        .selectFrom("implementer_environments")
        .select(["id", "name", "vcpus", "concurrency", "placement"])
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "h-4", name: "h-4", vcpus: 4, concurrency: 2, placement: "vercel" },
      {
        id: "mine",
        name: "Mine",
        vcpus: 2,
        concurrency: null,
        placement: "vercel",
      },
    ]);
  });

  // #1158-M02
  it("holds one hosted runner for each workspace, placement and size: a Cloudflare runner of 4 vCPU stands beside the Vercel one, a second of either does not", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await seed(db);
    await hosted(db, "v-4", 4, "vercel");
    await hosted(db, "c-4", 4, "cloudflare");

    await expect(hosted(db, "c-4b", 4, "cloudflare")).rejects.toThrow();
    await expect(hosted(db, "v-4b", 4, "vercel")).rejects.toThrow();
    await hosted(db, "c-8", 8, "cloudflare");
    // An environment of a person with the same size is no hosted runner and has no such limit.
    await sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, created_by, created_at, updated_at)
      values ('mine-4', 'w-1', 'Mine 4', 4, 'hosted', 'u-1', ${T}, ${T})`.execute(
      db,
    );
  });

  // #1158-M03
  it("refuses a placement that is none, and a Cloudflare placement on anything but a hosted runner", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await seed(db);

    await expect(hosted(db, "x", 4, "azure")).rejects.toThrow();
    await expect(
      sql`insert into implementer_environments (id, workspace_id, name, vcpus, kind, placement, created_by, created_at, updated_at)
        values ('p', 'w-1', 'Person', 4, 'hosted', 'cloudflare', 'u-1', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow();
  });

  // #1158-M04
  it("can be taken back: the Cloudflare rows go, the Vercel ones stay and the old index holds again", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    await seed(db);
    await hosted(db, "v-4", 4, "vercel");
    await hosted(db, "c-4", 4, "cloudflare");

    await migration.down?.(db);

    expect(
      (
        await db.selectFrom("implementer_environments").select("id").execute()
      ).map((row) => row.id),
    ).toEqual(["v-4"]);
    await expect(hosted(db, "again", 4)).rejects.toThrow();
  });
});
