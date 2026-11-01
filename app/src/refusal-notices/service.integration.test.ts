// SPDX-License-Identifier: LicenseRef-Proprietary

// The notice a pull request gets when a review is refused for a limit or a suspension (#281), end to end on the
// claim: a real queue and database, the real GitHub App provider and client against the fake GitHub, and the
// notice service wired as the running server does it. No model is involved anywhere.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createRefusalNoticesRepository } from "../db/repositories/refusal-notices-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import {
  TEST_BILLING_RATES,
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { sha } from "../test-support/jobs.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { EntitlementsData } from "../workspaces/entitlements.ts";
import { MAX_ATTEMPTS, RETRY_WAIT_MS } from "./service.ts";

const PERIOD_1 = "2026-10-01T00:00:00.000Z";
// Earlier than the fixture clock (2026-10-10): a period never starts in the future.
const PERIOD_2 = "2026-10-05T00:00:00.000Z";
const MINUTE = 60 * 1000;

function entitlements(
  overrides: Partial<EntitlementsData> = {},
): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode: "own",
    limits: {
      diffRunsPerPeriod: 0,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: PERIOD_1,
    suspended: false,
    suspensionCode: null,
    ...overrides,
  };
}

const SUSPENDED = entitlements({
  limits: {
    diffRunsPerPeriod: null,
    dynamicRunsPerPeriod: null,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  suspended: true,
  suspensionCode: "overdue",
});

async function limit(h: RunnerApiHarness, data: EntitlementsData) {
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(data, null);
}

async function start(
  options: Parameters<typeof startRunnerApiHarness>[0] extends infer O
    ? O extends { refusalNotices?: infer N }
      ? N
      : never
    : never = {},
) {
  return startRunnerApiHarness({ refusalNotices: options });
}

/** Queues a review, lets the claim refuse it and waits for the notice. */
async function refuse(
  h: RunnerApiHarness,
  overrides: Parameters<RunnerApiHarness["enqueueNew"]>[0] = {},
) {
  const job = await h.enqueueNew(overrides);
  expect((await h.claim()).status).toBe(204);
  await h.notices.settled();
  return job;
}

/** The comments on a pull request of the repository the fixture's jobs are in. */
const comments = (h: RunnerApiHarness, pr = 7) =>
  h.notices.comments(h.repository.fullName, pr);

describe("the refusal of a limit", () => {
  // #281-T01
  it("posts exactly one comment on the pull request, as the app, without a runner credential or a model call", async () => {
    const h = await start();
    await limit(h, entitlements());

    const job = await refuse(h);

    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]).toMatchObject({ login: "code-reviewer-test[bot]" });
    expect(comments(h)[0]?.body).toContain("No review ran for this change.");
    expect(comments(h)[0]?.body).toContain(
      "used the reviews included for the current period",
    );
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
      attempts: 0,
    });
    // Nothing a runner or a model needs exists: no usage record, no stored key, and the only token GitHub issued
    // is the narrow one of the notice (it cannot read code or change a pull request).
    expect(
      await h.db.selectFrom("usage_records").selectAll().execute(),
    ).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    expect(
      h.fake
        .tokenRequests()
        .filter((request) => request.repositoryIds !== null),
    ).toEqual([
      expect.objectContaining({
        repositoryIds: [Number(h.repository.externalId)],
        permissions: { issues: "write", metadata: "read" },
      }),
    ]);
    expect(h.fake.revokedInstallationTokens()).toHaveLength(1);
  });

  // #281-T02
  it("posts nothing more for a second push and a manual review on the same pull request in the same period", async () => {
    const h = await start();
    await limit(h, entitlements());
    await refuse(h);

    await refuse(h, { headSha: sha("b") });
    await refuse(h, { headSha: sha("c"), triggerKind: "manual" });
    await refuse(h, { headSha: sha("d"), triggerKind: "comment", args: "" });

    expect(comments(h)).toHaveLength(1);
    // The later refusals asked GitHub nothing about comments: the record answered.
    expect(
      h.fake
        .requests()
        .filter((r) => r.method === "POST" && r.path.endsWith("/comments")),
    ).toHaveLength(1);
  });

  it("posts on another pull request of the same period", async () => {
    const h = await start();
    await limit(h, entitlements());

    await refuse(h);
    await refuse(h, { prNumber: 8, headSha: sha("b") });

    expect(comments(h, 7)).toHaveLength(1);
    expect(comments(h, 8)).toHaveLength(1);
  });

  // #281-T03
  it("may post again once the period start has moved forward and the limit is hit again", async () => {
    const h = await start();
    await limit(h, entitlements());
    await refuse(h);

    await limit(h, entitlements({ periodStart: PERIOD_2 }));
    await refuse(h, { headSha: sha("b") });

    expect(comments(h)).toHaveLength(2);
    expect(comments(h)[0]?.body).toContain(`period=${PERIOD_1}`);
    expect(comments(h)[1]?.body).toContain(`period=${PERIOD_2}`);
    // The first one was neither edited nor removed.
    expect(comments(h)[0]?.revision).toBe(1);
  });
});

