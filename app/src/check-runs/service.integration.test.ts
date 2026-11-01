// SPDX-License-Identifier: LicenseRef-Proprietary

// The check run and the review verdict of review jobs (#405) end to end below the HTTP routes: a real database with
// the job queue, the real GitHub App provider and client over HTTP against the fake GitHub, and the service the
// running server uses. The fake GitHub shows what a pull request would show: the check runs of the commit with every
// state they were in, and the reviews with the decision GitHub would count.
import { identityFor } from "../product-identity/identities.ts";
import { describe, expect, it } from "vitest";
import {
  COMMENT_URL,
  HEAD,
  createCheckRunsHarness,
} from "../test-support/check-runs-harness.ts";
import { createJobCheckRunsRepository } from "../db/repositories/job-check-runs-repository.ts";
import { sha } from "../test-support/jobs.ts";
import { listJobsWithCheckWork } from "../db/repositories/job-check-runs-sweep.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { verdictMarker } from "./verdict.ts";

const BOT = "code-reviewer-test[bot]";
const MINUTE = 60 * 1000;
const NO_BLOCKER = {
  open: 1,
  bySeverity: { P0: 0, P1: 0, P2: 1, P3: 0 },
};
const BLOCKER = {
  open: 2,
  bySeverity: { P0: 1, P1: 0, P2: 1, P3: 0 },
};
const CLEAN = {
  open: 0,
  bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
};

describe("the check run of a job through its states", () => {
  // #405-T01
  it("is queued with the title waiting once the job is enqueued, and its id is kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toMatchObject([
      {
        name: "Code Reviewer",
        headSha: HEAD,
        status: "queued",
        conclusion: null,
        externalId: job.id,
        output: { title: "Waiting" },
      },
    ]);
    expect(await t.rowOf(job.id)).toMatchObject({
      checkRunId: String(t.checkRuns()[0]?.id),
      syncedStatus: "queued",
      state: "active",
    });
  });

  // #740-T05
  it("is named after the product the app is made for", async () => {
    const t = await createCheckRunsHarness({ product: identityFor("factory") });
    const job = await t.fixture.enqueueNew();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toMatchObject([
      { name: "Factory", status: "queued", output: { title: "Waiting" } },
    ]);
  });

  // #405-T02
  it("is in progress with the title reviewing once a worker claimed the job, on the same check run", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.claim();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "in_progress",
      output: { title: "Reviewing" },
    });
    expect(t.checkRuns()[0]?.history.map((state) => state.status)).toEqual([
      "queued",
      "in_progress",
    ]);
  });

  // #405-T03
  it("completes with success, the open findings per severity and a link to the review comment", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
      detailsUrl: COMMENT_URL,
      output: { title: "Review finished" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "2 open findings: P0 1 · P1 0 · P2 1 · P3 0",
    );
    expect(t.checkRuns()[0]?.output?.summary).toContain(COMMENT_URL);
  });

  // #405-T05
  it("completes neutral with a readable reason for a failure, never red", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "llm_auth");

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review did not finish" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The AI provider refused the API key.",
    );
    expect(t.checkRuns()[0]?.history.map((state) => state.conclusion)).toEqual([
      null,
      "neutral",
    ]);
  });

  // #405-T07
  it("goes back to queued when the job is given back, and the next claim uses the same check run", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const first = await t.claim();
    await t.service.syncJob(job.id);
    await t.fixture.queue.release(job.id, first.token, "launch_failed");
    await t.service.syncJob(job.id);
    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });

    t.fixture.clock.advance(MINUTE);
    await t.claim();
    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]?.history.map((state) => state.status)).toEqual([
      "in_progress",
      "queued",
      "in_progress",
    ]);
  });

  // #405-T27
  it("treats a review somebody asked for like an automatic one", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew({
      triggerKind: "manual",
      actorLogin: "alice",
    });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });
});

describe("a job that ends without a request of its own", () => {
  // #405-T06
  it("gets its check run completed by the reconciler when its lease ran out on the last attempt", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.claim();
      await t.service.syncJob(job.id);
      expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
      // No heartbeat: the lease runs out, and the next claim (or the sweep) deals with it.
      t.fixture.clock.advance(5 * MINUTE);
      await t.fixture.queue.expireStaleJobs();
    }

    const report = await t.service.reconcileDue();

    expect(report.synced).toBe(1);
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain("`lease_expired`");
    expect(await t.rowOf(job.id)).toMatchObject({ state: "settled" });
  });

  // #405-T06
  it("gets its check run completed when it ran past the hard time limit", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.service.syncJob(job.id);
    // The runner keeps its lease alive but the job outlives the hard limit.
    for (let minute = 0; minute < 30; minute += 1) {
      t.fixture.clock.advance(MINUTE);
      await t.fixture.queue.heartbeat(job.id, claimed.token);
    }
    await t.fixture.queue.expireStaleJobs();

    await t.service.reconcileDue();

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "timeout",
    });
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
    });
  });

  // #405-T06
  it("brings the check run of a job that went back to the queue back to waiting", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.claim();
    await t.service.syncJob(job.id);
    t.fixture.clock.advance(5 * MINUTE);
    await t.fixture.queue.expireStaleJobs();

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });
  });

  // #405-T10
  it("completes the check run of a waiting job that was dropped because the pull request was closed", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review cancelled" },
    });
    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The pull request was closed",
    );
  });

  // #405-T10
  it("completes the check run of a waiting job whose project was switched off", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.cancelWaitingForRepository(t.fixture.repositoryId);

    await t.service.reconcileDue();

    expect(t.checkRuns()[0]?.output?.summary).toContain(
      "The project was switched off",
    );
  });
});

