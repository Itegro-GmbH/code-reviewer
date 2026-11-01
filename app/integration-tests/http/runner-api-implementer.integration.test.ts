// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim and the Worker's fetch of a turn of the Implementer (#753, part of #745): the claim of a Dispatcher answers with a
// credential and no input; the Worker's fetch builds the `implementer` input (a repository, a base branch, a new branch, the
// instruction, a token that may write exactly this repository, the model with its cost policy) and reads no pull request. The
// write token is switched off at GitHub as soon as it is not needed any more: when it never reached the Worker, and when the
// turn is over (review of #776). A deployment without the capability reaches none of this.
import { describe, expect, it } from "vitest";
import {
  createFakeAdapter,
  FAKE_PROVIDER_ID,
} from "../../src/llm/providers/fake-adapter.ts";
import { openrouterDescriptor } from "../../src/llm/providers/openrouter/descriptor.ts";
import { createProviderRegistry } from "../../src/llm/providers/registry.ts";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createIntegrationsRepository } from "../../src/db/repositories/integrations-repository.ts";
import { createWorkspaceEntitlementsRepository } from "../../src/db/repositories/workspace-entitlements-repository.ts";
import type { ManagedAvailabilityJson } from "../../src/model-prices/availability.ts";
import type { PriceBookJson } from "../../src/model-prices/price-book.ts";
import type { JobModelEntry } from "../../src/models-dev/job-entry.ts";
import { createNativeCostService } from "../../src/native-cost/service.ts";
import { sha } from "../../src/test-support/jobs.ts";
import { createContractValidator } from "../../src/test-support/runner-contract.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";
import { allowAllClaimGuard } from "../../src/runner-api/claim-guard.ts";
import type { EntitlementsData } from "../../src/workspaces/entitlements.ts";
import type { EnqueueImplementerTurnInput } from "../../src/jobs/job-types.ts";

const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const FAKE_OPERATOR_KEY = "plain-operator-fake-0002-bbbbbbb";
const WORKSPACE_KEY = "plain-workspace-key-0003-cccccccc";
const FAKE_WORKSPACE_KEY = "plain-workspace-fake-0004-dddddd";
const PROVIDERS = createProviderRegistry([
  openrouterDescriptor,
  createFakeAdapter(),
]);
const BOTH = [openrouterDescriptor.id, FAKE_PROVIDER_ID];
const NATIVE_MODEL = "fake-thorough";
const INSTRUCTION = "Add a retry with backoff.\nCover it with a test.";
const BOOK: PriceBookJson = {
  input: "660000",
  output: "1980000",
  cacheRead: "22000",
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};
const CONFIRMED: ManagedAvailabilityJson = {
  selectable: true,
  book: BOOK,
  confirmationId: 3,
  hashVersion: 2,
};
const ENTRY: JobModelEntry = {
  version: 1,
  providerId: "deepseek",
  npm: "@ai-sdk/openai-compatible",
  family: "openai-chat",
  authHeader: "Authorization",
  upstreamBaseUrl: "https://api.deepseek.com",
  modelId: NATIVE_MODEL,
  model: {
    name: "Thorough",
    status: "active",
    tool_call: true,
    reasoning: false,
    temperature: true,
    limit: { context: 128000, output: 8192 },
    modalities: { input: ["text"], output: ["text"] },
  },
};
const FEATURES = [
  "dynamic_capabilities",
  "dynamic_cost_policy",
  "cost_limit",
  "operator_cost_limit",
];
const WORKER_FEATURES = FEATURES.join(",");
// What a Dispatcher says when it claims the next turn; what its Worker can do is judged at the Worker's fetch.
const DISPATCHER = { engines: ["implementer"], llmProviders: BOTH };
const READ_ONLY = {
  metadata: "read",
  contents: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
} as const;
// What the token of a review job may do (the provider's own constant is not importable here): it never writes contents.
const REVIEW_TOKEN_PERMISSIONS = {
  pull_requests: "write",
  issues: "write",
  contents: "read",
  metadata: "read",
};
const contract = createContractValidator();
// What a Worker reports of a turn that succeeded: the implementer block is required for it (#754).
const TURN_BLOCK = {
  baseCommit: sha("b"),
  headCommit: sha("c"),
  pushed: true,
  commits: [{ sha: sha("c"), subject: "Add a retry with backoff" }],
  filesChanged: [{ path: "src/retry.ts", status: "added" as const }],
  summary: "Added a retry with backoff.",
  opencode: { sessionId: "ses_0001", version: "1.19.0" },
};
const turnResult = (overrides: Parameters<typeof goodResult>[0] = {}) =>
  goodResult({ implementer: TURN_BLOCK, ...overrides });

