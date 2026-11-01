// SPDX-License-Identifier: LicenseRef-Proprietary

// #195 finding 1: the operator owns the deadline after which a job no capable runner claims is
// cancelled. A missing or unusable value must keep the default, so a typo never disables the bound.
import { describe, expect, it } from "vitest";
import {
  configuredNoCapableRunnerMs,
  DEFAULT_JOB_QUEUE_LIMITS,
  DEFAULT_NO_CAPABLE_RUNNER_MS,
  IMPLEMENTER_MAX_ATTEMPTS,
  NO_CAPABLE_RUNNER_VARIABLE,
} from "./job-limits.ts";

describe("the no-capable-runner deadline", () => {
  it("reads seconds from the operator variable", () => {
    expect(
      configuredNoCapableRunnerMs({ [NO_CAPABLE_RUNNER_VARIABLE]: "600" }),
    ).toBe(600_000);
  });

  it.each([undefined, "", "  ", "soon", "0", "-5", "NaN"])(
    "keeps the default for %s",
    (value) => {
      expect(
        configuredNoCapableRunnerMs({ [NO_CAPABLE_RUNNER_VARIABLE]: value }),
      ).toBe(DEFAULT_NO_CAPABLE_RUNNER_MS);
    },
  );
});

describe("the limits of the Implementer's turns", () => {
  // #752-T07
  it("never retries a turn: a second run would meet the branch the first one pushed", () => {
    expect(IMPLEMENTER_MAX_ATTEMPTS).toBe(1);
  });

  // #752-T08
  it("holds a turn for 70 minutes, the Dispatcher's 60 plus 10 of grace, and the other kinds for 25", () => {
    expect(DEFAULT_JOB_QUEUE_LIMITS.implementerMaxRuntimeMs).toBe(70 * 60_000);
    expect(DEFAULT_JOB_QUEUE_LIMITS.maxRuntimeMs).toBe(25 * 60_000);
    expect(DEFAULT_JOB_QUEUE_LIMITS.maxAttempts).toBe(3);
  });
});
