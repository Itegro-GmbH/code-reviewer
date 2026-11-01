// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the runner API on the running server: the real database, queue, registry and
// settings from the environment. This is the one place that decides which claim guard and which
// source of job options are used (see README.md for what replaces them when the projects land).
import "server-only";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createCatalogService } from "../model-catalog/service.ts";
import { configuredLlmModel } from "../llm/config.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { builtInProjectDynamicSettings } from "../review-settings/settings.ts";
import { managedModelsOf } from "./managed-models.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { createJobsRepository } from "../db/repositories/jobs-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createPinnedAddressReader } from "../review-settings/pinned-addresses.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createJobVmRunsRepository } from "../db/repositories/job-vm-runs-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { jobEnded, touched } from "../dispatch/maintenance-shared.ts";
import { getRunnerQueue } from "../jobs/shared.ts";
import { readEntitlements } from "../workspaces/effective-entitlements.ts";
import { getWorkspaceLlm, modelCapabilities } from "../llm/shared.ts";
import { getNativeCost } from "../native-cost/shared.ts";
import { projectServiceFor } from "../projects/shared.ts";
import { reviewSettingsServiceFor } from "../review-settings/shared.ts";
import { noteDispatcherClaim } from "../billing/dispatcher-features.ts";
import { createRunnerApi, type RunnerApi } from "./api.ts";
import { createProviderPins } from "./provider-pins.ts";
import { knownContextWindowFrom } from "./known-context-window.ts";
import { APP_VERSION } from "./app-version.ts";
import {
  createWorkerApi,
  type WorkerApi,
  type WorkerApiDeps,
} from "./worker-api.ts";
import { createProjectClaimGuard } from "./project-claim-guard.ts";
import { HEARTBEAT_INTERVAL_SECONDS } from "./contract.ts";
import { createReviewSettingsJobOptionsSource } from "./review-settings-job-options.ts";
import { consoleRunnerApiLogger, describeError } from "./logger.ts";
import { createKnownSecrets } from "./known-secrets.ts";
import { getClaimedKeys, getWriteTokens } from "./claimed-keys-shared.ts";
import { errorResponse } from "./responses.ts";
import { configuredRunnerToken } from "./token-auth.ts";

/**
 * The collaborators both APIs share: the runner API (claim, heartbeat, complete) and the Worker API
 * (#320, details, heartbeat, result) are two doors to the same queue, checks and redaction.
 */
