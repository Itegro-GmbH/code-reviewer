// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { projectServiceFor } from "@/projects/shared";
import { TodosPageContent } from "@/todos/ui/todos-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · ToDos" };

// The ToDos of one project (#925): the list of the ToDos page narrowed to the project, with the same answer panel. The route says `projectId`,
// the address of the tab says repository: the project is the repository's. Only in a deployment with the capability `implementer`.
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
      <TodosPageContent
        workspaceSlug={workspace.slug}
        projectId={
          (await projectServiceFor(workspace.id).findProject(repositoryId))
            ?.project?.id
        }
        variant="project"
      />
    </CockpitFrame>
  );
}
