// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireImplementerCapability } from "@/implementer/shared";
import { EnvironmentsPanel } from "@/implementer/environments/ui/environments-panel";
import { PAGE_COPY } from "@/implementer/environments/ui/messages";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Environments" };

// The environments of the Implementer (#818): a size and a setup script each, kept per workspace. The page exists only in a
// deployment with the capability `implementer` (the access proxy answers it as a path that does not exist everywhere else;
// `requireImplementerCapability()` is the second wall). Every member sees the list and the scripts; Owners and Admins also get
// the buttons (`manage_implementer_environments`). The panel loads and changes the environments through the routes, so the page
// reads no data of its own.
export default async function EnvironmentsPage({
  params,
}: PageProps<"/w/[workspace]/environments">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader title={PAGE_COPY.title} description={PAGE_COPY.description} />
      <EnvironmentsPanel
        workspaceSlug={workspace.slug}
        canManage={can(role, "manage_implementer_environments")}
      />
    </>
  );
}