function entitlements(keyMode: "own" | "managed"): EntitlementsData {
  return {
    planLabel: "plan",
    keyMode,
    limits: {
      diffRunsPerPeriod: null,
      dynamicRunsPerPeriod: null,
      managedCostLimitMicroUsd: null,
      ownKeyCostLimitMicroUsd: null,
    },
    periodStart: "2026-10-01T00:00:00.000Z",
    suspended: false,
    suspensionCode: null,
  };
}

type Started = RunnerApiHarness & {
  /** The entry of the operator's catalog the harness made (a managed workspace's choice). */
  entryId: string;
  /** Makes a turn on the model the workspace's key mode implies, unless told otherwise. */
  turn: (
    overrides?: Partial<EnqueueImplementerTurnInput>,
  ) => Promise<{ jobId: string; branch: string }>;
  keyLoads: { count: number };
};

async function start(
  options: {
    keyMode?: "own" | "managed";
    /** Not a factory: the registry's capabilities hold no `implementer`. */
    noCapability?: boolean;
    /** The kinds the catalog entry serves; default both. */
    entryKinds?: ("diff" | "dynamic")[];
    entryStatus?: "released" | "retired";
    /** A reader of the entry of the model; default a native entry. */
    nativeEntry?: boolean;
    /** The claim guard lets every job run (the connection is checked by the claim itself, as in a race with its removal). */
    openGuard?: boolean;
    /** Wraps what the API remembers about a job, for a test that makes one call of the ledger fail. */
    wrapClaimedKeys?: Parameters<
      typeof startRunnerApiHarness
    >[0] extends infer O
      ? O extends { wrapClaimedKeys?: infer W }
        ? W
        : never
      : never;
    /** A reader of the model metadata (the harness reads none by default). */
    modelCapabilities?: Parameters<
      typeof startRunnerApiHarness
    >[0] extends infer O
      ? O extends { modelCapabilities?: infer M }
        ? M
        : never
      : never;
    /** Wraps the job queue the API uses, for a test that makes one call of it fail. */
    wrapQueue?: Parameters<typeof startRunnerApiHarness>[0] extends infer O
      ? O extends { wrapQueue?: infer W }
        ? W
        : never
      : never;
  } = {},
): Promise<Started> {
  const keyMode = options.keyMode ?? "managed";
  const keyLoads = { count: 0 };
  let settingsDb: ReturnType<typeof createInstanceSettingsRepository> | null =
    null;
  const h = await startRunnerApiHarness({
    llmKey: WORKSPACE_KEY,
    projects: true,
    providers: PROVIDERS,
    implementer: options.noCapability !== true,
    ...(options.openGuard === true ? { guard: allowAllClaimGuard } : {}),
    ...(options.wrapQueue === undefined
      ? {}
      : { wrapQueue: options.wrapQueue }),
    ...(options.wrapClaimedKeys === undefined
      ? {}
      : { wrapClaimedKeys: options.wrapClaimedKeys }),
    ...(options.modelCapabilities === undefined
      ? {}
      : { modelCapabilities: options.modelCapabilities }),
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    onKeyLoad: () => {
      keyLoads.count += 1;
    },
    nativeCost: {
      ...createNativeCostService({
        prices: {
          availability: async () => CONFIRMED,
          catalogPrice: async () => BOOK,
        },
        settings: {
          get: (key) =>
            settingsDb === null
              ? Promise.resolve(undefined)
              : settingsDb.get(key),
        },
        catalog: {
          getProvider: async () => undefined,
          getModel: async () => undefined,
        },
        legacyProviders: [openrouterDescriptor.id],
        registryAddresses: {},
      }),
      entryFor: async () =>
        options.nativeEntry === false
          ? { ok: false, code: "model_not_in_catalog" }
          : { ok: true, entry: ENTRY },
      refOf: (selection) =>
        selection.provider === FAKE_PROVIDER_ID
          ? { providerId: "deepseek", modelId: selection.model }
          : null,
    },
  });
  settingsDb = createInstanceSettingsRepository(h.db);
  await h.setLlmKey(FAKE_WORKSPACE_KEY, FAKE_PROVIDER_ID);
  for (const [provider, apiKey] of [
    [openrouterDescriptor.id, OPERATOR_KEY],
    [FAKE_PROVIDER_ID, FAKE_OPERATOR_KEY],
  ] as const) {
    const saved = await h.llm.operatorKey().save({ provider, apiKey }, null);
    expect(saved.ok).toBe(true);
  }
  const entry = await h.catalogEntryFor(FAKE_PROVIDER_ID, {
    name: "Thorough",
    modelId: NATIVE_MODEL,
    kinds: options.entryKinds ?? ["diff", "dynamic"],
    status: options.entryStatus ?? "released",
  });
  await createWorkspaceEntitlementsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  ).put(entitlements(keyMode), null);
  await h.projectService.activateProject(h.repositoryId);
  const choice =
    keyMode === "managed"
      ? { entryId: entry.id }
      : { provider: FAKE_PROVIDER_ID, model: NATIVE_MODEL };
  return Object.assign(h, {
    entryId: entry.id,
    keyLoads,
    turn: async (overrides: Partial<EnqueueImplementerTurnInput> = {}) => {
      const made = await h.enqueueTurn({
        modelChoice: choice,
        instruction: INSTRUCTION,
        ...overrides,
      });
      return { jobId: made.job.id, branch: made.session.branch };
    },
  });
}

