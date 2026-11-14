// SPDX-License-Identifier: LicenseRef-Proprietary

// What a row of the project list knows about the ticket source of its project (#1038): a Jira project's key, and nothing for the issues of
// the repository or for a repository that is no project yet.
import { describe, expect, it } from "vitest";
import type {
  ProjectListEntry,
  StoredProject,
  TicketSource,
} from "../../db/repositories/projects-repository.ts";
import { loadProjectList } from "./list-view.ts";

function entry(id: string, source: TicketSource | null): ProjectListEntry {
  return {
    repository: {
      id,
      externalId: `ext-${id}`,
      fullName: `acme/${id}`,
      url: `https://github.com/acme/${id}`,
      available: true,
      integration: {
        id: "i-1",
        type: "github_app",
        displayName: "acme",
        status: "active",
      },
    },
    project:
      source === null
        ? null
        : ({
            id: `p-${id}`,
            repositoryId: id,
            active: true,
            ticketSource: source,
            settings: {},
          } as unknown as StoredProject),
    status: source === null ? "inactive" : "active",
  };
}

describe("the rows of the project list", () => {
  // #1038
  it("name the Jira project of a project whose tickets come from Jira, and nothing else", async () => {
    const view = await loadProjectList({
      projects: {
        listProjects: async () => [
          entry("shop", {
            provider: "jira",
            repositoryId: "shop",
            board: null,
            connectionId: "conn-1",
            projectKey: "PROJ",
          }),
          entry("api", {
            provider: "github",
            repositoryId: "api",
            board: null,
          }),
          entry("new", null),
        ],
      },
    });

    expect(view.rows.map((row) => [row.repositoryId, row.jira])).toEqual([
      ["shop", { connectionId: "conn-1", projectKey: "PROJ" }],
      ["api", undefined],
      ["new", undefined],
    ]);
  });
});
