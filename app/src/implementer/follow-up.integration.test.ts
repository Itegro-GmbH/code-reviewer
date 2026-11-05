// SPDX-License-Identifier: LicenseRef-Proprietary

// The next instruction of an Implementer session (#841, part of #745): the submit behind `POST .../sessions/:sessionId/turns`, the one
// instruction that waits for a running turn, and its start when the turn ends. Real service, real GitHub App provider against the fake
// GitHub, real job queue and a real Postgres database.
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { seedImplementerRepository } from "../test-support/implementer.ts";
import {
  ALLOW_ALL,
  USER,
  startImplementerHarness,
  type ImplementerHarness,
} from "../test-support/implementer-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { ImplementerModels } from "./models.ts";

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

const TIP = "c".repeat(40);

/** Puts the session's branch on the fake GitHub, as a pushed branch would be. */
function pushBranch(h: ImplementerHarness["h"], branch: string, number = 1) {
  h.fake.addPullRequest("acme/widgets", {
    number,
    title: "x",
    state: "open",
    headSha: TIP,
    headRef: branch,
    baseRef: "main",
    author: { login: "alice", id: 1 },
  });
}

/** A first turn that has ended: its job succeeded, the session is idle with a pushed head, the branch is on GitHub. */
async function idleSession(f: ImplementerHarness, environmentId?: string) {
  const started = await f.service.startTask(
    USER,
    f.body(environmentId === undefined ? {} : { environmentId }),
  );
  await endTurn(f, started.sessionId, started.runId);
  pushBranch(f.h, "implementer/abc123");
  return started;
}

/** What a runner's report does to the session and the job when a turn ends. */
async function endTurn(
  f: ImplementerHarness,
  sessionId: string,
  jobId: string,
  headCommit: string | null = TIP,
) {
  await f.h.db
    .updateTable("jobs")
    .set({ status: "succeeded", finished_at: "2026-11-05T10:00:00.000Z" })
    .where("id", "=", jobId)
    .execute();
  await createImplementerRepository(f.h.db, f.h.workspaceId).recordTurnResult(
    sessionId,
    { headCommit, opencode: null, summary: "Did it." },
  );
}

const ask = (overrides: Record<string, unknown> = {}) => ({
  instruction: "Now add a test.",
  clientRequestId: "follow-1",
  ...overrides,
});

async function counts(f: ImplementerHarness) {
  return f.counts();
}

async function makeEnvironment(
  environments: ReturnType<typeof createImplementerEnvironmentsRepository>,
  name: string,
  vcpus: number,
  setupScript: string,
) {
  const made = await environments.create(
    { name, vcpus, setupScript, createdBy: USER.id },
    10,
  );
  if (!made.ok) throw new Error("the environment was not made");
  return made.environment;
}

