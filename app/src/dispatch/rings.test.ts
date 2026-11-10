// SPDX-License-Identifier: LicenseRef-Proprietary

// The doorbell to the webhook dispatchers of customers (#972), at the level of the service: the rows of the pairs are in memory here
// (the join that finds the pairs is proven against Postgres in rings.integration.test.ts), the dispatchers are fake receivers that verify
// every request with the signing secret of their own.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";
import type { DispatchRow } from "../db/repositories/job-dispatches-repository.ts";
import {
  WAITING_DISPATCH_CODES,
  WAITING_MIN_GAP_MS,
} from "../db/repositories/job-dispatches-repository.ts";
import type {
  EndedJobGroup,
  RingPair,
  RunnerDispatchesRepository,
} from "../db/repositories/runner-dispatches-repository.ts";
import type { EnqueueResult, Job } from "../jobs/job-types.ts";
import {
  createFakeDispatchReceiver,
  ignored,
} from "../test-support/fake-dispatch-receiver.ts";
import type { DispatchFetch } from "./send.ts";
import { BUSY_REST_MS } from "./outcome.ts";
import { createRingService, ENDPOINT_DOWN_MS, RING_LIMIT } from "./rings.ts";

const START = new Date("2026-11-10T12:00:00.000Z");
const WORKSPACE = "w-1";

