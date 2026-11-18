// SPDX-License-Identifier: LicenseRef-Proprietary

// The top-level nodes of a lane version as a run walks them (#1078): the pre-steps of the trigger first, the ids inside branches and
// bodies, the words taken from the document cut and folded.
import { describe, expect, it, vi } from "vitest";
import {
  createLaneNodesIndex,
  laneNodesFor,
  laneNodesKey,
  laneNodesOfRun,
} from "./lane-nodes.ts";

const document = JSON.stringify({
  name: "Ship it",
  triggers: [
    {
      id: "by-hand",
      kind: "manual",
      input: { type: "object", properties: {} },
      steps: [{ id: "intake", kind: "action", connector: "ticket.comment" }],
    },
    { id: "label", kind: "ticket.labeled", label: "agent" },
  ],
  steps: [
    { id: "plan", kind: "agent", description: "Plan   the\nwork" },
    {
      id: "check",
      kind: "if",
      then: [{ id: "fix", kind: "agent" }],
      else: [
        {
          id: "again",
          kind: "loop",
          maxRounds: 2,
          body: [{ id: "deep", kind: "action" }],
        },
      ],
    },
    { id: "merge", kind: "action", connector: "pr.merge" },
  ],
});

describe("laneNodesOfRun", () => {
  // #1078-T01
  it("lists the pre-steps of the trigger first, then the shared steps, each with the ids inside it", () => {
    const nodes = laneNodesOfRun(document, { id: "by-hand", kind: "manual" });

    expect(nodes.map((node) => node.id)).toEqual([
      "intake",
      "plan",
      "check",
      "merge",
    ]);
    expect(nodes.find((node) => node.id === "check")?.innerIds).toEqual([
      "fix",
      "again",
      "deep",
    ]);
    expect(nodes.find((node) => node.id === "plan")?.innerIds).toEqual([]);
  });

  // #1078-T06
  it("lists the direct body of a loop, with what is inside each child, and no body for any other node", () => {
    const nested = JSON.stringify({
      triggers: [{ id: "t", kind: "manual" }],
      steps: [
        {
          id: "outer",
          kind: "loop",
          maxRounds: 2,
          body: [
            { id: "work", kind: "agent" },
            {
              id: "inner",
              kind: "loop",
              maxRounds: 3,
              body: [{ id: "deep", kind: "action" }],
            },
          ],
        },
        { id: "plain", kind: "agent" },
      ],
    });

    const [outer, plain] = laneNodesOfRun(nested, { id: "t", kind: "manual" });

    expect(outer?.innerIds).toEqual(["work", "inner", "deep"]);
    expect(outer?.body).toEqual([
      { id: "work", kind: "agent", innerIds: [] },
      { id: "inner", kind: "loop", innerIds: ["deep"] },
    ]);
    expect(plain?.body).toEqual([]);
  });

  // #1078-T02
  it("leaves the pre-steps of another trigger out", () => {
    const nodes = laneNodesOfRun(document, {
      id: "label",
      kind: "ticket.labeled",
    });

    expect(nodes.map((node) => node.id)).toEqual(["plan", "check", "merge"]);
  });

  // #1078-T03
  it("takes the note with its whitespace folded, and the connector of an action", () => {
    const nodes = laneNodesOfRun(document, { id: "by-hand", kind: "manual" });

    expect(nodes.find((node) => node.id === "plan")?.note).toBe(
      "Plan the work",
    );
    expect(nodes.find((node) => node.id === "intake")?.connector).toBe(
      "ticket.comment",
    );
    expect(nodes.find((node) => node.id === "plan")?.connector).toBeNull();
  });

  // #1078-T04
  it("cuts a long note", () => {
    const long = JSON.stringify({
      triggers: [{ id: "t", kind: "manual" }],
      steps: [{ id: "a", kind: "agent", description: "x".repeat(200) }],
    });

    const note = laneNodesOfRun(long, { id: "t", kind: "manual" })[0]?.note;

    expect(note?.length).toBe(81);
    expect(note?.endsWith("…")).toBe(true);
  });

  // #1078-T05
  it("gives no nodes for a version that is gone, unreadable, or without the trigger of the run", () => {
    expect(laneNodesOfRun(undefined, { id: null, kind: "manual" })).toEqual([]);
    expect(laneNodesOfRun("{nope", { id: null, kind: "manual" })).toEqual([]);
    expect(laneNodesOfRun(document, { id: "gone", kind: "manual" })).toEqual(
      [],
    );
  });
});

describe("the nodes of a response, once for each lane version", () => {
  const run = (
    overrides: Partial<Parameters<typeof laneNodesKey>[0]> = {},
  ) => ({
    workflowId: "wf-1",
    workflowVersion: 3,
    triggerKind: "manual",
    triggerId: "by-hand" as string | null,
    ...overrides,
  });

  // #1087-T05
  it("keys the nodes by lane, version and trigger, because the pre-steps of the trigger are part of them", () => {
    expect(laneNodesKey(run())).toBe("wf-1@3|manual|by-hand");
    expect(laneNodesKey(run({ triggerId: null }))).toBe("wf-1@3|manual|");
    expect(laneNodesKey(run({ workflowVersion: 4 }))).not.toBe(
      laneNodesKey(run()),
    );
    expect(
      laneNodesKey(run({ triggerId: "label", triggerKind: "ticket.labeled" })),
    ).not.toBe(laneNodesKey(run()));
  });

  // #1087-T06
  it("reads a version once, and gives a version without nodes no entry and no key", () => {
    const index = createLaneNodesIndex();
    const read = vi.fn(() =>
      laneNodesOfRun(document, { id: "by-hand", kind: "manual" }),
    );

    const first = index.refer(run(), read);
    const again = index.refer(run(), read);
    const gone = vi.fn(() => []);
    const none = index.refer(run({ workflowVersion: 1 }), gone);
    index.refer(run({ workflowVersion: 1 }), gone);

    expect(first).toBe("wf-1@3|manual|by-hand");
    expect(again).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(none).toBeNull();
    expect(gone).toHaveBeenCalledTimes(1);
    expect(Object.keys(index.byKey)).toEqual([first]);
  });

  // #1087-T07
  it("looks the nodes of a run up by its key, and finds none for no key or a key the response lacks", () => {
    const byKey = {
      a: laneNodesOfRun(document, { id: "by-hand", kind: "manual" }),
    };

    expect(laneNodesFor(byKey, "a")).toBe(byKey.a);
    expect(laneNodesFor(byKey, null)).toEqual([]);
    expect(laneNodesFor(byKey, "b")).toEqual([]);
  });
});