describe("a job that a newer push replaced", () => {
  // #405-T08
  it("completes the check run of a waiting job as superseded, and the newer job has its own on the new commit", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    const second = await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(first.id);
    await t.service.syncJob(second.id);

    expect(t.checkRuns()).toMatchObject([
      {
        headSha: HEAD,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Superseded by a newer commit" },
      },
      { headSha: sha("b"), status: "queued", externalId: second.id },
    ]);
  });

  // #405-T09
  it("completes the check run of a running job as superseded and submits no review", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    const claimed = await t.claim({ acceptsSupersede: true });
    await t.service.syncJob(first.id);
    await t.fixture.enqueueNew({ headSha: sha("b") });
    // The superseded run reports what it used; its result is stored once and the job stays superseded.
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(first.id);

    expect(await t.fixture.queue.get(first.id)).toMatchObject({
      status: "superseded",
    });
    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Superseded by a newer commit" },
    });
    expect(t.reviews()).toEqual([]);
  });

  // #405-T11
  it("creates no check run for a job that was replaced before any was shown", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(first.id);

    expect(t.checkRuns()).toEqual([]);
    expect(await t.rowOf(first.id)).toMatchObject({ state: "settled" });
  });

  // #405-T11
  it("creates no check run for a job that was cancelled before any was shown", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
  });

  // #405-T05
  it("does show a job that failed before any check run was made", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "timeout");

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "neutral" });
  });
});

describe("repeating and overlapping syncs", () => {
  // #405-T17
  it("makes no call to GitHub when there is nothing new", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const before = t.fake.requests().length;

    await t.service.syncJob(job.id);
    await t.service.syncJob(job.id);

    expect(t.fake.requests()).toHaveLength(before);
  });

  // #405-T16
  it("makes one check run when two syncs of a job run at the same time", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();

    await Promise.all([
      t.service.syncJob(job.id),
      t.service.syncJob(job.id),
      t.service.syncJob(job.id),
    ]);

    expect(t.checkRuns()).toHaveLength(1);
  });

  // #405-T16
  it("finds the check run an earlier attempt made but did not keep, and changes that one", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const { integration, repo } = await t.target();
    // The earlier attempt: the check run exists on GitHub, and the app only knows it started to make one.
    await t.provider.publishReviewCheck?.(
      integration,
      repo,
      {
        jobId: job.id,
        headSha: HEAD,
        name: "Code Reviewer",
        status: "queued",
        title: "Waiting",
        summary: "x",
      },
      { checkRunId: null, mayExist: false },
    );
    const checks = t.fixture.db;
    await checks
      .insertInto("job_check_runs")
      .values({
        job_id: job.id,
        workspace_id: t.fixture.workspaceId,
        check_create_attempts: 1,
        next_attempt_at: t.fixture.clock.now().toISOString(),
        created_at: t.fixture.clock.now().toISOString(),
        updated_at: t.fixture.clock.now().toISOString(),
      })
      .execute();
    await t.claim();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
    expect(await t.rowOf(job.id)).toMatchObject({
      checkRunId: String(t.checkRuns()[0]?.id),
    });
  });

  it("goes round again when the job moved on while it was syncing", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    let claimed = false;
    // The job is claimed while the check run is being made.
    const original = t.fixture.queue.get;
    let reads = 0;
    t.fixture.queue.get = async (id) => {
      const result = await original(id);
      reads += 1;
      if (reads === 1 && !claimed) {
        claimed = true;
        await t.claim();
      }
      return result;
    };

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ status: "in_progress" });
  });
});

describe("an App that may not write check runs", () => {
  const WITHOUT_CHECKS = {
    metadata: "read",
    contents: "read",
    pull_requests: "write",
    issues: "write",
  } as const;

  // #405-T12
  it("leaves the job alone and has no check run: one stable log code, no retries", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const job = await t.fixture.enqueueNew();

    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.service.syncJob(job.id);
    await t.fail(claimed.job, claimed.token, "timeout");
    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
    });
    expect(await t.rowOf(job.id)).toMatchObject({
      checkState: "dropped",
      lastCode: "CHECK_RUN_PERMISSION_MISSING",
      state: "settled",
    });
    expect(
      t.lines.error.filter((line) =>
        line.includes("CHECK_RUN_PERMISSION_MISSING"),
      ),
    ).toHaveLength(1);
    expect(t.lines.error.join("\n")).toContain(`job=${job.id}`);
  });

  // #405-T12
  it("still submits the verdict, which needs another permission", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toEqual([]);
    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T12
  it("starts to show check runs for the jobs after the permission was accepted", async () => {
    const t = await createCheckRunsHarness({ permissions: WITHOUT_CHECKS });
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    t.fake.setAppPermissions({ ...WITHOUT_CHECKS, checks: "write" });

    // The App is believed to lack the permission for a while (review P3-3); after that it is asked again.
    t.fixture.clock.advance(11 * MINUTE);
    const second = await t.fixture.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    await t.service.syncJob(second.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(t.checkRuns()[0]).toMatchObject({ externalId: second.id });
  });
});

describe("GitHub failing", () => {
  // #405-T15
  it("leaves the job alone, waits and tries again, and shows the check run once GitHub is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    await t.service.syncJob(job.id);

    expect(await t.fixture.queue.get(job.id)).toMatchObject({
      status: "queued",
    });
    expect(await t.rowOf(job.id)).toMatchObject({
      state: "active",
      attempts: 1,
      lastCode: "INTEGRATION_ACCESS_UNAVAILABLE",
    });
    expect(t.lines.error.join("\n")).toContain(
      "CHECK_RUN_FAILED job=" + job.id,
    );
    // Its back-off has not passed: the reconciler leaves it alone.
    expect((await t.service.reconcileDue()).synced).toBe(0);

    t.fake.clearFailures();
    t.fixture.clock.advance(3 * MINUTE);
    expect((await t.service.reconcileDue()).synced).toBe(1);
    expect(t.checkRuns()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({ attempts: 0 });
  });

  // #405-T15
  it("gives a job up after its attempts are used up, even one with a check run that may exist", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      t.fixture.clock.advance(61 * MINUTE);
      await t.service.syncJob(job.id);
    }

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      attempts: 30,
    });
    t.fake.clearFailures();
    t.fixture.clock.advance(60 * MINUTE);
    expect((await t.service.reconcileDue()).synced).toBe(0);
    expect(t.checkRuns()).toEqual([]);
  });

  // #405-T15
  it("waits for a rate limit as long as GitHub says", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({
      pathIncludes: "/check-runs",
      status: 429,
      headers: { "retry-after": "1800" },
    });

    await t.service.syncJob(job.id);

    const row = await t.rowOf(job.id);
    expect(row?.lastCode).toBe("INTEGRATION_ACCESS_RATE_LIMITED");
    expect(Date.parse(row?.nextAttemptAt ?? "")).toBeGreaterThanOrEqual(
      t.fixture.clock.now().getTime() + 1800 * 1000,
    );
  });

  it("gives up for good on an installation that is gone", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.removeInstallation(4242);

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      lastCode: "INTEGRATION_ACCESS_CONNECTION_GONE",
    });
  });
});

