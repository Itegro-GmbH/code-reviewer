// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind the workflow API (#833) with the wiring the running server uses: the dynamic segments, the
// database opened at start and the workspace access. Only the session lookup and `connection()` are replaced (they need Next.js's
// request scope). The handlers' own behaviour is in src/workflows/http.test.ts and the service's in service.integration.test.ts;
// this file proves the pieces are connected: validate answers without storing, a save runs the validator and makes a version,
// every member may use the routes, the workspace is the one in the address, and a deployment without the capability has no such path.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../src/auth/session-user.ts";
import { closeDatabase, getDatabase } from "../../src/db/startup.ts";
import type { WorkspaceRole } from "../../src/db/workspace-roles.ts";
import { signedInMember } from "../../src/test-support/session-lookup.ts";
import { openRouteTestDatabase } from "../../src/test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../src/test-support/workspaces.ts";
import { issueToPr, tiny } from "../../src/workflows/test-fixtures.ts";
import { createImplementerEnvironmentsRepository } from "../../src/db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../../src/db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { seedImplementerRepository } from "../../src/test-support/implementer.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
// `connection()` only works inside a Next.js request; here it just returns.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
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
  // The profiles the documents of the tests run (#843): profiles are data of the workspace, none is built in.
  await db
    .insertInto("users")
    .values({
      id: "u-profiles",
      name: "profiles",
      email: "profiles@example.test",
      email_verified: 1,
      created_at: "2026-11-04T08:00:00.000Z",
      updated_at: "2026-11-04T08:00:00.000Z",
    })
    .execute();
  for (const id of [workspaceId, otherId])
    for (const [name, canPush] of [
      ["implementer", true],
      ["reviewer", false],
    ] as const)
      await createProfilesRepository(db, id).create(
        {
          name,
          content: {
            description: "",
            model: { entryId: "entry-1" },
            instructions: "",
            costLimitCents: null,
            canPush,
            defaultResult: null,
          },
          createdBy: "u-profiles",
        },
        100,
      );
  // A project in each workspace (#922): a lane is listed and created within one.
  const projectIds: Record<string, string> = {};
  for (const [slug, id] of [
    ["default", workspaceId],
    ["other", otherId],
  ] as const) {
    const seeded = await seedImplementerRepository(db, id, slug);
    const project = await createProjectsRepository(db, id).get(
      seeded.repositoryId,
    );
    projectIds[slug] = project!.id;
  }
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: options.role ?? "member",
      githubLogin: "octocat",
    }),
  );
  const listRoute =
    await import("../../src/app/api/w/[workspace]/workflows/route.ts");
  const validateRoute =
    await import("../../src/app/api/w/[workspace]/workflows/validate/route.ts");
  const itemRoute =
    await import("../../src/app/api/w/[workspace]/workflows/[workflowId]/route.ts");

  const base = (workspace: string) =>
    `https://app.test/api/w/${workspace}/workflows`;
  const json = (method: string, url: string, body: unknown) =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const withProject = (workspace: string) =>
    `${base(workspace)}?projectId=${projectIds[workspace] ?? "unknown"}`;
  const list = (workspace = "default") =>
    listRoute.GET(new Request(withProject(workspace)), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.GET>[1]);
  const create = (body: unknown, workspace = "default") =>
    listRoute.POST(json("POST", withProject(workspace), body), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.POST>[1]);
  const validate = (body: unknown, workspace = "default") =>
    validateRoute.POST(json("POST", `${base(workspace)}/validate`, body), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof validateRoute.POST>[1]);
  const get = (id: string, query = "", workspace = "default") =>
    itemRoute.GET(new Request(`${base(workspace)}/${id}${query}`), {
      params: Promise.resolve({ workspace, workflowId: id }),
    } as Parameters<typeof itemRoute.GET>[1]);
  const update = (
    id: string,
    body: unknown,
    query = "",
    workspace = "default",
  ) =>
    itemRoute.PUT(json("PUT", `${base(workspace)}/${id}${query}`, body), {
      params: Promise.resolve({ workspace, workflowId: id }),
    } as Parameters<typeof itemRoute.PUT>[1]);
  const archive = (id: string, workspace = "default") =>
    itemRoute.DELETE(
      new Request(`${base(workspace)}/${id}`, { method: "DELETE" }),
      {
        params: Promise.resolve({ workspace, workflowId: id }),
      } as Parameters<typeof itemRoute.DELETE>[1],
    );
  const rows = () => db.selectFrom("workflows").selectAll().execute();
  const versions = () =>
    db.selectFrom("workflow_versions").selectAll().orderBy("version").execute();
  const addEnvironment = async (name: string, workspace = workspaceId) => {
    await db
      .insertInto("users")
      .values({
        id: `u-${name}`,
        name,
        email: `${name}@example.test`,
        email_verified: 1,
        created_at: "2026-11-04T08:00:00.000Z",
        updated_at: "2026-11-04T08:00:00.000Z",
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await createImplementerEnvironmentsRepository(db, workspace).create(
      { name, vcpus: 4, setupScript: "", createdBy: `u-${name}` },
      50,
    );
  };
  return {
    db,
    workspaceId,
    otherId,
    projectIds,
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
    addEnvironment,
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the workflow route files", () => {
  // #833-M1-T220
  it("let a Member validate a document without storing anything, with the environments of the workspace", async () => {
    const { validate, rows, addEnvironment } = await startRoutes({
      role: "member",
    });
    await addEnvironment("node");

    const good = await validate(tiny());
    const bad = await validate(change(tiny(), "profile", "ghost"));

    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("no-store");
    expect(await good.json()).toEqual({
      valid: true,
      errors: [],
      truncated: false,
      steps: 1,
      budgetUsd: 20,
      turnTimeLimitMinutes: 60,
    });
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({
      valid: false,
      errors: [
        {
          path: "/steps/0/profile",
          code: "profile_unknown",
          available: ["implementer", "reviewer"],
        },
      ],
    });
    expect(await rows()).toEqual([]);
  });

  // #833-M1-T221
  it("let a Member save a workflow and a new version of it, and read both back", async () => {
    const {
      create,
      update,
      get,
      list,
      rows,
      versions,
      addEnvironment,
      workspaceId,
    } = await startRoutes({ role: "member" });
    await addEnvironment("node");

    const created = await create(tiny());
    expect(created.status).toBe(201);
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    const saved = await update(workflow.id, {
      ...tiny(),
      description: "second",
    });
    expect(saved.status).toBe(200);

    expect(await rows()).toMatchObject([
      {
        id: workflow.id,
        workspace_id: workspaceId,
        name: "Tiny",
        current_version: 2,
      },
    ]);
    expect((await versions()).map((v) => v.version)).toEqual([1, 2]);
    expect(await (await list()).json()).toMatchObject({
      workflows: [{ id: workflow.id, name: "Tiny", version: 2 }],
      maximum: 100,
    });
    expect(await (await get(workflow.id)).json()).toMatchObject({
      workflow: { version: 2, document: { description: "second" } },
    });
    expect(await (await get(workflow.id, "?version=1")).json()).toMatchObject({
      workflow: { documentVersion: 1, version: 2 },
    });
    expect((await get(workflow.id, "?version=9")).status).toBe(404);
  });

  // #833-M1-T222
  it("refuse an invalid document on save with 422 and every error, and store nothing", async () => {
    const { create, update, rows, versions, addEnvironment } =
      await startRoutes();
    await addEnvironment("node");
    const created = await create(tiny());
    const { workflow } = (await created.json()) as { workflow: { id: string } };

    const broken = {
      ...tiny(),
      trigger: { kind: "cron" },
      steps: [{ id: "a", kind: "parallel" }],
    };
    const refusedNew = await create({ ...broken, name: "Other" });
    const refusedVersion = await update(workflow.id, broken);

    for (const response of [refusedNew, refusedVersion]) {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "WORKFLOW_INVALID",
        errors: [
          { path: "/steps/0/kind", code: "unknown_kind" },
          { path: "/trigger/kind", code: "unknown_trigger_kind" },
        ],
      });
    }
    expect(await rows()).toHaveLength(1);
    expect(await versions()).toHaveLength(1);
  });

  // #833-M1-T223
  it("validate and save the plan's example for a workspace that has the environment", async () => {
    const { create, addEnvironment } = await startRoutes();
    await addEnvironment("node");
    const example = issueToPr();
    for (const step of (example.steps as Array<Record<string, unknown>>)[1]!
      .body as Array<Record<string, unknown>>)
      step.profile = "implementer@1";

    const created = await create(example);

    expect(created.status).toBe(201);
  });

  // #833-M1-T224
  it("keep the workspaces apart: another workspace's workflow cannot be read or saved over by id, and a stranger sees 404", async () => {
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
      addEnvironment,
    } = await startRoutes({ role: "owner" });
    await addEnvironment("node");
    const { createWorkflowsRepository } =
      await import("../../src/db/repositories/workflows-repository.ts");
    await db
      .insertInto("users")
      .values({
        id: "u1",
        name: "u1",
        email: "u1@example.test",
        email_verified: 1,
        created_at: "2026-11-04T08:00:00.000Z",
        updated_at: "2026-11-04T08:00:00.000Z",
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    const foreign = await createWorkflowsRepository(db, otherId).create(
      { name: "Theirs", document: "{}", createdBy: "u1" },
      100,
    );
    if (!foreign.ok) throw new Error("seeding failed");
    const id = foreign.workflow.id;

    expect(await (await list()).json()).toMatchObject({ workflows: [] });
    const read = await get(id);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ error: "WORKFLOW_NOT_FOUND" });
    expect((await update(id, tiny())).status).toBe(404);
    expect((await archive(id)).status).toBe(404);
    // The signed in person is no member of "other": the workspace is not there for them.
    for (const response of [
      await list("other"),
      await create(tiny(), "other"),
      await validate(tiny(), "other"),
      await get(id, "", "other"),
      await update(id, tiny(), "", "other"),
      await archive(id, "other"),
    ])
      expect(response.status).toBe(404);
    expect(await rows()).toMatchObject([
      { id, name: "Theirs", current_version: 1, archived_at: null },
    ]);
    expect(await versions()).toHaveLength(1);
  });

  // #833-M1-T225
  it("refuse a second name that differs only in case with 409, and an expected version that is no longer current", async () => {
    const { create, update, addEnvironment } = await startRoutes();
    await addEnvironment("node");
    const created = await create(tiny());
    const { workflow } = (await created.json()) as { workflow: { id: string } };
    await update(workflow.id, tiny());

    const taken = await create({ ...tiny(), name: "tiny" });
    const stale = await update(workflow.id, tiny(), "?expectedVersion=1");

    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "WORKFLOW_NAME_TAKEN" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "WORKFLOW_VERSION_CONFLICT",
      current: 2,
    });
  });

  // #833-M1-T226
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
        () => create(tiny()),
        () => validate(tiny()),
        () => get("x"),
        () => update("x", tiny()),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    },
  );

  // #833-M1-T227
  it("export only the methods each route serves", async () => {
    const { listRoute, validateRoute, itemRoute } = await startRoutes();

    expect(Object.keys(listRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(validateRoute).sort()).toEqual(["POST"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["DELETE", "GET", "PUT"]);
  });
});

