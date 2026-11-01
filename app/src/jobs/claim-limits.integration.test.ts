// SPDX-License-Identifier: LicenseRef-Proprietary

// The limits and the suspension of a workspace at claim (#277; src/usage/README.md, "Limits"). The check and the reservation of the usage record happen in
// one transaction of the queue's claim, so a refused job leaves no record and two claims never pass the last unit.
// The runner API tests (integration-tests/http/runner-api-limits.integration.test.ts) pin what a runner is
// handed on each claim path.
import { describe, expect, it, vi } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import {
  createJobQueueFixture,
  sha,
  type JobQueueFixture,
} from "../test-support/jobs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import type {
  EntitlementLimits,
  EntitlementsData,
} from "../workspaces/entitlements.ts";
import { createJobQueue } from "./job-queue.ts";
import { createRunnerQueue } from "./runner-queue.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PERIOD_START = "2026-10-01T00:00:00.000Z";
const ENGINES = ["pr-agent", "opencode"] as const;

const open = async () => (await createTestDatabase({ poolMax: 12 })).db;

type EntitlementOverrides = Partial<Omit<EntitlementsData, "limits">> & {
  limits?: Partial<EntitlementLimits>;
};

function entitlements(overrides: EntitlementOverrides = {}): EntitlementsData {
  const { limits, ...rest } = overrides;
  return {
    planLabel: "plan",
    keyMode: "own",
    periodStart: PERIOD_START,
    suspended: false,
    suspensionCode: null,
    ...rest,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
      ...limits,
    },
  };
}