/** The clock of a test: moved by hand. */
function clock() {
  let at = START.getTime();
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

type Dispatcher = {
  runnerId: string;
  url: string;
  keyId: string;
  secret: string;
  labels?: string[];
  harnesses?: Record<string, { version: string; ready: boolean }>;
  baseVersion?: string;
};

/** Both dispatchers' secrets are sealed in the real app; here the "sealed" text is the secret itself and `openSecret` returns it. */
function world(
  dispatchers: Dispatcher[],
  jobs: { id: string; labels: string[]; harness?: string }[],
) {
  const time = clock();
  const rows = new Map<string, DispatchRow>();
  const key = (jobId: string, runnerId: string) => `${jobId}|${runnerId}`;
  const ended: EndedJobGroup[] = [];

  const receivers = new Map(
    dispatchers.map((dispatcher) => [
      dispatcher.url,
      createFakeDispatchReceiver({
        keys: [{ kid: dispatcher.keyId, secret: dispatcher.secret }],
        now: time.now,
      }),
    ]),
  );
  const fetch: DispatchFetch = (url, init) => {
    const receiver = receivers.get(url);
    if (receiver === undefined) return Promise.reject(new TypeError("down"));
    return receiver.fetch(url, init);
  };

  function pairsOf(): RingPair[] {
    return jobs.flatMap((job) =>
      dispatchers
        .filter((dispatcher) =>
          job.labels.every((label) =>
            (dispatcher.labels ?? ["linux"]).includes(label),
          ),
        )
        .map((dispatcher): RingPair => ({
          jobId: job.id,
          reviewKind: "implementer",
          jobAttempts: 0,
          harness: job.harness ?? "opencode",
          runnerId: dispatcher.runnerId,
          baseVersion: dispatcher.baseVersion ?? "1.0.0",
          manifest: {
            harnesses: dispatcher.harnesses ?? {
              opencode: { version: "1", ready: true },
            },
            capabilities: [],
          },
          delivery: {
            url: dispatcher.url,
            keyId: dispatcher.keyId,
            sealedSecret: dispatcher.secret,
          },
        })),
    );
  }

  const repository: RunnerDispatchesRepository = {
    async get(jobId, runnerId) {
      return rows.get(key(jobId, runnerId));
    },
    async create(jobId, runnerId, nextDispatchAt) {
      if (rows.has(key(jobId, runnerId))) return false;
      rows.set(key(jobId, runnerId), {
        jobId,
        state: "pending",
        attempts: 0,
        consecutiveFailures: 0,
        nextDispatchAt: formatTimestamp(nextDispatchAt),
        ackedAt: null,
        lastAttemptAt: null,
        lastStatus: null,
        lastCode: null,
      });
      return true;
    },
    async claimSend(jobId, runnerId, expected, leaseUntil) {
      const row = rows.get(key(jobId, runnerId));
      if (
        row === undefined ||
        row.nextDispatchAt !== expected ||
        row.state === "stopped"
      )
        return false;
      rows.set(key(jobId, runnerId), {
        ...row,
        attempts: row.attempts + 1,
        nextDispatchAt: formatTimestamp(leaseUntil),
        lastAttemptAt: formatTimestamp(time.now()),
      });
      return true;
    },
    async record(jobId, runnerId, update, at) {
      const row = rows.get(key(jobId, runnerId));
      if (row === undefined) return;
      rows.set(key(jobId, runnerId), {
        ...row,
        state: update.state,
        consecutiveFailures: update.consecutiveFailures,
        nextDispatchAt: formatTimestamp(update.nextDispatchAt),
        ackedAt: update.acknowledged ? formatTimestamp(at) : row.ackedAt,
        lastStatus: update.lastStatus,
        lastCode: update.lastCode,
      });
    },
    async listDue(at, limit, { jobId } = {}) {
      return pairsOf()
        .filter((pair) => jobId === undefined || pair.jobId === jobId)
        .filter((pair) => {
          const row = rows.get(key(pair.jobId, pair.runnerId));
          return (
            row === undefined ||
            (row.state !== "stopped" &&
              Date.parse(row.nextDispatchAt) <= at.getTime())
          );
        })
        .slice(0, limit);
    },
    async listWaiting(at, limit, group) {
      return pairsOf()
        .filter((pair) => {
          const job = jobs.find((candidate) => candidate.id === pair.jobId);
          const row = rows.get(key(pair.jobId, pair.runnerId));
          return (
            job !== undefined &&
            job.labels.every((label) => group.labels.includes(label)) &&
            row !== undefined &&
            row.state === "pending" &&
            row.attempts > 0 &&
            row.lastCode !== null &&
            (WAITING_DISPATCH_CODES as readonly string[]).includes(
              row.lastCode,
            ) &&
            row.lastAttemptAt !== null &&
            Date.parse(row.lastAttemptAt) <= at.getTime() - WAITING_MIN_GAP_MS
          );
        })
        .slice(0, limit);
    },
    async listRequeued(at, limit, jobId) {
      return pairsOf()
        .filter((pair) => pair.jobId === jobId)
        .filter((pair) => {
          const row = rows.get(key(pair.jobId, pair.runnerId));
          return (
            row === undefined ||
            row.state === "acked" ||
            (row.state === "pending" &&
              Date.parse(row.nextDispatchAt) <= at.getTime())
          );
        })
        .slice(0, limit);
    },
    async endpointFailedSince(runnerId, since) {
      const latest = [...rows.entries()]
        .filter(
          ([name, row]) =>
            name.endsWith(`|${runnerId}`) && row.lastAttemptAt !== null,
        )
        .map(([, row]) => row)
        .sort((a, b) =>
          (b.lastAttemptAt ?? "").localeCompare(a.lastAttemptAt ?? ""),
        )[0];
      return (
        latest !== undefined &&
        (latest.lastCode === "network_error" ||
          latest.lastCode === "timeout") &&
        Date.parse(latest.lastAttemptAt ?? "") >= since.getTime()
      );
    },
    async endedGroups() {
      return ended;
    },
    async holderDelivery() {
      return undefined;
    },
    async reviveStopped() {
      return 0;
    },
    async deleteFinishedBefore() {
      return 0;
    },
  };

  const lines: string[] = [];
  const service = (
    extra: {
      minBaseVersion?: string | null;
      openSecret?: (runnerId: string, sealed: string) => string;
      timeoutMs?: number;
    } = {},
  ) =>
    createRingService({
      db: {} as Kysely<Database>,
      dispatches: repository,
      openSecret: extra.openSecret ?? ((_runnerId, sealed) => sealed),
      minBaseVersion: () => extra.minBaseVersion ?? null,
      fetch,
      now: time.now,
      ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
      newId: (() => {
        let n = 0;
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      })(),
      log: {
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });

  return {
    time,
    rows,
    lines,
    service,
    receiver: (url: string) => {
      const receiver = receivers.get(url);
      if (receiver === undefined) throw new Error(`no receiver at ${url}`);
      return receiver;
    },
    jobEnded: (group: EndedJobGroup) => ended.push(group),
    row: (jobId: string, runnerId: string) => rows.get(key(jobId, runnerId)),
  };
}

const A: Dispatcher = {
  runnerId: "runner-a",
  url: "https://a.example.test/dispatch",
  keyId: "d-aaaaaaaa",
  secret: "crw_a-secret-0123456789abcdef0123456789abcdef",
};
const B: Dispatcher = {
  runnerId: "runner-b",
  url: "https://b.example.test/dispatch",
  keyId: "d-bbbbbbbb",
  secret: "crw_b-secret-0123456789abcdef0123456789abcdef",
};

const queued = (id: string): EnqueueResult => ({
  status: "created",
  job: { id, status: "queued", reviewKind: "implementer" } as Job,
  supersededJobIds: [],
});

describe("ringing the webhook dispatchers of customers", () => {
  // #972-T01
  it("rings every dispatcher that matches a new job, each with its own key, and the first claim wins (the others get 204 from the claim)", async () => {
    const w = world([A, B], [{ id: "job-1", labels: ["linux"] }]);

    await w.service().onEnqueued(queued("job-1"));

    for (const dispatcher of [A, B]) {
      const received = w.receiver(dispatcher.url).received;
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        url: dispatcher.url,
        verdict: "ok",
        body: { type: "job.ready", jobId: "job-1", reviewKind: "implementer" },
        headers: { "x-dispatch-key-id": dispatcher.keyId },
      });
    }
    // Both said 202; which of them wins is the claim's business (a second claim of the same job finds it running: 204).
    expect(w.row("job-1", A.runnerId)?.state).toBe("acked");
    expect(w.row("job-1", B.runnerId)?.state).toBe("acked");
  });

  it("carries no job data: the body is the doorbell of the contract and no key or label is in it", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);

    await w.service().onEnqueued(queued("job-1"));

    const [call] = w.receiver(A.url).received;
    expect(Object.keys(call?.body ?? {}).sort()).toEqual([
      "attempt",
      "dispatchId",
      "jobId",
      "reviewKind",
      "sentAt",
      "type",
      "version",
    ]);
    expect(call?.rawBody).not.toContain(A.secret);
  });

  // #972-T06
  it("signs with the secret of the dispatcher it rings: another dispatcher's receiver refuses the call", async () => {
    const w = world([A, B], [{ id: "job-1", labels: ["linux"] }]);

    await w.service().onEnqueued(queued("job-1"));

    // What A was sent, checked by B's receiver (B's key id and secret): it is not B's.
    const toA = w.receiver(A.url).received[0];
    const verifier = createFakeDispatchReceiver({
      keys: [{ kid: B.keyId, secret: B.secret }],
      now: w.time.now,
    });
    await verifier.fetch(A.url, {
      method: "POST",
      headers: toA?.headers,
      body: toA?.rawBody,
    });
    expect(verifier.received[0]?.verdict).toBe("unknown_key");
    // The same key id under another secret is a bad signature.
    const spoof = createFakeDispatchReceiver({
      keys: [{ kid: A.keyId, secret: B.secret }],
      now: w.time.now,
    });
    await spoof.fetch(A.url, {
      method: "POST",
      headers: toA?.headers,
      body: toA?.rawBody,
    });
    expect(spoof.received[0]?.verdict).toBe("bad_signature");
  });

  it("rings only dispatchers that have every label the job requires", async () => {
    const gpu = { ...B, labels: ["linux", "gpu"] };
    const w = world([A, gpu], [{ id: "job-1", labels: ["linux", "gpu"] }]);

    await w.service().onEnqueued(queued("job-1"));

    expect(w.receiver(A.url).received).toHaveLength(0);
    expect(w.receiver(gpu.url).received).toHaveLength(1);
  });

  it("does not ring a dispatcher that cannot run the job (no harness, or a base below the minimum) and does not ask again soon", async () => {
    const old = { ...B, baseVersion: "0.9.0" };
    const noHarness = {
      ...A,
      runnerId: "runner-c",
      url: "https://c.example.test/dispatch",
      keyId: "d-cccccccc",
      harnesses: { opencode: { version: "1", ready: true } },
    };
    const w = world(
      [old, noHarness],
      [{ id: "job-1", labels: ["linux"], harness: "claude-code" }],
    );

    await w.service({ minBaseVersion: "1.0.0" }).onEnqueued(queued("job-1"));

    expect(w.receiver(old.url).received).toHaveLength(0);
    expect(w.receiver(noHarness.url).received).toHaveLength(0);
    expect(w.row("job-1", old.runnerId)?.state).toBe("stopped");
    expect(w.row("job-1", noHarness.runnerId)?.state).toBe("stopped");
    expect(await w.service().ringDue()).toEqual({ rung: 0 });
  });

  it("is idempotent: a job that was rung is not rung again by the next enqueue hook or the sweep while its row waits", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const service = w.service();

    await service.onEnqueued(queued("job-1"));
    await service.onEnqueued(queued("job-1"));
    await service.ringDue();

    expect(w.receiver(A.url).received).toHaveLength(1);
  });

  it("leaves a review alone: only a turn of the Implementer can go to a customer's dispatcher", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);

    await w.service().onEnqueued({
      status: "created",
      job: { id: "job-1", status: "queued", reviewKind: "diff" } as Job,
      supersededJobIds: [],
    });

    expect(w.receiver(A.url).received).toHaveLength(0);
  });

  it("leaves a job that already exists alone, and a job that is not queued", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const service = w.service();

    await service.onEnqueued({
      status: "existing",
      job: { id: "job-1", status: "queued", reviewKind: "implementer" } as Job,
      reason: "same_delivery",
    });
    await service.onEnqueued({
      status: "created",
      job: { id: "job-1", status: "running" } as Job,
      supersededJobIds: [],
    });

    expect(w.receiver(A.url).received).toHaveLength(0);
  });

  it("rings the pairs a sweep finds due, and the pair whose back-off is over", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const receiver = w.receiver(A.url);
    receiver.reply({ status: 503, headers: { "retry-after": "5" } });
    const service = w.service();

    await service.onEnqueued(queued("job-1"));
    expect(receiver.received).toHaveLength(1);
    expect(w.row("job-1", A.runnerId)?.lastCode).toBe("unavailable");

    // Too early: the row says later.
    expect(await service.ringDue()).toEqual({ rung: 0 });
    w.time.advance(60_000);
    expect(await service.ringDue()).toEqual({ rung: 1 });
    expect(receiver.received).toHaveLength(2);
    expect(w.row("job-1", A.runnerId)?.state).toBe("acked");
  });
});

