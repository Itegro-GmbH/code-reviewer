// SPDX-License-Identifier: LicenseRef-Proprietary

// The follow-up service (#841) against fakes: the cases that need a particular order of events between two writes, which a real database
// cannot be made to produce on demand. The behaviour on a real database is in `follow-up.integration.test.ts`.
import { describe, expect, it, vi } from "vitest";
import type {
  QueuedInstruction,
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import { JobQueueError } from "../jobs/errors.ts";
import { ImplementerError } from "./errors.ts";
import {
  createFollowUps,
  QUEUED_INSTRUCTION_TTL_MS,
  type FollowUpDependencies,
} from "./follow-up.ts";

const T0 = new Date("2026-11-05T10:00:00.000Z");
const TIP = "c".repeat(40);

function queued(overrides: Partial<QueuedInstruction> = {}): QueuedInstruction {
  return {
    clientRequestId: "req-a",
    instruction: "Add a test.",
    modelChoice: { entryId: "entry-1" },
    costLimitCents: 200,
    environment: null,
    profile: null,
    resultSchema: null,
    createdBy: "user-1",
    actorLogin: "alice",
    queuedAt: T0.toISOString(),
    ...overrides,
  };
}

function session(
  overrides: Partial<StoredImplementerSession> = {},
): StoredImplementerSession {
  return {
    id: "session-1",
    workspaceId: "w-1",
    repositoryId: "repo-1",
    slot: 1,
    baseBranch: "main",
    startBranch: null,
    branch: "implementer/abc123",
    headCommit: TIP,
    status: "idle",
    opencodeSessionId: null,
    opencodeVersion: null,
    summary: null,
    createdBy: "user-1",
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    queued: null,
    discarded: null,
    ...overrides,
  };
}

function lastTurn(): StoredImplementerTurn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    workspaceId: "w-1",
    number: 1,
    instruction: "First.",
    modelChoice: { entryId: "entry-1" },
    costLimitCents: 200,
    jobId: "job-1",
    createdBy: "user-1",
    createdAt: T0.toISOString(),
    environment: null,
    runnerEnvironment: null,
    profile: null,
    resultSchema: null,
    resultValue: null,
  };
}

type Fakes = {
  deps: FollowUpDependencies;
  sessions: Record<string, ReturnType<typeof vi.fn>>;
  queue: Record<string, ReturnType<typeof vi.fn>>;
  provider: { getBranch: ReturnType<typeof vi.fn> };
  clock: { at: Date };
};

function fakes(initial: StoredImplementerSession): Fakes {
  const clock = { at: T0 };
  const firstFailed: { at: string | null } = { at: null };
  const provider = {
    installationPermissions: vi.fn(() =>
      Promise.resolve({ contentsWrite: true }),
    ),
    getRepositoryFacts: vi.fn(() => Promise.resolve({})),
    getBranch: vi.fn(() => Promise.resolve({ sha: TIP })),
  };
  const sessions = {
    getSession: vi.fn(() => Promise.resolve(initial)),
    getTurnByJob: vi.fn(() => Promise.resolve(undefined)),
    lastTurn: vi.fn(() => Promise.resolve(lastTurn())),
    queueInstruction: vi.fn(),
    discardQueued: vi.fn(() => Promise.resolve(initial)),
    noteQueuedAttempt: vi.fn(() => Promise.resolve()),
    // As the repository does: the first failure writes the time, the later ones read it.
    noteQueuedFailure: vi.fn(() => {
      firstFailed.at ??= clock.at.toISOString();
      return Promise.resolve(firstFailed.at);
    }),
  };
  const queue = {
    enqueueFollowUpTurn: vi.fn(),
    findImplementerTurn: vi.fn(() => Promise.resolve(undefined)),
  };
  const deps = {
    repositories: {
      get: () =>
        Promise.resolve({
          active: true,
          integrationId: "int-1",
          externalId: "1",
          fullName: "acme/widgets",
          url: "https://github.test/acme/widgets",
        }),
    },
    integrations: {
      get: () =>
        Promise.resolve({ id: "int-1", status: "active", type: "github" }),
    },
    registry: { resolve: () => provider },
    models: { check: () => Promise.resolve(null) },
    environments: { get: () => Promise.resolve(undefined) },
    profiles: { findByName: () => Promise.resolve(undefined) },
    sessions,
    steps: { lastStep: () => Promise.resolve(undefined) },
    queue,
    operatorCostLimitCents: () => Promise.resolve(1000),
    log: () => undefined,
    now: () => clock.at,
  } as unknown as FollowUpDependencies;
  return { deps, sessions, queue, provider, clock };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  instruction: "Add a test.",
  clientRequestId: "req-a",
  ...overrides,
});

