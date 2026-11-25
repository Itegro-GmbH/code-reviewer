// SPDX-License-Identifier: LicenseRef-Proprietary

// GET|PUT|DELETE /api/w/:workspace/llm-keys/claude-code: the Claude Code OAuth token of the workspace (#1150). Every member reads whether a
// token is configured; setting, replacing and removing it need an Admin or an Owner (`manage_llm_key`), like the provider keys. The token
// is write-only: no answer contains it. This file is a static sibling of `[provider]`, so `claude-code` is never read as a provider. The
// logic is in src/llm/claude-code-token-http.ts.
import { connection } from "next/server";
import { createClaudeCodeTokenRouteHandlers } from "@/llm/claude-code-token-http";
import { getWorkspaceLlm } from "@/llm/shared";
import { withWorkspace } from "@/workspaces/access-runtime";
import type { WorkspaceAccess } from "@/workspaces/access";
import type { WorkspaceAction } from "@/workspaces/permissions";

type Context = RouteContext<"/api/w/[workspace]/llm-keys/claude-code">;

async function run(
  context: Context,
  action: WorkspaceAction,
  call: (
    handlers: ReturnType<typeof createClaudeCodeTokenRouteHandlers>,
    access: WorkspaceAccess,
  ) => Promise<Response>,
): Promise<Response> {
  // Needs the request and the database, so it never runs at build time.
  await connection();
  const { workspace } = await context.params;
  return withWorkspace(workspace, action, (access) =>
    call(
      createClaudeCodeTokenRouteHandlers({
        token: getWorkspaceLlm().claudeCodeTokenFor(access.workspace.id),
      }),
      access,
    ),
  );
}

export function GET(request: Request, context: Context): Promise<Response> {
  return run(context, "view", (handlers, access) =>
    handlers.get(request, access),
  );
}

export function PUT(request: Request, context: Context): Promise<Response> {
  return run(context, "manage_llm_key", (handlers, access) =>
    handlers.put(request, access),
  );
}

export function DELETE(request: Request, context: Context): Promise<Response> {
  return run(context, "manage_llm_key", (handlers, access) =>
    handlers.remove(request, access),
  );
}
