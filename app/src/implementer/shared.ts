// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server: the real database, registry, key store, model catalogs and job queue behind the Implementer
// form (#755). The service itself is put together in `service-wiring.ts`.
import "server-only";
import { notFound } from "next/navigation";
import { getCapabilities } from "../capabilities/shared.ts";
import { getDatabase } from "../db/startup.ts";
import { jobQueueFor } from "../jobs/shared.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import type { ImplementerService } from "./service.ts";
import { implementerServiceWith } from "./service-wiring.ts";

export { implementerModelsFor } from "./service-wiring.ts";

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
  return implementerServiceWith(workspaceId, jobQueueFor(workspaceId));
}

/** The operator's maximum cost per task in whole US cents: the page shows it as the bound of the cost limit field (#756). */
export function operatorMaximumCents(): Promise<number> {
  return operatorCostLimitCentsFrom(getDatabase())();
}
