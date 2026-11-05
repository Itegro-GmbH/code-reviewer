// SPDX-License-Identifier: LicenseRef-Proprietary

// The stored session snapshot read back by the Worker of a follow-up turn (#840, follow-up turns): the snapshot of the job's own
// session, in the parts the upload used, with the description of the whole file in the headers of every part. The claim is proved on
// every call without extending the lease; only a turn of the Implementer reads; a job reads no other session's snapshot and no other
// workspace's; a turn that has no earlier snapshot gets 204 and continues from a summary. The runner side (the download) is tested on
// its own.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createImplementerSnapshotsRepository } from "../db/repositories/implementer-snapshots-repository.ts";
import type { WorkspaceId } from "../db/workspace-scope.ts";
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
  /** The snapshot of the session of `turn`, as that turn's upload leaves it: stored for turn `number`. */
  async function store(
    turn: { sessionId: string; jobId: string },
    whole: Uint8Array,
    number = 1,
    version = "1.19.0",
  ) {
    await h.db
      .insertInto("implementer_session_snapshots")
      .values({
        session_id: turn.sessionId,
        workspace_id: h.workspaceId,
        job_id: turn.jobId,
        turn_number: number,
        opencode_version: version,
        bytes: whole.byteLength,
        raw_bytes: whole.byteLength * 4,
        sha256: digest(whole),
        data: Buffer.from(whole).toString("base64"),
        created_at: "2026-11-05T06:00:00.000Z",
        updated_at: "2026-11-05T06:00:00.000Z",
      })
      .execute();
  }
  /**
   * The follow-up turn of `earlier`'s session, running: a second turn is queued (the follow-up API does not exist yet) and its turn row
   * is moved into the session as turn 2. The first turn has to be over, one turn runs at a time.
   */
  async function followUp(earlier: { sessionId: string; jobId: string }) {
    await h.db
      .updateTable("jobs")
      .set({ status: "failed" })
      .where("id", "=", earlier.jobId)
      .execute();
    const next = await running();
    await h.db
      .updateTable("implementer_turns")
      .set({ session_id: earlier.sessionId, number: 2 })
      .where("job_id", "=", next.jobId)
      .execute();
    return { ...next, sessionId: earlier.sessionId };
  }
  return { h, snapshots, running, store, followUp };
}