/** The input of the next turn as its Worker fetches it. */
async function fetched(h: Started, features = WORKER_FEATURES) {
  const { jobId, credential, details } = await h.startedWorker(
    features,
    BOTH.join(","),
    DISPATCHER,
  );
  return { jobId, credential, input: details.job.input, details };
}

/**
 * The Dispatcher's claim of a turn that cannot run: the checks run at the claim, before the Worker and the VM exist, so the
 * answer is "no job" and the job has ended with its code.
 */
async function endedAtClaim(h: Started, jobId: string) {
  expect((await h.claimSplit(DISPATCHER)).status).toBe(204);
  return h.queue.get(jobId);
}

/** The write tokens GitHub made, in order: the requests that asked for contents write. */
function writeTokens(h: Started): string[] {
  const requests = h.fake.tokenRequests();
  return h.fake
    .issuedInstallationTokens()
    .filter((_, index) => requests[index]?.permissions?.contents === "write");
}

describe("the claim of a Dispatcher", () => {
  // #753-T01
  it("answers with a credential and the kind, and with no input and no token", async () => {
    const h = await start();
    const { jobId } = await h.turn();

    const response = await h.claimSplit(DISPATCHER);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      job: Record<string, unknown>;
    };
    expect(body.job).toMatchObject({ id: jobId, reviewKind: "implementer" });
    expect(typeof body.job.credential).toBe("string");
    expect(body.job).not.toHaveProperty("input");
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });
});

