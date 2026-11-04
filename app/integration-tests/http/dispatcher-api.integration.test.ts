// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down what a Dispatcher (#316) does with the runner API through the real handlers and a real Postgres
// file (#322): claiming exactly one job by its id, the pool cap, giving a job back with `release`, and
// the version call that tells it what the app can do. The claim of a runner of the previous release is
// pinned to be unchanged. The shape of the answers against the contract file is in
// compatibility/hosted-contracts.integration.test.ts; the two dialects of the claim SQL are in
// src/jobs/claim-by-id-queue.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_FEATURES } from "../../src/runner-api/contract.ts";
import { T0 } from "../../src/test-support/jobs.ts";
import {
  startRunnerApiHarness,
  TEST_APP_VERSION,
  TEST_RUNNER_TOKEN,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const MINUTE = 60 * 1000;
const SHA_B = "b".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

async function errorOf(response: Response) {
  return (await response.json()).error as {
    code: string;
    message: string;
    fields?: Array<{ field: string; code: string }>;
  };
}

/** Claims as a Dispatcher and returns the credential of the claim. */
async function claimFor(
  h: RunnerApiHarness,
  jobId: string,
  request: Parameters<RunnerApiHarness["claimedSplit"]>[0] = {},
) {
  return (await h.claimedSplit({ jobId, ...request })).job.credential;
}

describe("the claim by job id", () => {
  // #322-T01
  it("hands out exactly the job the Dispatcher names, with a credential, and leaves the others", async () => {
    const h = await startRunnerApiHarness();
    const oldest = await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const wanted = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });

    const response = await h.claimSplit({ jobId: wanted.id });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.id).toBe(wanted.id);
    expect(body.job.credential).toMatch(/^crj_/);
    expect(await h.queue.get(wanted.id)).toMatchObject({
      status: "running",
      runnerId: "runner-a",
    });
    expect((await h.queue.get(oldest.id))?.status).toBe("queued");
  });

  // #322-T01
  it("works for the legacy answer too: the job id and the answer shape are independent", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const wanted = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });

    const response = await h.claim({
      engines: ["pr-agent"],
      jobId: wanted.id,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.id).toBe(wanted.id);
    expect(body.job.leaseToken).toEqual(expect.any(String));
    expect(body.job.input.command).toBe("review");
  });

  // #322-T02
  it("is 204 for an unknown id, a running job, a finished one, a cancelled one and a superseded one", async () => {
    const h = await startRunnerApiHarness();
    const running = await h.enqueueNew({ prNumber: 7 });
    const claimed = await h.claimed();
    await h.complete(running.id, claimed.job.leaseToken);
    const cancelled = await h.seedHistoricalJob({
      command: "review",
      status: "cancelled",
      prNumber: 8,
    });
    const old = await h.enqueueNew({ prNumber: 10, headSha: "a".repeat(40) });
    await h.enqueueNew({ prNumber: 10, headSha: SHA_B });
    const busy = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    await h.claimedSplit({ jobId: busy.id });

    for (const id of [
      crypto.randomUUID(),
      running.id,
      cancelled.id,
      old.id,
      busy.id,
    ]) {
      const response = await h.claimSplit({ jobId: id });
      expect({ id, status: response.status }).toStrictEqual({
        id,
        status: 204,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
    }
  });

  // #322-T02
  it("is 204 while the job waits for its time, and claims it once that has come", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    const released = await h.release(job.id, {
      credential,
      reason: "launch_failed",
      retryAfterSeconds: 120,
    });
    expect(released.status).toBe(200);

    expect((await h.claimSplit({ jobId: job.id })).status).toBe(204);
    h.clock.advance(121 * 1000);
    expect((await h.claimSplit({ jobId: job.id })).status).toBe(200);
  });

  // #322-T04
  it("is 204 for a Dynamic job when only pr-agent is advertised, and does not count an attempt", async () => {
    const h = await startRunnerApiHarness();
    const dynamic = await h.seedHistoricalJob({
      command: "review",
      status: "queued",
      reviewKind: "dynamic",
    });

    const response = await h.claimSplit({
      engines: ["pr-agent"],
      jobId: dynamic.id,
    });

    expect(response.status).toBe(204);
    expect(await h.queue.get(dynamic.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  // #322-T04
  it("hands out a Dynamic job by id when opencode is advertised", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    const dynamic = await h.enqueueNew();

    const response = await h.claimSplit({
      engines: ["pr-agent", "opencode"],
      jobId: dynamic.id,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).job).toMatchObject({
      id: dynamic.id,
      reviewKind: "dynamic",
    });
  });

  // #322-T13
  it("does not hand out another job when the named one ends at claim time", async () => {
    const h = await startRunnerApiHarness();
    const closed = await h.enqueueNew({ prNumber: 9 });
    h.clock.advance(1000);
    const other = await h.enqueueNew({ prNumber: 7 });

    const response = await h.claimSplit({ jobId: closed.id });

    expect(response.status).toBe(204);
    expect(await h.queue.get(closed.id)).toMatchObject({
      status: "failed",
      errorCode: "pull_request_closed",
    });
    expect((await h.queue.get(other.id))?.status).toBe("queued");
  });

  // #322-T12
  it.each([
    ["a job id that is no UUID", { jobId: "../etc/passwd" }, "jobId"],
    ["a cap of 0", { maxRunning: 0 }, "maxRunning"],
    ["a cap over 1000", { maxRunning: 1001 }, "maxRunning"],
    ["a cap that is no integer", { maxRunning: 2.5 }, "maxRunning"],
    ["a cap as text", { maxRunning: "4" }, "maxRunning"],
  ])(
    "refuses %s with 400 before any job is claimed",
    async (_name, fields, field) => {
      const h = await startRunnerApiHarness();
      const job = await h.enqueueNew();

      const response = await h.claimSplit(
        fields as Parameters<typeof h.claimSplit>[0],
      );

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("RUNNER_REQUEST_INVALID");
      expect(error.fields).toStrictEqual([{ field, code: "invalid" }]);
      expect(JSON.stringify(error)).not.toContain("passwd");
      expect((await h.queue.get(job.id))?.status).toBe("queued");
    },
  );

  // #322-T09
  it("needs the dispatcher credential like every claim", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.claimSplit({ jobId: job.id, token: "wrong" });

    expect(response.status).toBe(401);
    expect((await h.queue.get(job.id))?.status).toBe("queued");
  });
});

describe("the pool cap", () => {
  // #322-T05
  it("is 204 at the cap of the pool (the X-Runner-Id) and leaves another pool alone", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    h.clock.advance(1000);
    const third = await h.enqueueNew({
      prNumber: 7,
      repositoryId: h.otherRepositoryId,
    });
    h.clock.advance(1000);

    expect((await h.claimSplit({ maxRunning: 2 })).status).toBe(200);
    expect((await h.claimSplit({ maxRunning: 2 })).status).toBe(200);
    const capped = await h.claimSplit({ maxRunning: 2 });
    const other = await h.claimSplit({ maxRunning: 2, runnerId: "pool-b" });

    expect(capped.status).toBe(204);
    expect(capped.headers.get("cache-control")).toBe("no-store");
    expect(other.status).toBe(200);
    expect((await other.json()).job.id).toBe(third.id);
  });

  // #322-T05
  it("also holds when the Dispatcher names the job", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    const second = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    h.clock.advance(1000);
    await h.claimedSplit({ maxRunning: 1 });

    const response = await h.claimSplit({ maxRunning: 1, jobId: second.id });

    expect(response.status).toBe(204);
    expect((await h.queue.get(second.id))?.status).toBe("queued");
  });

  // #322-T05
  it("frees a slot when a job finishes or its lease runs out", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 7, repositoryId: h.otherRepositoryId });
    h.clock.advance(1000);
    const first = await h.claimedSplit({ maxRunning: 1 });
    expect((await h.claimSplit({ maxRunning: 1 })).status).toBe(204);

    h.clock.advance(3 * MINUTE);
    const afterExpiry = await h.claimSplit({ maxRunning: 1 });

    expect(afterExpiry.status).toBe(200);
    expect(first.job.id).toBeDefined();
  });

  // #322-T10
  it("is not applied to a claim without a cap, whatever the pool runs", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    h.clock.advance(1000);
    await h.claimedSplit({ maxRunning: 1 });

    expect((await h.claimSplit()).status).toBe(200);
  });
});