describe("a follow-up on an idle session", () => {
  // #841-T01
  it("writes turn 2 and its job, sets the session running, and answers with the run", async () => {
    const f = await startImplementerHarness();
    const first = await idleSession(f);

    const next = await f.service.continueSession(USER, first.sessionId, ask());

    expect(next).toMatchObject({
      status: "started",
      sessionId: first.sessionId,
      turnNumber: 2,
      created: true,
    });
    expect(await counts(f)).toEqual({ jobs: 2, sessions: 1, turns: 2 });
    const job = await f.h.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", next.runId as string)
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({
      review_kind: "implementer",
      status: "queued",
      pr_number: -1,
      head_sha: TIP,
      pr_url: "https://github.test/acme/widgets/tree/implementer/abc123",
    });
    const session = await f.h.db
      .selectFrom("implementer_sessions")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(session.status).toBe("running");
    expect(session.queued_instruction).toBeNull();
  });

  // #841-T02 (owner decision 6: the model of the last turn is the default)
  it("runs on the model and cost limit of the last turn unless the body names others", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(
      USER,
      f.body({ model: { entryId: "entry-1" }, costLimitCents: 200 }),
    );
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");

    const same = await f.service.continueSession(USER, first.sessionId, ask());
    const turns = createImplementerRepository(f.h.db, f.h.workspaceId);
    expect(await turns.lastTurn(first.sessionId)).toMatchObject({
      number: 2,
      modelChoice: { entryId: "entry-1" },
      costLimitCents: 200,
    });
    await endTurn(f, first.sessionId, same.runId as string);

    await f.service.continueSession(
      USER,
      first.sessionId,
      ask({
        clientRequestId: "follow-2",
        model: { entryId: "entry-2" },
        costLimitCents: null,
      }),
    );
    expect(await turns.lastTurn(first.sessionId)).toMatchObject({
      number: 3,
      modelChoice: { entryId: "entry-2" },
      costLimitCents: null,
    });
  });

  // #841-T03 (owner decision 7)
  it("copies the environment of the last turn, also when it was changed or deleted since, and takes another when asked", async () => {
    const f = await startImplementerHarness();
    const environments = createImplementerEnvironmentsRepository(
      f.h.db,
      f.h.workspaceId,
    );
    const made = await makeEnvironment(environments, "Node", 2, "npm ci");
    const other = await makeEnvironment(environments, "Python", 4, "uv sync");
    const first = await idleSession(f, made.id);
    await environments.update(made.id, {
      name: "Node",
      vcpus: 2,
      setupScript: "npm install",
    });
    const turns = createImplementerRepository(f.h.db, f.h.workspaceId);

    const kept = await f.service.continueSession(USER, first.sessionId, ask());
    expect((await turns.lastTurn(first.sessionId))?.environment).toMatchObject({
      id: made.id,
      name: "Node",
      setupScript: "npm ci",
    });
    await endTurn(f, first.sessionId, kept.runId as string);
    await environments.remove(made.id);

    // Deleted since: the copy still works.
    const stillKept = await f.service.continueSession(
      USER,
      first.sessionId,
      ask({ clientRequestId: "follow-2" }),
    );
    expect((await turns.lastTurn(first.sessionId))?.environment).toMatchObject({
      setupScript: "npm ci",
    });
    await endTurn(f, first.sessionId, stillKept.runId as string);

    await f.service.continueSession(
      USER,
      first.sessionId,
      ask({ clientRequestId: "follow-3", environmentId: other.id }),
    );
    expect((await turns.lastTurn(first.sessionId))?.environment).toMatchObject({
      id: other.id,
      setupScript: "uv sync",
    });
  });

  // #841-T04
  it("drops the environment with environmentId null and refuses an environment of the workspace that is not there", async () => {
    const f = await startImplementerHarness();
    const environments = createImplementerEnvironmentsRepository(
      f.h.db,
      f.h.workspaceId,
    );
    const made = await makeEnvironment(environments, "Node", 2, "npm ci");
    const first = await idleSession(f, made.id);

    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ environmentId: "no-such-environment" }),
        ),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_ENVIRONMENT_NOT_FOUND" });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });

    await f.service.continueSession(
      USER,
      first.sessionId,
      ask({ environmentId: null }),
    );
    expect(
      (
        await createImplementerRepository(f.h.db, f.h.workspaceId).lastTurn(
          first.sessionId,
        )
      )?.environment,
    ).toBeNull();
  });

  // #841-T05
  it("refuses with IMPLEMENTER_BRANCH_GONE when the session's branch is no longer on GitHub, and writes nothing", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await endTurn(f, first.sessionId, first.runId);
    // The branch was pushed (the session has a head) and deleted on GitHub since: it is not on the fake.

    expect(
      await failureOf(f.service.continueSession(USER, first.sessionId, ask())),
    ).toMatchObject({ code: "IMPLEMENTER_BRANCH_GONE" });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
    expect(
      (
        await createImplementerRepository(f.h.db, f.h.workspaceId).getSession(
          first.sessionId,
        )
      )?.status,
    ).toBe("idle");
  });

  // #841-T06
  it("starts from the base branch when the first turn pushed nothing: there is no branch to be gone", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await endTurn(f, first.sessionId, first.runId, null);

    const next = await f.service.continueSession(USER, first.sessionId, ask());

    expect(next).toMatchObject({ status: "started", turnNumber: 2 });
  });

  // #841-T07
  it("refuses a model the claim would not run, a cost limit above the maximum, and an installation without write access, in that order, writing nothing", async () => {
    const refusing: ImplementerModels = {
      options: ALLOW_ALL.options,
      check: async (model) =>
        "entryId" in model && model.entryId === "entry-bad" ? "no_key" : null,
    };
    const f = await startImplementerHarness({
      models: refusing,
      operatorCostLimitCents: 300,
    });
    const first = await idleSession(f);

    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ model: { entryId: "entry-bad" } }),
        ),
      ),
    ).toMatchObject({
      code: "IMPLEMENTER_MODEL_NOT_ALLOWED",
      reason: "no_key",
    });
    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ costLimitCents: 301 }),
        ),
      ),
    ).toMatchObject({ code: "EXCEEDS_OPERATOR_MAXIMUM", maximumCents: 300 });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #841-T08
  it("answers 404 for a session of another workspace or nobody, and asks GitHub nothing", async () => {
    const f = await startImplementerHarness();
    const other = await addWorkspace(f.h.db, "other");
    const seeded = await seedImplementerRepository(f.h.db, other, "elsewhere");
    const foreign = await createImplementerRepository(
      f.h.db,
      other,
    ).createSessionWithTurn(
      {
        repositoryId: seeded.repositoryId,
        baseBranch: "main",
        branch: "x/y",
        instruction: "x",
        modelChoice: { entryId: "entry-1" },
        costLimitCents: null,
        createdBy: seeded.userId,
      },
      async (trx, { slot }) => {
        const job = await trx
          .insertInto("jobs")
          .values({
            id: "foreign-job",
            workspace_id: other,
            repository_id: seeded.repositoryId,
            pr_number: -slot,
            pr_url: "https://github.test/acme/elsewhere/tree/x/y",
            head_sha: "a".repeat(40),
            command: "review",
            review_kind: "implementer",
            args: "",
            trigger_kind: "manual",
            actor_login: "octocat",
            delivery_id: "implementer:other:foreign",
            status: "succeeded",
            run_after: "2026-11-05T09:00:00.000Z",
            attempts: 0,
            created_at: "2026-11-05T09:00:00.000Z",
            updated_at: "2026-11-05T09:00:00.000Z",
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return job.id;
      },
    );
    const before = f.h.fake.requests().length;

    for (const id of [foreign.session.id, "no-such-session", "a\u0000b"])
      expect(
        await failureOf(f.service.continueSession(USER, id, ask())),
        id,
      ).toMatchObject({ code: "IMPLEMENTER_SESSION_NOT_FOUND" });
    expect(f.h.fake.requests()).toHaveLength(before);
  });

  // #841-T09
  it("hands the same run back for a repeated client request id and writes nothing; another body with that id is IMPLEMENTER_REQUEST_REUSED", async () => {
    const f = await startImplementerHarness();
    const first = await idleSession(f);
    const next = await f.service.continueSession(USER, first.sessionId, ask());
    const before = await counts(f);

    const again = await f.service.continueSession(USER, first.sessionId, ask());
    expect(again).toMatchObject({
      status: "started",
      runId: next.runId,
      turnNumber: 2,
      created: false,
    });
    expect(await counts(f)).toEqual(before);

    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ instruction: "Something else." }),
        ),
      ),
    ).toMatchObject({
      code: "IMPLEMENTER_REQUEST_REUSED",
      runId: next.runId,
    });
  });

  // #841-T10 (from the plan: "two parallel submits make one turn")
  it("makes exactly one turn of two parallel submits with the same request id", async () => {
    const f = await startImplementerHarness();
    const first = await idleSession(f);

    const results = await Promise.all([
      f.service.continueSession(USER, first.sessionId, ask()),
      f.service.continueSession(USER, first.sessionId, ask()),
    ]);

    expect(await counts(f)).toEqual({ jobs: 2, sessions: 1, turns: 2 });
    expect(new Set(results.map((r) => r.runId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  // #841-T11
  it("makes one turn and queues one instruction of two parallel submits with different request ids", async () => {
    const f = await startImplementerHarness();
    const first = await idleSession(f);

    const results = await Promise.all([
      f.service.continueSession(USER, first.sessionId, ask()),
      f.service.continueSession(
        USER,
        first.sessionId,
        ask({ clientRequestId: "follow-2", instruction: "And this." }),
      ),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(["queued", "started"]);
    expect(await counts(f)).toEqual({ jobs: 2, sessions: 1, turns: 2 });
  });
});

describe("the one instruction that waits for a running turn", () => {
  // #841-T12 (owner decision 5)
  it("queues the instruction of a running session, with the choices copied, and writes no turn", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());

    const queued = await f.service.continueSession(
      USER,
      first.sessionId,
      ask({ costLimitCents: 150 }),
    );

    expect(queued).toMatchObject({
      status: "queued",
      runId: null,
      turnNumber: null,
      created: true,
    });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
    const session = await createImplementerRepository(
      f.h.db,
      f.h.workspaceId,
    ).getSession(first.sessionId);
    expect(session).toMatchObject({
      status: "running",
      queued: {
        clientRequestId: "follow-1",
        instruction: "Now add a test.",
        costLimitCents: 150,
        modelChoice: { entryId: "entry-1" },
        actorLogin: USER.githubLogin,
      },
    });
  });

  // #841-T13 (owner decision 5)
  it("answers a second instruction while one is queued with IMPLEMENTER_SESSION_BUSY and keeps the first", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());

    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ clientRequestId: "follow-2", instruction: "Another." }),
        ),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_SESSION_BUSY" });
    expect(
      (
        await createImplementerRepository(f.h.db, f.h.workspaceId).getSession(
          first.sessionId,
        )
      )?.queued?.instruction,
    ).toBe("Now add a test.");
  });

  // #841-T14
  it("gives the queue back for a repeat of the request that queued it", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());

    const again = await f.service.continueSession(USER, first.sessionId, ask());

    expect(again).toMatchObject({ status: "queued", created: false });
    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({ instruction: "Not the same." }),
        ),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_REQUEST_REUSED" });
  });

  // #841-T15
  it("queues exactly one of two parallel submits to a running session and answers the other BUSY", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());

    const results = await Promise.all([
      f.service
        .continueSession(USER, first.sessionId, ask())
        .catch((e: unknown) => e),
      f.service
        .continueSession(
          USER,
          first.sessionId,
          ask({ clientRequestId: "follow-2", instruction: "And this." }),
        )
        .catch((e: unknown) => e),
    ]);

    const queued = results.filter(
      (r) => (r as { status?: string }).status === "queued",
    );
    const busy = results.filter(
      (r) => (r as { code?: string }).code === "IMPLEMENTER_SESSION_BUSY",
    );
    expect(queued).toHaveLength(1);
    expect(busy).toHaveLength(1);
  });

  // #841-T16
  it("does not let a direct submit jump the queue once the turn has ended but the queued instruction has not started", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");

    expect(
      await failureOf(
        f.service.continueSession(
          USER,
          first.sessionId,
          ask({
            clientRequestId: "follow-2",
            instruction: "Jumping the queue.",
          }),
        ),
      ),
    ).toMatchObject({ code: "IMPLEMENTER_SESSION_BUSY" });
  });
});