describe("the Worker's fetch of a turn", () => {
  // #753-T02
  it("answers an implementer input that the contract accepts, with the task exactly as submitted and no pull request", async () => {
    const h = await start();
    const { branch } = await h.turn({ baseBranch: "develop" });

    const { input } = await fetched(h);

    expect(contract.check("RunnerJobInput", input)).toStrictEqual({
      valid: true,
      errors: "",
    });
    expect(input).toMatchObject({
      reviewKind: "implementer",
      implementer: {
        repo: {
          fullName: h.repository.fullName,
          cloneUrl: `https://github.test/${h.repository.fullName}.git`,
        },
        baseBranch: "develop",
        branch,
        instruction: INSTRUCTION,
        limits: { timeLimitSeconds: 3600 },
        cost: { keyMode: "managed", priceBook: BOOK },
        modelEntry: ENTRY,
      },
      git: { provider: "github", botLogin: expect.stringMatching(/\[bot\]$/) },
    });
    expect(input).not.toHaveProperty("prUrl");
    expect(input).not.toHaveProperty("command");
    expect(input).not.toHaveProperty("base");
    expect(input).not.toHaveProperty("dynamic");
  });

  // #753-T03
  it("mints a token for the one repository that can write its contents, and a review job's token stays read-only", async () => {
    const h = await start();
    await h.turn();
    await h.enqueueNew();

    const { input } = await fetched(h);

    expect(h.fake.tokenRequests()).toEqual([
      expect.objectContaining({
        repositoryIds: [Number(h.repository.externalId)],
        permissions: { contents: "write", metadata: "read" },
      }),
    ]);
    expect(input.git.token).toBe(h.fake.issuedInstallationTokens()[0]);
    // The next job is the review: its token is the review token.
    const review = await h.claimed({ engines: ["pr-agent"] });
    expect(review.job.input).toHaveProperty("prUrl");
    expect(
      h.fake
        .tokenRequests()
        .filter((request) => request.permissions?.pull_requests === "write"),
    ).toEqual([
      expect.objectContaining({ permissions: REVIEW_TOKEN_PERMISSIONS }),
    ]);
  });

  // #753-T06
  it("fails the turn git_write_not_granted, makes no token and does not retry when the installation has not accepted contents write", async () => {
    const h = await start();
    h.fake.setInstallationPermissions(4242, READ_ONLY);
    const { jobId } = await h.turn();

    expect(await endedAtClaim(h, jobId)).toMatchObject({
      status: "failed",
      errorCode: "git_write_not_granted",
      attempts: 0,
    });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
    // Nothing is claimed again: the job is over, not waiting.
    expect((await h.claimSplit(DISPATCHER)).status).toBe(204);
  });

  // #753-T06
  it("gives the turn back with Retry-After, and does not fail it, when GitHub is down while the token is made", async () => {
    const h = await start();
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    h.fake.fail({
      pathIncludes: "/access_tokens",
      status: 503,
      times: 1,
      headers: { "retry-after": "120" },
    });

    const response = await h.worker.details(
      split.job.id,
      split.job.credential,
      WORKER_FEATURES,
      undefined,
      BOTH.join(","),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });

  // #753-T07
  it("reads no pull request", async () => {
    const h = await start();
    await h.turn();

    await fetched(h);

    const paths = h.fake.requests().map((request) => request.path);
    expect(paths.some((path) => path.includes("/pulls"))).toBe(false);
  });

  // #753-T07
  it("fails the turn git_connection_disabled when the connection of the repository is off", async () => {
    const h = await start({ openGuard: true });
    const { jobId } = await h.turn();
    const integrations = createIntegrationsRepository(h.db, h.workspaceId);
    const [integration] = await integrations.list();
    await integrations.setStatus(integration!.id, "disabled");

    expect(await endedAtClaim(h, jobId)).toMatchObject({
      status: "failed",
      errorCode: "git_connection_disabled",
    });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });

  // #753-T10
  it("answers the fourth fetch of one claim like it does for other kinds, and makes no token for it", async () => {
    const h = await start();
    await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    const fetch = () =>
      h.worker.details(
        split.job.id,
        split.job.credential,
        WORKER_FEATURES,
        undefined,
        BOTH.join(","),
      );
    for (let count = 0; count < 3; count += 1)
      expect((await fetch()).status).toBe(200);
    const tokens = h.fake.issuedInstallationTokens().length;

    const fourth = await fetch();

    expect(fourth.status).toBe(401);
    expect(h.fake.issuedInstallationTokens()).toHaveLength(tokens);
  });
});

describe("the model of a turn", () => {
  // #753-T04
  it("runs a workspace on the operator's key on the entry of its choice", async () => {
    const h = await start({ keyMode: "managed" });
    await h.turn();

    const { input } = await fetched(h);

    expect(input.llm).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: NATIVE_MODEL,
      apiKey: FAKE_OPERATOR_KEY,
    });
  });

  // #753-T04
  it("runs a workspace on its own key on the provider and the model of the turn", async () => {
    const h = await start({ keyMode: "own" });
    await h.turn();

    const { input } = await fetched(h);

    expect(input.llm).toMatchObject({
      provider: FAKE_PROVIDER_ID,
      model: NATIVE_MODEL,
      apiKey: FAKE_WORKSPACE_KEY,
    });
    expect(input).toMatchObject({
      implementer: { cost: { keyMode: "own" }, modelEntry: ENTRY },
    });
  });

  it.each<[string, Parameters<typeof start>[0], string]>([
    [
      "an entry that does not serve the dynamic kind",
      { keyMode: "managed", entryKinds: ["diff"] },
      "managed_model_unavailable",
    ],
    [
      "a retired entry",
      { keyMode: "managed", entryStatus: "retired" },
      "managed_model_unavailable",
    ],
    [
      "a model the catalog does not describe, on the operator's key",
      { keyMode: "managed", nativeEntry: false },
      "managed_model_unavailable",
    ],
  ])(
    // #753-T04
    "ends the turn closed, at the claim and before any token or key is handed out, for %s",
    async (_name, options, code) => {
      const h = await start(options);
      const { jobId } = await h.turn();

      expect(await endedAtClaim(h, jobId)).toMatchObject({
        status: "failed",
        errorCode: code,
      });
      expect(h.fake.issuedInstallationTokens()).toEqual([]);
      expect(
        await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
      ).toEqual([]);
    },
  );

  // #753-T04
  it("ends the turn llm_not_configured when the workspace has no key for the provider of the turn", async () => {
    const h = await start({ keyMode: "own" });
    await h.setLlmKey(null, FAKE_PROVIDER_ID);
    const { jobId } = await h.turn();

    expect(await endedAtClaim(h, jobId)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });

  // #753-T04
  it("ends the turn llm_provider_unsupported for a provider the app does not know", async () => {
    const h = await start({ keyMode: "own" });
    const { jobId } = await h.turn({
      modelChoice: { provider: "no_such_provider", model: "x" },
    });

    expect(await endedAtClaim(h, jobId)).toMatchObject({
      status: "failed",
      errorCode: "llm_provider_unsupported",
    });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });

  // #753-T04
  it("never moves a turn to another model when the key mode changed since it was started", async () => {
    const own = await start({ keyMode: "own" });
    const { jobId: ownJob } = await own.turn({
      modelChoice: { entryId: own.entryId },
    });
    const managed = await start({ keyMode: "managed" });
    const { jobId: managedJob } = await managed.turn({
      modelChoice: { provider: FAKE_PROVIDER_ID, model: NATIVE_MODEL },
    });

    expect(await endedAtClaim(own, ownJob)).toMatchObject({
      status: "failed",
      errorCode: "llm_model_unavailable",
    });
    expect(await endedAtClaim(managed, managedJob)).toMatchObject({
      status: "failed",
      errorCode: "managed_model_unavailable",
    });
    for (const h of [own, managed])
      expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });
});

