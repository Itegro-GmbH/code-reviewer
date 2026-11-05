// SPDX-License-Identifier: LicenseRef-Proprietary

// PUT /api/runners/v1/self: a customer's runner tells the app what it is now (labels, version of the base, manifest, limits; #854).
// Public for the session guard: the runner authenticates with its own credential. Only in a deployment with the capability
// `implementer`. All logic is in src/runner-api/registration.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "../../../../../implementer/shared.ts";
import { withRunnerRegistrationApi } from "../../../../../runner-api/shared.ts";

export async function PUT(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return withRunnerRegistrationApi((api) => api.announce(request));
}
