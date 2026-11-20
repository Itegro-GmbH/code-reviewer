// SPDX-License-Identifier: LicenseRef-Proprietary

// The workflow service with the real repositories on a real Postgres (#833): the validator runs with the workspace's own
// environments, an invalid document is refused with the full list and nothing is stored, every save is a new version, an older
// version stays readable, and a workspace never sees the workflows of another.
import { describe, expect, it, vi } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createMcpOAuthRepository } from "../db/repositories/mcp-oauth-repository.ts";
import { createMcpServersRepository } from "../db/repositories/mcp-servers-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { seedImplementerRepository } from "../test-support/implementer.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { WORKFLOW_ERROR_STATUS, WorkflowError } from "./errors.ts";
import { createWorkflowService, type WorkflowService } from "./service.ts";
import { effectiveMcpServers } from "./mcp.ts";
import { tiny as bareTiny } from "./test-fixtures.ts";

/** The lane the tests save: a new lane has a description of its own (#1107). */
const tiny = (): ReturnType<typeof bareTiny> => ({
  ...bareTiny(),
  description: "A tiny lane.",
});
/** A save of a new version says what it changes (#1107). */
const change = (
  document: Record<string, unknown>,
  text = "Changed in the test.",
) => ({
  ...document,
  changeDescription: text,
});

const USER = { id: "u-1" };
const PROFILE_CONTENT = {
  description: "",
  model: { entryId: "entry-1" },
  instructions: "",
  costLimitCents: null,
  canPush: true,
  defaultResult: null,
};

