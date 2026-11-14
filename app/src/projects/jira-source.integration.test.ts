// SPDX-License-Identifier: LicenseRef-Proprietary

// A project's ticket source that is a Jira project (#1038, epic #1034) against a real Postgres and the fake Atlassian: the connection is the
// one a person made through OAuth (`createJiraHarness`), the projects and the workflow statuses are read from the fake site through the real
// token handling, the project is created through the real handlers, service and repository, and what it names is read back. Nothing here
// touches the network but the loopback fake.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createJiraConnectionsRepository } from "../db/repositories/jira-connections-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import type { RepoRef } from "../integrations/types.ts";
import { createJiraProjectReader } from "../jira/projects.ts";
import {
  jiraProjectVia,
  jiraProjectsVia,
  statusNamesVia,
} from "../jira/project-source.ts";
import { createJiraHarness } from "../test-support/jira-harness.ts";
import { sessionUser } from "../test-support/session-lookup.ts";
import { createNewProjectHandlers } from "./create-http.ts";
import { createProjectService } from "./service.ts";

const SITE = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  url: "https://acme.atlassian.net",
  name: "acme",
};
const PROJECTS = [
  { id: "10000", key: "PROJ", name: "Project" },
  { id: "10001", key: "OPS", name: "Operations" },
  { id: "10002", key: "WEB", name: "Website" },
];