const USER = { id: "user-1", githubLogin: "alice" };

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe("the submit when the turn ends between the two writes", () => {
  // #841-U30 (review of #871, S3): enqueue says busy, the turn ends, queueing says idle: the next attempt starts the turn
  it("starts the turn on the next attempt when the enqueue said busy and the queueing then found the session idle", async () => {
    const f = fakes(session({ status: "running" }));
    f.queue.enqueueFollowUpTurn
      .mockResolvedValueOnce({ status: "busy" })
      .mockResolvedValueOnce({
        status: "created",
        job: { id: "job-2" },
        session: session({ status: "running" }),
        turn: { ...lastTurn(), number: 2 },
      });
    f.sessions.queueInstruction.mockResolvedValueOnce({ status: "idle" });

    const result = await createFollowUps(f.deps).continueSession(
      USER,
      "session-1",
      body(),
    );

    expect(result).toEqual({
      status: "started",
      sessionId: "session-1",
      runId: "job-2",
      turnNumber: 2,
      created: true,
    });
    expect(f.queue.enqueueFollowUpTurn).toHaveBeenCalledTimes(2);
    expect(f.sessions.queueInstruction).toHaveBeenCalledOnce();
  });

  // #841-U31
  it("is busy, and queues nothing, when the session keeps flipping for every attempt", async () => {
    const f = fakes(session({ status: "running" }));
    f.queue.enqueueFollowUpTurn.mockResolvedValue({ status: "busy" });
    f.sessions.queueInstruction.mockResolvedValue({ status: "idle" });

    const failure = await failureOf(
      createFollowUps(f.deps).continueSession(USER, "session-1", body()),
    );

    expect(failure).toBeInstanceOf(ImplementerError);
    expect((failure as ImplementerError).code).toBe("IMPLEMENTER_SESSION_BUSY");
  });
});

describe("the tip a follow-up is accepted at", () => {
  const branchesRead = (f: Fakes) =>
    f.provider.getBranch.mock.calls.map((call) => call[2] as string);

  // #909-T11
  it("reads the start branch, not the base branch, for a session that never pushed", async () => {
    const f = fakes(
      session({ headCommit: null, startBranch: "feature/start" }),
    );
    f.queue.enqueueFollowUpTurn.mockResolvedValue({
      status: "created",
      job: { id: "job-2" },
      session: session({ status: "running" }),
      turn: { ...lastTurn(), number: 2 },
    });

    await createFollowUps(f.deps).continueSession(USER, "session-1", body());

    expect(branchesRead(f)).toEqual(["feature/start"]);
  });

  // #909-T11
  it("reads the base branch for a session that never pushed and has no start branch", async () => {
    const f = fakes(session({ headCommit: null, startBranch: null }));
    f.queue.enqueueFollowUpTurn.mockResolvedValue({
      status: "created",
      job: { id: "job-2" },
      session: session({ status: "running" }),
      turn: { ...lastTurn(), number: 2 },
    });

    await createFollowUps(f.deps).continueSession(USER, "session-1", body());

    expect(branchesRead(f)).toEqual(["main"]);
  });
});