describe("the refusal of a suspended workspace", () => {
  // #281-T04
  it("posts a neutral comment with no reason", async () => {
    const h = await start();
    await limit(h, SUSPENDED);

    await refuse(h);

    const [comment] = comments(h);
    expect(comment?.body).toContain("No review ran for this change.");
    expect(comment?.body).toContain("Reviews are paused for this workspace.");
    expect(comment?.body).not.toMatch(/overdue|reason|because/i);
  });

  // #281-T04
  it("posts once for the whole backlog of the workspace", async () => {
    const h = await start();
    await limit(h, SUSPENDED);
    await h.enqueueNew({ prNumber: 7 });
    await h.enqueueNew({ prNumber: 8, headSha: sha("b") });

    expect((await h.claim()).status).toBe(204);
    await h.notices.settled();

    expect(comments(h, 7)).toHaveLength(1);
    expect(comments(h, 8)).toHaveLength(1);
  });
});

describe("the link", () => {
  // #281-T09
  it("has none when the instance has no plan page", async () => {
    const h = await start();
    await limit(h, entitlements());

    await refuse(h);

    expect(comments(h)[0]?.body).not.toMatch(/https?:\/\//);
  });

  // #284-T01
  it("posts the notice without a link when the link cannot be worked out", async () => {
    const h = await start({
      planPageUrl: () =>
        Promise.reject(new Error("the settings could not be read")),
    });
    await limit(h, entitlements());

    await refuse(h);

    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]?.body).not.toMatch(/https?:\/\//);
  });

  it("points to the plan page of the workspace when the instance has one", async () => {
    const h = await start({
      planPageUrl: (slug) => `https://app.example/w/${slug}/settings/plan`,
    });
    await limit(h, entitlements());

    await refuse(h);

    expect(comments(h)[0]?.body).toMatch(
      /\(https:\/\/app\.example\/w\/[a-z0-9-]+\/settings\/plan\)/,
    );
  });
});

