// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getCapabilities } from "@/capabilities/shared";
import { IssuesBoard } from "@/issues/issues-board";
import { loadIssuesPage } from "@/issues/load";
import { projectServiceFor } from "@/projects/shared";
import { trackerServiceFor } from "@/tracker/shared";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { CockpitFrame } from "./cockpit-frame";
import ProjectSettingsPage from "./review/page";

// The title is the one of the page: the cockpit in the factory, the review settings elsewhere (a function, as the capability is read
// from the environment).
export function generateMetadata(): Metadata {
  return {
    title: getCapabilities().has("implementer")
      ? "Project · Issues"
      : "Project settings",
  };
}

// One project. In the factory (#925) it is the cockpit, and this address is its Issues tab; the review settings are at `/review`. A
// deployment without the factory has no cockpit: the address shows the review settings, as it always did.
export default async function ProjectPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/projects/[repositoryId]">) {
  if (!getCapabilities().has("implementer"))
    return ProjectSettingsPage({ params, searchParams });
  const { workspace: slug, repositoryId } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab=""
    >
      <IssuesContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        repositoryId={repositoryId}
        mayStart={can(role, "start_implementer_task")}
      />
    </CockpitFrame>
  );
}

// The tickets of the project and the lanes a person can start from one (#925); the board polls from this first list.
async function IssuesContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  mayStart,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  mayStart: boolean;
}) {
  const data = await loadIssuesPage(repositoryId, {
    projects: projectServiceFor(workspaceId),
    tracker: trackerServiceFor(workspaceId),
    workflows: workflowServiceFor(workspaceId),
  });
  return (
    <IssuesBoard
      workspaceSlug={workspaceSlug}
      repositoryId={repositoryId}
      projectId={data.projectId}
      initial={data.initial}
      lanes={data.lanes}
      mayStart={mayStart}
    />
  );
}
