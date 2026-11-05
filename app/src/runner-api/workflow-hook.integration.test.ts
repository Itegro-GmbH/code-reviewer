// SPDX-License-Identifier: LicenseRef-Proprietary

// The hook that tells the workflow engine a turn is over (#844), through the runner API with a real Postgres: it is called once the
// completion is stored, also for a report that is repeated; a hook that throws or rejects changes nothing about the answer or the
// stored result; and a job that is no turn of the Implementer never reaches it.
import { describe, expect, it, vi } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import { sha } from "../test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { ImplementerResult } from "./contract.ts";

const block = (): ImplementerResult => ({
  baseCommit: sha("a"),
  headCommit: sha("b"),
  pushed: true,
  commits: [{ sha: sha("b"), subject: "Work" }],
  filesChanged: [],
  summary: "Done.",
  opencode: { sessionId: "ses_1", version: "1.19.0" },
});

async function start(turnEnded: (job: Job) => void | Promise<void>) {
  const h = await startRunnerApiHarness({
    implementer: true,
    hooks: { turnEnded },
  });
  await addUser(h.db, "user-1");
  async function running() {
    h.clock.advance(1);
    const enqueued = await h.queue.enqueueImplementerTurn({
      repositoryId: h.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: "implementer/hook",
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: "request-1",
    });
    const claimed = await h.queue.claimNext("runner-a", ["implementer"]);
    if (claimed === null || claimed.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    return claimed;
  }
  return { h, running };
}

describe("the hook for a turn that is over", () => {
  // #844-T120
  it("is called with the job once its completion is stored, and again for a report that is repeated", async () => {
    const seen: Array<{ id: string; status: string }> = [];
    const { h, running } = await start(async (job) => {
      // The hook runs after the completion committed: the job already reads as over.
      const stored = await h.queue.get(job.id);
      seen.push({ id: job.id, status: stored?.status ?? "missing" });
    });
    const turn = await running();

    const first = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
    });
    const again = await h.complete(turn.job.id, turn.leaseToken, {
      implementer: block(),
    });

    expect(first.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyCompleted: true });
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen).toEqual([
      { id: turn.job.id, status: "succeeded" },
      { id: turn.job.id, status: "succeeded" },
    ]);
  });

  // #844-T121
  it("is called for a turn that failed", async () => {
    const calls: string[] = [];
    const { h, running } = await start((job) => void calls.push(job.id));
    const turn = await running();

    const answer = await h.complete(turn.job.id, turn.leaseToken, {
      ok: false,
      errorCode: "no_result",
      errorMessage: "no result",
      implementer: block(),
    });

    expect(answer.status).toBe(200);
    expect(calls).toEqual([turn.job.id]);
  });

  // #844-T122
  it("cannot fail or change the completion: a hook that throws, and one that rejects, leave the answer and the stored result as they are", async () => {
    for (const hook of [
      () => {
        throw new Error("engine is broken");
      },
      () => Promise.reject(new Error("engine is broken")),
    ]) {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { h, running } = await start(hook);
      const turn = await running();

      const answer = await h.complete(turn.job.id, turn.leaseToken, {
        implementer: block(),
      });

      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({
        job: { id: turn.job.id, status: "succeeded" },
        alreadyCompleted: false,
      });
      const job = await h.queue.get(turn.job.id);
      expect(job).toMatchObject({ status: "succeeded", errorCode: null });
      expect(job?.result).toMatchObject({ implementer: block() });
      await vi.waitFor(() =>
        expect(errors).toHaveBeenCalledWith(
          `[runner-api] WORKFLOW_ENGINE_HOOK_FAILED job=${turn.job.id}`,
        ),
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain("broken");
      errors.mockRestore();
    }
  });

  // #844-T123
  it("is not called for a job that is no turn of the Implementer", async () => {
    const calls: string[] = [];
    const h = await startRunnerApiHarness({
      hooks: { turnEnded: (job) => void calls.push(job.id) },
    });
    const queued = await h.enqueue();
    const claimed = await h.queue.claimNext("runner-a");
    if (claimed === null || claimed.job.id !== queued.job.id)
      throw new Error("the review was not claimed");

    const answer = await h.complete(
      claimed.job.id,
      claimed.leaseToken,
      goodResult(),
    );

    expect(answer.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
