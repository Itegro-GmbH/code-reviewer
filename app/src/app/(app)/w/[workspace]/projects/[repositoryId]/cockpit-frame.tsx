// SPDX-License-Identifier: LicenseRef-Proprietary

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCapabilities } from "@/capabilities/shared";
import { projectServiceFor } from "@/projects/shared";
import type { CockpitTab } from "@/projects/ui/cockpit-messages";
import { loadProjectRow } from "@/projects/ui/list-view";
import { ProjectCockpit } from "@/projects/ui/project-cockpit";

// The frame the tab pages of a project share (#925): it reads the project once (an id nobody has in this workspace, also one of another
// workspace, is the not-found page) and renders the header and the tabs around the page's own content. A page of a tab calls
// `requireWorkspace` itself first, which is the guard behind the proxy.
export async function CockpitFrame({
  workspaceId,
  workspaceSlug,
  repositoryId,
  tab,
  children,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  tab: CockpitTab;
  children: ReactNode;
}) {
  const row = await loadProjectRow(repositoryId, {
    projects: projectServiceFor(workspaceId),
  });
  if (row === undefined) notFound();
  return (
    <ProjectCockpit
      workspaceSlug={workspaceSlug}
      row={row}
      tab={tab}
      factory={getCapabilities().has("implementer")}
    >
      {children}
    </ProjectCockpit>
  );
}
