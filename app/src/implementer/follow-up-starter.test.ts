// SPDX-License-Identifier: LicenseRef-Proprietary

// The starter of queued instructions (#841): it looks for idle sessions that hold one and starts each; it never throws.
import { describe, expect, it, vi } from "vitest";
import {
  DUE_FOLLOW_UP_LIMIT,
  createQueuedFollowUpStarter,
} from "./follow-up-starter.ts";
import type { StartQueuedOutcome } from "./follow-up.ts";

function starter(
  due: Array<{ workspaceId: string; sessionId: string }>,
  outcomes: Record<string, StartQueuedOutcome | Error>,
) {
  const lines: string[] = [];
  const start = vi.fn(async (_workspaceId: string, sessionId: string) => {
    const outcome = outcomes[sessionId] ?? { status: "nothing" as const };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const dueFn = vi.fn(() => Promise.resolve(due));
  const log = {
    info: (line: string) => void lines.push(line),
    error: (line: string) => void lines.push(line),
  };
  return {
    lines,
    start,
    dueFn,
    run: () =>
      createQueuedFollowUpStarter({ due: dueFn, start, log }).startDue(),
  };
}

describe("starting the queued instructions", () => {
  // #841-S01
  it("starts each session that has one and counts what became of it", async () => {
    const s = starter(
      [
        { workspaceId: "w1", sessionId: "a" },
        { workspaceId: "w2", sessionId: "b" },
        { workspaceId: "w2", sessionId: "c" },
        { workspaceId: "w3", sessionId: "d" },
      ],
      {
        a: { status: "started", runId: "job-a" },
        b: { status: "discarded", reason: "branch_gone" },
        c: { status: "retry" },
        d: { status: "nothing" },
      },
    );

    expect(await s.run()).toEqual({
      started: 1,
      discarded: 1,
      retry: 1,
      failed: 0,
    });
    expect(s.start).toHaveBeenCalledWith("w1", "a");
    expect(s.dueFn).toHaveBeenCalledWith(DUE_FOLLOW_UP_LIMIT);
  });

  // #841-S02: an error must never fail the end of a turn, and one session must not stop the others
  it("counts a failure, logs a stable word without the error, and goes on with the others", async () => {
    const s = starter(
      [
        { workspaceId: "w1", sessionId: "a" },
        { workspaceId: "w1", sessionId: "b" },
      ],
      {
        a: new Error("postgres://user:secret@db/x"),
        b: { status: "started", runId: "job-b" },
      },
    );

    expect(await s.run()).toEqual({
      started: 1,
      discarded: 0,
      retry: 0,
      failed: 1,
    });
    expect(s.lines).toEqual(["[implementer] FOLLOW_UP_START_FAILED session=a"]);
    expect(s.lines.join("\n")).not.toContain("secret");
  });

  // #841-S03
  it("does not throw when the lookup itself fails", async () => {
    const lines: string[] = [];
    const run = createQueuedFollowUpStarter({
      due: async () => {
        throw new Error("connection refused");
      },
      start: async () => ({ status: "nothing" }),
      log: { info: () => undefined, error: (line) => void lines.push(line) },
    });

    expect(await run.startDue()).toEqual({
      started: 0,
      discarded: 0,
      retry: 0,
      failed: 1,
    });
    expect(lines).toEqual(["[implementer] FOLLOW_UP_LOOKUP_FAILED"]);
  });

  // #841-S04: the hook is idempotent: a second run finds nothing
  it("finds nothing to do when nothing is due", async () => {
    const s = starter([], {});

    expect(await s.run()).toEqual({
      started: 0,
      discarded: 0,
      retry: 0,
      failed: 0,
    });
    expect(s.start).not.toHaveBeenCalled();
  });
});