describe("the cost limit of a turn", () => {
  // #753-T05
  it("carries the smaller of the turn's limit and the operator's maximum, as a Dynamic job does", async () => {
    const h = await start();
    await createInstanceSettingsRepository(h.db, h.clock.now).set(
      "review_max_cost_cents",
      300,
      null,
    );
    await h.turn({ costLimitCents: 150 });
    await h.turn({ costLimitCents: 500 });

    const first = await fetched(h);
    const second = await fetched(h);

    expect(first.input.llm).toMatchObject({
      maxCostUsd: 1.5,
      operatorMaxCostUsd: 3,
    });
    expect(second.input.llm).toMatchObject({
      maxCostUsd: 5,
      operatorMaxCostUsd: 3,
    });
  });

  // #753-T05, #790: the cost limit is the brake of a turn and the runner has no limit of its own for this kind.
  it.each([["neither cost feature", "dynamic_cost_policy"]])(
    "ends the turn for a runner that names %s, as for an engine that cannot run the kind, before any credential exists",
    async (_name, features) => {
      const h = await start();
      const { jobId } = await h.turn({ costLimitCents: 150 });
      const split = await h.claimedSplit(DISPATCHER);

      const response = await h.worker.details(
        split.job.id,
        split.job.credential,
        features,
        undefined,
        BOTH.join(","),
      );

      expect(response.status).toBe(409);
      expect(await h.queue.get(jobId)).toMatchObject({
        status: "failed",
        errorCode: "implementer_engine_unavailable",
      });
      expect(h.fake.issuedInstallationTokens()).toEqual([]);
      expect(h.logLines().join("\n")).not.toContain("carries no cost limit");
    },
  );

  // #790: one cost feature is enough, and each is handed what it reads.
  it.each([
    // The smaller of the turn's 1.50 and the operator's maximum (1.00 by default), folded into the one value it reads.
    ["cost_limit", { maxCostUsd: 1 }],
    ["operator_cost_limit", { operatorMaxCostUsd: 1 }],
  ])("serves a runner that names only %s", async (feature, expected) => {
    const h = await start();
    await h.turn({ costLimitCents: 150 });

    const { input } = await fetched(h, `dynamic_cost_policy,${feature}`);

    expect(input.llm).toMatchObject(expected);
  });

  // #753-T05
  it("ends the turn before any credential exists when the runner does not read a cost policy", async () => {
    const h = await start();
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);

    await h.worker.details(
      split.job.id,
      split.job.credential,
      "cost_limit",
      undefined,
      BOTH.join(","),
    );

    expect(await h.queue.get(jobId)).toMatchObject({ status: "failed" });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });
});

describe("the log of a claim and a fetch", () => {
  // #753-T09
  it("holds no token, no key, no credential and no instruction", async () => {
    const h = await start();
    await h.turn();

    const { input, credential } = await fetched(h);

    const written = h.logLines().join("\n");
    expect(written).not.toBe("");
    for (const secret of [
      input.git.token,
      input.llm.apiKey,
      credential,
      FAKE_OPERATOR_KEY,
      INSTRUCTION,
    ])
      expect(written).not.toContain(secret);
  });
});

