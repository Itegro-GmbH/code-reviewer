// SPDX-License-Identifier: LicenseRef-Proprietary

// The edits of the MCP lists of a lane (#1052): what the lane card and the inspector of an agent step write into the document.
import { describe, expect, it } from "vitest";
import { stepServers, withLaneServer, withStepServer } from "./mcp-edit.ts";
import type { Doc } from "./document.ts";

const lane = (over: Doc = {}): Doc => ({
  version: 1,
  name: "L",
  triggers: [
    {
      id: "t",
      kind: "manual",
      steps: [{ id: "pre", kind: "agent", mcp: ["a", "b"] }],
    },
  ],
  steps: [
    { id: "one", kind: "agent" },
    { id: "two", kind: "agent", mcp: ["a"] },
    {
      id: "loop",
      kind: "loop",
      body: [{ id: "three", kind: "agent", mcp: ["b", "c"] }],
    },
  ],
  ...over,
});

describe("the servers of the lane", () => {
  // #1052-T01
  it("adds a server at the end of the list and takes the key out when the list is empty", () => {
    const one = withLaneServer(lane(), "a", true);
    const two = withLaneServer(one, "b", true);

    expect(two.mcp).toEqual(["a", "b"]);
    expect(
      withLaneServer(withLaneServer(two, "a", false), "b", false),
    ).not.toHaveProperty("mcp");
    // Naming a server twice changes nothing.
    expect(withLaneServer(two, "a", true).mcp).toEqual(["a", "b"]);
  });

  // #1052-T01
  it("takes a server the lane drops out of the lists of the steps too, at every depth, so no step names what its lane does not", () => {
    const start = lane({ mcp: ["a", "b", "c"] });

    const next = withLaneServer(start, "b", false);

    expect(next.mcp).toEqual(["a", "c"]);
    const pre = (next.triggers as Doc[])[0]!.steps as Doc[];
    expect(pre[0]!.mcp).toEqual(["a"]);
    const steps = next.steps as Doc[];
    expect(steps[0]).not.toHaveProperty("mcp");
    expect(steps[1]!.mcp).toEqual(["a"]);
    expect(((steps[2]!.body as Doc[])[0] as Doc).mcp).toEqual(["c"]);
    // The document it started from is not changed.
    expect(start.mcp).toEqual(["a", "b", "c"]);
  });

  // #1052-T01
  it("keeps an empty list of a step empty when the lane drops a server: `none` stays none", () => {
    const start = lane({ mcp: ["a"] });
    (start.steps as Doc[])[1]!.mcp = [];

    expect((withLaneServer(start, "a", false).steps as Doc[])[1]!.mcp).toEqual(
      [],
    );
  });
});

describe("the servers of a step", () => {
  // #1052-T01
  it("follows the lane while it names none, and has its own list once it does", () => {
    expect(stepServers({ id: "x", kind: "agent" })).toBeUndefined();
    expect(stepServers({ id: "x", kind: "agent", mcp: [] })).toEqual([]);
    expect(stepServers({ id: "x", kind: "agent", mcp: ["a"] })).toEqual(["a"]);
    expect(stepServers({ id: "x", kind: "agent", mcp: "a" })).toEqual([]);
  });

  // #1052-T01
  it("writes the list of the unchecked-down lane: one server less is an explicit list, none is [], and all of them is the lane's own list again", () => {
    const start = lane({ mcp: ["a", "b", "c"] });
    const at = "/steps/0";

    const less = withStepServer(start, at, ["a", "b", "c"], "b", false);
    expect((less.steps as Doc[])[0]!.mcp).toEqual(["a", "c"]);
    const again = withStepServer(less, at, ["a", "b", "c"], "b", true);
    expect((again.steps as Doc[])[0]).not.toHaveProperty("mcp");
    let none = start;
    for (const id of ["a", "b", "c"])
      none = withStepServer(none, at, ["a", "b", "c"], id, false);
    expect((none.steps as Doc[])[0]!.mcp).toEqual([]);
  });

  // #1052-T01
  it("takes a server the lane does not have out of a step's own list; what is left may be all of the lane's, which is the lane's own list again", () => {
    const start = lane({ mcp: ["a", "b"] });
    (start.steps as Doc[])[1]!.mcp = ["a", "z"];

    const next = withStepServer(start, "/steps/1", ["a", "b"], "z", false);

    expect((next.steps as Doc[])[1]!.mcp).toEqual(["a"]);
  });
});
