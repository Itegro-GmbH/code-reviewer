// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database, registry, key store, model catalogs and job queue behind the Implementer
// form (#755).
import "server-only";
import { notFound } from "next/navigation";
import { getCapabilities } from "../capabilities/shared.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { jobQueueFor } from "../jobs/shared.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import { getWorkspaceLlm } from "../llm/shared.ts";
import { getCatalogService } from "../model-catalog/shared.ts";
import { getNativeCatalog } from "../native-providers/shared.ts";
import { getNativeCost } from "../native-cost/shared.ts";
import { catalogSelectionFrom } from "../review-settings/catalog-selection.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { readEffectiveEntitlements } from "../workspaces/effective-entitlements.ts";
import {
  entryAllowed,
  type ResolvedEntitlements,
} from "../workspaces/entitlements.ts";
import { createImplementerModels } from "./models.ts";
import {
  createImplementerService,
  type ImplementerService,
} from "./service.ts";

/**
 * The 404 of a path that does not exist, in a deployment without the capability `implementer`. The access proxy answers such a
 * path first (src/capabilities/), with the platform's own 404 page, byte for byte the one of a path that does not exist; this is
 * the second wall for a request that reaches a route file anyway, so a deployment without the capability (code-review.com) hands
 * out nothing. Called before the session or the database is asked.
 *
 * The limit of this second wall: `notFound()` in a route handler answers an empty 404, not the HTML page of an unknown path. It
 * is reachable only past the proxy (the proxy matcher leaves the route files no gap today), and its answer still carries no
 * data; the byte-for-byte equality is the proxy's and is proved in the hosted lane (e2e/hosted/capabilities.e2e.ts).
 */
export function requireImplementerCapability(): void {
  if (!getCapabilities().has("implementer")) notFound();
}

/** The Implementer service of one workspace. */
export function implementerServiceFor(workspaceId: string): ImplementerService {
  const db = getDatabase();
  const catalog = getCatalogService();
  const nativeCost = getNativeCost();
  const keys = getWorkspaceLlm().keyServiceFor(workspaceId);
  // The service is made for one request. The key mode and every entry of the picker ask about the same entitlements, so they are
  // read once, on first use.
  let entitlements: Promise<ResolvedEntitlements> | undefined;
  const readEntitlements = () =>
    (entitlements ??= readEffectiveEntitlements(db, workspaceId));
  return createImplementerService({
    repositories: createRepositoriesRepository(db, workspaceId),
    integrations: createIntegrationsRepository(db, workspaceId),
    registry: integrationRegistry,
    models: createImplementerModels({
      keyMode: async () => keyModeForJob(await readEntitlements()),
      configuredProviders: async () =>
        new Set(
          (await keys.nativeStatuses())
            .filter(({ status }) => status.state === "configured")
            .map(({ provider }) => provider),
        ),
      nativeCatalog: getNativeCatalog(),
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
    }),
    queue: jobQueueFor(workspaceId),
    operatorCostLimitCents: operatorCostLimitCentsFrom(db),
  });
}

/** The operator's maximum cost per task in whole US cents: the page shows it as the bound of the cost limit field (#756). */
export function operatorMaximumCents(): Promise<number> {
  return operatorCostLimitCentsFrom(getDatabase())();
}
