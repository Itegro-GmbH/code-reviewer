// SPDX-License-Identifier: LicenseRef-Proprietary

// The environments of the Implementer (#818) against a real Postgres: what the repository keeps true (a name once per
// workspace whatever its case, a bounded count, stored text as it is, nothing across workspaces).
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "./implementer-environments-repository.ts";
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
  const times = [
    "2026-11-02T08:00:00.000Z",
    "2026-11-02T09:00:00.000Z",
    "2026-11-02T10:00:00.000Z",
    "2026-11-02T11:00:00.000Z",
  ];
  let tick = 0;
  const now = () => new Date(times[Math.min(tick++, times.length - 1)] ?? "");
  let counter = 0;
  const newId = () => `env-${++counter}`;
  return {
    db,
    a: createImplementerEnvironmentsRepository(db, idA, { now, newId }),
    b: createImplementerEnvironmentsRepository(db, idB, { now, newId }),
    idA,
  };
}

const NODE = {
  name: "Node 22",
  vcpus: 4,
  setupScript: "  npm ci\r\n\tnpm run build  \n",
  createdBy: "u-1",
};

describe("the environments repository", () => {
  // #818-T03
  it("creates an environment and reads it back with the script as it was written", async () => {
    const { a, idA } = await setup();

    const created = await a.create(NODE, 50);

    expect(created).toEqual({
      ok: true,
      environment: {
        id: "env-1",
        workspaceId: idA,
        name: "Node 22",
        kind: "hosted",
        labels: [],
        vcpus: 4,
        setupScript: "  npm ci\r\n\tnpm run build  \n",
        network: { mode: "off", hosts: [] },
        createdBy: "u-1",
        createdAt: "2026-11-02T08:00:00.000Z",
        updatedAt: "2026-11-02T08:00:00.000Z",
      },
    });
    expect(await a.get("env-1")).toEqual(
      created.ok ? created.environment : undefined,
    );
  });

  // #818-T03
  it("lists the environments by name, ignoring case", async () => {
    const { a } = await setup();
    for (const name of ["pnpm", "Bun", "node"])
      await a.create({ ...NODE, name }, 50);

    expect((await a.list()).map((environment) => environment.name)).toEqual([
      "Bun",
      "node",
      "pnpm",
    ]);
  });

  // #818-T45
  it("lists summaries without reading the script: name, size and whether there is a script, by name", async () => {
    const { a, b } = await setup();
    await a.create({ ...NODE, name: "pnpm", setupScript: "" }, 50);
    await a.create(
      { ...NODE, name: "Bun", vcpus: 1, setupScript: "x".repeat(65_536) },
      50,
    );
    await b.create({ ...NODE, name: "foreign" }, 50);

    const summaries = await a.listSummaries();

    expect(summaries).toEqual([
      {
        id: expect.any(String),
        name: "Bun",
        kind: "hosted",
        labels: [],
        vcpus: 1,
        hasScript: true,
        networkMode: "off",
      },
      {
        id: expect.any(String),
        name: "pnpm",
        kind: "hosted",
        labels: [],
        vcpus: 4,
        hasScript: false,
        networkMode: "off",
      },
    ]);
    for (const summary of summaries)
      expect(Object.keys(summary).sort()).toEqual([
        "hasScript",
        "id",
        "kind",
        "labels",
        "name",
        "networkMode",
        "vcpus",
      ]);
  });

  // #818-T03
  it("refuses a second name that differs only in case, and allows the same name in another workspace", async () => {
    const { a, b } = await setup();
    await a.create({ ...NODE, name: "Node" }, 50);

    expect(await a.create({ ...NODE, name: "NODE" }, 50)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await b.create({ ...NODE, name: "Node" }, 50)).ok).toBe(true);
  });

  // #818-T03
  it("refuses a new environment once the workspace holds the maximum, and counts only its own", async () => {
    const { a, b } = await setup();
    await a.create({ ...NODE, name: "one" }, 2);
    await a.create({ ...NODE, name: "two" }, 2);

    expect(await a.create({ ...NODE, name: "three" }, 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect((await b.create({ ...NODE, name: "one" }, 2)).ok).toBe(true);
  });

  // #818-T03
  it("lets two creators race for the last place: exactly one wins", async () => {
    const { a } = await setup();
    await a.create({ ...NODE, name: "one" }, 2);

    const results = await Promise.all([
      a.create({ ...NODE, name: "two" }, 2),
      a.create({ ...NODE, name: "three" }, 2),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await a.list()).toHaveLength(2);
  });

  // #818-T03
  it("takes the lock on the workspace row before it counts: a creator waits for one that holds the row", async () => {
    const { db, a, idA } = await setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const holds = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // Another creator: it has the row of the workspace and has not finished.
    const other = db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("workspaces")
        .select("id")
        .where("id", "=", idA)
        .forNoKeyUpdate()
        .execute();
      holding();
      await held;
    });
    await holds;

    let finished = false;
    const creating = a.create(NODE, 50).then((outcome) => {
      finished = true;
      return outcome;
    });
    // It waits for a lock on the row: seen from another connection, a backend is blocked on a lock.
    const deadline = Date.now() + 3_000;
    let blocked = 0;
    while (blocked === 0 && Date.now() < deadline) {
      const { rows } = await sql<{
        blocked: number;
      }>`select count(*)::int as blocked from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`.execute(
        db,
      );
      blocked = rows[0]?.blocked ?? 0;
      if (blocked === 0)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(blocked).toBeGreaterThan(0);
    expect(finished).toBe(false);

    release();
    await other;
    expect((await creating).ok).toBe(true);
  });

  // #818-T03
  it("updates name, size and script, keeps who made it and when, and moves updatedAt", async () => {
    const { a } = await setup();
    await a.create(NODE, 50);

    const updated = await a.update("env-1", {
      name: "Node 24",
      vcpus: 8,
      setupScript: "",
    });

    expect(updated).toMatchObject({
      ok: true,
      environment: {
        id: "env-1",
        name: "Node 24",
        vcpus: 8,
        setupScript: "",
        createdBy: "u-1",
        createdAt: "2026-11-02T08:00:00.000Z",
        updatedAt: "2026-11-02T09:00:00.000Z",
      },
    });
  });

  // #818-T03
  it("keeps a name when an environment is saved under its own name in another case, and refuses another's", async () => {
    const { a } = await setup();
    await a.create({ ...NODE, name: "Node" }, 50);
    await a.create({ ...NODE, name: "Bun" }, 50);

    expect(
      (await a.update("env-1", { name: "NODE", vcpus: 2, setupScript: "" })).ok,
    ).toBe(true);
    expect(
      await a.update("env-1", { name: "bun", vcpus: 2, setupScript: "" }),
    ).toEqual({ ok: false, reason: "name_taken" });
  });

  // #818-T03
  it("answers a missing id the same way for read, update and delete", async () => {
    const { a } = await setup();

    expect(await a.get("nope")).toBeUndefined();
    expect(
      await a.update("nope", { name: "x", vcpus: 2, setupScript: "" }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await a.remove("nope")).toBe(false);
  });

  // #818-T03
  it("deletes an environment and frees its name", async () => {
    const { a } = await setup();
    await a.create({ ...NODE, name: "Node" }, 50);

    expect(await a.remove("env-1")).toBe(true);

    expect(await a.get("env-1")).toBeUndefined();
    expect((await a.create({ ...NODE, name: "Node" }, 50)).ok).toBe(true);
  });
});

// #745-T36: the rule for the agent's network (step 7)
describe("the environments repository and the network rule", () => {
  const LIST = {
    mode: "list",
    hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
  } as const;

  // #745-T36
  it("keeps a rule of each mode and reads it back, the hosts in the order they were written", async () => {
    const { a } = await setup();
    const open = await a.create(
      { ...NODE, name: "Open", network: { mode: "open", hosts: [] } },
      50,
    );
    const list = await a.create(
      {
        ...NODE,
        name: "List",
        network: { mode: "list", hosts: [...LIST.hosts] },
      },
      50,
    );
    const off = await a.create({ ...NODE, name: "Off" }, 50);

    expect(open.ok && open.environment.network).toEqual({
      mode: "open",
      hosts: [],
    });
    expect(list.ok && list.environment.network).toEqual(LIST);
    expect(off.ok && off.environment.network).toEqual({
      mode: "off",
      hosts: [],
    });
    expect((await a.get("env-2"))?.network).toEqual(LIST);
    expect(
      (await a.listSummaries()).map((s) => [s.name, s.networkMode]),
    ).toEqual([
      ["List", "list"],
      ["Off", "off"],
      ["Open", "open"],
    ]);
  });

  // #745-T36
  it("changes the rule with the rest of the environment", async () => {
    const { a } = await setup();
    await a.create(
      { ...NODE, network: { mode: "list", hosts: [...LIST.hosts] } },
      50,
    );

    const updated = await a.update("env-1", {
      name: "Node 22",
      vcpus: 4,
      setupScript: "",
      network: { mode: "open", hosts: [] },
    });
    const left = await a.update("env-1", {
      name: "Node 22",
      vcpus: 4,
      setupScript: "",
    });

    expect(updated.ok && updated.environment.network.mode).toBe("open");
    expect(left.ok && left.environment.network).toEqual({
      mode: "off",
      hosts: [],
    });
  });

  // #745-T36
  it("refuses in the database what the app would never write: a list without hosts, hosts without a list, another mode", async () => {
    const { db, a } = await setup();
    await a.create(NODE, 50);
    for (const [mode, hosts] of [
      ["list", ""],
      ["open", "a.example.com"],
      ["off", "a.example.com"],
      ["closed", ""],
      ["list", "x".repeat(25_401)],
    ] as const)
      await expect(
        sql`update implementer_environments set network_mode = ${mode}, network_hosts = ${hosts}`.execute(
          db,
        ),
      ).rejects.toThrow(/implementer_environments_network_check/);
  });
});

describe("the environments of the kind runner (#854)", () => {
  // #854-T231
  it("stores the labels lower case and sorted, with no size, script or network rule, and reads them back", async () => {
    const { a, idA } = await setup();

    const created = await a.create(
      {
        kind: "runner",
        name: "GPU box",
        labels: ["Linux", "gpu", "linux"],
        createdBy: "u-1",
      },
      50,
    );

    expect(created).toMatchObject({
      ok: true,
      environment: {
        workspaceId: idA,
        kind: "runner",
        labels: ["gpu", "linux"],
        vcpus: null,
        setupScript: "",
        network: { mode: "off", hosts: [] },
      },
    });
    expect((await a.list()).map((entry) => [entry.name, entry.kind])).toEqual([
      ["GPU box", "runner"],
    ]);
    expect(await a.listSummaries()).toEqual([
      {
        id: "env-1",
        name: "GPU box",
        kind: "runner",
        labels: ["gpu", "linux"],
        vcpus: null,
        hasScript: false,
        networkMode: "off",
      },
    ]);
  });

  // #854-T232
  it("shares the names, the count and the update with the hosted kind, and one can become the other", async () => {
    const { a } = await setup();
    await a.create(NODE, 50);

    expect(
      await a.create(
        { kind: "runner", name: "node 22", labels: ["x"], createdBy: "u-1" },
        50,
      ),
    ).toEqual({ ok: false, reason: "name_taken" });
    const runner = await a.create(
      { kind: "runner", name: "Box", labels: ["x"], createdBy: "u-1" },
      50,
    );
    if (!runner.ok) throw new Error("seeding failed");

    const toHosted = await a.update(runner.environment.id, {
      name: "Box",
      vcpus: 2,
      setupScript: "echo",
    });
    const toRunner = await a.update("env-1", {
      kind: "runner",
      name: "Node 22",
      labels: ["linux"],
    });

    expect(toHosted).toMatchObject({
      ok: true,
      environment: {
        kind: "hosted",
        vcpus: 2,
        labels: [],
        setupScript: "echo",
      },
    });
    expect(toRunner).toMatchObject({
      ok: true,
      environment: {
        kind: "runner",
        vcpus: null,
        labels: ["linux"],
        setupScript: "",
      },
    });
  });
});
