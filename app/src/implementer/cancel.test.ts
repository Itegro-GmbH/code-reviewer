// SPDX-License-Identifier: LicenseRef-Proprietary

// A member stops a run of the Implementer (#891): which jobs may be named, what each answer says, and the route handler behind it
// (the same rules as the other routes of the Implementer: the user first, then where the request comes from).
import { describe, expect, it, vi } from "vitest";
import type { CancelJobResult, Job } from "../jobs/job-types.ts";
import { createRunCanceller } from "./cancel.ts";
import { ImplementerError } from "./errors.ts";
import { createImplementerRouteHandlers } from "./http.ts";
import type { ImplementerService } from "./service.ts";

const JOB = (overrides: Partial<Job> = {}): Job =>
  ({
    id: "job-1",
    reviewKind: "implementer",
    status: "running",
    errorCode: null,
    cancelRequestedAt: null,
    ...overrides,
  }) as Job;

function build(found: Job | undefined, result: CancelJobResult) {
  const requestCancel = vi.fn(async () => result);
  const log = vi.fn();
  const canceller = createRunCanceller({
    queue: { get: async () => found, requestCancel },
    log,
  });
  return { canceller, requestCancel, log };
}

describe("cancelling a run of the Implementer", () => {
  // #891-T20
  it("tells the holder of a running turn to stop and says so", async () => {
    const running = JOB({ cancelRequestedAt: "2026-11-06T09:00:00.000Z" });
    const { canceller, requestCancel, log } = build(JOB(), {
      status: "requested",
      job: running,
    });

    expect(await canceller.cancelRun("job-1")).toEqual({
      runId: "job-1",
      outcome: "requested",
      status: "running",
    });
    expect(requestCancel).toHaveBeenCalledWith("job-1");
    expect(log).toHaveBeenCalledWith(
      "[implementer] cancel requested run=job-1 outcome=requested",
    );
  });

  // #891-T20
  it("ends a waiting turn at once", async () => {
    const { canceller } = build(JOB({ status: "queued" }), {
      status: "cancelled",
      job: JOB({ status: "cancelled", errorCode: "cancelled" }),
    });

    expect(await canceller.cancelRun("job-1")).toEqual({
      runId: "job-1",
      outcome: "cancelled",
      status: "cancelled",
    });
  });

  // #891-T21
  it("answers a repeat and a finished run as no-ops, naming the status", async () => {
    const again = build(JOB(), {
      status: "already_requested",
      job: JOB({ cancelRequestedAt: "2026-11-06T09:00:00.000Z" }),
    });
    const finished = build(JOB({ status: "succeeded" }), {
      status: "already_ended",
      job: JOB({ status: "succeeded" }),
    });

    expect(await again.canceller.cancelRun("job-1")).toMatchObject({
      outcome: "already_requested",
      status: "running",
    });
    expect(await finished.canceller.cancelRun("job-1")).toMatchObject({
      outcome: "already_ended",
      status: "succeeded",
    });
  });

  // #891-T22
  it("does not find a job that is no turn of the Implementer, or does not exist, and asks nothing of the queue", async () => {
    const review = build(JOB({ reviewKind: "diff" }), { status: "not_found" });
    const missing = build(undefined, { status: "not_found" });

    await expect(review.canceller.cancelRun("job-1")).rejects.toMatchObject({
      code: "IMPLEMENTER_RUN_NOT_FOUND",
    });
    await expect(missing.canceller.cancelRun("job-1")).rejects.toMatchObject({
      code: "IMPLEMENTER_RUN_NOT_FOUND",
    });
    await expect(
      build(JOB(), { status: "not_found" }).canceller.cancelRun("job-1"),
    ).rejects.toBeInstanceOf(ImplementerError);
    expect(review.requestCancel).not.toHaveBeenCalled();
    expect(missing.requestCancel).not.toHaveBeenCalled();
  });
});

describe("the route behind it", () => {
  const user = { id: "u-1", name: "Octo", email: "o@example.com" };
  function route(cancelRun: ImplementerService["cancelRun"]) {
    return createImplementerRouteHandlers({
      requireUser: () => Promise.resolve(user as never),
      service: { cancelRun } as ImplementerService,
    });
  }
  const post = (headers: Record<string, string> = {}) =>
    new Request(
      "https://app.example/api/w/acme/implementer/runs/job-1/cancel",
      {
        method: "POST",
        headers,
      },
    );

  // #891-T23
  it("answers 202 for a turn that is told to stop and 200 for what changed nothing or ended at once", async () => {
    const answers = {
      requested: 202,
      cancelled: 200,
      already_requested: 200,
      already_ended: 200,
    } as const;
    for (const [outcome, status] of Object.entries(answers)) {
      const response = await route(async () => ({
        runId: "job-1",
        outcome: outcome as keyof typeof answers,
        status: "running",
      })).cancelRun(post(), "job-1");

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        runId: "job-1",
        outcome,
        status: "running",
      });
    }
  });

  // #891-T23
  it("refuses a request from another site before anything else, and answers the stable code for a run that is not found", async () => {
    const cancelRun = vi.fn(async () => {
      throw new ImplementerError(
        "IMPLEMENTER_RUN_NOT_FOUND",
        "There is no such run.",
      );
    });

    const foreign = await route(cancelRun).cancelRun(
      post({ "sec-fetch-site": "cross-site" }),
      "job-1",
    );
    const missing = await route(cancelRun).cancelRun(post(), "job-1");

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      error: "IMPLEMENTER_CROSS_SITE_REQUEST",
    });
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: "IMPLEMENTER_RUN_NOT_FOUND",
    });
  });
});
