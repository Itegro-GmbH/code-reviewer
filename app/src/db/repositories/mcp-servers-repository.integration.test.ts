// SPDX-License-Identifier: LicenseRef-Proprietary

// The MCP servers of a workspace (#1050) against a real Postgres: a name once per workspace whatever its case, a bounded count, the sealed
// headers handed out only by `readHeaders`, a test result stored only for the revision that was tested, an edit that makes the last test
// stale, a server a lane names is not removed (and the lane is named), and nothing crosses workspaces.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import {
  createMcpServersRepository,
  mcpReferencesIn,
  type NewMcpServer,
} from "./mcp-servers-repository.ts";
import { createWorkflowsRepository } from "./workflows-repository.ts";

const SEALED = { ciphertext: "c1", nonce: "n1", keyVersion: 1 };

const server = (
  id: string,
  over: Partial<NewMcpServer> = {},
): NewMcpServer => ({
  id,
  name: `Server ${id}`,
  transport: "streamable-http",
  url: `https://mcp.example.com/${id}`,
  authKind: "header",
  headerNames: ["Authorization"],
  sealed: SEALED,
  createdBy: null,
  ...over,
});

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 17, 8, 0, tick++));
  return {
    db,
    idA,
    idB,
    a: createMcpServersRepository(db, idA, now),
    b: createMcpServersRepository(db, idB, now),
  };
}

