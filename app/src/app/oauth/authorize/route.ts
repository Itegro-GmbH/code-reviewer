// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /oauth/authorize: where an AI app sends the person's browser (epic #1143, #1144). It checks the request, and goes on to the consent
// page, through the sign in when there is no session; a client or redirect URI it cannot trust gets an error page and no redirect.
// Only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getOAuthHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";

export async function GET(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return getOAuthHandlers().authorize(request);
}
