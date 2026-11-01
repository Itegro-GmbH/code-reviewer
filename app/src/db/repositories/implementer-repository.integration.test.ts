// SPDX-License-Identifier: LicenseRef-Proprietary

// Sessions and turns of the Implementer (#751) against a real Postgres: what the repository keeps true (slots, one session
// per branch, one turn per job, nothing across workspaces) and what the database itself refuses when something bypasses it.
import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { ImplementerStoreError } from "../implementer-errors.ts";
import { createProjectsRepository } from "./projects-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import { createJobsRepository } from "./jobs-repository.ts";
import { createImplementerRepository } from "./implementer-repository.ts";
import {
  enqueueTurnJob,
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../../test-support/implementer.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import {
  FOREIGN_KEY_VIOLATION,
  UNIQUE_VIOLATION,
  errorCode,
} from "../errors.ts";

const CHECK_VIOLATION = "23514";
const T = "2026-10-30T10:00:00.000Z";

async function setup(options: { poolMax?: number } = {}) {
  const { db, url } = await createTestDatabase(options);
  const idA = await defaultWorkspaceId(db);
  const idB = await addWorkspace(db, "other");
  const a = await seedImplementerRepository(db, idA, "a");
  const b = await seedImplementerRepository(db, idB, "b");
  return { db, url, idA, idB, a, b };
}

/** A second active repository of the first workspace's installation (the seed helper makes one per workspace). */
async function addSecondRepository(db: Kysely<Database>, workspaceId: string) {
  const integration = await db
    .selectFrom("integrations")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const repositories = createRepositoriesRepository(db, workspaceId);
  const url = "https://github.test/acme/second";
  await repositories.reconcile(integration.id, [
    ...(await repositories.list()).map((repository) => ({
      integrationId: integration.id,
      externalId: repository.externalId,
      fullName: repository.fullName,
      url: repository.url,
    })),
    {
      integrationId: integration.id,
      externalId: "repo-second",
      fullName: "acme/second",
      url,
    },
  ]);
  const repository = (await repositories.list()).find(
    (candidate) => candidate.fullName === "acme/second",
  );
  if (repository === undefined) throw new Error("seeding failed");
  await createProjectsRepository(db, workspaceId).activate(repository.id);
  return { repositoryId: repository.id, repoUrl: url };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("starting a task", () => {
  // #751-T02
  it("creates the session and its first turn with the next slot, the job in between", async () => {
    const { db, idA, a } = await setup();

    const first = await startTask(db, idA, taskOf(a), a.repoUrl);
    const second = await startTask(
      db,
      idA,
      taskOf(a, { branch: "implementer/second" }),
      a.repoUrl,
    );

    expect(first.session).toMatchObject({
      workspaceId: idA,
      repositoryId: a.repositoryId,
      slot: 1,
      baseBranch: "main",
      branch: "implementer/abc123",
      headCommit: null,
      status: "running",
      opencodeSessionId: null,
      opencodeVersion: null,
      summary: null,
      createdBy: a.userId,
    });
    expect(second.session.slot).toBe(2);
    expect(first.turn).toMatchObject({
      sessionId: first.session.id,
      workspaceId: idA,
      number: 1,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: a.userId,
    });
    const job = await createJobsRepository(db, idA).get(first.turn.jobId);
    expect(job).toMatchObject({ prNumber: -1, repositoryId: a.repositoryId });
  });

  // #751-T02
  it("hands the callback the transaction, the slot and the session id, and stores the job id it returns", async () => {
    const { db, idA, a } = await setup();
    let seen: {
      slot: number;
      sessionId: string;
      inTransaction: boolean;
    } | null = null;

    const { session, turn } = await createImplementerRepository(
      db,
      idA,
    ).createSessionWithTurn(taskOf(a), async (trx, context) => {
      seen = { ...context, inTransaction: trx.isTransaction };
      const created = await createJobsRepository(trx, idA).enqueue({
        repositoryId: a.repositoryId,
        prNumber: -context.slot,
        prUrl: `${a.repoUrl}/tree/x`,
        headSha: "a".repeat(40),
        reviewKind: "diff",
        command: "review",
        args: "",
        triggerKind: "manual",
        actorLogin: "octocat",
        deliveryId: null,
        commentId: null,
        runAfter: null,
      });
      if (created.status !== "created") throw new Error("no job");
      return created.job.id;
    });

    expect(seen).toEqual({
      slot: 1,
      sessionId: session.id,
      inTransaction: true,
    });
    expect(turn.sessionId).toBe(session.id);
  });

  // #751-T02
  it("uses the transaction it is given instead of opening another one", async () => {
    const { db, idA, a } = await setup();

    await db.transaction().execute(async (trx) => {
      await startTask(trx, idA, taskOf(a), a.repoUrl);
      const inside = await createImplementerRepository(
        trx,
        idA,
      ).listForRepository(a.repositoryId);
      expect(inside).toHaveLength(1);
    });

    expect(
      await createImplementerRepository(db, idA).listForRepository(
        a.repositoryId,
      ),
    ).toHaveLength(1);
  });

  // #751-T02
  it("writes nothing when the job cannot be made", async () => {
    const { db, idA, a } = await setup();

    const error = await rejection(
      createImplementerRepository(db, idA).createSessionWithTurn(
        taskOf(a),
        async () => {
          throw new Error("the queue refused");
        },
      ),
    );

    expect(error).toMatchObject({ message: "the queue refused" });
    const { rows } = await sql<{
      sessions: number;
      turns: number;
    }>`select (select count(*) from implementer_sessions)::int as sessions,
              (select count(*) from implementer_turns)::int as turns`.execute(
      db,
    );
    expect(rows).toEqual([{ sessions: 0, turns: 0 }]);
  });

  // #751-T02
  it("does not start a task in a repository of another workspace, and never runs the callback", async () => {
    const { db, idA, a, b } = await setup();
    let called = false;

    const error = await rejection(
      createImplementerRepository(db, idA).createSessionWithTurn(
        taskOf(a, { repositoryId: b.repositoryId }),
        async () => {
          called = true;
          return "x";
        },
      ),
    );

    expect(error).toBeInstanceOf(ImplementerStoreError);
    expect((error as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_REPOSITORY_NOT_FOUND",
    );
    expect(called).toBe(false);
  });

  // #751-T05
  it("refuses a job that is not a job of this workspace with a typed error and writes nothing", async () => {
    const { db, idA, idB, a, b } = await setup();
    const foreign = await startTask(db, idB, taskOf(b), b.repoUrl);

    const error = await rejection(
      createImplementerRepository(db, idA).createSessionWithTurn(
        taskOf(a),
        async () => foreign.turn.jobId,
      ),
    );

    expect((error as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_JOB_NOT_FOUND",
    );
    expect(
      await createImplementerRepository(db, idA).listForRepository(
        a.repositoryId,
      ),
    ).toEqual([]);
  });

  // #751-T05
  it("refuses a job of another repository of the workspace, or one whose pull request number is not -slot, and writes nothing", async () => {
    const { db, idA, a } = await setup();
    const second = await addSecondRepository(db, idA);
    const refused: Array<
      [string, (trx: Kysely<Database>, slot: number) => Promise<string>]
    > = [
      [
        "another repository",
        (trx, slot) =>
          enqueueTurnJob(trx, idA, {
            repositoryId: second.repositoryId,
            slot,
            branch: "implementer/abc123",
            repoUrl: second.repoUrl,
          }),
      ],
      [
        "a positive pull request number",
        (trx, slot) =>
          enqueueTurnJob(trx, idA, {
            repositoryId: a.repositoryId,
            slot: -slot,
            branch: "implementer/abc123",
            repoUrl: a.repoUrl,
          }),
      ],
      [
        "the slot of another session",
        (trx, slot) =>
          enqueueTurnJob(trx, idA, {
            repositoryId: a.repositoryId,
            slot: slot + 1,
            branch: "implementer/abc123",
            repoUrl: a.repoUrl,
          }),
      ],
    ];

    const codes: Record<string, unknown> = {};
    for (const [label, makeJob] of refused) {
      const error = await rejection(
        createImplementerRepository(db, idA).createSessionWithTurn(
          taskOf(a),
          (trx, { slot }) => makeJob(trx, slot),
        ),
      );
      codes[label] = (error as ImplementerStoreError).code;
    }
    expect(codes).toEqual({
      "another repository": "IMPLEMENTER_JOB_MISMATCH",
      "a positive pull request number": "IMPLEMENTER_JOB_MISMATCH",
      "the slot of another session": "IMPLEMENTER_JOB_MISMATCH",
    });

    expect(
      await createImplementerRepository(db, idA).listForRepository(
        a.repositoryId,
      ),
    ).toEqual([]);
    const { rows } = await sql<{
      jobs: number;
    }>`select count(*)::int as jobs from jobs`.execute(db);
    expect(rows).toEqual([{ jobs: 0 }]);
  });
});

describe("the branch of a session", () => {
  // #751-T03
  it("is taken once per repository: the second session gets IMPLEMENTER_BRANCH_TAKEN and the job callback never runs", async () => {
    const { db, idA, a } = await setup();
    await startTask(db, idA, taskOf(a), a.repoUrl);
    let called = false;

    const error = await rejection(
      createImplementerRepository(db, idA).createSessionWithTurn(
        taskOf(a),
        async () => {
          called = true;
          return "x";
        },
      ),
    );

    expect(error).toBeInstanceOf(ImplementerStoreError);
    expect((error as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_BRANCH_TAKEN",
    );
    expect(called).toBe(false);
    expect(
      await createImplementerRepository(db, idA).listForRepository(
        a.repositoryId,
      ),
    ).toHaveLength(1);
  });

  // #751-T03
  it("is a different branch in another repository of the same workspace (the name is taken per repository)", async () => {
    const { db, idA, a } = await setup();
    const { createRepositoriesRepository } =
      await import("./repositories-repository.ts");
    const repositories = createRepositoriesRepository(db, idA);
    const [first] = await repositories.list();
    if (first === undefined) throw new Error("seeding failed");
    await repositories.reconcile(first.integrationId, [
      {
        integrationId: first.integrationId,
        externalId: "repo-a",
        fullName: "acme/a",
        url: first.url,
      },
      {
        integrationId: first.integrationId,
        externalId: "repo-a2",
        fullName: "acme/a2",
        url: "https://github.test/acme/a2",
      },
    ]);
    const second = (await repositories.list()).find(
      (repository) => repository.externalId === "repo-a2",
    );
    if (second === undefined) throw new Error("seeding failed");

    await startTask(db, idA, taskOf(a), a.repoUrl);
    const other = await startTask(
      db,
      idA,
      taskOf(a, { repositoryId: second.id }),
      second.url,
    );

    expect(other.session.slot).toBe(1);
  });

  // #751-T03
  it("is refused by the database itself when something bypasses the repository", async () => {
    const { db, idA, a } = await setup();
    const { session } = await startTask(db, idA, taskOf(a), a.repoUrl);

    const error = await rejection(
      db
        .insertInto("implementer_sessions")
        .values({
          id: "bypass",
          workspace_id: idA,
          repository_id: a.repositoryId,
          slot: 99,
          base_branch: "main",
          branch: session.branch,
          status: "running",
          created_by: a.userId,
          created_at: T,
          updated_at: T,
        })
        .execute(),
    );

    expect(errorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  // #751-T03
  it("goes to exactly one of two tasks that race for it on separate connections", async () => {
    const { connectPostgres } =
      await import("../../test-support/test-database.ts");
    const { db, url, idA, a } = await setup();
    const other = connectPostgres(url).db;

    const results = await Promise.allSettled([
      startTask(db, idA, taskOf(a), a.repoUrl),
      startTask(other, idA, taskOf(a), a.repoUrl),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_BRANCH_TAKEN",
    );
    expect(
      await createImplementerRepository(db, idA).listForRepository(
        a.repositoryId,
      ),
    ).toHaveLength(1);
  });
});

describe("the slot of a session", () => {
  // #751-T04
  it("is distinct for every task started at the same moment on one repository: none lost, none duplicated", async () => {
    const { db, idA, a } = await setup({ poolMax: 10 });
    const count = 8;

    const started = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        startTask(
          db,
          idA,
          taskOf(a, { branch: `implementer/b${index}` }),
          a.repoUrl,
        ),
      ),
    );

    expect(
      started.map((task) => task.session.slot).sort((x, y) => x - y),
    ).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    const stored = await createImplementerRepository(db, idA).listForRepository(
      a.repositoryId,
    );
    expect(stored).toHaveLength(count);
    expect(new Set(stored.map((entry) => entry.session.slot)).size).toBe(count);
    // The job of each task carries its own slot as the negative pull request number.
    const jobs = createJobsRepository(db, idA);
    for (const task of started)
      expect((await jobs.get(task.turn.jobId))?.prNumber).toBe(
        -task.session.slot,
      );
  });

  // #751-T04
  it("is counted per repository: a second workspace starts at 1 again", async () => {
    const { db, idA, idB, a, b } = await setup();
    await startTask(db, idA, taskOf(a), a.repoUrl);

    const other = await startTask(db, idB, taskOf(b), b.repoUrl);

    expect(other.session.slot).toBe(1);
  });

  // #751-T04
  it("is unique per repository in the database", async () => {
    const { db, idA, a } = await setup();
    const { session } = await startTask(db, idA, taskOf(a), a.repoUrl);

    const error = await rejection(
      db
        .insertInto("implementer_sessions")
        .values({
          id: "bypass",
          workspace_id: idA,
          repository_id: a.repositoryId,
          slot: session.slot,
          base_branch: "main",
          branch: "another",
          status: "running",
          created_by: a.userId,
          created_at: T,
          updated_at: T,
        })
        .execute(),
    );

    expect(errorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe("a turn", () => {
  // #751-T05
  it("has a job of its own: a second turn on the same job is refused by the database", async () => {
    const { db, idA, a } = await setup();
    const { session, turn } = await startTask(db, idA, taskOf(a), a.repoUrl);

    const error = await rejection(
      db
        .insertInto("implementer_turns")
        .values({
          id: "bypass",
          session_id: session.id,
          workspace_id: idA,
          number: 2,
          instruction: "again",
          model_choice: '{"entryId":"e"}',
          cost_limit_cents: null,
          job_id: turn.jobId,
          created_by: a.userId,
          created_at: T,
        })
        .execute(),
    );

    expect(errorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  // #751-T05
  it("has a number of its own in its session", async () => {
    const { db, idA, a } = await setup();
    const first = await startTask(db, idA, taskOf(a), a.repoUrl);
    const freshJob = await enqueueTurnJob(db, idA, {
      repositoryId: a.repositoryId,
      slot: 50,
      branch: "fresh",
      repoUrl: a.repoUrl,
    });

    const error = await rejection(
      db
        .insertInto("implementer_turns")
        .values({
          id: "bypass",
          session_id: first.session.id,
          workspace_id: idA,
          number: first.turn.number,
          instruction: "again",
          model_choice: '{"entryId":"e"}',
          cost_limit_cents: null,
          job_id: freshJob,
          created_by: a.userId,
          created_at: T,
        })
        .execute(),
    );

    expect(errorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  // #751-T05
  it("cannot reference a job of another workspace: the database refuses the link", async () => {
    const { db, idA, idB, a, b } = await setup();
    const own = await startTask(db, idA, taskOf(a), a.repoUrl);
    const foreignJob = await enqueueTurnJob(db, idB, {
      repositoryId: b.repositoryId,
      slot: 50,
      branch: "elsewhere",
      repoUrl: b.repoUrl,
    });

    const error = await rejection(
      db
        .insertInto("implementer_turns")
        .values({
          id: "bypass",
          session_id: own.session.id,
          workspace_id: idA,
          number: 2,
          instruction: "again",
          model_choice: '{"entryId":"e"}',
          cost_limit_cents: null,
          job_id: foreignJob,
          created_by: a.userId,
          created_at: T,
        })
        .execute(),
    );

    expect(errorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  // #751-T05
  it("cannot belong to a session of another workspace, and a session cannot belong to a repository of another one", async () => {
    const { db, idA, idB, a, b } = await setup();
    const foreign = await startTask(db, idB, taskOf(b), b.repoUrl);
    const freshJob = await enqueueTurnJob(db, idA, {
      repositoryId: a.repositoryId,
      slot: 50,
      branch: "fresh",
      repoUrl: a.repoUrl,
    });

    const turnInForeignSession = await rejection(
      db
        .insertInto("implementer_turns")
        .values({
          id: "bypass",
          session_id: foreign.session.id,
          workspace_id: idA,
          number: 2,
          instruction: "again",
          model_choice: '{"entryId":"e"}',
          cost_limit_cents: null,
          job_id: freshJob,
          created_by: a.userId,
          created_at: T,
        })
        .execute(),
    );
    const sessionInForeignRepository = await rejection(
      db
        .insertInto("implementer_sessions")
        .values({
          id: "bypass-2",
          workspace_id: idA,
          repository_id: b.repositoryId,
          slot: 5,
          base_branch: "main",
          branch: "x",
          status: "running",
          created_by: a.userId,
          created_at: T,
          updated_at: T,
        })
        .execute(),
    );

    expect(errorCode(turnInForeignSession)).toBe(FOREIGN_KEY_VIOLATION);
    expect(errorCode(sessionInForeignRepository)).toBe(FOREIGN_KEY_VIOLATION);
  });

  // #751-T05
  it("keeps the checks the repository relies on: status, slot, number and cost limit", async () => {
    const { db, idA, a } = await setup();
    const { session, turn } = await startTask(db, idA, taskOf(a), a.repoUrl);
    const sessionRow = {
      workspace_id: idA,
      repository_id: a.repositoryId,
      base_branch: "main",
      created_by: a.userId,
      created_at: T,
      updated_at: T,
    };

    const badStatus = await rejection(
      db
        .insertInto("implementer_sessions")
        .values({
          ...sessionRow,
          id: "s1",
          slot: 7,
          branch: "s1",
          status: "closed" as "idle",
        })
        .execute(),
    );
    const badSlot = await rejection(
      db
        .insertInto("implementer_sessions")
        .values({
          ...sessionRow,
          id: "s2",
          slot: 0,
          branch: "s2",
          status: "running",
        })
        .execute(),
    );
    const badNumber = await rejection(
      db
        .updateTable("implementer_turns")
        .set({ number: 0 })
        .where("id", "=", turn.id)
        .execute(),
    );
    const badLimit = await rejection(
      db
        .updateTable("implementer_turns")
        .set({ cost_limit_cents: 0 })
        .where("id", "=", turn.id)
        .execute(),
    );

    expect(errorCode(badStatus)).toBe(CHECK_VIOLATION);
    expect(errorCode(badSlot)).toBe(CHECK_VIOLATION);
    expect(errorCode(badNumber)).toBe(CHECK_VIOLATION);
    expect(errorCode(badLimit)).toBe(CHECK_VIOLATION);
    expect(session.status).toBe("running");
  });

  // #751-T06
  it("keeps the model choice as text and reads an own-key choice back", async () => {
    const { db, idA, a } = await setup();
    const { turn } = await startTask(
      db,
      idA,
      taskOf(a, {
        modelChoice: { provider: "anthropic", model: "sonnet" },
        costLimitCents: 250,
      }),
      a.repoUrl,
    );

    const { rows } = await sql<{
      model_choice: string;
    }>`select model_choice from implementer_turns where id = ${turn.id}`.execute(
      db,
    );
    expect(rows[0]?.model_choice).toBe(
      '{"provider":"anthropic","model":"sonnet"}',
    );
    const read = await createImplementerRepository(db, idA).getTurnByJob(
      turn.jobId,
    );
    expect(read?.turn).toMatchObject({
      modelChoice: { provider: "anthropic", model: "sonnet" },
      costLimitCents: 250,
    });
  });

  // #751-T06
  it("gives a typed error, not a crash, when the stored model choice is unreadable", async () => {
    const { db, idA, a } = await setup();
    const { turn } = await startTask(db, idA, taskOf(a), a.repoUrl);
    await db
      .updateTable("implementer_turns")
      .set({ model_choice: "{broken" })
      .where("id", "=", turn.id)
      .execute();

    const error = await rejection(
      createImplementerRepository(db, idA).getTurnByJob(turn.jobId),
    );

    expect(error).toBeInstanceOf(ImplementerStoreError);
    expect((error as ImplementerStoreError).code).toBe(
      "IMPLEMENTER_MODEL_CHOICE_UNREADABLE",
    );
  });
});

describe("reading", () => {
  // #751-T02
  it("finds a session, and a turn by its job, only inside the workspace", async () => {
    const { db, idA, idB, a } = await setup();
    const { session, turn } = await startTask(db, idA, taskOf(a), a.repoUrl);

    const own = createImplementerRepository(db, idA);
    const foreign = createImplementerRepository(db, idB);

    expect(await own.getSession(session.id)).toEqual(session);
    expect(await own.getTurnByJob(turn.jobId)).toEqual({ turn, session });
    expect(await foreign.getSession(session.id)).toBeUndefined();
    expect(await foreign.getTurnByJob(turn.jobId)).toBeUndefined();
    expect(await foreign.listForRepository(a.repositoryId)).toEqual([]);
    expect(await own.getSession("nobody")).toBeUndefined();
    expect(await own.getTurnByJob("nobody")).toBeUndefined();
  });

  // #751-T02
  it("lists the sessions of a repository newest first, each with its turns", async () => {
    const { db, idA, a } = await setup();
    const first = await startTask(db, idA, taskOf(a), a.repoUrl);
    const second = await startTask(
      db,
      idA,
      taskOf(a, { branch: "implementer/second" }),
      a.repoUrl,
    );

    const listed = await createImplementerRepository(db, idA).listForRepository(
      a.repositoryId,
    );

    expect(listed).toEqual([
      { session: second.session, turns: [second.turn] },
      { session: first.session, turns: [first.turn] },
    ]);
  });
});

describe("recording what a turn produced", () => {
  // #751-T02
  it("stores the head commit, the OpenCode ids and the summary and sets the session idle", async () => {
    const { db, idA, a } = await setup();
    const { session } = await startTask(db, idA, taskOf(a), a.repoUrl);
    const repository = createImplementerRepository(
      db,
      idA,
      () => new Date("2026-10-30T11:00:00.000Z"),
    );

    const updated = await repository.recordTurnResult(session.id, {
      headCommit: "c".repeat(40),
      opencode: { sessionId: "ses_1", version: "1.19.0" },
      summary: "Added the endpoint.",
    });

    expect(updated).toMatchObject({
      id: session.id,
      headCommit: "c".repeat(40),
      opencodeSessionId: "ses_1",
      opencodeVersion: "1.19.0",
      summary: "Added the endpoint.",
      status: "idle",
      updatedAt: "2026-10-30T11:00:00.000Z",
    });
    expect(await repository.getSession(session.id)).toEqual(updated);
  });

  // #751-T02
  it("leaves what the turn did not produce as it was (a failed turn with no new commit keeps the earlier head)", async () => {
    const { db, idA, a } = await setup();
    const { session } = await startTask(db, idA, taskOf(a), a.repoUrl);
    const repository = createImplementerRepository(db, idA);
    await repository.recordTurnResult(session.id, {
      headCommit: "c".repeat(40),
      opencode: { sessionId: "ses_1", version: "1.19.0" },
      summary: "First.",
    });

    const updated = await repository.recordTurnResult(session.id, {
      headCommit: null,
      opencode: null,
      summary: null,
    });

    expect(updated).toMatchObject({
      headCommit: "c".repeat(40),
      opencodeSessionId: "ses_1",
      opencodeVersion: "1.19.0",
      summary: "First.",
      status: "idle",
    });
  });

  // #751-T02
  it("changes nothing for a session of another workspace or one that does not exist", async () => {
    const { db, idA, idB, a } = await setup();
    const { session } = await startTask(db, idA, taskOf(a), a.repoUrl);

    const foreign = await createImplementerRepository(db, idB).recordTurnResult(
      session.id,
      {
        headCommit: "d".repeat(40),
        opencode: null,
        summary: "hijacked",
      },
    );
    const missing = await createImplementerRepository(db, idA).recordTurnResult(
      "nobody",
      {
        headCommit: null,
        opencode: null,
        summary: null,
      },
    );

    expect(foreign).toBeUndefined();
    expect(missing).toBeUndefined();
    expect(
      await createImplementerRepository(db, idA).getSession(session.id),
    ).toEqual(session);
  });
});
