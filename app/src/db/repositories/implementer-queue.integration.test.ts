// SPDX-License-Identifier: LicenseRef-Proprietary

// The next instruction of a session (#841) against a real Postgres: the atomic idle-to-running start, the one queued instruction, its
// discard, the history of a session's turns, and the sweep's lookup of the sessions that hold an instruction.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { ImplementerStoreError } from "../implementer-errors.ts";
import {
  createImplementerRepository,
  type NewFollowUpTurn,
  type QueuedInstruction,
} from "./implementer-repository.ts";
import { sessionsWithQueuedInstruction } from "./implementer-sessions-sweep.ts";
import {
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../../test-support/implementer.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";

const T = "2026-11-05T10:00:00.000Z";

async function setup() {
  const { db } = await createTestDatabase();
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const a = await seedImplementerRepository(db, idA, "a");
  const b = await seedImplementerRepository(db, idB, "b");
  const sessionsA = createImplementerRepository(db, idA);
  const started = await startTask(db, idA, taskOf(a), a.repoUrl);
  return { db, idA, idB, a, b, sessionsA, started };
}

/** A job in the shape of a turn's, inserted the way the queue inserts it (own delivery id, the negative slot as the pull request number). */
function jobOf(
  workspaceId: string,
  repositoryId: string,
  repoUrl: string,
  tag: string,
) {
  return async (
    trx: Kysely<Database>,
    context: { slot: number; sessionId: string },
  ): Promise<string> => {
    const id = `job-${tag}`;
    await trx
      .insertInto("jobs")
      .values({
        id,
        workspace_id: workspaceId,
        repository_id: repositoryId,
        pr_number: -context.slot,
        pr_url: `${repoUrl}/tree/x`,
        head_sha: "a".repeat(40),
        command: "review",
        review_kind: "implementer",
        args: "",
        trigger_kind: "manual",
        actor_login: "octocat",
        delivery_id: `implementer:${workspaceId}:${tag}`,
        status: "queued",
        run_after: T,
        attempts: 0,
        created_at: T,
        updated_at: T,
      })
      .execute();
    return id;
  };
}

const turn = (
  sessionId: string,
  overrides: Partial<NewFollowUpTurn> = {},
): NewFollowUpTurn => ({
  sessionId,
  instruction: "Next.",
  modelChoice: { entryId: "entry-1" },
  costLimitCents: null,
  environment: null,
  profile: null,
  resultSchema: null,
  createdBy: "user-a",
  fromQueued: false,
  ...overrides,
});

const queued = (
  overrides: Partial<QueuedInstruction> = {},
): QueuedInstruction => ({
  clientRequestId: "request-q",
  instruction: "Queued words.",
  modelChoice: { entryId: "entry-1" },
  costLimitCents: 100,
  environment: null,
  profile: null,
  resultSchema: null,
  createdBy: "user-a",
  actorLogin: "octocat",
  queuedAt: T,
  ...overrides,
});

async function endFirstTurn(
  f: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  await f.db
    .updateTable("jobs")
    .set({ status: "succeeded", finished_at: T })
    .where("id", "=", f.started.turn.jobId)
    .execute();
  await f.sessionsA.recordTurnResult(f.started.session.id, {
    headCommit: "c".repeat(40),
    opencode: null,
    summary: "Done.",
  });
}

describe("starting the next turn of a session", () => {
  // #841-D01
  it("takes the next turn number, sets the session running and writes the turn with the choices it was given", async () => {
    const f = await setup();
    await endFirstTurn(f);

    const result = await f.sessionsA.startFollowUpTurn(
      turn(f.started.session.id, {
        costLimitCents: 250,
        environment: { id: "env-1", name: "Node", vcpus: 2, setupScript: "ci" },
      }),
      jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "second"),
    );

    expect(result.status).toBe("started");
    if (result.status !== "started") return;
    expect(result.turn).toMatchObject({
      number: 2,
      instruction: "Next.",
      costLimitCents: 250,
      jobId: "job-second",
      environment: { id: "env-1", name: "Node", setupScript: "ci" },
    });
    expect(result.session.status).toBe("running");
  });

  // #841-D02: of two calls for one idle session, one turn
  it("makes one turn of two parallel calls and answers busy to the other", async () => {
    const f = await setup();
    await endFirstTurn(f);

    const results = await Promise.all(
      ["x", "y"].map((tag) =>
        f.sessionsA.startFollowUpTurn(
          turn(f.started.session.id),
          jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, tag),
        ),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual(["busy", "started"]);
    const turns = await f.db
      .selectFrom("implementer_turns")
      .select("number")
      .where("session_id", "=", f.started.session.id)
      .orderBy("number")
      .execute();
    expect(turns.map((t) => t.number)).toEqual([1, 2]);
  });

  // #841-D03
  it("answers busy for a running session without calling the job maker, and not_found for another workspace's session", async () => {
    const f = await setup();
    let called = false;
    const never = async (): Promise<string> => {
      called = true;
      return "never";
    };

    expect(
      await f.sessionsA.startFollowUpTurn(turn(f.started.session.id), never),
    ).toEqual({ status: "busy" });
    expect(
      await createImplementerRepository(f.db, f.idB).startFollowUpTurn(
        turn(f.started.session.id),
        never,
      ),
    ).toEqual({ status: "not_found" });
    expect(called).toBe(false);
  });

  // #841-D04: a job of another repository, or with another slot, is refused and nothing is written
  it("refuses a job whose pull request number is not the negative slot, writing nothing", async () => {
    const f = await setup();
    await endFirstTurn(f);

    const error = await f.sessionsA
      .startFollowUpTurn(turn(f.started.session.id), async (trx) => {
        const id = await jobOf(
          f.idA,
          f.a.repositoryId,
          f.a.repoUrl,
          "wrong",
        )(trx, { slot: 99, sessionId: f.started.session.id });
        return id;
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ImplementerStoreError);
    expect((error as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_JOB_MISMATCH",
    );
    expect((await f.sessionsA.getSession(f.started.session.id))?.status).toBe(
      "idle",
    );
    expect(
      await f.db
        .selectFrom("jobs")
        .select("id")
        .where("id", "=", "job-wrong")
        .execute(),
    ).toEqual([]);
  });
});

describe("the one queued instruction", () => {
  // #841-D05 (owner decision 5)
  it("is kept for a running session, once: the second is full, and a new one does not replace it", async () => {
    const f = await setup();

    const first = await f.sessionsA.queueInstruction(
      f.started.session.id,
      queued(),
    );
    const second = await f.sessionsA.queueInstruction(
      f.started.session.id,
      queued({ clientRequestId: "request-2", instruction: "Other." }),
    );

    expect(first.status).toBe("queued");
    expect(second).toEqual({ status: "full" });
    expect(
      (await f.sessionsA.getSession(f.started.session.id))?.queued,
    ).toMatchObject({ instruction: "Queued words.", costLimitCents: 100 });
  });

  // #841-D06
  it("makes one of two parallel calls queue and the other full", async () => {
    const f = await setup();

    const results = await Promise.all([
      f.sessionsA.queueInstruction(f.started.session.id, queued()),
      f.sessionsA.queueInstruction(
        f.started.session.id,
        queued({ clientRequestId: "request-2" }),
      ),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["full", "queued"]);
  });

  // #841-D07: an idle session is started, not queued
  it("is not taken by an idle session", async () => {
    const f = await setup();
    await endFirstTurn(f);

    expect(
      await f.sessionsA.queueInstruction(f.started.session.id, queued()),
    ).toEqual({ status: "idle" });
  });

  // #841-D08
  it("starts only as the queued turn: a direct start is busy while it waits, and the queued start empties the queue", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);

    expect(
      await f.sessionsA.startFollowUpTurn(
        turn(f.started.session.id),
        jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "jump"),
      ),
    ).toEqual({ status: "busy" });
    const started = await f.sessionsA.startFollowUpTurn(
      turn(f.started.session.id, { fromQueued: true }),
      jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "queued"),
    );

    expect(started.status).toBe("started");
    expect(await f.sessionsA.getSession(f.started.session.id)).toMatchObject({
      status: "running",
      queued: null,
      discarded: null,
    });
  });

  // #841-D09
  it("cannot be started as the queued turn when nothing is queued", async () => {
    const f = await setup();
    await endFirstTurn(f);

    expect(
      await f.sessionsA.startFollowUpTurn(
        turn(f.started.session.id, { fromQueued: true }),
        jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "none"),
      ),
    ).toEqual({ status: "nothing_queued" });
  });

  // #841-D10
  it("is kept as discarded with the reason, once, and queueing again or starting a turn clears the note", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);

    const discarded = await f.sessionsA.discardQueued(
      f.started.session.id,
      "request-q",
      "branch_gone",
    );
    const again = await f.sessionsA.discardQueued(
      f.started.session.id,
      "request-q",
      "branch_gone",
    );

    expect(discarded).toMatchObject({
      status: "idle",
      queued: null,
      discarded: { reason: "branch_gone", instruction: "Queued words." },
    });
    expect(again).toBeUndefined();
    await f.sessionsA.startFollowUpTurn(
      turn(f.started.session.id),
      jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "after"),
    );
    expect(
      (await f.sessionsA.getSession(f.started.session.id))?.discarded,
    ).toBeNull();
  });
});

