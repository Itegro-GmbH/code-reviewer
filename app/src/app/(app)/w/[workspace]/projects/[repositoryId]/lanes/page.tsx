// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { projectServiceFor } from "@/projects/shared";
import { LanesTab } from "@/projects/ui/project-tabs";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · Lanes" };

// The lanes of one project (#925, #922): the workflows that belong to it; each one opens its page with the Start form and its runs. A
// repository without a project has none. Only in a deployment with the capability `implementer`.
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
      <LanesContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        repositoryId={repositoryId}
      />
    </CockpitFrame>
  );
}

async function LanesContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
}) {
  const entry = await projectServiceFor(workspaceId).findProject(repositoryId);
  const projectId = entry?.project?.id;
  const workflows =
    projectId === undefined
      ? []
      : (await workflowServiceFor(workspaceId).list(projectId)).workflows;
  return <LanesTab workspaceSlug={workspaceSlug} lanes={workflows} />;
}
