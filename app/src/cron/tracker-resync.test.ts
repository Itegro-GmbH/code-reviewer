// SPDX-License-Identifier: LicenseRef-Proprietary

// The nightly resync of the ticket mirror (#932): the platform's cron calls it with the shared secret, it syncs every active project with
// the code of the Resync route, one project's failure never stops the others, and a deployment without the factory asks GitHub for nothing.
import { describe, expect, it, vi } from "vitest";
import type { ResyncTarget } from "../tracker/resync-targets.ts";
import {
  abortDelayMs,
  handleTrackerResyncCron,
  RESYNC_ABORT_GRACE_MS,
  RESYNC_HARD_LIMIT_MS,
  resyncProjects,
} from "./tracker-resync.ts";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";

const target = (
  id: string,
  lastAttemptAt: string | null = null,
  integrationId = "i-1",
  unfinished = false,
): ResyncTarget => ({
  workspaceId: "w-1",
  repositoryId: id,
  integrationId,
  lastAttemptAt,
  unfinished,
});

function request(authorization?: string): Request {
  return new Request("https://app.example.test/api/internal/tracker-resync", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function deps(
  overrides: Partial<Parameters<typeof handleTrackerResyncCron>[1]> = {},
) {
  return {
    env: { CRON_SECRET: SECRET },
    enabled: () => true,
    targets: async () => [target("r-1"), target("r-2")],
    resync: vi.fn(async () => ({ status: "done" as const })),
    logFailure: vi.fn(),
    ...overrides,
  };
}

describe("the nightly resync of the ticket mirror", () => {
  // #932-T13
  it("syncs every active project and answers with counts only", async () => {
    const d = deps();

    const response = await handleTrackerResyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(200);
    expect(d.resync).toHaveBeenCalledTimes(2);
    expect(await response.json()).toEqual({
      status: "ok",
      projects: 2,
      done: 2,
      partial: 0,
      failed: 0,
      deferred: 0,
    });
  });

  // #932-T14
  it.each([
    ["no header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["another scheme", `Basic ${SECRET}`],
  ])("answers 401 for %s and syncs nothing", async (_name, header) => {
    const d = deps({ targets: vi.fn(async () => [target("r-1")]) });

    const response = await handleTrackerResyncCron(request(header), d);

    expect(response.status).toBe(401);
    expect(d.targets).not.toHaveBeenCalled();
    expect(d.resync).not.toHaveBeenCalled();
  });

  // #932-T15
  it("does nothing in a deployment without the factory", async () => {
    const d = deps({ enabled: () => false, targets: vi.fn(async () => []) });

    const response = await handleTrackerResyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(await response.json()).toEqual({
      status: "skipped",
      reason: "not_enabled",
    });
    expect(d.targets).not.toHaveBeenCalled();
    expect(d.resync).not.toHaveBeenCalled();
  });

  // #932-T16
  it("goes on with the other projects when one fails, and logs the failed one by its id and the code of the failure", async () => {
    const logFailure = vi.fn();
    const resync = vi.fn(async (t: ResyncTarget) => {
      if (t.repositoryId === "r-1")
        throw Object.assign(new Error("body of the platform's answer"), {
          code: "TRACKER_SYNC_FAILED",
        });
      return { status: "done" as const };
    });

    const response = await handleTrackerResyncCron(
      request(`Bearer ${SECRET}`),
      deps({
        targets: async () => [target("r-1"), target("r-2"), target("r-3")],
        resync,
        logFailure,
      }),
    );

    expect(await response.json()).toMatchObject({
      status: "ok",
      projects: 3,
      done: 2,
      failed: 1,
    });
    expect(resync.mock.calls.map(([t]) => t.repositoryId)).toEqual([
      "r-1",
      "r-2",
      "r-3",
    ]);
    expect(logFailure).toHaveBeenCalledTimes(1);
    const line = String(logFailure.mock.calls[0]?.[0]);
    expect(line).toContain("repository=r-1");
    expect(line).toContain("TRACKER_SYNC_FAILED");
    expect(line).not.toContain("body of the platform");
  });

  // #932-T17
  it("answers 500 without a cause when the projects cannot be listed", async () => {
    const response = await handleTrackerResyncCron(
      request(`Bearer ${SECRET}`),
      deps({
        targets: async () => {
          throw new Error("postgres://user:password@host/db");
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "error",
      code: "TRACKER_RESYNC_FAILED",
    });
  });
});

describe("walking the projects", () => {
  // #932-T18
  it("takes the project attempted longest ago first, one that never was first of all", async () => {
    const order: string[] = [];

    await resyncProjects(
      [
        target("r-new", "2026-11-07T03:00:00.000Z"),
        target("r-old", "2026-11-01T03:00:00.000Z"),
        target("r-never", null),
      ],
      {
        resync: async (t) => {
          order.push(t.repositoryId);
          return { status: "done" };
        },
      },
    );

    expect(order).toEqual(["r-never", "r-old", "r-new"]);
  });

  // #932-T19
  it("continues a project that answers partial until it is done", async () => {
    const answers = ["partial", "partial", "done"] as const;
    let call = 0;

    const counts = await resyncProjects([target("r-1")], {
      resync: async () => ({ status: answers[call++] ?? "done" }),
    });

    expect(call).toBe(3);
    expect(counts).toMatchObject({ done: 1, partial: 0 });
  });

  // #932-T20
  it("stops at its budget: a project it ends in the middle of is partial, the ones not reached are deferred", async () => {
    let clock = 0;
    const seen: string[] = [];

    const counts = await resyncProjects(
      [target("r-1"), target("r-2"), target("r-3")],
      {
        now: () => clock,
        budgetMs: 100,
        minSliceMs: 10,
        resync: async (t, deadline) => {
          seen.push(`${t.repositoryId}@${String(deadline)}`);
          clock += 60;
          return { status: "partial" };
        },
      },
    );

    // r-1 gets a third of the budget (33) and stops there; r-2 gets half of what is left (60 + 20); the budget is gone before r-3.
    expect(seen).toEqual(["r-1@33", "r-2@80"]);
    expect(counts).toEqual({
      projects: 3,
      done: 0,
      partial: 2,
      failed: 0,
      deferred: 1,
    });
  });
});

describe("a project that needs more than the budget (#932)", () => {
  /** A fake of the sync state: what `resyncTargets` would read, and what a sync that ran writes. */
  function nights() {
    let clock = 1_000_000;
    const lastAttempt = new Map<string, string>();
    const unfinished = new Set<string>();
    const huge = "r-0-huge";
    const sync = async (t: ResyncTarget, deadline: number) => {
      if (t.repositoryId === huge) {
        // Never done: it reads until its deadline, and the sync state keeps its cursor.
        clock = deadline;
        lastAttempt.set(t.repositoryId, new Date(clock).toISOString());
        unfinished.add(t.repositoryId);
        return { status: "partial" as const };
      }
      clock += 1_000;
      lastAttempt.set(t.repositoryId, new Date(clock).toISOString());
      return { status: "done" as const };
    };
    const targets = () =>
      ["r-a", huge, "r-b", "r-c"].map((id) =>
        target(id, lastAttempt.get(id) ?? null, "i-1", unfinished.has(id)),
      );
    return { sync, targets, now: () => clock };
  }

  // #932-T22
  it("does not stop the others from syncing in the same run", async () => {
    const { sync, targets, now } = nights();
    const seen: string[] = [];

    const counts = await resyncProjects(targets(), {
      now,
      budgetMs: 240_000,
      minSliceMs: 1_000,
      resync: async (t, deadline) => {
        seen.push(t.repositoryId);
        return sync(t, deadline);
      },
    });

    expect(seen.filter((id) => id !== "r-0-huge").sort()).toEqual([
      "r-a",
      "r-b",
      "r-c",
    ]);
    expect(counts).toEqual({
      projects: 4,
      done: 3,
      partial: 1,
      failed: 0,
      deferred: 0,
    });
  });

  // #932-T23
  it("gives a project a fair slice of what is left, so that the huge one cannot use the whole budget", async () => {
    const deadlines = new Map<string, number>();
    let clock = 0;

    await resyncProjects([target("r-huge"), target("r-i")], {
      now: () => clock,
      budgetMs: 100_000,
      minSliceMs: 1_000,
      resync: async (t, deadline) => {
        deadlines.set(t.repositoryId, deadline);
        clock = deadline;
        return { status: "partial" };
      },
    });

    // Half of 100 s for the first, half of the rest for the second.
    expect(deadlines.get("r-huge")).toBe(50_000);
    expect(deadlines.get("r-i")).toBe(100_000);
  });

  // #932-T24
  it("does not go first every night: after a sync that did not end it comes after the projects whose sync did", async () => {
    const { sync, targets, now } = nights();
    const firstOf: string[] = [];

    for (let night = 0; night < 3; night += 1) {
      const order: string[] = [];
      await resyncProjects(targets(), {
        now,
        budgetMs: 240_000,
        minSliceMs: 1_000,
        resync: async (t, deadline) => {
          order.push(t.repositoryId);
          return sync(t, deadline);
        },
      });
      firstOf.push(order[0] ?? "");
    }

    // Night 1: nothing was ever attempted (ids decide). Nights 2 and 3: its last sync did not end, so it comes after the finished ones.
    expect(firstOf[0]).toBe("r-0-huge");
    expect(firstOf[1]).not.toBe("r-0-huge");
    expect(firstOf[2]).not.toBe("r-0-huge");
  });

  // #932-T25
  it("takes the projects the budget did not reach before the ones that were attempted", async () => {
    let clock = 0;
    const order: string[] = [];

    const counts = await resyncProjects(
      [
        target("r-attempted", "2026-11-07T03:00:00.000Z"),
        target("r-untouched", null),
      ],
      {
        now: () => clock,
        budgetMs: 1_000,
        minSliceMs: 1_000,
        resync: async (t) => {
          order.push(t.repositoryId);
          clock += 1_000;
          return { status: "done" };
        },
      },
    );

    expect(order).toEqual(["r-untouched"]);
    expect(counts).toMatchObject({ done: 1, deferred: 1 });
  });
});

describe("a rate limit (#932)", () => {
  const rateLimited = () =>
    Object.assign(new Error("slow down"), {
      code: "TRACKER_SYNC_FAILED",
      providerCode: "INTEGRATION_ACCESS_RATE_LIMITED",
    });

  // #932-T26
  it("skips the other projects of the same installation, counts them deferred, and goes on with the other installations", async () => {
    const logFailure = vi.fn();
    const seen: string[] = [];

    const counts = await resyncProjects(
      [
        target("r-1", null, "i-1"),
        target("r-2", null, "i-1"),
        target("r-3", null, "i-2"),
        target("r-4", null, "i-1"),
      ],
      {
        logFailure,
        resync: async (t) => {
          seen.push(t.repositoryId);
          if (t.repositoryId === "r-1") throw rateLimited();
          return { status: "done" };
        },
      },
    );

    expect(seen).toEqual(["r-1", "r-3"]);
    expect(counts).toEqual({
      projects: 4,
      done: 1,
      partial: 0,
      failed: 1,
      deferred: 2,
    });
    expect(logFailure).toHaveBeenCalledTimes(1);
  });

  // #932-T27
  it("does not skip anything for a failure that is not a rate limit", async () => {
    const seen: string[] = [];

    const counts = await resyncProjects(
      [target("r-1", null, "i-1"), target("r-2", null, "i-1")],
      {
        logFailure: () => undefined,
        resync: async (t) => {
          seen.push(t.repositoryId);
          throw Object.assign(new Error("x"), {
            code: "TRACKER_SYNC_FAILED",
            providerCode: "INTEGRATION_ACCESS_UNAVAILABLE",
          });
        },
      },
    );

    expect(seen).toEqual(["r-1", "r-2"]);
    expect(counts).toMatchObject({ failed: 2, deferred: 0 });
  });

  // #932-T28
  it("logs the code of the platform, not the code of the wrapper", async () => {
    const logFailure = vi.fn();

    await resyncProjects([target("r-1")], {
      logFailure,
      resync: async () => {
        throw rateLimited();
      },
    });

    const line = String(logFailure.mock.calls[0]?.[0]);
    expect(line).toContain("INTEGRATION_ACCESS_RATE_LIMITED");
    expect(line).not.toContain("slow down");
  });
});

describe("the budget clock (#932)", () => {
  // #932-T29
  it("starts when the handler is entered, so that listing the projects is paid from the budget", async () => {
    let clock = 0;
    const resync = vi.fn(async () => ({ status: "done" as const }));

    const response = await handleTrackerResyncCron(
      request(`Bearer ${SECRET}`),
      deps({
        now: () => clock,
        budgetMs: 100,
        targets: async () => {
          clock += 150;
          return [target("r-1")];
        },
        resync,
      }),
    );

    expect(resync).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ projects: 1, deferred: 1 });
  });
});

describe("the page in flight at the end of the budget (#932)", () => {
  // #937-T60
  it("counts a project whose page the end of its slice aborted as partial, not failed", async () => {
    const logFailure = vi.fn();
    const log = vi.fn();
    // The clock is past the hard limit of the run, so the signal aborts at once.
    const now = () => RESYNC_HARD_LIMIT_MS + 5000;
    const resync = vi.fn(
      (_target: ResyncTarget, _deadline: number, signal: AbortSignal) =>
        new Promise<{ status: "done" | "partial" }>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );

    const counts = await resyncProjects([target("r-1"), target("r-2")], {
      resync,
      now,
      startedAt: 0,
      budgetMs: 400_000,
      logFailure,
      log,
    });

    expect(counts).toMatchObject({
      projects: 2,
      done: 0,
      partial: 2,
      failed: 0,
    });
    expect(logFailure).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("2 partial, 0 failed"),
    );
  });

  // #932-R40
  it("hands every sync an abort signal that is still open", async () => {
    const calls: { target: ResyncTarget; signal: AbortSignal | undefined }[] =
      [];
    const resync = vi.fn(
      async (t: ResyncTarget, _deadline: number, signal?: AbortSignal) => {
        calls.push({ target: t, signal });
        return { status: "done" as const };
      },
    );

    await resyncProjects([target("r-1")], { resync, logFailure: vi.fn() });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  // #932-R41
  it("aborts a little after the end of the slice of the project", () => {
    expect(abortDelayMs(100_000, 0, 90_000)).toBe(
      10_000 + RESYNC_ABORT_GRACE_MS,
    );
  });

  // #932-R42
  it("never aborts later than the hard limit of the run, which is shorter than the function's 300 seconds", () => {
    expect(RESYNC_HARD_LIMIT_MS).toBeLessThan(300_000);
    // The slice ends at the end of the budget: the grace would go past the hard limit.
    expect(abortDelayMs(RESYNC_HARD_LIMIT_MS - 1000, 0, 200_000)).toBe(
      RESYNC_HARD_LIMIT_MS - 200_000,
    );
  });

  // #932-R43
  it("aborts at once, and never with a delay that is none, when the time is already over", () => {
    expect(abortDelayMs(1000, 0, RESYNC_HARD_LIMIT_MS + 5000)).toBe(1);
  });

  // #932-R44
  it("logs the counts line even when a project's failure cannot be logged", async () => {
    const log = vi.fn();

    await expect(
      resyncProjects([target("r-1")], {
        resync: async () => {
          throw new Error("boom");
        },
        logFailure: () => {
          throw new Error("log is gone");
        },
        log,
      }),
    ).rejects.toThrow("log is gone");

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("nightly resync");
  });

  // #932-R45
  it("logs the counts line once on a normal run", async () => {
    const log = vi.fn();

    await resyncProjects([target("r-1"), target("r-2")], {
      resync: async () => ({ status: "done" as const }),
      log,
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("2 projects, 2 done");
  });
});

describe("the order of the projects does not depend on the locale (#932)", () => {
  // #932-R46
  it("breaks a tie of the attempt time by the id in plain code unit order", async () => {
    const order: string[] = [];

    await resyncProjects([target("r-a"), target("r-B"), target("r-C")], {
      resync: async (t) => {
        order.push(t.repositoryId);
        return { status: "done" as const };
      },
      logFailure: vi.fn(),
      log: vi.fn(),
    });

    // `localeCompare` would put "r-a" before "r-B".
    expect(order).toEqual(["r-B", "r-C", "r-a"]);
  });
});
