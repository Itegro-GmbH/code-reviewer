// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/oauth/consent: the answer of the consent page (epic #1143, #1144): one workspace and one scope, or a refusal. Behind the sign in
// (the person comes from a form of this site); only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getOAuthHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { withSignedIn } from "@/workspaces/access-runtime";

export async function POST(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return withSignedIn((user) => getOAuthHandlers().consent(request, user));
}