function change(
  document: Record<string, unknown>,
  key: string,
  value: unknown,
) {
  const copy = structuredClone(document);
  (copy.steps as Array<Record<string, unknown>>)[0]![key] = value;
  return copy;
}

describe("archiving through the route file", () => {
  // #833-M1-T359
  it("lets a Member archive a workflow: gone from the list, readable with its versions, no new version, name free again", async () => {
    const {
      create,
      update,
      get,
      list,
      archive,
      rows,
      versions,
      addEnvironment,
    } = await startRoutes({ role: "member" });
    await addEnvironment("node");
    const created = await create(tiny());
    const { workflow } = (await created.json()) as { workflow: { id: string } };

    const archived = await archive(workflow.id);

    expect(archived.status).toBe(200);
    expect(archived.headers.get("cache-control")).toBe("no-store");
    expect(await archived.json()).toMatchObject({
      workflow: { id: workflow.id, archivedAt: expect.any(String) },
    });
    expect(await (await list()).json()).toMatchObject({ workflows: [] });
    expect(await (await get(workflow.id)).json()).toMatchObject({
      workflow: { archivedAt: expect.any(String), versions: [{ version: 1 }] },
    });
    const refused = await update(workflow.id, tiny());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "WORKFLOW_ARCHIVED" });
    expect((await create(tiny())).status).toBe(201);
    expect(await rows()).toHaveLength(2);
    expect(await versions()).toHaveLength(2);
    expect((await archive("missing")).status).toBe(404);
  });
});