describe("the verdict of a successful review", () => {
  // #405-T20
  it("requests changes on the reviewed commit for a blocking finding, with a short body and a link", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    const [review, ...others] = t.reviews();
    expect(others).toEqual([]);
    expect(review).toMatchObject({
      login: BOT,
      state: "CHANGES_REQUESTED",
      commitId: HEAD,
    });
    expect(review?.body).toContain("changes requested");
    expect(review?.body).toContain(COMMENT_URL);
    expect(review?.body).toContain(verdictMarker(job.id));
    expect(review?.body.length).toBeLessThan(400);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewId: String(review?.id),
      reviewState: "done",
      state: "settled",
    });
  });

  // #405-T21
  it("approves a review with no blocking finding", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: NO_BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "APPROVED", login: BOT }]);
  });

  // #405-T22
  it("replaces its own earlier verdict on a new push, and never touches a human review", async () => {
    const t = await createCheckRunsHarness();
    const first = await t.fixture.enqueueNew();
    const firstClaim = await t.claim();
    await t.succeed(firstClaim.job, firstClaim.token, { findings: BLOCKER });
    await t.service.syncJob(first.id);
    t.fake.addPullRequestReview(t.repo, 7, {
      login: "carol",
      event: "REQUEST_CHANGES",
      body: "Please add a test",
    });
    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "CHANGES_REQUESTED",
      carol: "CHANGES_REQUESTED",
    });
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("b") });
    const second = await t.fixture.enqueueNew({ headSha: sha("b") });
    const secondClaim = await t.claim();
    await t.succeed(secondClaim.job, secondClaim.token, { findings: CLEAN });

    await t.service.syncJob(second.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "APPROVED",
      carol: "CHANGES_REQUESTED",
    });
    expect(t.reviews().map((review) => review.state)).toEqual([
      "CHANGES_REQUESTED",
      "CHANGES_REQUESTED",
      "APPROVED",
    ]);
    // Nothing was dismissed or edited: the earlier reviews are as they were.
    expect(t.reviews()[2]?.commitId).toBe(sha("b"));
  });

  // #405-T23
  it("submits nothing for a failed job", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.fail(claimed.job, claimed.token, "llm_timeout");

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
  });

  // #405-T23
  it("submits nothing for a cancelled job", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
  });

  // #405-T24
  it("submits nothing when the pull request moved to a newer head, and says why", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("b") });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=stale_head");
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "done",
      reviewId: null,
    });
    // The check run still says the review finished.
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
  });

  // #405-T24
  it("submits nothing on a pull request that is closed", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.updatePullRequest(t.repo, 7, { state: "closed" });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=pull_request_closed");
  });

  // #405-T25
  it("does not submit a second review when the first one was submitted and its id was not kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    const { integration, repo } = await t.target();
    const earlier = await t.provider.submitReviewVerdict?.(
      integration,
      repo,
      7,
      {
        jobId: job.id,
        headSha: HEAD,
        event: "approve",
        body: `fine\n${verdictMarker(job.id)}`,
        marker: verdictMarker(job.id),
      },
      { lookForEarlier: false },
    );
    // The app only knows it started to submit one.
    const now = t.fixture.clock.now().toISOString();
    await t.fixture.db
      .insertInto("job_check_runs")
      .values({
        job_id: job.id,
        workspace_id: t.fixture.workspaceId,
        review_submit_attempts: 1,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await t.service.syncJob(job.id);

    expect(t.reviews()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewId: earlier?.reviewId,
      reviewState: "done",
    });
  });

  // #405-T26
  it("leaves the check run alone and gives the verdict up when GitHub refuses it for good", async () => {
    const t = await createCheckRunsHarness();
    t.fake.addPullRequest(t.repo, {
      number: 7,
      title: "Written by the app",
      state: "open",
      headSha: HEAD,
      headRef: "bot/change",
      baseRef: "main",
      author: { login: BOT, id: 1 },
    });
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "dropped",
      state: "settled",
    });
    expect(t.lines.error.join("\n")).toContain("REVIEW_VERDICT_REFUSED");
  });

  // #405-T26
  it("treats a forbidden review like a refused one, and retries a failing GitHub", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.fail({ pathIncludes: "/pulls/7/reviews", status: 502 });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "pending",
      attempts: 1,
    });
    t.fake.clearFailures();
    t.fixture.clock.advance(3 * MINUTE);
    await t.service.reconcileDue();
    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });
});

