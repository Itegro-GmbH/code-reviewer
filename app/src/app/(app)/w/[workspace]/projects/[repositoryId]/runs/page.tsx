// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { requireImplementerCapability } from "@/implementer/shared";
import { projectServiceFor } from "@/projects/shared";
import { RunsList } from "@/runs/ui/runs-list";
import { loadRunsPage } from "@/runs/ui/runs-page";
import { lastRunSourceFor, runsServiceFor } from "@/runs/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · Runs" };

// The runs of one project (#925): the list of the Runs page, for this repository only. The status filter of the address stays (`?status=`). Only in a
// deployment with the capability `implementer`: elsewhere the Runs page has the repository filter.
export default async function ProjectRunsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/runs">) {
  requireImplementerCapability();
  const { workspace: slug, repositoryId } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab="runs"
    >
      <RunsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        repositoryId={repositoryId}
        searchParams={searchParams}
      />
    </CockpitFrame>
  );
}

async function RunsContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  searchParams,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  searchParams: PageProps<"/w/[workspace]/projects/[repositoryId]/runs">["searchParams"];
}) {
  const query = await searchParams;
  const data = await loadRunsPage(
    { status: query.status, repository: repositoryId },
    {
      runs: runsServiceFor(workspaceId),
      projects: projectServiceFor(workspaceId),
      lastRuns: lastRunSourceFor(workspaceId),
    },
  );
  if (data.kind === "invalid_filter")
    return (
      <p className="text-sm text-muted-foreground">
        The status in the address is not one the app knows.
      </p>
    );
  return (
    <RunsList
      workspaceSlug={workspaceSlug}
      initial={data.snapshot}
      filter={data.filter}
    />
  );
}
