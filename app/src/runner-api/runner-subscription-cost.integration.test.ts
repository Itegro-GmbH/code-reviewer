// SPDX-License-Identifier: LicenseRef-Proprietary

// Who may say a job ran on a subscription (#856): the basis is read from our own records, never from the report. A runner or a hosted
// Worker that names `subscription` for a job that is not a turn on the harness claude-code of a customer's runner is booked as it
// would have been without the word (an unknown cost, visible to the alert and the counts of #361, #385); a real claude-code turn on a
// customer's runner is a subscription. Against a real Postgres with the harness of the runner API.
import {
  CLAUDE_CODE_ACCESS,
  OPENCODE_ACCESS,
} from "../test-support/runner-access.ts";
import { describe, expect, it } from "vitest";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createUsageFeedRepository } from "../db/repositories/usage-feed-repository.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import { sha } from "../test-support/jobs.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { ImplementerResult, RunnerResult } from "./contract.ts";

const IMPLEMENTER = ["implementer"] as const;
const WHOLE = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2027-01-01T00:00:00.000Z",
};
const CLAUDE_MODEL = { provider: "claude-code", model: "claude-sonnet-5-5" };
const RUNNER_ENV = { id: "env-runner", name: "My box", labels: ["box"] };
const PROFILE = {
  id: "p-1",
  name: "claude",
  version: 3,
  instructions: "",
  canPush: true,
};
const BOTH = { harnesses: [...CLAUDE_CODE_ACCESS], capabilities: [] };
const BLOCK: ImplementerResult = {
  baseCommit: sha("a"),
  headCommit: sha("b"),
  pushed: true,
  commits: [{ sha: sha("b"), subject: "Add a health endpoint" }],
  filesChanged: [{ path: "src/health.ts", status: "added" }],
  summary: "Added a health endpoint.",
  opencode: { sessionId: "ses_1", version: "1.19.0" },
};

/** What a runner (or anybody holding a claim) reports to get a job booked as one without a cost to know. */
const CLAIMS_SUBSCRIPTION = {
  model: "claude-sonnet-5-5",
  promptTokens: 100,
  completionTokens: 10,
  totalTokens: 110,
  aiCalls: 1,
  fallbackUsed: false,
  costUsd: null,
  stoppedEarly: null,
  costBasis: "subscription",
  estimatedCostUsd: 0.42,
} satisfies RunnerResult["usage"];

async function start() {
  const h = await startRunnerApiHarness({ implementer: true });
  await addUser(h.db, "user-1");
  const records = createUsageRecordsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  );
  const feed = createUsageFeedRepository(h.db);
  const unknown = async () =>
    (await feed.unknownCostCounts({ ...WHOLE, limit: 100 })).counts;
  return { h, records, unknown };
}

describe("who may say that a job ran on a subscription", () => {
  // #856-T75
  it("books a claude-code turn on a customer's runner as a subscription: no unknown cost", async () => {
    const { h, records, unknown } = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: { ...PROFILE, harness: "claude-code" },
    });
    const claimed = await h.queue.claimNext(
      customerRunnerId(runner.runnerId),
      IMPLEMENTER,
      {
        customerRunner: {
          workspaceId: h.workspaceId,
          labels: ["box"],
          access: CLAUDE_CODE_ACCESS,
        },
      },
    );
    expect(claimed?.job.id).toBe(turn.job.id);

    const answer = await h.complete(turn.job.id, claimed?.leaseToken ?? "", {
      implementer: BLOCK,
      usage: CLAIMS_SUBSCRIPTION,
    });

    expect(answer.status).toBe(200);
    expect(await records.get(turn.job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      costBasis: "subscription",
    });
    expect(await unknown()).toEqual([]);
    // The summary of the workspace does not count it as unknown either, and it adds nothing to a cost.
    const [group] = await records.summarize(WHOLE);
    expect(group).toMatchObject({
      settledCount: 1,
      knownCostMicroUsd: 0,
      unknownCostCount: 0,
    });
  });

  // #856-T75
  it("does not believe the word of an OpenCode turn on a customer's runner", async () => {
    const { h, records, unknown } = await start();
    const runner = await h.registerRunner({ labels: ["box"] });
    const turn = await h.enqueueTurn({
      // A runner works with the workspace's own key: a model of the catalog is the platform's and no runner announces it.
      modelChoice: { provider: "anthropic", model: "claude-sonnet-5-5" },
      runnerEnvironment: RUNNER_ENV,
      profile: { ...PROFILE, harness: "opencode" },
    });
    const claimed = await h.queue.claimNext(
      customerRunnerId(runner.runnerId),
      IMPLEMENTER,
      {
        customerRunner: {
          workspaceId: h.workspaceId,
          labels: ["box"],
          access: OPENCODE_ACCESS,
        },
      },
    );
    expect(claimed?.job.id).toBe(turn.job.id);

    await h.complete(turn.job.id, claimed?.leaseToken ?? "", {
      implementer: BLOCK,
      usage: CLAIMS_SUBSCRIPTION,
    });

    expect(await records.get(turn.job.id)).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      costBasis: null,
    });
    expect(await unknown()).toEqual([
      { workspaceId: h.workspaceId, keyMode: "own", unknownCostCount: 1 },
    ]);
    // What is stored for the run page does not carry the word either.
    const stored = (await h.queue.get(turn.job.id))?.result as {
      usage: Record<string, unknown>;
    };
    expect(stored.usage).not.toHaveProperty("costBasis");
    expect(stored.usage).not.toHaveProperty("estimatedCostUsd");
  });

  // #856-T75
  it("does not believe the word of a managed OpenCode turn that a hosted Worker ran", async () => {
    const { h, records, unknown } = await start();
    const turn = await h.enqueueTurn({ modelChoice: { entryId: "entry-1" } });
    const claimed = await h.queue.claimNext("runner-a", IMPLEMENTER);
    expect(claimed?.job.id).toBe(turn.job.id);

    await h.complete(turn.job.id, claimed?.leaseToken ?? "", {
      implementer: BLOCK,
      usage: CLAIMS_SUBSCRIPTION,
    });

    expect(await records.get(turn.job.id)).toMatchObject({
      costMicroUsd: null,
      costBasis: null,
    });
    expect((await unknown())[0]).toMatchObject({ unknownCostCount: 1 });
  });

  // #856-T75
  it.each([["diff"], ["dynamic"]] as const)(
    "does not believe the word of a %s review",
    async (reviewKind) => {
      const { h, records, unknown } = await start();
      const job = await h.enqueueNew({ reviewKind });
      const claimed = await h.queue.claimNext("runner-a", [
        "pr-agent",
        "opencode",
      ]);
      expect(claimed?.job.id).toBe(job.id);

      await h.complete(job.id, claimed?.leaseToken ?? "", {
        usage: CLAIMS_SUBSCRIPTION,
      });

      expect(await records.get(job.id)).toMatchObject({
        costMicroUsd: null,
        costBasis: null,
      });
      expect((await unknown())[0]).toMatchObject({ unknownCostCount: 1 });
    },
  );
});
