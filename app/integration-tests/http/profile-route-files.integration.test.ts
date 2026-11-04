// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind the profile API (#843) with the wiring the running server uses: the dynamic segments, the
// database opened at start and the workspace access. Only the session lookup, `connection()` and the catalog behind the rule for a
// model are replaced (the first two need Next.js's request scope; the catalog needs the whole model-catalog setup, and the rule itself
// is tested in src/implementer/models.test.ts). The handlers' own behaviour is in src/profiles/http.test.ts and the service's in
// src/profiles/service.integration.test.ts; this file proves the pieces are connected: validate answers without storing, a save runs the
// validator and makes a version, every member may use the routes, the workspace is the one in the address, and a deployment without
// the capability has no such path.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createProfilesRepository } from "../../src/db/repositories/profiles-repository.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../src/test-support/workspaces.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
// The rule for a model needs the model catalog; here one entry is allowed and every other is not.
vi.mock("../../src/implementer/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/implementer/shared.ts")>()),
  implementerModelsFor: () => ({
    options: async () => ({ keyMode: "unreadable" as const }),
    check: async (choice: { entryId?: string }) =>
      choice.entryId === "entry-1" ? null : ("entry_unknown" as const),
  }),
}));

const DEPLOYMENTS = {
  withCapability: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
  },
  factoryToday: {
    PRODUCT_ID: "factory",
    PRODUCT_CAPABILITIES: "review,dynamic-review",
  },
  codeReviewCom: { PRODUCT_ID: "code-review-com" },
} as const;

const REVIEWER = {
  name: "reviewer",
  description: "Reads a branch.",
  model: { entryId: "entry-1" },
  instructions: "Review only.",
  costLimitCents: 200,
  canPush: false,
};

