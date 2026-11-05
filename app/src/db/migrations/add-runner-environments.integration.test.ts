// SPDX-License-Identifier: LicenseRef-Proprietary

// #854: the runner environments migration is expand only. It adds columns with defaults or without, changes no existing row's meaning
// (every environment stays hosted, every turn reads null), keeps the checks of the rows it adds, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261105130000_add_runner_environments";
const T = "2026-11-05T08:00:00.000Z";

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
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
    values ('e-1', 'w-1', 'Node', 4, 'npm ci', 'u-1', ${T}, ${T})`.execute(db);
}

const environment = (
  id: string,
  values: Record<string, string | number | null>,
) =>
  sql`insert into implementer_environments (id, workspace_id, name, kind, labels, vcpus, setup_script, network_mode, network_hosts, created_by, created_at, updated_at)
    values (${id}, 'w-1', ${id}, ${values.kind ?? "hosted"}, ${values.labels ?? ""}, ${values.vcpus ?? null}, ${values.script ?? ""}, ${values.mode ?? "off"}, ${values.hosts ?? ""}, 'u-1', ${T}, ${T})`;

describe("the runner environments migration", () => {
  // #854-T220
  it("leaves every environment hosted with its size and no labels", async () => {
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

    expect(
      await db.selectFrom("implementer_environments").selectAll().execute(),
    ).toEqual([
      expect.objectContaining({
        id: "e-1",
        kind: "hosted",
        labels: "",
        vcpus: 4,
        setup_script: "npm ci",
        network_mode: "off",
      }),
    ]);
    await db.destroy();
  });

  // #854-T221
  it("keeps a hosted environment to a size and no labels, and a runner environment to labels and nothing else", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await environment("ok-hosted", { vcpus: 2 }).execute(db);
    await environment("ok-runner", {
      kind: "runner",
      labels: "gpu\nlinux",
    }).execute(db);
    for (const [what, values] of [
      ["a hosted environment without a size", {}],
      ["a hosted environment with labels", { vcpus: 2, labels: "gpu" }],
      ["a runner environment without labels", { kind: "runner" }],
      [
        "a runner environment with a size",
        { kind: "runner", labels: "a", vcpus: 2 },
      ],
      [
        "a runner environment with a script",
        { kind: "runner", labels: "a", script: "x" },
      ],
      [
        "a runner environment with a network rule",
        { kind: "runner", labels: "a", mode: "open" },
      ],
      ["an environment of another kind", { kind: "vps", vcpus: 2 }],
    ] as const)
      await expect(
        environment(`bad-${what}`, values).execute(db),
        what,
      ).rejects.toThrow(/implementer_environments_kind_check|violates check/);
    await db.destroy();
  });

  // #854-T222
  it("lets a turn copy a runner environment: labels and no size, and refuses a half copy", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, default_branch, created_at, updated_at)
      values ('r-1', 'w-1', 'i-1', '1', 'a/b', 'https://github.com/a/b', 'main', ${T}, ${T})`
      .execute(db)
      .catch(() => undefined);
    let turns = 0;
    const turn = (values: Record<string, string | number | null>) =>
      sql`insert into implementer_turns (id, session_id, workspace_id, number, instruction, model_choice, job_id, created_by, created_at,
          environment_id, environment_name, environment_vcpus, environment_setup_script, environment_kind, environment_labels)
        values (${values.id}, 's-1', 'w-1', ${++turns}, 'x', '{}', ${values.id}, 'u-1', ${T},
          ${values.eid ?? null}, ${values.name ?? null}, ${values.vcpus ?? null}, ${values.script ?? null}, ${values.kind ?? null}, ${values.labels ?? null})`;

    // Foreign keys of the turn (session, job) are not the subject here: the check constraint is judged on its own.
    await sql`set session_replication_role = replica`.execute(db);
    await turn({
      id: "t-runner",
      eid: "e",
      name: "n",
      script: "",
      kind: "runner",
      labels: "gpu",
    }).execute(db);
    await turn({
      id: "t-hosted",
      eid: "e",
      name: "n",
      vcpus: 2,
      script: "x",
    }).execute(db);
    await turn({ id: "t-none" }).execute(db);
    for (const values of [
      { id: "t-1", eid: "e", name: "n", script: "", kind: "runner" },
      {
        id: "t-2",
        eid: "e",
        name: "n",
        vcpus: 2,
        script: "",
        kind: "runner",
        labels: "a",
      },
      { id: "t-3", eid: "e", name: "n", vcpus: 2, script: "", labels: "a" },
      {
        id: "t-4",
        eid: "e",
        name: "n",
        script: "x",
        kind: "runner",
        labels: "a",
      },
      { id: "t-5", kind: "runner", labels: "a" },
    ])
      await expect(turn(values).execute(db), values.id).rejects.toThrow(
        /implementer_turns_environment_check/,
      );
    await db.destroy();
  });

  // #854-T223
  it("can be taken back: the runner environments go, the rest is as it was", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await environment("gone", { kind: "runner", labels: "gpu" }).execute(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    expect(
      await db.selectFrom("implementer_environments").select("id").execute(),
    ).toEqual([{ id: "e-1" }]);
    const { rows } = await sql<{
      name: string;
    }>`select column_name as name from information_schema.columns
      where table_name in ('implementer_environments', 'implementer_turns')
        and column_name in ('kind', 'labels', 'environment_kind', 'environment_labels')`.execute(
      db,
    );
    expect(rows).toEqual([]);
    await db.destroy();
  });

  // #854-T224
  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seen: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seen.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    await migrateToLatest(db, withProbe);

    expect(seen).toEqual(["0"]);
    await db.destroy();
  });
});
