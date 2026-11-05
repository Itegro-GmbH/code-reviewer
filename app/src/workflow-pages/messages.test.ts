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
