// SPDX-License-Identifier: LicenseRef-Proprietary

// The online runners and what they announce (#973): the question the validator asks of the runners of a workspace.
import { describe, expect, it } from "vitest";
import type { HarnessAccess } from "./access.ts";
import type { ListedRunner } from "./online.ts";
import { onlineRunnersOf, statusOf } from "./online.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const OPENCODE: HarnessAccess = {
  harness: "opencode",
  version: "1",
  auth: "app-key",
};

const runner = (change: Partial<ListedRunner> = {}): ListedRunner => ({
  labels: ["linux"],
  baseVersion: "1.2.0",
  lastSeenAt: "2026-11-05T11:59:30.000Z",
  manifest: { harnesses: [], capabilities: [] },
  ...change,
});

describe("the online runners and what they announce", () => {
  // #973-T01
  it("lists the runners heard from lately and at the minimum base, with their labels and entries, and no other", async () => {
    const online = runner({
      labels: ["box"],
      manifest: { harnesses: [OPENCODE], capabilities: [] },
    });
    const asleep = runner({ lastSeenAt: "2026-11-05T11:00:00.000Z" });
    const old = runner({ baseVersion: "0.9.0" });

    expect(
      await onlineRunnersOf(
        { list: async () => [online, asleep, old] },
        { minBaseVersion: "1.0.0", onlineWithinSeconds: 120 },
        NOW,
      ),
    ).toEqual([{ labels: ["box"], access: [OPENCODE] }]);
  });

  it("says offline for a runner not heard from, and update needed below the minimum", () => {
    const settings = { minBaseVersion: "1.0.0", onlineWithinSeconds: 120 };

    expect(statusOf(runner(), NOW, settings)).toBe("online");
    expect(
      statusOf(
        runner({ lastSeenAt: "2026-11-05T11:00:00.000Z" }),
        NOW,
        settings,
      ),
    ).toBe("offline");
    expect(statusOf(runner({ baseVersion: "0.9.0" }), NOW, settings)).toBe(
      "update_needed",
    );
  });
});