function sharedDeps(): WorkerApiDeps {
  const db = getDatabase();
  // #432: the model catalog. A claim reads it for a workspace on the operator's key only (an entry and the instance
  // defaults), and the masking of a result reads the model ids of every entry. The claim never writes it.
  const catalog = createCatalogService({
    catalog: createCatalogRepository(db),
    settings: createInstanceSettingsRepository(db),
    modelCapabilities,
    logger: { info: (line) => console.info(line) },
  });
  const llm = getWorkspaceLlm();
  const nativeCost = getNativeCost();
  const claimedKeys = getClaimedKeys();
  const writeTokens = getWriteTokens();
  const repositories = (workspaceId: string) =>
    createRepositoriesRepository(db, workspaceId);
  const integrations = (workspaceId: string) =>
    createIntegrationsRepository(db, workspaceId);
  return {
    // Runners serve the whole instance: the queue is not scoped, and everything the claim looks up
    // for a job is looked up in the job's own workspace.
    queue: getRunnerQueue(),
    repositories,
    integrations,
    // #199: the exact head of the last successful Dynamic review of the job's pull request; the
    // lookup is scoped to the job's own workspace.
    previousReviewedSha: (job) =>
      createJobsRepository(db, job.workspaceId).previousReviewedSha({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        reviewKind: job.reviewKind,
        excludeJobId: job.id,
      }),
    // #255: the heads of its earlier jobs that did not succeed, which may have written the summary.
    attemptedShas: (job) =>
      createJobsRepository(db, job.workspaceId).attemptedShas({
        repositoryId: job.repositoryId,
        prNumber: job.prNumber,
        reviewKind: job.reviewKind,
        excludeJobId: job.id,
      }),
    registry: integrationRegistry,
    // A job runs only while its repository has an active project; see claim-guard.ts.
    guard: createProjectClaimGuard({ projects: projectServiceFor }),
    // The review settings of the project over the global defaults; see job-options.ts.
    jobOptions: createReviewSettingsJobOptionsSource({
      settings: reviewSettingsServiceFor,
    }),
    // The key the selection of the claimed job names, of the job's own workspace: its own key of the selected provider, or
    // the operator's key of it, never another workspace's and never the other key (src/llm).
    // #689: the most one review may cost, from the admin portal; read at each job, so a change reaches the next one.
    operatorCostLimitCents: operatorCostLimitCentsFrom(db),
    keyFor: (workspaceId, selection) => llm.keyFor(workspaceId, selection),
    // The standing of the job's workspace, asked by the Worker's fetch before it hands out a key (#276), and its model access.
    entitlementsFor: (workspaceId) => readEntitlements(db, workspaceId),
    // Whose key the job runs on: what its claim decided, in its usage record (#496); scoped to the job's own workspace.
    // #753: the turn an implementer job runs, from the job's own workspace.
    implementerTurn: (job) =>
      createImplementerRepository(getDatabase(), job.workspaceId).getTurnByJob(
        job.id,
      ),
    claimedKeyMode: async (job) =>
      (await createUsageRecordsRepository(db, job.workspaceId).get(job.id))
        ?.keyMode,
    // #432: the provider and the catalog entry of the job (id and name as they are now), in its usage record; never the model.
    recordSelection: (job, selection) =>
      createUsageRecordsRepository(db, job.workspaceId).setSelection(job.id, {
        provider: selection.provider,
        catalogEntry:
          selection.keyMode === "managed"
            ? { id: selection.entry.id, name: selection.entry.name }
            : null,
      }),
    catalog,
    // The model of a kind when no layer sets one: read for every claim, so a changed LLM_MODEL reaches the next job.
    builtInModel: (kind) =>
      kind === "diff"
        ? configuredLlmModel(process.env)
        : builtInProjectDynamicSettings().dynamicModel,
    // Whether the job ran on the operator's key, and every model id of the catalog, for masking the result.
    managedModels: managedModelsOf({
      usage: (job) =>
        createUsageRecordsRepository(db, job.workspaceId).get(job.id),
      catalog,
    }),
    // #279: the metadata of a job's model (Dynamic, and a managed entry's), read when its claim is built.
    modelCapabilities,
    // #689: the window of a Diff job's model on the workspace's own key, from the public catalog the app keeps; the provider is not asked.
    knownContextWindow: knownContextWindowFrom(db),
    // #553: the cost policy and the entry of a native job. A provider outside the registry (#555) is always native, there is no
    // legacy wire for it; the two registry providers are native only while the switch of the native path is on (#578).
    nativeCost,
    // #588: a selection of a catalog provider made before pins existed is pinned by its first claim, in the job's own workspace.
    providerPins: createProviderPins(reviewSettingsServiceFor),
    claimedKeys,
    // #753: the write token of a turn of the Implementer ends with the turn (and with a fetch that failed after it was made).
    revokeWriteTokens: writeTokens.revokeAllOf,
    revokeUndelivered: writeTokens.revokeUndelivered,
    // #790: the addresses the workspace's projects pinned, which a turn's catalog provider is held to.
    pinnedAddresses: (workspaceId, slug) =>
      createPinnedAddressReader(createProjectsRepository(db, workspaceId))(
        slug,
      ),
    // #395: what happens between two sweeps. Both run after the response and do nothing in poll mode.
    jobEnded,
    activity: () => touched(),
    now: () => new Date(),
    logger: consoleRunnerApiLogger,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
    // The runner token and the current LLM key of the job's workspace (the key of the claim is in the database).
    // Fails closed (known-secrets.ts): a key that cannot be read fails the completion instead of masking less.
    knownSecrets: createKnownSecrets({
      env: process.env,
      currentKeysFor: (workspaceId) => llm.currentKeysFor(workspaceId),
    }),
  };
}

/** The runner API of the running server. */
export function getRunnerApi(): RunnerApi {
  return createRunnerApi({
    ...sharedDeps(),
    // #493: where a Dispatcher says it created the VM of a claim; scoped to the job's own workspace. The Worker API has
    // no such call.
    vmRuns: (workspaceId) =>
      createJobVmRunsRepository(getDatabase(), workspaceId),
    runnerToken: () => configuredRunnerToken(process.env),
    appVersion: APP_VERSION,
    // #498: which Dispatchers this app serves (billing is not switched on over one that reports no VMs).
    noteClaimFeatures: (features) =>
      noteDispatcherClaim(getDatabase(), features),
  });
}

/** The Worker API of the running server (#320). It has no use for `RUNNER_TOKEN`: a per-job credential opens it. */
export function getWorkerApi(): WorkerApi {
  return createWorkerApi(sharedDeps());
}

/**
 * What the route files call: builds the API and runs one call. If building it fails (the database
 * was not opened, say), the caller gets the same kind of answer as for any other unplanned failure,
 * with `no-store` and an error body, and the log gets the cause.
 */
export async function withRunnerApi(
  call: (api: RunnerApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await call(getRunnerApi());
  } catch (error) {
    consoleRunnerApiLogger.error(
      `[runner-api] the API could not be set up: ${describeError(error)}`,
    );
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }
}

/** What the Worker API's route files call; the same kind of answer as `withRunnerApi` if it cannot be set up. */
export async function withWorkerApi(
  call: (api: WorkerApi) => Promise<Response>,
): Promise<Response> {
  try {
    return await call(getWorkerApi());
  } catch (error) {
    consoleRunnerApiLogger.error(
      `[worker-api] the API could not be set up: ${describeError(error)}`,
    );
    return errorResponse(500, "RUNNER_INTERNAL_ERROR");
  }
}
