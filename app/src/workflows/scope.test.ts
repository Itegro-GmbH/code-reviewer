// SPDX-License-Identifier: LicenseRef-Proprietary

// The scope of a place in a workflow (#833): what a layer over the scope around it sees and keeps to itself.
import { describe, expect, it } from "vitest";
import { Scope, type Binding } from "./scope.ts";

const binding = (id: string): Binding => ({
  id,
  kind: "action",
  type: { kind: "unknown" },
  unavailable: {},
});

describe("a scope", () => {
  // #833-M1-T390
  it("is seen through by a child, and a child keeps what it sets to itself", () => {
    const outer = new Scope();
    outer.set("a", binding("a"));
    const inner = outer.child();
    inner.set("b", binding("b"));

    expect(inner.get("a")?.id).toBe("a");
    expect(inner.get("b")?.id).toBe("b");
    expect(outer.get("b")).toBeUndefined();
    expect([...inner.keys()]).toEqual(["a", "b"]);
    expect([...outer.keys()]).toEqual(["a"]);
    expect([inner.size, outer.size]).toEqual([2, 1]);
  });

  // #833-M1-T391
  it("counts an id once, also when a layer sets it again", () => {
    const outer = new Scope();
    outer.set("a", binding("a"));
    const inner = outer.child();
    const again = { ...binding("a"), kind: "agent" as const };
    inner.set("a", again);

    expect(inner.get("a")).toBe(again);
    expect(outer.get("a")?.kind).toBe("action");
    expect(inner.size).toBe(1);
    expect([...inner.keys()]).toEqual(["a"]);
  });

  // #833-M1-T392
  it("makes a layer without copying what is under it", () => {
    const outer = new Scope();
    for (let i = 0; i < 20_000; i++) outer.set(`s${i}`, binding(`s${i}`));
    const started = performance.now();

    let layer = outer;
    for (let i = 0; i < 20_000; i++) layer = outer.child();

    expect(layer.size).toBe(20_000);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