describe("a repeat of a request id that is queued", () => {
  const held = (extra: Partial<QueuedInstruction> = {}) =>
    session({ status: "running", queued: queued(extra) });

  // #841-U32 (review of #871, N4)
  it("is answered with the queue when the body is what was queued", async () => {
    const f = fakes(held());

    const result = await createFollowUps(f.deps).continueSession(
      USER,
      "session-1",
      body({ model: { entryId: "entry-1" }, costLimitCents: 200 }),
    );

    expect(result).toMatchObject({ status: "queued", created: false });
    expect(f.queue.enqueueFollowUpTurn).not.toHaveBeenCalled();
  });

  // #841-U33
  it.each([
    ["the text", { instruction: "Something else." }],
    ["the model", { model: { entryId: "entry-2" } }],
    ["the cost limit", { costLimitCents: 300 }],
    ["the environment", { environmentId: "env-1" }],
    ["the profile", { profile: "reviewer" }],
  ])(
    "is REQUEST_REUSED when %s differs from what was queued",
    async (_, change) => {
      const f = fakes(held());

      const failure = await failureOf(
        createFollowUps(f.deps).continueSession(
          USER,
          "session-1",
          body(change),
        ),
      );

      expect(failure).toBeInstanceOf(ImplementerError);
      expect((failure as ImplementerError).code).toBe(
        "IMPLEMENTER_REQUEST_REUSED",
      );
    },
  );
});

describe("starting the queued instruction", () => {
  function unreachable(f: Fakes) {
    f.provider.getBranch.mockRejectedValue(new Error("rate limited"));
  }

  // #841-U34 (review of #871, S1)
  it("discards the instruction it read, by its request id, and nothing newer", async () => {
    const f = fakes(session({ queued: queued({ clientRequestId: "req-a" }) }));
    f.provider.getBranch.mockResolvedValue(null);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "discarded", reason: "branch_gone" });
    expect(f.sessions.discardQueued).toHaveBeenCalledWith(
      "session-1",
      "req-a",
      "branch_gone",
    );
  });

  // #846-T141
  it("discards the instruction of a workflow step that gave up, also while a turn runs, and says so", async () => {
    const f = fakes(session({ status: "running", queued: queued() }));

    const discarded = await createFollowUps(f.deps).discardRequested(
      "session-1",
      "req-a",
    );
    f.sessions.discardQueued.mockResolvedValue(undefined);
    const gone = await createFollowUps(f.deps).discardRequested(
      "session-1",
      "req-a",
    );

    expect([discarded, gone]).toEqual([true, false]);
    expect(f.sessions.discardQueued).toHaveBeenCalledWith(
      "session-1",
      "req-a",
      "workflow_gave_up",
      { whileRunning: true },
    );
  });

  // #841-U35
  it("reports nothing when the repository found no instruction of that request id to discard", async () => {
    const f = fakes(session({ queued: queued() }));
    f.provider.getBranch.mockResolvedValue(null);
    f.sessions.discardQueued.mockResolvedValue(undefined);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "nothing" });
  });

  // #841-U36 (review of #871, S2)
  it("notes the attempt before it asks the platform", async () => {
    const f = fakes(session({ queued: queued() }));
    const order: string[] = [];
    f.sessions.noteQueuedAttempt.mockImplementation(() => {
      order.push("note");
      return Promise.resolve();
    });
    f.provider.getBranch.mockImplementation(() => {
      order.push("platform");
      return Promise.reject(new Error("down"));
    });

    await createFollowUps(f.deps).startQueued("session-1");

    expect(order).toEqual(["note", "platform"]);
    expect(f.sessions.noteQueuedAttempt).toHaveBeenCalledWith(
      "session-1",
      "req-a",
    );
  });

  // #841-U37 (review of #871, S3; fix round 2, S-A)
  it("keeps the instruction for a retry at the first failure, however long it waited behind a long turn", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    // The turn ran for 25 hours; only now is GitHub asked, and it fails once.
    f.clock.at = new Date(T0.getTime() + 25 * 60 * 60 * 1000);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "retry" });
    expect(f.sessions.noteQueuedFailure).toHaveBeenCalledWith(
      "session-1",
      "req-a",
    );
    expect(f.sessions.discardQueued).not.toHaveBeenCalled();
  });

  // #841-U37b (fix round 2, S-A)
  it("keeps the instruction for a retry until a day after the first failed start", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    f.clock.at = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
    await createFollowUps(f.deps).startQueued("session-1");
    f.clock.at = new Date(f.clock.at.getTime() + QUEUED_INSTRUCTION_TTL_MS - 1);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "retry" });
    expect(f.sessions.discardQueued).not.toHaveBeenCalled();
  });

  // #841-U38
  it("discards the instruction as github_unavailable a day after the first failed start", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    f.clock.at = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
    await createFollowUps(f.deps).startQueued("session-1");
    f.clock.at = new Date(f.clock.at.getTime() + QUEUED_INSTRUCTION_TTL_MS);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({
      status: "discarded",
      reason: "github_unavailable",
    });
    expect(f.sessions.discardQueued).toHaveBeenCalledWith(
      "session-1",
      "req-a",
      "github_unavailable",
    );
  });

  // #841-U38b (fix round 2, S-A)
  it("reports nothing when the instruction is not queued any more at the failure", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    f.sessions.noteQueuedFailure.mockResolvedValue(undefined);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "nothing" });
    expect(f.sessions.discardQueued).not.toHaveBeenCalled();
  });

  // #841-U39
  it("starts an old instruction when the platform answers again", async () => {
    const f = fakes(session({ queued: queued() }));
    f.clock.at = new Date(T0.getTime() + 2 * QUEUED_INSTRUCTION_TTL_MS);
    f.queue.enqueueFollowUpTurn.mockResolvedValue({
      status: "created",
      job: { id: "job-2" },
      session: session({ status: "running" }),
      turn: { ...lastTurn(), number: 2 },
    });

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "started", runId: "job-2" });
    expect(f.sessions.discardQueued).not.toHaveBeenCalled();
  });
});

