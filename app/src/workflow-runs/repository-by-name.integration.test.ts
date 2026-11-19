// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (review finding 4): which repository a `repos` entry of an agent step names: case-insensitive, active only, and only of the workspace.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { repositoryByName } from "./repository-by-name.ts";
import { targetOfNamedRepository } from "./repository-target.ts";

async function seed(db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
  const workspaceId = await defaultWorkspaceId(db);
  const otherWorkspaceId = await addWorkspace(db, "other");
  const make = async (
    workspace: string,
    externalId: string,
    names: string[],
  ) => {
    const integration = await createIntegrationsRepository(
      db,
      workspace,
    ).create({
      type: "github_app",
      displayName: externalId,
      externalId,
      config: {},
    });
    const repositories = createRepositoriesRepository(db, workspace);
    await repositories.reconcile(
      integration.id,
      names.map((fullName, index) => ({
        integrationId: integration.id,
        externalId: `${externalId}-${String(index)}`,
        fullName,
        url: `https://github.test/${fullName}`,
      })),
    );
    return { integration, repositories };
  };
  return { workspaceId, otherWorkspaceId, make };
}

describe("the repository an entry of `repos` names", () => {
  // #1092-T120
  it("is found by its full name without regard to case, with the name as stored", async () => {
    const { db } = await createTestDatabase();
    const { workspaceId, make } = await seed(db);
    const mine = await make(workspaceId, "1", ["Acme/App", "acme/lib"]);

    const found = await repositoryByName(mine.repositories)("ACME/app");

    expect(found).toEqual({
      id: expect.any(String) as string,
      fullName: "Acme/App",
    });
    expect(await repositoryByName(mine.repositories)("acme/missing")).toBe(
      undefined,
    );
  });

  // #1092-T121
  it("is not found once the repository is inactive", async () => {
    const { db } = await createTestDatabase();
    const { workspaceId, make } = await seed(db);
    const mine = await make(workspaceId, "1", ["acme/app"]);
    await mine.repositories.deactivateAll(mine.integration.id);

    expect(await repositoryByName(mine.repositories)("acme/app")).toBe(
      undefined,
    );
  });

  // #1092-T122
  it("is not found in another workspace: the same answer as for a repository that does not exist", async () => {
    const { db } = await createTestDatabase();
    const { workspaceId, otherWorkspaceId, make } = await seed(db);
    const mine = await make(workspaceId, "1", ["acme/app"]);
    const theirs = await make(otherWorkspaceId, "2", ["secret/product"]);

    expect(await repositoryByName(mine.repositories)("secret/product")).toBe(
      undefined,
    );
    expect(await repositoryByName(theirs.repositories)("acme/app")).toBe(
      undefined,
    );
    expect(
      await repositoryByName(theirs.repositories)("secret/product"),
    ).toMatchObject({ fullName: "secret/product" });
  });
});

describe("the target of a pull request step with `repos` (#1094)", () => {
  // #1094-T54
  it("is the workspace's own active repository by its name, and nothing for another workspace's or an inactive one", async () => {
    const { db } = await createTestDatabase();
    const { workspaceId, otherWorkspaceId, make } = await seed(db);
    const mine = await make(workspaceId, "1", ["Acme/App", "acme/lib"]);
    await make(otherWorkspaceId, "2", ["secret/product"]);
    const asked: string[] = [];
    const target = targetOfNamedRepository({
      // The real repositories repository of the workspace, as `shared.ts` makes it.
      repositories: (workspace) => createRepositoriesRepository(db, workspace),
      targetOf: async (_workspace, repositoryId) => {
        asked.push(repositoryId);
        return { repositoryId } as never;
      },
    });
    const call = (workspace: string) => ({ workspaceId: workspace }) as never;

    // Case-insensitive, as GitHub names are.
    expect(await target(call(workspaceId), "ACME/app")).toBeDefined();
    // The other workspace's repository is answered like one that does not exist, and its connection is never looked at.
    expect(await target(call(workspaceId), "secret/product")).toBeUndefined();
    expect(await target(call(otherWorkspaceId), "acme/app")).toBeUndefined();
    expect(asked).toHaveLength(1);
    await mine.repositories.deactivateAll(mine.integration.id);
    expect(await target(call(workspaceId), "acme/lib")).toBeUndefined();
  });
});
