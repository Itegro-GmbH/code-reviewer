// SPDX-License-Identifier: LicenseRef-Proprietary

// The model of the lane builder (#926): finding a node by the pointer of a validator error, and editing the document without changing
// anything else in it.
import { describe, expect, it } from "vitest";
import { issueToPr } from "../../workflows/test-fixtures.ts";
import {
  afterNode,
  agentIds,
  canMove,
  forSave,
  idsIn,
  insertNode,
  isInLoop,
  kindOf,
  moveNode,
  newNode,
  nodeAt,
  normalise,
  patchNode,
  removeNode,
  setAt,
  stepCountOf,
  uniqueId,
  withTriggerKind,
  type Doc,
} from "./document.ts";
import { shippedLane } from "./test-fixtures.ts";

describe("reading the shipped lane", () => {
  // #926-T01
  it("finds a node by the pointer of an error, in a loop body and in the branch of an if", () => {
    const lane = shippedLane();
    expect(nodeAt(lane, "/steps/1/body/1")?.id).toBe("review");
    expect(nodeAt(lane, "/steps/2/else/0")?.id).toBe("stuck");
    expect(nodeAt(lane, "/triggers/1/steps/0")?.id).toBe("mark");
    expect(nodeAt(lane, "/onFailure/1")?.id).toBe("release");
    expect(kindOf(lane, "/triggers/0")).toBe("trigger");
    expect(kindOf(lane, "/steps/1")).toBe("loop");
    expect(kindOf(lane, "/steps/2")).toBe("if");
    expect(kindOf(lane, "/steps/9")).toBeUndefined();
  });

  // #926-T02
  it("counts the steps the way the validator does and knows where a step is in a loop", () => {
    const lane = shippedLane();
    expect(stepCountOf(lane)).toBe(10);
    expect(isInLoop(lane, "/steps/1/body/0")).toBe(true);
    expect(isInLoop(lane, "/steps/2/then/0")).toBe(false);
    expect(agentIds(lane)).toEqual(["implement", "review"]);
    expect(idsIn(lane)).toContain("mark");
  });
});

describe("a document written before several triggers", () => {
  // #926-T03
  it("is edited as one trigger with the id the engine gives it, in the place the old key had", () => {
    const old = issueToPr();
    const normal = normalise(old) as Doc;
    expect(Object.keys(normal)).toEqual([
      "version",
      "name",
      "triggers",
      "budgetUsd",
      "steps",
    ]);
    expect(normal.triggers).toEqual([
      {
        id: "labeled",
        kind: "github.issueLabeled",
        label: "ready for agent",
        steps: [],
      },
    ]);
    expect(normalise("not a document")).toBeUndefined();
    expect(normalise([])).toBeUndefined();
  });

  // #926-T03b
  it("is saved in its old shape until the trigger is touched, then with triggers", () => {
    const old = issueToPr();
    const normal = normalise(old) as Doc;
    const renamed = setAt(normal, "/name", "Other") as Doc;
    const keptOld = forSave(renamed, old);
    expect(keptOld).toEqual({ ...old, name: "Other" });
    expect(Object.keys(keptOld)).toEqual(Object.keys(old));
    const edited = setAt(normal, "/triggers/0/label", "go") as Doc;
    expect(forSave(edited, old)).toBe(edited);
    const withSteps = setAt(normal, "/triggers/0/steps", [
      { id: "a", kind: "action", connector: "ticket.comment" },
    ]) as Doc;
    expect(forSave(withSteps, old)).toBe(withSteps);
    const now = shippedLane() as Doc;
    expect(forSave(now, now)).toBe(now);
  });
});

