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
      "branch_gone",
    );
    const again = await f.sessionsA.discardQueued(
      f.started.session.id,
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

describe("the sessions that hold an instruction", () => {
  // #841-D11
  it("are found whatever the workspace, when idle with an instruction queued, and not while the turn runs", async () => {
    const f = await setup();
    const sessionsB = createImplementerRepository(f.db, f.idB);
    const startedB = await startTask(f.db, f.idB, taskOf(f.b), f.b.repoUrl);
    await f.sessionsA.queueInstruction(f.started.session.id, queued());
    await sessionsB.queueInstruction(startedB.session.id, queued());

    expect(await sessionsWithQueuedInstruction(f.db, 10)).toEqual([]);

    await endFirstTurn(f);
    expect(await sessionsWithQueuedInstruction(f.db, 10)).toEqual([
      { workspaceId: f.idA, sessionId: f.started.session.id },
    ]);
    expect(await sessionsWithQueuedInstruction(f.db, 0)).toEqual([]);
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
