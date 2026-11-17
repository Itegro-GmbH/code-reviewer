// SPDX-License-Identifier: LicenseRef-Proprietary

// The queue side of the per-job credential (#320): a claim made with `workerCredential` stores only the hash of the credential as the lease
// token and returns the credential once; every statement fenced by the lease token is fenced by it;
// `holding` tells the claim that runs or ended from any other token; `countFetch` counts per claim.
import { describe, expect, it } from "vitest";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  isWorkerLeaseToken,
  workerLeaseToken,
  WORKER_CREDENTIAL_PATTERN,
} from "./worker-credential.ts";
import { createTestDatabase } from "../test-support/test-database.ts";

const MINUTE = 60 * 1000;

const open = async () => (await createTestDatabase()).db;

describe("the credential of a claim", () => {
  async function start() {
    const database = await open();
    return createJobQueueFixture(database === undefined ? {} : { database });
  }

  // #320-T14
  it("stores the hash of the credential as the lease token and returns the credential once", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();

    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });

    expect(claimed?.credential).toMatch(WORKER_CREDENTIAL_PATTERN);
    expect(claimed?.leaseToken).toBe(
      workerLeaseToken(claimed?.credential ?? ""),
    );
    expect(isWorkerLeaseToken(claimed?.leaseToken ?? "")).toBe(true);
    expect(await fixture.tokenOf(job.id)).toBe(claimed?.leaseToken);
    expect(await fixture.tokenOf(job.id)).not.toContain(
      (claimed?.credential ?? "").slice(4),
    );
  });

  // #320-T14
  it("keeps the plain 256 bit lease token for a claim without the option", async () => {
    const fixture = await start();
    await fixture.enqueueNew();

    const claimed = await fixture.queue.claimNext("runner-a");

    expect(claimed).not.toHaveProperty("credential");
    expect(claimed?.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // #320-T03
  it("fences heartbeat, complete and release on the hash, and nothing else", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    const credential = claimed?.credential ?? "";

    expect((await fixture.queue.heartbeat(job.id, credential)).status).toBe(
      "not_holder",
    );
    expect(
      (await fixture.queue.heartbeat(job.id, claimed?.leaseToken ?? "")).status,
    ).toBe("ok");
    expect(
      (
        await fixture.queue.complete(job.id, credential, {
          ok: false,
          errorCode: "x",
        })
      ).status,
    ).toBe("not_holder");
  });

  // #320-T09
  it("holds a job for the claim that runs, for the claim that ended, and for no other", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    const token = first?.leaseToken ?? "";

    expect((await fixture.queue.holding(job.id, token))?.status).toBe(
      "running",
    );
    expect(await fixture.queue.holding(job.id, "x".repeat(43))).toBeUndefined();
    expect(
      await fixture.queue.holding(crypto.randomUUID(), token),
    ).toBeUndefined();

    await fixture.queue.complete(job.id, token, { ok: true, result: {} });
    expect((await fixture.queue.holding(job.id, token))?.status).toBe(
      "succeeded",
    );
  });

  // #320-T09
  it("no longer holds the job once it was queued again, and the new claim has a new credential", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    fixture.clock.advance(3 * MINUTE);

    const second = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });

    expect(second?.job.id).toBe(job.id);
    expect(second?.credential).not.toBe(first?.credential);
    expect(
      await fixture.queue.holding(job.id, first?.leaseToken ?? ""),
    ).toBeUndefined();
    expect(
      (await fixture.queue.holding(job.id, second?.leaseToken ?? ""))?.status,
    ).toBe("running");
  });

  // #320-T05
  it("counts the fetches of a claim up to the limit and starts again with the next claim", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    const token = first?.leaseToken ?? "";

    const answers = [];
    for (let fetch = 0; fetch < 4; fetch += 1)
      answers.push(await fixture.queue.countFetch(job.id, token, 3));

    expect(answers).toStrictEqual([
      "counted",
      "counted",
      "counted",
      "exhausted",
    ]);
    expect(await fixture.queue.countFetch(job.id, "x".repeat(43), 3)).toBe(
      "not_holder",
    );

    fixture.clock.advance(3 * MINUTE);
    const second = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    expect(
      await fixture.queue.countFetch(job.id, second?.leaseToken ?? "", 3),
    ).toBe("counted");
    // The count of the old claim cannot be used with the old token any more.
    expect(await fixture.queue.countFetch(job.id, token, 3)).toBe("not_holder");
  });

  // #320-T05
  it("does not count a fetch for a job that is not running", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew({ headSha: sha("c") });
    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });

    expect(
      await fixture.queue.countFetch(job.id, claimed?.leaseToken ?? "", 3),
    ).toBe("not_holder");
  });

  // #1053-T04
  it("counts the MCP calls of a claim up to the limit, apart from the fetches, and starts again with the next claim", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew();
    const first = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    const token = first?.leaseToken ?? "";
    const answers = [];
    for (let call = 0; call < 4; call += 1)
      answers.push(await fixture.queue.countMcpCall(job.id, token, 3));
    expect(answers).toStrictEqual([
      "counted",
      "counted",
      "counted",
      "exhausted",
    ]);
    // The fetches have a count of their own.
    expect(await fixture.queue.countFetch(job.id, token, 3)).toBe("counted");
    expect(await fixture.queue.countMcpCall(job.id, "x".repeat(43), 3)).toBe(
      "not_holder",
    );

    fixture.clock.advance(3 * MINUTE);
    const second = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    expect(
      await fixture.queue.countMcpCall(job.id, second?.leaseToken ?? "", 3),
    ).toBe("counted");
    expect(await fixture.queue.countMcpCall(job.id, token, 3)).toBe(
      "not_holder",
    );
  });

  // #1053-T04
  it("does not count an MCP call for a job that is not running", async () => {
    const fixture = await start();
    const job = await fixture.enqueueNew({ headSha: sha("d") });
    const claimed = await fixture.queue.claimNext("dispatcher-a", undefined, {
      workerCredential: true,
    });
    await fixture.queue.complete(job.id, claimed?.leaseToken ?? "", {
      ok: true,
      result: {},
    });
    expect(
      await fixture.queue.countMcpCall(job.id, claimed?.leaseToken ?? "", 3),
    ).toBe("not_holder");
  });
});
