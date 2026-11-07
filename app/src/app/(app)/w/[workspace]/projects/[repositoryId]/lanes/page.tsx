// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { LanesTab } from "@/projects/ui/project-tabs";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · Lanes" };

// The lanes of one project (#925). A lane does not belong to a project yet (#922), so the tab lists the lanes of the workspace; each
// one opens its page with the Start form and its runs. Only in a deployment with the capability `implementer`.
export default async function ProjectLanesPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/lanes">) {
  requireImplementerCapability();
  const { workspace: slug, repositoryId } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab="lanes"
    >
      <LanesContent workspaceId={workspace.id} workspaceSlug={workspace.slug} />
    </CockpitFrame>
  );
}

async function LanesContent({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}) {
  const { workflows } = await workflowServiceFor(workspaceId).list();
  return <LanesTab workspaceSlug={workspaceSlug} lanes={workflows} />;
}