describe("discarding the queued instruction", () => {
  // #841-D10b (review of #871, S1): a caller that read instruction A must not discard B, which was queued after A started
  it("leaves a newer instruction alone when the caller's one has started and ended, and a newer one waits", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);
    // A: read by the caller, then started by someone else.
    const startedA = await f.sessionsA.startFollowUpTurn(
      turn(f.started.session.id, { fromQueued: true }),
      jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "a-turn"),
    );
    if (startedA.status !== "started") throw new Error("A did not start");
    // B is queued behind A's turn, and A's turn ends.
    await f.sessionsA.queueInstruction(
      f.started.session.id,
      queued({ clientRequestId: "request-b", instruction: "B words." }),
    );
    await f.db
      .updateTable("jobs")
      .set({ status: "succeeded", finished_at: T })
      .where("id", "=", startedA.turn.jobId)
      .execute();
    await f.sessionsA.recordTurnResult(f.started.session.id, {
      headCommit: null,
      opencode: null,
      summary: null,
    });

    // The stale discard of A, with the reason A's caller found.
    const stale = await f.sessionsA.discardQueued(
      f.started.session.id,
      "request-q",
      "branch_gone",
    );

    expect(stale).toBeUndefined();
    expect(await f.sessionsA.getSession(f.started.session.id)).toMatchObject({
      status: "idle",
      queued: { clientRequestId: "request-b", instruction: "B words." },
      discarded: null,
    });
    // B's own caller still discards B.
    expect(
      await f.sessionsA.discardQueued(
        f.started.session.id,
        "request-b",
        "github_unavailable",
      ),
    ).toMatchObject({
      queued: null,
      discarded: { reason: "github_unavailable", instruction: "B words." },
    });
  });

  // #841-D10c
  it("discards nothing while the session runs: a queued instruction waits for the end of the turn", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());

    expect(
      await f.sessionsA.discardQueued(
        f.started.session.id,
        "request-q",
        "branch_gone",
      ),
    ).toBeUndefined();
    expect(
      (await f.sessionsA.getSession(f.started.session.id))?.queued,
    ).toMatchObject({ clientRequestId: "request-q" });
  });
});

