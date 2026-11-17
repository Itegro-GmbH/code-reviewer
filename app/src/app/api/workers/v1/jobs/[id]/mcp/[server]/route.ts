// SPDX-License-Identifier: LicenseRef-Proprietary

// /api/workers/v1/jobs/:id/mcp/:server: a call of the agent's MCP client for one MCP server of the job (#1053, epic #1049). The door of the
// sandbox sends it with the credential of the job; the app adds the credential of the server and forwards the call (`src/mcp/job-proxy.ts`).
// POST carries one JSON-RPC message; DELETE ends the server's session; GET is 405 (this endpoint has no stream of its own).
import { withWorkerApi } from "../../../../../../../../runner-api/shared.ts";

type Context = { params: Promise<{ id: string; server: string }> };

async function call(request: Request, context: Context): Promise<Response> {
  const { id, server } = await context.params;
  return withWorkerApi((api) => api.mcp(request, id, server));
}

export const POST = call;
export const DELETE = call;
export const GET = call;
