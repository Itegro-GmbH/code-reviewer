// SPDX-License-Identifier: LicenseRef-Proprietary

// What a stored result of a turn gives the session (#754): the last PUSHED commit, the saved OpenCode session and the summary.
// A result without the block, or one that cannot be read, gives nothing, which `recordTurnResult` takes as "keep what is stored"
// (the session still becomes idle).
import { describe, expect, it } from "vitest";
import { turnResultOf } from "./implementer-turn-result.ts";

const block = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  implementer: {
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    pushed: true,
    commits: [],
    filesChanged: [],
    summary: "Added a health endpoint.",
    opencode: { sessionId: "ses_1", version: "1.19.0" },
    ...overrides,
  },
});

const NOTHING = { headCommit: null, opencode: null, summary: null };

describe("the part of a result that belongs to the session", () => {
  // #754-T01
  it("is the pushed head, the OpenCode session and the summary", () => {
    expect(turnResultOf(block())).toEqual({
      headCommit: "b".repeat(40),
      opencode: { sessionId: "ses_1", version: "1.19.0" },
      summary: "Added a health endpoint.",
    });
  });

  // #754-T02
  it("does not name a head that was not pushed", () => {
    expect(turnResultOf(block({ pushed: false }))).toMatchObject({
      headCommit: null,
      summary: "Added a health endpoint.",
    });
    expect(
      turnResultOf(block({ pushed: false, headCommit: null })).headCommit,
    ).toBeNull();
  });

  // #754-T01
  it("keeps the stored summary and OpenCode session when the turn had none", () => {
    expect(turnResultOf(block({ summary: "", opencode: null }))).toEqual({
      headCommit: "b".repeat(40),
      opencode: null,
      summary: null,
    });
  });

  // #754-T02
  it.each([
    ["no result", null],
    ["a result without the block", { ok: false }],
    ["a block that is not an object", { implementer: "x" }],
    [
      "a head that is not a sha",
      { implementer: { headCommit: 5, pushed: true } },
    ],
    ["an array", []],
  ] as const)("gives nothing for %s, and never throws", (_name, stored) => {
    expect(turnResultOf(stored)).toEqual(NOTHING);
  });
});
