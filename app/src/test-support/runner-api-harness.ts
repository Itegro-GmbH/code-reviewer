// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the runner API needs: a real Postgres database with the job queue and one
// integration (installation 4242, repositories acme/widgets and acme/gadgets), the fake GitHub behind
// the real GitHub App provider, and the API itself wired to all of them. `claim`, `heartbeat` and
// `complete` build requests like the runner does. The clock of the queue is the one in `clock`.
import { getProductIdentity } from "../product-identity/current.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { managedModelsOf } from "../runner-api/managed-models.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createCapabilitySet } from "../capabilities/capability.ts";
import { createJobQueue } from "../jobs/job-queue.ts";
import type { EnqueueImplementerTurnInput } from "../jobs/job-types.ts";
import { addUser } from "./workspace-deletion-fixture.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createDefaultIntegrationRegistry } from "../integrations/registry.ts";
import { loadGithubAppConfig } from "../integrations/registry.ts";
import type { JobQueueLimits } from "../db/job-limits.ts";
import type { LlmAccessResult } from "../llm/access.ts";
import { createWorkspaceLlm } from "../llm/assemble.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import type { LlmProviderDescriptor } from "../llm/providers/types.ts";
import { createCatalogFixture } from "./review-settings-harness.ts";
import type { CatalogEntry } from "../model-catalog/entries.ts";
import type { ProjectReviewKind } from "../job-kind/job-kind.ts";
import type { ModelCapabilityChecker } from "../llm/model-capabilities.ts";
import { noteDispatcherClaim } from "../billing/dispatcher-features.ts";
import { createRunnerApi } from "../runner-api/api.ts";
import type { ClaimDeps } from "../runner-api/claim.ts";
import {
  createWorkerApi,
  type WorkerApiDeps,
} from "../runner-api/worker-api.ts";
import {
  allowAllClaimGuard,
  type ClaimGuard,
} from "../runner-api/claim-guard.ts";
import type {
  ClaimResponse,
  RunnerResult,
  SplitClaimResponse,
  WorkerJobDetailsResponse,
} from "../runner-api/contract.ts";
import {
  emptyJobOptionsSource,
  type JobOptionsSource,
} from "../runner-api/job-options.ts";
import {
  createClaimedKeys,
  type ClaimedKeys,
} from "../runner-api/claimed-keys.ts";
import { createWriteTokens } from "../runner-api/write-token.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import { createPinnedAddressReader } from "../review-settings/pinned-addresses.ts";
import { createProjectClaimGuard } from "../runner-api/project-claim-guard.ts";
import { createKnownSecrets } from "../runner-api/known-secrets.ts";
import { knownContextWindowFrom } from "../runner-api/known-context-window.ts";
import { createReviewSettingsJobOptionsSource } from "../runner-api/review-settings-job-options.ts";
import { configuredRunnerToken } from "../runner-api/token-auth.ts";
import type { RunnerApiLogger } from "../runner-api/logger.ts";
import type { ReportDeps } from "../runner-api/report.ts";
import { createAppSettingsRepository } from "../db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createJobProjectHooks } from "../jobs/project-hooks.ts";
import { createProjectService } from "../projects/service.ts";
import { assembleRefusalNoticeService } from "../refusal-notices/assemble.ts";
import type {
  NoticeRefusal,
  RefusalNoticeService,
} from "../refusal-notices/service.ts";
import { createReviewSettingsService } from "../review-settings/service.ts";
import { catalogSelectionFrom } from "../review-settings/catalog-selection.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import type { Selection } from "../llm/selection.ts";
import { entryAllowed } from "../workspaces/entitlements.ts";
import { builtInReviewSettings } from "../review-settings/settings.ts";
import { startGithubAppHarness } from "./github-app-harness.ts";
import {
  readEffectiveEntitlements,
  readEntitlements,
} from "../workspaces/effective-entitlements.ts";
import { TEST_APP_SLUG } from "./github-app.ts";
import { createJobQueueFixture, sha, type TestQueue } from "./jobs.ts";
import type { NativeSelectionSource } from "../native-providers/catalog.ts";
import {
  createProviderPins,
  type ProviderPins,
} from "../runner-api/provider-pins.ts";

export const TEST_RUNNER_TOKEN = "test-runner-token-4f9c2a7e1b-0d58a3c6e9f2";
export const TEST_LLM_API_KEY = "test-llm-api-key-8d3b6e0a5c";
export const TEST_LLM_MODEL = "vendor/test-model";
export const TEST_APP_VERSION = "0.0.0-test";
export const TEST_APP_SECRET = "runner-api-test-app-secret-0123456789-0123";

