// SPDX-License-Identifier: LicenseRef-Proprietary

// The profiles of a workspace (#843) against a real Postgres: what the repository keeps true (a name once per workspace among the
// profiles that are not archived, a bounded count, every save a new version that is never updated, the next number never taken twice,
// the name never changes, nothing across workspaces).
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import {
  createProfilesRepository,
  type NewProfile,
  type ProfileContent,
} from "./profiles-repository.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  await addUser(db, "u-2");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 4, 8, 0, tick++));
  let counter = 0;
  const newId = () => `pr-${++counter}`;
  return {
    db,
    a: createProfilesRepository(db, idA, { now, newId }),
    b: createProfilesRepository(db, idB, { now, newId }),
    idA,
    idB,
  };
}

const CONTENT: ProfileContent = {
  description: "Writes code",
  model: { entryId: "entry-1" },
  instructions: "Be careful.",
  costLimitCents: 300,
  canPush: true,
  defaultResult: null,
};
const NEW: NewProfile = {
  name: "implementer",
  content: CONTENT,
  createdBy: "u-1",
};
const SCHEMA = '{"type":"object","properties":{"a":{"type":"string"}}}';

describe("the profiles repository", () => {
  // #843-T50
  it("creates a profile as version 1 and reads it back as it was written", async () => {
    const { a, idA } = await setup();

    const created = await a.create(
      {
        ...NEW,
        content: {
          ...CONTENT,
          model: { provider: "anthropic", model: "claude-sonnet-5-5" },
          costLimitCents: null,
          defaultResult: SCHEMA,
        },
      },
      100,
    );

    expect(created).toEqual({
      ok: true,
      profile: {
        id: "pr-1",
        workspaceId: idA,
        name: "implementer",
        version: 1,
        createdBy: "u-1",
        createdAt: "2026-11-04T08:00:00.000Z",
        updatedAt: "2026-11-04T08:00:00.000Z",
        archivedAt: null,
      },
      saved: {
        profileId: "pr-1",
        version: 1,
        content: {
          description: "Writes code",
          model: { provider: "anthropic", model: "claude-sonnet-5-5" },
          instructions: "Be careful.",
          costLimitCents: null,
          canPush: true,
          defaultResult: SCHEMA,
        },
        createdBy: "u-1",
        createdAt: "2026-11-04T08:00:00.000Z",
      },
    });
    expect(await a.get("pr-1")).toEqual({
      profile: created.ok ? created.profile : undefined,
      current: created.ok ? created.saved : undefined,
    });
  });

  // #843-T51
  it("lists the profiles by name, without the archived", async () => {
    const { a } = await setup();
    for (const name of ["pipeline", "build", "deploy"])
      await a.create({ ...NEW, name }, 100);
    await a.archive("pr-3", 100);

    expect((await a.list()).map((profile) => profile.name)).toEqual([
      "build",
      "pipeline",
    ]);
  });

  // #843-T136
  it("lists the names of the archived profiles, each once, and only of its own workspace", async () => {
    const { a, b } = await setup();
    for (const name of ["pipeline", "build", "deploy"])
      await a.create({ ...NEW, name }, 100);
    await b.create({ ...NEW, name: "theirs" }, 100);
    await a.archive("pr-3", 100);
    await a.archive("pr-1", 100);
    // The name is free again, and archived twice.
    await a.create({ ...NEW, name: "deploy" }, 100);
    await a.archive("pr-5", 100);

    expect(await a.archivedNames()).toEqual(["deploy", "pipeline"]);
    expect(await b.archivedNames()).toEqual([]);
  });

  // #843-T52
  it("keeps a name once per workspace among the live, and allows it in another workspace or after an archive", async () => {
    const { a, b } = await setup();
    await a.create(NEW, 100);

    expect(await a.create(NEW, 100)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await b.create(NEW, 100)).ok).toBe(true);
    await a.archive("pr-1", 100);
    expect((await a.create(NEW, 100)).ok).toBe(true);
    expect(await a.list()).toHaveLength(1);
  });

  // #843-T53
  it("refuses a profile over the maximum, counted with the new one, and does not let two creators take the last place", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "one" }, 2);
    await a.create({ ...NEW, name: "two" }, 2);

    expect(await a.create({ ...NEW, name: "three" }, 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    const raced = await Promise.all(
      ["w", "x", "y", "z"].map((name) => a.create({ ...NEW, name }, 3)),
    );
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
  });

  // #843-T54
  it("saves a new version each time, keeps the name, makes it current and keeps the old ones as they were", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);

    const second = await a.saveVersion(
      "pr-1",
      {
        content: { ...CONTENT, instructions: "v2", canPush: false },
        createdBy: "u-2",
      },
      200,
    );
    const third = await a.saveVersion(
      "pr-1",
      { content: { ...CONTENT, instructions: "v3" }, createdBy: "u-1" },
      200,
    );

    expect(second).toMatchObject({
      ok: true,
      profile: { name: "implementer", version: 2, createdBy: "u-1" },
      saved: { version: 2, createdBy: "u-2" },
    });
    expect(third).toMatchObject({ ok: true, profile: { version: 3 } });
    expect((await a.get("pr-1"))?.current.content.instructions).toBe("v3");
    expect((await a.getVersion("pr-1", 1))?.content).toEqual(CONTENT);
    expect((await a.getVersion("pr-1", 2))?.content).toMatchObject({
      instructions: "v2",
      canPush: false,
    });
    expect((await a.listVersions("pr-1")).map((v) => v.version)).toEqual([
      3, 2, 1,
    ]);
  });

  // #843-T55
  it("takes the next number once when writers race", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        a.saveVersion(
          "pr-1",
          { content: { ...CONTENT, instructions: `n${i}` }, createdBy: "u-1" },
          200,
        ),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect((await a.listVersions("pr-1")).map((v) => v.version).sort()).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
  });

  // #843-T56
  it("refuses to save over a version that is no longer current, and says which is", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);
    const next = { content: CONTENT, createdBy: "u-1" };
    await a.saveVersion("pr-1", next, 200);

    expect(
      await a.saveVersion("pr-1", { ...next, expectedVersion: 1 }, 200),
    ).toEqual({ ok: false, reason: "version_conflict", current: 2 });
    expect(
      (await a.saveVersion("pr-1", { ...next, expectedVersion: 2 }, 200)).ok,
    ).toBe(true);
  });

  // #843-T57
  it("refuses a version over the maximum", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);
    const next = { content: CONTENT, createdBy: "u-1" };
    await a.saveVersion("pr-1", next, 2);

    expect(await a.saveVersion("pr-1", next, 2)).toEqual({
      ok: false,
      reason: "version_limit_reached",
    });
  });

  // #843-T58
  it("archives a profile: hidden from the list, readable with its versions, archived once however often it is asked", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "keep" }, 100);
    await a.create({ ...NEW, name: "old" }, 100);
    await a.saveVersion("pr-2", { content: CONTENT, createdBy: "u-1" }, 100);

    const archived = await a.archive("pr-2", 100);
    const again = await a.archive("pr-2", 100);

    expect(archived).toEqual({
      ok: true,
      profile: expect.objectContaining({
        id: "pr-2",
        archivedAt: expect.any(String),
      }),
    });
    expect(again).toEqual(archived);
    expect((await a.list()).map((profile) => profile.name)).toEqual(["keep"]);
    expect((await a.listVersions("pr-2")).map((v) => v.version)).toEqual([
      2, 1,
    ]);
    expect((await a.getVersion("pr-2", 1))?.content).toEqual(CONTENT);
    expect(
      await a.saveVersion("pr-2", { content: CONTENT, createdBy: "u-1" }, 100),
    ).toEqual({ ok: false, reason: "archived" });
  });

  // #843-T59
  it("archives no more than the maximum of archived profiles, and counts only live profiles against the maximum", async () => {
    const { a, b } = await setup();
    for (const name of ["one", "two", "three"])
      await a.create({ ...NEW, name }, 100);

    expect((await a.archive("pr-1", 2)).ok).toBe(true);
    expect((await a.archive("pr-2", 2)).ok).toBe(true);
    expect(await a.archive("pr-3", 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect((await a.archive("pr-1", 2)).ok).toBe(true);
    expect((await a.create({ ...NEW, name: "four" }, 2)).ok).toBe(true);
    await b.create({ ...NEW, name: "theirs" }, 100);
    expect((await b.archive("pr-5", 2)).ok).toBe(true);
  });

  // #843-T60
  it("finds a live profile by name with the version asked for, or the newest", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);
    await a.saveVersion(
      "pr-1",
      { content: { ...CONTENT, instructions: "v2" }, createdBy: "u-1" },
      100,
    );

    expect((await a.findByName("implementer"))?.version.version).toBe(2);
    expect((await a.findByName("implementer", 1))?.version.content).toEqual(
      CONTENT,
    );
    expect(await a.findByName("implementer", 3)).toBeUndefined();
    expect(await a.findByName("nobody")).toBeUndefined();
    await a.archive("pr-1", 100);
    expect(await a.findByName("implementer")).toBeUndefined();
  });

  // #843-T61
  it("reads the facts of exactly the versions asked for", async () => {
    const { a } = await setup();
    await a.create(
      {
        ...NEW,
        content: { ...CONTENT, canPush: false, defaultResult: SCHEMA },
      },
      100,
    );
    await a.saveVersion("pr-1", { content: CONTENT, createdBy: "u-1" }, 100);
    await a.create({ ...NEW, name: "other" }, 100);

    expect(
      await a.versionFacts([
        { profileId: "pr-1", version: 1 },
        { profileId: "pr-1", version: 2 },
        { profileId: "pr-1", version: 9 },
        { profileId: "nope", version: 1 },
      ]),
    ).toEqual([
      { profileId: "pr-1", version: 1, canPush: false, defaultResult: SCHEMA },
      { profileId: "pr-1", version: 2, canPush: true, defaultResult: null },
    ]);
    expect(await a.versionFacts([])).toEqual([]);
  });

  // #843-T62
  it("shows nothing of another workspace and changes nothing in it", async () => {
    const { a, b } = await setup();
    await b.create({ ...NEW, name: "theirs" }, 100);

    expect(await a.list()).toEqual([]);
    expect(await a.get("pr-1")).toBeUndefined();
    expect(await a.getVersion("pr-1", 1)).toBeUndefined();
    expect(await a.listVersions("pr-1")).toEqual([]);
    expect(await a.findByName("theirs")).toBeUndefined();
    expect(await a.versionFacts([{ profileId: "pr-1", version: 1 }])).toEqual(
      [],
    );
    expect(
      await a.saveVersion("pr-1", { content: CONTENT, createdBy: "u-1" }, 100),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await a.archive("pr-1", 100)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect((await b.get("pr-1"))?.profile.archivedAt).toBeNull();
    expect((await b.get("pr-1"))?.profile.version).toBe(1);
  });

  // #843-T63
  it("says not_found for an id that is not there", async () => {
    const { a } = await setup();

    expect(await a.get("nope")).toBeUndefined();
    expect(await a.getVersion("nope", 1)).toBeUndefined();
    expect(await a.listVersions("nope")).toEqual([]);
  });

  // #843-T139
  it("refuses in the database a version whose workspace is not the workspace of its profile", async () => {
    const { a, db, idB } = await setup();
    await a.create(NEW, 100);

    await expect(
      sql`insert into profile_versions
        (profile_id, version, workspace_id, description, model_choice, instructions, can_push, created_by, created_at)
        values ('pr-1', 2, ${idB}, '', '{}', '', 1, 'u-1', 'now')`.execute(db),
    ).rejects.toThrow(/profile_versions_profile_fk/);
  });

  // #843-T64
  it("refuses in the database to change a saved version, a name that is not a profile name, and values out of bounds", async () => {
    const { a, db } = await setup();
    await a.create(NEW, 100);

    await expect(
      sql`update profile_versions set instructions = 'x' where profile_id = 'pr-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`update profile_versions set can_push = 0 where profile_id = 'pr-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(a.create({ ...NEW, name: "Not Valid" }, 100)).rejects.toThrow(
      /profiles_name_check/,
    );
    await expect(
      a.saveVersion(
        "pr-1",
        {
          content: { ...CONTENT, costLimitCents: 10_001 },
          createdBy: "u-1",
        },
        100,
      ),
    ).rejects.toThrow(/profile_versions_cost_limit_check/);
    await expect(
      a.saveVersion(
        "pr-1",
        {
          content: { ...CONTENT, instructions: "x".repeat(20_001) },
          createdBy: "u-1",
        },
        100,
      ),
    ).rejects.toThrow(/profile_versions_instructions_check/);
  });

  // #843-T65
  it("keeps instructions with line breaks, tabs and characters beyond the basic plane exactly", async () => {
    const { a } = await setup();
    const instructions = "line 1\r\n\tline 2 😀 ä\n\n  trailing  ";
    await a.create({ ...NEW, content: { ...CONTENT, instructions } }, 100);

    expect((await a.get("pr-1"))?.current.content.instructions).toBe(
      instructions,
    );
  });
});