describe("a dispatcher that is full", () => {
  // #972-T02
  it("answering busy is not rung again for that job by a timer, a second hook or the sweep, until an event; nothing is lost", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const receiver = w.receiver(A.url);
    receiver.reply(ignored("busy"));
    const service = w.service();

    await service.onEnqueued(queued("job-1"));

    expect(receiver.received).toHaveLength(1);
    expect(w.row("job-1", A.runnerId)).toMatchObject({
      state: "pending",
      lastCode: "ignored_busy",
      consecutiveFailures: 0,
    });
    // Nothing alarming is logged for a full dispatcher.
    expect(w.lines).toEqual([]);

    // The repair work of the requests (a minute later, and again just before the rest is over) leaves it alone.
    w.time.advance(60_000);
    expect(await service.ringDue()).toEqual({ rung: 0 });
    w.time.advance(BUSY_REST_MS - 120_000);
    expect(await service.ringDue()).toEqual({ rung: 0 });
    expect(receiver.received).toHaveLength(1);

    // The sweep after the rest rings it: the job was never lost.
    w.time.advance(120_000);
    expect(await service.ringDue()).toEqual({ rung: 1 });
    expect(receiver.received).toHaveLength(2);
  });

  // #972-T02
  it("hears of work again when a job of its label group ends: the waiting job is rung at once", async () => {
    const w = world([A], [{ id: "job-2", labels: ["linux"] }]);
    const receiver = w.receiver(A.url);
    receiver.reply(ignored("busy"));
    const service = w.service();
    await service.onEnqueued(queued("job-2"));
    w.time.advance(WAITING_MIN_GAP_MS + 1_000);
    w.jobEnded({
      jobId: "job-1",
      workspaceId: WORKSPACE,
      requiredLabels: ["linux"],
      holderLabels: ["linux"],
    });

    expect(await service.ringGroupsOf(["job-1"])).toEqual({ rung: 1 });

    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[1]?.body?.jobId).toBe("job-2");
    expect(w.row("job-2", A.runnerId)?.state).toBe("acked");
  });
});

