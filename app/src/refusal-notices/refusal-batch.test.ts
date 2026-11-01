// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { createRefusalBatcher } from "./refusal-batch.ts";
import type { NoticeRefusal } from "./service.ts";

const PERIOD = "2026-10-01T00:00:00.000Z";

function refusal(overrides: Partial<NoticeRefusal> = {}): NoticeRefusal {
  return {
    workspaceId: "w1",
    repositoryId: "r1",
    prNumber: 7,
    triggerKind: "webhook",
    reviewKind: "diff",
    errorCode: "quota_exhausted",
    periodStart: PERIOD,
    ...overrides,
  };
}

function setup() {
  const scheduled: Array<() => Promise<void>> = [];
  const handled: NoticeRefusal[] = [];
  const batcher = createRefusalBatcher({
    schedule: (work) => void scheduled.push(work),
    handle: async (item) => {
      handled.push(item);
    },
  });
  const flush = async () => {
    for (const work of scheduled.splice(0)) await work();
  };
  return { batcher, scheduled, handled, flush };
}

describe("the refusals of one claim, before they are scheduled", () => {
  // #281-P3
  it("schedules one callback for a whole backlog, and one notice per pull request", async () => {
    const t = setup();

    for (let index = 0; index < 100; index += 1)
      t.batcher.add(refusal({ prNumber: 1 + (index % 3) }));

    expect(t.scheduled).toHaveLength(1);
    await t.flush();
    expect(t.handled.map((item) => item.prNumber).sort()).toEqual([1, 2, 3]);
  });

  // #281-P3
  it("keeps the pull requests of other repositories, workspaces and periods apart", async () => {
    const t = setup();

    t.batcher.add(refusal());
    t.batcher.add(refusal({ repositoryId: "r2" }));
    t.batcher.add(refusal({ workspaceId: "w2" }));
    t.batcher.add(refusal({ periodStart: "2026-11-01T00:00:00.000Z" }));
    t.batcher.add(refusal());
    await t.flush();

    expect(t.handled).toHaveLength(4);
  });

  // #281-T07
  it("lets a review somebody asked for decide for the pull request, whatever its place in the backlog", async () => {
    const t = setup();

    t.batcher.add(refusal({ triggerKind: "webhook" }));
    t.batcher.add(refusal({ triggerKind: "manual" }));
    t.batcher.add(refusal({ triggerKind: "webhook" }));
    await t.flush();

    expect(t.handled).toEqual([
      expect.objectContaining({ triggerKind: "manual" }),
    ]);
  });

  it("schedules again for the refusals that come after a flush", async () => {
    const t = setup();
    t.batcher.add(refusal());
    await t.flush();

    t.batcher.add(refusal({ prNumber: 9 }));

    expect(t.scheduled).toHaveLength(1);
    await t.flush();
    expect(t.handled).toHaveLength(2);
  });

  it("never throws into the claim, whatever the scheduler does", () => {
    const batcher = createRefusalBatcher({
      schedule: vi.fn(() => {
        throw new Error("no request");
      }),
      handle: async () => undefined,
    });

    expect(() => batcher.add(refusal())).not.toThrow();
    // The refusals that could not be scheduled are not kept for ever.
    expect(() => batcher.add(refusal())).not.toThrow();
  });
});
