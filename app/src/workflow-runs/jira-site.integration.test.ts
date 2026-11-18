// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira site of a run's ticket against the real repositories (#1086): the project's source names the connection, the connection of
// ANOTHER workspace or a deleted one gives no site, and a GitHub source gives none.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { jiraSiteLookup } from "./jira-site.ts";

const SEALED = { ciphertext: "c1", nonce: "n1", keyVersion: 1 };

function connection(id: string, siteUrl: string) {
  return {
    id,
    cloudId: `cloud-${id}`,
    siteUrl,
    siteName: id,
    accountId: "acct",
    accountName: "Ada",
    scopes: ["read:jira-work"],
    sealed: SEALED,
    accessExpiresAt: new Date("2026-11-14T10:00:00.000Z"),
    connectedBy: null,
  };
}

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherWorkspace = await addWorkspace(db, "other");
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "1",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const projects = createProjectsRepository(db, workspaceId);
  const connections = createJiraConnectionsRepository(db, workspaceId);
  await connections.save(connection("conn-a", "https://acme.atlassian.net"));
  await createJiraConnectionsRepository(db, otherWorkspace).save(
    connection("conn-b", "https://beta.atlassian.net"),
  );
  return {
    db,
    repository,
    projects,
    lookup: jiraSiteLookup({ projects, jiraConnections: connections }),
    /** Writes the stored source of the project directly: `activate` refuses what these tests need (a connection of another workspace). */
    async setSource(source: Record<string, unknown>) {
      await db
        .updateTable("projects")
        .set({ ticket_source: JSON.stringify(source) })
        .execute();
    },
  };
}

describe("jiraSiteLookup against the database", () => {
  // #1086-T13
  it("gives the site of the project's Jira connection and the project key", async () => {
    const { projects, repository, lookup } = await setup();
    await projects.activate(repository.id, {
      jira: { connectionId: "conn-a", projectKey: "LAT" },
    });

    expect(await lookup(repository.id)).toEqual({
      siteUrl: "https://acme.atlassian.net",
      projectKey: "LAT",
    });
  });

  // #1086-T14
  it("gives no site for a project with a GitHub source", async () => {
    const { projects, repository, lookup } = await setup();
    await projects.activate(repository.id, {});

    expect(await lookup(repository.id)).toBeUndefined();
  });

  // #1086-T15
  it("gives no site for a connection of another workspace", async () => {
    const { projects, repository, lookup, setSource } = await setup();
    await projects.activate(repository.id, {});
    await setSource({
      provider: "jira",
      repositoryId: repository.id,
      connectionId: "conn-b",
      projectKey: "LAT",
    });

    expect(await lookup(repository.id)).toBeUndefined();
  });

  // #1086-T16
  it("gives no site for a connection that was deleted", async () => {
    const { projects, repository, lookup, db } = await setup();
    await projects.activate(repository.id, {
      jira: { connectionId: "conn-a", projectKey: "LAT" },
    });
    await db
      .deleteFrom("jira_connections")
      .where("id", "=", "conn-a")
      .execute();

    expect(await lookup(repository.id)).toBeUndefined();
  });
});