describe("the verdict setting", () => {
  // #405-T18
  it("off submits no review and the check run still shows the result", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("off");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
    expect(t.checkRuns()[0]?.output?.summary).toContain("switched off");
    expect(t.lines.info.join("\n")).toContain("reason=off");
  });

  // #405-T18
  it("blocking approves a review with only low priority findings", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("blocking");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: NO_BLOCKER });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });

  // #405-T18
  it("any requests changes for a finding of the lowest priority", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("any");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { open: 1, bySeverity: { P0: 0, P1: 0, P2: 0, P3: 1 } },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T19
  it("blocking submits nothing for a Diff review, whose findings have no severity", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { open: 3, bySeverity: null },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=no_severity");
    expect(t.checkRuns()[0]?.output?.summary).toContain("3 open findings.");
  });

  // #405-T19
  it("any requests changes for the active findings of a Diff review and approves when none is active", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("any");
    const first = await t.fixture.enqueueNew();
    const firstClaim = await t.claim();
    await t.succeed(firstClaim.job, firstClaim.token, {
      findings: { open: 2, bySeverity: null },
    });
    await t.service.syncJob(first.id);
    const second = await t.fixture.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    t.fake.addPullRequest(t.repo, {
      number: 8,
      title: "Another",
      state: "open",
      headSha: HEAD,
      headRef: "feature/other",
      baseRef: "main",
      author: { login: "bob", id: 1002 },
    });
    const secondClaim = await t.claim();
    await t.succeed(secondClaim.job, secondClaim.token, {
      findings: { open: 0, bySeverity: null },
    });
    await t.service.syncJob(second.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
    expect(t.fake.pullRequestReviews(t.repo, 8)).toMatchObject([
      { state: "APPROVED" },
    ]);
  });

  // #405-T19
  it("submits nothing for a result that does not say what is open", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token);

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=findings_unknown");
  });

  // #405-T19
  it("does not approve a review that stopped at its cost limit", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: CLEAN,
      usage: { stoppedEarly: "cost_limit" },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=review_incomplete");
    expect(t.checkRuns()[0]?.output?.summary).toContain("cost limit");
  });
});

describe("a verdict from a review that proves nothing", () => {
  // #405-T19 (review P1-3)
  it("does not approve a review that dropped findings or left files out, and says so in the check", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { ...CLEAN, incomplete: true },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=review_incomplete");
  });

  // #405-T19 (review P1-3)
  it("still requests changes for a blocker of a review that is incomplete", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { ...BLOCKER, incomplete: true },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toMatchObject([{ state: "CHANGES_REQUESTED" }]);
  });

  // #405-T19 (review P2-3)
  it("does not approve a result that made no model call", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: CLEAN,
      usage: { aiCalls: 0 },
    });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
    expect(t.lines.info.join("\n")).toContain("reason=no_model_work");
  });
});

const WITHOUT_CHECKS_PERMISSION = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
} as const;
const HOUR = 60 * MINUTE;

describe("no check run stays open (review P1-1)", () => {
  // #405-T15
  it("keeps trying to close a check run past the usual number of attempts, and completes it once GitHub is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    // A GitHub incident of many hours: far more failed syncs than the five that end a sync with nothing to close.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      t.fixture.clock.advance(HOUR);
      await t.service.reconcileDue();
    }

    expect(await t.rowOf(job.id)).toMatchObject({ state: "active" });
    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });
    t.fake.clearFailures();
    t.fixture.clock.advance(HOUR);
    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
    expect(await t.rowOf(job.id)).toMatchObject({ state: "settled" });
  });

  // #405-T15
  it("tries the call again within the same request before it waits, once after one second and once after three", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502, times: 2 });

    await t.service.syncJob(job.id);

    expect(t.sleeps).toEqual([1000, 3000]);
    expect(t.checkRuns()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({ attempts: 0 });
  });

  // #405-T16
  it("does not make a second check run when the call it repeats had worked and its answer was lost", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    // GitHub makes the check run and answers too late for the client, which gives up waiting.
    t.fake.fail({
      pathIncludes: "/check-runs",
      responseDelayMs: 1500,
      times: 1,
    });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toHaveLength(1);
    expect(await t.rowOf(job.id)).toMatchObject({
      checkRunId: String(t.checkRuns()[0]?.id),
    });
  });

  // #405-T12
  it("keeps the check run open for another try when the permission to write it was taken away, and closes it when it is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    t.fake.setAppPermissions(WITHOUT_CHECKS_PERMISSION);
    const claimed = await t.claim();

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({ status: "queued" });
    expect(await t.rowOf(job.id)).toMatchObject({
      state: "active",
      checkState: "active",
      lastCode: "INTEGRATION_ACCESS_SCOPE_REFUSED",
    });
    expect(
      t.lines.error.filter((line) =>
        line.includes("CHECK_RUN_PERMISSION_MISSING"),
      ),
    ).toHaveLength(1);

    t.fake.setAppPermissions({ ...WITHOUT_CHECKS_PERMISSION, checks: "write" });
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fixture.clock.advance(HOUR);
    await t.service.reconcileDue();

    expect(t.checkRuns()[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  // #405-T10
  it("waits for a connection that is switched off while a check run is open, and closes the check run when it is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    await t.setIntegrationStatus("disabled");
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    const before = t.fake.requests().length;

    await t.service.syncJob(job.id);

    expect(t.fake.requests()).toHaveLength(before);
    expect(await t.rowOf(job.id)).toMatchObject({ state: "active" });
    await t.setIntegrationStatus("active");
    t.fixture.clock.advance(HOUR);
    await t.service.reconcileDue();
    expect(t.checkRuns()[0]).toMatchObject({ conclusion: "success" });
  });

  // #405-T10 (review round 2)
  it("waits for a connection that is switched off while only the verdict is still due, and submits it when it is back", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    // The check run is completed; only the verdict cannot be sent yet.
    t.fake.fail({ pathIncludes: "/pulls/7", status: 502, times: 3 });
    await t.service.syncJob(job.id);
    expect(t.checkRuns()[0]).toMatchObject({ status: "completed" });
    expect(await t.rowOf(job.id)).toMatchObject({ reviewState: "pending" });

    await t.setIntegrationStatus("disabled");
    t.fixture.clock.advance(HOUR);
    await t.service.syncJob(job.id);
    expect(await t.rowOf(job.id)).toMatchObject({ state: "active" });

    await t.setIntegrationStatus("active");
    t.fixture.clock.advance(HOUR);
    await t.service.reconcileDue();
    expect(t.reviews()).toMatchObject([{ state: "APPROVED" }]);
  });

  // #405-T10
  it("drops a job whose connection is switched off before any check run was made", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.setIntegrationStatus("disabled");

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      lastCode: "CHECK_RUN_CONNECTION_UNAVAILABLE",
    });
  });

  // #405-T15
  it("still gives a sync up after five failures when no check run is open", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    // The check run is made and completed; only the verdict keeps failing.
    t.fake.fail({ pathIncludes: "/pulls/7", status: 502 });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      t.fixture.clock.advance(HOUR);
      await t.service.syncJob(job.id);
    }

    expect(t.checkRuns()[0]).toMatchObject({ status: "completed" });
    expect(await t.rowOf(job.id)).toMatchObject({ state: "dropped" });
  });
});

