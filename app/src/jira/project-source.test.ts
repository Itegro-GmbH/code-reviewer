// SPDX-License-Identifier: LicenseRef-Proprietary

// What the new-project dialog and the lane editor ask of Jira through a project's connection (#1038): the projects of the connection's
// site, and the names of the workflow statuses of the project a source names, whichever provider the project's tickets come from.
import { describe, expect, it, vi } from "vitest";
import type {
  StoredProject,
  TicketSource,
} from "../db/repositories/projects-repository.ts";
import type { StoredJiraConnection } from "../db/repositories/jira-connections-repository.ts";
import type { JiraProjectReader } from "./projects.ts";
import { jiraProjectsVia, statusNamesVia } from "./project-source.ts";

const connection = (status: "connected" | "broken" = "connected") =>
  ({ id: "conn-1", status }) as StoredJiraConnection;

function readerOf(overrides: Partial<JiraProjectReader> = {}) {
  const reader: JiraProjectReader = {
    listProjects: vi.fn(async () => ({
      ok: true as const,
      complete: true,
      projects: [{ id: "1", key: "PROJ", name: "Project" }],
    })),
    listStatuses: vi.fn(async () => ({
      ok: true as const,
      statuses: [
        { id: "1", name: "To Do", category: "new" as const },
        {
          id: "2",
          name: "Ready for agent",
          category: "indeterminate" as const,
        },
      ],
    })),
    ...overrides,
  };
  return reader;
}

describe("the projects of a connection's site", () => {
  // #1038-T01
  it("lists them for a connection of the workspace, key and name only", async () => {
    const reader = readerOf();
    const answer = await jiraProjectsVia({
      connections: { get: async () => connection() },
      reader,
    })("conn-1");

    expect(answer).toEqual({
      kind: "projects",
      complete: true,
      projects: [{ key: "PROJ", name: "Project" }],
    });
    expect(reader.listProjects).toHaveBeenCalledWith("conn-1");
  });

  // #1038-T01
  it("asks Jira nothing for a connection the workspace does not have, and nothing for a broken one", async () => {
    const reader = readerOf();

    expect(
      await jiraProjectsVia({
        connections: { get: async () => undefined },
        reader,
      })("other-workspaces"),
    ).toEqual({ kind: "connection_not_found" });
    expect(
      await jiraProjectsVia({
        connections: { get: async () => connection("broken") },
        reader,
      })("conn-1"),
    ).toEqual({ kind: "connection_broken" });
    expect(reader.listProjects).not.toHaveBeenCalled();
  });

  // #1038
  it("names what the call failed with: a connection that broke meanwhile, one that vanished, anything else is unavailable", async () => {
    const via = (
      error:
        | "jira_connection_broken"
        | "jira_connection_not_found"
        | "jira_unavailable"
        | "jira_forbidden",
    ) =>
      jiraProjectsVia({
        connections: { get: async () => connection() },
        reader: readerOf({
          listProjects: async () => ({ ok: false, error }),
        }),
      })("conn-1");

    expect(await via("jira_connection_broken")).toEqual({
      kind: "connection_broken",
    });
    expect(await via("jira_connection_not_found")).toEqual({
      kind: "connection_not_found",
    });
    expect(await via("jira_unavailable")).toEqual({ kind: "unavailable" });
    expect(await via("jira_forbidden")).toEqual({ kind: "unavailable" });
  });
});

describe("the status names the lane editor offers", () => {
  const project = (source: TicketSource) =>
    ({ id: "p-1", ticketSource: source }) as StoredProject;
  const github: TicketSource = {
    provider: "github",
    repositoryId: "r-1",
    board: { projectV2Id: "PVT_1", statusFieldId: "PVTSSF_1" },
  };
  const jira: TicketSource = {
    provider: "jira",
    repositoryId: "r-1",
    board: null,
    connectionId: "conn-1",
    projectKey: "PROJ",
  };

  // #1038-T02
  it("offers Jira's own names of the project's workflow statuses for a Jira project, in Jira's order", async () => {
    const reader = readerOf();
    const names = statusNamesVia({
      projects: { getById: async () => project(jira) },
      reader,
      boardNames: async () => ["not asked"],
    });

    expect(await names("p-1")).toEqual(["To Do", "Ready for agent"]);
    expect(reader.listStatuses).toHaveBeenCalledWith("conn-1", "PROJ");
  });

  // #1038
  it("leaves a GitHub project to the names of its board, and asks Jira nothing", async () => {
    const reader = readerOf();
    const boardNames = vi.fn(async () => ["Todo", "Done"]);
    const names = statusNamesVia({
      projects: { getById: async () => project(github) },
      reader,
      boardNames,
    });

    expect(await names("p-1")).toEqual(["Todo", "Done"]);
    expect(boardNames).toHaveBeenCalledWith("p-1");
    expect(reader.listStatuses).not.toHaveBeenCalled();
  });

  // #1038
  it("offers none when Jira cannot be asked, the project is gone or the connection is broken: the names are typed then", async () => {
    const failing = statusNamesVia({
      projects: { getById: async () => project(jira) },
      reader: readerOf({
        listStatuses: async () => ({ ok: false, error: "jira_unavailable" }),
      }),
      boardNames: async () => [],
    });
    expect(await failing("p-1")).toEqual([]);

    const gone = statusNamesVia({
      projects: { getById: async () => undefined },
      reader: readerOf(),
      boardNames: async () => ["no"],
    });
    expect(await gone("p-1")).toEqual([]);

    const throwing = statusNamesVia({
      projects: {
        getById: async () => {
          throw new Error("database down");
        },
      },
      reader: readerOf(),
      boardNames: async () => [],
    });
    expect(await throwing("p-1")).toEqual([]);
  });
});
