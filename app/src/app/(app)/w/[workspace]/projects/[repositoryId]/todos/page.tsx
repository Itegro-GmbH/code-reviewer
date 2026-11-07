// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { ProjectTodosTab } from "@/projects/ui/project-tabs";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · ToDos" };

// The ToDos of one project (#925): empty until the answer flow exists (#924). Only in a deployment with the capability `implementer`.
export default async function ProjectTodosPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/todos">) {
  requireImplementerCapability();
  const { workspace: slug, repositoryId } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab="todos"
    >
      <ProjectTodosTab />
    </CockpitFrame>
  );
}
