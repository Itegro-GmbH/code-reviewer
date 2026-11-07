// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCapabilities } from "@/capabilities/shared";
import { IssuesTab } from "@/projects/ui/project-tabs";
import { projectPath } from "@/projects/ui/project-cards";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "./cockpit-frame";

export const metadata: Metadata = { title: "Project · Issues" };

// The cockpit of one project (#925): its Issues tab. The address names the workspace and the repository by its id in this app. A
// deployment without the factory has no issues to show and opens the review settings of the project, as the page was before.
export default async function ProjectIssuesPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]">) {
  const { workspace: slug, repositoryId } = await params;
  const { workspace } = await requireWorkspace(slug);
  if (!getCapabilities().has("implementer"))
    redirect(projectPath(workspace.slug, repositoryId, "review"));
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab=""
    >
      <IssuesTab />
    </CockpitFrame>
  );
}