describe("the project of a lane (#922)", () => {
  // #922-T80
  it("lists and creates lanes within a project: a missing project is 400 and names the projects there are, another workspace's project is 404", async () => {
    const t = await startRoutes();
    await t.addEnvironment("node");
    const url = (query: string) =>
      `https://app.test/api/w/default/workflows${query}`;
    const context = {
      params: Promise.resolve({ workspace: "default" }),
    } as Parameters<typeof t.listRoute.GET>[1];

    const missing = await t.listRoute.GET(new Request(url("")), context);
    const foreign = await t.listRoute.GET(
      new Request(url(`?projectId=${t.projectIds.other}`)),
      context,
    );
    const created = await t.create(tiny());
    const own = await t.list();
    const stranger = await t.listRoute.POST(
      new Request(url(`?projectId=${t.projectIds.other}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tiny()),
      }),
      context,
    );

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: "WORKFLOW_PROJECT_REQUIRED",
      issues: [
        {
          path: "projectId",
          code: "project_required",
          available: [t.projectIds.default],
        },
      ],
    });
    expect(foreign.status).toBe(404);
    const refused = JSON.stringify(await foreign.json());
    expect(refused).toContain("WORKFLOW_PROJECT_NOT_FOUND");
    expect(refused).not.toContain(t.projectIds.other);
    expect(created.status).toBe(201);
    expect(
      (
        (await own.json()) as { workflows: { projectId: string }[] }
      ).workflows.map((workflow) => workflow.projectId),
    ).toEqual([t.projectIds.default]);
    expect(stranger.status).toBe(404);
    // Only the lane of this workspace was written.
    expect(await t.rows()).toHaveLength(1);
  });
});