describe("ringing again when a job of a label group ends", () => {
  // #972-T03
  it("rings the waiting jobs that group can take, and no others", async () => {
    const gpu = { ...B, labels: ["linux", "gpu"] };
    const w = world(
      [A, gpu],
      [
        { id: "job-linux", labels: ["linux"] },
        { id: "job-gpu", labels: ["linux", "gpu"] },
      ],
    );
    const receiverA = w.receiver(A.url);
    const receiverGpu = w.receiver(gpu.url);
    receiverA.reply(ignored("busy"));
    receiverGpu.reply(ignored("busy"), ignored("busy"));
    const service = w.service();
    await service.onEnqueued(queued("job-linux"));
    await service.onEnqueued(queued("job-gpu"));
    const rungBefore = [receiverA.received.length, receiverGpu.received.length];
    w.time.advance(WAITING_MIN_GAP_MS + 1_000);
    // A job that required only `linux` and ran on a dispatcher with `linux` ended.
    w.jobEnded({
      jobId: "job-done",
      workspaceId: WORKSPACE,
      requiredLabels: ["linux"],
      holderLabels: ["linux"],
    });

    const { rung } = await service.ringGroupsOf(["job-done"]);

    // The group has `linux` only: the waiting `linux` job is rung (on both dispatchers that match it), the `gpu` job is not.
    expect(rung).toBe(2);
    expect(receiverA.received.length).toBe(rungBefore[0]! + 1);
    expect(
      receiverGpu.received.filter((call) => call.body?.jobId === "job-gpu"),
    ).toHaveLength(1);
    expect(receiverGpu.received.at(-1)?.body?.jobId).toBe("job-linux");
  });

  // #972-T03
  it("does not storm: a pair is rung again only after the gap, a dispatcher that says busy again is spared in the same run, and at most RING_LIMIT pairs are rung", async () => {
    const jobs = Array.from({ length: RING_LIMIT + 5 }, (_, i) => ({
      id: `job-${String(i).padStart(2, "0")}`,
      labels: ["linux"],
    }));
    const w = world([A], jobs);
    const receiver = w.receiver(A.url);
    receiver.reply(...jobs.map(() => ignored("busy")));
    const service = w.service();
    for (const job of jobs) await service.onEnqueued(queued(job.id));
    // The first ring of each waiting job was answered busy (the dispatcher is spared inside one run, so the sweep of the enqueues counted).
    const afterEnqueues = receiver.received.length;
    w.jobEnded({
      jobId: "job-done",
      workspaceId: WORKSPACE,
      requiredLabels: ["linux"],
      holderLabels: ["linux"],
    });

    // Too soon after the last call: nothing.
    expect(await service.ringGroupsOf(["job-done"])).toEqual({ rung: 0 });
    w.time.advance(WAITING_MIN_GAP_MS + 1_000);
    receiver.reply(ignored("busy"));
    const first = await service.ringGroupsOf(["job-done"]);

    // One run asks a full dispatcher once, not once for each of its waiting jobs.
    expect(first).toEqual({ rung: 1 });
    expect(receiver.received.length).toBe(afterEnqueues + 1);
    expect(first.rung).toBeLessThanOrEqual(RING_LIMIT);
  });

  it("rings nothing for a job that ended in another workspace's group", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const receiver = w.receiver(A.url);
    receiver.reply(ignored("busy"));
    const service = w.service();
    await service.onEnqueued(queued("job-1"));
    w.time.advance(WAITING_MIN_GAP_MS + 1_000);
    w.jobEnded({
      jobId: "job-x",
      workspaceId: WORKSPACE,
      requiredLabels: ["gpu"],
      holderLabels: [],
    });

    expect(await service.ringGroupsOf(["job-x"])).toEqual({ rung: 0 });
  });
});

