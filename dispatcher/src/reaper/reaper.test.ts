// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import type { JobStateResult } from "../core/app-client.ts";
import { SandboxServiceError } from "../launchers/sandbox-service.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { ReapError, createReaper, type ReapReport } from "./reaper.ts";

const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND = 1000;
const JOB_LIFETIME_SECONDS = 1500;
const CANARY_LIFETIME_SECONDS = 450;
const GRACE_SECONDS = 120;
const MIN_AGE_SECONDS = 120;
const T0 = 1_800_000_000_000;

function setup() {
  const clock = { now: T0 };
  const fake = new FakeSandboxService(() => clock.now);
  const states = new Map<string, JobStateResult>();
  const asked: string[] = [];
  let throws = false;
  const logger = recordingLogger();
  const reaper = createReaper({
    fleet: fake,
    jobs: {
      jobState: (jobId) => {
        asked.push(jobId);
        if (throws) return Promise.reject(new Error("dummy refusal"));
        return Promise.resolve(states.get(jobId) ?? { kind: "unreadable" });
      },
    },
    logger,
    now: () => clock.now,
    jobLifetimeSeconds: JOB_LIFETIME_SECONDS,
    canaryLifetimeSeconds: CANARY_LIFETIME_SECONDS,
  });

  /** A job VM as the Launcher makes it, `ageSeconds` old. */
  function jobVm(
    jobId: string,
    ageSeconds: number,
    extra: {
      kind?: "diff" | "dynamic";
      timeoutMs?: number;
      suffix?: string;
    } = {},
  ): string {
    const kind = extra.kind ?? "diff";
    const name = `cr-${kind}-${jobId}-${extra.suffix ?? "abcd1234"}`;
    fake.seedVm({
      name,
      tags: { app: "code-reviewer", kind, job: jobId },
      createdAtMs: clock.now - ageSeconds * SECOND,
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    });
    return name;
  }

  /** A canary VM as the capability probe makes it (#331). */
  function canaryVm(
    ageSeconds: number,
    extra: { suffix?: string; timeoutMs?: number } = {},
  ): string {
    const name = `cr-canary-${extra.suffix ?? "abcd1234"}`;
    fake.seedVm({
      name,
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: clock.now - ageSeconds * SECOND,
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
    });
    return name;
  }

  return {
    clock,
    fake,
    states,
    asked,
    logger,
    reaper,
    jobVm,
    canaryVm,
    jobsThrow: () => {
      throws = true;
    },
  };
}

const OLD = 3 * 3600;
const TYPICAL = 600;

