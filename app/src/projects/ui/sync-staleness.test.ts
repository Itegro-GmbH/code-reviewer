// SPDX-License-Identifier: LicenseRef-Proprietary

// When the Setup tab says the tickets may be out of date (#937): the last full sync is older than three days and no delivery wrote a row since.
import { describe, expect, it } from "vitest";
import { STALE_SYNC_DAYS, syncStaleness } from "./sync-staleness.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const state = (overrides: object) => ({
  lastFullSyncAt: ago(5 * DAY),
  inProgress: false,
  lastWriteAt: ago(5 * DAY),
  ...overrides,
});

describe("the stale sync hint", () => {
  // #937-T30
  it("is three days", () => {
    expect(STALE_SYNC_DAYS).toBe(3);
  });

  // #937-T31
  it("shows for a full sync older than three days with no write after it, counting whole days", () => {
    expect(syncStaleness(state({}), NOW)).toEqual({ kind: "stale", days: 5 });
    expect(
      syncStaleness(
        state({ lastFullSyncAt: ago(3 * DAY + 1), lastWriteAt: null }),
        NOW,
      ),
    ).toEqual({ kind: "stale", days: 3 });
  });

  // #937-T32
  it("stays quiet for a recent full sync, exactly three days old included", () => {
    expect(
      syncStaleness(state({ lastFullSyncAt: ago(3 * DAY) }), NOW),
    ).toBeNull();
    expect(syncStaleness(state({ lastFullSyncAt: ago(DAY) }), NOW)).toBeNull();
  });

  // #937-T33
  it("stays quiet when a delivery wrote a row after the full sync", () => {
    expect(syncStaleness(state({ lastWriteAt: ago(2 * DAY) }), NOW)).toBeNull();
    // A write at the same time as the sync is the sync's own.
    expect(
      syncStaleness(state({ lastWriteAt: ago(5 * DAY) }), NOW),
    ).not.toBeNull();
  });

  // #937-T34
  it("says never for a repository that was not read in full, and nothing without a state, while a sync is under way or for a time it cannot read", () => {
    expect(
      syncStaleness(state({ lastFullSyncAt: null, lastWriteAt: null }), NOW),
    ).toEqual({ kind: "never" });
    expect(syncStaleness(null, NOW)).toBeNull();
    expect(
      syncStaleness(state({ inProgress: true, lastFullSyncAt: null }), NOW),
    ).toBeNull();
    expect(
      syncStaleness(state({ lastFullSyncAt: "not a time" }), NOW),
    ).toBeNull();
  });
});
