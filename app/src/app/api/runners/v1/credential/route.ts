// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/credential: a customer's runner renews its credential (#854). Public for the session guard: the runner
// authenticates with the credential it renews. Only in a deployment with the capability `implementer`. All logic is in
// src/runner-api/registration.ts.
import { connection } from "next/server";
import { requireImplementerCapability } from "../../../../../implementer/shared.ts";
import { withRunnerRegistrationApi } from "../../../../../runner-api/shared.ts";

export async function POST(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return withRunnerRegistrationApi((api) => api.renew(request));
}