describe("a check run whose creation may have worked (review P1-2)", () => {
  async function orphan(
    t: Awaited<ReturnType<typeof createCheckRunsHarness>>,
    jobId: string,
  ) {
    const { integration, repo } = await t.target();
    // The earlier attempt: the check run exists on GitHub, and the app only knows it started to make one.
    await t.provider.publishReviewCheck?.(
      integration,
      repo,
      {
        jobId,
        headSha: HEAD,
        name: "Code Reviewer",
        status: "queued",
        title: "Waiting",
        summary: "x",
      },
      { checkRunId: null, mayExist: false },
    );
    const now = t.fixture.clock.now().toISOString();
    await t.fixture.db
      .insertInto("job_check_runs")
      .values({
        job_id: jobId,
        workspace_id: t.fixture.workspaceId,
        check_create_attempts: 1,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  // #405-T16
  it("is completed as superseded when the job was replaced before its id was kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await orphan(t, job.id);
    await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(job.id);

    expect(
      t.checkRuns().filter((run) => run.externalId === job.id),
    ).toMatchObject([
      {
        status: "completed",
        conclusion: "neutral",
        output: { title: "Superseded by a newer commit" },
      },
    ]);
    expect(await t.rowOf(job.id)).toMatchObject({ state: "settled" });
  });

  // #405-T16
  it("is completed as cancelled when the job was cancelled before its id was kept", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await orphan(t, job.id);
    await t.fixture.queue.discardWaitingForPr(t.fixture.repositoryId, 7);

    await t.service.syncJob(job.id);

    expect(t.checkRuns()).toMatchObject([
      { status: "completed", conclusion: "neutral" },
    ]);
  });

  // #405-T11
  it("makes none when the look finds none and the job ended, and forgets that it tried", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const now = t.fixture.clock.now().toISOString();
    await t.fixture.db
      .insertInto("job_check_runs")
      .values({
        job_id: job.id,
        workspace_id: t.fixture.workspaceId,
        check_create_attempts: 1,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await t.fixture.enqueueNew({ headSha: sha("b") });

    await t.service.syncJob(job.id);

    expect(t.checkRuns().filter((run) => run.externalId === job.id)).toEqual(
      [],
    );
    expect(await t.rowOf(job.id)).toMatchObject({
      state: "settled",
      checkCreateAttempts: 0,
    });
  });
});

describe("the reconcile within the time of a function (review P2-4)", () => {
  // #405-T32
  it("stops starting jobs when its budget is used up, and the rest waits for the next run", async () => {
    const t = await createCheckRunsHarness();
    for (let n = 0; n < 5; n += 1)
      await t.fixture.enqueueNew({
        prNumber: 20 + n,
        prUrl: `https://github.test/acme/widgets/pull/${String(20 + n)}`,
      });
    // Every call fails, so each job spends four simulated seconds on its waits between tries.
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    const report = await t.service.reconcileDue({ budgetMs: 9000 });

    expect(report.synced).toBe(2);
  });

  // #405-T32
  it("does not run a call for a sync whose own time is over", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({ pathIncludes: "/check-runs", status: 502 });

    await t.service.syncJob(job.id, { budgetMs: 500 });

    // No second try was started: a wait of a second would not fit.
    expect(t.sleeps).toEqual([]);
  });

  // #405-T32 (review P3-2)
  it("asks for the due jobs once for reconciles that are asked for at the same time", async () => {
    const t = await createCheckRunsHarness();
    await t.fixture.enqueueNew();

    await Promise.all([
      t.service.reconcileDue(),
      t.service.reconcileDue(),
      t.service.reconcileDue(),
    ]);

    expect(t.dueCalls.count).toBeLessThanOrEqual(2);
    expect(t.checkRuns()).toHaveLength(1);
  });
});

describe("an App without the permission, asked again and again (review P3-3)", () => {
  // #405-T12
  it("asks GitHub for a token once for the jobs that follow, until the memory of it is over", async () => {
    const t = await createCheckRunsHarness({
      permissions: WITHOUT_CHECKS_PERMISSION,
    });
    const first = await t.fixture.enqueueNew();
    await t.service.syncJob(first.id);
    const asked = t.fake.tokenRequests().length;

    const second = await t.fixture.enqueueNew({
      prNumber: 8,
      prUrl: "https://github.test/acme/widgets/pull/8",
    });
    await t.service.syncJob(second.id);

    expect(t.fake.tokenRequests()).toHaveLength(asked);
    expect(await t.rowOf(second.id)).toMatchObject({
      checkState: "dropped",
      lastCode: "CHECK_RUN_PERMISSION_MISSING",
    });
    t.fixture.clock.advance(11 * MINUTE);
    t.fake.setAppPermissions({ ...WITHOUT_CHECKS_PERMISSION, checks: "write" });
    const third = await t.fixture.enqueueNew({
      prNumber: 9,
      prUrl: "https://github.test/acme/widgets/pull/9",
    });
    await t.service.syncJob(third.id);
    expect(t.checkRuns()).toHaveLength(1);
  });
});

describe("an App that may not review, asked again and again (review round 2)", () => {
  // #405-T26
  it("asks GitHub for a token for the verdict once for the jobs that follow, until the memory of it is over", async () => {
    const t = await createCheckRunsHarness({
      permissions: {
        metadata: "read",
        contents: "read",
        issues: "write",
        checks: "write",
        pull_requests: "read",
      },
    });
    const first = await t.fixture.enqueueNew();
    const one = await t.claim();
    await t.succeed(one.job, one.token, { findings: CLEAN });
    await t.service.syncJob(first.id);
    expect(await t.rowOf(first.id)).toMatchObject({ reviewState: "dropped" });
    const asked = t.fake.tokenRequests().length;

    const second = await t.fixture.enqueueNew({ headSha: sha("b") });
    const two = await t.claim();
    await t.succeed(two.job, two.token, { findings: CLEAN });
    await t.service.syncJob(second.id);

    // Only the check run asked for a token this time: the verdict was not tried.
    expect(
      t.fake
        .tokenRequests()
        .slice(asked)
        .filter((request) => "pull_requests" in (request.permissions ?? {})),
    ).toEqual([]);
    expect(await t.rowOf(second.id)).toMatchObject({ reviewState: "dropped" });
    expect(
      t.lines.error.filter((line) => line.includes("REVIEW_VERDICT_REFUSED")),
    ).toHaveLength(1);
  });
});

describe("a refusal that is not a missing permission (review P2-7)", () => {
  // #405-T12
  it("drops an archived repository with its own code and does not call it a permission", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({
      pathIncludes: "/check-runs",
      status: 403,
      message: "Repository was archived so is read-only.",
    });

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "dropped",
      lastCode: "CHECK_RUN_REPOSITORY_ARCHIVED",
    });
    const errors = t.lines.error.join("\n");
    expect(errors).toContain("CHECK_RUN_REPOSITORY_ARCHIVED");
    expect(errors).not.toContain("CHECK_RUN_PERMISSION_MISSING");
  });

  // #405-T12
  it("retries a 403 that GitHub gives for another reason, as any failure", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    t.fake.fail({
      pathIncludes: "/check-runs",
      status: 403,
      message: "Something temporary",
      times: 1,
    });

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({
      state: "active",
      attempts: 1,
    });
    expect(t.lines.error.join("\n")).not.toContain("PERMISSION_MISSING");
    t.fixture.clock.advance(3 * MINUTE);
    await t.service.reconcileDue();
    expect(t.checkRuns()).toHaveLength(1);
  });

  // #405-T26
  it("drops the verdict for an archived repository without a retry", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.fail({
      pathIncludes: "/pulls/7/reviews",
      status: 403,
      message: "Repository was archived so is read-only.",
    });

    await t.service.syncJob(job.id);

    expect(await t.rowOf(job.id)).toMatchObject({ reviewState: "dropped" });
  });
});