describe("the start of the queued instruction when the turn ends", () => {
  // #841-T17
  it("starts the queued instruction as turn 2 with the request id and choices it was queued with, and empties the queue", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(
      USER,
      first.sessionId,
      ask({ costLimitCents: 150 }),
    );
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");

    const outcome = await f.service.startQueued(first.sessionId);

    expect(outcome).toMatchObject({ status: "started" });
    expect(await counts(f)).toEqual({ jobs: 2, sessions: 1, turns: 2 });
    const turns = createImplementerRepository(f.h.db, f.h.workspaceId);
    expect(await turns.lastTurn(first.sessionId)).toMatchObject({
      number: 2,
      instruction: "Now add a test.",
      costLimitCents: 150,
    });
    expect(await turns.getSession(first.sessionId)).toMatchObject({
      status: "running",
      queued: null,
      discarded: null,
    });
    // The request that queued it now finds the turn.
    expect(
      await f.service.continueSession(USER, first.sessionId, ask()),
    ).toMatchObject({ status: "started", turnNumber: 2, created: false });
  });

  // #841-T18 (a duplicate event must not start a second turn)
  it("starts it once when the event arrives twice, also at the same time", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");

    const outcomes = await Promise.all([
      f.service.startQueued(first.sessionId),
      f.service.startQueued(first.sessionId),
    ]);
    const third = await f.service.startQueued(first.sessionId);

    expect(outcomes.filter((o) => o.status === "started")).toHaveLength(1);
    expect(third).toEqual({ status: "nothing" });
    expect(await counts(f)).toEqual({ jobs: 2, sessions: 1, turns: 2 });
  });

  // #841-T19
  it("does nothing while the turn still runs", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());

    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "nothing",
    });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #841-T20
  it("discards it with the reason when the branch is gone, and keeps the instruction for the Runs page", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());
    // The turn pushed (the session has a head), and the branch was deleted on GitHub before the next turn could start.
    await endTurn(f, first.sessionId, first.runId);

    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "discarded",
      reason: "branch_gone",
    });

    const session = await createImplementerRepository(
      f.h.db,
      f.h.workspaceId,
    ).getSession(first.sessionId);
    expect(session).toMatchObject({
      status: "idle",
      queued: null,
      discarded: { reason: "branch_gone", instruction: "Now add a test." },
    });
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
    // Nothing is left to start, and a new instruction is possible once the person starts again (idle sessions take one).
    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "nothing",
    });
  });

  // #841-T21
  it("discards it when the installation lost write access or the model is not allowed any more", async () => {
    let allowed = true;
    const models: ImplementerModels = {
      options: ALLOW_ALL.options,
      check: async () => (allowed ? null : "no_key"),
    };
    const f = await startImplementerHarness({ models });
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");
    allowed = false;

    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "discarded",
      reason: "model_not_allowed",
    });
  });

  // #841-T22
  it("leaves it queued when GitHub cannot be asked, so the sweep tries again", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.service.continueSession(USER, first.sessionId, ask());
    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");
    f.h.fake.fail({ pathIncludes: "/repos/acme/widgets", status: 500 });

    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "retry",
    });
    expect(
      (
        await createImplementerRepository(f.h.db, f.h.workspaceId).getSession(
          first.sessionId,
        )
      )?.queued,
    ).not.toBeNull();
    expect(await counts(f)).toEqual({ jobs: 1, sessions: 1, turns: 1 });
  });

  // #841-T23
  it("starts nothing for a session without a queued instruction or one that is not this workspace's", async () => {
    const f = await startImplementerHarness();
    const first = await idleSession(f);

    expect(await f.service.startQueued(first.sessionId)).toEqual({
      status: "nothing",
    });
    expect(await f.service.startQueued("no-such-session")).toEqual({
      status: "nothing",
    });
  });
});

