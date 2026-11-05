// SPDX-License-Identifier: LicenseRef-Proprietary

// The profile service with the real repository on a real Postgres (#843): a profile is checked by the validator and against the world
// (the model, the operator's maximum), an invalid one is refused with the full list and nothing is stored, every save is a new
// version, the name never changes, an older version stays readable, and a workspace never sees the profiles of another.
import { describe, expect, it } from "vitest";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { ProfileError } from "./errors.ts";
import { createProfileService } from "./service.ts";

const USER = { id: "u-1" };

const REVIEWER = {
  name: "reviewer",
  description: "Reads a branch.",
  model: { entryId: "entry-1" },
  instructions: "Review only.",
  costLimitCents: 200,
  canPush: false,
  defaultResult: {
    type: "object",
    required: ["findings"],
    properties: { findings: { type: "array", items: { type: "string" } } },
  },
};

async function setup() {
  const { db } = await createTestDatabase();
  await addUser(db, USER.id);
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const refusals = new Map<string, string>();
  const state = { maximumCents: 500 };
  const serviceFor = (
    workspaceId: string,
    options: { archivedMax?: number } = {},
  ) =>
    createProfileService({
      profiles: createProfilesRepository(db, workspaceId),
      models: {
        check: async (choice) =>
          "entryId" in choice
            ? ((refusals.get(choice.entryId) as "entry_unknown" | undefined) ??
              null)
            : "wrong_key_mode",
      },
      operatorCostLimitCents: async () => state.maximumCents,
      ...options,
    });
  return {
    db,
    a: serviceFor(idA),
    b: serviceFor(idB),
    serviceFor,
    idA,
    idB,
    refusals,
    state,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ProfileError> {
  const reason = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(reason instanceof ProfileError))
    throw new Error("expected a ProfileError");
  return reason;
}

describe("the profile service", () => {
  // #843-T80
  it("validates a profile without storing it", async () => {
    const { a } = await setup();

    const result = await a.validate(REVIEWER);

    expect(result).toEqual({ valid: true, errors: [], truncated: false });
    expect((await a.list()).profiles).toEqual([]);
  });

  // #843-T81
  it("adds to the validator's errors what only the world knows: a model the claim would not run, a cost limit above the maximum", async () => {
    const { a, refusals } = await setup();
    refusals.set("entry-1", "entry_unknown");

    const result = await a.validate({ ...REVIEWER, costLimitCents: 501 });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/costLimitCents",
        code: "cost_limit_above_maximum",
      }),
      expect.objectContaining({ path: "/model", code: "model_not_allowed" }),
    ]);
    expect(result.errors[0]?.message).toContain("500");
    expect(result.errors[1]?.message).toContain("entry_unknown");
    // A profile on the workspace's own key in a workspace that runs on the operator's.
    refusals.clear();
    expect(
      (
        await a.validate({
          ...REVIEWER,
          model: { provider: "anthropic", model: "m" },
        })
      ).errors[0],
    ).toMatchObject({ path: "/model", code: "model_not_allowed" });
  });

  // #843-T82
  it("refuses to save an invalid profile with the same errors as validate, and stores nothing", async () => {
    const { a } = await setup();
    const broken = { ...REVIEWER, name: "Bad Name", extra: 1 };

    const failure = await failureOf(a.create(USER, broken));

    expect(failure.code).toBe("PROFILE_INVALID");
    expect(failure.errors).toEqual((await a.validate(broken)).errors);
    expect(failure.errors.map((e) => e.code)).toEqual([
      "unknown_field",
      "invalid_value",
    ]);
    expect((await a.list()).profiles).toEqual([]);
  });

  // #843-T83
  it("saves a valid profile as version 1 and reads it back as the body that made it", async () => {
    const { a } = await setup();

    const created = await a.create(USER, REVIEWER);

    expect(created).toMatchObject({
      name: "reviewer",
      version: 1,
      documentVersion: 1,
      document: REVIEWER,
      versions: [{ version: 1 }],
    });
    expect(await a.get(created.id)).toEqual(created);
    expect((await a.list()).profiles).toMatchObject([
      { id: created.id, name: "reviewer", version: 1 },
    ]);
  });

  // #843-T84
  it("fills in what the body left out and reads it back filled in", async () => {
    const { a } = await setup();

    const created = await a.create(USER, {
      name: "plain",
      model: { entryId: "entry-1" },
      canPush: true,
    });

    expect(created.document).toEqual({
      name: "plain",
      description: "",
      model: { entryId: "entry-1" },
      instructions: "",
      costLimitCents: null,
      canPush: true,
      defaultResult: null,
    });
  });

  // #843-T85
  it("saves every change as a new version and keeps the older ones readable", async () => {
    const { a } = await setup();
    const created = await a.create(USER, REVIEWER);

    const second = await a.update(USER, created.id, {
      ...REVIEWER,
      instructions: "v2",
      canPush: true,
    });
    const third = await a.update(USER, created.id, {
      ...REVIEWER,
      instructions: "v3",
    });

    expect(second).toMatchObject({ version: 2, documentVersion: 2 });
    expect(third.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await a.get(created.id)).document).toMatchObject({
      instructions: "v3",
    });
    expect((await a.get(created.id, 1)).document).toEqual(REVIEWER);
    expect(await a.get(created.id, 2)).toMatchObject({
      version: 3,
      documentVersion: 2,
      document: { instructions: "v2", canPush: true },
    });
    expect((await failureOf(a.get(created.id, 9))).code).toBe(
      "PROFILE_VERSION_NOT_FOUND",
    );
  });

  // #843-T86
  it("refuses an invalid new version and keeps the current one", async () => {
    const { a } = await setup();
    const created = await a.create(USER, REVIEWER);

    const failure = await failureOf(
      a.update(USER, created.id, { ...REVIEWER, canPush: "no" }),
    );

    expect(failure.code).toBe("PROFILE_INVALID");
    expect((await a.get(created.id)).version).toBe(1);
  });

  // #843-T87
  it("keeps the name for the life of the profile: a different name in a new version is refused, the same one is fine", async () => {
    const { a } = await setup();
    const one = await a.create(USER, REVIEWER);
    await a.create(USER, { ...REVIEWER, name: "other" });

    const renamed = await failureOf(
      a.update(USER, one.id, { ...REVIEWER, name: "renamed" }),
    );
    const clash = await failureOf(a.create(USER, REVIEWER));

    expect(renamed.code).toBe("PROFILE_NAME_CHANGED");
    expect(renamed.errors).toEqual([
      expect.objectContaining({ path: "/name", code: "invalid_value" }),
    ]);
    expect(clash.code).toBe("PROFILE_NAME_TAKEN");
    expect((await a.get(one.id)).version).toBe(1);
  });

  // #843-T88
  it("saves over an expected version only if it is still current", async () => {
    const { a } = await setup();
    const created = await a.create(USER, REVIEWER);
    await a.update(USER, created.id, REVIEWER);

    const stale = await failureOf(a.update(USER, created.id, REVIEWER, 1));
    const fresh = await a.update(USER, created.id, REVIEWER, 2);

    expect(stale.code).toBe("PROFILE_VERSION_CONFLICT");
    expect(stale.current).toBe(2);
    expect(fresh.version).toBe(3);
  });

  // #843-T89
  it("archives: out of the list, no new version, readable, the name free again, archived once however often it is asked", async () => {
    const { a } = await setup();
    const created = await a.create(USER, REVIEWER);

    const archived = await a.archive(created.id);
    const again = await a.archive(created.id);

    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(again.archivedAt).toBe(archived.archivedAt);
    expect((await a.list()).profiles).toEqual([]);
    expect((await a.get(created.id)).document).toEqual(REVIEWER);
    expect((await failureOf(a.update(USER, created.id, REVIEWER))).code).toBe(
      "PROFILE_ARCHIVED",
    );
    expect((await a.create(USER, REVIEWER)).name).toBe("reviewer");
  });

  // #843-T138
  it("answers PROFILE_ARCHIVED for an update of an archived profile before it reads the body", async () => {
    const { a } = await setup();
    const created = await a.create(USER, REVIEWER);
    await a.archive(created.id);

    const failure = await failureOf(
      a.update(USER, created.id, { name: 5, junk: true }),
    );

    expect(failure.code).toBe("PROFILE_ARCHIVED");
  });

  // #843-T90
  it("holds a workspace to its maximum of archived profiles", async () => {
    const { serviceFor, idA } = await setup();
    const a = serviceFor(idA, { archivedMax: 1 });
    const one = await a.create(USER, { ...REVIEWER, name: "one" });
    const two = await a.create(USER, { ...REVIEWER, name: "two" });
    await a.archive(one.id);

    const failure = await failureOf(a.archive(two.id));

    expect(failure.code).toBe("PROFILE_ARCHIVE_LIMIT_REACHED");
    expect(failure.maximum).toBe(1);
  });

  // #843-T91
  it("says not found for an id that is not there or belongs to another workspace, and lets two workspaces use one name", async () => {
    const { a, b } = await setup();
    const theirs = await b.create(USER, REVIEWER);

    expect((await failureOf(a.get(theirs.id))).code).toBe("PROFILE_NOT_FOUND");
    expect((await failureOf(a.update(USER, theirs.id, REVIEWER))).code).toBe(
      "PROFILE_NOT_FOUND",
    );
    expect((await failureOf(a.archive(theirs.id))).code).toBe(
      "PROFILE_NOT_FOUND",
    );
    expect((await failureOf(a.get(""))).code).toBe("PROFILE_NOT_FOUND");
    expect((await failureOf(a.get("x".repeat(65)))).code).toBe(
      "PROFILE_NOT_FOUND",
    );
    expect((await a.create(USER, REVIEWER)).name).toBe("reviewer");
    expect((await b.get(theirs.id)).archivedAt).toBeNull();
  });

  // #843-T92
  it("does not check a saved version again when the world has changed: it is history", async () => {
    const { a, refusals, state } = await setup();
    const created = await a.create(USER, REVIEWER);
    refusals.set("entry-1", "entry_not_released");
    state.maximumCents = 50;

    expect((await a.get(created.id)).document).toEqual(REVIEWER);
    expect((await a.list()).profiles).toHaveLength(1);
  });

  // #843-T93
  it("holds a workspace to its maximum of profiles", async () => {
    const { db, idA } = await setup();
    const small = createProfileService({
      profiles: createProfilesRepository(db, idA),
      models: { check: async () => null },
      operatorCostLimitCents: async () => 500,
      profilesMax: 1,
    });
    await small.create(USER, REVIEWER);

    const failure = await failureOf(
      small.create(USER, { ...REVIEWER, name: "second" }),
    );

    expect(failure.code).toBe("PROFILE_LIMIT_REACHED");
    expect(failure.maximum).toBe(1);
  });
});
