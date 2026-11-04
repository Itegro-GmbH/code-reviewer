// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database, the real clock and the secrets the app knows
// (to take them out of a log should one slip through). Pages and routes ask for the service here;
// tests build their own with `createRunsService`.
import "server-only";
import { isBillingOn } from "../billing/enabled.ts";
import { createRunPriceSource } from "../billing/run-prices.ts";
import { createCatalogRepository } from "../db/repositories/catalog-repository.ts";
import { createImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import { createRunsRepository } from "../db/repositories/runs-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { knownSecretsFromEnv, redactText } from "../runner-api/redact.ts";
import type { LastRunSource } from "../projects/ui/list-view.ts";
import {
  createLastRunSource,
  createRunsService,
  type RunsService,
} from "./runs-service.ts";
import {
  createRunStepsService,
  type RunStepsService,
} from "./steps-service.ts";

/** The runs service of one workspace. */
export function runsServiceFor(workspaceId: string): RunsService {
  const db = getDatabase();
  return createRunsService({
    product: getProductIdentity(),
    runs: createRunsRepository(db, workspaceId),
    // The price of a review (#505): read only while billing is on, so a self-hoster who never switches it on sees no change. The
    // switch is the one instance setting; no billing table is read while it is off.
    prices: async (jobIds) =>
      (await isBillingOn(db))
        ? createRunPriceSource(db, workspaceId).pricesOf(jobIds)
        : new Map(),
    // Read on every call: the keys can change while the server runs.
    redact: (text) => redactText(text, knownSecretsFromEnv(process.env)),
  });
}

/** The steps service of one workspace: what the agent of a run of the Implementer did, for the live view (#745). */
export function runStepsServiceFor(workspaceId: string): RunStepsService {
  const db = getDatabase();
  return createRunStepsService({
    runs: createRunsRepository(db, workspaceId),
    steps: createImplementerStepsRepository(db, workspaceId),
    redact: (text) => redactText(text, knownSecretsFromEnv(process.env)),
    // The model ids of every entry of the catalog, as the runner API masks them when it stores a run's texts.
    hiddenModels: () => createCatalogRepository(db).allModelIds(),
  });
}

/** The status of each repository's last run in one workspace, for the project list. */
export function lastRunSourceFor(workspaceId: string): LastRunSource {
  return createLastRunSource({
    runs: createRunsRepository(getDatabase(), workspaceId),
  });
}
