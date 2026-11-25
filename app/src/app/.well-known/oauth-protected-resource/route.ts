// SPDX-License-Identifier: LicenseRef-Proprietary

// RFC 9728: the protected resource metadata of the factory MCP (epic #1143, #1144). Public, no session; only in a deployment with the capability `implementer`.
import { connection } from "next/server";
import { getOAuthHandlers } from "@/factory-mcp/shared";
import { requireImplementerCapability } from "@/implementer/shared";

export async function GET(): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return getOAuthHandlers().protectedResource();
}

export async function OPTIONS(): Promise<Response> {
  await connection();
  requireImplementerCapability();
  return getOAuthHandlers().preflight();
}
