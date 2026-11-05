// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_CODES,
  STEP_FAILURE_CODES,
  WORKFLOW_RUN_ERROR_STATUS,
} from "../workflow-runs/errors.ts";
import {
  COST_BASIS_COPY,
  describeRunFailure,
  describeRunPollFailure,
  describeStartFailure,
  describeStepFailure,
  FAILURE_UNKNOWN_TEXT,
} from "./messages.ts";

// The identity of any product: the sentences under test do not depend on which.
const product = {
  name: "Test",
} as unknown as Parameters<typeof describeStartFailure>[0];

describe("the copy of the workflow pages", () => {
  // #873-T20
  it("has a sentence of its own for every code a run can fail with, and never the code", () => {
    for (const code of RUN_FAILURE_CODES) {
      const text = describeRunFailure(code);
      expect(text, code).toBeTruthy();
      expect(text, code).not.toBe(FAILURE_UNKNOWN_TEXT);
      expect(text, code).not.toContain(code);
    }
  });

  // #873-T20
  it("has a sentence of its own for every code a step can fail with, and for the common codes of a job", () => {
    for (const code of [
      ...STEP_FAILURE_CODES,
      "timeout",
      "cost_limit_reached",
      "no_runner_available",
    ]) {
      const text = describeStepFailure(code);
      expect(text, code).toBeTruthy();
      expect(text, code).not.toBe(FAILURE_UNKNOWN_TEXT);
      expect(text, code).not.toContain(code);
    }
  });

  // #873-T21
  it("says that an unknown code is unknown rather than printing it", () => {
    expect(describeStepFailure("some_new_code")).toBe(FAILURE_UNKNOWN_TEXT);
    expect(describeRunFailure("some_new_code")).toBe(FAILURE_UNKNOWN_TEXT);
    // A key of the table's prototype is no code either.
    expect(describeStepFailure("toString")).toBe(FAILURE_UNKNOWN_TEXT);
    expect(describeStepFailure(null)).toBeNull();
    expect(describeRunFailure(null)).toBeNull();
  });

  // #873-T25
  it("names the missing permission of the GitHub App when the message of the step does", () => {
    const text = describeStepFailure(
      "github_permission_missing",
      'The GitHub App of this workspace may not open pull requests: it needs the permission "Pull requests: Read and write". The owner has to grant it.',
    );
    expect(text).toContain('"Pull requests: Read and write"');
    expect(text).not.toContain("github_permission_missing");
    expect(
      describeStepFailure(
        "github_permission_missing",
        'it needs the permission "Issues: Read and write".',
      ),
    ).toContain('"Issues: Read and write"');
  });

  // #873-T25
  it("names no permission that is not one of the two known ones, or when the message has none", () => {
    for (const message of [
      'it needs the permission "Administration: Read and write".',
      "<script>alert(1)</script>",
      null,
    ]) {
      const text = describeStepFailure("github_permission_missing", message);
      expect(text).toContain("lacks a permission this action needs");
      expect(text).not.toContain("Administration");
      expect(text).not.toContain("script");
    }
  });

  // #873-T26
  it("says that GitHub's rate limit was reached, and that an action that creates something may have happened after an error of GitHub's own", () => {
    expect(describeStepFailure("github_rate_limited")).toContain(
      "rate limit was reached",
    );
    const lost = describeStepFailure(
      "github_unavailable",
      "GitHub could not be reached or did not answer in time. The action may have happened; check GitHub before starting again.",
    );
    expect(lost).toContain("may have happened");
    // An idempotent action says nothing of the kind, and neither does the sentence.
    expect(
      describeStepFailure(
        "github_unavailable",
        "GitHub could not be reached or did not answer in time.",
      ),
    ).not.toContain("may have happened");
    // The two codes that are about an unknown outcome say it in their own sentence.
    expect(describeStepFailure("action_timeout")).toContain(
      "may have happened",
    );
    expect(describeStepFailure("action_interrupted")).toContain(
      "may have happened",
    );
  });

  // #873-T22
  it("explains each cost basis in a sentence", () => {
    for (const basis of ["reported", "estimated", "limit"] as const) {
      expect(COST_BASIS_COPY[basis].label).toBeTruthy();
      expect(COST_BASIS_COPY[basis].explanation.length).toBeGreaterThan(20);
    }
    expect(COST_BASIS_COPY.estimated.label).toBe("estimated");
    expect(COST_BASIS_COPY.limit.label).toContain("limit");
  });

  // #873-T23
  it("has a sentence for every code the run routes answer with", () => {
    for (const code of Object.keys(WORKFLOW_RUN_ERROR_STATUS)) {
      const text = describeStartFailure(product, { code, status: 400 });
      expect(text, code).toBeTruthy();
      expect(text, code).not.toContain(code);
    }
    expect(
      describeStartFailure(product, { code: "NETWORK_ERROR", status: null }),
    ).toContain("could not be reached");
    expect(
      describeStartFailure(product, { code: "mystery", status: 500 }),
    ).toContain("Something went wrong");
  });

  // #873-T24
  it("tells a poll that ended for good apart from one that keeps trying", () => {
    expect(describeRunPollFailure(product, "NETWORK_ERROR", false)).toContain(
      "keeps trying",
    );
    expect(
      describeRunPollFailure(product, "WORKFLOW_RUN_NOT_FOUND", true),
    ).toContain("no longer exists");
    expect(describeRunPollFailure(product, "not_found", true)).toContain(
      "no longer updates",
    );
  });
});
