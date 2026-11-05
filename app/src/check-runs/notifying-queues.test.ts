// SPDX-License-Identifier: LicenseRef-Proprietary

// The queues the running server uses tell the check run reconciler about every change of a job, after the change was
// made (#405): the runner side (claim, result, release, cancel, a heartbeat that learns of a supersede or an end) and
// the producer side (a new job, the jobs it replaced, waiting jobs that were dropped). The answer of the queue is
// never changed, and a notifier that throws never breaks a call.
import { describe, expect, it, vi } from "vitest";
import type { JobQueue } from "../jobs/job-queue.ts";
import type { EnqueueResult, Job } from "../jobs/job-types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import {
  notifyingJobQueue,
  notifyingRunnerQueue,
  type CheckNotifier,
} from "./notifying-queues.ts";

function job(id: string): Job {
  return { id } as Job;
}

function notifier() {
  const calls: string[] = [];
  const notify: CheckNotifier = {
    job: (id) => calls.push(`job ${id}`),
    change: () => calls.push("change"),
  };
  return { notify, calls };
}

function runnerQueue(overrides: Partial<RunnerQueue>): RunnerQueue {
  return overrides as RunnerQueue;
}

describe("the runner side of the queue", () => {
  // #405-T02
  it("tells of the job a claim handed out, and of nothing when there was none", async () => {
    const { notify, calls } = notifier();
    const claimed = { job: job("j1"), leaseToken: "t" };
    const queue = notifyingRunnerQueue(
      runnerQueue({
        claimNext: vi
          .fn()
          .mockResolvedValueOnce(claimed)
          .mockResolvedValue(null),
      }),
      notify,
    );

    expect(await queue.claimNext("r")).toBe(claimed);
    expect(await queue.claimNext("r")).toBeNull();

    expect(calls).toEqual(["job j1"]);
  });

  // #405-T03
  it("tells of a job that was completed, not of a repetition or a refusal", async () => {
    const { notify, calls } = notifier();
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ status: "completed", job: job("j1") })
      .mockResolvedValueOnce({ status: "already_completed", job: job("j1") })
      .mockResolvedValueOnce({ status: "not_holder" })
      .mockResolvedValueOnce({ status: "outcome_conflict", job: job("j1") });
    const queue = notifyingRunnerQueue(runnerQueue({ complete }), notify);

    for (let call = 0; call < 4; call += 1)
      await queue.complete("j1", "t", { ok: true, result: {} });

    expect(calls).toEqual(["job j1"]);
  });

  // #405-T07
  it("tells of a job that was given back or ended by the release, not of a refusal", async () => {
    const { notify, calls } = notifier();
    const release = vi
      .fn()
      .mockResolvedValueOnce({ status: "requeued", job: job("j1") })
      .mockResolvedValueOnce({ status: "failed", job: job("j2") })
      .mockResolvedValueOnce({ status: "cancelled", job: job("j3") })
      .mockResolvedValueOnce({ status: "not_holder" });
    const queue = notifyingRunnerQueue(runnerQueue({ release }), notify);

    for (let call = 0; call < 4; call += 1)
      await queue.release("j", "t", "why");

    expect(calls).toEqual(["job j1", "job j2", "job j3"]);
  });

  // #405-T10
  it("tells of a claimed job that was cancelled", async () => {
    const { notify, calls } = notifier();
    const queue = notifyingRunnerQueue(
      runnerQueue({
        cancelClaimed: vi
          .fn()
          .mockResolvedValueOnce({ status: "cancelled", job: job("j1") })
          .mockResolvedValueOnce({ status: "not_holder" }),
      }),
      notify,
    );

    await queue.cancelClaimed("j1", "t", "project_deactivated");
    await queue.cancelClaimed("j1", "t", "project_deactivated");

    expect(calls).toEqual(["job j1"]);
  });

  // #405-T09
  it("tells of a job whose heartbeat learned that it was superseded or that it is no longer held", async () => {
    const { notify, calls } = notifier();
    const heartbeat = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok", job: job("j1") })
      .mockResolvedValueOnce({ status: "superseded", job: job("j1") })
      .mockResolvedValueOnce({ status: "not_holder" });
    const queue = notifyingRunnerQueue(runnerQueue({ heartbeat }), notify);

    await queue.heartbeat("j1", "t");
    await queue.heartbeat("j1", "t");
    await queue.heartbeat("j1", "t");

    expect(calls).toEqual(["job j1", "job j1"]);
  });

  // #405-T06
  it("asks for a reconcile when the queue itself ended or requeued jobs, and not when it did nothing", async () => {
    const { notify, calls } = notifier();
    const none = {
      requeued: 0,
      leaseExpired: 0,
      timedOut: 0,
      noCapableRunner: 0,
      noRunnerAvailable: 0,
    };
    const expireStaleJobs = vi
      .fn()
      .mockResolvedValueOnce(none)
      .mockResolvedValueOnce({ ...none, timedOut: 1 })
      .mockResolvedValueOnce({ ...none, requeued: 2 });
    const failUndispatched = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(3);
    const queue = notifyingRunnerQueue(
      runnerQueue({ expireStaleJobs, failUndispatched }),
      notify,
    );

    await queue.expireStaleJobs();
    await queue.expireStaleJobs();
    await queue.expireStaleJobs();
    await queue.failUndispatched(1000);
    await queue.failUndispatched(1000);

    expect(calls).toEqual(["change", "change", "change"]);
  });

  // #632-T02
  it("tells of every job a claim refused, so its check run is completed at once instead of staying queued", () => {
    const { notify, calls } = notifier();
    const hook = notifyingRunnerQueue.onRefused(notify);

    hook({ jobId: "j1" });
    hook({ jobId: "j2" });

    expect(calls).toEqual(["job j1", "job j2"]);
  });

  // #632-T02
  it("never lets the notifier of a refusal throw into the claim", () => {
    const hook = notifyingRunnerQueue.onRefused({
      job: () => {
        throw new Error("boom");
      },
      change: () => undefined,
    });

    expect(() => hook({ jobId: "j1" })).not.toThrow();
  });

  it("returns what the queue answered whatever the notifier does", async () => {
    const answer = { status: "completed", job: job("j1") };
    const queue = notifyingRunnerQueue(
      runnerQueue({ complete: vi.fn().mockResolvedValue(answer) }),
      {
        job: () => {
          throw new Error("boom");
        },
        change: () => {
          throw new Error("boom");
        },
      },
    );

    expect(await queue.complete("j1", "t", { ok: true, result: {} })).toBe(
      answer,
    );
  });

  it("leaves the other calls of the queue as they are", async () => {
    const { notify, calls } = notifier();
    const get = vi.fn().mockResolvedValue(job("j1"));
    const queue = notifyingRunnerQueue(runnerQueue({ get }), notify);

    expect(await queue.get("j1")).toEqual(job("j1"));
    expect(calls).toEqual([]);
  });
});

