// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the profile routes (#843): the real database, the Implementer's rule for a model and the
// operator's maximum cost. The capability check (`requireImplementerCapability`) is the Implementer's, in `../implementer/shared.ts`;
// the profiles are part of the factory.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { onlineRunnersFrom } from "../runner-identity/online.ts";
import { implementerModelsFor } from "../implementer/shared.ts";
import { operatorCostLimitCentsFrom } from "../review-settings/operator-cost-limit-source.ts";
import { createProfileService, type ProfileService } from "./service.ts";

/** The profile service of one workspace. */
export function profileServiceFor(workspaceId: string): ProfileService {
  const db = getDatabase();
  return createProfileService({
    profiles: createProfilesRepository(db, workspaceId),
    models: implementerModelsFor(workspaceId),
    environments: createImplementerEnvironmentsRepository(db, workspaceId),
    onlineRunners: onlineRunnersFrom(createRunnersRepository(db, workspaceId)),
    operatorCostLimitCents: operatorCostLimitCentsFrom(db),
  });
}
