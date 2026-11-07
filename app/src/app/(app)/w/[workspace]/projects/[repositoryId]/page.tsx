// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getCapabilities } from "@/capabilities/shared";
import { IssuesTab } from "@/projects/ui/project-tabs";
import { requireWorkspace } from "@/workspaces/access-runtime";
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
  const { workspace } = await requireWorkspace(slug);
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
