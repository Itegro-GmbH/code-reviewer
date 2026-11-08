// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the built-in lanes a new project copies pass the validator, and "Issue to PR" is the example of the documentation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LANE_KEYS,
  builtInLaneDocument,
  isBuiltInLaneKey,
} from "./built-in-lanes.ts";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

describe("the built-in lanes", () => {
  // #922-T01
  it.each(BUILT_IN_LANE_KEYS)("%s validates clean", (key) => {
    const result = validateWorkflow(
      builtInLaneDocument(key, "node"),
      FAKE_RESOLVER,
      { maxBudgetUsd: 100 },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // #922-T02
  it("Issue to PR is the example of the documentation", () => {
    const example = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../contracts/examples/workflow/Workflow.json",
        ),
        "utf8",
      ),
    ) as unknown;
    expect(builtInLaneDocument("issue-to-pr", "node")).toEqual(example);
  });

  // #922-T03
  it("takes the environment it is given and names the lane", () => {
    const document = JSON.stringify(
      builtInLaneDocument("review-a-pull-request", "Python"),
    );
    expect(document).toContain('"environment":"Python"');
    expect(document).toContain('"name":"Review a pull request"');
  });

  // #966-T01
  it("Issue to PR hands the reviewer the issue and the implementer's report", () => {
    const document = builtInLaneDocument("issue-to-pr", "node") as {
      steps: { id: string; body?: { id: string; instruction?: unknown }[] }[];
    };
    const review = document.steps
      .find((step) => step.id === "fix")
      ?.body?.find((step) => step.id === "review");
    expect(review?.instruction).toEqual(expect.any(String));
    const instruction = String(review?.instruction);
    expect(instruction).toContain("{{trigger.ticket.title}}");
    expect(instruction).toContain("{{trigger.ticket.body}}");
    expect(instruction).toContain("{{implement.summary}}");
  });

  // #922-T04
  it("knows its keys", () => {
    expect(isBuiltInLaneKey("issue-to-pr")).toBe(true);
    expect(isBuiltInLaneKey("nothing")).toBe(false);
    expect(isBuiltInLaneKey(3)).toBe(false);
  });
});