/** A workspace with a Jira connection made through the OAuth round trip, a GitHub repository and the site's projects. */
async function world() {
  const h = await createJiraHarness({
    atlassian: {
      sites: [SITE],
      projects: { [SITE.id]: PROJECTS },
      // Two projects a page: the list has to follow the pages.
      projectPageSize: 2,
    },
  });
  async function workspaceWithConnection(slug: string) {
    const workspace = await h.workspace(slug);
    const owner = await h.person(`owner-${slug}`, {
      workspaceId: workspace.id,
      role: "owner",
    });
    await h.walk(owner, workspace, "owner");
    const [connection] = await h.jira.service.list(workspace.id);
    if (connection === undefined) throw new Error("not connected");
    return { workspace, owner, connection };
  }
  const acme = await workspaceWithConnection("acme");
  const other = await workspaceWithConnection("other");

  const integration = await createIntegrationsRepository(
    h.db,
    acme.workspace.id,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const remote: RepoRef = {
    integrationId: integration.id,
    externalId: "1",
    fullName: "acme/shop",
    url: "https://github.test/acme/shop",
  };
  const repositories = createRepositoriesRepository(h.db, acme.workspace.id);
  await repositories.reconcile(integration.id, [remote]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");

  const projects = createProjectsRepository(h.db, acme.workspace.id);
  const reader = createJiraProjectReader({
    tokens: h.jira.tokensFor(acme.workspace.id),
  });
  const connections = createJiraConnectionsRepository(h.db, acme.workspace.id);
  const jiraProjects = jiraProjectsVia({ connections, reader });
  const jiraProject = jiraProjectVia({ connections, reader });
  const handlers = createNewProjectHandlers({
    requireUser: async () => sessionUser(acme.owner.id),
    service: createProjectService({ projects }),
    boards: async () => ({ kind: "boards", available: true, boards: [] }),
    jiraProjects,
    jiraProject,
    laneKeys: [],
    copyLanes: async () => [],
  });
  const post = (body: unknown) =>
    handlers.create(
      new Request("https://factory.example.test/api/w/acme/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const projectCalls = () =>
    h.atlassian
      .requests()
      .filter((request) => request.path.includes("/rest/api/3/project"));
  return {
    h,
    acme,
    other,
    repository,
    projects,
    reader,
    connections,
    jiraProjects,
    jiraProject,
    handlers,
    post,
    projectCalls,
  };
}

describe("a project on a Jira project", () => {
  // #1038-T01
  it("is created from a connection and a project key of the site, with the repository the code lives in, and is read back", async () => {
    const w = await world();

    const response = await w.post({
      repositoryId: w.repository.id,
      ticketSource: {
        provider: "jira",
        connectionId: w.acme.connection.id,
        projectKey: "OPS",
      },
    });

    expect(response.status).toBe(201);
    // The key is checked with one call for that project, not by reading the list of the site (which has two pages here).
    expect(w.projectCalls().map((request) => request.path)).toEqual([
      `/ex/jira/${SITE.id}/rest/api/3/project/OPS`,
    ]);
    const stored = await w.projects.get(w.repository.id);
    expect(stored).toMatchObject({
      active: true,
      ticketSource: {
        provider: "jira",
        repositoryId: w.repository.id,
        board: null,
        connectionId: w.acme.connection.id,
        projectKey: "OPS",
      },
    });
    expect(await w.projects.getById(stored?.id ?? "")).toEqual(stored);
    // The connection knows its project now, and cannot be removed under it.
    expect(await w.connections.projectsUsing(w.acme.connection.id)).toEqual([
      { id: stored?.id, name: "acme/shop" },
    ]);
    expect(await w.connections.removeUnlessUsed(w.acme.connection.id)).toEqual({
      removed: false,
      reason: "in_use",
      projects: [{ id: stored?.id, name: "acme/shop" }],
    });
  });

  // #1038-T01
  it("refuses a source naming another workspace's connection, without asking Jira and without writing a project", async () => {
    const w = await world();

    const response = await w.post({
      repositoryId: w.repository.id,
      ticketSource: {
        provider: "jira",
        connectionId: w.other.connection.id,
        projectKey: "PROJ",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "PROJECT_REQUEST_INVALID",
      issues: [
        { path: "ticketSource.connectionId", code: "unknown_connection" },
      ],
    });
    expect(await w.projects.get(w.repository.id)).toBeUndefined();
    expect(w.projectCalls()).toEqual([]);
    // The same through the list of projects: no listing of the other workspace's site.
    expect(await w.jiraProjects(w.other.connection.id)).toEqual({
      kind: "connection_not_found",
    });
    expect(w.projectCalls()).toEqual([]);
  });

  // #1038-T01 (finding of the review of #1044)
  it("refuses a project key the site does not have with one call, naming no key of the site", async () => {
    const w = await world();

    const response = await w.post({
      repositoryId: w.repository.id,
      ticketSource: {
        provider: "jira",
        connectionId: w.acme.connection.id,
        projectKey: "NOPE",
      },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      issues: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      issues: [
        { path: "ticketSource.projectKey", code: "unknown_jira_project" },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/"(?:PROJ|OPS|WEB)"|available/);
    expect(await w.projects.get(w.repository.id)).toBeUndefined();
    expect(w.projectCalls()).toHaveLength(1);
  });

  // #1038-T01 (finding of the review of #1044)
  it("asks Jira nothing for a repository that is not there, nor for a project the repository has already", async () => {
    const w = await world();
    const ticketSource = {
      provider: "jira",
      connectionId: w.acme.connection.id,
      projectKey: "PROJ",
    };

    const unknown = await w.post({ repositoryId: "no-such", ticketSource });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: "PROJECT_REPOSITORY_NOT_FOUND",
    });
    expect(w.projectCalls()).toEqual([]);

    expect(
      (await w.post({ repositoryId: w.repository.id, ticketSource })).status,
    ).toBe(201);
    const callsBefore = w.projectCalls().length;
    const again = await w.post({ repositoryId: w.repository.id, ticketSource });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "PROJECT_ALREADY_EXISTS" });
    expect(w.projectCalls()).toHaveLength(callsBefore);
  });

  // #1038
  it("lists the projects of the site across Jira's pages, for the dialog", async () => {
    const w = await world();

    const response = await w.handlers.jiraProjects(
      new Request("https://factory.example.test/api"),
      w.acme.connection.id,
    );

    expect(await response.json()).toEqual({
      complete: true,
      projects: [
        { key: "PROJ", name: "Project" },
        { key: "OPS", name: "Operations" },
        { key: "WEB", name: "Website" },
      ],
    });
    expect(w.projectCalls().map((request) => request.query.startAt)).toEqual([
      "0",
      "2",
    ]);
  });

  // #1038-T02
  it("offers the lane editor Jira's own status names of the project, and none for a project of another source or a broken connection", async () => {
    const w = await world();
    w.h.atlassian.setProjects(SITE.id, [
      {
        id: "10000",
        key: "PROJ",
        name: "Project",
        issueTypes: [
          {
            id: "1",
            name: "Task",
            statuses: [
              { id: "1", name: "Backlog", category: "new" },
              { id: "2", name: "Ready for agent" },
              { id: "3", name: "Fertig", category: "done" },
            ],
          },
          {
            id: "2",
            name: "Bug",
            statuses: [
              { id: "2", name: "Ready for agent" },
              { id: "4", name: "In Review" },
            ],
          },
        ],
      },
    ]);
    await w.post({
      repositoryId: w.repository.id,
      ticketSource: {
        provider: "jira",
        connectionId: w.acme.connection.id,
        projectKey: "PROJ",
      },
    });
    const project = await w.projects.get(w.repository.id);
    const names = statusNamesVia({
      projects: w.projects,
      reader: w.reader,
      boardNames: async () => ["a board's"],
    });

    expect(await names(project?.id ?? "")).toEqual([
      "Backlog",
      "Ready for agent",
      "Fertig",
      "In Review",
    ]);
    expect(await names("no-such-project")).toEqual([]);

    // The person removed the app in Atlassian: the next refresh is refused, the connection is marked broken, the editor has none to offer
    // and nothing more is asked of Atlassian.
    w.h.atlassian.revokeGrants();
    w.h.atlassian.expireAccessTokens();
    expect(await names(project?.id ?? "")).toEqual([]);
    const callsBefore = w.h.atlassian.requests().length;
    expect(await names(project?.id ?? "")).toEqual([]);
    expect(await w.jiraProjects(w.acme.connection.id)).toEqual({
      kind: "connection_broken",
    });
    expect(w.h.atlassian.requests().length).toBe(callsBefore);
  });
});