describe("editing", () => {
  // #926-T04
  it("changes one field and leaves every other node as the same object", () => {
    const lane = shippedLane();
    const next = patchNode(lane, "/steps/0", { add: undefined, remove: ["x"] });
    expect(nodeAt(next, "/steps/0")).toEqual({
      id: "start",
      kind: "action",
      connector: "ticket.labels",
      ticket: "{{trigger.ticket}}",
      remove: ["x"],
    });
    expect((next.steps as unknown[])[1]).toBe((lane.steps as unknown[])[1]);
    expect(lane).toEqual(shippedLane());
  });

  // #926-T05
  it("inserts a step after a node, in a loop body and in an else that did not exist", () => {
    const lane = shippedLane();
    const after = afterNode("/steps/0");
    expect(after).toEqual({ list: "/steps", index: 1 });
    const inserted = insertNode(lane, "/steps", 1, newNode(lane, "action"));
    expect(inserted.pointer).toBe("/steps/1");
    expect(nodeAt(inserted.doc, "/steps/2")?.id).toBe("fix");

    const plain = setAt(lane, "/steps/2/else", undefined);
    expect(nodeAt(plain, "/steps/2")).not.toHaveProperty("else");
    const withElse = insertNode(
      plain,
      "/steps/2/else",
      0,
      newNode(plain, "action"),
    );
    expect(nodeAt(withElse.doc, "/steps/2/else/0")?.kind).toBe("action");
  });

  // #926-T06
  it("removes a step and leaves out an else or onFailure that has no step left", () => {
    const lane = shippedLane();
    const noStuck = removeNode(lane, "/steps/2/else/0");
    expect(nodeAt(noStuck.doc, "/steps/2")).not.toHaveProperty("else");
    expect(noStuck.selection).toBe("/steps/2");
    const one = removeNode(lane, "/onFailure/1");
    expect(one.selection).toBe("/onFailure/0");
    const none = removeNode(one.doc, "/onFailure/0");
    expect(none.doc).not.toHaveProperty("onFailure");
    expect(stepCountOf(none.doc)).toBe(8);
  });

  // #926-T07
  it("moves a step up and down within its list only", () => {
    const lane = shippedLane();
    expect(canMove(lane, "/steps/0", -1)).toBe(false);
    expect(canMove(lane, "/steps/0", 1)).toBe(true);
    expect(canMove(lane, "/triggers/0", 1)).toBe(false);
    const moved = moveNode(lane, "/steps/0", 1);
    expect(moved.pointer).toBe("/steps/1");
    expect(nodeAt(moved.doc, "/steps/0")?.id).toBe("fix");
    expect(nodeAt(moved.doc, "/steps/1")?.id).toBe("start");
    expect(moveNode(lane, "/steps/0", -1).doc).toBe(lane);
  });

  // #926-T08
  it("gives a new step an id nobody has and no environment, since the profile says where it runs (#919)", () => {
    const lane = shippedLane();
    expect(uniqueId(lane, "agent")).toBe("agent");
    expect(uniqueId(lane, "fix")).toBe("fix2");
    const agent = newNode(lane, "agent", { profile: "reviewer" });
    expect(agent).toMatchObject({
      kind: "agent",
      profile: "reviewer",
      session: "new",
    });
    expect(agent).not.toHaveProperty("environment");
    const bare = newNode({ steps: [] }, "agent");
    expect(bare).not.toHaveProperty("environment");
    expect(newNode(lane, "loop")).toMatchObject({
      kind: "loop",
      maxRounds: 3,
      body: [],
    });
    expect(newNode(lane, "if")).toMatchObject({ kind: "if", then: [] });
  });

  // #926-T09
  it("starts the fields of the new kind when a trigger changes its kind", () => {
    const lane = shippedLane();
    const scheduled = withTriggerKind(lane, "/triggers/0", "schedule");
    expect(nodeAt(scheduled, "/triggers/0")).toEqual({
      id: "labeled",
      kind: "schedule",
      cron: "0 2 * * *",
      steps: [],
    });
    const manual = withTriggerKind(lane, "/triggers/0", "manual");
    expect(nodeAt(manual, "/triggers/0")?.input).toMatchObject({
      required: ["ticket"],
    });
  });
});
