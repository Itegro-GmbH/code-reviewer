// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflows of a workspace (#833) against a real Postgres: what the repository keeps true (a name once per workspace whatever
// its case, a bounded count, every save a new immutable version, the next number never taken twice, nothing across workspaces).
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createWorkflowsRepository } from "./workflows-repository.ts";
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
  const newId = () => `wf-${++counter}`;
  return {
    db,
    a: createWorkflowsRepository(db, idA, { now, newId }),
    b: createWorkflowsRepository(db, idB, { now, newId }),
    idA,
    idB,
  };
}

const DOC = '{"version":1,"name":"Issue to PR"}';
const NEW = { name: "Issue to PR", document: DOC, createdBy: "u-1" };

describe("the workflows repository", () => {
  // #833-M1-T140
  it("creates a workflow as version 1 and reads it back with its document as it was written", async () => {
    const { a, idA } = await setup();

    const created = await a.create({ ...NEW, document: '{ "x" :  1 }' }, 100);

    expect(created).toEqual({
      ok: true,
      workflow: {
        id: "wf-1",
        workspaceId: idA,
        name: "Issue to PR",
        version: 1,
        createdBy: "u-1",
        createdAt: "2026-11-04T08:00:00.000Z",
        updatedAt: "2026-11-04T08:00:00.000Z",
        archivedAt: null,
      },
      saved: {
        workflowId: "wf-1",
        version: 1,
        document: '{ "x" :  1 }',
        createdBy: "u-1",
        createdAt: "2026-11-04T08:00:00.000Z",
      },
    });
    expect(await a.get("wf-1")).toEqual({
      workflow: created.ok ? created.workflow : undefined,
      current: created.ok ? created.saved : undefined,
    });
  });

  // #833-M1-T141
  it("lists the workflows by name, ignoring case, without documents", async () => {
    const { a } = await setup();
    for (const name of ["pipeline", "Build", "deploy"])
      await a.create({ ...NEW, name }, 100);

    expect((await a.list()).map((workflow) => workflow.name)).toEqual([
      "Build",
      "deploy",
      "pipeline",
    ]);
  });

  // #833-M1-T142
  it("keeps a name once per workspace whatever its case, and allows it in another workspace", async () => {
    const { a, b } = await setup();
    await a.create({ ...NEW, name: "Issue to PR" }, 100);

    expect(await a.create({ ...NEW, name: "issue to pr" }, 100)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await b.create({ ...NEW, name: "Issue to PR" }, 100)).ok).toBe(
      true,
    );
    expect(await a.list()).toHaveLength(1);
  });

  // #833-M1-T143
  it("refuses a workflow over the maximum, counted with the new one", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "one" }, 2);
    await a.create({ ...NEW, name: "two" }, 2);

    expect(await a.create({ ...NEW, name: "three" }, 2)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
  });

  // #833-M1-T144
  it("does not let two creators take the last place", async () => {
    const { a } = await setup();

    const results = await Promise.all(
      ["one", "two", "three", "four"].map((name) =>
        a.create({ ...NEW, name }, 1),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await a.list()).toHaveLength(1);
  });

  // #833-M1-T145
  it("saves a new version each time, makes it current and keeps the old ones as they were", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);

    const second = await a.saveVersion(
      "wf-1",
      { name: "Issue to PR 2", document: '{"v":2}', createdBy: "u-2" },
      200,
    );
    const third = await a.saveVersion(
      "wf-1",
      { name: "Issue to PR 2", document: '{"v":3}', createdBy: "u-1" },
      200,
    );

    expect(second).toMatchObject({
      ok: true,
      workflow: { name: "Issue to PR 2", version: 2, createdBy: "u-1" },
      saved: { version: 2, createdBy: "u-2" },
    });
    expect(third).toMatchObject({ ok: true, workflow: { version: 3 } });
    expect((await a.get("wf-1"))?.current.document).toBe('{"v":3}');
    expect((await a.getVersion("wf-1", 1))?.document).toBe(DOC);
    expect((await a.getVersion("wf-1", 2))?.document).toBe('{"v":2}');
    expect((await a.listVersions("wf-1")).map((v) => v.version)).toEqual([
      3, 2, 1,
    ]);
  });

  // #833-M1-T146
  it("saves identical text again as a new version", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);

    const again = await a.saveVersion("wf-1", NEW, 200);

    expect(again).toMatchObject({
      ok: true,
      saved: { version: 2, document: DOC },
    });
  });

  // #833-M1-T147
  it("takes the next number once when writers race", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        a.saveVersion("wf-1", { ...NEW, document: `{"n":${i}}` }, 200),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect((await a.listVersions("wf-1")).map((v) => v.version).sort()).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
  });

  // #833-M1-T148
  it("refuses to save over a version that is no longer current, and says which is", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);
    await a.saveVersion("wf-1", NEW, 200);

    expect(
      await a.saveVersion("wf-1", { ...NEW, expectedVersion: 1 }, 200),
    ).toEqual({
      ok: false,
      reason: "version_conflict",
      current: 2,
    });
    expect(
      (await a.saveVersion("wf-1", { ...NEW, expectedVersion: 2 }, 200)).ok,
    ).toBe(true);
  });

  // #833-M1-T149
  it("refuses a version over the maximum", async () => {
    const { a } = await setup();
    await a.create(NEW, 100);
    await a.saveVersion("wf-1", NEW, 2);

    expect(await a.saveVersion("wf-1", NEW, 2)).toEqual({
      ok: false,
      reason: "version_limit_reached",
    });
  });

  // #833-M1-T350
  it("archives a workflow: hidden from the list, readable with its versions, archived once however often it is asked", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "Keep" }, 100);
    await a.create({ ...NEW, name: "Old" }, 100);
    await a.saveVersion("wf-2", { ...NEW, name: "Old" }, 100);

    const archived = await a.archive("wf-2");
    const again = await a.archive("wf-2");

    expect(archived).toEqual({
      ok: true,
      workflow: expect.objectContaining({
        id: "wf-2",
        archivedAt: expect.any(String),
      }),
    });
    expect(again).toEqual(archived);
    expect((await a.list()).map((workflow) => workflow.name)).toEqual(["Keep"]);
    expect((await a.get("wf-2"))?.workflow.archivedAt).toBe(
      archived.ok ? archived.workflow.archivedAt : undefined,
    );
    expect((await a.listVersions("wf-2")).map((v) => v.version)).toEqual([
      2, 1,
    ]);
    expect((await a.getVersion("wf-2", 1))?.document).toBe(DOC);
    expect((await a.get("wf-1"))?.workflow.archivedAt).toBeNull();
  });

  // #833-M1-T351
  it("does not count an archived workflow, and gives its name back", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "Flow" }, 1);
    await a.archive("wf-1");

    const next = await a.create({ ...NEW, name: "flow" }, 1);

    expect(next.ok).toBe(true);
    expect(await a.create({ ...NEW, name: "third" }, 1)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect(await a.create({ ...NEW, name: "FLOW" }, 5)).toEqual({
      ok: false,
      reason: "name_taken",
    });
  });

  // #833-M1-T352
  it("saves no new version of an archived workflow, and a name taken by an archived one is free for a rename", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "One" }, 100);
    await a.create({ ...NEW, name: "Two" }, 100);
    await a.archive("wf-1");

    expect(await a.saveVersion("wf-1", { ...NEW, name: "One" }, 100)).toEqual({
      ok: false,
      reason: "archived",
    });
    expect((await a.saveVersion("wf-2", { ...NEW, name: "one" }, 100)).ok).toBe(
      true,
    );
  });

  // #833-M1-T353
  it("says not_found when it archives an id that is not there or belongs to another workspace", async () => {
    const { a, b } = await setup();
    await b.create({ ...NEW, name: "Theirs" }, 100);

    expect(await a.archive("nope")).toEqual({ ok: false, reason: "not_found" });
    expect(await a.archive("wf-1")).toEqual({ ok: false, reason: "not_found" });
    expect((await b.get("wf-1"))?.workflow.archivedAt).toBeNull();
  });

  // #833-M1-T150
  it("refuses a rename to the name of another workflow, and keeps its own name case-insensitively", async () => {
    const { a } = await setup();
    await a.create({ ...NEW, name: "one" }, 100);
    await a.create({ ...NEW, name: "two" }, 100);

    expect(await a.saveVersion("wf-1", { ...NEW, name: "TWO" }, 200)).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect((await a.saveVersion("wf-1", { ...NEW, name: "ONE" }, 200)).ok).toBe(
      true,
    );
    expect((await a.listVersions("wf-1")).map((v) => v.version)).toEqual([
      2, 1,
    ]);
  });

  // #833-M1-T151
  it("says not_found for an id that is not there", async () => {
    const { a } = await setup();

    expect(await a.saveVersion("nope", NEW, 200)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await a.get("nope")).toBeUndefined();
    expect(await a.getVersion("nope", 1)).toBeUndefined();
    expect(await a.listVersions("nope")).toEqual([]);
  });

  // #833-M1-T152
  it("refuses in the database to change a saved version or to leave a version number out", async () => {
    const { a, db } = await setup();
    await a.create(NEW, 100);

    await expect(
      sql`update workflow_versions set document = '{}' where workflow_id = 'wf-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`update workflow_versions set version = 7 where workflow_id = 'wf-1'`.execute(
        db,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
        select id, 0, workspace_id, '{}', 'u-1', 'x' from workflows`.execute(
        db,
      ),
    ).rejects.toThrow(/workflow_versions_version_check/);
  });

  // #833-M1-T153
  it("bounds the size of a document in the database", async () => {
    const { a } = await setup();

    await expect(
      a.create({ ...NEW, document: "x".repeat(262145) }, 100),
    ).rejects.toThrow(/workflow_versions_document_check/);
  });
});
