// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow service with the real repositories on a real Postgres (#833): the validator runs with the workspace's own
// environments, an invalid document is refused with the full list and nothing is stored, every save is a new version, an older
// version stays readable, and a workspace never sees the workflows of another.
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { WorkflowError } from "./errors.ts";
import { createWorkflowService } from "./service.ts";
import { tiny } from "./test-fixtures.ts";

const USER = { id: "u-1" };

async function setup() {
  const { db } = await createTestDatabase();
  await addUser(db, USER.id);
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const serviceFor = (
    workspaceId: string,
    options: { maxBudgetUsd?: number; archivedMax?: number } = {},
  ) =>
    createWorkflowService({
      workflows: createWorkflowsRepository(db, workspaceId),
      environments: createImplementerEnvironmentsRepository(db, workspaceId),
      ...options,
    });
  for (const id of [idA, idB])
    await createImplementerEnvironmentsRepository(db, id).create(
      { name: "node", vcpus: 4, setupScript: "", createdBy: USER.id },
      50,
    );
  return { db, a: serviceFor(idA), b: serviceFor(idB), serviceFor, idA, idB };
}

async function failureOf(promise: Promise<unknown>): Promise<WorkflowError> {
  const reason = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(reason instanceof WorkflowError))
    throw new Error("expected a WorkflowError");
  return reason;
}

