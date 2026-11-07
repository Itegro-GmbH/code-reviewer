// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the project service on a real Postgres database: activating and deactivating by repository id,
// the stable error codes of a refusal, the hook that lets the jobs module discard waiting jobs in the
// deactivation's transaction, and the lookups the webhook intake and the list use.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { RepoRef } from "../integrations/types.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { ProjectError } from "./errors.ts";
import { noopProjectHooks, type ProjectHooks } from "./hooks.ts";
import { createProjectService } from "./service.ts";
import { defaultWorkspaceId } from "../test-support/workspaces.ts";

async function setup(hooks?: ProjectHooks) {
  const { db } = await createTestDatabase();
  const integration = await createIntegrationsRepository(
    db,
    await defaultWorkspaceId(db),
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    db,
    await defaultWorkspaceId(db),
  );
  const remote = (id: number): RepoRef => ({
    integrationId: integration.id,
    externalId: String(id),
    fullName: `acme/repo-${id}`,
    url: `https://github.test/acme/repo-${id}`,
  });
  await repositories.reconcile(integration.id, [remote(1), remote(2)]);
  const [first, second] = await repositories.list();
  if (first === undefined || second === undefined)
    throw new Error("seeding failed");
  const projects = createProjectsRepository(db, await defaultWorkspaceId(db));
  return {
    db,
    integration,
    repositories,
    remote,
    first,
    second,
    projects,
    service: createProjectService({ projects, hooks }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProjectError) return error.code;
    throw error;
  }
  throw new Error("expected a ProjectError");
}

describe("activating a project", () => {
  // CR-24-T01
  it("makes the repository an active project", async () => {
    const { service, first } = await setup();

    const result = await service.activateProject(first.id);

    expect(result).toMatchObject({
      outcome: "created",
      project: { repositoryId: first.id, active: true },
    });
    expect(await service.getActiveProjectForRepository(first.id)).toMatchObject(
      { id: result.project.id },
    );
  });

  // CR-24-T07
  it("answers a second activation with the same project and says nothing changed", async () => {
    const { service, first } = await setup();
    const one = await service.activateProject(first.id);

    const two = await service.activateProject(first.id);

    expect(two.project.id).toBe(one.project.id);
    expect(two.outcome).toBe("unchanged");
  });

  // CR-24-T08
  it("refuses a repository the platform no longer lists with a stable code", async () => {
    const { service, first, repositories, integration, remote } = await setup();
    await repositories.reconcile(integration.id, [remote(2)]);

    expect(await codeOf(service.activateProject(first.id))).toBe(
      "PROJECT_REPOSITORY_UNAVAILABLE",
    );
    expect(
      await service.getActiveProjectForRepository(first.id),
    ).toBeUndefined();
  });

  // CR-24-T08
  it("refuses a repository whose installation is suspended with a stable code", async () => {
    const { service, first, db, integration } = await setup();
    await createIntegrationsRepository(
      db,
      await defaultWorkspaceId(db),
    ).setStatus(integration.id, "disabled");

    expect(await codeOf(service.activateProject(first.id))).toBe(
      "PROJECT_INTEGRATION_UNAVAILABLE",
    );
    expect(await db.selectFrom("projects").selectAll().execute()).toEqual([]);
  });

  // CR-24-T09
  it("refuses an unknown repository id with a stable code", async () => {
    const { service, projects } = await setup();

    expect(await codeOf(service.activateProject("no-such-repository"))).toBe(
      "PROJECT_REPOSITORY_NOT_FOUND",
    );
    expect(await projects.list()).toHaveLength(2);
    expect(
      (await projects.list()).every((entry) => entry.project === null),
    ).toBe(true);
  });

  it("refuses an id that cannot be one without looking it up", async () => {
    const { service } = await setup();

    for (const bad of ["", " ", "x".repeat(200), 42, null, undefined])
      expect(
        await codeOf(service.activateProject(bad as unknown as string)),
      ).toBe("PROJECT_REQUEST_INVALID");
  });
});