async function setup() {
  const { db } = await createTestDatabase();
  await addUser(db, USER.id);
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  // A project in each workspace (#922): a lane belongs to one.
  const projectIds = new Map<string, string>();
  for (const [id, tag] of [
    [idA, "a"],
    [idB, "b"],
  ] as const) {
    const seeded = await seedImplementerRepository(db, id, tag);
    const project = await createProjectsRepository(db, id).get(
      seeded.repositoryId,
    );
    projectIds.set(id, project!.id);
  }
  const rawServiceFor = (
    workspaceId: string,
    options: { maxBudgetUsd?: number; archivedMax?: number } = {},
  ): WorkflowService =>
    createWorkflowService({
      workflows: createWorkflowsRepository(db, workspaceId),
      projects: createProjectsRepository(db, workspaceId),
      environments: createImplementerEnvironmentsRepository(db, workspaceId),
      profiles: createProfilesRepository(db, workspaceId),
      mcpServers: createMcpServersRepository(db, workspaceId),
      mcpOAuth: createMcpOAuthRepository(db, workspaceId),
      ...options,
    });
  /** The service with the project of the workspace filled in for `create` and `list`, as the tests below read. */
  const serviceFor = (
    workspaceId: string,
    options: { maxBudgetUsd?: number; archivedMax?: number } = {},
  ) => {
    const service = rawServiceFor(workspaceId, options);
    const projectId = projectIds.get(workspaceId)!;
    return {
      ...service,
      create: (user: { id: string }, body: unknown) =>
        service.create(user, projectId, body),
      list: () => service.list(projectId),
    };
  };
  for (const id of [idA, idB]) {
    await createImplementerEnvironmentsRepository(db, id).create(
      { name: "node", vcpus: 4, setupScript: "", createdBy: USER.id },
      50,
    );
    // The profile the documents of the tests run (#843): profiles are data, none is built in.
    await createProfilesRepository(db, id).create(
      {
        name: "implementer",
        content: PROFILE_CONTENT,
        createdBy: USER.id,
      },
      100,
    );
  }
  return {
    db,
    a: serviceFor(idA),
    b: serviceFor(idB),
    serviceFor,
    rawServiceFor,
    projectIds,
    idA,
    idB,
  };
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

  // #843-T135
  it("tells a workflow that names an archived profile that it is archived, not that it does not exist", async () => {
    const { a, db, idA } = await setup();
    const profiles = createProfilesRepository(db, idA);
    const created = await profiles.create(
      { name: "retired", content: PROFILE_CONTENT, createdBy: USER.id },
      100,
    );
    if (!created.ok) throw new Error("the profile was not created");
    await profiles.archive(created.profile.id, 50);
    const document = tiny();
    (document.steps as Array<Record<string, unknown>>)[0]!.profile = "retired";

    const refused = await a.validate(document);

    expect(refused.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/profile",
        code: "profile_archived",
        available: ["implementer"],
      }),
    ]);
    const unknown = tiny();
    (unknown.steps as Array<Record<string, unknown>>)[0]!.profile = "never";
    expect((await a.validate(unknown)).errors[0]?.code).toBe("profile_unknown");
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

  // #919-T48
  it("says the environment of a profile version that belongs to another workspace is not in this one", async () => {
    const { a, b, db, idA, idB } = await setup();
    const [foreign] = await createImplementerEnvironmentsRepository(
      db,
      idB,
    ).listSummaries();
    if (foreign === undefined) throw new Error("expected an environment");
    // Seeded directly: the profile service would never save an id that is not one of the workspace.
    const created = await createProfilesRepository(db, idA).create(
      {
        name: "crossed",
        content: { ...PROFILE_CONTENT, environmentId: foreign.id },
        createdBy: USER.id,
      },
      100,
    );
    if (!created.ok) throw new Error("the profile was not created");
    await createProfilesRepository(db, idB).create(
      {
        name: "crossed",
        content: { ...PROFILE_CONTENT, environmentId: foreign.id },
        createdBy: USER.id,
      },
      100,
    );
    const document = tiny();
    const step = (document.steps as Array<Record<string, unknown>>)[0]!;
    step.profile = "crossed";
    delete step.environment;

    const refused = await a.validate(document);

    expect(refused.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/profile",
        code: "environment_unknown",
        available: ["node"],
      }),
    ]);
    // In the workspace the environment belongs to, the same profile is fine.
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
    const second = await a.update(USER, created.id, change(changed));
    const third = await a.update(
      USER,
      created.id,
      change({ ...changed, description: "third" }),
    );

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
      a.update(USER, created.id, change({ ...tiny(), steps: [] })),
    );

    expect(failure.code).toBe("WORKFLOW_INVALID");
    expect((await a.get(created.id)).version).toBe(1);
  });

  // #833-M1-T206
  it("takes the name from the document: a rename is a new version, a taken name is refused", async () => {
    const { a } = await setup();
    const one = await a.create(USER, tiny());
    await a.create(USER, { ...tiny(), name: "Other" });

    const renamed = await a.update(
      USER,
      one.id,
      change({ ...tiny(), name: "Renamed" }),
    );
    const clash = await failureOf(
      a.update(USER, one.id, change({ ...tiny(), name: "other" })),
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
    await a.update(USER, created.id, change(tiny()));

    const stale = await failureOf(
      a.update(USER, created.id, change(tiny()), 1),
    );

    expect(stale.code).toBe("WORKFLOW_VERSION_CONFLICT");
    expect(stale.current).toBe(2);
    expect((await a.update(USER, created.id, change(tiny()), 2)).version).toBe(
      3,
    );
  });

  // #833-M1-T208
  it("answers 'not found' for an id that does not exist, is empty or is too long", async () => {
    const { a } = await setup();

    for (const id of ["nope", "", "x".repeat(200)]) {
      expect((await failureOf(a.get(id))).code).toBe("WORKFLOW_NOT_FOUND");
      expect((await failureOf(a.update(USER, id, change(tiny())))).code).toBe(
        "WORKFLOW_NOT_FOUND",
      );
    }
  });

  // #833-M1-T354
  it("archives a workflow: not listed, still readable with its versions, no new version, and its name is free", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());
    await a.update(USER, created.id, change(tiny()));

    const archived = await a.archive(created.id);
    const again = await a.archive(created.id);

    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(again.archivedAt).toBe(archived.archivedAt);
    expect((await a.list()).workflows).toEqual([]);
    const read = await a.get(created.id);
    expect(read.archivedAt).toBe(archived.archivedAt);
    expect(read.versions.map((v) => v.version)).toEqual([2, 1]);
    const refused = await failureOf(a.update(USER, created.id, change(tiny())));
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
    expect((await a.update(USER, third.id, change(tiny()))).version).toBe(2);
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
    expect(
      (await failureOf(a.update(USER, theirs.id, change(tiny())))).code,
    ).toBe("WORKFLOW_NOT_FOUND");
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

  // #922-T10
  it("lists and creates lanes within a project, and refuses a missing or foreign project naming the ones there are", async () => {
    const { rawServiceFor, projectIds, idA, idB } = await setup();
    const service = rawServiceFor(idA);
    const mine = projectIds.get(idA)!;

    const missing = await failureOf(service.list(undefined));
    const foreign = await failureOf(
      service.create(USER, projectIds.get(idB), tiny()),
    );

    expect(missing.code).toBe("WORKFLOW_PROJECT_REQUIRED");
    expect(missing.issues).toEqual([
      expect.objectContaining({
        path: "projectId",
        code: "project_required",
        available: [mine],
      }),
    ]);
    expect(foreign.code).toBe("WORKFLOW_PROJECT_NOT_FOUND");
    expect(foreign.issues).toEqual([
      expect.objectContaining({ code: "project_unknown", available: [mine] }),
    ]);
    expect((await service.list(mine)).workflows).toEqual([]);
    expect((await service.create(USER, mine, tiny())).projectId).toBe(mine);
    expect(
      (await service.list(mine)).workflows.map((w) => w.projectId),
    ).toEqual([mine]);
  });

  // #922-T11
  it("takes no lane in a project that is switched off", async () => {
    const { rawServiceFor, projectIds, db, idA } = await setup();
    const mine = projectIds.get(idA)!;
    const projects = createProjectsRepository(db, idA);
    const project = await db
      .selectFrom("projects")
      .select("repository_id")
      .where("id", "=", mine)
      .executeTakeFirstOrThrow();
    await projects.deactivate(project.repository_id);

    const failure = await failureOf(
      rawServiceFor(idA).create(USER, mine, tiny()),
    );

    expect(failure.code).toBe("WORKFLOW_PROJECT_INACTIVE");
  });

  // #922-T12
  it("holds a name once per project, not once per workspace", async () => {
    const { rawServiceFor, projectIds, db, idA } = await setup();
    const service = rawServiceFor(idA);
    const first = { id: projectIds.get(idA)! };
    // A second repository of the workspace, with a project of its own.
    const integration = await createIntegrationsRepository(db, idA).create({
      type: "github_app",
      displayName: "acme-second",
      externalId: "installation-second",
      config: {},
    });
    const repositories = createRepositoriesRepository(db, idA);
    await repositories.reconcile(integration.id, [
      {
        integrationId: integration.id,
        externalId: "repo-second",
        fullName: "acme/second",
        url: "https://github.test/acme/second",
      },
    ]);
    const repository = (await repositories.list()).find(
      (candidate) => candidate.fullName === "acme/second",
    )!;
    const activated = await createProjectsRepository(db, idA).activate(
      repository.id,
    );
    if (activated.kind !== "activated") throw new Error("seeding failed");
    const second = activated.project;

    await service.create(USER, first.id, tiny());
    const again = await failureOf(service.create(USER, first.id, tiny()));
    const other = await service.create(USER, second.id, tiny());

    expect(again.code).toBe("WORKFLOW_NAME_TAKEN");
    expect(other.projectId).toBe(second.id);
    expect((await service.list(second.id)).workflows).toHaveLength(1);
  });

  // #922-T13
  it("copies built-in lanes into a project and reports the ones that do not pass", async () => {
    const { rawServiceFor, projectIds, db, idA } = await setup();
    const service = rawServiceFor(idA);
    const mine = projectIds.get(idA)!;
    // The profiles of the built-ins: `implementer` exists (setup), `reviewer` does not.
    const results = await service.copyBuiltIn(USER, mine, [
      "issue-to-pr",
      "review-a-pull-request",
    ]);

    expect(results.map((r) => [r.key, r.ok])).toEqual([
      ["issue-to-pr", false],
      ["review-a-pull-request", false],
    ]);
    expect(
      results.flatMap((r) => (r.ok ? [] : r.errors.map((e) => e.code))),
    ).toContain("profile_unknown");

    await createProfilesRepository(db, idA).create(
      { name: "reviewer", content: PROFILE_CONTENT, createdBy: USER.id },
      100,
    );
    const copied = await service.copyBuiltIn(USER, mine, [
      "issue-to-pr",
      "review-a-pull-request",
    ]);
    const twice = await service.copyBuiltIn(USER, mine, ["issue-to-pr"]);

    expect(copied.map((r) => [r.key, r.ok])).toEqual([
      ["issue-to-pr", true],
      ["review-a-pull-request", true],
    ]);
    expect(
      (await service.list(mine)).workflows.map((w) => w.name).sort(),
    ).toEqual(["Issue to PR", "Review a pull request"]);
    expect(twice[0]).toMatchObject({ ok: false, code: "WORKFLOW_NAME_TAKEN" });
  });

  // #937 (from the re-review of #936)
  it("reports a database error on the second built-in lane as that lane's failure only, and the first stays saved", async () => {
    const { db, idA, projectIds } = await setup();
    await createProfilesRepository(db, idA).create(
      { name: "reviewer", content: PROFILE_CONTENT, createdBy: USER.id },
      100,
    );
    const real = createWorkflowsRepository(db, idA);
    let creates = 0;
    const service = createWorkflowService({
      workflows: {
        ...real,
        create: (input, maximum) => {
          creates += 1;
          if (creates === 2)
            return Promise.reject(
              Object.assign(new Error("connection lost"), { code: "08006" }),
            );
          return real.create(input, maximum);
        },
      },
      projects: createProjectsRepository(db, idA),
      environments: createImplementerEnvironmentsRepository(db, idA),
      profiles: createProfilesRepository(db, idA),
    });
    const mine = projectIds.get(idA)!;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await service.copyBuiltIn(USER, mine, [
      "issue-to-pr",
      "review-a-pull-request",
    ]);

    expect(results[0]).toMatchObject({ key: "issue-to-pr", ok: true });
    expect(results[1]).toMatchObject({
      key: "review-a-pull-request",
      ok: false,
      code: "LANE_COPY_FAILED",
    });
    expect((await service.list(mine)).workflows.map((w) => w.name)).toEqual([
      "Issue to PR",
    ]);
    // The lane and the code of the error are logged, never its text.
    expect(quiet).toHaveBeenCalledWith(
      "[workflows] copying the built-in lane review-a-pull-request failed (08006)",
    );
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("connection lost");
    quiet.mockRestore();
  });
});