describe("a link that is not to the review comment (review P3-4)", () => {
  // #405-T03
  it("is left out of the check run and of the review when it is not a comment of this pull request", async () => {
    const t = await createCheckRunsHarness();
    for (const [index, link] of [
      "https://evil.example/acme/gadgets/pull/7#issuecomment-1",
      "https://github.test/acme/widgets/pull/7#issuecomment-1",
      "https://github.test/acme/gadgets/pull/8#issuecomment-1",
      "https://github.test/acme/gadgets/pull/7",
      "javascript:alert(1)",
    ].entries()) {
      const job = await t.fixture.enqueueNew({
        headSha: sha("abcde"[index] ?? "f"),
      });
      const claimed = await t.claim();
      await t.succeed(claimed.job, claimed.token, {
        findings: CLEAN,
        commentUrl: link,
      });
      await t.service.syncJob(job.id);

      const run = t.checkRuns().find((item) => item.externalId === job.id);
      expect(run?.detailsUrl).toBeNull();
      expect(run?.output?.summary).not.toContain(link);
    }
    for (const review of t.reviews()) expect(review.body).not.toContain("](");
  });

  // #405-T03
  it("is kept when it is a comment of this pull request", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]?.detailsUrl).toBe(COMMENT_URL);
    expect(t.reviews()[0]?.body).toContain(`](${COMMENT_URL})`);
  });
});

