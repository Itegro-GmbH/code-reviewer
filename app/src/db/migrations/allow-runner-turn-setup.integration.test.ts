// SPDX-License-Identifier: LicenseRef-Proprietary

// #1126: a turn on a self-hosted runner copies the step's setup script and network rule. The migration only loosens the check of the
// runner copy (an empty script was required); everything else about the copies stays as it was, and it can be taken back.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261121140000_allow_runner_turn_setup";
const T = "2026-11-21T08:00:00.000Z";

const turn = (values: {
  id: string;
  number: number;
  script: string | null;
  kind: string | null;
  labels: string | null;
  vcpus?: number | null;
}) =>
  sql`insert into implementer_turns (id, session_id, workspace_id, number, instruction, model_choice, job_id, created_by, created_at,
      environment_id, environment_name, environment_vcpus, environment_setup_script, environment_kind, environment_labels)
    values (${values.id}, 's-1', 'w-1', ${values.number}, 'x', '{}', ${values.id}, 'u-1', ${T},
      ${values.kind === null && values.script === null ? null : "e"}, ${values.kind === null && values.script === null ? null : "n"},
      ${values.vcpus ?? null}, ${values.script}, ${values.kind}, ${values.labels})`;

describe("the migration that lets a runner copy hold a script", () => {
  // #1126-T50
  it("accepts a runner copy with a script of at most 64 KB and refuses a longer one, a missing one and a half copy", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await sql`set session_replication_role = replica`.execute(db);

    await turn({
      id: "ok-1",
      number: 1,
      script: "npm ci\n",
      kind: "runner",
      labels: "box",
    }).execute(db);
    await turn({
      id: "ok-2",
      number: 2,
      script: "",
      kind: "runner",
      labels: "box",
    }).execute(db);
    await turn({
      id: "ok-3",
      number: 3,
      script: "x".repeat(65536),
      kind: "runner",
      labels: "box",
    }).execute(db);
    for (const [name, values] of [
      [
        "too long",
        { script: "x".repeat(65537), kind: "runner", labels: "box" },
      ],
      ["no script", { script: null, kind: "runner", labels: "box" }],
      ["no labels", { script: "x", kind: "runner", labels: null }],
      ["a size", { script: "x", kind: "runner", labels: "box", vcpus: 2 }],
    ] as const)
      await expect(
        turn({ id: `bad-${name}`, number: 9, ...values }).execute(db),
        name,
      ).rejects.toThrow(/implementer_turns_environment_check/);
    await db.destroy();
  });

  // #1126-T51
  it("can be taken back: a runner copy goes back to an empty script and the old check holds", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await sql`set session_replication_role = replica`.execute(db);
    await turn({
      id: "kept",
      number: 1,
      script: "make\n",
      kind: "runner",
      labels: "box",
    }).execute(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      script: string;
    }>`select environment_setup_script as script from implementer_turns where id = 'kept'`.execute(
      db,
    );
    expect(rows).toEqual([{ script: "" }]);
    await expect(
      turn({
        id: "again",
        number: 2,
        script: "x",
        kind: "runner",
        labels: "box",
      }).execute(db),
    ).rejects.toThrow(/implementer_turns_environment_check/);
    await db.destroy();
  });
});