describe("the workflow service", () => {
  // #833-M1-T200
  it("validates against the environments of its own workspace and stores nothing", async () => {
    const { a, db, idA } = await setup();
    await createImplementerEnvironmentsRepository(db, idA).create(
      { name: "rust", vcpus: 2, setupScript: "", createdBy: USER.id },
      50,
    );
    const document = tiny();
    (document.steps as Array<Record<string, unknown>>)[0]!.environment = "rust";

    expect((await a.validate(document)).valid).toBe(true);
    (document.steps as Array<Record<string, unknown>>)[0]!.environment = "go";
    const refused = await a.validate(document);

    expect(refused.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/environment",
        code: "environment_unknown",
        available: ["node", "rust"],
      }),
    ]);
    expect((await a.list()).workflows).toEqual([]);
  });

  // #833-M1-T201
  it("does not see the environments of another workspace", async () => {
    const { a, b, db, idB } = await setup();
    await createImplementerEnvironmentsRepository(db, idB).create(
      { name: "only-in-b", vcpus: 2, setupScript: "", createdBy: USER.id },
      50,
    );
    const document = tiny();
    (document.steps as Array<Record<string, unknown>>)[0]!.environment =
      "only-in-b";

    expect((await a.validate(document)).errors[0]?.code).toBe(
      "environment_unknown",
    );
    expect((await b.validate(document)).valid).toBe(true);
  });

  // #833-M1-T202
  it("refuses to save an invalid document with the same errors as validate, and stores nothing", async () => {
    const { a } = await setup();
    const broken = { ...tiny(), version: 3, extra: true };

    const failure = await failureOf(a.create(USER, broken));

    expect(failure.code).toBe("WORKFLOW_INVALID");
    expect(failure.errors).toEqual((await a.validate(broken)).errors);
    expect(failure.errors.map((e) => e.code)).toEqual([
      "unknown_field",
      "invalid_value",
    ]);
    expect((await a.list()).workflows).toEqual([]);
  });

  // #833-M1-T203
  it("saves a valid document as version 1 and reads it back", async () => {
    const { a } = await setup();

    const created = await a.create(USER, tiny());

    expect(created).toMatchObject({
      name: "Tiny",
      version: 1,
      documentVersion: 1,
      document: tiny(),
      versions: [{ version: 1 }],
    });
    expect(await a.get(created.id)).toEqual(created);
    expect((await a.list()).workflows).toMatchObject([
      { id: created.id, name: "Tiny", version: 1 },
    ]);
  });

  // #833-M1-T204
  it("saves every change as a new version and keeps the older ones readable", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    const changed = { ...tiny(), description: "second" };
    const second = await a.update(USER, created.id, changed);
    const third = await a.update(USER, created.id, {
      ...changed,
      description: "third",
    });

    expect(second).toMatchObject({ version: 2, documentVersion: 2 });
    expect(third.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await a.get(created.id)).document).toMatchObject({
      description: "third",
    });
    expect((await a.get(created.id, 1)).document).toEqual(tiny());
    expect(await a.get(created.id, 2)).toMatchObject({
      version: 3,
      documentVersion: 2,
      document: changed,
    });
    expect((await failureOf(a.get(created.id, 9))).code).toBe(
      "WORKFLOW_VERSION_NOT_FOUND",
    );
  });

  // #833-M1-T205
  it("refuses an invalid new version and keeps the current one", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    const failure = await failureOf(
      a.update(USER, created.id, { ...tiny(), steps: [] }),
    );

    expect(failure.code).toBe("WORKFLOW_INVALID");
    expect((await a.get(created.id)).version).toBe(1);
  });

  // #833-M1-T206
  it("takes the name from the document: a rename is a new version, a taken name is refused", async () => {
    const { a } = await setup();
    const one = await a.create(USER, tiny());
    await a.create(USER, { ...tiny(), name: "Other" });

    const renamed = await a.update(USER, one.id, {
      ...tiny(),
      name: "Renamed",
    });
    const clash = await failureOf(
      a.update(USER, one.id, { ...tiny(), name: "other" }),
    );
    const twice = await failureOf(
      a.create(USER, { ...tiny(), name: "RENAMED" }),
    );

    expect(renamed.name).toBe("Renamed");
    expect(clash.code).toBe("WORKFLOW_NAME_TAKEN");
    expect(twice.code).toBe("WORKFLOW_NAME_TAKEN");
  });

  // #833-M1-T207
  it("saves over an expected version only if it is still current", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());
    await a.update(USER, created.id, tiny());

    const stale = await failureOf(a.update(USER, created.id, tiny(), 1));

    expect(stale.code).toBe("WORKFLOW_VERSION_CONFLICT");
    expect(stale.current).toBe(2);
    expect((await a.update(USER, created.id, tiny(), 2)).version).toBe(3);
  });

  // #833-M1-T208
  it("answers 'not found' for an id that does not exist, is empty or is too long", async () => {
    const { a } = await setup();

    for (const id of ["nope", "", "x".repeat(200)]) {
      expect((await failureOf(a.get(id))).code).toBe("WORKFLOW_NOT_FOUND");
      expect((await failureOf(a.update(USER, id, tiny()))).code).toBe(
        "WORKFLOW_NOT_FOUND",
      );
    }
  });

  // #833-M1-T354
  it("archives a workflow: not listed, still readable with its versions, no new version, and its name is free", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());
    await a.update(USER, created.id, tiny());

    const archived = await a.archive(created.id);
    const again = await a.archive(created.id);

    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(again.archivedAt).toBe(archived.archivedAt);
    expect((await a.list()).workflows).toEqual([]);
    const read = await a.get(created.id);
    expect(read.archivedAt).toBe(archived.archivedAt);
    expect(read.versions.map((v) => v.version)).toEqual([2, 1]);
    const refused = await failureOf(a.update(USER, created.id, tiny()));
    expect(refused.code).toBe("WORKFLOW_ARCHIVED");
    const fresh = await a.create(USER, tiny());
    expect(fresh.id).not.toBe(created.id);
    expect(fresh.version).toBe(1);
    expect(fresh.archivedAt).toBeNull();
  });

  // #833-M1-T371
  it("holds the archived workflows to a maximum, so archiving and creating again cannot grow the rows without bound", async () => {
    const { serviceFor, idA } = await setup();
    const a = serviceFor(idA, { archivedMax: 2 });

    for (let round = 0; round < 2; round++)
      await a.archive((await a.create(USER, tiny())).id);
    const third = await a.create(USER, tiny());
    const refused = await failureOf(a.archive(third.id));

    expect(refused.code).toBe("WORKFLOW_ARCHIVE_LIMIT_REACHED");
    expect(refused.maximum).toBe(2);
    expect((await a.get(third.id)).archivedAt).toBeNull();
    // What is archived stays archived when it is asked again, and the live workflow still takes versions and a neighbour.
    expect((await a.update(USER, third.id, tiny())).version).toBe(2);
    expect((await a.create(USER, { ...tiny(), name: "Next" })).version).toBe(1);
  });

  // #833-M1-T372
  it("says in a refused save that the list of errors is cut, as the validate call does", async () => {
    const { a } = await setup();
    const many = (count: number) => ({
      ...tiny(),
      steps: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        kind: "action",
        connector: "nope",
      })),
    });

    const long = await failureOf(a.create(USER, many(300)));
    const short = await failureOf(a.create(USER, many(3)));

    expect(long.code).toBe("WORKFLOW_INVALID");
    expect(long.errors).toHaveLength(200);
    expect(long.truncated).toBe(true);
    expect(short.truncated).toBe(false);
    expect((await a.validate(many(300))).truncated).toBe(true);
  });

  // #833-M1-T355
  it("answers 'not found' when it archives an id that does not exist, is empty, is too long or is another workspace's", async () => {
    const { a, b } = await setup();
    const theirs = await b.create(USER, tiny());

    for (const id of ["nope", "", "x".repeat(200), theirs.id])
      expect((await failureOf(a.archive(id))).code).toBe("WORKFLOW_NOT_FOUND");
    expect((await b.get(theirs.id)).archivedAt).toBeNull();
  });

  // #833-M1-T209
  it("keeps the workflows of two workspaces apart", async () => {
    const { a, b } = await setup();
    const mine = await a.create(USER, tiny());
    const theirs = await b.create(USER, tiny());

    expect(theirs.id).not.toBe(mine.id);
    expect((await a.list()).workflows.map((w) => w.id)).toEqual([mine.id]);
    expect((await failureOf(a.get(theirs.id))).code).toBe("WORKFLOW_NOT_FOUND");
    expect((await failureOf(a.update(USER, theirs.id, tiny()))).code).toBe(
      "WORKFLOW_NOT_FOUND",
    );
    expect((await b.get(theirs.id)).version).toBe(1);
  });

  // #833-M1-T210
  it("holds the budget to the maximum it is given", async () => {
    const { serviceFor, idA } = await setup();
    const document = { ...tiny(), budgetUsd: 30 };

    const failure = await failureOf(
      serviceFor(idA, { maxBudgetUsd: 25 }).create(USER, document),
    );

    expect(failure.errors.map((e) => e.code)).toEqual(["budget_above_maximum"]);
    expect((await serviceFor(idA).create(USER, document)).version).toBe(1);
  });

  // #833-M1-T211
  it("stores the document exactly as it was validated", async () => {
    const { a, db } = await setup();
    const document = { ...tiny(), description: 'Ümlaut ☃ and "quotes"' };

    const created = await a.create(USER, document);

    const row = await db
      .selectFrom("workflow_versions")
      .select("document")
      .where("workflow_id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.document)).toEqual(document);
    expect(created.document).toEqual(document);
  });
});