describe("what gets no notice", () => {
  // #281-T07
  it("a closed pull request", async () => {
    const h = await start();
    await limit(h, entitlements());

    await refuse(h, { prNumber: 9, headSha: sha("c") });
    await refuse(h, { prNumber: 10, headSha: sha("d") });

    expect(comments(h, 9)).toEqual([]);
    expect(comments(h, 10)).toEqual([]);
    expect(h.notices.lines).toEqual([]);
  });

  // #281-T07
  it("a draft that the automatic review would skip, but a draft somebody asked a review for does", async () => {
    const h = await start();
    h.fake.addPullRequest(h.repository.fullName, {
      number: 11,
      title: "Work in progress",
      state: "open",
      draft: true,
      headSha: sha("e"),
      headRef: "wip",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    await limit(h, entitlements());

    await refuse(h, {
      prNumber: 11,
      headSha: sha("e"),
      triggerKind: "webhook",
    });
    expect(comments(h, 11)).toEqual([]);

    await refuse(h, { prNumber: 11, headSha: sha("f"), triggerKind: "manual" });
    expect(comments(h, 11)).toHaveLength(1);
  });

  // #281-T10
  it("an instance with no entitlements: nothing is refused and nothing is posted", async () => {
    const h = await start();
    const job = await h.enqueueNew();

    const claimed = await h.claim();
    await h.notices.settled();

    expect(claimed.status).toBe(200);
    expect((await h.queue.get(job.id))?.status).toBe("running");
    expect(h.notices.refusals).toEqual([]);
    expect(comments(h)).toEqual([]);
  });

  // #281-T10
  it("a workspace that is under its limit", async () => {
    const h = await start();
    await limit(
      h,
      entitlements({
        limits: {
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
      }),
    );
    await h.enqueueNew();

    expect((await h.claim()).status).toBe(200);
    await h.notices.settled();

    expect(comments(h)).toEqual([]);
  });

  it("the other refusals of the claim (entitlements that cannot be read)", async () => {
    const h = await start();
    await h.db
      .insertInto("workspace_entitlements")
      .values({
        workspace_id: h.workspaceId,
        plan_label: "plan",
        key_mode: "own",
        limits: "{ damaged",
        period_start: PERIOD_1,
        suspended: 0,
        suspension_code: null,
        updated_by: null,
        updated_at: PERIOD_1,
      })
      .execute();

    const job = await refuse(h);

    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "entitlements_invalid",
    });
    expect(comments(h)).toEqual([]);
  });
});

describe("when GitHub refuses the comment", () => {
  // #281-T06
  it.each([
    ["403", { status: 403 }, "INTEGRATION_ACCESS_CONNECTION_SUSPENDED"],
    ["404", { status: 404 }, "INTEGRATION_ACCESS_CONNECTION_GONE"],
    ["500", { status: 500 }, "INTEGRATION_ACCESS_UNAVAILABLE"],
  ] as const)(
    "leaves the job as it was and logs one line with the code (%s)",
    async (_name, failure, code) => {
      const h = await start();
      await limit(h, entitlements());
      h.fake.fail({ pathIncludes: "/issues/7/comments", ...failure });

      const job = await refuse(h);

      expect(await h.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
      expect(comments(h)).toEqual([]);
      expect(h.notices.lines).toHaveLength(1);
      expect(h.notices.lines[0]).toContain("REFUSAL_NOTICE_FAILED");
      expect(h.notices.lines[0]).toContain(code);
      // No title, name, token or body in the line.
      expect(h.notices.lines[0]).not.toMatch(/acme|widgets|ghs_|No review ran/);
    },
  );

  // #281-T06
  it("leaves the job as it was when GitHub does not answer in time", async () => {
    const h = await start({ githubRequestTimeoutMs: 300 });
    await limit(h, entitlements());
    h.fake.fail({ pathIncludes: "/issues/7/comments", hang: true });

    const job = await refuse(h);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(h.notices.lines).toHaveLength(1);
    expect(h.notices.lines[0]).toContain("INTEGRATION_ACCESS_UNAVAILABLE");
  });

  // #281-T06
  it("does not try again at every push: it waits, and gives up after a few attempts", async () => {
    const h = await start();
    await limit(h, entitlements());
    h.fake.fail({ pathIncludes: "/issues/7/comments", status: 403 });
    // Every request about the comments of the pull request (a retry looks before it posts).
    const posts = () =>
      h.fake.requests().filter((r) => r.path.endsWith("/issues/7/comments"))
        .length;
    await refuse(h);
    expect(posts()).toBe(1);

    // Pushes within the wait make no request at GitHub for the comment.
    await refuse(h, { headSha: sha("b") });
    await refuse(h, { headSha: sha("c") });
    expect(posts()).toBe(1);

    // After the wait the next refusal tries once more; and so on, up to the attempts.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      h.clock.advance(RETRY_WAIT_MS * (attempt - 1) + MINUTE);
      await refuse(h, {
        headSha: sha(`${attempt}0`.slice(0, 1) === "2" ? "d" : "e"),
      });
      expect(posts()).toBe(attempt);
    }
    h.clock.advance(24 * 60 * MINUTE);
    await refuse(h, { headSha: sha("f") });
    expect(posts()).toBe(MAX_ATTEMPTS);
    expect(
      await createRefusalNoticesRepository(h.db, h.workspaceId).find({
        repositoryId: h.repositoryId,
        prNumber: 7,
        periodStart: PERIOD_1,
      }),
    ).toMatchObject({ state: "pending", attempts: MAX_ATTEMPTS });
  });

  // #281-T06
  it("is tried again by the sweep after the wait, and then posts once", async () => {
    const h = await start();
    await limit(h, entitlements());
    h.fake.fail({ pathIncludes: "/issues/7/comments", status: 500, times: 1 });
    await refuse(h);
    expect(comments(h)).toEqual([]);

    // Before the wait nothing is due.
    expect(await h.notices.service().retryDue()).toEqual({ tried: 0 });
    h.clock.advance(RETRY_WAIT_MS + MINUTE);

    expect(await h.notices.service().retryDue()).toEqual({ tried: 1 });
    expect(comments(h)).toHaveLength(1);
    expect(await h.notices.service().retryDue()).toEqual({ tried: 0 });
    expect(comments(h)).toHaveLength(1);
  });

  // #281-T08
  it("does not post a second time when an attempt posted and stopped before it noted it", async () => {
    const h = await start();
    await limit(h, entitlements());
    await refuse(h);
    expect(comments(h)).toHaveLength(1);
    // The first instance posted, then stopped before it marked the record: the record is pending again.
    await h.db
      .updateTable("refusal_notices")
      .set({ state: "pending", posted_at: null, next_attempt_at: PERIOD_1 })
      .execute();

    expect(await h.notices.service().retryDue()).toEqual({ tried: 1 });

    expect(comments(h)).toHaveLength(1);
    expect(
      await createRefusalNoticesRepository(h.db, h.workspaceId).find({
        repositoryId: h.repositoryId,
        prNumber: 7,
        periodStart: PERIOD_1,
      }),
    ).toMatchObject({ state: "posted" });
  });
});

describe("a notice that cannot be attempted when it is due again", () => {
  /** Rows that wait for another attempt, made the way a failed first attempt leaves them. */
  async function dueRows(h: RunnerApiHarness, prNumbers: number[]) {
    const notices = createRefusalNoticesRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    );
    for (const prNumber of prNumbers) {
      await notices.begin(
        { repositoryId: h.repositoryId, prNumber, periodStart: PERIOD_1 },
        "quota_exhausted",
        { leaseMs: MINUTE, maxAttempts: MAX_ATTEMPTS },
      );
      h.clock.advance(1000);
    }
    h.clock.advance(5 * MINUTE);
    return notices;
  }
  const keyOf = (h: RunnerApiHarness, prNumber: number) => ({
    repositoryId: h.repositoryId,
    prNumber,
    periodStart: PERIOD_1,
  });
  const UNREADABLE = Array.from({ length: 22 }, (_, index) => 101 + index);

  // #281-P2
  it("drops the ones whose pull request is gone, so a newer one is still posted", async () => {
    const h = await start();
    // 22 pull requests the fake does not know (404), then one that is there and newer.
    const notices = await dueRows(h, [...UNREADABLE, 7]);

    await h.notices.service().retryDue();
    await h.notices.service().retryDue();

    expect(comments(h, 7)).toHaveLength(1);
    expect(await notices.find(keyOf(h, 101))).toMatchObject({
      state: "dropped",
    });
    expect(await notices.find(keyOf(h, 7))).toMatchObject({ state: "posted" });
  });

  // #281-P2
  it("counts an attempt for the ones GitHub cannot answer for now, so a newer one is still posted and none is read for ever", async () => {
    const h = await start();
    for (const prNumber of UNREADABLE)
      h.fake.addPullRequest(h.repository.fullName, {
        number: prNumber,
        title: "Change",
        state: "open",
        headSha: sha("a"),
        headRef: `feature/${prNumber}`,
        baseRef: "main",
        author: { login: "alice", id: 1001 },
      });
    // `/pulls/10x`, `/pulls/11x`, `/pulls/12x` fail; `/pulls/7` does not.
    h.fake.fail({ pathIncludes: "/pulls/1", status: 500 });
    const notices = await dueRows(h, [...UNREADABLE, 7]);
    const reads = () =>
      h.fake.requests().filter((r) => /\/pulls\/1\d\d$/.test(r.path)).length;

    await h.notices.service().retryDue();
    await h.notices.service().retryDue();

    expect(comments(h, 7)).toHaveLength(1);
    // They wait now (not due, not dropped) and were counted.
    expect(await notices.find(keyOf(h, 101))).toMatchObject({
      state: "pending",
      attempts: 2,
    });

    // However many runs follow, no row is read more than the attempts allow.
    for (let run = 0; run < 6; run += 1) {
      h.clock.advance(60 * MINUTE);
      await h.notices.service().retryDue();
      await h.notices.service().retryDue();
    }
    expect(reads()).toBeLessThanOrEqual(UNREADABLE.length * MAX_ATTEMPTS);
    expect(await notices.find(keyOf(h, 101))).toMatchObject({
      state: "pending",
      attempts: MAX_ATTEMPTS,
    });
  });

  // #281-P2
  it("drops a notice whose connection is no longer active", async () => {
    const h = await start();
    const notices = await dueRows(h, [7]);
    await h.db
      .updateTable("integrations")
      .set({ status: "disabled" })
      .execute();

    expect(await h.notices.service().retryDue()).toEqual({ tried: 1 });

    expect(await notices.find(keyOf(h, 7))).toMatchObject({ state: "dropped" });
    expect(comments(h, 7)).toEqual([]);
    expect(await h.notices.service().retryDue()).toEqual({ tried: 0 });
  });
});

