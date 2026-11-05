// SPDX-License-Identifier: LicenseRef-Proprietary

// The session snapshot of a turn of the Implementer through the Worker API (#839, follow-up turns): the parts a running turn puts
// are kept apart until the last one is in, then checked against the size and digest the runner announced and swapped in for the
// session's old snapshot; the claim is proved on every call without extending the lease; only a turn of the Implementer takes a
// snapshot; nothing is ever deleted but by the erasure of the workspace. The runner side (the transport) is tested on its own.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createImplementerSnapshotsRepository } from "../db/repositories/implementer-snapshots-repository.ts";
import { sha } from "../test-support/jobs.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import { createContractValidator } from "../test-support/runner-contract.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { SNAPSHOT_LIMITS } from "./contract.ts";

const IMPLEMENTER = ["implementer"] as const;
const workerContract = createContractValidator("worker-api.v1.json");
const PART = SNAPSHOT_LIMITS.partBytes;

const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** The query of part `index` of a file of `whole`, as the runner describes it. */
function describeFile(
  whole: Uint8Array,
  index: number,
  over: Record<string, string | number> = {},
) {
  const parts = Math.max(1, Math.ceil(whole.byteLength / PART));
  return {
    part: index,
    parts,
    bytes: whole.byteLength,
    rawBytes: whole.byteLength * 4,
    sha256: digest(whole),
    opencodeVersion: "1.19.0",
    ...over,
  };
}

const slice = (whole: Uint8Array, index: number) =>
  whole.subarray(index * PART, (index + 1) * PART);