describe("a claim of a runner of the previous release", () => {
  // #322-T10
  it("is exactly what it was: no body, the oldest job, the legacy answer", async () => {
    const h = await startRunnerApiHarness();
    const oldest = await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({ prNumber: 8, headSha: SHA_B });

    const response = await h.claim();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.id).toBe(oldest.id);
    expect(Object.keys(body.job).sort()).toStrictEqual([
      "heartbeatIntervalSeconds",
      "id",
      "input",
      "leaseExpiresAt",
      "leaseToken",
      "tokenExpiresAt",
    ]);
    expect(body.job).not.toHaveProperty("credential");
  });

  // #322-T10
  it("is not changed by the fields it never sends: engines alone still claim the next job", async () => {
    const h = await startRunnerApiHarness();
    const oldest = await h.enqueueNew({ prNumber: 7 });

    const response = await h.claim({ engines: ["pr-agent"] });

    expect((await response.json()).job.id).toBe(oldest.id);
  });
});

describe("the release", () => {
  // #322-T07
  it("gives the job back with an attempt counted, and offers it again after the delay", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);

    const response = await h.release(job.id, {
      credential,
      reason: "launch_failed",
      retryAfterSeconds: 90,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toStrictEqual({
      version: 1,
      job: { id: job.id, status: "queued" },
    });
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      runnerId: null,
      runAfter: new Date(T0.getTime() + 90 * 1000).toISOString(),
    });
    expect((await h.claimSplit()).status).toBe(204);
    h.clock.advance(90 * 1000);
    expect((await h.claimedSplit()).job.id).toBe(job.id);
  });

  // #322-T07
  it("offers the job again at once when no delay is given", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);

    const response = await h.release(job.id, {
      credential,
      reason: "launch_failed",
    });

    expect(response.status).toBe(200);
    expect((await h.claimedSplit()).job.id).toBe(job.id);
  });

  // #322-T08
  it("fails the job with the reason on the last allowed attempt", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const statuses: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const credential = await claimFor(h, job.id);
      const response = await h.release(job.id, {
        credential,
        reason: "launch_failed",
      });
      statuses.push((await response.json()).job.status);
    }

    expect(statuses).toStrictEqual(["queued", "queued", "failed"]);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "launch_failed",
      attempts: 3,
    });
    expect((await h.claimSplit({ jobId: job.id })).status).toBe(204);
  });

  // #322-T08
  it("stores a reason it does not know as launch_failed", async () => {
    const h = await startRunnerApiHarness({ limits: { maxAttempts: 1 } });
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);

    const response = await h.release(job.id, {
      credential,
      reason: "something_made_up",
    });

    expect((await response.json()).job.status).toBe("failed");
    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "launch_failed",
    });
  });

  // #375-T02
  it("stores worker_exited as the error code of a job whose Worker keeps ending with an error, after counting each attempt", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const statuses: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const credential = await claimFor(h, job.id);
      const response = await h.release(job.id, {
        credential,
        reason: "worker_exited",
      });
      expect(response.status).toBe(200);
      statuses.push((await response.json()).job.status);
    }

    expect(statuses).toStrictEqual(["queued", "queued", "failed"]);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "worker_exited",
      attempts: 3,
    });
  });

  // #375-T03
  it("answers a release of a job that already delivered its result as a no-op, and the result stands", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    await h.worker.result(job.id, credential);
    const before = await h.snapshotJobs();

    const response = await h.release(job.id, {
      credential,
      reason: "worker_exited",
      retryAfterSeconds: 30,
    });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_ENDED");
    expect(await h.snapshotJobs()).toStrictEqual(before);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "succeeded",
      attempts: 0,
    });
  });

  // #375-T06
  it("refuses a release with a stale credential after a requeue and a new claim, and the new claim is untouched", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const first = await claimFor(h, job.id);
    // The first Worker's lease lapses and the job is claimed again.
    h.clock.advance(3 * MINUTE);
    const second = await claimFor(h, job.id);
    const before = await h.snapshotJobs();

    const response = await h.release(job.id, {
      credential: first,
      reason: "worker_exited",
    });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("WORKER_CREDENTIAL_INVALID");
    expect(await h.snapshotJobs()).toStrictEqual(before);
    expect(await h.queue.get(job.id)).toMatchObject({ status: "running" });
    // The second claim still holds the job: it can heartbeat and give it back itself.
    expect(
      (await h.release(job.id, { credential: second, reason: "worker_exited" }))
        .status,
    ).toBe(200);
  });

  // #322-T09
  it("is refused with the credential of another job, and nothing changes", async () => {
    const h = await startRunnerApiHarness();
    const a = await h.enqueueNew({ prNumber: 7 });
    const b = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    await claimFor(h, a.id);
    const credentialB = await claimFor(h, b.id);
    const before = await h.snapshotJobs();

    const response = await h.release(a.id, {
      credential: credentialB,
      reason: "launch_failed",
    });

    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("WORKER_CREDENTIAL_INVALID");
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #322-T09
  it("is refused with a credential that is wrong or from an earlier claim", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const first = await claimFor(h, job.id);
    h.clock.advance(3 * MINUTE);
    const second = await claimFor(h, job.id);
    const before = await h.snapshotJobs();

    for (const credential of [first, `crj_${"A".repeat(43)}`]) {
      const response = await h.release(job.id, {
        credential,
        reason: "launch_failed",
      });
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("WORKER_CREDENTIAL_INVALID");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
    expect(
      (await h.release(job.id, { credential: second, reason: "x" })).status,
    ).toBe(200);
  });

  // #322-T09
  it("is refused without the dispatcher credential, also with the right job credential", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    const before = await h.snapshotJobs();
    const body = { credential, reason: "launch_failed" };

    for (const request of [
      { token: null },
      { token: "wrong" },
      { token: credential },
    ]) {
      const response = await h.release(job.id, body, request);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("RUNNER_UNAUTHORIZED");
    }

    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #322-T09
  it("does not take the lease token of a legacy claim as a credential", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const claimed = await h.claimed();
    const before = await h.snapshotJobs();

    const response = await h.release(job.id, {
      credential: claimed.job.leaseToken,
      reason: "launch_failed",
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).fields).toStrictEqual([
      { field: "credential", code: "invalid" },
    ]);
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #322-T09
  it("answers 404 for a job that does not exist and 409 for one that ended", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    await h.worker.result(job.id, credential);

    const missing = await h.release(crypto.randomUUID(), {
      credential,
      reason: "launch_failed",
    });
    const ended = await h.release(job.id, {
      credential,
      reason: "launch_failed",
    });

    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("RUNNER_JOB_NOT_FOUND");
    expect(ended.status).toBe(409);
    expect((await errorOf(ended)).code).toBe("RUNNER_JOB_ENDED");
    expect((await h.queue.get(job.id))?.status).toBe("succeeded");
  });

  // #322-T09
  it("refuses a bad job id, a body that is not JSON and bad fields with 400, and a large body with 413", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    const before = await h.snapshotJobs();

    const badId = await h.release("not-a-uuid", { credential, reason: "x" });
    const notJson = await h.release(job.id, "{nope");
    const badFields = await h.release(job.id, {
      credential,
      reason: "Not Valid",
      retryAfterSeconds: 0,
    });
    const large = await h.release(job.id, "x".repeat(70 * 1024));

    expect(badId.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(badFields.status).toBe(400);
    expect((await errorOf(badFields)).fields).toStrictEqual([
      { field: "reason", code: "invalid" },
      { field: "retryAfterSeconds", code: "invalid" },
    ]);
    expect(large.status).toBe(413);
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #322-T14
  it("never writes the credential to the log or into an answer", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);

    const ok = await h.release(job.id, { credential, reason: "launch_failed" });
    const refused = await h.release(job.id, {
      credential,
      reason: "launch_failed",
    });

    expect(await ok.text()).not.toContain(credential);
    expect(await refused.text()).not.toContain(credential);
    const logged = h.logLines().join("\n");
    expect(logged).toContain(job.id);
    expect(logged).not.toContain(credential);
    expect(logged).not.toContain(credential.slice(4));
  });

  // #322-T14
  it("works on a second app instance over the same database", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    const other = h.anotherInstance();

    const response = await other.release(job.id, {
      credential,
      reason: "launch_failed",
    });

    expect(response.status).toBe(200);
    expect((await h.queue.get(job.id))?.status).toBe("queued");
  });
});