export type RequestOptions = {
  /** Sent as `Authorization: Bearer <token>`. Default: the right token. `null` sends no header. */
  token?: string | null;
  /** The whole header value, for another scheme or an empty `Bearer`. Wins over `token`. */
  authorization?: string | null;
  /** `X-Runner-Id`. Default `runner-a`. `null` leaves the header out. */
  runnerId?: string | null;
  /**
   * #195: the engines sent in the claim body. Left out, the request has no body at all, which is how
   * a previous-release runner asks and means `pr-agent`. An empty array is an (invalid) explicit list.
   */
  engines?: string[];
  /** #279: the features sent in the claim body next to the engines (`dynamic_capabilities`). */
  features?: string[];
  /** #424: the LLM providers a runner advertises in the claim body. Any value, so a test can send an invalid one. */
  llmProviders?: unknown;
  /** #322: the job a Dispatcher claims. Sent in the claim body; the engines then default to `pr-agent`. */
  jobId?: string;
  /** #322: the pool cap. Sent in the claim body. Any value, so a test can send an invalid one. */
  maxRunning?: unknown;
};

export async function startRunnerApiHarness(
  options: {
    guard?: ClaimGuard;
    jobOptions?: JobOptionsSource;
    /**
     * Wires the guard and the job options like the running server does: a job runs only while its
     * repository has an active project, and its options are the review settings. Explicit `guard` and
     * `jobOptions` win. Without this, every job may run and has no extra options.
     */
    projects?: boolean;
    /** Wraps the job queue the API uses, for example to make one call fail. */
    wrapQueue?: (queue: TestQueue) => TestQueue;
    /** #395: what the running server does when a job ends or a call touched the database. */
    hooks?: Pick<ReportDeps, "jobEnded" | "activity">;
    limits?: Partial<JobQueueLimits>;
    /** Replaces or (with undefined) removes variables of the app's environment. */
    env?: Record<string, string | undefined>;
    /**
     * The LLM key of the workspace the jobs belong to, as an Owner or an Admin saved it (the key service of
     * the workspace). Default: `TEST_LLM_API_KEY`. `null`: the workspace has none.
     */
    llmKey?: string | null;
    /** Replaces how the keys to mask in a result are read (for example to make the read of one provider's key fail). */
    currentKeysFor?: (workspaceId: string) => Promise<readonly string[]>;
    /** Replaces how the claim loads the key of a selection (for example to answer with the operator's key, or to count the loads). */
    loadLlm?: (workspaceId: string) => Promise<LlmAccessResult>;
    /** #588: told each time the claim loads a key (the selection it loads for), before the real load; a refusal must not reach it. */
    onKeyLoad?: (workspaceId: string, selection: Selection) => void;
    /** #588: where a claim adopts the address of a legacy selection; default: the settings of the job's workspace, as on the running server. */
    providerPins?: ProviderPins;
    /** #279: where a Dynamic claim reads the model metadata from. Left out, the claim reads none. */
    modelCapabilities?: ModelCapabilityChecker;
    /** #553: the cost policy of a native job (`ClaimDeps.nativeCost`). Left out, no job is native, as on the running server today. */
    nativeCost?: ClaimDeps["nativeCost"];
    /**
     * #555: the catalog of providers and models a project may pick for Dynamic Review (the save of the settings). The claim
     * serves the model from `nativeCost.entryFor`, never from this reader.
     */
    nativeCatalog?: NativeSelectionSource;
    /**
     * #432: the providers of the app, for a test that brings a second one (`createFakeAdapter`). The key services, the
     * claim and the selection all use it. Default: the registry of the app.
     */
    providers?: {
      readonly ids: readonly string[];
      readonly defaultProvider: LlmProviderDescriptor;
      find(raw: unknown): LlmProviderDescriptor | undefined;
    };
    /**
     * #432: whether the harness makes one released catalog entry that serves both kinds and is the instance default of
     * both, so a job on the operator's key can run without the test setting a catalog up. Default: true. A test about
     * the catalog turns it off and builds its own entries (`h.catalogFixture.entry`, `h.setCatalogDefaults`).
     */
    defaultEntry?: boolean;
    /**
     * #753: the deployment is a factory with the Implementer: the registry's capabilities hold `implementer`, the fake App asks
     * for contents write and the installation has accepted it (`h.enqueueTurn` makes a turn). Default: a code-review.com
     * deployment, which can never make the write token.
     */
    implementer?: boolean;
    /** #753: wraps what the API remembers about a job, for a test that makes one call fail (for example the write token ledger). */
    wrapClaimedKeys?: (keys: ClaimedKeys) => ClaimedKeys;
    /** #790: the addresses the workspace's projects pinned for a catalog provider. Default: read from the projects, as on the server. */
    pinnedAddresses?: ClaimDeps["pinnedAddresses"];
    /**
     * #281: wires the notice of a refused review like the running server does (`h.notices`). With
     * `deliver: "manual"` the refusals are only collected (`h.notices.refusals`) and the test hands them on.
     */
    refusalNotices?: {
      deliver?: "claim" | "manual";
      /** The link to the plan page of a workspace; default none. */
      planPageUrl?: (
        workspaceSlug: string,
      ) => string | null | Promise<string | null>;
      /** The link to the settings of a workspace, for a refusal for the balance (#498); default none. */
      settingsUrl?: (
        workspaceSlug: string,
      ) => string | null | Promise<string | null>;
      /** How long a request to GitHub may take. */
      githubRequestTimeoutMs?: number;
    };
  } = {},
) {
  const noticeOptions = options.refusalNotices;
  const refusals: NoticeRefusal[] = [];
  const noticeWork: Promise<void>[] = [];
  let noticeService: RefusalNoticeService | undefined;
  // #790: what the running server does when the claim of a job ended, for a turn of the Implementer: its write tokens are switched off
  // (after the response there; `h.writeTokensSettled()` waits for it here).
  const endedWork: Promise<void>[] = [];
  let onEnded: ((jobIds: readonly string[]) => void) | undefined;
  const fixture = await createJobQueueFixture({
    onClaimsEnded: (jobIds) => onEnded?.(jobIds),
    ...(noticeOptions === undefined
      ? {}
      : {
          onRefused: (refusal: NoticeRefusal) => {
            refusals.push(refusal);
            if (noticeOptions.deliver === "manual") return;
            if (noticeService !== undefined)
              noticeWork.push(noticeService.onRefused(refusal));
          },
        }),
    // The runner API tests exercise routing by engines; the Dynamic Review rollout gate (#195) is
    // covered by the queue tests, so the harness enables it.
    dynamicReview: true,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  // With the notice wired, the comments of the fake are authored as the slug of the app's own configuration,
  // which is how the provider recognizes the app's own comment (`<slug>[bot]`).
  const github = await startGithubAppHarness(
    noticeOptions === undefined ? {} : { appSlug: TEST_APP_SLUG },
  );
  github.fake.addInstallation({
    id: 4242,
    account: { login: "acme", id: 5001, type: "Organization" },
  });
  github.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/gadgets" },
  ]);
  const pullRequests = [
    { number: 7, state: "open", headSha: sha("a") },
    { number: 8, state: "open", headSha: sha("b") },
    { number: 9, state: "closed", headSha: sha("c") },
    { number: 10, state: "closed", merged: true, headSha: sha("d") },
  ] as const;
  for (const repository of ["acme/widgets", "acme/gadgets"])
    for (const pullRequest of pullRequests)
      github.fake.addPullRequest(repository, {
        title: `Change ${pullRequest.number}`,
        headRef: `feature/change-${pullRequest.number}`,
        baseRef: "main",
        author: { login: "alice", id: 1001 },
        ...pullRequest,
      });
  const repository = await createRepositoriesRepository(
    fixture.db,
    fixture.workspaceId,
    fixture.clock.now,
  ).get(fixture.repositoryId);
  if (repository === undefined)
    throw new Error("The fixture repository is missing.");

  /** The tokens GitHub created for jobs: the requests that named a repository. */
  function issuedJobTokens(): string[] {
    const requests = github.fake.tokenRequests();
    return github.fake
      .issuedInstallationTokens()
      .filter((_, index) => requests[index]?.repositoryIds != null);
  }

  /** The app's environment as the runner API reads it; change it to change the settings. */
  const env: Record<string, string | undefined> = {
    RUNNER_TOKEN: TEST_RUNNER_TOKEN,
    LLM_MODEL: TEST_LLM_MODEL,
    ...options.env,
  };

  if (options.implementer === true) {
    const write = {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "write",
    } as const;
    github.fake.setAppPermissions(write);
    github.fake.setInstallationPermissions(4242, write);
  }
  const registry = createDefaultIntegrationRegistry({
    capabilities: () =>
      createCapabilitySet(
        options.implementer === true
          ? ["review", "dynamic-review", "implementer"]
          : ["review", "dynamic-review"],
      ),
    loadConfig: () => loadGithubAppConfig(github.env),
    githubClient: {
      now: github.clock.now,
      requestTimeoutMs: noticeOptions?.githubRequestTimeoutMs ?? 5000,
    },
  });
  const infoLines: string[] = [];
  const errorLines: string[] = [];
  /** What the notice of a refused review logged (#281). */
  const noticeLines: string[] = [];
  /** One app instance's notice service; another one shares nothing but the database and GitHub. */
  const buildNoticeService = () =>
    assembleRefusalNoticeService({
      product: getProductIdentity(),
      db: fixture.db,
      registry,
      planPageUrl: noticeOptions?.planPageUrl ?? (() => null),
      ...(noticeOptions?.settingsUrl === undefined
        ? {}
        : { settingsUrl: noticeOptions.settingsUrl }),
      now: fixture.clock.now,
      log: {
        info: (line) => noticeLines.push(line),
        error: (line) => noticeLines.push(line),
      },
    });
  if (noticeOptions !== undefined) noticeService = buildNoticeService();
  const logger: RunnerApiLogger = {
    info: (line) => infoLines.push(line),
    error: (line) => errorLines.push(line),
  };
  const projectService = createProjectService({
    projects: createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    hooks: createJobProjectHooks(fixture.workspaceId),
  });
  // #432: the model catalog of the instance. The claim reads it only for a workspace on the operator's key; `catalogReads`
  // counts what it asked, so a test can pin that an own claim asks nothing.
  const providers = options.providers ?? llmProviderDescriptors;
  const catalogFixture = createCatalogFixture(fixture.db);
  const catalogReads = { count: 0 };
  const catalog = {
    get: (id: string) => {
      catalogReads.count += 1;
      return catalogFixture.service.get(id);
    },
    defaults: () => {
      catalogReads.count += 1;
      return catalogFixture.service.defaults();
    },
    allCatalogModelIds: () => {
      catalogReads.count += 1;
      return catalogFixture.service.allCatalogModelIds();
    },
  };
  let defaultEntry: CatalogEntry | undefined;
  if (options.defaultEntry !== false) {
    defaultEntry = await catalogFixture.entry({
      name: "Standard",
      modelId: "entry/default-model",
    });
    const set = await catalogFixture.service.setDefaults(
      { diff: defaultEntry.id, dynamic: defaultEntry.id },
      null,
    );
    if (!set.ok) throw new Error(`defaults refused: ${set.code}`);
  }
  const appSettings = createAppSettingsRepository(
    fixture.db,
    fixture.workspaceId,
  );
  // The settings service as the running server wires it for a workspace: a workspace on the operator's key selects
  // catalog entries and may not write a model (#283, #430), one on its own key is the other way round.
  const settingsEntitlements = () =>
    readEffectiveEntitlements(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    );
  const reviewSettings = createReviewSettingsService({
    appSettings,
    projects: createProjectsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    builtIn: () => builtInReviewSettings(configuredLlmModel(env)),
    operatorsModels: async () =>
      keyModeForJob(await settingsEntitlements()) !== "own",
    catalog: catalogSelectionFrom(catalogFixture.service, async (id) =>
      entryAllowed(await settingsEntitlements(), { id }),
    ),
    providers: options.providers ?? llmProviderDescriptors,
    // #689: a cost limit above the operator's maximum (the instance setting) is refused at the save, as on the running server.
    operatorCostLimitCents: operatorCostLimitCentsFrom(fixture.db),
    ...(options.nativeCatalog === undefined
      ? {}
      : { nativeCatalog: options.nativeCatalog }),
  });
  // One app instance: its own collaborators, over the SAME database, queue and fakes. The LLM access is put
  // together as the running server does it: the key of the job's own workspace. A second instance (`anotherInstance`) shares nothing but
  // the database, which is what several app instances do.
  function buildApi() {
    const llm = createWorkspaceLlm({
      db: fixture.db,
      appSecret: () => TEST_APP_SECRET,
      env: () => env,
      now: fixture.clock.now,
      providers,
    });
    const plainClaimedKeys = createClaimedKeys({
      db: fixture.db,
      appSecret: () => TEST_APP_SECRET,
      now: fixture.clock.now,
    });
    const claimedKeys =
      options.wrapClaimedKeys?.(plainClaimedKeys) ?? plainClaimedKeys;
    const writeTokens = createWriteTokens({
      repositories: (workspaceId) =>
        createRepositoriesRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      integrations: (workspaceId) =>
        createIntegrationsRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      registry,
      claimedKeys,
      rows: createJobClaimedKeysRepository(fixture.db, fixture.clock.now),
      logger,
      // The tokens expire on the clock of GitHub's fake.
      now: () => new Date(github.clock.now()),
    });
    onEnded = (jobIds) => {
      endedWork.push(writeTokens.revokeEnded(jobIds));
    };
    const apiDeps: WorkerApiDeps = {
      queue: options.wrapQueue?.(fixture.queue) ?? fixture.queue,
      repositories: (workspaceId) =>
        createRepositoriesRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      integrations: (workspaceId) =>
        createIntegrationsRepository(
          fixture.db,
          workspaceId,
          fixture.clock.now,
        ),
      previousReviewedSha: (job) =>
        createJobsRepository(fixture.db, job.workspaceId).previousReviewedSha({
          repositoryId: job.repositoryId,
          prNumber: job.prNumber,
          reviewKind: job.reviewKind,
          excludeJobId: job.id,
        }),
      attemptedShas: (job) =>
        createJobsRepository(fixture.db, job.workspaceId).attemptedShas({
          repositoryId: job.repositoryId,
          prNumber: job.prNumber,
          reviewKind: job.reviewKind,
          excludeJobId: job.id,
        }),
      registry,
      guard:
        options.guard ??
        (options.projects === true
          ? createProjectClaimGuard({ projects: () => projectService })
          : allowAllClaimGuard),
      jobOptions:
        options.jobOptions ??
        (options.projects === true
          ? createReviewSettingsJobOptionsSource({
              settings: () => reviewSettings,
            })
          : emptyJobOptionsSource),
      // #689: as on the running server, the operator's maximum is the instance setting (1.00 USD until a test sets it).
      operatorCostLimitCents: operatorCostLimitCentsFrom(fixture.db),
      keyFor:
        options.loadLlm !== undefined
          ? (workspaceId) => options.loadLlm!(workspaceId)
          : (workspaceId, selection) => {
              options.onKeyLoad?.(workspaceId, selection);
              return llm.keyFor(workspaceId, selection);
            },
      recordSelection: (job, selection) =>
        createUsageRecordsRepository(
          fixture.db,
          job.workspaceId,
          fixture.clock.now,
        ).setSelection(job.id, {
          provider: selection.provider,
          catalogEntry:
            selection.keyMode === "managed"
              ? { id: selection.entry.id, name: selection.entry.name }
              : null,
        }),
      catalog,
      providers,
      builtInModel: (kind) =>
        kind === "diff"
          ? configuredLlmModel(env)
          : llmProviderDescriptors.defaultProvider.defaultModels.dynamic,
      managedModels: managedModelsOf({
        usage: (job) =>
          createUsageRecordsRepository(
            fixture.db,
            job.workspaceId,
            fixture.clock.now,
          ).get(job.id),
        catalog,
      }),
      entitlementsFor: (workspaceId) =>
        readEntitlements(fixture.db, workspaceId, fixture.clock.now),
      implementerTurn: (job) =>
        createImplementerRepository(fixture.db, job.workspaceId).getTurnByJob(
          job.id,
        ),
      claimedKeyMode: async (job) =>
        (
          await createUsageRecordsRepository(
            fixture.db,
            job.workspaceId,
            fixture.clock.now,
          ).get(job.id)
        )?.keyMode,
      knownContextWindow: knownContextWindowFrom(fixture.db),
      ...(options.modelCapabilities === undefined
        ? {}
        : { modelCapabilities: options.modelCapabilities }),
      ...(options.nativeCost === undefined
        ? {}
        : { nativeCost: options.nativeCost }),
      providerPins:
        options.providerPins ?? createProviderPins(() => reviewSettings),
      claimedKeys,
      revokeWriteTokens: writeTokens.revokeAllOf,
      revokeUndelivered: writeTokens.revokeUndelivered,
      pinnedAddresses:
        options.pinnedAddresses ??
        ((workspaceId, slug) =>
          createPinnedAddressReader(
            createProjectsRepository(
              fixture.db,
              workspaceId,
              fixture.clock.now,
            ),
          )(slug)),
      ...(options.hooks ?? {}),
      now: fixture.clock.now,
      logger,
      heartbeatIntervalSeconds: 30,
      knownSecrets: createKnownSecrets({
        env,
        currentKeysFor:
          options.currentKeysFor ??
          ((workspaceId) => llm.currentKeysFor(workspaceId)),
      }),
    };
    const api = createRunnerApi({
      ...apiDeps,
      vmRuns: (workspaceId) =>
        createJobVmRunsRepository(fixture.db, workspaceId, fixture.clock.now),
      runnerToken: () => configuredRunnerToken(env),
      appVersion: TEST_APP_VERSION,
      noteClaimFeatures: (features) =>
        noteDispatcherClaim(fixture.db, features, fixture.clock.now()),
    });
    // #320: the Worker API over the same collaborators (it has no dispatcher credential).
    const workerApi = createWorkerApi(apiDeps);
    return { api, workerApi, llm, claimedKeys, writeTokens };
  }
  const { api, workerApi, llm, claimedKeys, writeTokens } = buildApi();
  /** Saves (or, with null, removes) the LLM key of the workspace of the jobs, for a provider (default: the first one). */
  async function setLlmKey(
    key: string | null,
    provider: string = llmProviderDescriptors.defaultProvider.id,
  ): Promise<void> {
    const keys = llm.keyServiceFor(fixture.workspaceId);
    if (key === null) {
      await keys.remove(provider);
      return;
    }
    const saved = await keys.save({ provider, apiKey: key }, null);
    if (!saved.ok) throw new Error("The test LLM key was refused.");
  }
  await setLlmKey(
    options.llmKey === undefined ? TEST_LLM_API_KEY : options.llmKey,
  );

  function headers(
    request: RequestOptions,
    extra: Record<string, string> = {},
  ): Headers {
    const result = new Headers(extra);
    const authorization =
      request.authorization !== undefined
        ? request.authorization
        : request.token === null
          ? null
          : `Bearer ${request.token ?? TEST_RUNNER_TOKEN}`;
    if (authorization !== null) result.set("authorization", authorization);
    if (request.runnerId !== null)
      result.set("x-runner-id", request.runnerId ?? "runner-a");
    return result;
  }

  const url = "https://app.test/api/runners/v1";

  function claim(request: RequestOptions = {}): Promise<Response> {
    return api.claim(claimRequest(request));
  }

  /** The claim request of the runner: no body, or the engines (#195) and features (#279) it advertises. */
  function claimRequest(request: RequestOptions): Request {
    if (
      request.engines === undefined &&
      request.llmProviders === undefined &&
      request.jobId === undefined &&
      request.maxRunning === undefined
    )
      return new Request(`${url}/claim`, {
        method: "POST",
        headers: headers(request),
      });
    return new Request(`${url}/claim`, {
      method: "POST",
      headers: headers(request, { "content-type": "application/json" }),
      body: JSON.stringify({
        ...(request.engines === undefined ? {} : { engines: request.engines }),
        ...(request.features === undefined
          ? {}
          : { features: request.features }),
        ...(request.llmProviders === undefined
          ? {}
          : { llmProviders: request.llmProviders }),
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        ...(request.maxRunning === undefined
          ? {}
          : { maxRunning: request.maxRunning }),
      }),
    });
  }

  /** #322: the release of a Dispatcher: `body` is sent as JSON, or as it is if it is a string. */
  function release(
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
    target: typeof api = api,
  ): Promise<Response> {
    return target.release(
      new Request(`${url}/jobs/${jobId}/release`, {
        method: "POST",
        headers: headers(request, { "content-type": "application/json" }),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      jobId,
    );
  }

  /** #493: the report of a VM start by a Dispatcher: `body` is sent as JSON, or as it is if it is a string. */
  function vmStart(
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
    target: typeof api = api,
  ): Promise<Response> {
    return target.vmStart(
      new Request(`${url}/jobs/${jobId}/vm`, {
        method: "POST",
        headers: headers(request, { "content-type": "application/json" }),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      jobId,
    );
  }

  /** #364: the job state call of a Dispatcher (`GET /jobs/{id}`). */
  function jobState(
    jobId: string,
    request: RequestOptions = {},
  ): Promise<Response> {
    return api.jobState(
      new Request(`${url}/jobs/${jobId}`, {
        method: "GET",
        headers: headers(request),
      }),
      jobId,
    );
  }

  /** #322: the version call of a Dispatcher. */
  function version(
    request: RequestOptions & { query?: string } = {},
  ): Promise<Response> {
    return api.version(
      new Request(`${url}/version${request.query ?? ""}`, {
        method: "GET",
        headers: headers(request),
      }),
    );
  }

  function postTo(
    target: typeof api,
    action: "heartbeat" | "complete",
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
  ): Promise<Response> {
    const call = new Request(`${url}/jobs/${jobId}/${action}`, {
      method: "POST",
      headers: headers(request, { "content-type": "application/json" }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return action === "heartbeat"
      ? target.heartbeat(call, jobId)
      : target.complete(call, jobId);
  }

  /** `body` is sent as JSON, or as it is if it is a string. */
  const post = (
    action: "heartbeat" | "complete",
    jobId: string,
    body: unknown,
    request: RequestOptions = {},
  ) => postTo(api, action, jobId, body, request);

  /**
   * Another app instance over the same database (nothing in memory is shared with the first): for the tests
   * of what must work whichever instance serves a call.
   */
  function anotherInstance() {
    const other = buildApi();
    return {
      claimedKeys: other.claimedKeys,
      workerApi: other.workerApi,
      claim: (request: RequestOptions = {}) =>
        other.api.claim(claimRequest(request)),
      release: (jobId: string, body: unknown, request: RequestOptions = {}) =>
        release(jobId, body, request, other.api),
      complete: (
        jobId: string,
        leaseToken: string,
        result: Partial<RunnerResult> = {},
        request?: RequestOptions,
      ) =>
        postTo(
          other.api,
          "complete",
          jobId,
          { leaseToken, result: goodResult(result) },
          request,
        ),
    };
  }

  const heartbeat = (
    jobId: string,
    leaseToken: string,
    request?: RequestOptions,
  ) => post("heartbeat", jobId, { leaseToken }, request);

  const complete = (
    jobId: string,
    leaseToken: string,
    result: Partial<RunnerResult> = {},
    request?: RequestOptions,
  ) =>
    post(
      "complete",
      jobId,
      { leaseToken, result: goodResult(result) },
      request,
    );

  /** Every row of the jobs table, for "nothing changed" assertions. */
  const snapshotJobs = () =>
    fixture.db.selectFrom("jobs").selectAll().orderBy("id").execute();

  const workerUrl = "https://app.test/api/workers/v1";

  /** What a Worker sends: the bearer credential, nothing else (no runner id). */
  function workerHeaders(
    credential: string | null,
    extra: Record<string, string> = {},
  ): Headers {
    const result = new Headers(extra);
    if (credential !== null)
      result.set("authorization", `Bearer ${credential}`);
    return result;
  }

  /** The claim of a Dispatcher: the dispatcher credential and the feature `worker_credential` (#320). */
  function claimSplit(
    request: RequestOptions & { engines?: string[] } = {},
    target: typeof api = api,
  ): Promise<Response> {
    return target.claim(
      claimRequest({
        engines: ["pr-agent"],
        ...request,
        features: ["worker_credential", ...(request.features ?? [])],
      }),
    );
  }

  /** Claims the next job as a Dispatcher and returns the parsed split answer. */
  async function claimedSplit(
    request?: RequestOptions & { engines?: string[] },
  ): Promise<SplitClaimResponse> {
    const response = await claimSplit(request);
    if (response.status !== 200)
      throw new Error(`Expected a job, got ${response.status}.`);
    return (await response.json()) as SplitClaimResponse;
  }

  /** The Worker API as a Worker calls it. `credential: null` sends no header. */
  const worker = {
    details: (
      jobId: string,
      credential: string | null,
      features?: string,
      target: typeof workerApi = workerApi,
      llmProviders?: string,
    ) =>
      target.details(
        new Request(
          `${workerUrl}/jobs/${jobId}${detailsQuery(features, llmProviders)}`,
          { method: "GET", headers: workerHeaders(credential) },
        ),
        jobId,
      ),
    heartbeat: (
      jobId: string,
      credential: string | null,
      body: string = "{}",
    ) =>
      workerApi.heartbeat(
        new Request(`${workerUrl}/jobs/${jobId}/heartbeat`, {
          method: "POST",
          headers: workerHeaders(credential, {
            "content-type": "application/json",
          }),
          body,
        }),
        jobId,
      ),
    /** `body` is sent as JSON, or as it is if it is a string; a result alone is wrapped as `{ result }`. */
    result: (
      jobId: string,
      credential: string | null,
      result: Partial<RunnerResult> | string = {},
      target: typeof workerApi = workerApi,
    ) =>
      target.result(
        new Request(`${workerUrl}/jobs/${jobId}/result`, {
          method: "POST",
          headers: workerHeaders(credential, {
            "content-type": "application/json",
          }),
          body:
            typeof result === "string"
              ? result
              : JSON.stringify({ result: goodResult(result) }),
        }),
        jobId,
      ),
  };

  /** Claims as a Dispatcher and fetches the job as its Worker: the credential and the job details. */
  async function startedWorker(
    features?: string,
    llmProviders?: string,
    /** How the Dispatcher claims, for example `{ engines: ["opencode"] }` to be handed a Dynamic job. */
    request?: RequestOptions & { engines?: string[] },
  ) {
    const claim = await claimedSplit(request);
    const response = await worker.details(
      claim.job.id,
      claim.job.credential,
      features,
      undefined,
      llmProviders,
    );
    if (response.status !== 200)
      throw new Error(`Expected the job details, got ${response.status}.`);
    return {
      jobId: claim.job.id,
      credential: claim.job.credential,
      details: (await response.json()) as WorkerJobDetailsResponse,
    };
  }

  /** #753: the queue of a factory deployment, for the turns of the Implementer (the harness queue refuses the kind). */
  const turnQueue = createJobQueue(fixture.db, fixture.workspaceId, {
    now: fixture.clock.now,
    kindAllowed: (kind) =>
      createCapabilitySet([
        "review",
        "dynamic-review",
        "implementer",
      ]).allowsReviewKind(kind),
  });
  let turnCounter = 0;
  /** #753: a turn of the Implementer on the harness repository, as the submit will make it (a queued job of the kind). */
  async function enqueueTurn(
    overrides: Partial<EnqueueImplementerTurnInput> = {},
  ) {
    if (turnCounter === 0) await addUser(fixture.db, "turn-user");
    turnCounter += 1;
    fixture.clock.advance(1);
    const result = await turnQueue.enqueueImplementerTurn({
      repositoryId: fixture.repositoryId,
      baseBranch: "main",
      baseSha: sha("b"),
      branch: `implementer/t${String(turnCounter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "turn-user",
      actorLogin: "octocat",
      clientRequestId: `request-${String(turnCounter)}`,
      ...overrides,
    });
    if (result.status !== "created")
      throw new Error(`expected a new turn, got ${result.status}`);
    return result;
  }

  /** Claims the next job and returns the parsed answer. */
  async function claimed(request?: RequestOptions) {
    const response = await claim(request);
    if (response.status !== 200)
      throw new Error(`Expected a job, got ${response.status}.`);
    return (await response.json()) as ClaimResponse;
  }

  return {
    ...fixture,
    github,
    fake: github.fake,
    /** The repository that `enqueue` uses: its name and the platform's id. */
    repository: {
      fullName: repository.fullName,
      externalId: repository.externalId,
    },
    githubClock: github.clock,
    env,
    /** The LLM access of each workspace, as the claim resolves it: `llm.keyServiceFor(id).save(...)` sets a workspace key. */
    llm,
    /** #432: the model catalog (a real service on the test database) and the number of questions the claim put to it. */
    catalogFixture,
    catalogReads,
    /**
     * A released entry (or another status) for a provider of the harness's registry. The catalog service only knows the
     * providers of the app, so an entry of a test's second provider is made for the default one and moved.
     */
    catalogEntryFor: async (
      provider: string,
      entryOptions: Parameters<typeof catalogFixture.entry>[0] = {},
    ) => {
      const made = await catalogFixture.entry(entryOptions);
      if (provider === llmProviderDescriptors.defaultProvider.id) return made;
      await fixture.db
        .updateTable("model_catalog_entries")
        .set({ provider })
        .where("id", "=", made.id)
        .execute();
      return { ...made, provider };
    },
    /** The entry `defaultEntry` made, or undefined. */
    defaultEntry,
    /** Sets the instance defaults (`catalog_defaults`): an entry id per kind or null. */
    setCatalogDefaults: async (
      defaults: Record<ProjectReviewKind, string | null>,
    ) => {
      const set = await catalogFixture.service.setDefaults(defaults, null);
      if (!set.ok) throw new Error(`defaults refused: ${set.code}`);
    },
    setLlmKey,
    claimedKeys,
    registry,
    /** The project service (with the job queue's deactivation hook) and the review settings service. */
    projectService,
    reviewSettings,
    api,
    workerApi,
    worker,
    claimSplit,
    claimedSplit,
    startedWorker,
    anotherInstance,
    /** #281: the notice of a refused review. Present only when the harness was started with `refusalNotices`. */
    notices: {
      /** Every refusal the claim reported, in order. */
      refusals,
      /** The log lines of the notice. */
      lines: noticeLines,
      /** Another app instance's service over the same database. */
      another: buildNoticeService,
      /** Waits until every notice the claims started is done. */
      async settled() {
        await Promise.all(noticeWork);
      },
      service: () => {
        if (noticeService === undefined)
          throw new Error("Start the harness with refusalNotices.");
        return noticeService;
      },
      /** The comments on a pull request of the fake GitHub. */
      comments: (repoFullName: string, prNumber: number) =>
        github.fake.pullRequestComments(repoFullName, prNumber),
    },
    enqueueTurn,
    /** #790: the write token service of the first app instance (the sweep's `retryPending`, the end of a turn). */
    writeTokens,
    /** #790: waits for the write tokens that the ends of claims (the reaper, a stop) switched off after their response. */
    writeTokensSettled: async () => {
      await Promise.all(endedWork.splice(0));
    },
    claim,
    claimed,
    release,
    vmStart,
    /** #493: the VM runs of the harness workspace. */
    vmRuns: createJobVmRunsRepository(
      fixture.db,
      fixture.workspaceId,
      fixture.clock.now,
    ),
    jobState,
    version,
    heartbeat,
    complete,
    post,
    snapshotJobs,
    issuedJobTokens,
    infoLines,
    errorLines,
    /** Everything the API logged. */
    logLines: () => [...infoLines, ...errorLines],
  };
}

export type RunnerApiHarness = Awaited<
  ReturnType<typeof startRunnerApiHarness>
>;

/** A valid, successful result; any field can be replaced. */
function detailsQuery(features?: string, llmProviders?: string): string {
  const parts = [
    ...(features === undefined ? [] : [`features=${features}`]),
    ...(llmProviders === undefined ? [] : [`llmProviders=${llmProviders}`]),
  ];
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function goodResult(
  overrides: Partial<RunnerResult> = {},
): RunnerResult {
  return {
    ok: true,
    durationMs: 41250,
    commentUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1001",
    errorCode: null,
    errorMessage: null,
    logTail: "review published",
    logTruncated: false,
    usage: {
      model: TEST_LLM_MODEL,
      promptTokens: 12000,
      completionTokens: 900,
      totalTokens: 12900,
      aiCalls: 2,
      fallbackUsed: false,
      costUsd: 0.04,
      stoppedEarly: null,
    },
    ...overrides,
  };
}
