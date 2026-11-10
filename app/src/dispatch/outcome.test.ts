// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_SCHEDULE_MS,
  BUSY_REST_MS,
  MAX_RETRY_AFTER_SECONDS,
  REJECTED_BACKOFF_MS,
  decideOutcome,
  failureDelayMs,
} from "./outcome.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

describe("the back-off schedule", () => {
  // #326-T03
  it("is 10 s, 30 s, 2 min, 5 min and then 15 min", () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([10_000, 30_000, 120_000, 300_000]);
    expect(
      [1, 2, 3, 4, 5, 6, 40].map((failures) => failureDelayMs(failures)),
    ).toEqual([10_000, 30_000, 120_000, 300_000, 900_000, 900_000, 900_000]);
  });
});

describe("deciding what an answer means for the dispatch", () => {
  // #326-T01
  it("acknowledges a 202 and looks again after the acknowledgement timeout", () => {
    expect(decideOutcome({ kind: "accepted" }, 3, NOW)).toEqual({
      state: "acked",
      nextDispatchAt: after(ACK_TIMEOUT_MS),
      consecutiveFailures: 0,
      acknowledged: true,
      lastStatus: 202,
      lastCode: "accepted",
      alert: false,
    });
  });

  // #326-T03
  it("resends after the acknowledgement timeout when the job was not claimable", () => {
    for (const reason of ["not_claimable", "some_other_reason"])
      expect(decideOutcome({ kind: "ignored", reason }, 2, NOW)).toEqual({
        state: "pending",
        nextDispatchAt: after(ACK_TIMEOUT_MS),
        consecutiveFailures: 0,
        acknowledged: false,
        lastStatus: 200,
        lastCode: "ignored_not_claimable",
        alert: false,
      });
  });

  // #972-T02
  it("waits for an event or the sweep when the receiver is full (reason busy)", () => {
    expect(decideOutcome({ kind: "ignored", reason: "busy" }, 2, NOW)).toEqual({
      state: "pending",
      nextDispatchAt: after(BUSY_REST_MS),
      consecutiveFailures: 0,
      acknowledged: false,
      lastStatus: 200,
      lastCode: "ignored_busy",
      alert: false,
    });
    // Longer than the acknowledgement timeout: no timer or request rings a full dispatcher again.
    expect(BUSY_REST_MS).toBeGreaterThan(ACK_TIMEOUT_MS);
  });

  // #326-T03
  it("stops resending when the receiver cannot run the review kind", () => {
    expect(
      decideOutcome({ kind: "ignored", reason: "not_capable" }, 0, NOW),
    ).toMatchObject({
      state: "stopped",
      lastStatus: 200,
      lastCode: "ignored_not_capable",
      consecutiveFailures: 0,
      alert: false,
    });
  });

  // #326-T03
  it("backs off on a 5xx, a timeout and a network error, one step further each time", () => {
    const kinds = [
      {
        result: { kind: "server_error", status: 502 } as const,
        code: "server_error",
        status: 502,
      },
      { result: { kind: "timeout" } as const, code: "timeout", status: null },
      {
        result: { kind: "network_error" } as const,
        code: "network_error",
        status: null,
      },
    ];
    for (const { result, code, status } of kinds) {
      expect(decideOutcome(result, 0, NOW)).toMatchObject({
        state: "pending",
        nextDispatchAt: after(10_000),
        consecutiveFailures: 1,
        lastStatus: status,
        lastCode: code,
        alert: false,
      });
      expect(decideOutcome(result, 4, NOW)).toMatchObject({
        nextDispatchAt: after(900_000),
        consecutiveFailures: 5,
      });
    }
  });

  // #326-T04
  it("lets a Retry-After that is longer than the schedule win on 429 and 503", () => {
    expect(
      decideOutcome(
        { kind: "retry_later", status: 429, retryAfterSeconds: 600 },
        0,
        NOW,
      ),
    ).toMatchObject({
      nextDispatchAt: after(600_000),
      consecutiveFailures: 1,
      lastStatus: 429,
      lastCode: "rate_limited",
    });
    expect(
      decideOutcome(
        { kind: "retry_later", status: 503, retryAfterSeconds: 3600 },
        3,
        NOW,
      ),
    ).toMatchObject({
      nextDispatchAt: after(3_600_000),
      lastStatus: 503,
      lastCode: "unavailable",
    });
  });

  // #326-T04
  it("keeps the schedule when Retry-After is shorter or missing, and caps an absurd header", () => {
    expect(
      decideOutcome(
        { kind: "retry_later", status: 429, retryAfterSeconds: 1 },
        1,
        NOW,
      ).nextDispatchAt,
    ).toEqual(after(30_000));
    expect(
      decideOutcome(
        { kind: "retry_later", status: 503, retryAfterSeconds: null },
        1,
        NOW,
      ).nextDispatchAt,
    ).toEqual(after(30_000));
    expect(
      decideOutcome(
        { kind: "retry_later", status: 503, retryAfterSeconds: 10 ** 9 },
        0,
        NOW,
      ).nextDispatchAt,
    ).toEqual(after(MAX_RETRY_AFTER_SECONDS * 1000));
  });

  // #326-T05
  it("waits long on any other answer and raises an alert", () => {
    for (const status of [400, 401, 403, 404, 413, 302, 204])
      expect(decideOutcome({ kind: "rejected", status }, 0, NOW)).toEqual({
        state: "pending",
        nextDispatchAt: after(REJECTED_BACKOFF_MS),
        consecutiveFailures: 1,
        acknowledged: false,
        lastStatus: status,
        lastCode: "rejected",
        alert: true,
      });
    expect(REJECTED_BACKOFF_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
