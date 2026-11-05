// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { isDirectPredecessorSnapshot } from "./implementer-snapshots-repository.ts";

describe("which snapshot a turn is offered (#885)", () => {
  // #885-U01
  it("offers the snapshot of the directly preceding turn only", () => {
    expect(isDirectPredecessorSnapshot(1, 2)).toBe(true);
    expect(isDirectPredecessorSnapshot(2, 3)).toBe(true);
  });

  // #885-U02
  it("offers nothing older than that, nor the turn's own or a later one", () => {
    expect(isDirectPredecessorSnapshot(1, 3)).toBe(false);
    expect(isDirectPredecessorSnapshot(2, 2)).toBe(false);
    expect(isDirectPredecessorSnapshot(3, 2)).toBe(false);
  });
});
