// SPDX-License-Identifier: LicenseRef-Proprietary

// The Jira Cloud connections of a workspace (#1037) against a real Postgres: one connection per site and workspace, a reconnect replaces
// the row in place, the token pair is replaced only by the request that read its version, a connection a project uses is not removed (and
// the project is named), and nothing crosses workspaces.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { RepoRef } from "../../integrations/types.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import {
  createJiraConnectionsRepository,
  type SaveJiraConnection,
} from "./jira-connections-repository.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";

const SEALED = { ciphertext: "c1", nonce: "n1", keyVersion: 1 };
const EXPIRES = new Date("2026-11-14T10:00:00.000Z");

function site(id: string, over: Partial<SaveJiraConnection> = {}) {
  return {
    id,
    cloudId: "cloud-1",
    siteUrl: "https://acme.atlassian.net",
    siteName: "acme",
    accountId: "acct-1",
    accountName: "Ada",
    scopes: ["read:jira-work", "offline_access"],
    sealed: SEALED,
    accessExpiresAt: EXPIRES,
    connectedBy: null,
    ...over,
  } satisfies SaveJiraConnection;
}

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const a = createJiraConnectionsRepository(db, idA);
  const b = createJiraConnectionsRepository(db, idB);
  return { db, idA, idB, a, b };
}

/** A project of workspace `workspaceId` whose ticket source is the Jira connection `connectionId`. */
async function projectUsing(
  db: Awaited<ReturnType<typeof setup>>["db"],
  workspaceId: string,
  connectionId: string,
  fullName: string,
) {
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: `ext-${fullName}`,
    config: {},
  });
  const remote: RepoRef = {
    integrationId: integration.id,
    externalId: fullName,
    fullName,
    url: `https://github.test/${fullName}`,
  };
  const repositories = createRepositoriesRepository(db, workspaceId);
  await repositories.reconcile(integration.id, [remote]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const activated = await createProjectsRepository(db, workspaceId).activate(
    repository.id,
  );
  if (activated.kind !== "activated") throw new Error("seeding failed");
  await db
    .updateTable("projects")
    .set({
      ticket_source: JSON.stringify({
        provider: "jira",
        connectionId,
        jiraProject: "CR",
      }),
    })
    .where("id", "=", activated.project.id)
    .execute();
  return activated.project.id;
}

describe("the Jira connections repository", () => {
  // #1037
  it("keeps one connection per site and workspace; connecting the site again replaces the row in place", async () => {
    const { a, b } = await setup();
    const first = await a.save(site("jc-1"));
    expect(first).toMatchObject({
      id: "jc-1",
      cloudId: "cloud-1",
      status: "connected",
      errorCode: null,
      scopes: ["read:jira-work", "offline_access"],
    });
    expect(
      await a.save(site("jc-1", { accountName: "Grace", siteName: "acme 2" })),
    ).toMatchObject({ id: "jc-1", accountName: "Grace", siteName: "acme 2" });
    expect(await a.list()).toHaveLength(1);
    // The same site in another workspace is its own connection.
    expect(await b.save(site("jc-2"))).toMatchObject({ id: "jc-2" });
    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toHaveLength(1);
  });

  // #1037
  it("refuses to save over the row of a site under another id (the tokens are sealed for the id)", async () => {
    const { a } = await setup();
    await a.save(site("jc-1"));
    expect(await a.save(site("jc-other"))).toBeUndefined();
    expect((await a.readTokens("jc-1"))?.sealed).toEqual(SEALED);
  });

  // #1037
  it("replaces the token pair only for the request that read its version, and a refresh mends a broken connection", async () => {
    const { a } = await setup();
    await a.save(site("jc-1"));
    const read = await a.readTokens("jc-1");
    expect(read?.tokenVersion).toBe(1);
    const next = { ciphertext: "c2", nonce: "n2", keyVersion: 1 };
    const later = new Date("2026-11-14T11:00:00.000Z");
    expect(await a.replaceTokens("jc-1", 1, next, later)).toBe(true);
    // The second request read version 1 as well: it lost.
    expect(
      await a.replaceTokens(
        "jc-1",
        1,
        { ciphertext: "c3", nonce: "n3", keyVersion: 1 },
        later,
      ),
    ).toBe(false);
    expect(await a.markBroken("jc-1", 1, "jira_refresh_refused")).toBe(false);
    const after = await a.readTokens("jc-1");
    expect(after?.sealed).toEqual(next);
    expect(after?.tokenVersion).toBe(2);
    expect(after?.connection.accessExpiresAt).toBe(later.toISOString());

    expect(await a.markBroken("jc-1", 2, "jira_refresh_refused")).toBe(true);
    expect(await a.get("jc-1")).toMatchObject({
      status: "broken",
      errorCode: "jira_refresh_refused",
    });
    // Connecting again mends it and moves the version on.
    expect(await a.save(site("jc-1"))).toMatchObject({
      status: "connected",
      errorCode: null,
    });
    expect((await a.readTokens("jc-1"))?.tokenVersion).toBe(3);
  });

  // #1037-T03
  it("does not remove a connection a project uses, and names the project; removes it once the project does not use it", async () => {
    const { db, idA, a } = await setup();
    await a.save(site("jc-1"));
    const projectId = await projectUsing(db, idA, "jc-1", "acme/api");
    expect(await a.removeUnlessUsed("jc-1")).toEqual({
      removed: false,
      reason: "in_use",
      projects: [{ id: projectId, name: "acme/api" }],
    });
    expect(await a.get("jc-1")).toBeDefined();

    await db
      .updateTable("projects")
      .set({ ticket_source: null })
      .where("id", "=", projectId)
      .execute();
    expect(await a.removeUnlessUsed("jc-1")).toEqual({ removed: true });
    expect(await a.get("jc-1")).toBeUndefined();
    expect(await a.removeUnlessUsed("jc-1")).toEqual({
      removed: false,
      reason: "not_found",
    });
  });

  // #1037-T03
  it("is not held back by a project whose ticket source is damaged text or names another connection", async () => {
    const { db, idA, a } = await setup();
    await a.save(site("jc-1"));
    const projectId = await projectUsing(db, idA, "jc-other", "acme/api");
    expect(await a.removeUnlessUsed("jc-1")).toEqual({ removed: true });
    await a.save(site("jc-1"));
    await sql`update projects set ticket_source = 'not json' where id = ${projectId}`.execute(
      db,
    );
    expect(await a.projectsUsing("jc-1")).toEqual([]);
  });

  // #1037
  it("does not see or change the connections of another workspace", async () => {
    const { db, idB, a, b } = await setup();
    await b.save(site("jc-b"));
    const project = await projectUsing(db, idB, "jc-b", "other/repo");
    expect(await a.get("jc-b")).toBeUndefined();
    expect(await a.readTokens("jc-b")).toBeUndefined();
    expect(await a.findBySite("cloud-1")).toBeUndefined();
    expect(await a.replaceTokens("jc-b", 1, SEALED, EXPIRES)).toBe(false);
    expect(await a.markBroken("jc-b", 1, "jira_refresh_refused")).toBe(false);
    expect(await a.projectsUsing("jc-b")).toEqual([]);
    expect(await a.removeUnlessUsed("jc-b")).toEqual({
      removed: false,
      reason: "not_found",
    });
    expect(await b.get("jc-b")).toMatchObject({ status: "connected" });
    expect(project).toBeDefined();
  });
});
