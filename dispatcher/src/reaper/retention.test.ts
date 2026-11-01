// SPDX-License-Identifier: LicenseRef-Proprietary

// The reaper's retention (#802): the platform keeps a stopped VM until somebody deletes it, and the listing every claim
// makes grows with them (283 stopped VMs took 5.1 s). The reaper deletes the stopped VMs of ours that are older than a few
// days, a bounded number per run, and nothing else.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { SandboxServiceError } from "../launchers/sandbox-service.ts";
import { recordingLogger } from "../test-support/harness.ts";
import {
  MAX_DELETES_PER_RUN,
  RETENTION_MS,
  createReaper,
  type ReapReport,
} from "./reaper.ts";

const T0 = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

describe("the reaper's retention of stopped VMs", () => {
  // #802-T20
  it("deletes a stopped VM of ours that is older than three days, by its name, and counts it", async () => {
    const t = setup();
    const old = t.jobVm(3 * DAY);

    const report = await t.reaper.run();

    expect(RETENTION_MS).toBe(3 * DAY);
    expect(t.fake.deletes).toStrictEqual([old]);
    expect(t.fake.vms.has(old)).toBe(false);
    expect(report).toMatchObject({ deleted: 1, deleteFailed: 0 });
    expect(t.logger.text()).toContain(`vm_deleted {"sandbox":"${old}"}`);
  });

  // #802-T20
  it("keeps a stopped VM that is a second short of three days", async () => {
    const t = setup();
    t.jobVm(3 * DAY - 1000);

    const report = await t.reaper.run();

    expect(t.fake.deletes).toStrictEqual([]);
    expect(report).toMatchObject({ deleted: 0 });
  });

  // #802-T21
  it.each(["running", "pending", "stopping", "snapshotting", "failed"])(
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
  it("deletes at most a fixed number per run, the oldest first, and drains a backlog over several runs", async () => {
    const t = setup();
    const total = MAX_DELETES_PER_RUN * 2 + 20;
    const names: string[] = [];
    // Created from the youngest to the oldest, so the order of the listing is not the order of age.
    for (let index = 0; index < total; index += 1)
      names.push(t.jobVm(4 * DAY + index * 1000));
    const oldestFirst = [...names].reverse();

    const first = await t.reaper.run();
    expect(first).toMatchObject({ deleted: MAX_DELETES_PER_RUN });
    expect(new Set(t.fake.deletes)).toStrictEqual(
      new Set(oldestFirst.slice(0, MAX_DELETES_PER_RUN)),
    );

    const second = await t.reaper.run();
    const third = await t.reaper.run();
    const fourth = await t.reaper.run();

    expect(second).toMatchObject({ deleted: MAX_DELETES_PER_RUN });
    expect(third).toMatchObject({ deleted: 20 });
    expect(fourth).toMatchObject({ deleted: 0 });
    expect(t.fake.deletes).toHaveLength(total);
    expect(new Set(t.fake.deletes).size).toBe(total);
  });

  // #802-T25
  it("goes on after a failed delete, counts it, never fails the run, and deletes that VM in the next run", async () => {
    const t = setup();
    const first = t.jobVm(5 * DAY);
    const second = t.jobVm(5 * DAY);
    t.fake.failDeletes(
      Object.assign(new SandboxServiceError("unavailable"), {
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
    t.fake.failDeletes(new SandboxServiceError("unavailable"));

    const report = await t.reaper.run();

    expect(t.fake.deletes).toHaveLength(MAX_DELETES_PER_RUN);
    expect(report).toMatchObject({
      deleted: 0,
      deleteFailed: MAX_DELETES_PER_RUN,
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
