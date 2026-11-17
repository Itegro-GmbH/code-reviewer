// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireImplementerCapability } from "@/implementer/shared";
import { loadAuthConfig } from "@/auth/config";
import { MCP_OAUTH_RESULT_CODES } from "@/mcp/oauth/errors";
import { mcpOAuthCallbackUrl } from "@/mcp/oauth/callback-url";
import { McpPanel, type McpRoundTrip } from "@/mcp/ui/mcp-panel";
import { PAGE_COPY } from "@/mcp/ui/messages";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "MCP" };

// The MCP servers of the workspace (#1050, epic #1049). The page exists only in a deployment with the capability `implementer` (the access
// proxy answers it as a path that does not exist everywhere else; `requireImplementerCapability()` is the second wall). Every member sees
// the list (names and addresses, the NAMES of headers, the tools a test found; never a value); Owners and Admins get the buttons that add,
// change, test and remove a server (`manage_mcp`). The panel loads and changes through the routes, so the page reads no data of its own.
export default async function McpPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/mcp">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const query = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title={PAGE_COPY.title} description={PAGE_COPY.description} />
      <McpPanel
        workspaceSlug={workspace.slug}
        canManage={can(role, "manage_mcp")}
        callbackUrl={mcpOAuthCallbackUrl(loadAuthConfig(process.env).baseUrl)}
        roundTrip={roundTripOf(query)}
      />
    </>
  );
}

/**
 * What a round trip through an authorization server left in the address (`?mcp=<code>&server=<id>`): only a code of our own list and an id
 * of the shape of ours are taken; anything else is nothing.
 */
function roundTripOf(
  query: Record<string, string | string[] | undefined>,
): McpRoundTrip | null {
  const code = query.mcp;
  if (
    typeof code !== "string" ||
    !(MCP_OAUTH_RESULT_CODES as readonly string[]).includes(code)
  )
    return null;
  const server = query.server;
  return {
    code,
    serverId:
      typeof server === "string" && /^[A-Za-z0-9-]{1,100}$/.test(server)
        ? server
        : null,
  };
}
