// SPDX-License-Identifier: LicenseRef-Proprietary

// #1092 (epic #1090, ADR 0006): what the claim tests of a turn on several repositories need beside the runner API harness: a second installation with
// a repository of its own, clone addresses on the host of the fake GitHub (the claim holds a job to the host of the API it hands out), and the
// repositories of a session as the first turn resolved them.
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { RunnerApiHarness } from "./runner-api-harness.ts";

/** An installation that has accepted the right to write contents. */
export const WRITE = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
} as const;

/** One repository of a session of several (`SessionRepo`): mounted under the name part, based on `main`. */
export function sessionRepo(id: string, fullName: string, branch = "main") {
  return {
    repositoryId: id,
    fullName,
    name: fullName.split("/")[1] as string,
    base: "main",
    branch,
  };
}

/** The clone address of every repository is on the host of the API: the fake GitHub is that host here. */
export async function cloneFromTheFake(h: RunnerApiHarness): Promise<void> {
  const host = new URL(h.fake.baseUrl).host;
  const rows = await h.db
    .selectFrom("repositories")
    .select(["id", "full_name"])
    .execute();
  for (const row of rows)
    await h.db
      .updateTable("repositories")
      .set({ url: `https://${host}/${row.full_name}` })
      .where("id", "=", row.id)
      .execute();
}

/** A second installation (4243) with the repository `other/docs`, as a workspace on two installations has. */
export async function secondInstallation(h: RunnerApiHarness) {
  h.fake.addInstallation({
    id: 4243,
    account: { login: "other", id: 5002, type: "Organization" },
  });
  h.fake.setRepositories(4243, [{ id: 7003, fullName: "other/docs" }]);
  h.fake.setInstallationPermissions(4243, WRITE);
  const integration = await createIntegrationsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).create({
    type: "github_app",
    displayName: "other",
    externalId: "4243",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7003",
      fullName: "other/docs",
      url: "https://github.test/other/docs",
    },
  ]);
  const [row] = await repositories.list({ integrationId: integration.id });
  if (row === undefined) throw new Error("The second repository is missing.");
  return { integrationId: integration.id, repositoryId: row.id };
}

/** The full name of the other repository of the harness (the order of the fixture decides which of its two is the first). */
export async function otherName(h: RunnerApiHarness): Promise<string> {
  const row = await h.db
    .selectFrom("repositories")
    .select("full_name")
    .where("id", "=", h.otherRepositoryId)
    .executeTakeFirstOrThrow();
  return row.full_name;
}
