// SPDX-License-Identifier: LicenseRef-Proprietary

// The nightly resync of the ticket mirror (#932): the platform's cron calls it with the shared secret, it syncs every active project with
// the code of the Resync route, one project's failure never stops the others, and a deployment without the factory asks GitHub for nothing.
import { describe, expect, it, vi } from "vitest";
import {
  handleTrackerResyncCron,
  resyncProjects,
  type ResyncTarget,
} from "./tracker-resync.ts";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";

const target = (
  id: string,
  lastFullSyncAt: string | null = null,
): ResyncTarget => ({
  workspaceId: "w-1",
  repositoryId: id,
  lastFullSyncAt,
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
  it("takes the project synced longest ago first, one that never was first of all", async () => {
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
  it("stops at its budget: the project it is in keeps its place (partial), the ones not reached are deferred", async () => {
    let clock = 0;
    const seen: string[] = [];

    const counts = await resyncProjects(
      [target("r-1"), target("r-2"), target("r-3")],
      {
        now: () => clock,
        budgetMs: 100,
        resync: async (t, deadline) => {
          seen.push(`${t.repositoryId}@${String(deadline)}`);
          clock += 60;
          return { status: "partial" };
        },
      },
    );

    // Each call is limited by what is left of the budget; r-1 uses it up, so r-2 and r-3 are not started.
    expect(seen).toEqual(["r-1@100", "r-1@100"]);
    expect(counts).toEqual({
      projects: 3,
      done: 0,
      partial: 1,
      failed: 0,
      deferred: 2,
    });
  });
});