describe("two app instances", () => {
  // #281-T08
  it("post one comment when they refuse jobs of the same pull request at the same time", async () => {
    const h = await start({ deliver: "manual" });
    await limit(h, entitlements());
    await h.enqueueNew();
    expect((await h.claim()).status).toBe(204);
    await h.enqueueNew({ headSha: sha("b") });
    expect((await h.claim()).status).toBe(204);
    const [first, second] = h.notices.refusals;
    if (first === undefined || second === undefined)
      throw new Error("expected two refusals");
    const instances = [h.notices.another(), h.notices.another()];

    await Promise.all([
      instances[0]?.onRefused(first),
      instances[1]?.onRefused(second),
    ]);

    expect(comments(h)).toHaveLength(1);
  });
});

describe("the refusal for the balance", () => {
  /** Billing is on and the workspace has no credit: the claim cannot hold anything. */
  async function billed(options: Parameters<typeof start>[0] = {}) {
    const h = await start(options);
    await setBillingSwitch(h.db, true);
    return h;
  }

  // #498-T03
  it("posts one comment per pull request head, as the app, and none for the same head again", async () => {
    const h = await billed();

    const job = await refuse(h);
    await refuse(h, { triggerKind: "manual" });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
      attempts: 0,
    });
    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]).toMatchObject({ login: "code-reviewer-test[bot]" });
    expect(comments(h)[0]?.body).toContain("No review ran for this change.");
    expect(comments(h)[0]?.body).toContain("Add credit to continue");
    expect(comments(h)[0]?.body).toContain(`head:${sha("a")}`);
    // Nothing a runner or a model needs exists, and the balance holds nothing.
    expect(
      await h.db.selectFrom("usage_records").selectAll().execute(),
    ).toEqual([]);
    expect(
      await h.db.selectFrom("billing_journal_entries").selectAll().execute(),
    ).toEqual([]);
  });

  // #498-T03
  it("posts again for a new push, which is a new head", async () => {
    const h = await billed();
    await refuse(h);

    await refuse(h, { headSha: sha("b") });

    expect(comments(h)).toHaveLength(2);
    expect(comments(h)[1]?.body).toContain(`head:${sha("b")}`);
  });

  // #498-T04
  it("tells a workspace whose balance is below zero that it is", async () => {
    const h = await billed();
    await fundWorkspace(h.db, h.workspaceId, 1_000);
    await createBillingJournalRepository(h.db, h.workspaceId).append({
      type: "refund",
      amountMicroUsd: -5_000,
      provider: "manual",
      providerRef: "refund-1",
      refKey: "refund-1",
    });

    const job = await refuse(h);

    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "balance_negative",
    });
    expect(comments(h)[0]?.body).toContain("below zero");
  });

  // #498-T03
  it("links to the workspace settings when the instance can name them, and has no link otherwise", async () => {
    const without = await billed();
    await refuse(without);
    expect(comments(without)[0]?.body).not.toMatch(/https?:\/\//);

    const withLink = await billed({
      settingsUrl: (slug) => `https://app.example/w/${slug}/settings`,
    });
    await refuse(withLink);
    expect(comments(withLink)[0]?.body).toMatch(
      /\[the workspace settings\]\(https:\/\/app\.example\/w\/[a-z0-9-]+\/settings\)/,
    );
  });

  // #498-T03
  it("posts nothing when billing is off, and the job runs", async () => {
    const h = await start();
    const job = await h.enqueueNew();

    const claimed = await h.claim();
    await h.notices.settled();

    expect(claimed.status).toBe(200);
    expect((await h.queue.get(job.id))?.status).toBe("running");
    expect(comments(h)).toEqual([]);
  });
});