const MCP_SERVER = (id: string, name: string) => ({
  id,
  name,
  transport: "streamable-http",
  url: `https://mcp.example.com/${name}`,
  authKind: "none",
  headerNames: [],
  sealed: null,
  createdBy: null,
});

function withMcp(lane: unknown, step?: unknown): Record<string, unknown> {
  const document = tiny();
  if (lane !== undefined) document.mcp = lane;
  if (step !== undefined)
    (document.steps as Array<Record<string, unknown>>)[0]!.mcp = step;
  return document;
}

describe("a lane that names MCP servers (#1052)", () => {
  async function withServers() {
    const fixture = await setup();
    const { db, idA, idB } = fixture;
    const mine = createMcpServersRepository(db, idA);
    const theirs = createMcpServersRepository(db, idB);
    await mine.create(MCP_SERVER("srv-github", "github"), 50);
    await mine.create(MCP_SERVER("srv-linear", "linear"), 50);
    await theirs.create(MCP_SERVER("srv-foreign", "foreign"), 50);
    return { ...fixture, mine };
  }

  // #1052-T01
  it("saves a lane with two servers and a step narrowed to one, and the stored document gives the step that one", async () => {
    const { a } = await withServers();

    const saved = await a.create(
      USER,
      withMcp(["srv-github", "srv-linear"], ["srv-linear"]),
    );

    expect(saved.document).toMatchObject({ mcp: ["srv-github", "srv-linear"] });
    expect(effectiveMcpServers(saved.document, "work")).toEqual(["srv-linear"]);
    // The next version may change the list.
    const next = await a.update(
      USER,
      saved.id,
      change(withMcp(["srv-github", "srv-linear"], [])),
      1,
    );
    expect(effectiveMcpServers(next.document, "work")).toEqual([]);
  });

  // #1052-T02
  it("refuses a server of another workspace like one that never existed, stores nothing, and names the place", async () => {
    const { a } = await withServers();

    for (const id of ["srv-foreign", "srv-nowhere"]) {
      const refused = await failureOf(
        a.create(USER, withMcp(["srv-github", id])),
      );

      expect(refused.code).toBe("WORKFLOW_INVALID");
      expect(refused.errors).toEqual([
        expect.objectContaining({
          path: "/mcp/1",
          code: "mcp_server_unknown",
          available: ["srv-github", "srv-linear"],
        }),
      ]);
      // The answer echoes what was written and names only this workspace's servers, never the other's.
      expect(JSON.stringify(refused.errors)).not.toContain("'foreign'");
    }
    expect((await a.list()).workflows).toEqual([]);
  });

  // #1052-T02
  it("refuses a step that names a server its lane does not, also on a new version", async () => {
    const { a } = await withServers();
    const saved = await a.create(USER, withMcp(["srv-github"]));

    const refused = await failureOf(
      a.update(
        USER,
        saved.id,
        change(withMcp(["srv-github"], ["srv-linear"])),
        1,
      ),
    );

    expect(refused.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/mcp/0",
        code: "mcp_server_not_in_lane",
      }),
    ]);
    expect((await a.get(saved.id)).version).toBe(1);
  });

  // #1052-T02
  it("says a broken server is broken and still saves", async () => {
    const { a, mine } = await withServers();
    const server = await mine.get("srv-github");
    await mine.recordTest("srv-github", server!.revision, {
      ok: false,
      code: "mcp_test_timeout",
    });

    const checked = await a.validate(withMcp(["srv-github"]));
    const saved = await a.create(USER, withMcp(["srv-github"]));

    expect(checked.valid).toBe(true);
    expect(checked.warnings).toEqual([
      expect.objectContaining({ path: "/mcp/0", code: "mcp_server_broken" }),
    ]);
    expect(saved.version).toBe(1);
  });

  // #1051-T02
  it("warns about an OAuth server that is not connected or whose grant ended, and still saves", async () => {
    const { a, db, idA } = await withServers();
    const mine = createMcpServersRepository(db, idA);
    await mine.create(
      { ...MCP_SERVER("srv-oauth", "oauth"), authKind: "oauth" },
      50,
    );

    const waiting = await a.validate(withMcp(["srv-oauth"]));
    expect(waiting.valid).toBe(true);
    expect(waiting.warnings).toEqual([
      expect.objectContaining({ path: "/mcp/0", code: "mcp_server_broken" }),
    ]);

    await createMcpOAuthRepository(db, idA).saveConnection("srv-oauth", 1, {
      discovery: {
        resource: "https://mcp.example.com/oauth",
        issuer: "https://as.example.com",
        authorizationEndpoint: "https://as.example.com/authorize",
        tokenEndpoint: "https://as.example.com/token",
        registrationEndpoint: null,
        scopes: [],
        issParameter: false,
        authMethods: [],
      },
      client: {
        source: "dynamic",
        clientId: "c",
        authMethod: "none",
        sealedSecret: null,
        registeredIssuer: "https://as.example.com",
        registeredRedirectUri: "https://factory.example.test/cb",
      },
      sealedTokens: { ciphertext: "c", nonce: "n", keyVersion: 1 },
      accessExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      scopes: [],
      connectedBy: null,
    });
    expect((await a.validate(withMcp(["srv-oauth"]))).warnings).toBeUndefined();

    await createMcpOAuthRepository(db, idA).withLockedTokens(
      "srv-oauth",
      (locked, writes) =>
        writes.markBroken(
          locked?.tokenVersion ?? 0,
          "mcp_oauth_refresh_refused",
        ),
    );
    const ended = await a.validate(withMcp(["srv-oauth"]));
    expect(ended.valid).toBe(true);
    expect(ended.warnings).toEqual([
      expect.objectContaining({ path: "/mcp/0", code: "mcp_server_broken" }),
    ]);
    expect((await a.create(USER, withMcp(["srv-oauth"]))).version).toBe(1);
  });

  // #1052 (follow-up of #1050)
  it("refuses a save when the server was removed after the check and before the commit, and stores nothing", async () => {
    const { db, idA, mine } = await withServers();
    const racing = {
      // Reads the servers, then the server goes: the validator saw it, the save must not.
      list: async () => {
        const listed = await mine.list();
        await mine.removeUnlessUsed("srv-linear");
        return listed;
      },
    };
    const service = createWorkflowService({
      workflows: createWorkflowsRepository(db, idA),
      projects: createProjectsRepository(db, idA),
      environments: createImplementerEnvironmentsRepository(db, idA),
      profiles: createProfilesRepository(db, idA),
      mcpServers: racing,
    });
    const projectId = (await createProjectsRepository(db, idA).list())[0]!
      .project!.id;

    const refused = await failureOf(
      service.create(USER, projectId, withMcp(["srv-linear"])),
    );

    expect(refused.errors).toEqual([
      expect.objectContaining({ path: "/mcp/0", code: "mcp_server_unknown" }),
    ]);
    expect((await service.list(projectId)).workflows).toEqual([]);
  });

  // #1052-T03
  it("leaves a lane without `mcp` as it was: it saves and runs with or without a registry of servers", async () => {
    const { a, db, idA } = await withServers();
    const bare = createWorkflowService({
      workflows: createWorkflowsRepository(db, idA),
      projects: createProjectsRepository(db, idA),
      environments: createImplementerEnvironmentsRepository(db, idA),
      profiles: createProfilesRepository(db, idA),
    });

    const saved = await a.create(USER, tiny());

    expect(saved.document).not.toHaveProperty("mcp");
    expect((await bare.validate(tiny())).valid).toBe(true);
    // A lane that names a server cannot be saved where no registry is wired: it fails closed.
    expect((await bare.validate(withMcp(["srv-github"]))).errors).toEqual([
      expect.objectContaining({ code: "mcp_server_unknown" }),
    ]);
  });
});