async function start() {
  const h = await startRunnerApiHarness();
  await addUser(h.db, "user-1");
  let counter = 0;
  const snapshots = createImplementerSnapshotsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  );
  /** A turn that a Worker holds: queued, claimed with the engine `implementer`, with the per-job credential of a Dispatcher's claim. */
  async function running() {
    counter += 1;
    h.clock.advance(1);
    const enqueued = await h.queue.enqueueImplementerTurn({
      repositoryId: h.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `implementer/s${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    const claimed = await h.queue.claimNext("runner-a", IMPLEMENTER, {
      workerCredential: true,
    });
    if (claimed === null || claimed.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    const turn = await h.db
      .selectFrom("implementer_turns")
      .select(["session_id", "number"])
      .where("job_id", "=", claimed.job.id)
      .executeTakeFirstOrThrow();
    return {
      jobId: claimed.job.id,
      leaseToken: claimed.leaseToken,
      credential: claimed.credential ?? "",
      sessionId: turn.session_id,
    };
  }
  const put = (
    turn: { jobId: string; credential: string },
    whole: Uint8Array,
    index: number,
    over: Record<string, string | number> = {},
    body: Uint8Array = slice(whole, index),
  ) =>
    h.worker.session(
      turn.jobId,
      turn.credential,
      describeFile(whole, index, over),
      body,
    );
  const putAll = async (
    turn: { jobId: string; credential: string },
    whole: Uint8Array,
  ) => {
    const answers: Response[] = [];
    const count = Math.max(1, Math.ceil(whole.byteLength / PART));
    for (let index = 0; index < count; index += 1)
      answers.push(await put(turn, whole, index));
    return answers;
  };
  const parts = (jobId: string) =>
    h.db
      .selectFrom("implementer_session_snapshot_parts")
      .selectAll()
      .where("job_id", "=", jobId)
      .orderBy("part_index")
      .execute();
  const stored = () =>
    h.db.selectFrom("implementer_session_snapshots").selectAll().execute();
  return { h, snapshots, running, put, putAll, parts, stored };
}

describe("the snapshot call of the Worker API", () => {
  // #839-T23
  it("stores a small snapshot in one request, with what the runner announced, and the response is valid", async () => {
    const { h, snapshots, running, putAll, parts } = await start();
    const turn = await running();
    const whole = randomBytes(5_000);

    const [answer] = await putAll(turn, whole);

    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("cache-control")).toBe("no-store");
    const body = await answer?.json();
    expect(body).toStrictEqual({
      version: 1,
      part: 0,
      parts: 1,
      complete: true,
    });
    expect(workerContract.check("SessionPartResponse", body).valid).toBe(true);
    const read = await snapshots.read(turn.sessionId);
    expect(Buffer.from(read?.data ?? []).equals(whole)).toBe(true);
    expect(read?.snapshot).toMatchObject({
      sessionId: turn.sessionId,
      jobId: turn.jobId,
      turnNumber: 1,
      opencodeVersion: "1.19.0",
      bytes: 5_000,
      rawBytes: 20_000,
      sha256: digest(whole),
    });
    expect(await parts(turn.jobId)).toEqual([]);
    expect(
      await h.db
        .selectFrom("implementer_session_snapshots")
        .select("workspace_id")
        .execute(),
    ).toEqual([{ workspace_id: h.workspaceId }]);
  });

  // #839-T23
  it("keeps the parts of a large snapshot apart until the last one is in, then swaps the whole in", async () => {
    const { snapshots, running, put, parts, stored } = await start();
    const turn = await running();
    const whole = randomBytes(2 * PART + 1234);

    const first = await put(turn, whole, 0);
    const second = await put(turn, whole, 1);

    expect(await first.json()).toMatchObject({
      part: 0,
      parts: 3,
      complete: false,
    });
    expect(await second.json()).toMatchObject({
      part: 1,
      parts: 3,
      complete: false,
    });
    expect((await parts(turn.jobId)).map((row) => row.part_index)).toEqual([
      0, 1,
    ]);
    expect(await stored()).toEqual([]);
    expect(await snapshots.find(turn.sessionId)).toBeUndefined();

    const last = await put(turn, whole, 2);

    expect(await last.json()).toMatchObject({
      part: 2,
      parts: 3,
      complete: true,
    });
    expect(await parts(turn.jobId)).toEqual([]);
    const read = await snapshots.read(turn.sessionId);
    expect(Buffer.from(read?.data ?? []).equals(whole)).toBe(true);
  });

  // #839-T23
  it("takes the parts in any order", async () => {
    const { snapshots, running, put } = await start();
    const turn = await running();
    const whole = randomBytes(PART + 99);

    const second = await put(turn, whole, 1);
    const first = await put(turn, whole, 0);

    expect(await second.json()).toMatchObject({ complete: false });
    expect(await first.json()).toMatchObject({ complete: true });
    expect(
      Buffer.from((await snapshots.read(turn.sessionId))?.data ?? []).equals(
        whole,
      ),
    ).toBe(true);
  });

  // #839-T24
  it("is idempotent: a part sent again changes nothing, also the last one after the snapshot is whole", async () => {
    const { running, put, parts, stored } = await start();
    const turn = await running();
    const whole = randomBytes(PART + 10);
    await put(turn, whole, 0);

    const again = await put(turn, whole, 0);
    expect(await again.json()).toMatchObject({ complete: false });
    expect(await parts(turn.jobId)).toHaveLength(1);

    await put(turn, whole, 1);
    const before = await stored();
    const late = await put(turn, whole, 1);

    expect(await late.json()).toMatchObject({ complete: true });
    expect(await parts(turn.jobId)).toEqual([]);
    expect(await stored()).toEqual(before);
  });

  // #839-T24
  it("replaces the snapshot of the session with a new one for the same turn", async () => {
    const { snapshots, running, putAll, stored } = await start();
    const turn = await running();
    await putAll(turn, randomBytes(100));
    const changed = randomBytes(300);

    await putAll(turn, changed);

    expect(await stored()).toHaveLength(1);
    expect(
      Buffer.from((await snapshots.read(turn.sessionId))?.data ?? []).equals(
        changed,
      ),
    ).toBe(true);
  });

  // #839-T24
  it("never lets an older turn replace the snapshot of a newer one", async () => {
    const { h, snapshots, running, putAll } = await start();
    const turn = await running();
    await putAll(turn, randomBytes(100));
    await h.db
      .updateTable("implementer_session_snapshots")
      .set({ turn_number: 5 })
      .where("session_id", "=", turn.sessionId)
      .execute();

    const answers = await putAll(turn, randomBytes(300));

    expect(await answers[0]?.json()).toMatchObject({ complete: true });
    expect((await snapshots.find(turn.sessionId))?.turnNumber).toBe(5);
    expect((await snapshots.find(turn.sessionId))?.bytes).toBe(100);
  });

  // #839-T25
  it("deletes the parts of an upload that never finished when the next upload of the session starts", async () => {
    const { h, running, put, parts } = await start();
    const turn = await running();
    const other = await running();
    // The other turn belongs to another session; give its job the parts of an unfinished upload for THIS session, as an earlier
    // turn of the same session would have left them.
    await h.db
      .insertInto("implementer_session_snapshot_parts")
      .values({
        job_id: other.jobId,
        part_index: 0,
        workspace_id: h.workspaceId,
        session_id: turn.sessionId,
        part_count: 2,
        opencode_version: "1.19.0",
        bytes: PART + 1,
        raw_bytes: 10,
        sha256: "b".repeat(64),
        data: "AAAA",
        created_at: "2026-11-05T08:00:00.000Z",
      })
      .execute();

    await put(turn, randomBytes(50), 0);

    expect(await parts(other.jobId)).toEqual([]);
  });

  // #839-T26
  it("answers 400 and keeps nothing when the parts do not make the file announced", async () => {
    const { snapshots, running, put, parts, stored } = await start();
    const turn = await running();
    const whole = randomBytes(PART + 40);

    await put(turn, whole, 0);
    const wrong = await put(turn, whole, 1, {}, randomBytes(40));

    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      error: { code: "RUNNER_REQUEST_INVALID" },
    });
    expect(await parts(turn.jobId)).toEqual([]);
    expect(await stored()).toEqual([]);
    expect(await snapshots.find(turn.sessionId)).toBeUndefined();
  });

  // #839-T26
  it("answers 400 and keeps nothing when two parts describe different files", async () => {
    const { running, put, parts, stored } = await start();
    const turn = await running();
    const whole = randomBytes(PART + 40);
    await put(turn, whole, 0);

    const other = await put(turn, whole, 1, { sha256: "c".repeat(64) });

    expect(other.status).toBe(400);
    expect(await parts(turn.jobId)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  // #839-T26
  it("keeps the old snapshot when the new upload is refused", async () => {
    const { snapshots, running, putAll, put } = await start();
    const turn = await running();
    const old = randomBytes(100);
    await putAll(turn, old);

    const wrong = await put(turn, randomBytes(100), 0, {
      sha256: "d".repeat(64),
    });

    expect(wrong.status).toBe(400);
    expect(
      Buffer.from((await snapshots.read(turn.sessionId))?.data ?? []).equals(
        old,
      ),
    ).toBe(true);
  });

  // #839-T27
  it("answers 401 for a credential that is not the job's, 409 once the job has ended, and stores nothing then", async () => {
    const { h, running, put, parts, stored } = await start();
    const turn = await running();
    const other = await running();
    const whole = randomBytes(100);

    const wrong = await put(
      { jobId: turn.jobId, credential: other.credential },
      whole,
      0,
    );
    const none = await h.worker.session(
      turn.jobId,
      null,
      describeFile(whole, 0),
      whole,
    );
    await h.complete(turn.jobId, turn.leaseToken, {
      ok: false,
      errorCode: "agent_gave_up",
      errorMessage: "gave up",
    });
    const ended = await put(turn, whole, 0);

    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({
      error: { code: "RUNNER_JOB_ENDED" },
    });
    expect(await parts(turn.jobId)).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  // #839-T27
  it("does not extend the lease", async () => {
    const { h, running, put } = await start();
    const turn = await running();
    const before = await h.db
      .selectFrom("jobs")
      .select(["lease_expires_at", "heartbeat_at", "updated_at"])
      .where("id", "=", turn.jobId)
      .executeTakeFirstOrThrow();
    h.clock.advance(60_000);

    const response = await put(turn, randomBytes(100), 0);

    expect(response.status).toBe(200);
    expect(
      await h.db
        .selectFrom("jobs")
        .select(["lease_expires_at", "heartbeat_at", "updated_at"])
        .where("id", "=", turn.jobId)
        .executeTakeFirstOrThrow(),
    ).toStrictEqual(before);
  });

  // #839-T27
  it("refuses a job that is not a turn of the Implementer", async () => {
    const { h } = await start();
    await h.enqueueNew();
    const claim = await h.claimedSplit();
    const whole = randomBytes(100);

    const response = await h.worker.session(
      claim.job.id,
      claim.job.credential,
      describeFile(whole, 0),
      whole,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { fields: [{ field: "jobId", code: "invalid" }] },
    });
  });

  // #839-T28
  it("refuses a body over 3 MiB with 413 and a description that does not fit with 400, naming fields and never values", async () => {
    const { running, put, parts } = await start();
    const turn = await running();
    const whole = randomBytes(100);

    const big = await put(turn, whole, 0, {}, new Uint8Array(PART + 1));
    const bad = await put(turn, whole, 0, { sha256: "not-a-digest", part: 7 });
    const missing = await put(turn, whole, 0, { opencodeVersion: "../x" });

    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({
      error: { code: "RUNNER_BODY_TOO_LARGE" },
    });
    expect(bad.status).toBe(400);
    const badBody = JSON.stringify(await bad.json());
    expect(badBody).toContain('"field":"sha256"');
    expect(badBody).toContain('"field":"part"');
    expect(badBody).not.toContain("not-a-digest");
    expect(missing.status).toBe(400);
    expect(await parts(turn.jobId)).toEqual([]);
  });

  // #839-T28
  it("takes a snapshot of the largest size the runner keeps, in three parts", async () => {
    const { snapshots, running, putAll } = await start();
    const turn = await running();
    const whole = randomBytes(SNAPSHOT_LIMITS.maxBytes);

    const answers = await putAll(turn, whole);

    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    const read = await snapshots.read(turn.sessionId);
    expect(read?.snapshot.bytes).toBe(SNAPSHOT_LIMITS.maxBytes);
    expect(Buffer.from(read?.data ?? []).equals(whole)).toBe(true);
  }, 30_000);

  // #839-T28
  it("refuses a snapshot over the cap", async () => {
    const { running, put } = await start();
    const turn = await running();
    const whole = randomBytes(SNAPSHOT_LIMITS.maxBytes + 1);

    const response = await put(turn, whole, 0, {}, slice(whole, 0));

    expect(response.status).toBe(400);
  });

  // #839-T29
  it("keeps two turns' snapshots apart, also with the other's credential", async () => {
    const { snapshots, running, put, putAll } = await start();
    const first = await running();
    const second = await running();
    const firstData = randomBytes(100);
    await putAll(first, firstData);

    const response = await put(
      { jobId: first.jobId, credential: second.credential },
      randomBytes(100),
      0,
    );

    expect(response.status).toBe(401);
    expect(await snapshots.find(second.sessionId)).toBeUndefined();
    expect(
      Buffer.from((await snapshots.read(first.sessionId))?.data ?? []).equals(
        firstData,
      ),
    ).toBe(true);
  });

  // #839-T29
  it("lets two parts of one turn arrive at the same time: the snapshot is whole once", async () => {
    const { snapshots, running, put, parts, stored } = await start();
    const turn = await running();
    const whole = randomBytes(PART + 500);

    const [a, b] = await Promise.all([
      put(turn, whole, 0),
      put(turn, whole, 1),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const completes = [await a.json(), await b.json()].filter(
      (body) => body.complete,
    );
    expect(completes).toHaveLength(1);
    expect(await stored()).toHaveLength(1);
    expect(await parts(turn.jobId)).toEqual([]);
    expect(
      Buffer.from((await snapshots.read(turn.sessionId))?.data ?? []).equals(
        whole,
      ),
    ).toBe(true);
  });
});
