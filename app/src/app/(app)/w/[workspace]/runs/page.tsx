// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { getCapabilities } from "@/capabilities/shared";
import { projectServiceFor } from "@/projects/shared";
import { loadRunsPage, RunsPageContent } from "@/runs/ui/runs-page";
import { lastRunSourceFor, runsServiceFor } from "@/runs/shared";
import { PageHeader } from "@/components/page-header";
import {
  LaneRunsPageContent,
  loadLaneRunsPage,
  runsViewOf,
  RunsViewTabs,
} from "@/workflow-pages/lane-runs-page";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { getProductIdentity } from "@/product-identity/current";

export const metadata: Metadata = { title: "Runs" };

// Two tabs, chosen through the address (`?view=lanes|agents`, #1078). Lane runs (the default in a deployment with the implementer
// capability): the runs of every lane of the workspace, the active ones first. Agent runs: every review Code Reviewer has started in the
// workspace, newest first, filtered by project and status through the address. The page asks for the workspace itself (the second guard behind the proxy).
// `searchParams` is request data, so it is read inside the component that renders the list, behind the
// layout's <Suspense>; the page itself stays static.
export default async function RunsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/runs">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const hasLanes = getCapabilities().has("implementer");
  return (
    <>
      <PageHeader
        title="Runs"
        {...(hasLanes
          ? {
              description:
                "What the environments are doing. Open a run to follow it.",
            }
          : {})}
      />
      {hasLanes ? (
        <RunsTabs workspaceSlug={workspace.slug} searchParams={searchParams} />
      ) : null}
      <RunsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        searchParams={searchParams}
      />
    </>
  );
}

async function RunsTabs({
  workspaceSlug,
  searchParams,
}: {
  workspaceSlug: string;
  searchParams: PageProps<"/w/[workspace]/runs">["searchParams"];
}) {
  return (
    <RunsViewTabs
      workspaceSlug={workspaceSlug}
      view={runsViewOf(await searchParams, true)}
    />
  );
}

async function RunsContent({
  workspaceId,
  workspaceSlug,
  searchParams,
}: {
  workspaceId: string;
  workspaceSlug: string;
  searchParams: PageProps<"/w/[workspace]/runs">["searchParams"];
}) {
  const params = await searchParams;
  if (runsViewOf(params, getCapabilities().has("implementer")) === "lanes")
    return (
      <LaneRunsPageContent
        workspaceSlug={workspaceSlug}
        data={await loadLaneRunsPage(params, {
          runs: workflowRunServiceFor(workspaceId),
          workflows: workflowServiceFor(workspaceId),
          projects: projectServiceFor(workspaceId),
        })}
      />
    );
  const data = await loadRunsPage(params, {
    runs: runsServiceFor(workspaceId),
    projects: projectServiceFor(workspaceId),
    lastRuns: lastRunSourceFor(workspaceId),
  });
  return (
    <RunsPageContent
      product={getProductIdentity()}
      workspaceSlug={workspaceSlug}
      data={data}
    />
  );
}