describe("the write token ends with the turn", () => {
  // review of #776, point 1
  it("is switched off when the fetch fails after the token was made, so it never reaches the Worker", async () => {
    let failGet = false;
    const h = await start({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) =>
          failGet
            ? Promise.reject(new Error("the queue is down"))
            : queue.get(id),
      }),
    });
    await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    failGet = true;

    const response = await h.worker.details(
      split.job.id,
      split.job.credential,
      WORKER_FEATURES,
      undefined,
      BOTH.join(","),
    );

    expect(response.status).toBe(500);
    const made = writeTokens(h);
    expect(made).toHaveLength(1);
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
    expect(h.logLines().join("\n")).not.toContain(made[0]!);
  });

  // review of #776, point 1
  it("is switched off when the Worker reports the result, success or failure, every token the fetches made", async () => {
    for (const result of [
      turnResult(),
      goodResult({
        ok: false,
        errorCode: "push_rejected",
        errorMessage: "the provider refused",
        commentUrl: null,
      }),
    ]) {
      const h = await start();
      await h.turn();
      const first = await fetched(h);
      // A second fetch of the same claim makes a second token.
      await h.worker.details(
        first.jobId,
        first.credential,
        WORKER_FEATURES,
        undefined,
        BOTH.join(","),
      );
      const made = writeTokens(h);
      expect(made).toHaveLength(2);
      expect(h.fake.revokedInstallationTokens()).toEqual([]);

      const response = await h.worker.result(
        first.jobId,
        first.credential,
        result,
      );

      expect(response.status).toBe(200);
      expect([...h.fake.revokedInstallationTokens()].sort()).toEqual(
        [...made].sort(),
      );
      // A repeated report revokes nothing again and does not fail.
      const again = await h.worker.result(
        first.jobId,
        first.credential,
        result,
      );
      expect(again.status).toBe(200);
      expect(h.fake.revokedInstallationTokens()).toHaveLength(2);
    }
  });

  // review of #776, point 1
  it("is switched off when the Worker is shut down and gives the turn back", async () => {
    const h = await start();
    await h.turn();
    const { jobId, credential } = await fetched(h);
    const made = writeTokens(h);

    await h.worker.result(
      jobId,
      credential,
      goodResult({
        ok: false,
        errorCode: "runner_shutdown",
        errorMessage: "shut down",
        commentUrl: null,
      }),
    );

    expect(h.fake.revokedInstallationTokens()).toEqual(made);
  });

  // review of #776, point 1
  it("is switched off when a Dispatcher releases the turn because the Worker's container ended without a result", async () => {
    const h = await start();
    await h.turn();
    const { jobId, credential } = await fetched(h);
    const made = writeTokens(h);

    const response = await h.release(jobId, {
      credential,
      reason: "worker_exited",
    });

    expect(response.status).toBe(200);
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
  });

  // review of #776, point 1
  it("is switched off when a runner that fetched the turn with the claim reports its result", async () => {
    const h = await start();
    await h.turn();
    const claimed = await h.claimed({
      engines: ["implementer"],
      features: FEATURES,
      llmProviders: BOTH,
    });
    const made = writeTokens(h);
    expect(made).toEqual([claimed.job.input.git.token]);
    expect(h.fake.revokedInstallationTokens()).toEqual([]);

    await h.complete(claimed.job.id, claimed.job.leaseToken, turnResult());

    expect(h.fake.revokedInstallationTokens()).toEqual(made);
  });

  // review of #776, point 1
  it("never stores the token in the clear", async () => {
    const h = await start();
    await h.turn();
    await fetched(h);
    const made = writeTokens(h);

    const rows = await h.db
      .selectFrom("job_claimed_keys")
      .selectAll()
      .execute();

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(made[0]!);
  });
});

describe("a deployment without the capability", () => {
  // review of #776, point 2
  it("reaches no write token even with an App that was set to write by hand, and ends the turn without asking GitHub for one", async () => {
    const h = await start({ noCapability: true });
    // The App asks for contents write and the installation accepted it, by hand.
    const write = { ...READ_ONLY, contents: "write" } as const;
    h.fake.setAppPermissions(write);
    h.fake.setInstallationPermissions(4242, write);
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);

    const response = await h.worker.details(
      split.job.id,
      split.job.credential,
      WORKER_FEATURES,
      undefined,
      BOTH.join(","),
    );

    expect(response.status).toBe(409);
    expect(await h.queue.get(jobId)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
    expect(h.fake.tokenRequests()).toEqual([]);
  });
});

describe("the managed cost guard and a turn (#754)", () => {
  // #790: confirms that #754 holds the managed turn to the rule of a managed Dynamic run, through the whole road.
  it.each([
    [
      "a success that reports no cost",
      { usage: { ...goodResult().usage!, costUsd: null } },
    ],
    ["a success that reports no usage at all", { usage: null }],
  ])(
    "stores %s of a managed native turn as dynamic_accounting_failed",
    async (_name, report) => {
      const h = await start({ keyMode: "managed" });
      await h.turn();
      const { jobId, credential } = await fetched(h);

      const response = await h.worker.result(
        jobId,
        credential,
        turnResult(report),
      );

      expect(response.status).toBe(200);
      expect(await h.queue.get(jobId)).toMatchObject({
        status: "failed",
        errorCode: "dynamic_accounting_failed",
      });
    },
  );

  // #790: and a report that does name a cost settles as a success.
  it("settles a managed native turn that reports its cost", async () => {
    const h = await start({ keyMode: "managed" });
    await h.turn();
    const { jobId, credential } = await fetched(h);

    await h.worker.result(jobId, credential, turnResult());

    expect(await h.queue.get(jobId)).toMatchObject({ status: "succeeded" });
  });
});

/** The Worker's fetch of the turn the Dispatcher claimed, by its credential. */
function fetchAgain(
  h: Started,
  split: { job: { id: string; credential: string } },
) {
  return h.worker.details(
    split.job.id,
    split.job.credential,
    WORKER_FEATURES,
    undefined,
    BOTH.join(","),
  );
}