async function bytesOf(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

describe("the resume-session call of the Worker API", () => {
  // #840-T01
  it("serves a small snapshot to the follow-up turn of the same session, as stored, with the description of the whole file in the headers", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    const whole = randomBytes(5_000);
    await store(first, whole);
    const turn = await followUp(first);

    const answer = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-length")).toBe("5000");
    const headers = {
      "x-snapshot-parts": answer.headers.get("x-snapshot-parts"),
      "x-snapshot-bytes": answer.headers.get("x-snapshot-bytes"),
      "x-snapshot-raw-bytes": answer.headers.get("x-snapshot-raw-bytes"),
      "x-snapshot-sha256": answer.headers.get("x-snapshot-sha256"),
      "x-snapshot-opencode-version": answer.headers.get(
        "x-snapshot-opencode-version",
      ),
    };
    expect(headers).toStrictEqual({
      "x-snapshot-parts": "1",
      "x-snapshot-bytes": "5000",
      "x-snapshot-raw-bytes": "20000",
      "x-snapshot-sha256": digest(whole),
      "x-snapshot-opencode-version": "1.19.0",
    });
    expect(workerContract.check("ResumeSessionHeaders", headers).valid).toBe(
      true,
    );
    expect(Buffer.from(await bytesOf(answer)).equals(whole)).toBe(true);
  });

  // #840-T02
  it("serves a large snapshot in the parts of the upload, each with the same description, and the parts make the file", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    const whole = randomBytes(2 * PART + 1234);
    await store(first, whole);
    const turn = await followUp(first);

    const answers = await Promise.all(
      [0, 1, 2].map((part) =>
        h.worker.resumeSession(turn.jobId, turn.credential, part),
      ),
    );

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    for (const answer of answers) {
      expect(answer.headers.get("x-snapshot-parts")).toBe("3");
      expect(answer.headers.get("x-snapshot-bytes")).toBe(
        String(whole.byteLength),
      );
      expect(answer.headers.get("x-snapshot-sha256")).toBe(digest(whole));
    }
    const bodies = await Promise.all(answers.map(bytesOf));
    expect(bodies.map((body) => body.byteLength)).toEqual([PART, PART, 1234]);
    expect(Buffer.concat(bodies).equals(whole)).toBe(true);
  });

  // #840-T03
  it("serves a part again, and a part of a snapshot with one part only as part 0", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    await store(first, randomBytes(100));
    const turn = await followUp(first);

    const again = await Promise.all([
      h.worker.resumeSession(turn.jobId, turn.credential, 0),
      h.worker.resumeSession(turn.jobId, turn.credential),
    ]);
    const beyond = await h.worker.resumeSession(turn.jobId, turn.credential, 1);

    expect(again.map((answer) => answer.status)).toEqual([200, 200]);
    expect(beyond.status).toBe(400);
    expect(await beyond.json()).toMatchObject({
      error: { code: "RUNNER_REQUEST_INVALID", fields: [{ field: "part" }] },
    });
  });

  // #840-T04
  it.each(["3", "-1", "abc", "1.5", "01", ""])(
    "refuses the part %j and names the field",
    async (part) => {
      const { h, running, store, followUp } = await start();
      const first = await running();
      await store(first, randomBytes(100));
      const turn = await followUp(first);

      const answer = await h.worker.resumeSession(
        turn.jobId,
        turn.credential,
        part,
      );

      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_REQUEST_INVALID", fields: [{ field: "part" }] },
      });
    },
  );

  // #840-T05
  it("answers 204 with no body when the session has no snapshot", async () => {
    const { h, running, followUp } = await start();
    const first = await running();
    const turn = await followUp(first);

    const answer = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(answer.status).toBe(204);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect((await bytesOf(answer)).byteLength).toBe(0);
  });

  // #840-T06
  it("reads a snapshot of an earlier turn only: the one left by this very turn's earlier attempt, or by a later turn, is not read", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    await store(first, randomBytes(100), 2);
    const turn = await followUp(first);

    const answer = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(answer.status).toBe(204);
  });

  // #840-T07
  it("gives a turn nothing of another session: its own session has none, the other one has a snapshot", async () => {
    const { h, running, store } = await start();
    const other = await running();
    await h.db
      .updateTable("jobs")
      .set({ status: "failed" })
      .where("id", "=", other.jobId)
      .execute();
    await store(other, randomBytes(100));
    const turn = await running();

    const answer = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(turn.sessionId).not.toBe(other.sessionId);
    expect(answer.status).toBe(204);
  });

  // #840-T08
  it("does not read through another workspace's repository", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    await store(first, randomBytes(100));
    const turn = await followUp(first);
    const foreign = createImplementerSnapshotsRepository(
      h.db,
      "another-workspace" as WorkspaceId,
      h.clock.now,
    );

    const read = await foreign.readForJob(turn.jobId, turn.leaseToken);

    expect(read).toStrictEqual({ status: "not_holder" });
  });

  // #840-T09
  it("answers 401 for a credential that is not the job's or none, and 409 once the job has ended", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    await store(first, randomBytes(100));
    const turn = await followUp(first);

    const wrong = await h.worker.resumeSession(turn.jobId, first.credential);
    const none = await h.worker.resumeSession(turn.jobId, null);
    await h.complete(turn.jobId, turn.leaseToken, {
      ok: false,
      errorCode: "agent_gave_up",
      errorMessage: "gave up",
    });
    const ended = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({
      error: { code: "RUNNER_JOB_ENDED" },
    });
  });

  // #840-T10
  it("does not extend the lease", async () => {
    const { h, running, store, followUp } = await start();
    const first = await running();
    await store(first, randomBytes(100));
    const turn = await followUp(first);
    const read = () =>
      h.db
        .selectFrom("jobs")
        .select(["lease_expires_at", "heartbeat_at", "updated_at"])
        .where("id", "=", turn.jobId)
        .executeTakeFirstOrThrow();
    const before = await read();
    h.clock.advance(60_000);

    const answer = await h.worker.resumeSession(turn.jobId, turn.credential);

    expect(answer.status).toBe(200);
    expect(await read()).toStrictEqual(before);
  });

  // #840-T11
  it("is a call for a turn of the Implementer: a stale or unknown job id is refused, and the repository finds nothing for a job that is not a running turn", async () => {
    const { h, running, store, followUp, snapshots } = await start();
    const first = await running();
    await store(first, randomBytes(100));
    const turn = await followUp(first);

    const unknown = await h.worker.resumeSession(
      "00000000-0000-4000-8000-000000000000",
      turn.credential,
    );
    const badId = await h.worker.resumeSession("not-a-uuid", turn.credential);
    const wrongLease = await snapshots.readForJob(turn.jobId, "another-lease");
    const ended = await snapshots.readForJob(first.jobId, first.leaseToken);

    expect(unknown.status).toBe(401);
    expect(badId.status).toBe(400);
    expect(wrongLease).toStrictEqual({ status: "not_holder" });
    expect(ended).toStrictEqual({ status: "not_holder" });
  });
});
