// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/register: a customer's runner exchanges a registration token for a credential of its own (#854). Public for
// the session guard: the token in the body is the proof. Only in a deployment with the capability `implementer`. All logic is in
// src/runner-api/registration.ts; see src/runner-fleet/README.md.
import { connection } from "next/server";
import { requireImplementerCapability } from "../../../../../implementer/shared.ts";
import { withRunnerRegistrationApi } from "../../../../../runner-api/shared.ts";

export async function POST(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return withRunnerRegistrationApi((api) => api.register(request));
}
