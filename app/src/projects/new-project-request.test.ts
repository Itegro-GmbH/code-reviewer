// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the body of a new project is held to its shape; every problem has a path, a code, a message and, for a closed set, `available`.
import { describe, expect, it } from "vitest";
import { readNewProjectRequest } from "./new-project-request.ts";

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
      board: { projectV2Id: "not-a-board", color: "red" },
      lanes: ["issue-to-pr", "issue-to-pr", "nothing"],
      extra: 1,
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "extra",
          code: "unknown_field",
          available: ["repositoryId", "board", "lanes"],
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