/** Whether GitHub still honours a token (it does until it is switched off or expires). */
async function stillWorks(h: Started, token: string): Promise<boolean> {
  const response = await fetch(`${h.fake.baseUrl}/installation/repositories`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status === 200;
}

describe("a write token that could not be switched off (#790)", () => {
  // review of #790, point 1
  it("stays in the ledger, is said so in the log, and is switched off at the next try", async () => {
    const h = await start();
    await h.turn();
    const { jobId, credential } = await fetched(h);
    const [token] = writeTokens(h);
    // Both the report and the end of the claim try to switch the token off; GitHub is down for both.
    h.fake.fail({ pathIncludes: "/installation/token", status: 503 });

    const response = await h.worker.result(jobId, credential, turnResult());
    await h.writeTokensSettled();

    expect(response.status).toBe(200);
    expect(h.fake.revokedInstallationTokens()).toEqual([]);
    expect(await stillWorks(h, token!)).toBe(true);
    expect(
      (await h.claimedKeys.gitTokensOf(jobId)).map((t) => t.token),
    ).toEqual([token]);
    const written = h.logLines().join("\n");
    expect(written).toContain("not switched off yet");
    expect(written).not.toMatch(/\d write token\(s\) switched off/);
    expect(written).not.toContain(token!);

    h.fake.clearFailures();
    await h.writeTokens.retryPending();

    expect(h.fake.revokedInstallationTokens()).toEqual([token]);
    expect(await h.claimedKeys.gitTokensOf(jobId)).toEqual([]);
    expect(await stillWorks(h, token!)).toBe(false);
  });

  // review of #790, point 1 and 4: "retrying what failed until the token's expiry passes, and then forget it".
  it("is tried again until it expires on its own, and forgotten then", async () => {
    const h = await start();
    await h.turn();
    const { jobId, credential } = await fetched(h);
    const [token] = writeTokens(h);
    h.fake.fail({ pathIncludes: "/installation/token", status: 503 });
    await h.worker.result(jobId, credential, turnResult());
    await h.writeTokensSettled();

    // Within the hour the token is kept and tried each time.
    for (const minutes of [5, 20]) {
      h.clock.advance(minutes * 60_000);
      h.githubClock.advance(minutes * 60_000);
      await h.writeTokens.retryPending();
      expect(
        (await h.claimedKeys.gitTokensOf(jobId)).map((t) => t.token),
      ).toEqual([token]);
    }
    expect(h.fake.revokedInstallationTokens()).toEqual([]);

    // Past its expiry it is no danger any more: forgotten, and GitHub is not asked again.
    h.clock.advance(40 * 60_000);
    h.githubClock.advance(40 * 60_000);
    const asked = h.fake.requests().length;
    await h.writeTokens.retryPending();

    expect(await h.claimedKeys.gitTokensOf(jobId)).toEqual([]);
    expect(h.fake.requests()).toHaveLength(asked);
  });

  // review of #790, point 1: a token the fetch could not hand over is held to the same rule.
  it("is kept when the revoke of a token that never reached the Worker fails, and switched off later", async () => {
    let failGet = false;
    const h = await start({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) =>
          failGet
            ? Promise.reject(new Error("the queue is down"))
            : queue.get(id),
      }),
    });
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    failGet = true;
    h.fake.fail({ pathIncludes: "/installation/token", status: 503, times: 1 });

    expect((await fetchAgain(h, split)).status).toBe(500);
    failGet = false;

    const [token] = writeTokens(h);
    expect(h.fake.revokedInstallationTokens()).toEqual([]);
    expect(
      (await h.claimedKeys.gitTokensOf(jobId)).map((t) => t.token),
    ).toEqual([token]);
    // The turn is still waiting (nothing was handed to a Worker), and a later try switches the token off.
    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
    await h.writeTokens.revokeAllOf({
      id: jobId,
      reviewKind: "implementer",
      workspaceId: h.workspaceId,
      repositoryId: h.repositoryId,
    });
    expect(h.fake.revokedInstallationTokens()).toEqual([token]);
  });
});

