// SPDX-License-Identifier: LicenseRef-Proprietary

// The environments of the Implementer (#818) against a real Postgres: what the repository keeps true (a name once per
// workspace whatever its case, a bounded count, stored text as it is, nothing across workspaces).
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
        vcpus: 4,
        setupScript: "  npm ci\r\n\tnpm run build  \n",
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