describe("the limits at claim", () => {
  async function start() {
    const database = await open();
    return createJobQueueFixture({
      ...(database === undefined ? {} : { database }),
      dynamicReview: true,
    });
  }

  function entitlementsOf(fixture: JobQueueFixture, workspaceId?: string) {
    return createWorkspaceEntitlementsRepository(
      fixture.db,
      workspaceId ?? fixture.workspaceId,
      fixture.clock.now,
    );
  }

  const setEntitlements = (
    fixture: JobQueueFixture,
    overrides: EntitlementOverrides,
    workspaceId?: string,
  ) => entitlementsOf(fixture, workspaceId).put(entitlements(overrides), null);

  const recordsOf = (fixture: JobQueueFixture) =>
    createUsageRecordsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );

  const allRecords = (fixture: JobQueueFixture) =>
    fixture.db.selectFrom("usage_records").selectAll().execute();

  let next = 0;
  /** A new waiting job on a pull request of its own (so any number can run at once). */
  function enqueue(
    fixture: JobQueueFixture,
    reviewKind: "diff" | "dynamic" = "diff",
  ) {
    next += 1;
    // Jobs are claimed oldest first: each one is a millisecond younger than the one before.
    fixture.clock.advance(1);
    return fixture.enqueueNew({
      prNumber: 100 + next,
      reviewKind,
    });
  }

  /** Claims, notes the key it ran on and completes a run with a cost, as a runner would. */
  async function runToCompletion(
    fixture: JobQueueFixture,
    options: { costUsd: number | null; managed: boolean },
  ) {
    const job = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);
    expect(claimed?.job.id).toBe(job.id);
    // The claim reserved the record on the key mode it decided (the entitlements', billing being off); a run on the other key is
    // noted the way a test of the usage record has to say it.
    await recordsOf(fixture).setKeyMode(
      job.id,
      options.managed ? "managed" : "own",
    );
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          costUsd: options.costUsd,
        },
      },
    });
    return job;
  }

  // #277-T01
  it("claims as before when the workspace has no entitlements", async () => {
    const fixture = await start();
    const jobs = [await enqueue(fixture), await enqueue(fixture)];

    for (const job of jobs)
      expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);

    expect(await allRecords(fixture)).toHaveLength(2);
  });

  // #277-T01
  it("claims as before when the entitlements put no limit on anything", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {});
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #277-T02
  it("runs Diff jobs up to the limit and fails the next one, which no runner gets", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 2 } });
    const [first, second, third] = [
      await enqueue(fixture),
      await enqueue(fixture),
      await enqueue(fixture),
    ];

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(first.id);
    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(second.id);
    expect(await fixture.queue.claimNext("runner-c")).toBeNull();

    expect(await fixture.queue.get(third.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
      // Nothing started: no holder and no start time, so the Runs list shows no duration (#277-P3).
      runnerId: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      finishedAt: fixture.clock.now().toISOString(),
      attempts: 0,
    });
    expect(await recordsOf(fixture).get(third.id)).toBeUndefined();
    expect(await allRecords(fixture)).toHaveLength(2);
    const stored = await fixture.db
      .selectFrom("jobs")
      .select("lease_token")
      .where("id", "=", third.id)
      .executeTakeFirstOrThrow();
    expect(stored.lease_token).toBeNull();
  });

  // #277-T02
  it("counts runs that settled as well as runs that are still reserved", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 2 } });
    await runToCompletion(fixture, { costUsd: 0.01, managed: false });
    await enqueue(fixture);
    expect(await fixture.queue.claimNext("runner-a")).not.toBeNull();
    const refused = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();

    expect(await fixture.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });

  // #277-T03
  it("fails every Dynamic job when the Dynamic limit is 0 and leaves Diff jobs alone", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { dynamicRunsPerPeriod: 0 } });
    const dynamic = await enqueue(fixture, "dynamic");
    const diff = await enqueue(fixture, "diff");

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(diff.id);
    expect(await fixture.queue.get(dynamic.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(await recordsOf(fixture).get(dynamic.id)).toBeUndefined();
  });

  // #277-T03
  it("counts the runs of each kind on their own", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { diffRunsPerPeriod: 1, dynamicRunsPerPeriod: 1 },
    });
    const diff = await enqueue(fixture, "diff");
    const dynamic = await enqueue(fixture, "dynamic");

    expect((await fixture.queue.claimNext("runner-a", ENGINES))?.job.id).toBe(
      diff.id,
    );
    expect((await fixture.queue.claimNext("runner-b", ENGINES))?.job.id).toBe(
      dynamic.id,
    );
  });

  // #277-T04
  it("fails a managed job once the settled managed cost reaches the limit, and not a job on the own key", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 5_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 3, managed: true });
    await runToCompletion(fixture, { costUsd: 2, managed: true });
    const refused = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a")).toBeNull();

    expect(await fixture.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
    expect(await recordsOf(fixture).get(refused.id)).toBeUndefined();
    // The workspace now reviews on its own key: the cost limit is about the operator's.
    // An entry of this shape cannot be written any more (#277), but one stored earlier still reads.
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({ key_mode: "own" })
      .execute();
    const own = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(own.id);
  });

  // #277-T04
  it("lets a managed job run while the cost is below the limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 5_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 4.999999, managed: true });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #277-T04
  it("does not count the cost of a run on the own key against the managed limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 1_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 9, managed: false });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #277-T05
  it("fails every job of a suspended workspace and runs the next one once the suspension is cleared", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      suspended: true,
      suspensionCode: "overdue",
    });
    const diff = await enqueue(fixture, "diff");
    const dynamic = await enqueue(fixture, "dynamic");

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    for (const job of [diff, dynamic])
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "workspace_suspended",
      });
    expect(await allRecords(fixture)).toEqual([]);
    await setEntitlements(fixture, {});
    const later = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(later.id);
  });

  // #277-T05
  it("applies the default entitlements to a workspace without a row", async () => {
    const fixture = await start();
    await createInstanceSettingsRepository(fixture.db, fixture.clock.now).set(
      "default_entitlements",
      entitlements({ suspended: true, suspensionCode: "overdue" }),
      null,
    );
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a")).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
  });

  // #271 follow-up: unreadable entitlements fail closed
  it("fails the job instead of running it when the stored entitlements cannot be read", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 5 } });
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();
    const job = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-a")).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "entitlements_invalid",
    });
    expect(await allRecords(fixture)).toEqual([]);
  });

  // #277-T07
  it("leaves no usage record for a refused job", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    await enqueue(fixture);

    await fixture.queue.claimNext("runner-a");

    expect(await allRecords(fixture)).toEqual([]);
  });

  // #277-T08
  it("runs a job claimed again after a lost lease although the limit is reached, with the one record it has", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const job = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    fixture.clock.advance(3 * MINUTE);

    const again = await fixture.queue.claimNext("runner-b");

    expect(again?.job).toMatchObject({ id: job.id, attempts: 1 });
    expect(await allRecords(fixture)).toHaveLength(1);
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "reserved",
    });
  });

  // #277-T08
  it("does not let a job that lost its lease run once the workspace is suspended, and voids its record", async () => {
    const fixture = await start();
    const job = await enqueue(fixture);
    await fixture.queue.claimNext("runner-a");
    await setEntitlements(fixture, {
      suspended: true,
      suspensionCode: "overdue",
    });
    fixture.clock.advance(3 * MINUTE);

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();

    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_suspended",
    });
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "void",
    });
  });

  // #277-T09
  it("stops counting earlier records the moment the period start moves forward", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
    await enqueue(fixture);
    expect(await fixture.queue.claimNext("runner-a")).not.toBeNull();
    const refused = await enqueue(fixture);
    expect(await fixture.queue.claimNext("runner-b")).toBeNull();
    expect((await fixture.queue.get(refused.id))?.status).toBe("failed");
    fixture.clock.advance(10 * SECOND);
    await setEntitlements(fixture, {
      limits: { diffRunsPerPeriod: 1 },
      periodStart: fixture.clock.now().toISOString(),
    });
    fixture.clock.advance(10 * SECOND);
    const allowed = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-c"))?.job.id).toBe(
      allowed.id,
    );
  });

  // #277-T09
  it("counts a run that started exactly at the period start", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { diffRunsPerPeriod: 1 },
      periodStart: fixture.clock.now().toISOString(),
    });
    await enqueue(fixture);
    await fixture.queue.claimNext("runner-a");
    const refused = await enqueue(fixture);

    expect(await fixture.queue.claimNext("runner-b")).toBeNull();

    expect((await fixture.queue.get(refused.id))?.errorCode).toBe(
      "quota_exhausted",
    );
  });

  // #277-T10
  it("does not count a void record", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const first = await enqueue(fixture);
    const claimed = await fixture.queue.claimNext("runner-a");
    // A run that failed without using the model: its record is void.
    await fixture.queue.complete(first.id, claimed?.leaseToken ?? "", {
      ok: false,
      errorCode: "checkout_incomplete",
    });
    expect(await recordsOf(fixture).get(first.id)).toMatchObject({
      state: "void",
    });
    const second = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(second.id);
  });

  // #277-T11
  it("counts a settled record of unknown cost as a run and adds nothing to the cost", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: {
        diffRunsPerPeriod: 2,
        managedCostLimitMicroUsd: 1_000_000,
      },
    });
    await runToCompletion(fixture, { costUsd: null, managed: true });
    await runToCompletion(fixture, { costUsd: 0.5, managed: true });
    const refused = await enqueue(fixture);

    // Two runs counted (the limit of 2); the cost sum is 0.5 of 1.0, so only the count refuses.
    expect(await fixture.queue.claimNext("runner-a")).toBeNull();

    expect(await fixture.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });

  // #277-T11
  it("does not let unknown costs refuse a managed job on their own", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 1 },
    });
    await runToCompletion(fixture, { costUsd: null, managed: true });
    await runToCompletion(fixture, { costUsd: null, managed: true });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  /** A runner queue of the instance that records what the claim refused and why. */
  function recordingQueue(fixture: JobQueueFixture) {
    const refusals: Array<{
      jobId: string;
      errorCode: string;
      detail?: string;
    }> = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onRefused: ({ jobId, errorCode, detail }) =>
        refusals.push({
          jobId,
          errorCode,
          ...(detail === undefined ? {} : { detail }),
        }),
    });
    return { queue, refusals };
  }

  // #361-T01
  it("reads an entry stored before the own-key limit existed as unlimited, and claims as before", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 5 } });
    // The JSON of a stored entry from before the limit: it lacks the key.
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({
        limits: JSON.stringify({
          diffRunsPerPeriod: 5,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
        }),
      })
      .execute();
    await runToCompletion(fixture, { costUsd: 99, managed: false });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    expect(
      await readEffectiveEntitlements(
        fixture.db,
        fixture.workspaceId,
        fixture.clock.now,
      ),
    ).toMatchObject({
      kind: "limited",
      limits: { diffRunsPerPeriod: 5, ownKeyCostLimitMicroUsd: null },
    });
  });

  // #361-T02
  it("fails an own-key job once the settled own-key cost reaches the limit, with no record", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "own",
      limits: { ownKeyCostLimitMicroUsd: 5_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 3, managed: false });
    await runToCompletion(fixture, { costUsd: 2, managed: false });
    const refused = await enqueue(fixture);
    const { queue, refusals } = recordingQueue(fixture);

    expect(await queue.claimNext("runner-a")).toBeNull();

    expect(await fixture.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
      runnerId: null,
      claimedAt: null,
      attempts: 0,
    });
    expect(refusals).toEqual([
      {
        jobId: refused.id,
        errorCode: "quota_exhausted",
        detail: "own_key_cost",
      },
    ]);
    expect(await recordsOf(fixture).get(refused.id)).toBeUndefined();
    expect(await allRecords(fixture)).toHaveLength(2);
  });

  // #361-T02
  it("lets an own-key job run while the own-key cost is below the limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 5_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 4.999999, managed: false });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #361-T02
  it("refuses a Dynamic job at the own-key cost limit as well as a Diff job", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 1, managed: false });
    const dynamic = await enqueue(fixture, "dynamic");

    expect(await fixture.queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(await fixture.queue.get(dynamic.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });

  // #361-T03
  it("does not let the managed cost limit block an own-key job, nor the own-key limit a managed job", async () => {
    const fixture = await start();
    // Managed cost used up; the workspace now runs on its own key.
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 1_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 1, managed: true });
    await setEntitlements(fixture, {
      keyMode: "own",
      limits: { ownKeyCostLimitMicroUsd: 5_000_000 },
    });
    const own = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(own.id);

    // Own-key cost used up; the workspace now runs on the operator's key.
    await runToCompletion(fixture, { costUsd: 9, managed: false });
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: {
        managedCostLimitMicroUsd: 5_000_000,
        ownKeyCostLimitMicroUsd: 5_000_000,
      },
    });
    const managed = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(
      managed.id,
    );
  });

  // #361-T03
  it("refuses a managed job at the managed limit with its own detail even when the own-key limit is set", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: {
        managedCostLimitMicroUsd: 1_000_000,
        ownKeyCostLimitMicroUsd: 1_000_000,
      },
    });
    await runToCompletion(fixture, { costUsd: 1, managed: true });
    await enqueue(fixture);
    const { queue, refusals } = recordingQueue(fixture);

    expect(await queue.claimNext("runner-a")).toBeNull();

    expect(refusals).toMatchObject([{ detail: "managed_cost" }]);
  });

  // #361-T04
  it("keeps the records of each key mode under the limit of that mode when the workspace is switched mid-period", async () => {
    const fixture = await start();
    // The managed cost limit cannot be written next to the own key (#277), so the own phases carry only
    // the own-key limit.
    const ownLimits = { ownKeyCostLimitMicroUsd: 2_000_000 };
    const limits = { ...ownLimits, managedCostLimitMicroUsd: 2_000_000 };
    await setEntitlements(fixture, { keyMode: "own", limits: ownLimits });
    await runToCompletion(fixture, { costUsd: 2, managed: false });
    const { queue, refusals } = recordingQueue(fixture);
    const ownRefused = await enqueue(fixture);
    expect(await queue.claimNext("runner-a")).toBeNull();
    expect(refusals).toMatchObject([
      { jobId: ownRefused.id, detail: "own_key_cost" },
    ]);

    // Switched to the operator's key: the own-key cost is not part of its sum.
    await setEntitlements(fixture, { keyMode: "managed", limits });
    await runToCompletion(fixture, { costUsd: 1.5, managed: true });
    const managedOk = await enqueue(fixture);
    expect((await queue.claimNext("runner-b"))?.job.id).toBe(managedOk.id);
    await recordsOf(fixture).setKeyMode(managedOk.id, "managed");
    await fixture.queue.complete(
      managedOk.id,
      await fixture.tokenOf(managedOk.id),
      {
        ok: true,
        result: {
          ok: true,
          usage: { promptTokens: 1, completionTokens: 1, costUsd: 1 },
        },
      },
    );
    const managedRefused = await enqueue(fixture);
    expect(await queue.claimNext("runner-c")).toBeNull();
    expect(refusals.at(-1)).toMatchObject({
      jobId: managedRefused.id,
      detail: "managed_cost",
    });

    // Back on the own key: the earlier own-key records are still under the own-key limit.
    await setEntitlements(fixture, { keyMode: "own", limits: ownLimits });
    const again = await enqueue(fixture);
    expect(await queue.claimNext("runner-d")).toBeNull();
    expect(refusals.at(-1)).toMatchObject({
      jobId: again.id,
      detail: "own_key_cost",
    });
  });

  // #361-T05
  it("counts a settled own-key record of unknown cost as a run and adds nothing to the cost", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: {
        diffRunsPerPeriod: 2,
        ownKeyCostLimitMicroUsd: 1_000_000,
      },
    });
    await runToCompletion(fixture, { costUsd: null, managed: false });
    await runToCompletion(fixture, { costUsd: 0.5, managed: false });
    const refused = await enqueue(fixture);
    const { queue, refusals } = recordingQueue(fixture);

    // Two runs counted (the limit of 2); the cost sum is 0.5 of 1.0, so only the count refuses.
    expect(await queue.claimNext("runner-a")).toBeNull();

    expect(refusals).toEqual([
      {
        jobId: refused.id,
        errorCode: "quota_exhausted",
        detail: "diff_runs",
      },
    ]);
  });

  // #361-T05
  it("does not let unknown costs refuse an own-key job on their own", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1 },
    });
    await runToCompletion(fixture, { costUsd: null, managed: false });
    await runToCompletion(fixture, { costUsd: null, managed: false });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #361-T06
  it("refuses every own-key job when the own-key limit is 0", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 0 },
    });
    const job = await enqueue(fixture);
    const { queue, refusals } = recordingQueue(fixture);

    expect(await queue.claimNext("runner-a")).toBeNull();

    expect(refusals).toMatchObject([{ jobId: job.id, detail: "own_key_cost" }]);
    expect(await allRecords(fixture)).toEqual([]);
  });

  // #361-T06
  it("runs own-key jobs without bound when the own-key limit is null", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: null },
    });
    await runToCompletion(fixture, { costUsd: 1000, managed: false });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
  });

  // #361-T07
  it("stops counting earlier own-key cost the moment the period start moves forward", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 1, managed: false });
    const refused = await enqueue(fixture);
    expect(await fixture.queue.claimNext("runner-a")).toBeNull();
    expect((await fixture.queue.get(refused.id))?.status).toBe("failed");
    fixture.clock.advance(10 * SECOND);
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
      periodStart: fixture.clock.now().toISOString(),
    });
    fixture.clock.advance(10 * SECOND);
    const allowed = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(
      allowed.id,
    );
  });

  // #361-T08
  it("runs a job claimed again after a lost lease at the own-key limit, with the one record it has", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
    });
    await runToCompletion(fixture, { costUsd: 0.9, managed: false });
    const job = await enqueue(fixture);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    fixture.clock.advance(3 * MINUTE);

    const again = await fixture.queue.claimNext("runner-b");

    expect(again?.job).toMatchObject({ id: job.id, attempts: 1 });
    expect(await allRecords(fixture)).toHaveLength(2);
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "reserved",
    });
  });

  // #361-T09
  it("lets runs in flight pass a soft cap, never more than the runs in flight, while the count limit stays exact", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: {
        diffRunsPerPeriod: 4,
        ownKeyCostLimitMicroUsd: 1_000_000,
      },
    });
    await runToCompletion(fixture, { costUsd: 0.9, managed: false });
    for (let index = 0; index < 8; index += 1) await enqueue(fixture);

    // Eight claims at once below the cost limit: the runs in flight cost nothing yet, so only the count
    // (4 minus the 1 that settled) bounds how many start.
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture.queue.claimNext(`runner-${index}`),
      ),
    );
    const started = answers.filter((answer) => answer !== null);
    expect(started).toHaveLength(3);
    expect(await allRecords(fixture)).toHaveLength(4);

    // Each of the three settles above what is left of the limit: the overshoot is what they cost.
    for (const claimed of started)
      await fixture.queue.complete(claimed.job.id, claimed.leaseToken, {
        ok: true,
        result: {
          ok: true,
          usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.5 },
        },
      });
    const total = await recordsOf(fixture).sumSettledCostMicroUsd(
      PERIOD_START,
      "own",
    );
    expect(total).toBe(2_400_000);
    // Over the limit by no more than what the runs in flight cost.
    expect(total - 1_000_000).toBeLessThanOrEqual(started.length * 500_000);
    const next = await enqueue(fixture);
    expect(await fixture.queue.claimNext("runner-late")).toBeNull();
    expect((await fixture.queue.get(next.id))?.errorCode).toBe(
      "quota_exhausted",
    );
  });

  // #361-T10
  it("raises one alert with the workspace and job ids when a run settles without a cost, and none when it has one", async () => {
    const fixture = await start();
    const alerts: unknown[] = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onUnknownCostSettled: (event) => alerts.push(event),
    });
    const unknown = await enqueue(fixture);
    const known = await enqueue(fixture);
    const first = await queue.claimNext("runner-a");
    const second = await queue.claimNext("runner-b");
    const usage = (costUsd: number | null) => ({
      ok: true as const,
      result: {
        ok: true,
        usage: { promptTokens: 1, completionTokens: 1, costUsd },
      },
    });

    await queue.complete(unknown.id, first?.leaseToken ?? "", usage(null));
    await queue.complete(known.id, second?.leaseToken ?? "", usage(0.25));
    // Reporting the same outcome again settles nothing and alerts nothing.
    await queue.complete(unknown.id, first?.leaseToken ?? "", usage(null));

    expect(alerts).toEqual([
      { workspaceId: fixture.workspaceId, jobId: unknown.id },
    ]);
  });

  // #361-T10
  it("raises the alert for a run that ended with no result, whose cost is unknown too", async () => {
    const fixture = await start();
    const alerts: Array<{ workspaceId: string; jobId: string }> = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onUnknownCostSettled: (event) => alerts.push(event),
    });
    const job = await enqueue(fixture);
    // Only the last attempt ends a job without a result: the lease runs out on it.
    await fixture.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", job.id)
      .execute();
    await queue.claimNext("runner-a");
    fixture.clock.advance(3 * MINUTE);
    await queue.expireStaleJobs();

    expect((await fixture.queue.get(job.id))?.status).toBe("failed");
    expect(await recordsOf(fixture).get(job.id)).toMatchObject({
      state: "settled",
      settledReason: "no_result",
      costMicroUsd: null,
    });
    expect(alerts).toEqual([
      { workspaceId: fixture.workspaceId, jobId: job.id },
    ]);
  });

  // #361-T10
  it("raises no alert for a lost lease that is requeued, and exactly one on the final attempt", async () => {
    const fixture = await start();
    const alerts: Array<{ workspaceId: string; jobId: string }> = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onUnknownCostSettled: (event) => alerts.push(event),
    });
    const job = await enqueue(fixture);

    // Two attempts are lost and the job waits again: its record stays reserved and nothing settled.
    for (const attempt of [1, 2]) {
      expect((await queue.claimNext("runner-a"))?.job.id).toBe(job.id);
      fixture.clock.advance(3 * MINUTE);
      await queue.expireStaleJobs();
      expect((await queue.get(job.id))?.status).toBe("queued");
      expect(await recordsOf(fixture).get(job.id)).toMatchObject({
        state: "reserved",
      });
      expect(alerts, `after lost attempt ${String(attempt)}`).toEqual([]);
    }

    // The last attempt loses its lease too: the job ends without a result.
    expect((await queue.claimNext("runner-a"))?.job.id).toBe(job.id);
    fixture.clock.advance(3 * MINUTE);
    await queue.expireStaleJobs();
    // Expiring again settles nothing more.
    await queue.expireStaleJobs();

    expect((await queue.get(job.id))?.status).toBe("failed");
    expect(alerts).toEqual([
      { workspaceId: fixture.workspaceId, jobId: job.id },
    ]);
  });

  // #361-T10
  it("reports nothing from a queue built on a transaction, which cannot see its caller's commit or rollback", async () => {
    const fixture = await start();
    const alerts: unknown[] = [];
    const job = await enqueue(fixture);
    const usage = {
      ok: true as const,
      result: {
        ok: true,
        usage: { promptTokens: 1, completionTokens: 1, costUsd: null },
      },
    };

    // Rolled back: the settlement never happened, so no alert may have been raised for it.
    await fixture.db
      .transaction()
      .execute(async (trx) => {
        const queue = createRunnerQueue(trx, {
          now: fixture.clock.now,
          onUnknownCostSettled: (event) => alerts.push(event),
        });
        const claimed = await queue.claimNext("runner-a");
        await queue.complete(job.id, claimed?.leaseToken ?? "", usage);
        throw new Error("rollback");
      })
      .catch(() => undefined);

    expect(alerts).toEqual([]);
    expect(await recordsOf(fixture).get(job.id)).toBeUndefined();
  });

  // #361-T10
  it("never lets a throwing alert callback fail the completion", async () => {
    const fixture = await start();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onUnknownCostSettled: () => {
        throw new Error("callback failed");
      },
    });
    const job = await enqueue(fixture);
    const claimed = await queue.claimNext("runner-a");

    try {
      const completed = await queue.complete(
        job.id,
        claimed?.leaseToken ?? "",
        {
          ok: true,
          result: {
            ok: true,
            usage: { promptTokens: 1, completionTokens: 1, costUsd: null },
          },
        },
      );
      expect(completed.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("")).not.toContain("callback failed");
  });

  // #361-T13
  it("leaves another workspace alone when one is at its own-key limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 0 },
    });
    const refused = await enqueue(fixture);
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const otherJob = await enqueueInWorkspace(fixture, other);

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job).toMatchObject({ id: otherJob, workspaceId: other });
    expect((await fixture.queue.get(refused.id))?.errorCode).toBe(
      "quota_exhausted",
    );
  });

  // #361-T13
  it("does not count the own-key cost of another workspace against this one", async () => {
    const fixture = await start();
    const other = await addWorkspace(fixture.db, "other");
    await setEntitlements(fixture, {
      limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
    });
    // The other workspace spent a lot on its own key; the usage record is in its scope.
    const otherJob = await enqueueInWorkspace(fixture, other);
    const claimed = await fixture.queue.claimNext("runner-a");
    expect(claimed?.job.id).toBe(otherJob);
    await fixture.queue.complete(otherJob, claimed?.leaseToken ?? "", {
      ok: true,
      result: {
        ok: true,
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 50 },
      },
    });
    const job = await enqueue(fixture);

    expect((await fixture.queue.claimNext("runner-b"))?.job.id).toBe(job.id);
  });

  // #277-T13
  it("leaves another workspace alone when one is at its limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    const refused = await enqueue(fixture);
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const otherJob = await enqueueInWorkspace(fixture, other);

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed?.job).toMatchObject({ id: otherJob, workspaceId: other });
    expect((await fixture.queue.get(refused.id))?.status).toBe("failed");
  });

  // #277-T06
  it("lets exactly one of two claims at the same moment take the last unit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
    const one = await enqueue(fixture);
    const two = await enqueue(fixture);

    // Two connections of one pool.
    const answers = await Promise.all([
      fixture.queue.claimNext("runner-a"),
      fixture.queue.claimNext("runner-b"),
    ]);

    const winners = answers.filter((answer) => answer !== null);
    expect(winners).toHaveLength(1);
    const statuses = await Promise.all(
      [one, two].map(async (job) => (await fixture.queue.get(job.id))?.status),
    );
    expect(statuses.sort()).toEqual(["failed", "running"]);
    expect(await allRecords(fixture)).toHaveLength(1);
  });

  // #277-T06
  it("never lets many claims at the same moment pass more than the limit", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 3 } });
    for (let index = 0; index < 8; index += 1) await enqueue(fixture);

    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fixture.queue.claimNext(`runner-${index}`),
      ),
    );

    expect(answers.filter((answer) => answer !== null)).toHaveLength(3);
    expect(await allRecords(fixture)).toHaveLength(3);
  });

  // #277-T02
  it("reports each refusal with its code and detail once the claim committed", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      suspended: false,
      limits: { diffRunsPerPeriod: 0 },
    });
    const refusals: unknown[] = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onRefused: (refusal) => refusals.push(refusal),
    });
    const job = await enqueue(fixture);

    expect(await queue.claimNext("runner-a")).toBeNull();

    expect(refusals).toEqual([
      {
        jobId: job.id,
        workspaceId: fixture.workspaceId,
        // #281: where the pull request notice goes, and whether somebody asked for the review.
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        triggerKind: job.triggerKind,
        // #752: a turn of the Implementer has no pull request, so the notice is not made for it.
        reviewKind: "diff",
        errorCode: "quota_exhausted",
        detail: "diff_runs",
        // #281: the period the refusal was decided under; the pull request notice is once per period.
        periodStart: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  // #277-T02
  it("claims the next waiting job after refusing one, in the same call", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { dynamicRunsPerPeriod: 0 } });
    const dynamic = await enqueue(fixture, "dynamic");
    fixture.clock.advance(1000);
    const diff = await enqueue(fixture, "diff");

    const claimed = await fixture.queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(diff.id);
    expect((await fixture.queue.get(dynamic.id))?.status).toBe("failed");
  });

  // #277-T02
  it("refuses a job claimed by its id and answers nothing, like any job that cannot be claimed", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    const job = await enqueue(fixture);

    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
      jobId: job.id,
    });

    expect(claimed).toBeNull();
    expect(await fixture.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "quota_exhausted",
    });
  });
  // #277-P2
  it("fails all the due jobs of a suspended workspace at once, so a healthy workspace behind them is served in the same call", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      suspended: true,
      suspensionCode: "overdue",
    });
    const backlog = [];
    for (let index = 0; index < 30; index += 1)
      backlog.push(
        await enqueue(fixture, index % 2 === 0 ? "diff" : "dynamic"),
      );
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const healthy = await enqueueInWorkspace(fixture, other);
    const refusals: string[] = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onRefused: ({ jobId }) => refusals.push(jobId),
    });

    const claimed = await queue.claimNext("runner-a", ENGINES);

    expect(claimed?.job.id).toBe(healthy);
    for (const job of backlog)
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "workspace_suspended",
        claimedAt: null,
      });
    expect(refusals.sort()).toEqual(backlog.map((job) => job.id).sort());
    expect(await allRecords(fixture)).toHaveLength(1);
  });

  // #281
  it("tells where the pull request of every job of a suspended backlog is, with the period", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { suspended: true });
    const first = await enqueue(fixture);
    fixture.clock.advance(1000);
    const second = await fixture.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
      triggerKind: "manual",
    });
    const refusals: unknown[] = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onRefused: (refusal) => refusals.push(refusal),
    });

    expect(await queue.claimNext("runner-a", ENGINES)).toBeNull();

    expect(refusals).toHaveLength(2);
    expect(refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: first.id,
          repositoryId: first.repositoryId,
          prNumber: first.prNumber,
          triggerKind: first.triggerKind,
          periodStart: PERIOD_START,
        }),
        expect.objectContaining({
          jobId: second.id,
          prNumber: 8,
          triggerKind: "manual",
          periodStart: PERIOD_START,
        }),
      ]),
    );
  });

  // #277-P2
  it("fails all the due jobs of a workspace whose entitlements cannot be read at once, and voids the record of one that lost its lease", async () => {
    const fixture = await start();
    const lost = await enqueue(fixture);
    await fixture.queue.claimNext("runner-a");
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 5 } });
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({ limits: "{not json" })
      .execute();
    fixture.clock.advance(3 * MINUTE);
    const backlog = [lost];
    for (let index = 0; index < 29; index += 1)
      backlog.push(await enqueue(fixture));
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const healthy = await enqueueInWorkspace(fixture, other);

    const claimed = await fixture.queue.claimNext("runner-b", ENGINES);

    expect(claimed?.job.id).toBe(healthy);
    for (const job of backlog)
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "entitlements_invalid",
      });
    expect(await recordsOf(fixture).get(lost.id)).toMatchObject({
      state: "void",
    });
  });

  // #277-P2
  it("refuses at most 25 jobs for a run limit in one call, then answers nothing and serves the healthy workspace on the next", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 0 } });
    const backlog = [];
    for (let index = 0; index < 26; index += 1)
      backlog.push(await enqueue(fixture));
    fixture.clock.advance(1000);
    const other = await addWorkspace(fixture.db, "other");
    const healthy = await enqueueInWorkspace(fixture, other);

    expect(await fixture.queue.claimNext("runner-a")).toBeNull();

    const statuses = await Promise.all(
      backlog.map(async (job) => (await fixture.queue.get(job.id))?.status),
    );
    expect(statuses.filter((status) => status === "failed")).toHaveLength(25);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
    expect((await fixture.queue.claimNext("runner-a"))?.job.id).toBe(healthy);
  });

  // #277-P3
  it("does not reject the claim, and hands out the job claimed in the same call, when the refusal callback throws", async () => {
    const fixture = await start();
    await setEntitlements(fixture, { limits: { dynamicRunsPerPeriod: 0 } });
    const dynamic = await enqueue(fixture, "dynamic");
    const diff = await enqueue(fixture, "diff");
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onRefused: () => {
        throw new Error("callback failed");
      },
    });

    try {
      const claimed = await queue.claimNext("runner-a", ENGINES);

      expect(claimed?.job.id).toBe(diff.id);
    } finally {
      spy.mockRestore();
    }
    expect((await fixture.queue.get(dynamic.id))?.status).toBe("failed");
    expect(errors).toEqual([
      expect.stringContaining("claim_refusal_log_failed"),
    ]);
    expect(errors.join("")).not.toContain("callback failed");
  });

  // #277-P2
  it("ignores a cost limit stored next to the own key, runs the job, and says so once per claim", async () => {
    const fixture = await start();
    await setEntitlements(fixture, {
      keyMode: "managed",
      limits: { managedCostLimitMicroUsd: 0 },
    });
    // An entry of this shape cannot be written any more (#277), but one stored earlier still reads.
    await fixture.db
      .updateTable("workspace_entitlements")
      .set({ key_mode: "own" })
      .execute();
    const ignored: string[] = [];
    const queue = createRunnerQueue(fixture.db, {
      now: fixture.clock.now,
      onIgnoredCostLimit: (workspaceId) => ignored.push(workspaceId),
    });
    const job = await enqueue(fixture);

    expect((await queue.claimNext("runner-a"))?.job.id).toBe(job.id);

    expect(ignored).toEqual([fixture.workspaceId]);
  });

  describe("a run that a newer push superseded (#397)", () => {
    const REPORT = {
      ok: false,
      errorCode: "superseded",
      result: {
        ok: false,
        errorCode: "superseded",
        usage: { promptTokens: 100, completionTokens: 10, costUsd: 1.2 },
      },
    } as const;

    /** A running run whose holder understands the supersede, and the newer push that replaces it. */
    async function supersededRun(fixture: JobQueueFixture) {
      const old = await fixture.enqueueNew();
      const claimed = await fixture.queue.claimNext("runner-a", ENGINES, {
        acceptsSupersede: true,
      });
      expect(claimed?.job.id).toBe(old.id);
      fixture.clock.advance(1);
      await fixture.enqueue({ headSha: sha("b") });
      expect((await fixture.queue.get(old.id))?.status).toBe("superseded");
      return { old, claimed };
    }

    // #397-T08
    it("is not a run of the free quota: the push that replaced it is still admitted at the limit", async () => {
      const fixture = await start();
      await setEntitlements(fixture, { limits: { diffRunsPerPeriod: 1 } });
      await supersededRun(fixture);

      // The limit is one run: the superseded one does not use it up, the replacing one does.
      const next = await fixture.queue.claimNext("runner-b", ENGINES);

      expect(next?.job).toMatchObject({
        headSha: sha("b"),
        status: "running",
      });
      const other = await enqueue(fixture);
      expect(await fixture.queue.claimNext("runner-c", ENGINES)).toBeNull();
      expect(await fixture.queue.get(other.id)).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
    });

    // #397-T09
    it("counts its measured cost against the cost limit, like any other usage", async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
      });
      const { old, claimed } = await supersededRun(fixture);
      await fixture.queue.complete(old.id, claimed?.leaseToken ?? "", REPORT);
      const waiting = await fixture.queue.get(
        (
          await fixture.db
            .selectFrom("jobs")
            .select("id")
            .where("status", "=", "queued")
            .executeTakeFirstOrThrow()
        ).id,
      );

      // $1.20 was measured against a limit of $1.00: the next claim is refused for cost.
      expect(await fixture.queue.claimNext("runner-b", ENGINES)).toBeNull();

      expect(await fixture.queue.get(waiting?.id ?? "")).toMatchObject({
        status: "failed",
        errorCode: "quota_exhausted",
      });
    });

    // #397-T09
    it("adds nothing to the cost limit when its cost is unknown", async () => {
      const fixture = await start();
      await setEntitlements(fixture, {
        limits: { ownKeyCostLimitMicroUsd: 1_000_000 },
      });
      const { old, claimed } = await supersededRun(fixture);
      await fixture.queue.complete(old.id, claimed?.leaseToken ?? "", {
        ...REPORT,
        result: {
          ...REPORT.result,
          usage: { promptTokens: 100, completionTokens: 10, costUsd: null },
        },
      });

      expect(
        (await fixture.queue.claimNext("runner-b", ENGINES))?.job.headSha,
      ).toBe(sha("b"));
    });
  });
});

/** Queues a job on a repository of its own in another workspace and returns its id. */
async function enqueueInWorkspace(
  fixture: JobQueueFixture,
  workspaceId: string,
): Promise<string> {
  const integration = await createIntegrationsRepository(
    fixture.db,
    workspaceId,
    fixture.clock.now,
  ).create({
    type: "github_app",
    displayName: "other",
    externalId: "9999",
    config: {},
  });
  const repositories = createRepositoriesRepository(
    fixture.db,
    workspaceId,
    fixture.clock.now,
  );
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "8001",
      fullName: "other/widgets",
      url: "https://github.test/other/widgets",
    },
  ]);
  const [repository] = await repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined)
    throw new Error("The repository of the other workspace is missing.");
  const result = await createJobQueue(fixture.db, workspaceId, {
    now: fixture.clock.now,
  }).enqueue({
    repositoryId: repository.id,
    prNumber: 1,
    prUrl: "https://github.test/other/widgets/pull/1",
    headSha: sha("f"),
    command: "review",
    triggerKind: "webhook",
    actorLogin: "octocat",
  });
  if (result.status !== "created")
    throw new Error("The job of the other workspace was not created.");
  return result.job.id;
}
