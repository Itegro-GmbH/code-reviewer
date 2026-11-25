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
import {
  cloneFromTheFake,
  otherName,
  secondInstallation,
  sessionRepo,
  WRITE,
} from "../test-support/multi-repo-claim.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import type { NetworkRule } from "../network-rule/network.ts";
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

  // #1126-T40
  it("hands a Worker that names implementer_subscription_setup the script and the network rule of the step, as a closed environment", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: {
        ...RUNNER_ENV,
        setupScript: "npm ci\n",
        network: {
          mode: "list",
          hosts: ["fonts.googleapis.com", "lateinorum.de"],
        },
      },
      profile: PROFILE,
    });

    const { response } = await fetchedTurn(h, runner.credential, [
      ...NOW_FEATURES,
      "implementer_subscription_setup",
    ]);

    const input = (await turnInput(response)) as unknown as {
      implementer: Record<string, unknown>;
    };
    expect(input.implementer.environment).toEqual({
      name: "My box",
      setupScript: "npm ci\n",
      network: {
        mode: "list",
        hosts: ["fonts.googleapis.com", "lateinorum.de"],
      },
    });
  });

  // #1126-T41
  it("ends the turn, free, when the Worker does not name the feature, before a token exists: it would run without the script", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: { ...RUNNER_ENV, setupScript: "npm ci\n" },
      profile: PROFILE,
    });

    const { response } = await fetchedTurn(h, runner.credential);

    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
  });

  // #1126-T54
  it.each<[NetworkRule, string]>([
    [{ mode: "open", hosts: [] }, "open network"],
    [
      { mode: "list", hosts: ["registry.npmjs.org", "*.github.io"] },
      "wildcard",
    ],
    [{ mode: "list", hosts: ["*.co.uk"] }, "public suffix"],
  ])(
    "ends the turn, free, before a token exists, for a rule the runner would refuse (%j, %s)",
    async (network) => {
      const h = await start();
      const runner = await h.registerRunner({
        labels: ["box"],
        manifest: BOTH,
      });
      const turn = await h.enqueueTurn({
        modelChoice: CLAUDE_MODEL,
        runnerEnvironment: { ...RUNNER_ENV, setupScript: "npm ci\n", network },
        profile: PROFILE,
      });

      const { response } = await fetchedTurn(h, runner.credential, [
        ...NOW_FEATURES,
        "implementer_subscription_setup",
      ]);

      expect(response.status).toBe(409);
      expect(h.issuedJobTokens()).toEqual([]);
      expect(await h.queue.get(turn.job.id)).toMatchObject({
        status: "failed",
        errorCode: "implementer_config_invalid",
      });
    },
  );

  // #1126-T42
  it("sends no environment, and needs no feature, for a step without a script or a rule", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const { response } = await fetchedTurn(h, runner.credential);

    const input = (await turnInput(response)) as unknown as {
      implementer: Record<string, unknown>;
    };
    expect(input.implementer).not.toHaveProperty("environment");
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

// #1092 (review finding 4): a turn of several repositories on a device's login is built when the Worker fetches it (`buildSubscriptionJob`), with the same tokens,
// ledger and guards as a hosted turn.
describe("the fetch of a turn on several repositories on the harness claude-code", () => {
  const MULTI_FEATURES = [...NOW_FEATURES, "implementer_multi_repo"];
  const multiClaimOf = (credential: string) => ({
    token: credential,
    engines: ["implementer"],
    features: ["implementer_multi_repo"],
  });

  async function setup(options: { canPush?: boolean } = {}) {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    const second = await secondInstallation(h);
    await cloneFromTheFake(h);
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: { ...PROFILE, canPush: options.canPush ?? true },
      repos: [
        sessionRepo(h.repositoryId, h.repository.fullName),
        sessionRepo(second.repositoryId, "other/docs"),
        sessionRepo(h.otherRepositoryId, await otherName(h)),
      ],
    });
    return { h, runner, turn };
  }

  async function fetchWith(
    h: Awaited<ReturnType<typeof start>>,
    credential: string,
    features: string[],
  ) {
    const claim = await h.claim(multiClaimOf(credential));
    expect(claim.status).toBe(200);
    const { job } = (await claim.json()) as SplitClaimResponse;
    return {
      claim: job,
      response: await h.worker.details(
        job.id,
        job.credential,
        features.join(","),
      ),
    };
  }

  // #1092-T110
  it("is not claimed by a runner that does not name the feature: the turn waits", async () => {
    const { h, runner, turn } = await setup();

    expect((await h.claim(claimOf(runner.credential))).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #1092-T111
  it("hands the Worker the repositories and one token for each installation, remembered with their connections before they leave", async () => {
    const { h, runner, turn } = await setup();

    const { claim, response } = await fetchWith(
      h,
      runner.credential,
      MULTI_FEATURES,
    );

    expect(claim.id).toBe(turn.job.id);
    const input = (await turnInput(response)) as unknown as {
      git: { token: string; tokens: Array<{ id: string; token: string }> };
      implementer: { repos: Array<{ tokenId: string }> };
    };
    expect(input.implementer.repos).toHaveLength(3);
    expect(input.git.tokens).toHaveLength(2);
    expect(input.git.token).toBe(input.git.tokens[0]?.token);
    expect(h.issuedJobTokens()).toHaveLength(2);
    const ledger = await h.claimedKeys.gitTokensOf(claim.id);
    expect(ledger.map((entry) => entry.token).sort()).toEqual(
      input.git.tokens.map((entry) => entry.token).sort(),
    );
    expect(new Set(ledger.map((entry) => entry.integrationId)).size).toBe(2);
  });

  // #1092-T112
  it("ends the turn implementer_engine_unavailable, free, when the Worker does not name the feature, before a token exists", async () => {
    const { h, runner, turn } = await setup();

    const { response } = await fetchWith(h, runner.credential, NOW_FEATURES);

    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
    expect(h.logLines().join("\n")).toContain("implementer_multi_repo");
  });

  // #1092-T113
  it("makes tokens that cannot write when the profile may not push, and asks for no right to write", async () => {
    const { h, runner } = await setup({ canPush: false });
    for (const id of [4242, 4243])
      h.fake.setInstallationPermissions(id, { ...WRITE, contents: "read" });

    const { response } = await fetchWith(h, runner.credential, MULTI_FEATURES);

    expect(response.status).toBe(200);
    expect(
      h.fake.tokenRequests().map((request) => request.permissions?.contents),
    ).toEqual(["read", "read"]);
  });

  // #1092-T114
  it("refuses a profile that may push on an installation that has not accepted the right to write, before a token exists", async () => {
    const { h, runner, turn } = await setup();
    h.fake.setInstallationPermissions(4243, { ...WRITE, contents: "read" });

    const { response } = await fetchWith(h, runner.credential, MULTI_FEATURES);

    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_write_not_granted",
    });
  });

  // #1092-T115 (review finding 3)
  it("ends a turn whose stored repositories cannot be read", async () => {
    const { h, runner, turn } = await setup();
    await h.db
      .updateTable("implementer_sessions")
      .set({ repos: "[not json" })
      .where("id", "=", turn.session.id)
      .execute();

    const claim = await h.claim(multiClaimOf(runner.credential));

    // Refused at the claim (before the Worker exists) or at the fetch: never run on the first repository alone.
    if (claim.status === 200) {
      const { job } = (await claim.json()) as SplitClaimResponse;
      const response = await h.worker.details(
        job.id,
        job.credential,
        MULTI_FEATURES.join(","),
      );
      expect(response.status).toBe(409);
    }
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
  });
});

