// SPDX-License-Identifier: LicenseRef-Proprietary

// The kinds of a job (#752): a project still selects `diff` or `dynamic` and nothing else; the queue knows one more.
import { describe, expect, it } from "vitest";
import {
  JOB_KINDS,
  PROJECT_REVIEW_KINDS,
  isProjectReviewKind,
  projectKindOf,
} from "./job-kind.ts";
import {
  validateProjectSettingsPatch,
  validateWorkspaceSettingsPatch,
} from "../review-settings/validate.ts";

describe("the kinds of a job", () => {
  // #752-T06
  it("keeps the kinds a project can select exactly diff and dynamic", () => {
    expect([...PROJECT_REVIEW_KINDS]).toStrictEqual(["diff", "dynamic"]);
    expect([...JOB_KINDS]).toStrictEqual(["diff", "dynamic", "implementer"]);
  });

  // #752-T06
  it.each([
    ["a project", validateProjectSettingsPatch],
    ["the workspace defaults", validateWorkspaceSettingsPatch],
  ])("refuses implementer as the review kind of %s", (_name, validate) => {
    expect(validate({ reviewKind: "implementer" })).toMatchObject({
      ok: false,
      issues: [{ field: "reviewKind", code: "INVALID_FORMAT" }],
    });
    expect(validate({ reviewKind: "dynamic" })).toMatchObject({ ok: true });
  });

  // #752-T12
  it("prices, counts and chooses models for a turn as for Dynamic Review, the engine it runs on", () => {
    expect(projectKindOf("implementer")).toBe("dynamic");
    expect(projectKindOf("diff")).toBe("diff");
    expect(projectKindOf("dynamic")).toBe("dynamic");
    expect(isProjectReviewKind("implementer")).toBe(false);
    expect(isProjectReviewKind("diff")).toBe(true);
  });
});
