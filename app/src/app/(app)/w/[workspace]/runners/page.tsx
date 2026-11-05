// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireImplementerCapability } from "@/implementer/shared";
import { RunnersPanel } from "@/runner-fleet/ui/runners-panel";
import { PAGE_COPY } from "@/runner-fleet/ui/messages";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Runners" };

// The runners on customers' own machines (#854). The page exists only in a deployment with the capability `implementer` (the access
// proxy answers it as a path that does not exist everywhere else; `requireImplementerCapability()` is the second wall). Every member
// sees the list (the labels are what an environment asks for); a runner takes the workspace's jobs, so only Owners and Admins get
// the buttons that add and revoke one (`manage_runners`). The panel loads and changes through the routes, so the page reads no data
// of its own.
export default async function RunnersPage({
  params,
}: PageProps<"/w/[workspace]/runners">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title={PAGE_COPY.title} description={PAGE_COPY.description} />
      <RunnersPanel
        workspaceSlug={workspace.slug}
        canManage={can(role, "manage_runners")}
      />
    </>
  );
}
