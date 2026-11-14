// SPDX-License-Identifier: LicenseRef-Proprietary

// What a stored ticket source reads as (#1038): the issues of the repository (GitHub, with or without a board) or a Jira project with its
// connection, the code staying in the repository. A source that cannot be used reads as the default with a warning that names the project.
import { describe, expect, it, vi } from "vitest";
import { TICKET_PROVIDERS } from "../../integrations/types.ts";
import { jiraSourceOf, readTicketSource } from "./projects-repository.ts";

const read = (text: string | null, warn = vi.fn()) => ({
  source: readTicketSource(text, "repo-1", "project-1", warn),
  warn,
});

describe("reading a ticket source", () => {
  // #1038-T01
  it("reads a Jira source with its connection and project key, the repository being the row's", () => {
    const { source, warn } = read(
      JSON.stringify({
        provider: "jira",
        repositoryId: "someone-else",
        connectionId: "conn-1",
        projectKey: "PROJ",
      }),
    );

    expect(source).toEqual({
      provider: "jira",
      repositoryId: "repo-1",
      board: null,
      connectionId: "conn-1",
      projectKey: "PROJ",
    });
    expect(jiraSourceOf(source)).toEqual({
      connectionId: "conn-1",
      projectKey: "PROJ",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // #1038
  it("knows no board for a Jira source, even when the text has one", () => {
    const { source } = read(
      JSON.stringify({
        provider: "jira",
        connectionId: "conn-1",
        projectKey: "PROJ",
        board: { projectV2Id: "PVT_x", statusFieldId: "PVTSSF_x" },
      }),
    );
    expect(source.board).toBeNull();
  });

  // #1038
  it.each([
    ["no connection", { provider: "jira", projectKey: "PROJ" }],
    [
      "an empty connection",
      { provider: "jira", connectionId: "", projectKey: "PROJ" },
    ],
    [
      "a connection that is no text",
      { provider: "jira", connectionId: 7, projectKey: "PROJ" },
    ],
    ["no project key", { provider: "jira", connectionId: "conn-1" }],
    [
      "a project key that cannot be one",
      { provider: "jira", connectionId: "conn-1", projectKey: "../x" },
    ],
    [
      "a lower case project key",
      { provider: "jira", connectionId: "conn-1", projectKey: "proj" },
    ],
  ])(
    "reads %s as the default with a warning that names the project",
    (_name, value) => {
      const { source, warn } = read(JSON.stringify(value));

      expect(source).toEqual({
        provider: "github",
        repositoryId: "repo-1",
        board: null,
      });
      expect(jiraSourceOf(source)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("project-1");
      expect(warn.mock.calls[0]?.[0]).not.toContain("conn-1");
    },
  );

  // #1038
  it("leaves a GitHub source as it was and carries no Jira fields into it", () => {
    const { source } = read(
      JSON.stringify({
        provider: "github",
        board: { projectV2Id: "PVT_b", statusFieldId: "PVTSSF_b" },
        connectionId: "conn-1",
        projectKey: "PROJ",
      }),
    );

    expect(source).toEqual({
      provider: "github",
      repositoryId: "repo-1",
      board: { projectV2Id: "PVT_b", statusFieldId: "PVTSSF_b" },
    });
    expect(read(null).source).toEqual({
      provider: "github",
      repositoryId: "repo-1",
      board: null,
    });
  });

  // #1038
  it("takes `jira` among the providers a source may name", () => {
    expect(TICKET_PROVIDERS).toEqual(["github", "jira"]);
  });
});
