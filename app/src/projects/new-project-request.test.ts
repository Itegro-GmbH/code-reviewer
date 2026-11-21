// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the body of a new project is held to its shape; every problem has a path, a code, a message and, for a closed set, `available`.
import { describe, expect, it } from "vitest";
import { readNewProjectRequest as read } from "./new-project-request.ts";

const LANES = ["issue-to-pr", "review-a-pull-request"];
const readNewProjectRequest = (body: unknown) => read(body, LANES);

const BOARD = "PVT_kwDOAbc123";

describe("the body of a new project", () => {
  // #922-T10
  it("takes a repository alone, with or without a board and lanes", () => {
    expect(readNewProjectRequest({ repositoryId: "r1" })).toEqual({
      ok: true,
      request: { repositoryId: "r1", board: null, lanes: [] },
    });
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        board: { projectV2Id: BOARD },
        lanes: ["issue-to-pr", "review-a-pull-request"],
      }),
    ).toEqual({
      ok: true,
      request: {
        repositoryId: "r1",
        board: { projectV2Id: BOARD },
        lanes: ["issue-to-pr", "review-a-pull-request"],
      },
    });
    expect(
      readNewProjectRequest({ repositoryId: "r1", board: null }),
    ).toMatchObject({ ok: true, request: { board: null } });
  });

  // #922-T11
  it("reports every problem with its path and what would have been accepted", () => {
    const result = readNewProjectRequest({
      board: { projectV2Id: "not-a-board", color: "tint" },
      lanes: ["issue-to-pr", "issue-to-pr", "nothing"],
      extra: 1,
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "extra",
          code: "unknown_field",
          available: ["repositoryId", "board", "lanes", "ticketSource"],
        }),
        expect.objectContaining({
          path: "repositoryId",
          code: "missing_field",
        }),
        expect.objectContaining({
          path: "board.color",
          code: "unknown_field",
          available: ["projectV2Id"],
        }),
        expect.objectContaining({
          path: "board.projectV2Id",
          code: "invalid_value",
        }),
        expect.objectContaining({
          path: "lanes/1",
          code: "duplicate_lane",
          available: ["review-a-pull-request"],
        }),
        expect.objectContaining({
          path: "lanes/2",
          code: "unknown_lane",
          available: ["issue-to-pr", "review-a-pull-request"],
        }),
      ],
    });
  });

  // #922-T12
  it("refuses a body that is not an object and values of the wrong type", () => {
    expect(readNewProjectRequest([])).toMatchObject({
      ok: false,
      issues: [{ path: "", code: "wrong_type" }],
    });
    expect(
      readNewProjectRequest({
        repositoryId: 3,
        board: "x",
        lanes: "issue-to-pr",
      }),
    ).toMatchObject({
      ok: false,
      issues: [
        { path: "repositoryId", code: "invalid_value" },
        { path: "board", code: "wrong_type" },
        { path: "lanes", code: "wrong_type" },
      ],
    });
  });
});

describe("the ticket source in the body of a new project (#1038)", () => {
  const JIRA = { provider: "jira", connectionId: "conn-1", projectKey: "PROJ" };

  // #1038-T01
  it("takes a Jira project with its connection and key, the repository being the one the code lives in", () => {
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: JIRA,
        lanes: ["review-a-pull-request"],
      }),
    ).toEqual({
      ok: true,
      request: {
        repositoryId: "r1",
        board: null,
        lanes: ["review-a-pull-request"],
        jira: { connectionId: "conn-1", projectKey: "PROJ" },
      },
    });
  });

  // #1038 (finding of the review of #1044)
  it("refuses the lane that starts from a GitHub label for a Jira project, naming the lanes that are allowed, and still takes it for the issues of a repository", () => {
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: JIRA,
        lanes: ["review-a-pull-request", "issue-to-pr"],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "lanes/1",
          code: "lane_not_for_jira",
          message: expect.stringContaining("issue-to-pr"),
          available: [
            "one-off-task",
            "issue-to-pr-status",
            "review-a-pull-request",
          ],
        },
      ],
    });
    // #1105: the one-off lane needs no ticket, so a Jira project takes it.
    expect(
      read(
        { repositoryId: "r1", ticketSource: JIRA, lanes: ["one-off-task"] },
        [...LANES, "one-off-task"],
      ).ok,
    ).toBe(true);
    // #1040: the status lane works for a Jira project.
    expect(
      read(
        {
          repositoryId: "r1",
          ticketSource: JIRA,
          lanes: ["issue-to-pr-status", "review-a-pull-request"],
        },
        [...LANES, "issue-to-pr-status"],
      ).ok,
    ).toBe(true);
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { provider: "github" },
        lanes: ["issue-to-pr"],
      }),
    ).toMatchObject({ ok: true });
  });

  // #1038
  it("reads `github` as the issues of the repository, as when no source is named, and keeps the board", () => {
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { provider: "github" },
        board: { projectV2Id: BOARD },
      }),
    ).toEqual({
      ok: true,
      request: {
        repositoryId: "r1",
        board: { projectV2Id: BOARD },
        lanes: [],
      },
    });
  });

  // #1038
  it("names every problem of the source with its path and what would have been accepted", () => {
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { provider: "linear", connectionId: "c", color: 1 },
      }),
    ).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "ticketSource.color",
          code: "unknown_field",
          available: ["provider", "connectionId", "projectKey"],
        }),
        expect.objectContaining({
          path: "ticketSource.provider",
          code: "invalid_value",
          available: ["github", "jira"],
        }),
      ],
    });
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { provider: "jira" },
      }),
    ).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "ticketSource.connectionId",
          code: "missing_field",
        }),
        expect.objectContaining({
          path: "ticketSource.projectKey",
          code: "missing_field",
        }),
      ],
    });
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { ...JIRA, projectKey: "proj/../x" },
      }),
    ).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "ticketSource.projectKey",
          code: "invalid_value",
        }),
      ],
    });
    expect(
      readNewProjectRequest({ repositoryId: "r1", ticketSource: "jira" }),
    ).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "ticketSource",
          code: "wrong_type",
        }),
      ],
    });
  });

  // #1038
  it("refuses a connection that is not a text of a sensible size, and a GitHub board next to a Jira project", () => {
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { ...JIRA, connectionId: 7 },
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "ticketSource.connectionId", code: "invalid_value" }],
    });
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: { ...JIRA, connectionId: "x".repeat(129) },
      }),
    ).toMatchObject({ ok: false });
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: JIRA,
        board: { projectV2Id: BOARD },
      }),
    ).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "board",
          code: "invalid_value",
        }),
      ],
    });
    // `board: null` next to a Jira project says nothing and is fine.
    expect(
      readNewProjectRequest({
        repositoryId: "r1",
        ticketSource: JIRA,
        board: null,
      }),
    ).toMatchObject({ ok: true });
  });
});