describe("an unexpected failure while starting the queued instruction (fix round 2, S-B)", () => {
  const created = () => ({
    status: "created",
    job: { id: "job-2" },
    session: session({ status: "running" }),
    turn: { ...lastTurn(), number: 2 },
  });

  // #841-U44
  it.each([
    [
      "the queue throws",
      (f: Fakes) =>
        f.queue.enqueueFollowUpTurn.mockRejectedValue(new Error("db down")),
    ],
    [
      "the model check throws",
      (f: Fakes) => {
        (f.deps.models.check as unknown as ReturnType<typeof vi.fn>) = vi
          .fn()
          .mockRejectedValue(new Error("catalog down"));
      },
    ],
  ])(
    "keeps the instruction for a retry when %s, and discards it as start_failed a day after the first failure",
    async (_, fail) => {
      const f = fakes(session({ queued: queued() }));
      fail(f);

      const first = await createFollowUps(f.deps).startQueued("session-1");
      f.clock.at = new Date(T0.getTime() + QUEUED_INSTRUCTION_TTL_MS);
      const last = await createFollowUps(f.deps).startQueued("session-1");

      expect(first).toEqual({ status: "retry" });
      expect(last).toEqual({ status: "discarded", reason: "start_failed" });
      expect(f.sessions.discardQueued).toHaveBeenCalledWith(
        "session-1",
        "req-a",
        "start_failed",
      );
    },
  );

  // #841-U45
  it("discards at once, as request_invalid, an instruction the job queue refuses for good", async () => {
    const f = fakes(session({ queued: queued() }));
    f.queue.enqueueFollowUpTurn.mockRejectedValue(
      new JobQueueError("JOB_INPUT_INVALID", "The input is not valid."),
    );

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "discarded", reason: "request_invalid" });
    expect(f.sessions.discardQueued).toHaveBeenCalledWith(
      "session-1",
      "req-a",
      "request_invalid",
    );
    expect(f.sessions.noteQueuedFailure).not.toHaveBeenCalled();
  });

  // #841-U46
  it("still starts the instruction when the queue answers on a later try", async () => {
    const f = fakes(session({ queued: queued() }));
    f.queue.enqueueFollowUpTurn
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(created());

    const first = await createFollowUps(f.deps).startQueued("session-1");
    const second = await createFollowUps(f.deps).startQueued("session-1");

    expect(first).toEqual({ status: "retry" });
    expect(second).toEqual({ status: "started", runId: "job-2" });
  });
});