describe("the sessions that hold an instruction", () => {
  // #841-D11
  it("are found whatever the workspace, when idle with an instruction queued, and not while the turn runs", async () => {
    const f = await setup();
    const sessionsB = createImplementerRepository(f.db, f.idB);
    const startedB = await startTask(f.db, f.idB, taskOf(f.b), f.b.repoUrl);
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await sessionsB.queueInstruction(startedB.session.id, queued());

    expect(await sessionsWithQueuedInstruction(f.db, 10, T)).toEqual([]);

    await endFirstTurn(f);
    expect(await sessionsWithQueuedInstruction(f.db, 10, T)).toEqual([
      { workspaceId: f.idA, sessionId: f.started.session.id },
    ]);
    expect(await sessionsWithQueuedInstruction(f.db, 0, T)).toEqual([]);
  });

  // #841-D11b (review of #871, S2): never tried first, then the longest ago; a session tried lately waits for the backoff
  it("are ordered by the last try, never tried first, and one tried since the cut-off is left out", async () => {
    const f = await setup();
    const second = await startTask(
      f.db,
      f.idA,
      { ...taskOf(f.a), branch: "implementer/second" },
      f.a.repoUrl,
    );
    const third = await startTask(
      f.db,
      f.idA,
      { ...taskOf(f.a), branch: "implementer/third" },
      f.a.repoUrl,
    );
    for (const session of [f.started.session, second.session, third.session])
      await f.sessionsA.queueInstruction(session.id, queued());
    await f.db
      .updateTable("implementer_sessions")
      .set({ status: "idle" })
      .execute();
    const triedAt = (id: string, at: string) =>
      f.db
        .updateTable("implementer_sessions")
        .set({ queued_attempted_at: at })
        .where("id", "=", id)
        .execute();
    await triedAt(f.started.session.id, "2026-11-05T11:00:00.000Z");
    await triedAt(second.session.id, "2026-11-05T09:00:00.000Z");

    const due = await sessionsWithQueuedInstruction(
      f.db,
      10,
      "2026-11-05T10:30:00.000Z",
    );

    expect(due.map((d) => d.sessionId)).toEqual([
      third.session.id,
      second.session.id,
    ]);
    expect(
      (
        await sessionsWithQueuedInstruction(f.db, 1, "2026-11-05T10:30:00.000Z")
      ).map((d) => d.sessionId),
    ).toEqual([third.session.id]);
  });

  // #841-D11c
  it("notes the try without touching updated_at, for the instruction asked about only, and clears it with the instruction", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);
    const before = await f.sessionsA.getSession(f.started.session.id);
    const row = () =>
      f.db
        .selectFrom("implementer_sessions")
        .select(["queued_attempted_at", "updated_at"])
        .where("id", "=", f.started.session.id)
        .executeTakeFirstOrThrow();

    await f.sessionsA.noteQueuedAttempt(f.started.session.id, "request-other");
    expect((await row()).queued_attempted_at).toBeNull();
    await f.sessionsA.noteQueuedAttempt(f.started.session.id, "request-q");

    const noted = await row();
    expect(noted.queued_attempted_at).not.toBeNull();
    expect(noted.updated_at).toBe(before?.updatedAt);
    await f.sessionsA.discardQueued(
      f.started.session.id,
      "request-q",
      "branch_gone",
    );
    expect((await row()).queued_attempted_at).toBeNull();
  });

  // #841-D11d (fix round 2, S-A)
  it("notes the first failure once and hands that time back after, for the instruction asked about only, and clears it with the instruction", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);
    const stored = () =>
      f.db
        .selectFrom("implementer_sessions")
        .select("queued_first_failed_at")
        .where("id", "=", f.started.session.id)
        .executeTakeFirstOrThrow();

    expect(
      await f.sessionsA.noteQueuedFailure(
        f.started.session.id,
        "request-other",
      ),
    ).toBeUndefined();
    expect((await stored()).queued_first_failed_at).toBeNull();
    const first = await f.sessionsA.noteQueuedFailure(
      f.started.session.id,
      "request-q",
    );
    expect(first).toBeDefined();
    expect((await stored()).queued_first_failed_at).toBe(first);
    await f.db
      .updateTable("implementer_sessions")
      .set({ queued_first_failed_at: "2026-11-04T00:00:00.000Z" })
      .where("id", "=", f.started.session.id)
      .execute();

    expect(
      await f.sessionsA.noteQueuedFailure(f.started.session.id, "request-q"),
    ).toBe("2026-11-04T00:00:00.000Z");
    await f.sessionsA.discardQueued(
      f.started.session.id,
      "request-q",
      "github_unavailable",
    );
    expect((await stored()).queued_first_failed_at).toBeNull();
    expect(
      await f.sessionsA.noteQueuedFailure(f.started.session.id, "request-q"),
    ).toBeUndefined();
  });

  // #841-D11e (fix round 2, N-A)
  it("reads a stored text that is no instruction as unreadable, and discards it with a reason that no request id is needed for", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);
    await f.db
      .updateTable("implementer_sessions")
      .set({ queued_instruction: "not json" })
      .where("id", "=", f.started.session.id)
      .execute();

    const read = await f.sessionsA.getSession(f.started.session.id);
    expect(read).toMatchObject({ queued: null, queuedUnreadable: true });

    // A readable instruction is never taken by the id-less discard; the unreadable one is.
    const dropped = await f.sessionsA.discardQueued(
      f.started.session.id,
      null,
      "instruction_unreadable",
    );
    expect(dropped).toMatchObject({
      queued: null,
      discarded: { reason: "instruction_unreadable", instruction: "" },
    });
    expect(dropped?.queuedUnreadable).toBeUndefined();
    expect(
      (
        await sessionsWithQueuedInstruction(
          f.db,
          10,
          "2026-11-06T00:00:00.000Z",
        )
      ).map((d) => d.sessionId),
    ).toEqual([]);
  });

  // #841-D11f (fix round 2, N-A)
  it("does not let the id-less discard take a readable instruction", async () => {
    const f = await setup();
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await endFirstTurn(f);

    expect(
      await f.sessionsA.discardQueued(
        f.started.session.id,
        null,
        "instruction_unreadable",
      ),
    ).toBeUndefined();
    expect(
      (await f.sessionsA.getSession(f.started.session.id))?.queued,
    ).toMatchObject({ clientRequestId: "request-q" });
  });
});

