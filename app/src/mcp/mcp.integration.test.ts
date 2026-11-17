// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP registry of a workspace (#1050) over a real Postgres, the real service and route handlers, and the fake MCP server: a server with a
// header secret is added and tested, the tool list is stored and shown and the secret is never returned or stored in the clear; an address
// that is private or plain http is refused with a stable code; a server a lane uses is not removed and the lane is named. No real network.
import { afterEach, describe, expect, it } from "vitest";
import { startMcpFake, type McpFake } from "../../../fakes/mcp/server.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createGuardedFetch } from "../dispatch/guarded-fetch.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { createMcpRouteHandlers } from "./http.ts";
import { createMcpService, MCP_TEST_WORKSPACE_MAX } from "./service.ts";

const APP_SECRET = "test-app-secret-for-mcp-registry-0123456789";
const SECRET = "Bearer fake-secret-value-7f3a";

const fakes: McpFake[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
});

async function setup(options: { appSecret?: string } = {}) {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  const fake = await startMcpFake({
    requiredHeaders: { authorization: SECRET },
  });
  fakes.push(fake);
  const serviceOf = (
    workspaceId: string,
    appSecret = options.appSecret ?? APP_SECRET,
  ) =>
    createMcpService({
      workspaceId,
      repository: createMcpServersRepository(db, workspaceId),
      rateLimits: createRateLimitsRepository(db),
      appSecret,
      fetch: createGuardedFetch({ allowLoopback: true }),
      allowTestEndpoints: true,
      testLimits: { deadlineMs: 5000 },
    });
  const handlers = createMcpRouteHandlers({
    serviceFor: (id) => serviceOf(id),
  });
  const access = (
    workspaceId: string,
    role: "owner" | "admin" | "member",
  ): WorkspaceAccess =>
    ({
      user: { id: "u-1" },
      workspace: { id: workspaceId },
      role,
    }) as unknown as WorkspaceAccess;
  const post = (body: unknown) =>
    new Request("http://app.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { db, idA, idB, fake, serviceOf, handlers, access, post };
}

const form = (url: string, over: Record<string, unknown> = {}) => ({
  name: "Fake issues",
  transport: "streamable-http",
  url,
  auth: { kind: "header", headers: [{ name: "Authorization", value: SECRET }] },
  ...over,
});

describe("the MCP registry", () => {
  // #1050-T01
  it("adds a server with a header secret, tests it against the fake MCP server, stores and shows the tool list, and never returns the secret", async () => {
    const { db, idA, fake, serviceOf, handlers, access, post } = await setup();

    const created = await handlers.create(
      post(form(fake.url)),
      access(idA, "admin"),
    );
    const createdText = await created.text();
    const createdBody = JSON.parse(createdText) as { server: { id: string } };
    const tested = await handlers.test(
      new Request("http://app.test/x", { method: "POST" }),
      access(idA, "admin"),
      createdBody.server.id,
    );
    const testedBody = await tested.text();
    const listed = await (
      await handlers.list(
        new Request("http://app.test/x"),
        access(idA, "member"),
      )
    ).text();

    expect(created.status).toBe(201);
    expect(tested.status).toBe(200);
    expect(JSON.parse(testedBody)).toMatchObject({
      server: {
        name: "Fake issues",
        headers: ["Authorization"],
        status: "ok",
        tools: {
          serverName: "fake-mcp",
          tools: [
            {
              name: "search_issues",
              description: "Search the issues of a project.",
            },
            { name: "get_issue", description: "Read one issue by its key." },
          ],
        },
      },
    });
    // The server really got the credential, and no answer, row or log line holds it.
    expect(fake.sawHeader("authorization", SECRET)).toBe(true);
    for (const text of [createdText, testedBody, listed])
      expect(text).not.toContain("fake-secret-value-7f3a");
    const rows = JSON.stringify(
      await db.selectFrom("mcp_servers").selectAll().execute(),
    );
    expect(rows).not.toContain("fake-secret-value-7f3a");
    expect(await serviceOf(idA).list()).toHaveLength(1);
  });

  // #1050-T01
  it("keeps a header's value when an edit does not send it, and changes it when a new one is sent", async () => {
    const { idA, fake, serviceOf } = await setup();
    const service = serviceOf(idA);
    const created = await service.create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");
    const id = created.value.id;

    // Renamed, the header kept: the stored secret still opens the fake.
    const renamed = await service.update(id, {
      ...form(fake.url, { name: "Renamed" }),
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", keep: true }],
      },
      revision: created.value.revision,
    });
    const tested = await service.test(id);
    expect(renamed).toMatchObject({
      ok: true,
      value: { name: "Renamed", revision: 2 },
    });
    expect(tested).toMatchObject({ ok: true, value: { status: "ok" } });

    // A wrong new value: the fake says 401, and the page learns a code, not a text.
    await service.update(id, {
      ...form(fake.url, { name: "Renamed" }),
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", value: "Bearer wrong" }],
      },
      revision: 2,
    });
    expect(await service.test(id)).toMatchObject({
      ok: true,
      value: { status: "failed", testErrorCode: "mcp_test_unauthorized" },
    });
    // A header that is not stored cannot be kept.
    expect(
      await service.update(id, {
        ...form(fake.url, { name: "Renamed" }),
        auth: { kind: "header", headers: [{ name: "X-Other", keep: true }] },
        revision: 3,
      }),
    ).toMatchObject({ ok: false, error: "mcp_header_unknown" });
  });

  // #1050-T02
  it("never sends a stored header to another address: a change of the address keeps no value, and nothing is saved", async () => {
    const { idA, fake, serviceOf } = await setup();
    const foreign = await startMcpFake();
    fakes.push(foreign);
    const service = serviceOf(idA);
    const created = await service.create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");
    const { id, revision } = created.value;
    const keepForm = (url: string, over: Record<string, unknown> = {}) => ({
      ...form(url),
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", keep: true }],
      },
      revision,
      ...over,
    });

    // An Admin points the server at a host of their own, leaves the value empty and presses Test: refused, nothing changed.
    expect(await service.update(id, keepForm(foreign.url))).toMatchObject({
      ok: false,
      error: "mcp_header_value_required",
    });
    expect(
      await service.update(id, keepForm(fake.url, { transport: "sse" })),
    ).toMatchObject({ ok: false, error: "mcp_header_value_required" });
    expect(await service.test(id)).toMatchObject({
      ok: true,
      value: { status: "ok", revision },
    });
    expect(foreign.requests()).toEqual([]);

    // The values entered again are fine for the new address.
    expect(
      await service.update(id, { ...form(foreign.url), revision }),
    ).toMatchObject({ ok: true, value: { revision: revision + 1 } });
  });

  // #1050-T02
  it("refuses a change without the revision the form was made from", async () => {
    const { idA, fake, serviceOf } = await setup();
    const service = serviceOf(idA);
    const created = await service.create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");

    for (const revision of [undefined, "1", 0, 1.5, null])
      expect(
        await service.update(created.value.id, {
          ...form(fake.url, { name: "Renamed" }),
          ...(revision === undefined ? {} : { revision }),
        }),
      ).toMatchObject({ ok: false, error: "mcp_revision_required" });
    expect(await service.list()).toMatchObject([{ name: "Fake issues" }]);
  });

  // #1050-T01
  it("reports a stale form and a taken name, and holds the maximum of tests per workspace", async () => {
    const { idA, fake, serviceOf } = await setup();
    const service = serviceOf(idA);
    const a = await service.create(
      { id: "u-1" },
      form(fake.url, { name: "one" }),
    );
    await service.create({ id: "u-1" }, form(fake.url, { name: "two" }));
    if (!a.ok) throw new Error("seeding failed");

    expect(
      await service.create({ id: "u-1" }, form(fake.url, { name: "ONE" })),
    ).toMatchObject({
      ok: false,
      error: "mcp_name_taken",
    });
    expect(
      await service.update(a.value.id, {
        ...form(fake.url, { name: "one" }),
        revision: 9,
      }),
    ).toMatchObject({
      ok: false,
      error: "mcp_server_changed",
    });
    for (let index = 0; index < MCP_TEST_WORKSPACE_MAX; index++)
      expect((await service.test(a.value.id)).ok).toBe(true);
    expect(await service.test(a.value.id)).toMatchObject({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: expect.any(Number),
    });
  }, 60_000);

  it("shows a server whose headers cannot be read as a failed test with its own code, instead of sending anything", async () => {
    const { idA, db, fake, serviceOf } = await setup();
    const created = await serviceOf(idA).create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");

    const other = await serviceOf(
      idA,
      "another-app-secret-0123456789abcdef",
    ).test(created.value.id);

    expect(other).toMatchObject({
      ok: true,
      value: {
        status: "failed",
        testErrorCode: "mcp_test_credentials_unreadable",
      },
    });
    expect(fake.requests()).toEqual([]);
    expect(
      await db.selectFrom("mcp_servers").select("id").execute(),
    ).toHaveLength(1);
  });

  // #1050-T02
  it("refuses a private address and plain http with a stable code, and saves nothing", async () => {
    const { db, idA, serviceOf, handlers, access, post, fake } = await setup();
    const service = createMcpService({
      workspaceId: idA,
      repository: createMcpServersRepository(db, idA),
      rateLimits: createRateLimitsRepository(db),
      appSecret: APP_SECRET,
      fetch: createGuardedFetch({ allowLoopback: false }),
      // Production: no test flag.
      allowTestEndpoints: false,
    });
    const productionHandlers = createMcpRouteHandlers({
      serviceFor: () => service,
    });

    for (const [url, code] of [
      ["http://mcp.example.com/mcp", "mcp_url_not_https"],
      ["https://10.0.0.5/mcp", "mcp_url_private"],
      ["https://169.254.169.254/latest", "mcp_url_private"],
      ["https://localhost/mcp", "mcp_url_private"],
      ["https://[::1]/mcp", "mcp_url_private"],
    ] as const) {
      const response = await productionHandlers.create(
        post(form(url)),
        access(idA, "owner"),
      );
      expect({
        url,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        url,
        status: 422,
        body: { error: code },
      });
    }
    expect(await service.list()).toEqual([]);
    // Behind the test flag, loopback http is fine and a private network is still not.
    expect(
      (await handlers.create(post(form(fake.url)), access(idA, "owner")))
        .status,
    ).toBe(201);
    expect(
      (
        await handlers.create(
          post(form("http://10.0.0.5/mcp", { name: "x" })),
          access(idA, "owner"),
        )
      ).status,
    ).toBe(422);
    expect(await serviceOf(idA).list()).toHaveLength(1);
  });

  // #1050-T03
  it("refuses to remove a server a lane uses and names the lane, and removes it when no lane uses it", async () => {
    const { db, idA, fake, serviceOf, handlers, access } = await setup();
    const created = await serviceOf(idA).create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");
    const lane = await createWorkflowsRepository(db, idA).create(
      {
        name: "Triage issues",
        document: JSON.stringify({
          name: "Triage issues",
          mcp: [created.value.id],
          steps: [],
        }),
        createdBy: "u-1",
      },
      100,
    );
    if (!lane.ok) throw new Error("seeding failed");
    const request = () =>
      new Request("http://app.test/x", { method: "DELETE" });

    const refused = await handlers.remove(
      request(),
      access(idA, "admin"),
      created.value.id,
    );

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "mcp_server_in_use",
      lanes: [
        { id: lane.workflow.id, name: "Triage issues", projectName: null },
      ],
    });
    expect(await serviceOf(idA).list()).toHaveLength(1);

    await createWorkflowsRepository(db, idA).archive(lane.workflow.id, 100);
    const removed = await handlers.remove(
      request(),
      access(idA, "admin"),
      created.value.id,
    );
    expect(removed.status).toBe(200);
    expect(await serviceOf(idA).list()).toEqual([]);
  });

  it("lets a Member read the list and nothing else, and keeps every workspace to its own servers", async () => {
    const { idA, idB, fake, serviceOf, handlers, access, post } = await setup();
    const created = await serviceOf(idA).create({ id: "u-1" }, form(fake.url));
    if (!created.ok) throw new Error("seeding failed");
    const request = (method: string) =>
      new Request("http://app.test/x", { method });

    expect(
      (await handlers.list(request("GET"), access(idA, "member"))).status,
    ).toBe(200);
    expect(
      (
        await handlers.create(
          post(form(fake.url, { name: "n" })),
          access(idA, "member"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.test(
          request("POST"),
          access(idA, "member"),
          created.value.id,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.remove(
          request("DELETE"),
          access(idA, "member"),
          created.value.id,
        )
      ).status,
    ).toBe(403);
    // Another workspace's Owner reaches nothing of this one.
    expect(
      (
        await handlers.test(
          request("POST"),
          access(idB, "owner"),
          created.value.id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handlers.remove(
          request("DELETE"),
          access(idB, "owner"),
          created.value.id,
        )
      ).status,
    ).toBe(404);
    expect(await serviceOf(idB).list()).toEqual([]);
  });

  it("refuses a request from another site and a body that is not JSON", async () => {
    const { idA, handlers, access } = await setup();

    const crossSite = await handlers.remove(
      new Request("http://app.test/x", {
        method: "DELETE",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      access(idA, "owner"),
      "x",
    );
    const text = await handlers.create(
      new Request("http://app.test/x", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      }),
      access(idA, "owner"),
    );

    expect(crossSite.status).toBe(403);
    expect(text.status).toBe(415);
  });
});