describe("a stored instruction that cannot be read (fix round 2, N-A)", () => {
  // #841-U47
  it("is discarded with a reason, without asking the platform", async () => {
    const f = fakes(session({ queuedUnreadable: true }));

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({
      status: "discarded",
      reason: "instruction_unreadable",
    });
    expect(f.sessions.discardQueued).toHaveBeenCalledWith(
      "session-1",
      null,
      "instruction_unreadable",
    );
    expect(f.sessions.noteQueuedAttempt).not.toHaveBeenCalled();
    expect(f.provider.getBranch).not.toHaveBeenCalled();
  });
});

describe("the time an instruction was queued (fix round 2, N-B)", () => {
  // #841-U48
  it("is the injected clock's", async () => {
    const f = fakes(session({ status: "running" }));
    f.queue.enqueueFollowUpTurn.mockResolvedValue({ status: "busy" });
    f.sessions.queueInstruction.mockResolvedValue({
      status: "queued",
      session: session({ status: "running" }),
    });

    await createFollowUps(f.deps).continueSession(USER, "session-1", body());

    expect(f.sessions.queueInstruction).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ queuedAt: T0.toISOString() }),
    );
  });
});

describe("the continuation of a run", () => {
  // #841-U40 (review of #871, N2)
  it.each([
    ["a NUL byte", "run\u0000x"],
    ["nothing", ""],
    ["an id that is far too long", "r".repeat(1000)],
    ["a value that is no string", 42 as unknown as string],
  ])("is not there for %s, and the database is not asked", async (_, id) => {
    const f = fakes(session());

    const found = await createFollowUps(f.deps).continuation(id);

    expect(found).toBeUndefined();
    expect(f.sessions.getTurnByJob).not.toHaveBeenCalled();
  });
});

describe("a session whose last turn ran on a runner environment (#854)", () => {
  const RUNNER = { id: "env-r", name: "Mac", labels: ["macos"] };
  const OWN_KEY = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const onRunner = () => {
    const f = fakes(session());
    f.sessions.lastTurn.mockResolvedValue({
      ...lastTurn(),
      modelChoice: OWN_KEY,
      runnerEnvironment: RUNNER,
    });
    f.queue.enqueueFollowUpTurn.mockResolvedValue({
      status: "created",
      job: { id: "job-2" },
      session: session({ status: "running" }),
      turn: { ...lastTurn(), number: 2 },
    });
    return f;
  };

  // #841-U41
  it("keeps the runner environment of the last turn when the body names none", async () => {
    const f = onRunner();

    await createFollowUps(f.deps).continueSession(USER, "session-1", body());

    expect(f.queue.enqueueFollowUpTurn).toHaveBeenCalledWith(
      expect.objectContaining({ environment: null, runnerEnvironment: RUNNER }),
    );
  });

  // #841-U42
  it("refuses a managed model while the runner environment stays", async () => {
    const f = onRunner();

    const failure = await failureOf(
      createFollowUps(f.deps).continueSession(
        USER,
        "session-1",
        body({ model: { entryId: "entry-1" } }),
      ),
    );

    expect((failure as ImplementerError).code).toBe(
      "IMPLEMENTER_RUNNER_NEEDS_OWN_KEY",
    );
    expect(f.queue.enqueueFollowUpTurn).not.toHaveBeenCalled();
  });

  // #841-U43
  it("shows the runner environment as the default of the continuation", async () => {
    const f = onRunner();
    f.sessions.getTurnByJob.mockResolvedValue({
      turn: { ...lastTurn(), modelChoice: OWN_KEY, runnerEnvironment: RUNNER },
      session: session(),
    });

    const found = await createFollowUps(f.deps).continuation("job-1");

    expect(found?.defaults.environment).toEqual({ id: "env-r", name: "Mac" });
  });
});
