// SPDX-License-Identifier: LicenseRef-Proprietary

// #973: the harness entries of a manifest become a list `{ harness, version, auth }`. A runner that announced the old map form is rewritten once as the
// app reads it (a ready OpenCode is `app-key`, a ready Claude Code a `subscription`, an entry that is not ready is dropped, the capabilities stay);
// a row that holds a list already, or none, does not change; and it can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { manifestFromText } from "../../runner-identity/announcement.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261110180000_rewrite_runner_manifests";
const T = "2026-11-10T08:00:00.000Z";

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

async function seed(db: Kysely<Database>, manifests: Record<string, string>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  for (const [id, manifest] of Object.entries(manifests))
    await sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at)
      values (${id}, 'w-1', 'box', 'linux', '1.0.0', ${manifest}, '{}', ${`hash-${id}`}, ${T}, ${T})`.execute(
      db,
    );
}

async function manifests(db: Kysely<Database>) {
  const { rows } = await sql<{ id: string; manifest: string }>`
    select id, manifest from runners order by id`.execute(db);
  return Object.fromEntries(
    rows.map((row) => [row.id, JSON.parse(row.manifest) as unknown]),
  );
}

describe("the runner manifest migration", () => {
  it("runs after every migration it builds on", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();
    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261110120000_add_runner_delivery"),
    );
  });

  // #973-T04
  it("rewrites the old map as the list the app reads, leaves the other rows alone, and the app reads every row it wrote", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    const list = JSON.stringify({
      harnesses: [{ harness: "opencode", version: "1", auth: "local-key" }],
      capabilities: [],
    });
    await seed(db, {
      "r-both": JSON.stringify({
        harnesses: {
          opencode: { version: "1.19.0", ready: true },
          "claude-code": { version: "2.1.311", ready: true },
          "custom/idle": { version: "0.1", ready: false },
        },
        capabilities: ["agent-docker"],
      }),
      "r-idle": JSON.stringify({
        harnesses: { opencode: { version: "1.19.0", ready: false } },
      }),
      "r-empty": "{}",
      "r-list": list,
    });
    const before = await manifests(db);

    const { executed } = await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(executed).toContain(THIS);
    const after = await manifests(db);
    expect(after).toEqual({
      "r-both": {
        harnesses: [
          { harness: "claude-code", version: "2.1.311", auth: "subscription" },
          { harness: "opencode", version: "1.19.0", auth: "app-key" },
        ],
        capabilities: ["agent-docker"],
      },
      "r-idle": { harnesses: [], capabilities: [] },
      "r-empty": before["r-empty"],
      "r-list": before["r-list"],
    });
    // What the migration wrote is what the app reads out of the old text.
    expect(
      manifestFromText(JSON.stringify(before["r-both"])).harnesses,
    ).toEqual(
      expect.arrayContaining(
        (after["r-both"] as { harnesses: unknown[] }).harnesses,
      ),
    );
    await db.destroy();
  });

  it("is applied once: running it again changes nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    await seed(db, {
      "r-1": JSON.stringify({
        harnesses: { opencode: { version: "1", ready: true } },
        capabilities: [],
      }),
    });
    await migrateToLatest(db, migrationProvider);
    const once = await manifests(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toEqual([]);
    expect(await manifests(db)).toEqual(once);
    await db.destroy();
  });

  it("can be taken back to the map form", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db, {
      "r-1": JSON.stringify({
        harnesses: [
          { harness: "opencode", version: "1.19.0", auth: "app-key" },
          { harness: "claude-code", version: "2.1.311", auth: "subscription" },
        ],
        capabilities: ["agent-docker"],
      }),
    });

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    expect(await manifests(db)).toEqual({
      "r-1": {
        harnesses: {
          opencode: { version: "1.19.0", ready: true },
          "claude-code": { version: "2.1.311", ready: true },
        },
        capabilities: ["agent-docker"],
      },
    });
    await db.destroy();
  });
});