describe("the change description of a version (#1107)", () => {
  // #1107-T01
  it("refuses a new version without a change description, with 422, and writes no version", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    const failure = await failureOf(a.update(USER, created.id, tiny()));

    expect(failure.code).toBe("WORKFLOW_CHANGE_DESCRIPTION_REQUIRED");
    expect(WORKFLOW_ERROR_STATUS[failure.code]).toBe(422);
    expect((await a.get(created.id)).version).toBe(1);
  });

  // #1107-T02
  it("refuses a change description that is blank, not a text or longer than 1,000 characters", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    for (const bad of ["", "   \n\t ", 7, null, ["x"], "x".repeat(1001)]) {
      const failure = await failureOf(
        a.update(USER, created.id, { ...tiny(), changeDescription: bad }),
      );
      expect(failure.code).toBe("WORKFLOW_CHANGE_DESCRIPTION_REQUIRED");
    }
    expect((await a.get(created.id)).version).toBe(1);
    // The longest allowed text is saved.
    const longest = await a.update(
      USER,
      created.id,
      change(tiny(), "x".repeat(1000)),
    );
    expect(longest.versions[0]?.changeDescription).toBe("x".repeat(1000));
  });

  // #1107-T03
  it("stores the change description with the version and lists it with the author, and keeps it out of the document", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    const second = await a.update(
      USER,
      created.id,
      change(
        { ...tiny(), description: "Second." },
        "  Reworded the description.  ",
      ),
    );

    expect(second.versions).toEqual([
      expect.objectContaining({
        version: 2,
        savedBy: USER.id,
        changeDescription: "Reworded the description.",
      }),
      expect.objectContaining({
        version: 1,
        savedBy: USER.id,
        changeDescription: null,
      }),
    ]);
    expect(second.document).not.toHaveProperty("changeDescription");
    expect((await a.get(created.id, 2)).document).not.toHaveProperty(
      "changeDescription",
    );
    expect((await a.get(created.id)).versions[0]?.changeDescription).toBe(
      "Reworded the description.",
    );
  });

  // #1107-T04
  it("still refuses an invalid document first by its own errors when the change description is there", async () => {
    const { a } = await setup();
    const created = await a.create(USER, tiny());

    const failure = await failureOf(
      a.update(USER, created.id, change({ ...tiny(), steps: [] })),
    );

    expect(failure.code).toBe("WORKFLOW_INVALID");
  });

  // #1107-T05
  it("does not take a change description on create: version 1 has the lane's description", async () => {
    const { a } = await setup();

    const failure = await failureOf(
      a.create(USER, { ...tiny(), changeDescription: "First." }),
    );

    expect(failure.code).toBe("WORKFLOW_INVALID");
    expect(failure.errors).toEqual([
      expect.objectContaining({
        path: "/changeDescription",
        code: "unknown_field",
      }),
    ]);
  });

  // #1107-T06
  it("refuses a new lane without a description, or with a blank one, and names the field", async () => {
    const { a } = await setup();
    const without: Record<string, unknown> = { ...tiny() };
    delete without.description;

    for (const document of [without, { ...tiny(), description: "  " }]) {
      const failure = await failureOf(a.create(USER, document));
      expect(failure.code).toBe("WORKFLOW_INVALID");
      expect(failure.errors).toEqual([
        expect.objectContaining({
          path: "/description",
          code: "missing_field",
        }),
      ]);
    }
    expect((await a.list()).workflows).toEqual([]);
  });

  // #1107-T07
  it("refuses a new lane without a project and one for another workspace's project", async () => {
    const { rawServiceFor, idA, projectIds, idB } = await setup();
    const service = rawServiceFor(idA);

    const none = await failureOf(service.create(USER, undefined, tiny()));
    const blank = await failureOf(service.create(USER, "", tiny()));
    const foreign = await failureOf(
      service.create(USER, projectIds.get(idB), tiny()),
    );

    expect(none.code).toBe("WORKFLOW_PROJECT_REQUIRED");
    expect(blank.code).toBe("WORKFLOW_PROJECT_REQUIRED");
    expect(foreign.code).toBe("WORKFLOW_PROJECT_NOT_FOUND");
  });
});
