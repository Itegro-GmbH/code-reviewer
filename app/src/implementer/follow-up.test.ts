// SPDX-License-Identifier: LicenseRef-Proprietary

// The follow-up service (#841) against fakes: the cases that need a particular order of events between two writes, which a real database
// cannot be made to produce on demand. The behaviour on a real database is in `follow-up.integration.test.ts`.
import { describe, expect, it, vi } from "vitest";
import type {
  QueuedInstruction,
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
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

  // #841-U37 (review of #871, S3)
  it("keeps the instruction for a retry while the platform is unreachable and the instruction is younger than a day", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    f.clock.at = new Date(T0.getTime() + QUEUED_INSTRUCTION_TTL_MS - 1);

    const outcome = await createFollowUps(f.deps).startQueued("session-1");

    expect(outcome).toEqual({ status: "retry" });
    expect(f.sessions.discardQueued).not.toHaveBeenCalled();
  });

  // #841-U38
  it("discards the instruction as github_unavailable once it has waited a day", async () => {
    const f = fakes(session({ queued: queued() }));
    unreachable(f);
    f.clock.at = new Date(T0.getTime() + QUEUED_INSTRUCTION_TTL_MS);

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
