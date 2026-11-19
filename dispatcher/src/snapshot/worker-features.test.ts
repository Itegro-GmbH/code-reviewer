// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { parseWorkerFeatures, workerFeaturesValue } from "./worker-features.ts";

describe("the feature list of a Worker image", () => {
  // #1098-T02
  it("reads a comma separated list sorted and without duplicates", () => {
    expect(parseWorkerFeatures("b_feature,a_feature, b_feature")).toEqual([
      "a_feature",
      "b_feature",
    ]);
    expect(parseWorkerFeatures(["b_feature", "a_feature"])).toEqual([
      "a_feature",
      "b_feature",
    ]);
  });

  // #1098-T02
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 3],
    ["an empty string", ""],
    ["blanks", "  "],
    ["none", "none"],
    ["an upper case name", "Feature"],
    ["a name with a space", "a feature"],
    ["one bad name among good ones", "a_feature,bad-name"],
    ["an empty name", "a_feature,"],
    ["a name that is no string", ["a_feature", 1]],
    ["a name that is too long", "a".repeat(65)],
    [
      "more names than a Worker has",
      Array.from({ length: 65 }, (_value, index) => `f${index}`),
    ],
  ])("reads %s as the empty list (fail closed)", (_name, value) => {
    expect(parseWorkerFeatures(value)).toEqual([]);
  });

  // #1098-T02
  it("stores the empty list as `none` and any other list as the joined names", () => {
    expect(workerFeaturesValue([])).toBe("none");
    expect(workerFeaturesValue(["b_feature", "a_feature"])).toBe(
      "a_feature,b_feature",
    );
    expect(parseWorkerFeatures(workerFeaturesValue(["a_feature"]))).toEqual([
      "a_feature",
    ]);
  });
});
