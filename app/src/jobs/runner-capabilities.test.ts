// SPDX-License-Identifier: LicenseRef-Proprietary

// Which job kinds a runner's engines can run (#195, #746, #752): the engine `implementer` serves the kind `implementer`
// and nothing else, and no other engine serves it.
import { describe, expect, it } from "vitest";
import { reviewKindsForEngines } from "./runner-capabilities.ts";

describe("the kinds of an engine", () => {
  // #752-T04
  it("gives the engine implementer the kind implementer and no other, and the other engines their own kinds only", () => {
    expect(reviewKindsForEngines(["implementer"])).toStrictEqual([
      "implementer",
    ]);
    expect(reviewKindsForEngines(["pr-agent"])).toStrictEqual(["diff"]);
    expect(reviewKindsForEngines(["opencode"])).toStrictEqual(["dynamic"]);
    expect(reviewKindsForEngines(["pr-agent", "opencode"])).toStrictEqual([
      "diff",
      "dynamic",
    ]);
    expect(
      reviewKindsForEngines(["pr-agent", "opencode", "implementer"]),
    ).toStrictEqual(["diff", "dynamic", "implementer"]);
  });
});
