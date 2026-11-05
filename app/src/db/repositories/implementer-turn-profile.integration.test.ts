// SPDX-License-Identifier: LicenseRef-Proprietary

// The profile a turn started with (#843): the version's instructions and push right are copied into the turn when it is written
// (the model and the cost limit are the turn's own columns), so that nothing done to the profile later reaches a running or a past
// turn. A turn without a profile has no copy: it runs with the platform's own defaults, as every turn did before profiles. Against a
// real Postgres.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createImplementerRepository } from "./implementer-repository.ts";
import {
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../../test-support/implementer.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const seed = await seedImplementerRepository(db, workspaceId, "a");
  return { db, workspaceId, seed };
}

const PROFILE = {
  id: "profile-1",
  name: "reviewer",
  version: 3,
  instructions: "Review only.\nDo not edit.",
  canPush: false,
};

describe("the profile snapshot of a turn", () => {
  // #843-T150
  it("stores the version's instructions and push right as they were, and reads them back", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, {
        modelChoice: { provider: "anthropic", model: "m" },
        costLimitCents: 250,
        profile: PROFILE,
      }),
    );

    // A turn written without a harness is a turn on OpenCode (#856).
    expect(turn.profile).toEqual({ ...PROFILE, harness: "opencode" });
    expect(turn.costLimitCents).toBe(250);
    expect(turn.modelChoice).toEqual({ provider: "anthropic", model: "m" });
    const read = await createImplementerRepository(
      db,
      workspaceId,
    ).getTurnByJob(turn.jobId);
    expect(read?.turn.profile).toEqual({ ...PROFILE, harness: "opencode" });
  });

  // #856-T63
  it("keeps the harness of the version, and refuses one in the database for a turn without a profile", async () => {
    const { db, workspaceId, seed } = await setup();
    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, { profile: { ...PROFILE, harness: "claude-code" } }),
    );
    expect(turn.profile?.harness).toBe("claude-code");

    const other = await startTask(
      db,
      workspaceId,
      taskOf(seed, { branch: "implementer/other" }),
    );
    await expect(
      sql`update implementer_turns set profile_harness = 'claude-code' where id = ${other.turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_profile_harness_check/);
    await expect(
      sql`update implementer_turns set profile_harness = 'codex' where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_profile_harness_check/);
  });

  // #843-T151
  it("has none for a turn without a profile: the platform's defaults, as before", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    expect(turn.profile).toBeNull();
    const row = await db
      .selectFrom("implementer_turns")
      .select([
        "profile_id",
        "profile_name",
        "profile_version",
        "profile_instructions",
        "profile_can_push",
      ])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      profile_id: null,
      profile_name: null,
      profile_version: null,
      profile_instructions: null,
      profile_can_push: null,
    });
  });

  // #843-T152
  it("keeps a profile with empty instructions and the right to push: that is today's Implementer", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, {
        profile: { ...PROFILE, instructions: "", canPush: true },
      }),
    );

    expect(turn.profile).toMatchObject({ instructions: "", canPush: true });
  });

  // #843-T153
  it("refuses in the database a half-written profile: all five columns are set or none", async () => {
    const { db, workspaceId, seed } = await setup();
    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    await expect(
      sql`update implementer_turns set profile_id = 'p' where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_profile_check/);
    await expect(
      sql`update implementer_turns set profile_id = 'p', profile_name = 'n', profile_version = 0,
        profile_instructions = '', profile_can_push = 1 where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_profile_check/);
  });

  // #843-T154
  it("is not touched when the profile of that id is edited, archived or deleted: nothing points into the profile tables", async () => {
    const { db, workspaceId, seed } = await setup();
    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, { profile: PROFILE }),
    );

    // There is no foreign key; the id is only kept to say which profile it was.
    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'implementer_turns' and c.contype = 'f' and c.confrelid::regclass::text like 'profile%'`.execute(
      db,
    );
    expect(rows[0]?.n).toBe(0);
    expect(turn.profile?.id).toBe("profile-1");
  });
});
