// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator found, placed in the flow (#926): which node an error path belongs to, and when a one-click fix exists.
import { describe, expect, it } from "vitest";
import { patchNode, setAt } from "./document.ts";
import {
  countOf,
  fixOf,
  nodeOfPath,
  sortProblems,
  type Problem,
} from "./problems.ts";
import { answerOf, shippedLane } from "./test-fixtures.ts";

const problem = (
  path: string,
  code: string,
  available?: string[],
): Problem => ({
  path,
  code,
  message: "m",
  ...(available === undefined ? {} : { available }),
});

describe("which node an error belongs to", () => {
  // #926-T10
  it.each([
    ["/steps/2", "/steps/2"],
    ["/steps/2/when/equals/0", "/steps/2"],
    ["/steps/1/body/0/instruction/next", "/steps/1/body/0"],
    ["/steps/2/else/1/add/0", "/steps/2/else/1"],
    ["/steps/1/body/1/then/0/else/3/x", "/steps/1/body/1/then/0/else/3"],
    ["/triggers/1", "/triggers/1"],
    ["/triggers/1/input/properties", "/triggers/1"],
    ["/triggers/1/steps/0/connector", "/triggers/1/steps/0"],
    ["/onFailure/0/body", "/onFailure/0"],
  ])("puts %s at %s", (path, node) => {
    expect(nodeOfPath(path)).toBe(node);
  });

  // #926-T11
  it("leaves the errors about the document as a whole to the header", () => {
    for (const path of [
      "",
      "/budgetUsd",
      "/name",
      "/steps",
      "/triggers",
      "/onFailure",
      "/turnTimeLimitMinutes",
    ])
      expect(nodeOfPath(path)).toBeUndefined();
    const sorted = sortProblems([
      problem("/budgetUsd", "invalid_value"),
      problem("/steps/0/id", "duplicate_id"),
      problem("/steps/0/x", "unknown_field"),
    ]);
    expect(sorted.document.map((entry) => entry.code)).toEqual([
      "invalid_value",
    ]);
    expect(countOf(sorted, "/steps/0")).toBe(2);
    expect(countOf(sorted, "/steps/1")).toBe(0);
  });

  // #926-T12
  it("maps the real errors of a lane that was changed to the steps that were changed", () => {
    let lane = patchNode(shippedLane(), "/steps/1/body/0", {
      profile: "nobody",
    });
    lane = patchNode(lane, "/steps/2/else/0", { body: 5 });
    const sorted = sortProblems(answerOf(lane).errors);
    expect(
      sorted.byNode.get("/steps/1/body/0")?.map((entry) => entry.code),
    ).toContain("profile_unknown");
    expect(sorted.byNode.has("/steps/2/else/0")).toBe(true);
    expect(sorted.document).toEqual([]);
  });
});

describe("a one-click fix", () => {
  // #926-T13
  it("is offered where exactly one name would do", () => {
    const lane = shippedLane();
    expect(
      fixOf(
        setAt(lane, "/steps/1/body/1/environment", "nod"),
        problem("/steps/1/body/1/environment", "environment_unknown", ["node"]),
      ),
    ).toEqual({
      pointer: "/steps/1/body/1/environment",
      value: "node",
      replacement: "node",
    });
    expect(
      fixOf(
        lane,
        problem("/steps/1/body/1/profile", "profile_unknown", ["reviewer"]),
      )?.value,
    ).toBe("reviewer");
  });

  // #926-T14
  it("keeps the profile name when only the version is wrong", () => {
    const lane = patchNode(shippedLane(), "/steps/1/body/1", {
      profile: "reviewer@9",
    });
    expect(
      fixOf(
        lane,
        problem("/steps/1/body/1/profile", "profile_version_unknown", ["1"]),
      )?.value,
    ).toBe("reviewer@1");
  });

  // #926-T15
  it("is not offered for two names, for no name, for a code that has no one right answer, or for a value that is not a text", () => {
    const lane = shippedLane();
    expect(
      fixOf(
        lane,
        problem("/steps/1/body/1/profile", "profile_unknown", ["a", "b"]),
      ),
    ).toBeUndefined();
    expect(
      fixOf(lane, problem("/steps/1/body/1/profile", "profile_unknown", [])),
    ).toBeUndefined();
    expect(
      fixOf(lane, problem("/steps/1/body/1/profile", "profile_unknown")),
    ).toBeUndefined();
    expect(
      fixOf(
        lane,
        problem("/steps/0/ticket", "reference_unknown_step", ["start"]),
      ),
    ).toBeUndefined();
    expect(
      fixOf(
        lane,
        problem("/steps/1/body/0/session", "session_target_invalid", [
          "implement",
        ]),
      ),
    ).toBeUndefined();
    expect(
      fixOf(
        lane,
        problem("/steps/1/body/1/profile", "profile_unknown", [
          "a very long name…",
        ]),
      ),
    ).toBeUndefined();
  });
});