describe("failures of a dispatcher", () => {
  it("backs off like the platform's dispatcher and logs the stable code, never the address or the key", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    const receiver = w.receiver(A.url);
    receiver.reply({ fails: "connect ECONNREFUSED a.example.test" });
    const service = w.service();

    await service.onEnqueued(queued("job-1"));

    expect(w.row("job-1", A.runnerId)).toMatchObject({
      state: "pending",
      lastCode: "network_error",
      consecutiveFailures: 1,
    });
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toContain("RING_SEND_FAILED");
    expect(w.lines[0]).toContain("code=network_error");
    expect(w.lines[0]).not.toContain("example.test");
    expect(w.lines[0]).not.toContain(A.secret);
    expect(w.lines[0]).not.toContain(A.keyId);
  });

  it("alerts for an answer the contract does not describe", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);
    w.receiver(A.url).reply({ status: 401 });

    await w.service().onEnqueued(queued("job-1"));

    expect(w.lines[0]).toContain("RING_REJECTED");
  });

  it("does not ring a dispatcher whose secret cannot be read, and tells an operator", async () => {
    const w = world([A], [{ id: "job-1", labels: ["linux"] }]);

    await w
      .service({
        openSecret: () => {
          throw new Error("secret_undecryptable");
        },
      })
      .onEnqueued(queued("job-1"));

    expect(w.receiver(A.url).received).toHaveLength(0);
    expect(w.row("job-1", A.runnerId)).toMatchObject({
      state: "pending",
      lastCode: "rejected",
      lastStatus: null,
    });
    expect(w.lines[0]).toContain("RING_REJECTED");
  });
});