describe("the reaper: which VMs are leftovers", () => {
  // #364-T01
  it.each(["succeeded", "failed", "superseded", "cancelled"] as const)(
    "stops the VM of a job the App reports %s, by its name",
    async (status) => {
      const t = setup();
      const name = t.jobVm(JOB_A, TYPICAL);
      t.states.set(JOB_A, { kind: "known", status });

      const report = await t.reaper.run();

      expect(t.fake.stops).toStrictEqual([name]);
      expect(t.asked).toStrictEqual([JOB_A]);
      expect(report).toMatchObject({ stopped: 1, failed: 0, unreadable: 0 });
    },
  );

  // #364-T02
  it("stops the VM of a job that is waiting again after its lease lapsed", async () => {
    const t = setup();
    const name = t.jobVm(JOB_A, TYPICAL, { kind: "dynamic" });
    t.states.set(JOB_A, { kind: "known", status: "queued" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([name]);
  });

  // #364-T03
  it("keeps the VM of a job the App still holds as running", async () => {
    const t = setup();
    t.jobVm(JOB_A, TYPICAL);
    t.states.set(JOB_A, { kind: "known", status: "running" });

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(report).toMatchObject({ stopped: 0, kept: 1 });
  });

  // #397-T12
  it("keeps the VM of a superseded job that is draining, and stops it once the drain is over", async () => {
    const t = setup();
    const name = t.jobVm(JOB_A, TYPICAL);
    t.states.set(JOB_A, {
      kind: "known",
      status: "superseded",
      draining: true,
    });

    const kept = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(kept).toMatchObject({ stopped: 0, kept: 1 });

    t.states.set(JOB_A, { kind: "known", status: "superseded" });
    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([name]);
  });

  // #364-T06
  it("never touches a VM younger than two minutes, and does not even ask about its job", async () => {
    const t = setup();
    t.jobVm(JOB_A, MIN_AGE_SECONDS - 1);
    t.states.set(JOB_A, { kind: "known", status: "failed" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(t.asked).toStrictEqual([]);
  });

  // #364-T10
  it.each(["stopping", "stopped", "failed", "aborted", "snapshotting"])(
    "skips a VM the platform reports as %s",
    async (status) => {
      const t = setup();
      t.jobVm(JOB_A, TYPICAL);
      t.fake.seedVm({
        name: `cr-diff-${JOB_B}-abcd1234`,
        tags: { app: "code-reviewer", kind: "diff", job: JOB_B },
        createdAtMs: T0 - OLD * SECOND,
        status,
      });
      t.states.set(JOB_A, { kind: "known", status: "running" });
      t.states.set(JOB_B, { kind: "known", status: "failed" });

      await t.reaper.run();

      expect(t.asked).toStrictEqual([JOB_A]);
      expect(t.fake.stops).toStrictEqual([]);
    },
  );

  // #364-T12
  it("asks the App once for two VMs of the same job and stops both", async () => {
    const t = setup();
    const first = t.jobVm(JOB_A, TYPICAL, { suffix: "11111111" });
    const second = t.jobVm(JOB_A, TYPICAL + 60, { suffix: "22222222" });
    t.states.set(JOB_A, { kind: "known", status: "failed" });

    await t.reaper.run();

    expect(t.asked).toStrictEqual([JOB_A]);
    expect([...t.fake.stops].sort()).toStrictEqual([first, second].sort());
  });

  // #364-T08
  it("keeps a VM when the App's state is unreadable, and counts it", async () => {
    const t = setup();
    t.jobVm(JOB_A, TYPICAL);
    t.states.set(JOB_A, { kind: "unreadable" });

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(report).toMatchObject({ stopped: 0, unreadable: 1 });
    expect(t.logger.text()).toContain("job_state_unreadable");
  });

  // #364-T08
  it("keeps a VM when asking the App throws", async () => {
    const t = setup();
    t.jobVm(JOB_A, TYPICAL);
    t.jobsThrow();

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(report.unreadable).toBe(1);
  });
});

describe("the reaper: maximum lifetime", () => {
  const LIFETIME = JOB_LIFETIME_SECONDS + GRACE_SECONDS;

  // #364-T07
  it.each<[string, JobStateResult]>([
    ["the App says running", { kind: "known", status: "running" }],
    ["the App is unreadable", { kind: "unreadable" }],
  ])(
    "stops a VM past its lifetime without asking the App when %s",
    async (_name, state) => {
      const t = setup();
      const name = t.jobVm(JOB_A, LIFETIME);
      t.states.set(JOB_A, state);

      const report = await t.reaper.run();

      expect(t.fake.stops).toStrictEqual([name]);
      expect(t.asked).toStrictEqual([]);
      expect(report.stopped).toBe(1);
    },
  );

  // #364-T14
  it("keeps a VM one second inside the lifetime of the configuration while its job runs", async () => {
    const t = setup();
    t.jobVm(JOB_A, LIFETIME - 1);
    t.states.set(JOB_A, { kind: "known", status: "running" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
  });

  // #364-T14
  it("takes the lifetime from the timeout the VM reports, plus the grace", async () => {
    const t = setup();
    const inside = t.jobVm(JOB_A, 599 + GRACE_SECONDS, {
      timeoutMs: 600 * SECOND,
    });
    const expired = t.jobVm(JOB_B, 600 + GRACE_SECONDS, {
      timeoutMs: 600 * SECOND,
    });
    t.states.set(JOB_A, { kind: "known", status: "running" });
    t.states.set(JOB_B, { kind: "known", status: "running" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([expired]);
    expect(t.fake.stops).not.toContain(inside);
  });

  // #364-T14
  it("does not trust a reported timeout above the longest a job may have", async () => {
    const t = setup();
    const name = t.jobVm(JOB_A, LIFETIME, { timeoutMs: 30 * 3600 * SECOND });
    t.states.set(JOB_A, { kind: "known", status: "running" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([name]);
  });
});

describe("the reaper: canary VMs", () => {
  const LIFETIME = CANARY_LIFETIME_SECONDS + GRACE_SECONDS;

  // #364-T28
  it("stops a canary past its lifetime, keeps one inside it and one younger than two minutes, and never asks the App", async () => {
    const t = setup();
    const expired = t.canaryVm(LIFETIME, { suffix: "00000001" });
    const inside = t.canaryVm(LIFETIME - 1, { suffix: "00000002" });
    const young = t.canaryVm(30, { suffix: "00000003" });

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([expired]);
    expect(t.fake.stops).not.toContain(inside);
    expect(t.fake.stops).not.toContain(young);
    expect(t.asked).toStrictEqual([]);
    expect(report).toMatchObject({ candidates: 3, stopped: 1, kept: 2 });
  });

  // #364-T28
  it("takes the lifetime of a canary from its reported timeout, and bounds it", async () => {
    const t = setup();
    const own = t.canaryVm(180 + GRACE_SECONDS, {
      suffix: "00000001",
      timeoutMs: 180 * SECOND,
    });
    const absurd = t.canaryVm(LIFETIME, {
      suffix: "00000002",
      timeoutMs: 10 * 3600 * SECOND,
    });

    await t.reaper.run();

    expect([...t.fake.stops].sort()).toStrictEqual([own, absurd].sort());
  });
});

describe("the reaper: only our own VMs", () => {
  // #364-T04
  it.each<[string, { name: string; tags: Record<string, string> }]>([
    [
      "an unknown kind",
      {
        name: `cr-review-${JOB_A}-abcd1234`,
        tags: { app: "code-reviewer", kind: "review", job: JOB_A },
      },
    ],
    [
      "no job tag",
      {
        name: `cr-diff-${JOB_A}-abcd1234`,
        tags: { app: "code-reviewer", kind: "diff" },
      },
    ],
    [
      "a job tag of another job",
      {
        name: `cr-diff-${JOB_A}-abcd1234`,
        tags: { app: "code-reviewer", kind: "diff", job: JOB_B },
      },
    ],
    [
      "a kind tag that differs from the name",
      {
        name: `cr-diff-${JOB_A}-abcd1234`,
        tags: { app: "code-reviewer", kind: "dynamic", job: JOB_A },
      },
    ],
    [
      "a job id that is no UUID",
      {
        name: "cr-diff-not-a-uuid-abcd1234",
        tags: { app: "code-reviewer", kind: "diff", job: "not-a-uuid" },
      },
    ],
    [
      "a longer suffix",
      {
        name: `cr-diff-${JOB_A}-abcd1234-more`,
        tags: { app: "code-reviewer", kind: "diff", job: JOB_A },
      },
    ],
    [
      "another app tag",
      {
        name: `cr-diff-${JOB_A}-abcd1234`,
        tags: { app: "somebody-else", kind: "diff", job: JOB_A },
      },
    ],
    [
      "a canary name with the tags of a job VM",
      {
        name: "cr-canary-abcd1234",
        tags: { app: "code-reviewer", kind: "diff", job: JOB_A },
      },
    ],
    [
      "a canary name with a role tag",
      {
        name: "cr-canary-abcd1234",
        tags: { app: "code-reviewer", role: "golden-check" },
      },
    ],
    [
      "canary tags on a job VM name",
      {
        name: `cr-diff-${JOB_A}-abcd1234`,
        tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      },
    ],
    [
      "a canary tagged with a job id",
      {
        name: "cr-canary-abcd1234",
        tags: { app: "code-reviewer", kind: "canary", job: JOB_A },
      },
    ],
    [
      "a canary name with a suffix that is not 8 hex digits",
      {
        name: "cr-canary-abcd12345",
        tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      },
    ],
  ])(
    "does not touch a VM with %s, however old, nor ask about it",
    async (_name, vm) => {
      const t = setup();
      t.fake.listIgnoresFilter();
      t.fake.seedVm({ ...vm, createdAtMs: T0 - 48 * 3600 * SECOND });
      t.states.set(JOB_A, { kind: "known", status: "failed" });
      t.states.set(JOB_B, { kind: "known", status: "failed" });

      const report = await t.reaper.run();

      expect(t.fake.stops).toStrictEqual([]);
      expect(t.asked).toStrictEqual([]);
      expect(report).toMatchObject({ candidates: 0, stopped: 0 });
    },
  );

  // #364-T05
  it("never stops the golden snapshot's builder or check VM, old or not, whatever the App says", async () => {
    const t = setup();
    t.fake.listIgnoresFilter();
    for (const vm of [
      {
        name: "code-reviewer-golden-builder-20261015t030000z",
        tags: { app: "code-reviewer", role: "golden-builder" },
      },
      {
        name: "code-reviewer-golden-check-20261015t030000z",
        tags: { app: "code-reviewer", role: "golden-check" },
      },
      {
        name: "cr-canary-0000000a",
        tags: { app: "code-reviewer", role: "golden-builder" },
      },
    ])
      t.fake.seedVm({ ...vm, createdAtMs: T0 - 30 * 3600 * SECOND });
    t.states.set(JOB_A, { kind: "known", status: "failed" });

    const report = await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(t.asked).toStrictEqual([]);
    expect(report.stopped).toBe(0);
  });

  // #364-T05
  it("never stops a persistent VM, even one named and tagged like a job VM or a canary: ours are never persistent", async () => {
    const t = setup();
    t.fake.listIgnoresFilter();
    t.fake.seedVm({
      name: `cr-diff-${JOB_A}-abcd1234`,
      tags: { app: "code-reviewer", kind: "diff", job: JOB_A },
      createdAtMs: T0 - 48 * 3600 * SECOND,
      persistent: true,
    });
    t.fake.seedVm({
      name: "cr-canary-abcd1234",
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: T0 - 48 * 3600 * SECOND,
      persistent: true,
    });
    t.states.set(JOB_A, { kind: "known", status: "failed" });

    await t.reaper.run();

    expect(t.fake.stops).toStrictEqual([]);
    expect(t.asked).toStrictEqual([]);
  });

  // #364-T05
  it("asks the platform only for the prefix and the one tag of our VMs", async () => {
    const t = setup();

    await t.reaper.run();

    expect(t.fake.lists).toStrictEqual([
      { namePrefix: "cr-", tags: { app: "code-reviewer" } },
    ]);
  });
});

describe("the reaper: failures and what it reports", () => {
  // #364-T09
  it("goes on after a failed stop, counts it, and stops that VM in the next run", async () => {
    const t = setup();
    const first = t.jobVm(JOB_A, TYPICAL);
    const second = t.jobVm(JOB_B, TYPICAL);
    t.states.set(JOB_A, { kind: "known", status: "failed" });
    t.states.set(JOB_B, { kind: "known", status: "succeeded" });
    t.fake.failStops(new SandboxServiceError("unavailable"), first);

    const run1 = await t.reaper.run();

    expect([...t.fake.stops].sort()).toStrictEqual([first, second].sort());
    expect(run1).toMatchObject({ stopped: 1, failed: 1 });
    expect(t.logger.text()).toContain("vm_reap_failed");
    t.fake.healStops();
    const before = t.fake.stops.length;

    const run2 = await t.reaper.run();

    expect(t.fake.stops.slice(before)).toStrictEqual([first]);
    expect(run2).toMatchObject({ stopped: 1, failed: 0 });
  });

  // #364-T11
  it("stops nothing and asks nothing when the listing fails, and says why with a stable code only", async () => {
    const t = setup();
    t.jobVm(JOB_A, OLD);
    t.fake.failNextList(
      Object.assign(new SandboxServiceError("unavailable"), {
        message: "boom dummy-platform-token-0000",
      }),
    );

    const failed = await t.reaper.run().catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ReapError);
    expect((failed as ReapError).code).toBe("REAP_LIST_FAILED");
    expect(t.fake.stops).toStrictEqual([]);
    expect(t.asked).toStrictEqual([]);
    expect(t.logger.text()).toContain("reap_list_failed");
    expect(t.logger.text()).not.toContain("dummy-platform-token");
  });

  // #364-T13
  it("logs and reports counts and stable codes only, with every kind of outcome in one run", async () => {
    const t = setup();
    t.jobVm(JOB_A, TYPICAL);
    t.jobVm(JOB_B, TYPICAL);
    t.canaryVm(LIFETIME_OF_CANARY());
    t.states.set(JOB_A, { kind: "known", status: "failed" });
    t.states.set(JOB_B, { kind: "unreadable" });
    t.fake.failStops(
      new Error("dummy-secret-in-error-text"),
      `cr-diff-${JOB_A}-abcd1234`,
    );

    const report: ReapReport = await t.reaper.run();

    for (const value of Object.values(report))
      expect(typeof value).toBe("number");
    expect(Object.keys(report).sort()).toStrictEqual([
      "candidates",
      "deleteFailed",
      "deleted",
      "failed",
      "kept",
      "listed",
      "stopped",
      "unreadable",
    ]);
    const text = t.logger.text();
    expect(text).not.toMatch(/dummy-secret|Bearer|crj_|token/i);
    expect(text).toContain("reap_done");
  });
});

function LIFETIME_OF_CANARY(): number {
  return CANARY_LIFETIME_SECONDS + GRACE_SECONDS + 1;
}
