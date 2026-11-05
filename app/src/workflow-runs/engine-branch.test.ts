// SPDX-License-Identifier: LicenseRef-Proprietary

// #846: the name of the branch a session of its own works on.
import { describe, expect, it } from "vitest";
import { checkBranchName } from "../implementer/branch-name.ts";
import { ID_PATTERN } from "../workflows/check-steps.ts";
import { sessionBranchOf } from "./engine.ts";

const run = { id: "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab" };

describe("the branch of a session", () => {
  // #846-T142
  it("names the first session of a step after the run and the step, and a later one with the round", () => {
    expect(sessionBranchOf(run, { stepId: "review", round: 1 })).toBe(
      `workflow/${run.id}/review`,
    );
    expect(sessionBranchOf(run, { stepId: "review", round: 2 })).toBe(
      `workflow/${run.id}/review.r2`,
    );
  });

  // #846-T143
  it("cannot name two sessions alike: a step called like the later round of another is another branch", () => {
    // `review-r2` is a legal step id; the suffix of a round holds a character no step id can hold.
    expect(ID_PATTERN.test("review-r2")).toBe(true);
    expect(ID_PATTERN.test("review.r2")).toBe(false);
    expect(sessionBranchOf(run, { stepId: "review", round: 2 })).not.toBe(
      sessionBranchOf(run, { stepId: "review-r2", round: 1 }),
    );
    expect(sessionBranchOf(run, { stepId: "review-r2", round: 2 })).not.toBe(
      sessionBranchOf(run, { stepId: "review", round: 2 }),
    );
  });

  // #846-T144
  it("is a name the Implementer takes, also for the longest step id and round", () => {
    const longest = "a".repeat(64);
    for (const round of [1, 2, 10])
      expect(
        checkBranchName(
          sessionBranchOf(run, { stepId: longest, round }),
          "main",
        ),
      ).toMatchObject({ ok: true });
  });
});
