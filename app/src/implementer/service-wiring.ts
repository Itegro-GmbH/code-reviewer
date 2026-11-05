// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the Implementer service for one workspace: the real database, registry, key store and model catalogs, with the job
// queue handed in. It does not import the queues of the running server (`jobs/shared.ts`), so the code those queues run when a turn
// ends (`follow-up-shared.ts`, #841) can build the service too without an import cycle.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import type { JobQueue } from "../jobs/job-queue.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import { getWorkspaceLlm } from "../llm/shared.ts";
import { getCatalogService } from "../model-catalog/shared.ts";
import { getImplementerCatalog } from "../native-providers/shared.ts";
import { getNativeCost } from "../native-cost/shared.ts";
import { catalogSelectionFrom } from "../review-settings/catalog-selection.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import {
  entryAllowed,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import { configuredKeyProviders } from "./key-providers.ts";
import { createImplementerModels, type ImplementerModels } from "./models.ts";
import {
  createImplementerService,
  type ImplementerService,
} from "./service.ts";

/**
 * The models a workspace can run a task on, as the claim would: the rule of the picker and of the submit. The profiles of the
 * workspace (#843) check their model with the same rule when they are saved.
 */
export function implementerModelsFor(workspaceId: string): ImplementerModels {
  const db = getDatabase();
  const catalog = getCatalogService();
  const nativeCost = getNativeCost();
  const keys = getWorkspaceLlm().keyServiceFor(workspaceId);
  // The key mode and every entry of the picker ask about the same entitlements, so they are read once, on first use.
  let entitlements: Promise<ResolvedEntitlements> | undefined;
  const readEntitlements = () =>
    (entitlements ??= readEffectiveEntitlements(db, workspaceId));
  return createImplementerModels({
    keyMode: async () => keyModeForJob(await readEntitlements()),
    configuredProviders: () => configuredKeyProviders(keys),
    nativeCatalog: getImplementerCatalog(),
    catalog: catalogSelectionFrom(catalog, async (id) =>
      entryAllowed(await readEntitlements(), { id }),
    ),
    // What the claim does with the entry of a job on the operator's key (src/runner-api/claim.ts, `costOf`): the model
    // must be one the native path knows, have a confirmed price, and have an entry the catalog can describe.
    entryUsable: async (id) => {
      const entry = await catalog.get(id);
      if (entry === undefined) return false;
      const ref = nativeCost.refOf({
        provider: entry.provider,
        model: entry.modelId,
      });
      if (ref === null) return false;
      if (!(await nativeCost.policyFor("managed", ref)).ok) return false;
      return (await nativeCost.entryFor(ref)).ok;
    },
  });
}

/** The Implementer service of one workspace, on the job queue handed in. */
export function implementerServiceWith(
  workspaceId: string,
  queue: JobQueue,
): ImplementerService {
  const db = getDatabase();
  return createImplementerService({
    repositories: createRepositoriesRepository(db, workspaceId),
    integrations: createIntegrationsRepository(db, workspaceId),
    registry: integrationRegistry,
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    profiles: createProfilesRepository(db, workspaceId),
    sessions: createImplementerRepository(db, workspaceId),
    steps: createImplementerStepsRepository(db, workspaceId),
    models: implementerModelsFor(workspaceId),
    queue,
    operatorCostLimitCents: operatorCostLimitCentsFrom(db),
  });
}