describe("the version call", () => {
  // #322-T11
  it("lists the version and the features, not cacheable", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.version();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toStrictEqual({
      version: 1,
      appVersion: TEST_APP_VERSION,
      features: [...APP_FEATURES],
    });
  });

  // #322-T11
  it("names every feature this change adds", () => {
    expect([...APP_FEATURES].sort()).toStrictEqual([
      "claim_by_job_id",
      "implementer_steps",
      "pool_cap",
      "release",
      "vm_lifecycle",
      "worker_api",
    ]);
  });

  // #322-T11
  it("needs the dispatcher credential", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);

    for (const request of [
      { token: null },
      { token: "wrong" },
      { authorization: "Basic abc" },
      { token: credential },
      { token: `${TEST_RUNNER_TOKEN}x` },
    ]) {
      const response = await h.version(request);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("RUNNER_UNAUTHORIZED");
    }
  });

  // #322-T15
  it("is also opened by the credential of a running claim, named by its job id, with the same answer", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    const before = await h.snapshotJobs();

    const response = await h.version({
      token: credential,
      runnerId: null,
      query: `?jobId=${job.id}`,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toStrictEqual({
      version: 1,
      appVersion: TEST_APP_VERSION,
      features: [...APP_FEATURES],
    });
    expect(text).not.toContain(job.id);
    expect(text).not.toContain(credential);
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });

  // #322-T15
  it("refuses a job credential that is not the running claim of the named job", async () => {
    const h = await startRunnerApiHarness();
    const a = await h.enqueueNew({ prNumber: 7 });
    const b = await h.enqueueNew({ prNumber: 8, headSha: SHA_B });
    const credentialA = await claimFor(h, a.id);
    const credentialB = await claimFor(h, b.id);
    const ended = await h.enqueueNew({
      prNumber: 7,
      repositoryId: h.otherRepositoryId,
    });
    const credentialEnded = await claimFor(h, ended.id);
    await h.worker.result(ended.id, credentialEnded);
    const bad: Array<[string, { token: string | null; query: string }]> = [
      [
        "another job's credential",
        { token: credentialB, query: `?jobId=${a.id}` },
      ],
      ["no job id", { token: credentialA, query: "" }],
      [
        "an unknown job id",
        { token: credentialA, query: `?jobId=${crypto.randomUUID()}` },
      ],
      ["a job id that is no UUID", { token: credentialA, query: "?jobId=x" }],
      [
        "a job that ended",
        { token: credentialEnded, query: `?jobId=${ended.id}` },
      ],
      [
        "a made-up credential",
        { token: `crj_${"A".repeat(43)}`, query: `?jobId=${a.id}` },
      ],
    ];

    for (const [name, request] of bad) {
      const response = await h.version(request);
      expect({ name, status: response.status }).toStrictEqual({
        name,
        status: 401,
      });
      expect((await errorOf(response)).code).toBe("RUNNER_UNAUTHORIZED");
    }
  });

  // #322-T15
  it("refuses a job credential on a claim that expired and was claimed again", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();
    const first = await claimFor(h, job.id);
    h.clock.advance(3 * MINUTE);
    const second = await claimFor(h, job.id);

    expect(
      (await h.version({ token: first, query: `?jobId=${job.id}` })).status,
    ).toBe(401);
    expect(
      (await h.version({ token: second, query: `?jobId=${job.id}` })).status,
    ).toBe(200);
  });

  // #322-T11
  it("touches no job and needs no runner id", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const before = await h.snapshotJobs();

    const response = await h.version({ runnerId: null });

    expect(response.status).toBe(200);
    expect(await h.snapshotJobs()).toStrictEqual(before);
  });
});

