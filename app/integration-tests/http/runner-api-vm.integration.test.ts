// SPDX-License-Identifier: LicenseRef-Proprietary

// The report of a VM start by the Dispatcher (#493): `POST /api/runners/v1/jobs/{id}/vm`, authenticated with the
// dispatcher credential and the per-job credential in the body (the Worker, which holds only the second, cannot call
// it). The first report of a VM wins; a report after the claim ended, with a stranger's credential, with an extra field
// or an oversize body stores nothing and answers like the other calls of the runner API.
import { describe, expect, it } from "vitest";
import { APP_FEATURES } from "../../src/runner-api/contract.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** The body a Dispatcher sends right after `Sandbox.create` returned. */
function report(
  h: RunnerApiHarness,
  credential: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    credential,
    vmName: "cr-diff-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-ab12cd34",
    startedAt: h.clock.now().toISOString(),
    timeoutSeconds: 2100,
    ...overrides,
  };
}

async function runningJob(h: RunnerApiHarness, prNumber = 7) {
  const job = await h.enqueueNew({
    prNumber,
    headSha: String(prNumber).repeat(40).slice(0, 40),
  });
  const claim = await h.claimedSplit({ jobId: job.id });
  return { job, credential: claim.job.credential };
}

describe("the report of a VM start", () => {
  // #493-T12
  it("is advertised as a feature of the version call", async () => {
    const h = await startRunnerApiHarness();

    const body = await (await h.version()).json();

    expect(APP_FEATURES).toContain("vm_lifecycle");
    expect(body.features).toContain("vm_lifecycle");
  });

  // #493-T02
  it("stores the start of the VM with the job credential, and a second report of it changes nothing", async () => {
    const h = await startRunnerApiHarness();
    const { job, credential } = await runningJob(h);
    h.clock.advance(4 * SECOND);

    const first = await h.vmStart(job.id, report(h, credential));

    expect(first.status).toBe(200);
    expect(await first.json()).toStrictEqual({
      version: 1,
      status: "recorded",
    });
    const stored = await h.vmRuns.list(job.id);
    expect(stored).toStrictEqual([
      expect.objectContaining({
        vmName: "cr-diff-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-ab12cd34",
        startedAt: h.clock.now().toISOString(),
        vmTimeoutSeconds: 2100,
        attempt: 1,
        billable: true,
        endedAt: null,
      }),
    ]);

    h.clock.advance(MINUTE);
    const again = await h.vmStart(
      job.id,
      report(h, credential, { startedAt: h.clock.now().toISOString() }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toStrictEqual({
      version: 1,
      status: "replayed",
    });
    expect(await h.vmRuns.list(job.id)).toStrictEqual(stored);
  });

  // #493-T03
  it("refuses a wrong credential, another job's credential, and a call without the dispatcher credential, storing nothing", async () => {
    const h = await startRunnerApiHarness();
    const mine = await runningJob(h, 7);
    const theirs = await runningJob(h, 8);
    const jobsBefore = await h.snapshotJobs();

    const madeUp = await h.vmStart(
      mine.job.id,
      report(h, `crj_${"A".repeat(43)}`),
    );
    const stranger = await h.vmStart(mine.job.id, report(h, theirs.credential));
    const noToken = await h.vmStart(mine.job.id, report(h, mine.credential), {
      token: null,
    });
    const wrongToken = await h.vmStart(
      mine.job.id,
      report(h, mine.credential),
      { token: "not-the-token" },
    );

    // The same refusal as the release, which is a call of the same kind.
    const releaseOfStranger = await h.release(mine.job.id, {
      credential: theirs.credential,
      reason: "launch_failed",
    });
    const releaseNoToken = await h.release(
      mine.job.id,
      { credential: mine.credential, reason: "launch_failed" },
      { token: null },
    );
    expect(madeUp.status).toBe(401);
    expect(await madeUp.json()).toStrictEqual(await releaseOfStranger.json());
    expect(stranger.status).toBe(401);
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toStrictEqual(await releaseNoToken.json());
    expect(wrongToken.status).toBe(401);
    expect(await h.vmRuns.list(mine.job.id)).toStrictEqual([]);
    expect(await h.vmRuns.list(theirs.job.id)).toStrictEqual([]);
    expect(await h.snapshotJobs()).toStrictEqual(jobsBefore);
  });

  // #493-T03
  it("refuses an extra field, a malformed value and an oversize body, storing nothing", async () => {
    const h = await startRunnerApiHarness();
    const { job, credential } = await runningJob(h);
    const bad: Array<[string, unknown]> = [
      ["an extra field", report(h, credential, { more: 1 })],
      ["no VM name", report(h, credential, { vmName: undefined })],
      ["a VM name with a slash", report(h, credential, { vmName: "a/b" })],
      ["an empty VM name", report(h, credential, { vmName: "" })],
      ["a long VM name", report(h, credential, { vmName: "a".repeat(129) })],
      [
        "a start that is no timestamp",
        report(h, credential, { startedAt: "x" }),
      ],
      [
        "a start without the Z",
        report(h, credential, { startedAt: "2026-10-19T10:00:00" }),
      ],
      ["a timeout of 0", report(h, credential, { timeoutSeconds: 0 })],
      ["a timeout as text", report(h, credential, { timeoutSeconds: "60" })],
      [
        "a timeout above a day",
        report(h, credential, { timeoutSeconds: 86_401 }),
      ],
      ["a lease token", report(h, credential, { credential: "lease-1234567" })],
      ["an array", []],
    ];

    for (const [name, body] of bad) {
      const response = await h.vmStart(job.id, body);
      expect({ name, status: response.status }).toStrictEqual({
        name,
        status: 400,
      });
    }
    const notJson = await h.vmStart(job.id, "{nope");
    const large = await h.vmStart(job.id, "x".repeat(70 * 1024));
    const badId = await h.vmStart("not-a-uuid", report(h, credential));

    expect(notJson.status).toBe(400);
    expect(large.status).toBe(413);
    expect(badId.status).toBe(400);
    expect(await h.vmRuns.list(job.id)).toStrictEqual([]);
  });

  // #493-T04
  it("refuses a report that arrives after the claim ended, and stores no row", async () => {
    const h = await startRunnerApiHarness();
    const { job, credential } = await runningJob(h);
    await h.complete(job.id, await h.tokenOf(job.id));

    const late = await h.vmStart(job.id, report(h, credential));

    expect(late.status).toBe(409);
    expect((await late.json()).error.code).toBe("RUNNER_JOB_ENDED");
    expect(await h.vmRuns.list(job.id)).toStrictEqual([]);
  });

  // #493-T04
  it("refuses the credential of an earlier claim after a new claim, and answers 404 for a job that does not exist", async () => {
    const h = await startRunnerApiHarness();
    const { job, credential: first } = await runningJob(h);
    await h.release(job.id, { credential: first, reason: "launch_failed" });
    h.clock.advance(31 * SECOND);
    await h.claimedSplit({ jobId: job.id });

    const stale = await h.vmStart(job.id, report(h, first));
    const missing = await h.vmStart(crypto.randomUUID(), report(h, first));

    expect(stale.status).toBe(401);
    expect(missing.status).toBe(404);
    expect(await h.vmRuns.list(job.id)).toStrictEqual([]);
  });

  // #493-T08
  it("numbers the attempt by the lost attempts of the job and keeps both VMs, the last one counting", async () => {
    const h = await startRunnerApiHarness();
    const { job, credential: first } = await runningJob(h);
    await h.vmStart(job.id, report(h, first, { vmName: "vm-one" }));
    await h.release(job.id, { credential: first, reason: "launch_failed" });
    h.clock.advance(31 * SECOND);
    const second = (await h.claimedSplit({ jobId: job.id })).job.credential;

    const response = await h.vmStart(
      job.id,
      report(h, second, { vmName: "vm-two" }),
    );

    expect(response.status).toBe(200);
    expect(
      (await h.vmRuns.list(job.id)).map((row) => [
        row.vmName,
        row.attempt,
        row.billable,
      ]),
    ).toStrictEqual([
      ["vm-one", 1, false],
      ["vm-two", 2, true],
    ]);
  });

  // #818-T34
  it("stores the size of the VM when the Dispatcher reports it (an Implementer job), and null when it does not", async () => {
    const h = await startRunnerApiHarness();
    const sized = await runningJob(h, 7);
    const plain = await runningJob(h, 8);

    const first = await h.vmStart(
      sized.job.id,
      report(h, sized.credential, { vcpus: 6 }),
    );
    const second = await h.vmStart(plain.job.id, report(h, plain.credential));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await h.vmRuns.list(sized.job.id)).toStrictEqual([
      expect.objectContaining({ vcpus: 6 }),
    ]);
    expect(await h.vmRuns.list(plain.job.id)).toStrictEqual([
      expect.objectContaining({ vcpus: null }),
    ]);
  });

  // #818-T34
  it.each([
    ["zero", 0],
    ["a size above 64", 65],
    ["a fraction", 2.5],
    ["text", "4"],
    ["null", null],
  ])("refuses a VM size of %s, storing nothing", async (_name, vcpus) => {
    const h = await startRunnerApiHarness();
    const { job, credential } = await runningJob(h);

    const response = await h.vmStart(job.id, report(h, credential, { vcpus }));

    expect(response.status).toBe(400);
    expect(await h.vmRuns.list(job.id)).toStrictEqual([]);
  });
});
