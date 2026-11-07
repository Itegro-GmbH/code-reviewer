// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { RunnerResult } from "./contract.ts";
import { withAgentResultOrNoResult } from "./implementer-result-guard.ts";

const sha = (c: string) => c.repeat(40);
const result = (
  agentResult?: unknown,
  overrides: Partial<RunnerResult> = {},
): RunnerResult => ({
  ok: true,
  durationMs: 1,
  commentUrl: null,
  errorCode: null,
  errorMessage: null,
  logTail: "",
  logTruncated: false,
  usage: null,
  implementer: {
    baseCommit: sha("a"),
    headCommit: sha("b"),
    pushed: true,
    commits: [{ sha: sha("b"), subject: "Add it" }],
    filesChanged: [],
    summary: "Done.",
    opencode: { sessionId: "ses_1", version: "1.19.0" },
    ...(agentResult === undefined
      ? {}
      : { agentResult: agentResult as { [key: string]: never } }),
  },
  ...overrides,
});

describe("a turn that ended with a question (#920)", () => {
  const asking = (): RunnerResult => {
    const given = result();
    return {
      ...given,
      implementer: {
        ...(given.implementer as NonNullable<RunnerResult["implementer"]>),
        agentAsk: { question: "Retry which failures?" },
      },
    };
  };

  // #920-T10
  it("is a success without a result: the turn of a schema that asks is not a no_result, and the report is untouched", async () => {
    const asked = vi.fn(() => Promise.resolve(true));
    const given = asking();

    expect(await withAgentResultOrNoResult(given, asked)).toBe(given);
    expect(asked).not.toHaveBeenCalled();
  });

  // #920-T10
  it("does not excuse a result that is over its bounds: the result goes and the question stays", async () => {
    const given = result({ big: "x".repeat(300_000) });
    const withBoth: RunnerResult = {
      ...given,
      implementer: {
        ...(given.implementer as NonNullable<RunnerResult["implementer"]>),
        agentAsk: { question: "q" },
      },
    };

    const made = await withAgentResultOrNoResult(withBoth, () =>
      Promise.resolve(true),
    );

    expect(made.implementer).not.toHaveProperty("agentResult");
    expect(made.implementer).toHaveProperty("agentAsk");
    expect(made).toMatchObject({ ok: true });
  });
});

describe("the result of the agent at the completion of a turn (#843)", () => {
  // #843-T131
  it("leaves a result within the bounds alone and does not ask for the schema", async () => {
    const asked = vi.fn(() => Promise.resolve(true));
    const given = result({ summary: "ok" });

    expect(await withAgentResultOrNoResult(given, asked)).toBe(given);
    expect(asked).not.toHaveBeenCalled();
  });

  // #843-T131
  it("makes a success without a result of a turn with a schema a no_result and keeps the report", async () => {
    const given = result();

    const made = await withAgentResultOrNoResult(given, () =>
      Promise.resolve(true),
    );

    expect(made).toMatchObject({
      ok: false,
      errorCode: "no_result",
      implementer: given.implementer,
    });
  });

  // #843-T131
  it("leaves a success of a turn without a schema, a failure and a job without a block as they are", async () => {
    const none = () => Promise.resolve(false);
    const some = () => Promise.resolve(true);
    const failed = result(undefined, {
      ok: false,
      errorCode: "time_limit_reached",
    });
    const plain = { ...result(), implementer: undefined };

    expect(await withAgentResultOrNoResult(result(), none)).toEqual(result());
    expect(await withAgentResultOrNoResult(failed, some)).toBe(failed);
    expect(await withAgentResultOrNoResult(plain, some)).toBe(plain);
  });

  // #843-T132
  it("drops a result over the bounds, and records no_result when the turn had a schema, keeping any other code", async () => {
    const big = { text: "x".repeat(256 * 1024) };
    const failed = result(big, { ok: false, errorCode: "cost_limit_reached" });

    const asSuccess = await withAgentResultOrNoResult(result(big), () =>
      Promise.resolve(true),
    );
    const asFailure = await withAgentResultOrNoResult(failed, () =>
      Promise.resolve(true),
    );

    expect(asSuccess.errorCode).toBe("no_result");
    expect(asSuccess.implementer).not.toHaveProperty("agentResult");
    expect(asFailure.errorCode).toBe("cost_limit_reached");
    expect(asFailure.implementer).not.toHaveProperty("agentResult");
    expect(asFailure.implementer?.commits).toHaveLength(1);
  });
});
