// SPDX-License-Identifier: LicenseRef-Proprietary

// The permissions of the tokens the App hands out: a review job's stay what they were, the Implementer's is
// exactly what pushing a branch needs.
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTER_TOKEN_PERMISSIONS,
  JOB_TOKEN_PERMISSIONS,
  toImplementerAccessError,
} from "./job-access.ts";
import { GithubAppError } from "./errors.ts";

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