describe("the refusal for a billing setup that is not complete (#632)", () => {
  /** Billing is switched on, but a rate is missing: the claim refuses every job with `billing_rates_incomplete`. */
  async function incomplete(options: Parameters<typeof start>[0] = {}) {
    const h = await start(options);
    await setBillingSwitch(h.db, true, null);
    return h;
  }

  // #632-T03 (replaces #498-T15, which posted nothing: the refusal was silent on the pull request)
  it("posts one comment per pull request head, as the app, with no link, and none for the same head again", async () => {
    const h = await incomplete({
      settingsUrl: (slug) => `https://app.example/w/${slug}/settings`,
      planPageUrl: (slug) => `https://app.example/w/${slug}/settings/plan`,
    });

    const job = await refuse(h);
    await refuse(h, { triggerKind: "manual" });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "billing_rates_incomplete",
      attempts: 0,
    });
    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]).toMatchObject({ login: "code-reviewer-test[bot]" });
    expect(comments(h)[0]?.body).toContain("No review ran for this change.");
    expect(comments(h)[0]?.body).toContain("billing setup is not complete");
    expect(comments(h)[0]?.body).toContain(`head:${sha("a")}`);
    expect(comments(h)[0]?.body).not.toMatch(/https?:\/\//);
  });

  // #632-T03
  it("posts again for a new push, which is a new head", async () => {
    const h = await incomplete();
    await refuse(h);

    await refuse(h, { headSha: sha("b") });

    expect(comments(h)).toHaveLength(2);
    expect(comments(h)[1]?.body).toContain(`head:${sha("b")}`);
  });

  // #632-T04
  it("posts the comment for a job a Dispatcher claimed by its id, as in a hosted deployment", async () => {
    const h = await incomplete();
    const job = await h.enqueueNew();

    const claimed = await h.claim({
      jobId: job.id,
      engines: ["pr-agent"],
      features: ["worker_credential", "vm_lifecycle"],
    });
    await h.notices.settled();

    expect(claimed.status).toBe(204);
    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "billing_rates_incomplete",
    });
    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]?.body).toContain("billing setup is not complete");
  });
});

