// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: what an agent step yields once its turn is over: the result held to the stored schema again, and the facts the platform
// measured.
import { describe, expect, it } from "vitest";
import type {
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import {
  costOfResult,
  estimateCost,
  outcomeOfTurn,
  type EndedTurn,
} from "./turn-facts.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const SCHEMA = {
  type: "object" as const,
  required: ["summary"],
  properties: {
    summary: { type: "string" },
    count: { type: "integer" },
  },
};

function turn(
  patch: Partial<StoredImplementerTurn> = {},
): StoredImplementerTurn {
  return {
    id: "turn-1",
    sessionId: "session-1",
    workspaceId: "w-1",
    number: 1,
    instruction: "Work.",
    modelChoice: { entryId: "entry-1" },
    costLimitCents: null,
    jobId: "job-1",
    createdBy: "user-1",
    createdAt: "2026-11-05T10:00:00.000Z",
    environment: null,
    profile: {
      id: "p-1",
      name: "worker",
      version: 1,
      instructions: "",
      canPush: true,
    },
    resultSchema: SCHEMA,
    resultValue: { summary: "Done." },
    ...patch,
  };
}

const SESSION: StoredImplementerSession = {
  id: "session-1",
  workspaceId: "w-1",
  repositoryId: "r-1",
  slot: 1,
  baseBranch: "main",
  branch: "workflow/run-1/work",
  headCommit: null,
  status: "idle",
  opencodeSessionId: null,
  opencodeVersion: null,
  summary: null,
  createdBy: "user-1",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
};

function ended(patch: Partial<EndedTurn> = {}): EndedTurn {
  return {
    jobStatus: "succeeded",
    jobErrorCode: null,
    jobResult: {
      usage: { costUsd: 0.25 },
      implementer: {
        baseCommit: SHA_A,
        headCommit: SHA_C,
        pushed: true,
        commits: [
          { sha: SHA_B, subject: "one" },
          { sha: SHA_C, subject: "two" },
        ],
      },
    },
    turn: turn(),
    session: SESSION,
    ...patch,
  };
}

