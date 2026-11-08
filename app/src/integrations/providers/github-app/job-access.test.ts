// SPDX-License-Identifier: LicenseRef-Proprietary

// The permissions of the tokens the App hands out: a review job's stay what they were, the Implementer's is
// exactly what pushing a branch needs.
import { describe, expect, it } from "vitest";
import {
  BOARD_STATUS_TOKEN_PERMISSIONS,
  IMPLEMENTER_TOKEN_PERMISSIONS,
  JOB_TOKEN_PERMISSIONS,
  PULL_REQUEST_ACTION_TOKEN_PERMISSIONS,
  REVIEW_REQUEST_TOKEN_PERMISSIONS,
  WORKFLOW_ACTION_TOKEN_PERMISSIONS,
  toImplementerAccessError,
  toWriteError,
} from "./job-access.ts";
import { GithubAppError } from "./errors.ts";

describe("the token permissions of the action that opens a pull request", () => {
  // #913-T01
  it("are pull requests write, contents read and metadata read: without contents GitHub cannot resolve the head and base refs", () => {
    expect(PULL_REQUEST_ACTION_TOKEN_PERMISSIONS).toStrictEqual({
      pull_requests: "write",
      contents: "read",
      metadata: "read",
    });
  });
});

describe("the token permissions of the workflow actions (#917)", () => {
  // #917-T400
  it.each([
    [
      "pullRequest.open",
      { pull_requests: "write", contents: "read", metadata: "read" },
    ],
    [
      "github.pullRequest.open",
      { pull_requests: "write", contents: "read", metadata: "read" },
    ],
    ["pullRequest.comment", { issues: "write", metadata: "read" }],
    ["ticket.comment", { issues: "write", metadata: "read" }],
    ["github.issue.comment", { issues: "write", metadata: "read" }],
    ["ticket.labels", { issues: "write", metadata: "read" }],
    ["github.issue.labels", { issues: "write", metadata: "read" }],
    [
      "ticket.setStatus",
      { organization_projects: "write", issues: "read", metadata: "read" },
    ],
    ["ticket.requestReview", { pull_requests: "write", metadata: "read" }],
  ])("%s asks for exactly %j", (connector, permissions) => {
    expect(WORKFLOW_ACTION_TOKEN_PERMISSIONS[connector]).toStrictEqual(
      permissions,
    );
  });

  // #917-T401
  it("ask for the projects of the owner only for the board, and for pull requests only to open them and to ask for a review", () => {
    expect(REVIEW_REQUEST_TOKEN_PERMISSIONS).toStrictEqual({
      pull_requests: "write",
      metadata: "read",
    });
    expect(BOARD_STATUS_TOKEN_PERMISSIONS).toStrictEqual({
      organization_projects: "write",
      issues: "read",
      metadata: "read",
    });
    const needing = (permission: string) =>
      Object.entries(WORKFLOW_ACTION_TOKEN_PERMISSIONS)
        .filter(([, held]) => permission in held)
        .map(([name]) => name)
        .sort();
    expect(needing("organization_projects")).toEqual(["ticket.setStatus"]);
    expect(needing("pull_requests")).toEqual([
      "github.pullRequest.open",
      "pullRequest.open",
      "ticket.requestReview",
    ]);
  });
});

describe("the reason GitHub gave for a refusal", () => {
  const refused = (duringTokenRequest: boolean) =>
    new GithubAppError("GITHUB_APP_REQUEST_FAILED", "GitHub answered 422.", {
      status: 422,
      reason: "PullRequest head invalid",
      duringTokenRequest,
    });

  // #913-T02
  it("is the detail of a refused call, and of no refused token request", () => {
    expect(toWriteError(refused(false))).toMatchObject({
      code: "INTEGRATION_REQUEST_REFUSED",
      detail: "PullRequest head invalid",
    });
    expect(toWriteError(refused(true)).detail).toBeNull();
  });
});

describe("the token permissions of the Implementer", () => {
  // #749-T04
  it("are contents write and metadata read, and nothing else", () => {
    expect(IMPLEMENTER_TOKEN_PERMISSIONS).toStrictEqual({
      contents: "write",
      metadata: "read",
    });
  });

  // #749-T04
  it("do not reach pull requests, issues or workflows", () => {
    for (const name of ["pull_requests", "issues", "workflows", "checks"])
      expect(IMPLEMENTER_TOKEN_PERMISSIONS).not.toHaveProperty(name);
  });

  // #749-T07
  it("leave the token of a review job as it was: contents read", () => {
    expect(JOB_TOKEN_PERMISSIONS).toStrictEqual({
      pull_requests: "write",
      issues: "write",
      contents: "read",
      metadata: "read",
    });
  });
});

describe("the failure of the token request of the Implementer", () => {
  const refusal = (
    refusal: GithubAppError["refusal"],
    status = 422,
    duringTokenRequest = true,
  ) =>
    new GithubAppError("GITHUB_APP_REQUEST_FAILED", "GitHub answered.", {
      status,
      duringTokenRequest,
      ...(refusal === undefined ? {} : { refusal }),
    });

  // #749-T05
  it("maps a 422 about a permission the installation has not accepted to its own stable code, not retryable", () => {
    const error = toImplementerAccessError(refusal("permission_missing"));

    expect(error).toMatchObject({
      code: "INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED",
      retryable: false,
    });
  });

  // #749-T05
  it("keeps the scope refused code for a repository the installation does not have", () => {
    expect(
      toImplementerAccessError(refusal("repository_not_accessible")).code,
    ).toBe("INTEGRATION_ACCESS_SCOPE_REFUSED");
  });

  // #749-T05
  it("treats the other failures like any job access failure", () => {
    expect(
      toImplementerAccessError(
        new GithubAppError("GITHUB_APP_NOT_FOUND", "gone", {
          status: 404,
          duringTokenRequest: true,
        }),
      ).code,
    ).toBe("INTEGRATION_ACCESS_CONNECTION_GONE");
    expect(
      toImplementerAccessError(
        new GithubAppError("GITHUB_APP_UNAVAILABLE", "down", { status: 503 }),
      ),
    ).toMatchObject({
      code: "INTEGRATION_ACCESS_UNAVAILABLE",
      retryable: true,
    });
  });
});