describe("an earlier request for changes when the new review submits nothing (review P2-1)", () => {
  async function askedForChanges(
    t: Awaited<ReturnType<typeof createCheckRunsHarness>>,
  ) {
    const first = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });
    await t.service.syncJob(first.id);
    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "CHANGES_REQUESTED",
    });
    // The jobs that follow come later: events of one pull request are ordered by the time they were recorded.
    t.fixture.clock.advance(1000);
  }

  // #405-T22
  it("stays when the review that follows is incomplete, and the check run says why no verdict was submitted", async () => {
    const t = await createCheckRunsHarness();
    await askedForChanges(t);
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("c") });
    const second = await t.fixture.enqueueNew({ headSha: sha("c") });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, {
      findings: { ...CLEAN, incomplete: true },
    });

    await t.service.syncJob(second.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "CHANGES_REQUESTED",
    });
    const summary = t.checkRuns().find((run) => run.externalId === second.id)
      ?.output?.summary;
    expect(summary).toContain("No review verdict was submitted");
    expect(summary).toContain("did not cover everything");
    expect(summary).toContain("earlier request for changes");
  });

  // #405-T22
  it("is dismissed with a message when the project switched the verdict off, and nothing of a human is touched", async () => {
    const t = await createCheckRunsHarness();
    await askedForChanges(t);
    t.fake.addPullRequestReview(t.repo, 7, {
      login: "a-human",
      event: "REQUEST_CHANGES",
      body: "my own opinion",
    });
    t.setVerdictMode("off");
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("c") });
    const second = await t.fixture.enqueueNew({ headSha: sha("c") });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(second.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      "a-human": "CHANGES_REQUESTED",
    });
    const dismissed = t
      .reviews()
      .filter((review) => review.state === "DISMISSED");
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]?.login).toBe(BOT);
    expect(dismissed[0]?.dismissalMessage).toMatch(/switched off/i);
    expect(await t.rowOf(second.id)).toMatchObject({
      reviewState: "done",
      state: "settled",
    });
  });

  // #405-T22 (review round 2): `off` costs nothing where the app never asked for changes.
  it("makes no call to GitHub about the verdict when the setting is off and the app asked for nothing", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("off");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    const aboutThePullRequest = t.fake
      .requests()
      .filter((request) => request.path.includes("/pulls/"));
    expect(aboutThePullRequest).toEqual([]);
    expect(
      t.fake.tokenRequests().map((r) => Object.keys(r.permissions ?? {})),
    ).not.toContainEqual(["metadata", "pull_requests"]);
    expect(await t.rowOf(job.id)).toMatchObject({
      reviewState: "done",
      state: "settled",
    });
  });

  // #405-T22 (review round 2)
  it("makes no call either when the latest thing the app did was to approve or to take its request back", async () => {
    const t = await createCheckRunsHarness();
    await askedForChanges(t);
    t.fixture.clock.advance(MINUTE);
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("c") });
    const approved = await t.fixture.enqueueNew({ headSha: sha("c") });
    const second = await t.claim();
    await t.succeed(second.job, second.token, { findings: CLEAN });
    await t.service.syncJob(approved.id);
    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "APPROVED",
    });
    t.setVerdictMode("off");
    t.fixture.clock.advance(MINUTE);
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("d") });
    const off = await t.fixture.enqueueNew({ headSha: sha("d") });
    const third = await t.claim();
    await t.succeed(third.job, third.token, { findings: CLEAN });
    const before = t.fake.requests().length;

    await t.service.syncJob(off.id);

    const after = t.fake.requests().slice(before);
    expect(after.filter((request) => request.path.includes("/pulls/"))).toEqual(
      [],
    );
    expect(
      t.reviews().filter((review) => review.state === "DISMISSED"),
    ).toEqual([]);
  });

  // #405-T22 (review round 2)
  it("takes the request back once, and asks nothing about it on the jobs that follow", async () => {
    const t = await createCheckRunsHarness();
    await askedForChanges(t);
    t.setVerdictMode("off");
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("c") });
    const first = await t.fixture.enqueueNew({ headSha: sha("c") });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    await t.service.syncJob(first.id);
    expect(
      t.reviews().filter((review) => review.state === "DISMISSED"),
    ).toHaveLength(1);
    t.fixture.clock.advance(1000);
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("d") });
    const next = await t.fixture.enqueueNew({ headSha: sha("d") });
    const again = await t.claim();
    await t.succeed(again.job, again.token, { findings: CLEAN });
    const before = t.fake.requests().length;

    await t.service.syncJob(next.id);

    expect(
      t.fake
        .requests()
        .slice(before)
        .filter((request) => request.path.includes("/pulls/")),
    ).toEqual([]);
  });

  // #405-T22 (review round 2)
  it("is not reached by a person who copied the marker of the app into their own review", async () => {
    const t = await createCheckRunsHarness();
    t.fake.addPullRequestReview(t.repo, 7, {
      login: "a-human",
      event: "REQUEST_CHANGES",
      body: `my own opinion ${verdictMarker("job-0")}`,
    });
    t.setVerdictMode("off");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      "a-human": "CHANGES_REQUESTED",
    });
    expect(
      t.reviews().filter((review) => review.state === "DISMISSED"),
    ).toEqual([]);
  });

  // #405-T22
  it("is not dismissed when the setting is off and the app asked for nothing", async () => {
    const t = await createCheckRunsHarness();
    t.setVerdictMode("off");
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });

    await t.service.syncJob(job.id);

    expect(t.reviews()).toEqual([]);
  });

  // #405-T24
  it("is not dismissed on a pull request that is closed", async () => {
    const t = await createCheckRunsHarness();
    await askedForChanges(t);
    t.setVerdictMode("off");
    t.fake.updatePullRequest(t.repo, 7, { headSha: sha("c") });
    const second = await t.fixture.enqueueNew({ headSha: sha("c") });
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: CLEAN });
    t.fake.updatePullRequest(t.repo, 7, { state: "closed" });

    await t.service.syncJob(second.id);

    expect(t.fake.pullRequestReviewDecisions(t.repo, 7)).toEqual({
      [BOT]: "CHANGES_REQUESTED",
    });
  });
});

describe("what the tokens and the logs hold", () => {
  // #405-T34
  it("asks for a token limited to one repository and the least permissions for each call, and logs no token", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    await t.service.syncJob(job.id);
    const claimed = await t.claim();
    await t.succeed(claimed.job, claimed.token, { findings: BLOCKER });
    await t.service.syncJob(job.id);

    const scoped = t.fake
      .tokenRequests()
      .filter((request) => request.permissions !== null);
    expect(scoped.length).toBeGreaterThanOrEqual(3);
    for (const request of scoped) {
      expect(request.repositoryIds).toEqual([t.repoId]);
      expect(Object.keys(request.permissions ?? {}).sort()).toSatisfy(
        (keys: string[]) =>
          JSON.stringify(keys) === JSON.stringify(["checks", "metadata"]) ||
          JSON.stringify(keys) ===
            JSON.stringify(["metadata", "pull_requests"]) ||
          // The one read of the review comment the run posted (#657).
          JSON.stringify(keys) === JSON.stringify(["issues", "metadata"]),
      );
    }
    const logged = [...t.lines.info, ...t.lines.error].join("\n");
    for (const credential of t.fake.seenCredentials())
      expect(logged).not.toContain(credential);
  });
});

