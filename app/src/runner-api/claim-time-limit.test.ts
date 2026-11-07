// SPDX-License-Identifier: LicenseRef-Proprietary

// #918: how long a turn may run, as the claim tells the Worker: the minutes of the turn, else the platform's 3600 seconds.
import { describe, expect, it } from "vitest";
import { IMPLEMENTER_TIME_LIMIT_SECONDS, timeLimitSecondsOf } from "./claim.ts";

describe("the time limit of a turn", () => {
  // #918-T09
  it("is the minutes of the turn in seconds, and 3600 for a turn without a limit of its own", () => {
    expect(timeLimitSecondsOf({ timeLimitMinutes: 15 })).toBe(900);
    expect(timeLimitSecondsOf({ timeLimitMinutes: 60 })).toBe(3600);
    expect(timeLimitSecondsOf({ timeLimitMinutes: null })).toBe(
      IMPLEMENTER_TIME_LIMIT_SECONDS,
    );
    expect(IMPLEMENTER_TIME_LIMIT_SECONDS).toBe(3600);
  });
});
