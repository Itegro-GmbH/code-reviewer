// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server behind the environments page and routes (#818): the real database. The capability check
// (`requireImplementerCapability`) is the Implementer's, in `../shared.ts`; the environments are part of it.
import "server-only";
import { createImplementerEnvironmentsRepository } from "../../db/repositories/implementer-environments-repository.ts";
import { getDatabase } from "../../db/startup.ts";
import {
  createEnvironmentService,
  type EnvironmentService,
} from "./service.ts";

/** The environment service of one workspace. */
export function environmentServiceFor(workspaceId: string): EnvironmentService {
  return createEnvironmentService({
    environments: createImplementerEnvironmentsRepository(
      getDatabase(),
      workspaceId,
    ),
  });
}