describe("the refusal for the monthly limit and the hidden brake (#499)", () => {
  /** Billing is on, the workspace has plenty of credit, and the brake's number is a distinctive one. */
  async function billed(
    options: Parameters<typeof start>[0] = {},
    rates: Parameters<typeof setBillingSwitch>[2] = {
      ...TEST_BILLING_RATES,
      hourlyReviewLimit: 37,
    },
  ) {
    const h = await start(options);
    await setBillingSwitch(h.db, true, rates);
    await fundWorkspace(h.db, h.workspaceId, 1_000_000_000, h.clock.now);
    return h;
  }

  /** A review of this month that ended and was charged `micro`: the limit is reached when the charges equal it. */
  async function chargeMonth(
    h: Awaited<ReturnType<typeof start>>,
    micro: number,
  ) {
    const journal = createBillingJournalRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    );
    await journal.reserve(micro, "charged-job");
    await journal.settle("charged-job", {
      aiMicroUsd: micro,
      infraMicroUsd: 0,
      minutes: 1,
      reviewKind: "diff",
    });
  }

  // #499-T01
  it("posts one comment per pull request head for the monthly limit, as the app, and none for the same head again", async () => {
    const h = await billed();
    await createBillingWorkspaceSettingsRepository(
      h.db,
      h.workspaceId,
    ).setMonthlyLimit(1_000, null);
    await chargeMonth(h, 1_000);

    const job = await refuse(h);
    await refuse(h, { triggerKind: "manual" });

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "monthly_limit_reached",
      attempts: 0,
    });
    expect(comments(h)).toHaveLength(1);
    expect(comments(h)[0]).toMatchObject({ login: "code-reviewer-test[bot]" });
    expect(comments(h)[0]?.body).toContain("No review ran for this change.");
    expect(comments(h)[0]?.body).toContain("monthly spending limit");
    expect(comments(h)[0]?.body).toContain(`head:${sha("a")}`);
    expect(
      await h.db.selectFrom("usage_records").selectAll().execute(),
    ).toEqual([]);
  });

  // #499-T01
  it("posts again for a new push, and links to the workspace settings when the instance can name them", async () => {
    const h = await billed({
      settingsUrl: (slug) => `https://app.example/w/${slug}/settings`,
    });
    await createBillingWorkspaceSettingsRepository(
      h.db,
      h.workspaceId,
    ).setMonthlyLimit(1_000, null);
    await chargeMonth(h, 1_000);
    await refuse(h);

    await refuse(h, { headSha: sha("b") });

    expect(comments(h)).toHaveLength(2);
    expect(comments(h)[1]?.body).toContain(`head:${sha("b")}`);
    expect(comments(h)[0]?.body).toMatch(
      /\[the workspace settings\]\(https:\/\/app\.example\/w\/[a-z0-9-]+\/settings\)/,
    );
  });

  // #499-T06
  it("posts that reviews are paused for a while for the brake, and neither the notice nor any log line names the number or the window", async () => {
    const h = await billed({
      settingsUrl: (slug) => `https://app.example/w/${slug}/settings`,
      planPageUrl: (slug) => `https://app.example/w/${slug}/settings/plan`,
    });
    // 37 reviews have started within the hour; the next push is refused.
    for (let started = 0; started < 37; started += 1) {
      h.clock.advance(1);
      const old = await h.seedHistoricalJob({
        command: "review",
        prNumber: 1_000 + started,
      });
      await createUsageRecordsRepository(
        h.db,
        h.workspaceId,
        h.clock.now,
      ).reserve(old.id, "own");
    }

    const job = await refuse(h);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "reviews_paused",
    });
    expect(comments(h)).toHaveLength(1);
    const body = comments(h)[0]?.body ?? "";
    expect(body).toContain(
      "Reviews are paused for this workspace for a while.",
    );
    const visibleText = body.replace(/<!--[\s\S]*?-->/g, "");
    expect(visibleText).not.toMatch(/37|60|\bhour|minute|\blimit/i);
    expect(visibleText).not.toMatch(/https?:\/\//);
    const lines = [...h.logLines(), ...h.notices.lines];
    expect(lines.join("\n")).not.toMatch(/\b37\b|\bhour(s|ly)?\b|60 min/i);
  });

  // #499-T06
  it("posts nothing for a claim that could not evaluate the limits: that is the operator's side", async () => {
    const h = await billed();
    await sql`alter table billing_workspace_settings rename to settings_gone`.execute(
      h.db,
    );

    const job = await refuse(h);

    expect(await h.queue.get(job.id)).toMatchObject({
      errorCode: "billing_limits_unreadable",
    });
    expect(comments(h)).toEqual([]);
  });
});