describe("the producer side of the queue", () => {
  const created = (id: string, superseded: string[] = []): EnqueueResult => ({
    status: "created",
    job: job(id),
    supersededJobIds: superseded,
  });

  function jobQueue(overrides: Partial<JobQueue>): JobQueue {
    return overrides as JobQueue;
  }

  // #405-T01
  it("tells of a new job and of the jobs it replaced", () => {
    const { notify, calls } = notifier();
    const hook = notifyingJobQueue.onEnqueued(notify);

    hook(created("new", ["old1", "old2"]));

    expect(calls).toEqual(["job new", "job old1", "job old2"]);
  });

  // #405-T01
  it("tells of nothing for a job that existed already", () => {
    const { notify, calls } = notifier();
    const hook = notifyingJobQueue.onEnqueued(notify);

    hook({ status: "existing", job: job("j1"), reason: "same_head" });

    expect(calls).toEqual([]);
  });

  // #405-T10
  it("asks for a reconcile when waiting jobs were dropped, and not when none was", async () => {
    const { notify, calls } = notifier();
    const queue = notifyingJobQueue(
      jobQueue({
        cancelWaitingForRepository: vi
          .fn()
          .mockResolvedValueOnce(2)
          .mockResolvedValue(0),
        cancelWaitingForReviewKindChange: vi.fn().mockResolvedValue(1),
        discardWaitingForPr: vi.fn().mockResolvedValue(1),
        discardWaitingAutomaticForPr: vi.fn().mockResolvedValue(0),
      }),
      notify,
    );

    expect(await queue.cancelWaitingForRepository("r")).toBe(2);
    expect(await queue.cancelWaitingForRepository("r")).toBe(0);
    await queue.cancelWaitingForReviewKindChange("r");
    await queue.discardWaitingForPr("r", 7);
    await queue.discardWaitingAutomaticForPr("r", 7);

    expect(calls).toEqual(["change", "change", "change"]);
  });
});