describe("a turn that ends without a report (#790)", () => {
  // review of #790, point 4
  it("has its write tokens switched off when the reaper ends it", async () => {
    const h = await start();
    const { jobId } = await h.turn();
    await fetched(h);
    const made = writeTokens(h);
    expect(h.fake.revokedInstallationTokens()).toEqual([]);

    h.clock.advance(10 * 60_000);
    await h.queue.expireStaleJobs();
    await h.writeTokensSettled();

    expect(await h.queue.get(jobId)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
    });
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
    expect(await h.claimedKeys.gitTokensOf(jobId)).toEqual([]);
  });

  // review of #790, point 4
  it("has its write tokens switched off when the claim is cancelled (a stop)", async () => {
    const h = await start();
    const { jobId } = await h.turn();
    await fetched(h);
    const made = writeTokens(h);

    const cancelled = await h.queue.cancelClaimed(
      jobId,
      await h.tokenOf(jobId),
      "project_deactivated",
    );
    await h.writeTokensSettled();

    expect(cancelled.status).toBe("cancelled");
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
  });

  // review of #790, point 4
  it("has its write tokens switched off when the hard time limit ends it", async () => {
    const h = await start();
    await h.turn();
    const { jobId, credential } = await fetched(h);
    const made = writeTokens(h);

    // The Worker keeps its lease alive, so only the limit of the kind can end the turn.
    for (let minute = 0; minute < 75; minute += 1) {
      h.clock.advance(60_000);
      await h.worker.heartbeat(jobId, credential);
    }
    await h.queue.expireStaleJobs();
    await h.writeTokensSettled();

    expect(await h.queue.get(jobId)).toMatchObject({ status: "failed" });
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
  });

  // review of #790, point 4: a requeued turn is not ended, so its tokens are not touched.
  it("leaves the tokens alone while the turn is still waiting", async () => {
    const h = await start();
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });
    await fetchAgain(h, split);

    await h.writeTokensSettled();

    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
    expect(h.fake.revokedInstallationTokens()).toEqual([]);
  });
});

describe("a turn given back after an input was handed out (#790)", () => {
  // review of #790, point 5: `beforeStart` held by convention only.
  it("is not requeued when a second fetch fails after the Worker already got an input, and its tokens end with the turn", async () => {
    let failGet = false;
    const h = await start({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) =>
          failGet
            ? Promise.reject(new Error("the queue is down"))
            : queue.get(id),
      }),
    });
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    expect((await fetchAgain(h, split)).status).toBe(200);
    const [delivered] = writeTokens(h);
    failGet = true;

    expect((await fetchAgain(h, split)).status).toBe(500);
    failGet = false;
    await h.writeTokensSettled();

    // The Worker of the first fetch may be running: the turn is not put back in the queue under it.
    expect(await h.queue.get(jobId)).toMatchObject({ status: "failed" });
    const made = writeTokens(h);
    expect(made).toHaveLength(2);
    // The failed fetch's own token is off at once; the delivered one is off because the turn is over, not because of the fetch.
    expect([...h.fake.revokedInstallationTokens()].sort()).toEqual(
      [...made].sort(),
    );
    expect(made).toContain(delivered);
  });

  // review of #790, point 5: with nothing handed out the turn waits again.
  it("is requeued when the first fetch fails after its token was made", async () => {
    let failGet = false;
    const h = await start({
      wrapQueue: (queue) => ({
        ...queue,
        get: (id: string) =>
          failGet
            ? Promise.reject(new Error("the queue is down"))
            : queue.get(id),
      }),
    });
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);
    failGet = true;

    expect((await fetchAgain(h, split)).status).toBe(500);
    failGet = false;

    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
    expect(h.fake.revokedInstallationTokens()).toEqual(writeTokens(h));
  });
});

describe("the write token on every failure path of the claim and the build (#790)", () => {
  // review of #790, point 7: the `catch` of the claim of a runner.
  it("is switched off when the claim of a runner fails after the input was built", async () => {
    const h = await start({
      wrapClaimedKeys: (keys) => ({
        ...keys,
        rememberNative: () => Promise.reject(new Error("the ledger is down")),
      }),
    });
    const { jobId } = await h.turn();

    const response = await h.claim({
      engines: ["implementer"],
      features: FEATURES,
      llmProviders: BOTH,
    });

    expect(response.status).toBe(500);
    const made = writeTokens(h);
    expect(made).toHaveLength(1);
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
  });

  // review of #790, point 7: the build fails after the token was made, before the input exists.
  it("is switched off when the input cannot be built after the token was made", async () => {
    const h = await start({
      modelCapabilities: {
        // A native model reads no metadata; the window of a managed one is asked for last, after the token exists.
        check: () => Promise.reject(new Error("not asked")),
        lastKnownContextLength: () => {
          throw new Error("the window cannot be read");
        },
      },
    });
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);

    const response = await fetchAgain(h, split);

    expect(response.status).toBe(500);
    const made = writeTokens(h);
    expect(made).toHaveLength(1);
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
  });

  // review of #790, point 7: the token in hand is switched off whatever the ledger says.
  it("is switched off when the ledger cannot remember it either", async () => {
    const h = await start({
      wrapClaimedKeys: (keys) => ({
        ...keys,
        rememberGitToken: () => Promise.reject(new Error("the ledger is down")),
      }),
    });
    const { jobId } = await h.turn();
    const split = await h.claimedSplit(DISPATCHER);

    const response = await fetchAgain(h, split);

    expect(response.status).toBe(500);
    const made = writeTokens(h);
    expect(made).toHaveLength(1);
    expect(h.fake.revokedInstallationTokens()).toEqual(made);
    expect(await h.queue.get(jobId)).toMatchObject({ status: "queued" });
  });
});
