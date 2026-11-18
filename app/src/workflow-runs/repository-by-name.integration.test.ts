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
