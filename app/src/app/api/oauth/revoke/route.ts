// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/oauth/revoke: the OAuth server of the factory MCP (epic #1143, #1144; logic in src/factory-mcp/oauth/http.ts). Public, no session;
// only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getOAuthHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";

export async function POST(request: Request): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return getOAuthHandlers().revoke(request);
}

export async function OPTIONS(): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return getOAuthHandlers().preflight();
}
