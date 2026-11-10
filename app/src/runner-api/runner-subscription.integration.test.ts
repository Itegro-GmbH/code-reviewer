// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim of a turn on the harness claude-code (#856): only a customer's runner that announces the harness as ready is handed one;
// the job it gets has no model, no key, no price and no catalog entry (the login is the device's and never known to the app), it
// carries the budget and the model name Claude Code reads, and every other claim, hosted or not, leaves it queued. Against a real
// Postgres with the harness of the runner API.
import {
  CLAUDE_CODE_ACCESS,
  OPENCODE_ACCESS,
} from "../test-support/runner-access.ts";
import { describe, expect, it } from "vitest";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import type {
  SplitClaimResponse,
  WorkerSubscriptionDetailsResponse,
} from "./contract.ts";

const NOW_FEATURES = [
  "cost_limit",
  "operator_cost_limit",
  "dynamic_cost_policy",
  "implementer_profile",
  "implementer_environment",
  "implementer_result",
  "implementer_resume",
  "implementer_start_branch",
];
const CLAUDE_MODEL = { provider: "claude-code", model: "claude-sonnet-5-5" };
const RUNNER_ENV = { id: "env-runner", name: "My box", labels: ["box"] };
const PROFILE = {
  id: "p-1",
  name: "claude",
  version: 3,
  instructions: "Be brief.",
  canPush: true,
  harness: "claude-code" as const,
};

const BOTH = { harnesses: [...CLAUDE_CODE_ACCESS], capabilities: [] };
const OPENCODE_ONLY = { harnesses: [...OPENCODE_ACCESS], capabilities: [] };
// Claude Code is announced only while it is ready: a device whose login or layer is gone leaves it out (#973).
const NOT_READY = OPENCODE_ONLY;

function claimOf(credential: string) {
  return { token: credential, engines: ["implementer"] };
}

/**
 * #974: the claim of a customer's runner answers with the credential of the job and nothing else; the Worker that holds it fetches the turn
 * with the features it reads (`features`), and it is there that the git token is made and a Worker that does not read what the turn carries is refused.
 */
async function fetchedTurn(
  h: Awaited<ReturnType<typeof start>>,
  credential: string,
  features = NOW_FEATURES,
) {
  const claim = await h.claim(claimOf(credential));
  expect(claim.status).toBe(200);
  const { job } = (await claim.json()) as SplitClaimResponse;
  const response = await h.worker.details(
    job.id,
    job.credential,
    features.join(","),
  );
  return { claim: job, response };
}

async function turnInput(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as WorkerSubscriptionDetailsResponse).job
    .input;
}

async function start() {
  // No model key at all: a turn on a device's login must not need one.
  return startRunnerApiHarness({ implementer: true, llmKey: null });
}

describe("the claim of a turn on the harness claude-code", () => {
  // #856-T50
  it("hands a runner that announces it ready the turn with a subscription and no model, key or price", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
      costLimitCents: 80,
    });

    const { claim, response } = await fetchedTurn(h, runner.credential);

    // The claim holds nothing of the turn but its credential and what the dispatcher needs to start: no git token, no input.
    expect(claim.id).toBe(turn.job.id);
    expect(claim).not.toHaveProperty("input");
    expect(claim.access).toEqual({
      harness: "claude-code",
      auth: "subscription",
      model: "claude-sonnet-5-5",
    });
    // The git token is made by the Worker's fetch, not by the claim.
    expect(h.issuedJobTokens()).toHaveLength(1);
    const input = (await turnInput(response)) as unknown as {
      llm?: unknown;
      implementer: Record<string, unknown>;
    };
    expect(input.llm).toBeUndefined();
    expect(input.implementer.cost).toBeUndefined();
    expect(input.implementer.modelEntry).toBeUndefined();
    expect(input.implementer.subscription).toEqual({
      model: "claude-sonnet-5-5",
      maxBudgetUsd: "0.80",
    });
    expect(input.implementer.profile).toEqual({
      name: "claude",
      version: 3,
      instructions: "Be brief.",
      canPush: true,
      harness: "claude-code",
    });
    expect(input).toMatchObject({ reviewKind: "implementer" });
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "running" });
  });

  // #856-T50
  it("holds the budget to the operator's maximum when the profile names none or a higher one", async () => {
    const h = await start();
    for (const costLimitCents of [null, 250]) {
      const runner = await h.registerRunner({
        labels: ["box"],
        manifest: BOTH,
      });
      await h.enqueueTurn({
        modelChoice: CLAUDE_MODEL,
        runnerEnvironment: RUNNER_ENV,
        profile: PROFILE,
        costLimitCents,
      });

      const { response } = await fetchedTurn(h, runner.credential);

      const subscription = (
        (await turnInput(response)) as unknown as {
          implementer: { subscription: { maxBudgetUsd: string } };
        }
      ).implementer.subscription;
      // The harness's operator maximum is 100 cents.
      expect(subscription.maxBudgetUsd).toBe("1.00");
    }
  });

  // #856-T51
  it("hands a runner without a ready claude-code nothing, and the turn stays queued for one that has it", async () => {
    const h = await start();
    const plain = await h.registerRunner({
      labels: ["box"],
      manifest: OPENCODE_ONLY,
    });
    const notReady = await h.registerRunner({
      labels: ["box"],
      manifest: NOT_READY,
    });
    const capable = await h.registerRunner({
      labels: ["box"],
      manifest: BOTH,
    });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    expect((await h.claim(claimOf(plain.credential))).status).toBe(204);
    expect((await h.claim(claimOf(notReady.credential))).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect((await h.claim(claimOf(capable.credential))).status).toBe(200);
  });

  // #856-T51
  it("never hands the Dispatcher or the shared token a turn on this harness", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    expect(
      (
        await h.claim({
          engines: ["implementer", "opencode", "pr-agent"],
          features: NOW_FEATURES,
          jobId: turn.job.id,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await h.claim({
          engines: ["implementer", "opencode", "pr-agent"],
          features: NOW_FEATURES,
        })
      ).status,
    ).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });

  // #856-T52
  it("ends the turn, free, when the runner does not read profiles, instead of running it without the instructions", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const { response } = await fetchedTurn(
      h,
      runner.credential,
      NOW_FEATURES.filter((name) => name !== "implementer_profile"),
    );

    // The Worker's fetch is refused (the job is over for it) before any git token is made.
    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
  });

  // #909-T13
  it("ends the turn, free, when the runner does not read the start branch, instead of starting from the base branch", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
      startBranch: "feature/start",
    });

    const { response } = await fetchedTurn(
      h,
      runner.credential,
      NOW_FEATURES.filter((name) => name !== "implementer_start_branch"),
    );

    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
  });

  // #909-T13
  it("hands a runner that reads the start branch the turn with it", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
      startBranch: "feature/start",
    });

    const { response } = await fetchedTurn(h, runner.credential);

    expect(await turnInput(response)).toMatchObject({
      implementer: { startBranch: "feature/start" },
    });
  });

  // #856-T52
  it("ends the turn when its model is not a name for Claude Code", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: "claude-sonnet-5-5" },
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const response = await h.claim(claimOf(runner.credential));

    expect(response.status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
  });
});