describe("keeping the review comment a run posted (#657)", () => {
  /** The review comment as the runner leaves it on the pull request: written by the app's bot, linked from the result. */
  async function postReview(
    t: Awaited<ReturnType<typeof createCheckRunsHarness>>,
    body: string,
  ) {
    const comment = t.fake.addPullRequestComment(t.repo, 7, body);
    return `https://github.test/${t.repo}/pull/7#issuecomment-${String(comment.id)}`;
  }

  // #657-T04
  it("reads the comment once the run ended and keeps its body on the row", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    const commentUrl = await postReview(t, "## Review\n\n- A finding.");
    await t.succeed(claimed.job, claimed.token, {
      commentUrl,
      findings: NO_BLOCKER,
    });

    await t.service.syncJob(job.id);

    expect(
      await createJobCheckRunsRepository(
        t.fixture.db,
        t.fixture.workspaceId,
      ).reviewCommentOf(job.id),
    ).toBe("## Review\n\n- A finding.");
  });

  // #657-T04
  it("keeps nothing for a run without a link to a comment, and an empty text for a comment that is gone", async () => {
    const t = await createCheckRunsHarness();
    const checks = createJobCheckRunsRepository(
      t.fixture.db,
      t.fixture.workspaceId,
    );
    const noLink = await t.fixture.enqueueNew({ prNumber: 7 });
    const first = await t.claim();
    await t.succeed(first.job, first.token, { commentUrl: null });
    await t.service.syncJob(noLink.id);
    expect(await checks.reviewCommentOf(noLink.id)).toBeNull();

    t.fixture.clock.advance(MINUTE);
    const gone = await t.fixture.enqueueNew({ prNumber: 7, headSha: sha("b") });
    const second = await t.claim();
    await t.succeed(second.job, second.token, {
      commentUrl: `https://github.test/${t.repo}/pull/7#issuecomment-424242`,
    });
    await t.service.syncJob(gone.id);
    expect(await checks.reviewCommentOf(gone.id)).toBe("");
  });

  // #657-T04
  it("reads the comment of a link on github.com when the repository is stored with another host, and of no other host or pull request", async () => {
    const t = await createCheckRunsHarness();
    const checks = createJobCheckRunsRepository(
      t.fixture.db,
      t.fixture.workspaceId,
    );
    const comment = t.fake.addPullRequestComment(t.repo, 7, "the findings");
    const link = (host: string, pull: number) =>
      `https://${host}/${t.repo}/pull/${String(pull)}#issuecomment-${String(comment.id)}`;

    const strange = await t.fixture.enqueueNew({ prNumber: 7 });
    const first = await t.claim();
    await t.succeed(first.job, first.token, {
      commentUrl: link("evil.example", 7),
    });
    await t.service.syncJob(strange.id);
    expect(await checks.reviewCommentOf(strange.id)).toBeNull();

    t.fixture.clock.advance(MINUTE);
    const other = await t.fixture.enqueueNew({
      prNumber: 7,
      headSha: sha("b"),
    });
    const second = await t.claim();
    await t.succeed(second.job, second.token, {
      commentUrl: link("github.com", 8),
    });
    await t.service.syncJob(other.id);
    expect(await checks.reviewCommentOf(other.id)).toBeNull();

    t.fixture.clock.advance(MINUTE);
    const own = await t.fixture.enqueueNew({ prNumber: 7, headSha: sha("c") });
    const third = await t.claim();
    await t.succeed(third.job, third.token, {
      commentUrl: link("github.com", 7),
    });
    await t.service.syncJob(own.id);
    expect(await checks.reviewCommentOf(own.id)).toBe("the findings");
  });

  // #657-T04
  it("never keeps a comment somebody else wrote, even when the result links to it", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    const stranger = t.fake.addPullRequestComment(
      t.repo,
      7,
      "buy my coins",
      "mallory",
    );
    await t.succeed(claimed.job, claimed.token, {
      commentUrl: `https://github.test/${t.repo}/pull/7#issuecomment-${String(stranger.id)}`,
    });

    await t.service.syncJob(job.id);

    expect(
      await createJobCheckRunsRepository(
        t.fixture.db,
        t.fixture.workspaceId,
      ).reviewCommentOf(job.id),
    ).toBe("");
  });

  // #657-T04
  it("keeps an empty text for a link whose comment sits below another pull request of the repository", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    // The app's own comment, but below pull request 8; the result names it as the comment of pull request 7.
    const elsewhere = t.fake.addPullRequestComment(
      t.repo,
      8,
      "the review of another pull request",
    );
    await t.succeed(claimed.job, claimed.token, {
      commentUrl: `https://github.test/${t.repo}/pull/7#issuecomment-${String(elsewhere.id)}`,
    });

    await t.service.syncJob(job.id);

    expect(
      await createJobCheckRunsRepository(
        t.fixture.db,
        t.fixture.workspaceId,
      ).reviewCommentOf(job.id),
    ).toBe("");
  });

  // #657-T04
  it("does not fail the sync when the comment cannot be read: the check run is still completed and one stable code is logged", async () => {
    const t = await createCheckRunsHarness();
    const job = await t.fixture.enqueueNew();
    const claimed = await t.claim();
    const commentUrl = await postReview(t, "a review");
    await t.succeed(claimed.job, claimed.token, { commentUrl });
    t.fake.fail({ pathIncludes: "/issues/comments/", status: 500 });

    await t.service.syncJob(job.id);

    expect(t.checkRuns()[0]).toMatchObject({ status: "completed" });
    expect(t.lines.error.join("\n")).toContain("REVIEW_COMMENT_UNREADABLE");
    expect(t.lines.error.join("\n")).not.toContain("a review");
  });
});

describe("a turn of the Implementer", () => {
  async function withTurn() {
    const t = await createCheckRunsHarness();
    await addUser(t.fixture.db, "user-1");
    const turn = await t.fixture.queue.enqueueImplementerTurn({
      repositoryId: t.fixture.repositoryId,
      baseBranch: "main",
      baseSha: HEAD,
      branch: "implementer/abc",
      instruction: "Do it.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: "req-1",
    });
    return { t, turn };
  }

  // #752-T09
  it("gets no check run, however often it is synced, claimed or ended, and no row", async () => {
    const { t, turn } = await withTurn();

    await t.service.syncJob(turn.job.id);
    await t.fixture.queue.claimNext("runner", ["implementer"]);
    await t.service.syncJob(turn.job.id);
    t.fixture.clock.advance(80 * MINUTE);
    await t.fixture.queue.expireStaleJobs();
    await t.service.syncJob(turn.job.id);
    await t.service.reconcileDue();

    expect(t.checkRuns()).toEqual([]);
    expect(
      await t.fixture.db.selectFrom("job_check_runs").selectAll().execute(),
    ).toEqual([]);
  });

  // #752-T09
  it("does not take the place of a review in the list of jobs that need check work", async () => {
    const { t, turn } = await withTurn();
    // The turn is older, so a list that did not skip it would put it first.
    t.fixture.clock.advance(1000);
    const review = await t.fixture.enqueueNew();

    const due = await listJobsWithCheckWork(
      t.fixture.db,
      t.fixture.clock.now(),
      { limit: 1 },
    );

    expect(due.map((item) => item.jobId)).toEqual([review.id]);
    expect(turn.job.id).not.toBe(review.id);
  });
});
