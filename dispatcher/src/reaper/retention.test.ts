// SPDX-License-Identifier: LicenseRef-Proprietary

// The reaper's retention (#802): the platform keeps a stopped VM until somebody deletes it, and the listing every claim
// makes grows with them (283 stopped VMs took 5.1 s). The reaper deletes the ended VMs of ours that are older than a day,
// a bounded number per run, and nothing else.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import {
  SandboxServiceError,
  type SandboxFailureKind,
} from "../launchers/sandbox-service.ts";
import { recordingLogger } from "../test-support/harness.ts";
import {
  DELETE_BUDGET_MS,
  MAX_DELETES_PER_RUN,
  RETENTION_MS,
  createReaper,
  type ReapReport,
} from "./reaper.ts";

const T0 = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** A small seeded generator, so a test that depends on the reaper's random pick is repeatable. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const clock = { now: T0 };
  const fake = new FakeSandboxService(() => clock.now);
  const logger = recordingLogger();
  let asked = 0;
  const reaper = createReaper({
    fleet: fake,
    jobs: {
      jobState: () => {
        asked += 1;
        return Promise.resolve({ kind: "unreadable" });
      },
    },
    logger,
    now: () => clock.now,
    random: seeded(7),
    jobLifetimeSeconds: 1500,
    canaryLifetimeSeconds: 450,
  });
  let counter = 0;
  /** A job VM of ours with the platform's word `status`, `ageMs` old. */
  function jobVm(
    ageMs: number,
    extra: {
      status?: string;
      persistent?: boolean;
      tags?: Record<string, string>;
      name?: string;
    } = {},
  ): string {
    counter += 1;
    const suffix = counter.toString(16).padStart(8, "0");
    const name = extra.name ?? `cr-diff-${JOB}-${suffix}`;
    fake.seedVm({
      name,
      tags: extra.tags ?? { app: "code-reviewer", kind: "diff", job: JOB },
      createdAtMs: clock.now - ageMs,
      status: extra.status ?? "stopped",
      ...(extra.persistent === undefined
        ? {}
        : { persistent: extra.persistent }),
    });
    return name;
  }
  return { clock, fake, logger, reaper, jobVm, asked: () => asked };
}

