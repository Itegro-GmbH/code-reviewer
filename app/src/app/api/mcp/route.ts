// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/mcp: the Streamable HTTP endpoint of the factory MCP (epic #1143, #1144). It authenticates with an OAuth access token and answers
// 401 with the address of the metadata otherwise; the logic is in src/factory-mcp/endpoint/. Only in a deployment with the capability
// `implementer` (the proxy answers it as a path that does not exist everywhere else; this is the second wall).
import { connection } from "next/server";
import { requireImplementerCapability } from "@/implementer/shared";
import { getMcpEndpoint } from "@/factory-mcp/shared";

async function handle(request: Request): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  requireImplementerCapability();
  return getMcpEndpoint().handle(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
