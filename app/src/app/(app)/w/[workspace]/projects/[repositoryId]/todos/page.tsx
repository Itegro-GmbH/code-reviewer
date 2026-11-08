// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { projectServiceFor } from "@/projects/shared";
import { TodosPageContent } from "@/todos/ui/todos-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · ToDos" };

// The ToDos of one project (#925): the list of the ToDos page narrowed to the project, with the same answer panel. The route says `projectId`,
// the address of the tab says repository: the project is the repository's. `?run=<id>` opens the open question of that run (the Answer button of the Issues tab). Only in a deployment with the capability `implementer`.
export default async function ProjectTodosPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/todos">) {
  requireImplementerCapability();
  const { workspace: slug, repositoryId } = await params;
  const { run } = await searchParams;
  const { workspace, role, user } = await requireWorkspace(slug);
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
        focusRun={typeof run === "string" ? run : undefined}
        actor={{
          mayAct: can(role, "start_implementer_task"),
          hasLogin: user.githubLogin !== null,
        }}
      />
    </CockpitFrame>
  );
}
