// SPDX-License-Identifier: LicenseRef-Proprietary

// The starter of queued instructions (#841): it looks for idle sessions that hold one and starts each; it never throws.
import { describe, expect, it, vi } from "vitest";
import {
  DUE_FOLLOW_UP_LIMIT,
  FOLLOW_UP_RETRY_BACKOFF_MS,
  createQueuedFollowUpStarter,
} from "./follow-up-starter.ts";
import type { StartQueuedOutcome } from "./follow-up.ts";

const NOW = new Date("2026-11-05T12:00:00.000Z");

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
  const dueFn = vi.fn<
    (limit: number, retryAfter: string) => Promise<typeof due>
  >(() => Promise.resolve(due));
  const sessionOfJob = vi.fn((_workspaceId: string, jobId: string) =>
    Promise.resolve(jobId === "no-turn" ? undefined : `session-of-${jobId}`),
  );
  const log = {
    info: (line: string) => void lines.push(line),
    error: (line: string) => void lines.push(line),
  };
  const make = () =>
    createQueuedFollowUpStarter({
      due: dueFn,
      sessionOfJob,
      start,
      now: () => NOW,
      log,
    });
  return {
    lines,
    start,
    dueFn,
    sessionOfJob,
    run: () => make().startDue(),
    runForJob: (jobId: string) =>
      make().startForJob({ id: jobId, workspaceId: "w1" }),
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
    expect(s.dueFn).toHaveBeenCalledWith(
      DUE_FOLLOW_UP_LIMIT,
      new Date(NOW.getTime() - FOLLOW_UP_RETRY_BACKOFF_MS).toISOString(),
    );
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
      sessionOfJob: async () => undefined,
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

  // #841-S05 (review of #871, S2): an event starts the session of its own turn and no other
  it("starts only the session of the turn that ended, whatever else is queued", async () => {
    const s = starter([{ workspaceId: "w1", sessionId: "other" }], {
      "session-of-job-1": { status: "started", runId: "job-new" },
    });

    expect(await s.runForJob("job-1")).toEqual({
      started: 1,
      discarded: 0,
      retry: 0,
      failed: 0,
    });
    expect(s.start).toHaveBeenCalledOnce();
    expect(s.start).toHaveBeenCalledWith("w1", "session-of-job-1");
    expect(s.dueFn).not.toHaveBeenCalled();
  });

  // #841-S06
  it("does nothing for a job that is no turn of a session", async () => {
    const s = starter([], {});

    expect(await s.runForJob("no-turn")).toEqual({
      started: 0,
      discarded: 0,
      retry: 0,
      failed: 0,
    });
    expect(s.start).not.toHaveBeenCalled();
  });

  // #841-S07
  it("does not throw when the session of the job cannot be looked up", async () => {
    const lines: string[] = [];
    const run = createQueuedFollowUpStarter({
      due: async () => [],
      sessionOfJob: async () => {
        throw new Error("connection refused");
      },
      start: async () => ({ status: "nothing" }),
      log: { info: () => undefined, error: (line) => void lines.push(line) },
    });

    expect(await run.startForJob({ id: "job-1", workspaceId: "w1" })).toEqual({
      started: 0,
      discarded: 0,
      retry: 0,
      failed: 1,
    });
    expect(lines).toEqual(["[implementer] FOLLOW_UP_LOOKUP_FAILED"]);
  });
});