async function startRoutes(
  options: { role?: WorkspaceRole; deployment?: keyof typeof DEPLOYMENTS } = {},
) {
  for (const [name, value] of Object.entries(
    DEPLOYMENTS[options.deployment ?? "withCapability"],
  ))
    vi.stubEnv(name, value);
  await openRouteTestDatabase();
  const db = getDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherId = await addWorkspace(db, "other");
  await createInstanceSettingsRepository(db).set(
    "review_max_cost_cents",
    500,
    null,
  );
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: options.role ?? "member",
      githubLogin: "octocat",
    }),
  );
  const listRoute =
    await import("../../src/app/api/w/[workspace]/profiles/route.ts");
  const validateRoute =
    await import("../../src/app/api/w/[workspace]/profiles/validate/route.ts");
  const itemRoute =
    await import("../../src/app/api/w/[workspace]/profiles/[profileId]/route.ts");

  const base = (workspace: string) =>
    `https://app.test/api/w/${workspace}/profiles`;
  const json = (method: string, url: string, body: unknown) =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const list = (workspace = "default") =>
    listRoute.GET(new Request(base(workspace)), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.GET>[1]);
  const create = (body: unknown, workspace = "default") =>
    listRoute.POST(json("POST", base(workspace), body), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.POST>[1]);
  const validate = (body: unknown, workspace = "default") =>
    validateRoute.POST(json("POST", `${base(workspace)}/validate`, body), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof validateRoute.POST>[1]);
  const get = (id: string, query = "", workspace = "default") =>
    itemRoute.GET(new Request(`${base(workspace)}/${id}${query}`), {
      params: Promise.resolve({ workspace, profileId: id }),
    } as Parameters<typeof itemRoute.GET>[1]);
  const update = (
    id: string,
    body: unknown,
    query = "",
    workspace = "default",
  ) =>
    itemRoute.PUT(json("PUT", `${base(workspace)}/${id}${query}`, body), {
      params: Promise.resolve({ workspace, profileId: id }),
    } as Parameters<typeof itemRoute.PUT>[1]);
  const archive = (id: string, workspace = "default") =>
    itemRoute.DELETE(
      new Request(`${base(workspace)}/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ workspace, profileId: id }) } as Parameters<
        typeof itemRoute.DELETE
      >[1],
    );
  const rows = () => db.selectFrom("profiles").selectAll().execute();
  const versions = () =>
    db.selectFrom("profile_versions").selectAll().orderBy("version").execute();
  return {
    db,
    workspaceId,
    otherId,
    listRoute,
    validateRoute,
    itemRoute,
    list,
    create,
    validate,
    get,
    update,
    archive,
    rows,
    versions,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the profile route files", () => {
  // #843-T140
  it("let a Member validate a profile without storing anything, with the rule for a model and the operator's maximum", async () => {
    const { db, validate, rows } = await startRoutes({ role: "member" });
    await createInstanceSettingsRepository(db).set(
      "review_max_cost_cents",
      100,
      null,
    );

    const good = await validate({ ...REVIEWER, costLimitCents: 100 });
    const bad = await validate({
      ...REVIEWER,
      model: { entryId: "nope" },
      costLimitCents: 101,
    });

    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(await good.json()).toEqual({
      valid: true,
      errors: [],
      truncated: false,
    });
    expect(await bad.json()).toMatchObject({
      valid: false,
      errors: [
        { path: "/costLimitCents", code: "cost_limit_above_maximum" },
        { path: "/model", code: "model_not_allowed" },
      ],
    });
    expect(await rows()).toEqual([]);
  });

  // #843-T141
  it("let a Member save a profile and a new version of it, and read both back", async () => {
    const { create, update, get, list, rows, versions, workspaceId } =
      await startRoutes({ role: "member" });

    const created = await create(REVIEWER);
    const { profile } = (await created.json()) as { profile: { id: string } };
    const changed = { ...REVIEWER, instructions: "second", canPush: true };
    const updated = await update(profile.id, changed);

    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(updated.status).toBe(200);
    expect(await rows()).toMatchObject([
      { id: profile.id, workspace_id: workspaceId, current_version: 2 },
    ]);
    expect(await versions()).toMatchObject([
      { version: 1, instructions: "Review only.", can_push: false },
      { version: 2, instructions: "second", can_push: true },
    ]);
    expect(await (await list()).json()).toMatchObject({
      profiles: [{ id: profile.id, name: "reviewer", version: 2 }],
      maximum: 100,
    });
    expect(await (await get(profile.id)).json()).toMatchObject({
      profile: { version: 2, document: { instructions: "second" } },
    });
    expect(await (await get(profile.id, "?version=1")).json()).toMatchObject({
      profile: { documentVersion: 1, version: 2 },
    });
    expect((await get(profile.id, "?version=9")).status).toBe(404);
  });

  // #843-T142
  it("refuse an invalid profile on save with 422 and every error, and store nothing", async () => {
    const { create, update, rows, versions } = await startRoutes();
    const created = await create(REVIEWER);
    const { profile } = (await created.json()) as { profile: { id: string } };

    const broken = { ...REVIEWER, canPush: "yes", model: { entryId: "nope" } };
    const refusedNew = await create({ ...broken, name: "other" });
    const refusedVersion = await update(profile.id, broken);

    for (const response of [refusedNew, refusedVersion]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "PROFILE_INVALID",
        errors: [{ path: "/canPush", code: "wrong_type" }],
      });
    }
    expect(await rows()).toHaveLength(1);
    expect(await versions()).toHaveLength(1);
  });

  // #843-T143
  it("refuse a model the workspace cannot run with model_not_allowed", async () => {
    const { create, rows } = await startRoutes();

    const refused = await create({ ...REVIEWER, model: { entryId: "nope" } });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: "PROFILE_INVALID",
      errors: [{ path: "/model", code: "model_not_allowed" }],
    });
    expect(await rows()).toEqual([]);
  });

  // #843-T144
  it("keep the workspaces apart: another workspace's profile cannot be read or saved over by id, and a stranger sees 404", async () => {
    const {
      db,
      otherId,
      create,
      list,
      get,
      update,
      archive,
      validate,
      rows,
      versions,
    } = await startRoutes({ role: "owner" });
    await db
      .insertInto("users")
      .values({
        id: "u-foreign",
        name: "foreign",
        email: "foreign@example.test",
        email_verified: 1,
        created_at: "2026-11-04T08:00:00.000Z",
        updated_at: "2026-11-04T08:00:00.000Z",
      })
      .execute();
    const foreign = await createProfilesRepository(db, otherId).create(
      {
        name: "theirs",
        content: {
          description: "",
          model: { entryId: "entry-1" },
          instructions: "",
          costLimitCents: null,
          canPush: true,
          defaultResult: null,
        },
        createdBy: "u-foreign",
      },
      100,
    );
    if (!foreign.ok) throw new Error("seeding failed");
    const id = foreign.profile.id;

    expect(await (await list()).json()).toMatchObject({ profiles: [] });
    const read = await get(id);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: "PROFILE_NOT_FOUND" });
    expect((await update(id, REVIEWER)).status).toBe(404);
    expect((await archive(id)).status).toBe(404);
    // The signed in person is no member of "other": the workspace is not there for them.
    for (const response of [
      await list("other"),
      await create(REVIEWER, "other"),
      await validate(REVIEWER, "other"),
      await get(id, "", "other"),
      await update(id, REVIEWER, "", "other"),
      await archive(id, "other"),
    ])
      expect(response.status).toBe(404);
    expect(await rows()).toMatchObject([
      { id, name: "theirs", current_version: 1, archived_at: null },
    ]);
    expect(await versions()).toHaveLength(1);
  });

  // #843-T145
  it("refuse a second profile of the name with 409, a new version under another name with 422, and an expected version that is no longer current", async () => {
    const { create, update } = await startRoutes();
    const created = await create(REVIEWER);
    const { profile } = (await created.json()) as { profile: { id: string } };
    await update(profile.id, REVIEWER);

    const taken = await create(REVIEWER);
    const renamed = await update(profile.id, { ...REVIEWER, name: "renamed" });
    const stale = await update(profile.id, REVIEWER, "?expectedVersion=1");

    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "PROFILE_NAME_TAKEN" });
    expect(renamed.status).toBe(422);
    expect(await renamed.json()).toMatchObject({
      error: "PROFILE_NAME_CHANGED",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "PROFILE_VERSION_CONFLICT",
      current: 2,
    });
  });

  // #843-T146
  it("lets a Member archive a profile: gone from the list, readable with its versions, no new version, name free again", async () => {
    const { create, update, get, list, archive, rows } = await startRoutes({
      role: "member",
    });
    const created = await create(REVIEWER);
    const { profile } = (await created.json()) as { profile: { id: string } };

    const archived = await archive(profile.id);

    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      profile: { id: profile.id, archivedAt: expect.any(String) },
    });
    expect(await (await list()).json()).toMatchObject({ profiles: [] });
    expect(await (await get(profile.id)).json()).toMatchObject({
      profile: { archivedAt: expect.any(String), versions: [{ version: 1 }] },
    });
    const refused = await update(profile.id, REVIEWER);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "PROFILE_ARCHIVED" });
    expect((await create(REVIEWER)).status).toBe(201);
    expect(await rows()).toHaveLength(2);
    expect((await archive("missing")).status).toBe(404);
  });

  // #843-T147
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "answer the 404 of a path that does not exist in a deployment without the capability (%s), before the session or the database is asked, and write nothing",
    async (deployment) => {
      const { list, create, validate, get, update, rows } = await startRoutes({
        deployment,
      });
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      for (const call of [
        () => list(),
        () => create(REVIEWER),
        () => validate(REVIEWER),
        () => get("x"),
        () => update("x", REVIEWER),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    },
  );

  // #843-T148
  it("export only the methods each route serves", async () => {
    const { listRoute, validateRoute, itemRoute } = await startRoutes();

    expect(Object.keys(listRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(validateRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["DELETE", "GET", "PUT"]);
  });
});