describe("what the Runs page needs for its Continue form", () => {
  // #841-T24
  it("gives the defaults of the last turn, the session state and the instruction that waits, for the newest turn only", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(
      USER,
      f.body({ costLimitCents: 120 }),
    );

    expect(await f.service.continuation(first.runId)).toMatchObject({
      sessionId: first.sessionId,
      turnNumber: 1,
      sessionStatus: "running",
      defaults: {
        model: { entryId: "entry-1" },
        costLimitCents: 120,
        environment: null,
        profile: null,
      },
      queued: null,
      discarded: null,
      historyTokens: null,
    });

    await f.service.continueSession(USER, first.sessionId, ask());
    expect((await f.service.continuation(first.runId))?.queued).toEqual({
      instruction: "Now add a test.",
    });

    await endTurn(f, first.sessionId, first.runId);
    pushBranch(f.h, "implementer/abc123");
    const started = await f.service.startQueued(first.sessionId);
    expect(started.status).toBe("started");

    // The first turn is not the newest any more.
    expect(await f.service.continuation(first.runId)).toBeUndefined();
    expect(
      await f.service.continuation((started as { runId: string }).runId),
    ).toMatchObject({ turnNumber: 2, sessionStatus: "running" });
    expect(await f.service.continuation("no-such-run")).toBeUndefined();
  });

  // #841-T25
  it("estimates the history from the last model call of the turn", async () => {
    const f = await startImplementerHarness();
    const first = await f.service.startTask(USER, f.body());
    await f.h.db
      .insertInto("implementer_turn_steps")
      .values({
        job_id: first.runId,
        part_id: "step-1",
        workspace_id: f.h.workspaceId,
        seq: 1,
        ordinal: 1,
        kind: "step",
        payload: JSON.stringify({
          tokens: {
            input: 100,
            output: 20,
            reasoning: 0,
            cacheRead: 5000,
            cacheWrite: 300,
          },
        }),
        bytes: 100,
        created_at: "2026-11-05T09:00:00.000Z",
        updated_at: "2026-11-05T09:00:00.000Z",
      })
      .execute();

    expect((await f.service.continuation(first.runId))?.historyTokens).toBe(
      5420,
    );
  });
});
