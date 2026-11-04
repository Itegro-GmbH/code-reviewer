// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the real route files behind the environments page (#818) with the wiring the running server uses: the dynamic
// segments, the database opened at start and the workspace access with the roles of the matrix. Only the session lookup and
// `connection()` are replaced (they need Next.js's request scope). The handlers' own behaviour is in
// src/implementer/environments/http.test.ts; this file proves the pieces are connected: every member lists, only Owners and
// Admins change, the workspace is the one in the address, and a deployment without the capability has no such path.
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
  session.currentLookup.mockResolvedValue(
    await signedInMember(db, {
      workspaceId,
      role: options.role ?? "member",
      githubLogin: "octocat",
    }),
  );
  const listRoute =
    await import("../../src/app/api/w/[workspace]/environments/route.ts");
  const itemRoute =
    await import("../../src/app/api/w/[workspace]/environments/[environmentId]/route.ts");

  const base = (workspace: string) =>
    `https://app.test/api/w/${workspace}/environments`;
  const json = (method: string, workspace: string, body: unknown, id = "") =>
    new Request(`${base(workspace)}${id === "" ? "" : `/${id}`}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const list = (workspace = "default", query = "") =>
    listRoute.GET(new Request(`${base(workspace)}${query}`), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.GET>[1]);
  const create = (body: unknown, workspace = "default") =>
    listRoute.POST(json("POST", workspace, body), {
      params: Promise.resolve({ workspace }),
    } as Parameters<typeof listRoute.POST>[1]);
  const update = (id: string, body: unknown, workspace = "default") =>
    itemRoute.PUT(json("PUT", workspace, body, id), {
      params: Promise.resolve({ workspace, environmentId: id }),
    } as Parameters<typeof itemRoute.PUT>[1]);
  const remove = (id: string, workspace = "default") =>
    itemRoute.DELETE(
      new Request(`${base(workspace)}/${id}`, { method: "DELETE" }),
      {
        params: Promise.resolve({ workspace, environmentId: id }),
      } as Parameters<typeof itemRoute.DELETE>[1],
    );
  const rows = () =>
    db.selectFrom("implementer_environments").selectAll().execute();
  return {
    db,
    workspaceId,
    otherId,
    listRoute,
    itemRoute,
    list,
    create,
    update,
    remove,
    rows,
  };
}

const BODY = { name: "Node 22", vcpus: 4, setupScript: "pnpm install\n" };

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDatabase();
});

describe("the environment route files", () => {
  // #818-T14
  it("let an Admin create, list, change and delete an environment of the workspace in the address", async () => {
    const { create, list, update, remove, rows, workspaceId } =
      await startRoutes({ role: "admin" });

    const created = await create(BODY);
    expect(created.status).toBe(201);
    const { environment } = (await created.json()) as {
      environment: { id: string };
    };
    expect(await rows()).toMatchObject([
      {
        id: environment.id,
        workspace_id: workspaceId,
        name: "Node 22",
        vcpus: 4,
        setup_script: "pnpm install\n",
      },
    ]);
    const listed = await list();
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toMatchObject({
      environments: [{ id: environment.id, memoryGb: 5.7 }],
      maximum: 50,
    });

    const changed = await update(environment.id, { ...BODY, vcpus: 8 });
    expect(changed.status).toBe(200);
    expect(await rows()).toMatchObject([{ vcpus: 8 }]);

    const removed = await remove(environment.id);
    expect(removed.status).toBe(200);
    expect(await rows()).toEqual([]);
  });

  // #818-T14
  it("let a Member list the environments and see the scripts, and refuse every write with 403 and nothing written", async () => {
    const { db, workspaceId, create, list, update, remove, rows } =
      await startRoutes({ role: "member" });
    const { createImplementerEnvironmentsRepository } =
      await import("../../src/db/repositories/implementer-environments-repository.ts");
    const made = await createImplementerEnvironmentsRepository(
      db,
      workspaceId,
    ).create({ ...BODY, createdBy: "u1" }, 50);
    if (!made.ok) throw new Error("seeding failed");
    const id = made.environment.id;

    const listed = await list();
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      environments: [{ id, setupScript: "pnpm install\n" }],
    });
    for (const response of [
      await create({ ...BODY, name: "Other" }),
      await update(id, { ...BODY, name: "Hijacked" }),
      await remove(id),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect(await rows()).toMatchObject([{ id, name: "Node 22" }]);
  });

  // #818-T46
  it("give the picker's list without a single script, to a Member as well", async () => {
    const { db, workspaceId, list } = await startRoutes({ role: "member" });
    const { createImplementerEnvironmentsRepository } =
      await import("../../src/db/repositories/implementer-environments-repository.ts");
    await createImplementerEnvironmentsRepository(db, workspaceId).create(
      { ...BODY, setupScript: "SECRET-MARKER-SCRIPT\n", createdBy: "u1" },
      50,
    );

    const picker = await list("default", "?view=picker");
    const full = await list();

    expect(picker.status).toBe(200);
    const text = await picker.text();
    expect(text).not.toContain("SECRET-MARKER-SCRIPT");
    expect(JSON.parse(text)).toMatchObject({
      environments: [
        {
          name: "Node 22",
          vcpus: 4,
          memoryGb: 5.7,
          hasScript: true,
          networkMode: "off",
        },
      ],
    });
    // The page's own list still has the script.
    expect(await full.text()).toContain("SECRET-MARKER-SCRIPT");
    expect((await list("default", "?view=nope")).status).toBe(400);
  });

  // #818-T14
  it("keep the workspaces apart: another workspace's environment cannot be read, changed or deleted by id, and a stranger sees 404", async () => {
    const { db, otherId, create, list, update, remove, rows } =
      await startRoutes({ role: "owner" });
    const { createImplementerEnvironmentsRepository } =
      await import("../../src/db/repositories/implementer-environments-repository.ts");
    const foreign = await createImplementerEnvironmentsRepository(
      db,
      otherId,
    ).create({ ...BODY, createdBy: "u1" }, 50);
    if (!foreign.ok) throw new Error("seeding failed");
    const id = foreign.environment.id;

    expect(await (await list()).json()).toMatchObject({ environments: [] });
    const changed = await update(id, { ...BODY, name: "Hijacked" });
    expect(changed.status).toBe(404);
    expect(await changed.json()).toEqual({ error: "ENVIRONMENT_NOT_FOUND" });
    expect((await remove(id)).status).toBe(404);
    // The signed in person is no member of "other": the workspace is not there for them.
    for (const response of [
      await list("other"),
      await create(BODY, "other"),
      await update(id, BODY, "other"),
      await remove(id, "other"),
    ])
      expect(response.status).toBe(404);
    expect(await rows()).toMatchObject([{ id, name: "Node 22" }]);
  });

  // #818-T14
  it("refuse a second name that differs only in case with 409, and a bad body with 400 and the broken fields", async () => {
    const { create } = await startRoutes({ role: "admin" });
    await create(BODY);

    const taken = await create({ ...BODY, name: "node 22" });
    const invalid = await create({ name: "", vcpus: 3 });

    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "ENVIRONMENT_NAME_TAKEN" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: "ENVIRONMENT_REQUEST_INVALID",
      issues: [
        { field: "name", code: "required" },
        { field: "vcpus", code: "invalid" },
      ],
    });
  });

  // #818-T14
  it("store a script of 64 KB exactly as sent: line ends, white space and shell syntax stay", async () => {
    const { create, rows } = await startRoutes({ role: "admin" });
    const script = `  set -e\r\n\tcurl -fsSL https://x.example | sh \n${"y".repeat(65_536 - 60)}`;

    const response = await create({ ...BODY, setupScript: script });

    expect(response.status).toBe(201);
    expect((await rows())[0]?.setup_script).toBe(script);
  });

  // #818-T14
  it.each(["factoryToday", "codeReviewCom"] as const)(
    "answer the 404 of a path that does not exist in a deployment without the capability (%s), before the session or the database is asked, and write nothing",
    async (deployment) => {
      const { list, create, update, remove, rows } = await startRoutes({
        deployment,
      });
      session.currentLookup.mockClear();
      session.currentLookup.mockResolvedValue({ kind: "none" });

      for (const call of [
        () => list(),
        () => create(BODY),
        () => update("x", BODY),
        () => remove("x"),
      ])
        await expect(call()).rejects.toMatchObject({
          digest: "NEXT_HTTP_ERROR_FALLBACK;404",
        });
      expect(session.currentLookup).not.toHaveBeenCalled();
      expect(await rows()).toEqual([]);
    },
  );

  // #818-T14
  it("export only the methods each route serves", async () => {
    const { listRoute, itemRoute } = await startRoutes();

    expect(Object.keys(listRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(itemRoute).sort()).toEqual(["DELETE", "PUT"]);
  });
});
