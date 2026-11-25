// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { createConnectedAppsHandlers } from "./http.ts";
import { createConnectedAppsService } from "./service.ts";
import {
  ACME,
  ADA,
  BOB,
  SIDE,
  connect,
  createWorld,
} from "../oauth/test-harness.ts";
import type { WorkspaceAccess } from "../../workspaces/access.ts";

async function setup() {
  const world = createWorld();
  await connect(world, { user: ADA.id });
  await connect(world, { user: BOB.id, scope: "factory:read" });
  await connect(world, {
    user: ADA.id,
    workspaceId: SIDE.id,
    scope: "factory:read",
  });
  const service = createConnectedAppsService({
    grantsOf: (workspaceId) => world.store.scoped(workspaceId),
    now: () => world.clock.now,
  });
  return { world, service };
}

describe("the connected AI apps of a workspace", () => {
  // #1144-T200
  it("shows an Owner every connection of the workspace and no other workspace's", async () => {
    const { service } = await setup();
    const apps = await service.list(ACME.id, { userId: ADA.id, role: "owner" });
    expect(apps.map((app) => [app.userName, app.scope, app.own])).toEqual(
      expect.arrayContaining([
        ["Ada", "factory:control", true],
        ["Bob", "factory:read", false],
      ]),
    );
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ clientName: "Claude Code" });
  });

  // #1144-T201
  it("shows a Member only their own connection", async () => {
    const { service } = await setup();
    const apps = await service.list(ACME.id, {
      userId: BOB.id,
      role: "member",
    });
    expect(apps.map((app) => app.userName)).toEqual(["Bob"]);
  });

  // #1144-T202
  it("lets an Admin revoke anybody's, and a Member only their own", async () => {
    const { world, service } = await setup();
    const all = await service.list(ACME.id, { userId: ADA.id, role: "owner" });
    const adas = all.find((app) => app.userName === "Ada")!;
    const bobs = all.find((app) => app.userName === "Bob")!;
    expect(
      await service.revoke(
        ACME.id,
        { userId: BOB.id, role: "member" },
        adas.id,
      ),
    ).toBe("not_found");
    expect(
      await service.revoke(
        ACME.id,
        { userId: BOB.id, role: "member" },
        bobs.id,
      ),
    ).toBe("revoked");
    expect(
      await service.revoke(ACME.id, { userId: ADA.id, role: "admin" }, adas.id),
    ).toBe("revoked");
    expect(
      await service.list(ACME.id, { userId: ADA.id, role: "owner" }),
    ).toEqual([]);
    // The other workspace's connection is untouched.
    expect(await world.store.scoped(SIDE.id).list()).toHaveLength(1);
  });

  // #1144-T203
  it("does not revoke a connection of another workspace, whoever asks", async () => {
    const { world, service } = await setup();
    const [side] = await world.store.scoped(SIDE.id).list();
    expect(
      await service.revoke(
        ACME.id,
        { userId: ADA.id, role: "owner" },
        side!.id,
      ),
    ).toBe("not_found");
    expect(await world.store.scoped(SIDE.id).list()).toHaveLength(1);
  });
});

describe("the routes of the list", () => {
  const access = (
    role: "owner" | "member",
    userId: string,
  ): WorkspaceAccess => ({
    user: {
      id: userId,
      name: userId,
      email: "x@example.test",
      isInstanceAdmin: false,
      githubLogin: null,
      githubId: null,
      image: null,
    },
    workspace: {
      id: ACME.id,
      slug: ACME.slug,
      name: ACME.name,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    },
    role,
  });

  // #1144-T204
  it("revokes by a form post, goes back to the page, and refuses another site", async () => {
    const { world, service } = await setup();
    const handlers = createConnectedAppsHandlers(service);
    const [adas] = await service.list(ACME.id, {
      userId: ADA.id,
      role: "owner",
    });
    const crossSite = await handlers.revoke(
      new Request("https://x.test/revoke", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      access("owner", ADA.id),
      adas!.id,
    );
    expect(crossSite.status).toBe(403);
    expect(await world.store.scoped(ACME.id).list()).toHaveLength(2);

    const done = await handlers.revoke(
      new Request("https://x.test/revoke", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      access("owner", ADA.id),
      adas!.id,
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/w/acme/settings/ai-apps");
    const missing = await handlers.revoke(
      new Request("https://x.test/revoke", { method: "POST" }),
      access("owner", ADA.id),
      adas!.id,
    );
    expect(missing.status).toBe(404);
  });

  // #1144-T205
  it("lists as JSON without caching", async () => {
    const { service } = await setup();
    const response = await createConnectedAppsHandlers(service).list(
      access("member", BOB.id),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { apps: { userName: string }[] };
    expect(body.apps.map((app) => app.userName)).toEqual(["Bob"]);
  });
});