// #1150: the same turn on the Claude Code OAuth token of the workspace. A hosted Sandbox VM has no login of a device, so the token is its login;
// a self-hosted runner that announces no login of its own (the entry `app-key` for the harness) runs on it as well; a runner that has its own
// login keeps it (the runner's own login wins).
const OAUTH_TOKEN =
  "sk-ant-oat01-WORKSPACETOKENWORKSPACETOKEN0123456789-abcdef_WXYZ";
const HOSTED_FEATURES = [...NOW_FEATURES, "implementer_subscription_setup"];
const DISPATCHER_ENGINES = ["implementer", "opencode", "pr-agent"];
const TOKEN_ACCESS = [
  ...OPENCODE_ACCESS,
  { harness: "claude-code", version: "2.1.311", auth: "app-key" as const },
];
const TOKEN_ONLY = { harnesses: [...TOKEN_ACCESS], capabilities: [] };

async function saveToken(h: Awaited<ReturnType<typeof start>>) {
  const saved = await h.llm
    .claudeCodeTokenFor(h.workspaceId)
    .save(OAUTH_TOKEN, null);
  expect(saved.ok).toBe(true);
}

describe("the claim of a turn on claude-code that runs on the token of the workspace", () => {
  // #1150-T10
  it("ends a hosted turn, free and with its reason, when the workspace has no token: no VM is started for a turn that cannot log in", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      profile: PROFILE,
    });

    const claim = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });

    expect(claim.status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #1150-T11
  it("hands a hosted Dispatcher the turn with the size of a VM and the host of Claude Code, and its Worker the token with the input and nowhere else", async () => {
    const h = await start();
    await saveToken(h);
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      profile: PROFILE,
      costLimitCents: 80,
    });

    const response = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });
    expect(response.status).toBe(200);
    const { job } = (await response.json()) as SplitClaimResponse;

    // The claim holds nothing of the turn but its credential and what the Dispatcher needs to start a VM: no input, no token.
    expect(job.id).toBe(turn.job.id);
    expect(JSON.stringify(job)).not.toContain(OAUTH_TOKEN);
    expect(job).not.toHaveProperty("input");
    expect(job.access).toEqual({
      harness: "claude-code",
      auth: "app-key",
      model: "claude-sonnet-5-5",
    });
    expect(job.sizeLabel).toMatch(/^cr:size-/);
    // The Dispatcher narrows the VM's network to the App, GitHub and the host of Claude Code (the token of the switch signs it).
    expect(job).toMatchObject({
      network: { mode: "off", hosts: [] },
      modelHost: "api.anthropic.com",
    });

    const fetched = await h.worker.details(
      job.id,
      job.credential,
      HOSTED_FEATURES.join(","),
    );
    const input = (await turnInput(fetched)) as unknown as {
      llm?: unknown;
      implementer: { subscription: Record<string, unknown> };
    };
    expect(input.llm).toBeUndefined();
    expect(input.implementer.subscription).toEqual({
      model: "claude-sonnet-5-5",
      maxBudgetUsd: "0.80",
      oauthToken: OAUTH_TOKEN,
    });
    expect(h.issuedJobTokens()).toHaveLength(1);
  });

  // #1150-T11
  it("never writes the token to the log of the App", async () => {
    const h = await start();
    await saveToken(h);
    await h.enqueueTurn({ modelChoice: CLAUDE_MODEL, profile: PROFILE });
    const response = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });
    const { job } = (await response.json()) as SplitClaimResponse;

    await h.worker.details(job.id, job.credential, HOSTED_FEATURES.join(","));

    expect(h.logLines().join("\n")).not.toContain(OAUTH_TOKEN);
  });

  // #1150-T11
  it("carries the size, the script and the rule of the hosted environment of the turn: the Dispatcher starts the VM of that size and the Worker reads the same setup as on a runner", async () => {
    const h = await start();
    await saveToken(h);
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      profile: PROFILE,
      environment: {
        id: "env-hosted",
        name: "Standard",
        vcpus: 4,
        setupScript: "npm ci\n",
        network: { mode: "list", hosts: ["registry.npmjs.org"] },
      },
    });

    const response = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });
    const { job } = (await response.json()) as SplitClaimResponse;

    expect(job).toMatchObject({
      vcpus: 4,
      network: { mode: "list", hosts: ["registry.npmjs.org"] },
      modelHost: "api.anthropic.com",
    });
    const input = (await turnInput(
      await h.worker.details(job.id, job.credential, HOSTED_FEATURES.join(",")),
    )) as unknown as { implementer: { environment: unknown } };
    expect(input.implementer.environment).toEqual({
      name: "Standard",
      setupScript: "npm ci\n",
      network: { mode: "list", hosts: ["registry.npmjs.org"] },
    });
  });

  // #1150-T11
  it("ends a hosted turn with an open network before a VM is started: the token would be inside a container that can reach anything", async () => {
    const h = await start();
    await saveToken(h);
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      profile: PROFILE,
      environment: {
        id: "env-hosted",
        name: "Standard",
        vcpus: 4,
        setupScript: "",
        network: { mode: "open", hosts: [] },
      },
    });

    const claim = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });

    expect(claim.status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #1150-T12
  it("hands a runner without a login of its own the turn on the token, and says so in the access the dispatcher reads", async () => {
    const h = await start();
    await saveToken(h);
    const runner = await h.registerRunner({
      labels: ["box"],
      manifest: TOKEN_ONLY,
    });
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const claim = await h.claim(claimOf(runner.credential));
    expect(claim.status).toBe(200);
    const { job } = (await claim.json()) as SplitClaimResponse;

    // `app-key`: the dispatcher hands the Worker no credential of its device, there is none.
    expect(job.access).toEqual({
      harness: "claude-code",
      auth: "app-key",
      model: "claude-sonnet-5-5",
    });
    const fetched = await h.worker.details(
      job.id,
      job.credential,
      NOW_FEATURES.join(","),
      undefined,
      undefined,
      "workspace",
    );
    const input = (await turnInput(fetched)) as unknown as {
      implementer: { subscription: { oauthToken?: string } };
    };
    expect(input.implementer.subscription.oauthToken).toBe(OAUTH_TOKEN);
  });

  // #1150-T12
  it("ends a turn on a runner without a login of its own, free, when the workspace has no token", async () => {
    const h = await start();
    const runner = await h.registerRunner({
      labels: ["box"],
      manifest: TOKEN_ONLY,
    });
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    expect((await h.claim(claimOf(runner.credential))).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
  });

  // #1150-T13
  it("keeps the runner's own login: the claim says subscription and the token of the workspace is not sent to its Worker", async () => {
    const h = await start();
    await saveToken(h);
    const runner = await h.registerRunner({ labels: ["box"], manifest: BOTH });
    await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const { claim, response } = await fetchedTurn(h, runner.credential);

    expect(claim.access).toEqual({
      harness: "claude-code",
      auth: "subscription",
      model: "claude-sonnet-5-5",
    });
    const input = (await turnInput(response)) as unknown as {
      implementer: { subscription: Record<string, unknown> };
    };
    expect(input.implementer.subscription).not.toHaveProperty("oauthToken");
  });

  // #1150-T13
  it("takes the token for a model the runner's login does not allow, as a runner without one does", async () => {
    const h = await start();
    await saveToken(h);
    const runner = await h.registerRunner({
      labels: ["box"],
      manifest: {
        harnesses: [
          ...TOKEN_ACCESS,
          {
            harness: "claude-code",
            version: "2.1.311",
            auth: "subscription",
            models: ["haiku"],
          },
        ],
        capabilities: [],
      },
    });
    await h.enqueueTurn({
      modelChoice: { provider: "claude-code", model: "opus" },
      runnerEnvironment: RUNNER_ENV,
      profile: PROFILE,
    });

    const claim = await h.claim(claimOf(runner.credential));

    expect(claim.status).toBe(200);
    expect(((await claim.json()) as SplitClaimResponse).job.access).toEqual({
      harness: "claude-code",
      auth: "app-key",
      model: "opus",
    });
  });

  // #1150-T14
  it("does not hand a token that cannot be read to anybody: the turn ends with its reason", async () => {
    const h = await start();
    await saveToken(h);
    // A row that was made for another workspace does not decrypt for this one.
    await h.db
      .updateTable("workspace_secrets")
      .set({ ciphertext: "AAAA", nonce: "AAAA" })
      .where("name", "=", "claude_code_oauth_token")
      .execute();
    const turn = await h.enqueueTurn({
      modelChoice: CLAUDE_MODEL,
      profile: PROFILE,
    });

    const claim = await h.claimSplit({
      engines: DISPATCHER_ENGINES,
      features: HOSTED_FEATURES,
    });

    expect(claim.status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
  });
});
