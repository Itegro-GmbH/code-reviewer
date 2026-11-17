// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/mcp/oauth/callback: where an MCP server's authorization server sends the browser after the consent page (`?code=&state=`, or
// `?error=&state=`). It is not a public path: the person has to be signed in, and the state is the one they started "Connect" with, in this
// browser session. The flow ends on a fixed page (the MCP page of the workspace). Only in a deployment with the capability `implementer`. The
// logic is in src/mcp/oauth/.
import { connection } from "next/server";
import { requireUser } from "@/auth/session";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpOAuthRouteHandlers } from "@/mcp/oauth/shared";

export async function GET(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  // The proxy answers first; this is the second wall for a request that reaches the route file anyway.
  requireImplementerCapability();
  // The second guard behind the proxy: somebody who is not signed in, or has to verify the address or has no workspace, is sent where
  // every page sends them, before anything of the flow is touched.
  await requireUser();
  return getMcpOAuthRouteHandlers().callback(request);
}