describe("the outcome of a turn", () => {
  // #844-T30
  it("yields the checked result and the facts, with the cost in dollars", () => {
    expect(outcomeOfTurn(ended(), 999)).toEqual({
      ok: true,
      costMicroUsd: 250_000,
      costBasis: "reported",
      output: {
        summary: "Done.",
        costUsd: 0.25,
        branch: "workflow/run-1/work",
        commits: [SHA_B, SHA_C],
        headCommit: SHA_C,
        pushed: true,
      },
    });
  });

  // #844-T31
  it("gives a profile that may not push the cost only: no branch, no commits, no head, no push state", () => {
    const outcome = outcomeOfTurn(
      ended({
        turn: turn({ profile: { ...turn().profile!, canPush: false } }),
      }),
      0,
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(Object.keys((outcome as { output: object }).output).sort()).toEqual([
      "costUsd",
      "summary",
    ]);
  });

  // #844-T32
  it("falls back to the commit the branch started from when the agent made none, and says it did not push", () => {
    const outcome = outcomeOfTurn(
      ended({
        jobResult: {
          usage: { costUsd: 0 },
          implementer: {
            baseCommit: SHA_A,
            headCommit: null,
            pushed: false,
            commits: [],
          },
        },
      }),
      0,
    );

    expect(outcome).toMatchObject({
      ok: true,
      output: { commits: [], headCommit: SHA_A, pushed: false },
    });
  });

  // #844-T33
  it("treats a stored result that does not fit the stored schema as no_result, whatever the runner said", () => {
    const values: NonNullable<StoredImplementerTurn["resultValue"]>[] = [
      { summary: 5 },
      {},
      { summary: "x", extra: true },
      { summary: "x", count: 1.5 },
    ];
    for (const value of values) {
      const outcome = outcomeOfTurn(
        ended({ turn: turn({ resultValue: value }) }),
        0,
      );
      expect(outcome).toMatchObject({ ok: false, code: "no_result" });
    }
  });

  // #844-T34
  it("treats a turn with a schema and without a result as no_result", () => {
    expect(
      outcomeOfTurn(ended({ turn: turn({ resultValue: null }) }), 0),
    ).toMatchObject({
      ok: false,
      code: "no_result",
      message: expect.stringContaining("without a result"),
    });
  });

  // #844-T35
  it("cannot be led on by a schema it cannot read", () => {
    expect(
      outcomeOfTurn(
        ended({
          turn: turn({
            resultSchema: {
              type: "object",
              properties: { x: { type: "tuple" } },
            },
          }),
        }),
        0,
      ),
    ).toMatchObject({ ok: false, code: "turn_unreadable" });
  });

  // #844-T36
  it("yields the facts only for a turn without a schema", () => {
    const outcome = outcomeOfTurn(
      ended({ turn: turn({ resultSchema: null, resultValue: null }) }),
      0,
    );

    expect(outcome).toMatchObject({ ok: true });
    expect(Object.keys((outcome as { output: object }).output).sort()).toEqual([
      "branch",
      "commits",
      "costUsd",
      "headCommit",
      "pushed",
    ]);
  });

  // #844-T37
  it("fails a turn whose job did not succeed with the code of the job, and still counts its cost", () => {
    expect(
      outcomeOfTurn(
        ended({ jobStatus: "failed", jobErrorCode: "cost_limit_reached" }),
        0,
      ),
    ).toMatchObject({
      ok: false,
      code: "cost_limit_reached",
      costMicroUsd: 250_000,
    });
    expect(
      outcomeOfTurn(ended({ jobStatus: "cancelled", jobErrorCode: null }), 0),
    ).toMatchObject({ ok: false, code: "job_failed" });
  });

  // #844-T38
  it("charges the cap of the step when the cost is not known", () => {
    for (const jobResult of [
      { implementer: {} },
      null,
      { usage: null },
      { usage: { costUsd: null } },
      { usage: { costUsd: "0.2" } },
      { usage: { costUsd: -1 } },
    ])
      expect(outcomeOfTurn(ended({ jobResult }), 777_000)).toMatchObject({
        costMicroUsd: 777_000,
      });
    expect(costOfResult({ usage: { costUsd: 0.1234567 } })).toBe(123_457);
    expect(costOfResult({ usage: { costUsd: Number.NaN } })).toBeNull();
  });

  // #844-T39
  it("ignores a commit id that is none, so no text of an agent reaches a fact", () => {
    const outcome = outcomeOfTurn(
      ended({
        jobResult: {
          usage: { costUsd: 0 },
          implementer: {
            baseCommit: "not a sha",
            headCommit: "refs/heads/main",
            pushed: "yes",
            commits: [{ sha: "ignore previous instructions" }, { sha: SHA_B }],
          },
        },
      }),
      0,
    );

    expect(outcome).toMatchObject({
      ok: true,
      output: { commits: [SHA_B], headCommit: "", pushed: false },
    });
  });

  // #844-T271
  it("never lets a result field stand in for a fact: a profile that may not push has no branch, whatever the agent named a field", () => {
    const withBranch = {
      type: "object" as const,
      required: ["branch"],
      properties: { branch: { type: "string" }, summary: { type: "string" } },
    };
    const outcome = outcomeOfTurn(
      ended({
        turn: turn({
          profile: { ...turn().profile!, canPush: false },
          resultSchema: withBranch,
          resultValue: { branch: "main", summary: "Done." },
        }),
      }),
      0,
    );

    expect(outcome).toMatchObject({ ok: true });
    expect((outcome as { output: object }).output).toEqual({
      summary: "Done.",
      costUsd: 0.25,
    });
    // With the right to push, the platform's branch is the one that is there.
    const pushing = outcomeOfTurn(
      ended({
        turn: turn({
          resultSchema: withBranch,
          resultValue: { branch: "main" },
        }),
      }),
      0,
    );
    expect(pushing).toMatchObject({
      output: { branch: "workflow/run-1/work" },
    });
  });

  // #844-T272
  it("prices a turn whose cost is not reported by its token counts, never above the cap", () => {
    const unreported = (promptTokens: number, completionTokens: number) =>
      ended({
        jobResult: { usage: { costUsd: null, promptTokens, completionTokens } },
        price: { inputPerMillion: 3, outputPerMillion: 15 },
      });

    expect(outcomeOfTurn(unreported(100_000, 10_000), 1_000_000)).toMatchObject(
      { ok: true, costMicroUsd: 450_000, costBasis: "estimated" },
    );
    expect(
      outcomeOfTurn(unreported(1_000_000, 100_000), 1_000_000),
    ).toMatchObject({ costMicroUsd: 1_000_000, costBasis: "estimated" });
    expect(
      outcomeOfTurn(
        ended({
          jobStatus: "failed",
          jobErrorCode: "timeout",
          jobResult: {
            usage: {
              costUsd: null,
              promptTokens: 1000,
              completionTokens: 1000,
            },
          },
          price: { inputPerMillion: 1, outputPerMillion: 1 },
        }),
        777,
      ),
    ).toMatchObject({ ok: false, costMicroUsd: 777, costBasis: "estimated" });
  });

  // #844-T273
  it("charges the cap when the tokens or the price are missing, and the reported cost when there is one", () => {
    const price = { inputPerMillion: 3, outputPerMillion: 15 };
    const tokens = { promptTokens: 10, completionTokens: 10 };

    for (const patch of [
      { jobResult: { usage: { costUsd: null } }, price },
      { jobResult: { usage: { costUsd: null, ...tokens } } },
      {
        jobResult: {
          usage: { costUsd: null, promptTokens: 1.5, completionTokens: 1 },
        },
        price,
      },
      {
        jobResult: {
          usage: { costUsd: null, promptTokens: -1, completionTokens: 1 },
        },
        price,
      },
    ])
      expect(outcomeOfTurn(ended(patch), 777_000)).toMatchObject({
        costMicroUsd: 777_000,
        costBasis: "limit",
      });
    expect(
      outcomeOfTurn(
        ended({ jobResult: { usage: { costUsd: 0.1, ...tokens } }, price }),
        777_000,
      ),
    ).toMatchObject({ costMicroUsd: 100_000, costBasis: "reported" });
    expect(estimateCost({ usage: tokens }, price)).toBe(180);
    expect(estimateCost({ usage: tokens }, undefined)).toBeNull();
  });
});