describe("the reaper's retention of ended VMs", () => {
  // #802-T20
  it("deletes a stopped VM of ours that is a day old, by its name, and counts it", async () => {
    const t = setup();
    const old = t.jobVm(DAY);

    const report = await t.reaper.run();

    expect(RETENTION_MS).toBe(DAY);
    expect(t.fake.deletes).toStrictEqual([old]);
    expect(t.fake.vms.has(old)).toBe(false);
    expect(report).toMatchObject({
      deleted: 1,
      deleteFailed: 0,
      deleteKept: 0,
      deleteNotTried: 0,
    });
    expect(t.logger.text()).toContain(`vm_deleted {"sandbox":"${old}"}`);
  });

  // #802-T20
  it("keeps a stopped VM that is a second short of a day", async () => {
    const t = setup();
    t.jobVm(DAY - 1000);

    const report = await t.reaper.run();

    expect(t.fake.deletes).toStrictEqual([]);
    expect(report).toMatchObject({ deleted: 0 });
  });

  // #802-T21
  it.each(["stopped", "failed", "aborted"])(
    "deletes a VM the platform reports as %s, which has ended for good",
    async (status) => {
      const t = setup();
      const name = t.jobVm(2 * DAY, { status });

      await t.reaper.run();

      expect(t.fake.deletes).toStrictEqual([name]);
    },
  );

  // #802-T21
  it.each(["running", "pending", "stopping", "snapshotting"])(
    "never deletes a VM the platform reports as %s, however old",
    async (status) => {
      const t = setup();
      t.jobVm(30 * DAY, { status });

      await t.reaper.run();

      expect(t.fake.deletes).toStrictEqual([]);
    },
  );

  // #802-T22
  it("deletes the stopped canary of a probe that is long over, which no job and no probe uses", async () => {
    const t = setup();
    const name = "cr-canary-abcd1234";
    t.fake.seedVm({
      name,
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: T0 - 4 * DAY,
      status: "stopped",
    });

    await t.reaper.run();

    expect(t.fake.deletes).toStrictEqual([name]);
  });

  // #802-T23
  it("never deletes what is not exactly a VM of ours: a persistent one, the golden builder and check VM, lookalikes", async () => {
    const t = setup();
    const old = 30 * DAY;
    const mine = { app: "code-reviewer", kind: "diff", job: JOB };
    // Persistent, though named and tagged like a job VM: ours are never persistent.
    t.jobVm(old, { persistent: true });
    // The golden snapshot's builder and check VM.
    t.fake.seedVm({
      name: "code-reviewer-golden-20261101",
      tags: { app: "code-reviewer", role: "builder" },
      createdAtMs: T0 - old,
      status: "stopped",
      persistent: true,
    });
    t.fake.seedVm({
      name: "cr-golden-check-20261101",
      tags: { app: "code-reviewer", role: "check" },
      createdAtMs: T0 - old,
      status: "stopped",
    });
    // Our name, somebody else's tag, a tag of ours with a name that does not match, a mismatching job tag, a canary with a role.
    t.jobVm(old, { tags: { ...mine, app: "someone-else" } });
    t.jobVm(old, { tags: { kind: "diff", job: JOB } });
    t.jobVm(old, { name: "cr-diff-not-a-job-id-00000001" });
    t.jobVm(old, {
      tags: { ...mine, job: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });
    t.jobVm(old, { tags: { ...mine, kind: "dynamic" } });
    t.fake.seedVm({
      name: "cr-canary-00000001",
      tags: { app: "code-reviewer", kind: "canary", job: "canary", role: "x" },
      createdAtMs: T0 - old,
      status: "stopped",
    });
    // Somebody's VM that has nothing of ours but the prefix.
    t.fake.seedVm({
      name: "cr-mine",
      tags: {},
      createdAtMs: T0 - old,
      status: "stopped",
    });

    const report = await t.reaper.run();

    expect(t.fake.deletes).toStrictEqual([]);
    expect(report).toMatchObject({ deleted: 0 });
  });

  // #802-T24
  it("deletes at most a fixed number per run and drains a backlog over several runs", async () => {
    const t = setup();
    const total = MAX_DELETES_PER_RUN * 2 + 20;
    for (let index = 0; index < total; index += 1)
      t.jobVm(2 * DAY + index * 1000);

    const first = await t.reaper.run();
    expect(first).toMatchObject({ deleted: MAX_DELETES_PER_RUN });
    expect(t.fake.deletes).toHaveLength(MAX_DELETES_PER_RUN);

    const second = await t.reaper.run();
    const third = await t.reaper.run();
    const fourth = await t.reaper.run();

    expect(second).toMatchObject({ deleted: MAX_DELETES_PER_RUN });
    expect(third).toMatchObject({ deleted: 20 });
    expect(fourth).toMatchObject({ deleted: 0 });
    expect(t.fake.deletes).toHaveLength(total);
    expect(new Set(t.fake.deletes).size).toBe(total);
  });

  // #802-T28
  it("does not let VMs whose delete fails for good starve the others: it picks among the eligible ones, not the oldest", async () => {
    const t = setup();
    // Seventy VMs the platform refuses to delete, all older than the 20 that can be.
    const poison = Array.from({ length: 70 }, (_, index) =>
      t.jobVm(10 * DAY + index * 1000),
    );
    const good = Array.from({ length: 20 }, (_, index) =>
      t.jobVm(2 * DAY + index * 1000),
    );
    for (const name of poison)
      t.fake.failDeletes(new SandboxServiceError("rejected"), name);

    let runs = 0;
    while (good.some((name) => t.fake.vms.has(name)) && runs < 30) {
      const report = await t.reaper.run();
      expect(report.deleted + report.deleteFailed).toBeLessThanOrEqual(
        MAX_DELETES_PER_RUN,
      );
      runs += 1;
    }

    expect(good.some((name) => t.fake.vms.has(name))).toBe(false);
    expect(poison.every((name) => t.fake.vms.has(name))).toBe(true);
    // Not a certainty for every seed, but with this one it stays well under the thirty runs it is allowed.
    expect(runs).toBeLessThan(15);
  });

  // #802-T25
  it("goes on after a failed delete, counts it, never fails the run, and deletes that VM in the next run", async () => {
    const t = setup();
    const first = t.jobVm(5 * DAY);
    const second = t.jobVm(5 * DAY);
    t.fake.failDeletes(
      Object.assign(new SandboxServiceError("rejected"), {
        message: "dummy-platform-text-secret",
      }),
      first,
    );

    const run1: ReapReport = await t.reaper.run();

    expect(run1).toMatchObject({ deleted: 1, deleteFailed: 1 });
    expect(t.fake.vms.has(second)).toBe(false);
    expect(t.fake.vms.has(first)).toBe(true);
    expect(t.logger.text()).toContain(
      `vm_delete_failed {"sandbox":"${first}"}`,
    );
    expect(t.logger.text()).not.toContain("dummy-platform-text-secret");

    t.fake.healDeletes();
    const run2 = await t.reaper.run();

    expect(run2).toMatchObject({ deleted: 1, deleteFailed: 0 });
    expect(t.fake.vms.has(first)).toBe(false);
  });

  // #802-T25
  it("counts a failed delete against the bound of the run, so a platform that refuses deletes is not hammered", async () => {
    const t = setup();
    for (let index = 0; index < MAX_DELETES_PER_RUN + 5; index += 1)
      t.jobVm(5 * DAY);
    t.fake.failDeletes(new SandboxServiceError("rejected"));

    const report = await t.reaper.run();

    expect(t.fake.deletes).toHaveLength(MAX_DELETES_PER_RUN);
    expect(report).toMatchObject({
      deleted: 0,
      deleteFailed: MAX_DELETES_PER_RUN,
    });
  });

  // #802-T29
  it("counts a VM that is no longer deletable when the platform is asked again as kept, not as deleted", async () => {
    const t = setup();
    const back = t.jobVm(5 * DAY);
    const other = t.jobVm(5 * DAY);
    t.fake.keepOnDelete(back);

    const report = await t.reaper.run();

    expect(report).toMatchObject({
      deleted: 1,
      deleteKept: 1,
      deleteFailed: 0,
    });
    expect(t.fake.vms.has(back)).toBe(true);
    expect(t.fake.vms.has(other)).toBe(false);
    expect(t.logger.text()).not.toContain(`vm_deleted {"sandbox":"${back}"}`);
    expect(t.logger.text()).toContain(`vm_delete_kept {"sandbox":"${back}"}`);
  });

  // #802-T30
  it.each<SandboxFailureKind>(["rate_limited", "unavailable"])(
    "stops its deletions at the first %s answer and counts the rest as not tried, so job launches are not hurt",
    async (kind) => {
      const t = setup();
      for (let index = 0; index < MAX_DELETES_PER_RUN + 10; index += 1)
        t.jobVm(5 * DAY);
      t.fake.failDeletes(new SandboxServiceError(kind));

      const report = await t.reaper.run();

      // The first answers are those of the calls already in flight (four at a time); nothing starts after the first.
      expect(t.fake.deletes.length).toBeLessThanOrEqual(4);
      expect(report.deleteFailed).toBe(t.fake.deletes.length);
      expect(report.deleteNotTried).toBe(
        MAX_DELETES_PER_RUN - t.fake.deletes.length,
      );
      expect(report.deleted).toBe(0);
      expect(t.logger.text()).toContain(`vm_delete_halted {"kind":"${kind}"}`);

      // The next run tries again.
      t.fake.healDeletes();
      const next = await t.reaper.run();
      expect(next).toMatchObject({ deleted: MAX_DELETES_PER_RUN });
    },
  );

  // #802-T30
  it("does not stop for another kind of failure: the other VMs are still tried", async () => {
    const t = setup();
    for (let index = 0; index < 10; index += 1) t.jobVm(5 * DAY);
    t.fake.failDeletes(new SandboxServiceError("rejected"));

    const report = await t.reaper.run();

    expect(t.fake.deletes).toHaveLength(10);
    expect(report).toMatchObject({ deleteFailed: 10, deleteNotTried: 0 });
  });

  // #802-T31
  it("stops starting deletions once the pass has used its time budget, and counts the rest as not tried", async () => {
    const t = setup();
    for (let index = 0; index < MAX_DELETES_PER_RUN; index += 1)
      t.jobVm(5 * DAY);
    // Each delete takes more than half the budget, and the calls start one after the other: only two start inside it.
    t.fake.deleteHook = () => {
      t.clock.now += DELETE_BUDGET_MS / 2 + 1;
    };

    const report = await t.reaper.run();

    expect(DELETE_BUDGET_MS).toBeLessThan(5 * 60 * 1000);
    expect(t.fake.deletes).toHaveLength(2);
    expect(report).toMatchObject({
      deleted: 2,
      deleteNotTried: MAX_DELETES_PER_RUN - 2,
    });
  });

  // #802-T26
  it("only deletes: it stops nothing and asks the App nothing for a VM that is already stopped", async () => {
    const t = setup();
    t.jobVm(5 * DAY);

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(t.asked()).toBe(0);
  });

  // #802-T26
  it("still stops the leftovers that are up in the same run, and does not delete a VM in the run that stops it", async () => {
    const t = setup();
    const up = t.jobVm(10 * 3600 * 1000 * 3, { status: "running" });
    const gone = t.jobVm(5 * DAY);

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([up]);
    expect(t.fake.deletes).toStrictEqual([gone]);
    expect(report).toMatchObject({ stopped: 1, deleted: 1 });
  });

  // #802-T27
  it("deletes nothing when the listing fails", async () => {
    const t = setup();
    t.jobVm(5 * DAY);
    t.fake.failNextList(new SandboxServiceError("unavailable"));

    await expect(t.reaper.run()).rejects.toThrow();

    expect(t.fake.deletes).toStrictEqual([]);
  });
});