describe("ringing a job that a lapsed lease put back in the queue", () => {
  // #972-T03
  it("rings the pair that held it and the pairs of the other dispatchers that match, once each", async () => {
    const w = world([A, B], [{ id: "job-1", labels: ["linux"] }]);
    const service = w.service();
    // The job was rung and A claimed it: both rows say acked. Then A's lease lapsed and the job is queued again.
    await service.onEnqueued(queued("job-1"));
    expect(w.row("job-1", A.runnerId)?.state).toBe("acked");

    const { rung } = await service.ringRequeued(["job-1"]);

    expect(rung).toBe(2);
    expect(w.receiver(A.url).received).toHaveLength(2);
    expect(w.receiver(B.url).received).toHaveLength(2);
  });

  it("leaves a pair alone that was told to stop, and one that is waiting for a back-off or a slot", async () => {
    const stopped = {
      ...B,
      runnerId: "runner-c",
      url: "https://c.example.test/dispatch",
      keyId: "d-cccccccc",
      baseVersion: "0.9.0",
    };
    const w = world([A, stopped], [{ id: "job-1", labels: ["linux"] }]);
    w.receiver(A.url).reply(ignored("busy"));
    const service = w.service({ minBaseVersion: "1.0.0" });
    await service.onEnqueued(queued("job-1"));
    expect(w.row("job-1", A.runnerId)?.lastCode).toBe("ignored_busy");
    expect(w.row("job-1", stopped.runnerId)?.state).toBe("stopped");

    expect(await service.ringRequeued(["job-1"])).toEqual({ rung: 0 });

    expect(w.receiver(A.url).received).toHaveLength(1);
    expect(w.receiver(stopped.url).received).toHaveLength(0);
  });

  it("rings the waiting jobs of the group the lost slot belonged to", async () => {
    const w = world(
      [A],
      [
        { id: "job-1", labels: ["linux"] },
        { id: "job-2", labels: ["linux"] },
      ],
    );
    const receiver = w.receiver(A.url);
    // job-1 was claimed by A; job-2 was turned away because A was full.
    receiver.reply({ status: 202 }, ignored("busy"));
    const service = w.service();
    await service.onEnqueued(queued("job-1"));
    await service.onEnqueued(queued("job-2"));
    expect(w.row("job-2", A.runnerId)?.lastCode).toBe("ignored_busy");
    w.time.advance(WAITING_MIN_GAP_MS + 1_000);
    w.jobEnded({
      jobId: "job-1",
      workspaceId: WORKSPACE,
      requiredLabels: ["linux"],
      holderLabels: [],
    });
    const before = receiver.received.length;

    await service.ringRequeued(["job-1"]);

    const later = receiver.received
      .slice(before)
      .map((call) => call.body?.jobId);
    expect(later).toContain("job-1");
    expect(later).toContain("job-2");
  });

  it("is bounded: at most RING_LIMIT pairs are rung, however many jobs came back", async () => {
    const jobs = Array.from({ length: RING_LIMIT + 10 }, (_, i) => ({
      id: `job-${String(i).padStart(2, "0")}`,
      labels: ["linux"],
    }));
    const w = world([A, B], jobs);
    const service = w.service();
    for (const job of jobs) await service.onEnqueued(queued(job.id));
    w.time.advance(60_000);
    const before =
      w.receiver(A.url).received.length + w.receiver(B.url).received.length;

    const { rung } = await service.ringRequeued(jobs.map((job) => job.id));

    expect(rung).toBeLessThanOrEqual(RING_LIMIT);
    expect(
      w.receiver(A.url).received.length +
        w.receiver(B.url).received.length -
        before,
    ).toBe(rung);
  });
});