describe("the refusal of a turn of the Implementer", () => {
  async function enqueueTurn(h: Awaited<ReturnType<typeof start>>) {
    await addUser(h.db, "user-1");
    return h.queue.enqueueImplementerTurn({
      repositoryId: h.repositoryId,
      baseBranch: "main",
      baseSha: sha("b"),
      branch: "implementer/abc",
      instruction: "Do it.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: "req-1",
    });
  }

  /** What a refused turn must leave: no comment on any pull request number, no notice row, no token for GitHub. */
  async function expectNoNotice(h: Awaited<ReturnType<typeof start>>) {
    for (const number of [-1, -2, -3, 0, 1, 7, 8, 9, 10])
      expect(comments(h, number)).toEqual([]);
    expect(
      await h.db.selectFrom("refusal_notices").selectAll().execute(),
    ).toEqual([]);
    expect(h.github.fake.tokenRequests()).toEqual([]);
    // Without the gate the service would look the placeholder number up on GitHub and log that it cannot read it.
    expect(h.notices.lines).toEqual([]);
  }

  // #752-T09
  it("posts no comment on any pull request and creates no notice row for a suspended workspace", async () => {
    const h = await start();
    await limit(h, SUSPENDED);
    const result = await enqueueTurn(h);
    if (result.status !== "created") throw new Error("expected a new turn");

    expect(await h.queue.claimNext("runner", ["implementer"])).toBeNull();
    await h.notices.settled();

    expect(await h.queue.get(result.job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
    expect(h.notices.refusals).toEqual([
      expect.objectContaining({
        jobId: result.job.id,
        reviewKind: "implementer",
      }),
    ]);
    await expectNoNotice(h);
  });

  // #752-T09: a refusal for the balance carries a head key as its period, so only the gate of the kind keeps it off GitHub.
  it("posts no comment and creates no notice row for a turn refused for the balance", async () => {
    const h = await start();
    await setBillingSwitch(h.db, true);
    const result = await enqueueTurn(h);
    if (result.status !== "created") throw new Error("expected a new turn");

    expect(await h.queue.claimNext("runner", ["implementer"])).toBeNull();
    await h.notices.settled();

    expect(await h.queue.get(result.job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
    expect(h.notices.refusals).toEqual([
      expect.objectContaining({
        jobId: result.job.id,
        reviewKind: "implementer",
        errorCode: "insufficient_balance",
        periodStart: expect.stringMatching(/^head:/),
      }),
    ]);
    await expectNoNotice(h);
  });
});