describe("deactivating a project", () => {
  // CR-24-T02
  it("switches it off and tells the hook which project it was, in the same transaction", async () => {
    const calls: Array<{
      projectId: string;
      repositoryId: string;
      inTransaction: boolean;
    }> = [];
    const hooks: ProjectHooks = {
      async onProjectDeactivated(event, executor) {
        calls.push({ ...event, inTransaction: executor.isTransaction });
      },
    };
    const { service, first } = await setup(hooks);
    const activated = await service.activateProject(first.id);

    const result = await service.deactivateProject(first.id);

    expect(result).toMatchObject({
      changed: true,
      project: { id: activated.project.id, active: false },
    });
    expect(calls).toEqual([
      {
        projectId: activated.project.id,
        repositoryId: first.id,
        inTransaction: true,
      },
    ]);
    expect(
      await service.getActiveProjectForRepository(first.id),
    ).toBeUndefined();
  });

  it("keeps the project active when the hook fails", async () => {
    const { service, first } = await setup({
      async onProjectDeactivated() {
        throw new Error("waiting jobs could not be discarded");
      },
    });
    await service.activateProject(first.id);

    await expect(service.deactivateProject(first.id)).rejects.toThrow(
      "waiting jobs could not be discarded",
    );

    expect(await service.getActiveProjectForRepository(first.id)).toMatchObject(
      { active: true },
    );
  });

  it("does nothing, and tells no hook, for a repository without a project", async () => {
    let called = 0;
    const { service, first } = await setup({
      async onProjectDeactivated() {
        called++;
      },
    });

    const result = await service.deactivateProject(first.id);

    expect(result).toEqual({ project: undefined, changed: false });
    expect(called).toBe(0);
  });

  it("has a default hook that does nothing", async () => {
    const { service, first } = await setup();
    await service.activateProject(first.id);

    const result = await service.deactivateProject(first.id);

    expect(result.changed).toBe(true);
    await expect(
      noopProjectHooks.onProjectDeactivated(
        { projectId: "p", repositoryId: "r" },
        (await setup()).db,
      ),
    ).resolves.toBeUndefined();
  });

  // CR-24-T09
  it("refuses an unknown repository id with a stable code", async () => {
    const { service } = await setup();

    expect(await codeOf(service.deactivateProject("no-such-repository"))).toBe(
      "PROJECT_REPOSITORY_NOT_FOUND",
    );
  });
});

describe("the lookups", () => {
  // CR-24-T03
  it("finds no active project for a repository without one", async () => {
    const { service, integration, second } = await setup();

    expect(
      await service.getActiveProjectForRepository(second.id),
    ).toBeUndefined();
    expect(
      await service.hasActiveProject(integration.id, second.externalId),
    ).toBe(false);
  });

  // CR-24-T04
  it("finds no active project once it was deactivated", async () => {
    const { service, integration, first } = await setup();
    await service.activateProject(first.id);
    expect(
      await service.hasActiveProject(integration.id, first.externalId),
    ).toBe(true);

    await service.deactivateProject(first.id);

    expect(
      await service.hasActiveProject(integration.id, first.externalId),
    ).toBe(false);
  });

  it("lists the repositories with their status for the UI", async () => {
    const { service, first } = await setup();
    await service.activateProject(first.id);

    const list = await service.listProjects();

    expect(
      list.map((entry) => [entry.repository.fullName, entry.status]),
    ).toEqual([
      ["acme/repo-1", "active"],
      ["acme/repo-2", "inactive"],
    ]);
  });
});

describe("finding one project entry", () => {
  it("returns the entry of a repository and nothing for an id that cannot be one of ours", async () => {
    const { service, first } = await setup();

    expect(await service.findProject(first.id)).toMatchObject({
      repository: { id: first.id },
      status: "inactive",
    });
    expect(await service.findProject("")).toBeUndefined();
    expect(await service.findProject("x".repeat(129))).toBeUndefined();
    expect(await service.findProject("no-such-repository")).toBeUndefined();
  });
});

describe("creating a project in the factory (#922)", () => {
  const BOARD = { projectV2Id: "PVT_board1", statusFieldId: "PVTSSF_1" };

  // #922-T65
  it("creates the project with its board, runs the activation hook, and finds it by its id", async () => {
    const events: string[] = [];
    const { service, first } = await setup({
      ...noopProjectHooks,
      onProjectActivated: async (event) => void events.push(event.repositoryId),
    });

    const project = await service.createProject(first.id, BOARD);

    expect(project.active).toBe(true);
    expect(project.ticketSource).toEqual({
      provider: "github",
      repositoryId: first.id,
      board: BOARD,
    });
    expect(events).toEqual([first.id]);
    expect(await service.getProject(project.id)).toEqual(project);
    expect(await service.getProject("")).toBeUndefined();
    expect(await service.getProject("x".repeat(500))).toBeUndefined();
  });

  // #922-T66
  it("creates a project without a board, and refuses a repository that is a project already without changing it", async () => {
    const { service, first } = await setup();
    await service.createProject(first.id, null);

    expect(await codeOf(service.createProject(first.id, BOARD))).toBe(
      "PROJECT_ALREADY_EXISTS",
    );
    expect(
      (await service.findProject(first.id))?.project?.ticketSource.board,
    ).toBeNull();
  });

  // #922-T67
  it("creates the project of a repository that was switched off, and says what an unknown or an unavailable repository is", async () => {
    const { service, first, remote, repositories, integration } = await setup();
    await service.activateProject(first.id);
    await service.deactivateProject(first.id);

    const again = await service.createProject(first.id, BOARD);

    expect(again.active).toBe(true);
    expect(again.ticketSource.board).toEqual(BOARD);
    expect(
      await codeOf(service.createProject("no-such-repository", null)),
    ).toBe("PROJECT_REPOSITORY_NOT_FOUND");
    // The platform stops listing the first repository.
    await repositories.reconcile(integration.id, [remote(2)]);
    await service.deactivateProject(first.id);
    expect(await codeOf(service.createProject(first.id, null))).toBe(
      "PROJECT_REPOSITORY_UNAVAILABLE",
    );
  });
});