describe("the history of a session", () => {
  // #841-D12
  it("lists the turns oldest first with their job's status and stored report, and leaves another workspace's out", async () => {
    const f = await setup();
    await f.db
      .updateTable("jobs")
      .set({
        status: "succeeded",
        finished_at: T,
        result: JSON.stringify({ implementer: { summary: "Done." } }),
      })
      .where("id", "=", f.started.turn.jobId)
      .execute();
    await f.sessionsA.recordTurnResult(f.started.session.id, {
      headCommit: null,
      opencode: null,
      summary: null,
    });
    await f.sessionsA.startFollowUpTurn(
      turn(f.started.session.id, { instruction: "Second." }),
      jobOf(f.idA, f.a.repositoryId, f.a.repoUrl, "second"),
    );

    const history = await f.sessionsA.turnHistory(f.started.session.id);

    expect(history.map((entry) => entry.number)).toEqual([1, 2]);
    expect(history[0]).toMatchObject({
      jobStatus: "succeeded",
      result: { implementer: { summary: "Done." } },
    });
    expect(history[1]).toMatchObject({
      instruction: "Second.",
      jobStatus: "queued",
      result: null,
    });
    expect(
      await createImplementerRepository(f.db, f.idB).turnHistory(
        f.started.session.id,
      ),
    ).toEqual([]);
    expect((await f.sessionsA.lastTurn(f.started.session.id))?.number).toBe(2);
  });
});