describe("the job state call", () => {
  // #364-T25
  it.each([
    ["queued", async () => undefined],
    [
      "running",
      async (h: RunnerApiHarness, id: string) => {
        await claimFor(h, id);
      },
    ],
    [
      "succeeded",
      async (h: RunnerApiHarness, id: string) => {
        await h.complete(id, (await h.claimed()).job.leaseToken);
      },
    ],
    [
      "failed",
      async (h: RunnerApiHarness, id: string) => {
        await h.complete(id, (await h.claimed()).job.leaseToken, {
          ok: false,
          errorCode: "timeout",
          commentUrl: null,
        });
      },
    ],
    [
      "superseded",
      async (h: RunnerApiHarness) => {
        await h.enqueueNew({ prNumber: 7, headSha: SHA_B });
      },
    ],
    [
      "cancelled",
      async (h: RunnerApiHarness) => {
        await h.queue.discardWaitingForPr(h.repositoryId, 7);
      },
    ],
  ])(
    "answers the status of a %s job and nothing else, not cacheable",
    async (status, bring) => {
      const h = await startRunnerApiHarness();
      const job = await h.enqueueNew({ prNumber: 7 });
      await bring(h, job.id);
      const before = await h.snapshotJobs();

      const response = await h.jobState(job.id);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toStrictEqual({
        version: 1,
        job: { id: job.id, status },
      });
      expect(await h.snapshotJobs()).toStrictEqual(before);
    },
  );

  // #364-T25
  it("answers 404 RUNNER_JOB_NOT_FOUND for an id no job has", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.jobState(crypto.randomUUID());

    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe("RUNNER_JOB_NOT_FOUND");
  });

  // #364-T25
  it("needs no runner id and leaves the version features as they are", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const response = await h.jobState(job.id, { runnerId: null });

    expect(response.status).toBe(200);
    expect([...APP_FEATURES]).not.toContain("job_state");
  });

  // #364-T24
  it("is opened by the dispatcher credential only, before any job is looked up", async () => {
    let lookups = 0;
    const h = await startRunnerApiHarness({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) => {
          lookups += 1;
          return queue.get(id);
        },
      }),
    });
    const job = await h.enqueueNew();
    const credential = await claimFor(h, job.id);
    lookups = 0;

    for (const request of [
      { token: null },
      { token: "wrong" },
      { authorization: "Basic abc" },
      { token: credential },
      { token: `${TEST_RUNNER_TOKEN}x` },
    ]) {
      const response = await h.jobState(job.id, request);
      expect(response.status).toBe(401);
      expect((await errorOf(response)).code).toBe("RUNNER_UNAUTHORIZED");
    }
    expect(lookups).toBe(0);
  });

  // #364-T24
  it("refuses an id that is no UUID with 400 before any job is looked up", async () => {
    let lookups = 0;
    const h = await startRunnerApiHarness({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) => {
          lookups += 1;
          return queue.get(id);
        },
      }),
    });

    const response = await h.jobState("not-a-uuid");

    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("RUNNER_REQUEST_INVALID");
    expect(lookups).toBe(0);
  });
});