describe("the MCP servers repository", () => {
  // #1050-T01
  it("creates a server with sealed headers, lists it by name and reads the header names but never the values", async () => {
    const { a } = await setup();

    const created = await a.create(
      server("s-1", {
        name: "linear",
        headerNames: ["Authorization", "X-Team"],
      }),
      50,
    );
    await a.create(
      server("s-2", {
        name: "Atlassian",
        authKind: "none",
        headerNames: [],
        sealed: null,
      }),
      50,
    );

    expect(created).toMatchObject({
      ok: true,
      server: {
        id: "s-1",
        authKind: "header",
        headerNames: ["Authorization", "X-Team"],
        testStatus: "untested",
        snapshot: null,
        revision: 1,
      },
    });
    expect((await a.list()).map((entry) => entry.name)).toEqual([
      "Atlassian",
      "linear",
    ]);
    expect(JSON.stringify(await a.list())).not.toContain("c1");
    expect(await a.readHeaders("s-1")).toMatchObject({ sealed: SEALED });
    expect((await a.readHeaders("s-2"))?.sealed).toBeNull();
  });

  it("keeps one server per name and workspace whatever the case, and the same name free in another workspace", async () => {
    const { a, b } = await setup();
    await a.create(server("s-1", { name: "Linear" }), 50);

    expect(await a.create(server("s-2", { name: "LINEAR" }), 50)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await b.create(server("s-3", { name: "linear" }), 50)).ok).toBe(
      true,
    );
  });

  it("holds the maximum of servers per workspace, counted with the new one", async () => {
    const { a, b } = await setup();
    await a.create(server("s-1"), 2);
    await a.create(server("s-2"), 2);

    expect(await a.create(server("s-3"), 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect((await b.create(server("s-4"), 2)).ok).toBe(true);
  });

  it("never lets two creations at once pass the maximum", async () => {
    const { a } = await setup();

    const results = await Promise.all(
      ["s-1", "s-2", "s-3", "s-4"].map((id) => a.create(server(id), 2)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(await a.list()).toHaveLength(2);
  });

  // #1050-T01
  it("stores the result of a test for the revision that was tested, and keeps the tool list after a later failure", async () => {
    const { a } = await setup();
    await a.create(server("s-1"), 50);
    const snapshot = {
      serverName: "Fake",
      serverVersion: "1",
      protocolVersion: "2025-06-18",
      tools: [{ name: "search", description: "Searches." }],
      truncated: false,
    };

    expect(await a.recordTest("s-1", 1, { ok: true, snapshot })).toBe(true);
    expect(await a.get("s-1")).toMatchObject({
      testStatus: "ok",
      testErrorCode: null,
      snapshot,
    });
    expect(
      await a.recordTest("s-1", 1, { ok: false, code: "mcp_test_timeout" }),
    ).toBe(true);
    expect(await a.get("s-1")).toMatchObject({
      testStatus: "failed",
      testErrorCode: "mcp_test_timeout",
      snapshot,
    });
  });

  it("does not store a result for a revision that was edited since, and an edit of the address makes the last test stale", async () => {
    const { a } = await setup();
    await a.create(server("s-1"), 50);
    const snapshot = {
      serverName: null,
      serverVersion: null,
      protocolVersion: null,
      tools: [],
      truncated: false,
    };
    await a.recordTest("s-1", 1, { ok: true, snapshot });

    const renamed = await a.update("s-1", 1, {
      name: "Renamed",
      transport: "streamable-http",
      url: "https://mcp.example.com/s-1",
      authKind: "header",
      headerNames: ["Authorization"],
    });
    // Only the name changed: the result of the test still holds.
    expect(renamed).toMatchObject({
      ok: true,
      server: { revision: 2, testStatus: "ok" },
    });

    const moved = await a.update("s-1", 2, {
      name: "Renamed",
      transport: "streamable-http",
      url: "https://mcp.example.com/other",
      authKind: "header",
      headerNames: ["Authorization"],
    });
    expect(moved).toMatchObject({
      ok: true,
      server: {
        revision: 3,
        testStatus: "untested",
        snapshot: null,
        testedAt: null,
      },
    });
    // A test that started before the edit reports for revision 2: it is dropped.
    expect(await a.recordTest("s-1", 2, { ok: true, snapshot })).toBe(false);
    expect((await a.get("s-1"))?.testStatus).toBe("untested");
  });

  it("replaces the sealed headers only when a new seal is given, and drops them when the kind becomes none", async () => {
    const { a } = await setup();
    await a.create(server("s-1"), 50);
    const fields = {
      name: "Server s-1",
      transport: "streamable-http",
      url: "https://mcp.example.com/s-1",
    };

    await a.update("s-1", 1, {
      ...fields,
      authKind: "header",
      headerNames: ["Authorization"],
    });
    expect((await a.readHeaders("s-1"))?.sealed).toEqual(SEALED);
    await a.update("s-1", 2, {
      ...fields,
      authKind: "header",
      headerNames: ["X-Key"],
      sealed: { ciphertext: "c2", nonce: "n2", keyVersion: 1 },
    });
    expect(await a.readHeaders("s-1")).toMatchObject({
      server: { headerNames: ["X-Key"] },
      sealed: { ciphertext: "c2" },
    });
    await a.update("s-1", 3, {
      ...fields,
      authKind: "none",
      headerNames: [],
      sealed: null,
    });
    expect(await a.readHeaders("s-1")).toMatchObject({
      server: { authKind: "none", headerNames: [] },
      sealed: null,
    });
  });

  it("refuses a change made on a stale revision, an unknown server and a taken name", async () => {
    const { a } = await setup();
    await a.create(server("s-1", { name: "one" }), 50);
    await a.create(server("s-2", { name: "two" }), 50);
    const change = {
      name: "one",
      transport: "sse",
      url: "https://mcp.example.com/x",
      authKind: "none",
      headerNames: [],
      sealed: null,
    };

    expect(await a.update("s-1", 5, change)).toEqual({
      ok: false,
      reason: "changed",
    });
    expect(await a.update("nope", 1, change)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await a.update("s-2", 1, change)).toEqual({
      ok: false,
      reason: "name_taken",
    });
  });

  // #1050-T03
  it("refuses to remove a server a lane names, names the lane and its project, and removes it once the lane no longer does", async () => {
    const { db, idA, a } = await setup();
    await a.create(server("s-1"), 50);
    await a.create(server("s-2"), 50);
    const workflows = createWorkflowsRepository(db, idA);
    const lane = await workflows.create(
      {
        name: "Triage",
        document: JSON.stringify({ name: "Triage", mcp: ["s-1"], steps: [] }),
        createdBy: "u-1",
      },
      100,
    );
    if (!lane.ok) throw new Error("seeding failed");

    expect(await a.removeUnlessUsed("s-1")).toEqual({
      removed: false,
      reason: "in_use",
      lanes: [
        {
          id: lane.workflow.id,
          name: "Triage",
          projectId: null,
          projectName: null,
        },
      ],
    });
    expect(await a.get("s-1")).toBeDefined();
    // A server no lane names is free.
    expect(await a.removeUnlessUsed("s-2")).toEqual({ removed: true });
    // The lane's next version drops it.
    await workflows.saveVersion(
      lane.workflow.id,
      {
        name: "Triage",
        document: JSON.stringify({ name: "Triage", steps: [] }),
        createdBy: "u-1",
      },
      100,
    );
    expect(await a.removeUnlessUsed("s-1")).toEqual({ removed: true });
    expect(await a.removeUnlessUsed("s-1")).toEqual({
      removed: false,
      reason: "not_found",
    });
  });

  // #1050-T03
  it("counts the lane of a step too, and not an archived lane, a lane of another workspace or one that only mentions the id", async () => {
    const { db, idA, idB, a, b } = await setup();
    await a.create(server("s-1"), 50);
    await b.create(server("s-9"), 50);
    const mine = createWorkflowsRepository(db, idA);
    const theirs = createWorkflowsRepository(db, idB);
    const stepLane = await mine.create(
      {
        name: "Step lane",
        document: JSON.stringify({
          steps: [{ id: "review", mcp: [{ server: "s-1" }] }],
        }),
        createdBy: "u-1",
      },
      100,
    );
    const mention = await mine.create(
      {
        name: "Mention",
        document: JSON.stringify({ description: "uses s-1", steps: [] }),
        createdBy: "u-1",
      },
      100,
    );
    const foreign = await theirs.create(
      {
        name: "Foreign",
        document: JSON.stringify({ mcp: ["s-1"] }),
        createdBy: "u-1",
      },
      100,
    );
    if (!stepLane.ok || !mention.ok || !foreign.ok)
      throw new Error("seeding failed");

    expect((await a.lanesUsing("s-1")).map((lane) => lane.name)).toEqual([
      "Step lane",
    ]);
    await mine.archive(stepLane.workflow.id, 100);
    expect(await a.lanesUsing("s-1")).toEqual([]);
    // Another workspace's lane names an id of this one: it is not this workspace's lane.
    expect(await b.lanesUsing("s-1")).toEqual([
      expect.objectContaining({ name: "Foreign" }),
    ]);
  });

  it("hands the row under the lock to a change that is built from it, and returns a refusal of the builder without writing", async () => {
    const { a } = await setup();
    await a.create(server("s-1"), 50);
    const seen: { revision: number; url: string }[] = [];

    const built = await a.update("s-1", 1, ({ server: current }) => {
      seen.push({ revision: current.revision, url: current.url });
      return {
        name: "Built",
        transport: "streamable-http",
        url: current.url,
        authKind: "none",
        headerNames: [],
        sealed: null,
      };
    });
    const refused = await a.update("s-1", 2, () => ({ refused: "no_way" }));
    // The revision is compared before the builder is asked.
    const stale = await a.update("s-1", 1, () => {
      throw new Error("not asked");
    });

    expect(seen).toEqual([{ revision: 1, url: "https://mcp.example.com/s-1" }]);
    expect(built).toMatchObject({
      ok: true,
      server: { name: "Built", revision: 2, authKind: "none" },
    });
    expect(refused).toEqual({
      ok: false,
      reason: "refused",
      code: "no_way",
    });
    expect(stale).toEqual({ ok: false, reason: "changed" });
    expect(await a.get("s-1")).toMatchObject({ revision: 2, name: "Built" });
  });

  it("reads the `mcp` references of a document: every string under the key, at any depth, and nothing else", () => {
    expect(
      [
        ...mcpReferencesIn(
          JSON.stringify({
            mcp: ["a", { server: "b", tools: ["c"] }],
            steps: [{ mcp: [{ id: "d" }], note: "e" }],
            other: { mcp: "f" },
            name: "g",
          }),
        ),
      ].sort(),
    ).toEqual(["a", "b", "c", "d", "f"]);
    expect([...mcpReferencesIn("not json")]).toEqual([]);
  });

  it("never reads or changes another workspace's server", async () => {
    const { a, b } = await setup();
    await b.create(server("s-b"), 50);

    expect(await a.get("s-b")).toBeUndefined();
    expect(await a.readHeaders("s-b")).toBeUndefined();
    expect(await a.list()).toEqual([]);
    expect(await a.removeUnlessUsed("s-b")).toEqual({
      removed: false,
      reason: "not_found",
    });
    expect(
      await a.recordTest("s-b", 1, { ok: false, code: "mcp_test_timeout" }),
    ).toBe(false);
  });
});