describe("a dispatcher whose endpoint is down", () => {
  it("is not rung for another job for a minute, in this or any other run, and is rung again after it", async () => {
    const w = world(
      [A, B],
      [
        { id: "job-1", labels: ["linux"] },
        { id: "job-2", labels: ["linux"] },
        { id: "job-3", labels: ["linux"] },
      ],
    );
    w.receiver(A.url).reply({ fails: "connect ECONNREFUSED" });
    const service = w.service();

    await service.onEnqueued(queued("job-1"));
    expect(w.row("job-1", A.runnerId)?.lastCode).toBe("network_error");
    // A second job arrives a moment later: A is not tried, B is.
    w.time.advance(5_000);
    await service.onEnqueued(queued("job-2"));
    expect(w.receiver(A.url).received).toHaveLength(1);
    expect(w.receiver(B.url).received.map((call) => call.body?.jobId)).toEqual([
      "job-1",
      "job-2",
    ]);
    // Nor does the sweep try it inside the minute.
    w.time.advance(ENDPOINT_DOWN_MS - 10_000);
    await service.ringDue();
    expect(w.receiver(A.url).received).toHaveLength(1);

    // After the minute the endpoint is asked again; it answers this time.
    w.time.advance(10_000);
    await service.onEnqueued(queued("job-3"));
    expect(
      w.receiver(A.url).received.map((call) => call.body?.jobId),
    ).toContain("job-3");
  });

  it("is remembered for a timeout as well, and a dispatcher that answered is not", async () => {
    const w = world(
      [A, B],
      [
        { id: "job-1", labels: ["linux"] },
        { id: "job-2", labels: ["linux"] },
      ],
    );
    w.receiver(A.url).reply("hang");
    w.receiver(B.url).reply({ status: 503, headers: { "retry-after": "1" } });
    const service = w.service({ timeoutMs: 20 });

    await service.onEnqueued(queued("job-1"));
    expect(w.row("job-1", A.runnerId)?.lastCode).toBe("timeout");
    expect(w.row("job-1", B.runnerId)?.lastCode).toBe("unavailable");
    await service.onEnqueued(queued("job-2"));

    expect(w.receiver(A.url).received).toHaveLength(1);
    // B answered 503 (it is up): it is asked for the next job.
    expect(w.receiver(B.url).received).toHaveLength(2);
  });
});
