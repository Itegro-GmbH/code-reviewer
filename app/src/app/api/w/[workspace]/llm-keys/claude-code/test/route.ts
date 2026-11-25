// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/w/:workspace/llm-keys/claude-code/test (#1150): checks the shape of the Claude Code OAuth token, the one typed into the field or,
// when it is empty, the stored one. It sends nothing to the Claude API (src/llm/claude-code-token-http.ts says why). An Admin or an Owner only
// (`manage_llm_key`).
import { connection } from "next/server";
import { createClaudeCodeTokenRouteHandlers } from "@/llm/claude-code-token-http";
import { getWorkspaceLlm } from "@/llm/shared";
import { withWorkspace } from "@/workspaces/access-runtime";

export async function POST(
  request: Request,
  context: RouteContext<"/api/w/[workspace]/llm-keys/claude-code/test">,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, "manage_llm_key", (access) =>
    createClaudeCodeTokenRouteHandlers({
      token: getWorkspaceLlm().claudeCodeTokenFor(access.workspace.id),
    }).test(request, access),
  );
}
