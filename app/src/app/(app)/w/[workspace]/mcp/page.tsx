// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireImplementerCapability } from "@/implementer/shared";
import { McpPanel } from "@/mcp/ui/mcp-panel";
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
}: PageProps<"/w/[workspace]/mcp">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title={PAGE_COPY.title} description={PAGE_COPY.description} />
      <McpPanel
        workspaceSlug={workspace.slug}
        canManage={can(role, "manage_mcp")}
      />
    </>
  );
}
