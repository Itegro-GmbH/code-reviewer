// SPDX-License-Identifier: LicenseRef-Proprietary

// How many turns one self-hosted runner may run at the same time (#1105, ADR 0007, "Concurrency"): the `parallelRuns` it announced, held
// within the operator's maximum.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PARALLEL_RUNS,
  maxParallelRuns,
  runnerConcurrency,
} from "./config.ts";

describe("the concurrency of a self-hosted runner", () => {
  // #1105-R100
  it("has an operator's maximum of 16 unless a whole number from 1 to 1000 is set", () => {
    expect(maxParallelRuns({})).toBe(DEFAULT_MAX_PARALLEL_RUNS);
    expect(DEFAULT_MAX_PARALLEL_RUNS).toBe(16);
    const set = (value: string) =>
      maxParallelRuns({ RUNNER_MAX_PARALLEL_RUNS: value });
    expect(set("4")).toBe(4);
    expect(set(" 1000 ")).toBe(1000);
    for (const bad of ["0", "-3", "2.5", "lots", "", "1001", "1e2"])
      expect(set(bad)).toBe(DEFAULT_MAX_PARALLEL_RUNS);
  });

  // #1105-R101
  it("is what the runner announced, held within the maximum; a runner that announced none gets the maximum", () => {
    expect(runnerConcurrency({ parallelRuns: 3 }, {})).toBe(3);
    expect(runnerConcurrency({ parallelRuns: 64 }, {})).toBe(16);
    expect(
      runnerConcurrency(
        { parallelRuns: 64 },
        { RUNNER_MAX_PARALLEL_RUNS: "8" },
      ),
    ).toBe(8);
    expect(runnerConcurrency({}, {})).toBe(16);
    expect(runnerConcurrency({}, { RUNNER_MAX_PARALLEL_RUNS: "2" })).toBe(2);
  });
});
