// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireImplementerCapability } from "@/implementer/shared";
import { profileServiceFor } from "@/profiles/shared";
import { loadWorkflowPage, WorkflowPageContent } from "@/workflow-pages/pages";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Workflow" };

// One workflow (#873, #926): the lane builder (its "Run now" opens the form that starts it by hand) and its runs. A workflow nobody has in this workspace (also one of another
// workspace) shows the not-found page and nothing of any other workflow; with Cache Components the data sits behind the layout's
// <Suspense>, so the response is already streaming and its HTTP status stays 200. The data routes answer a real 404.
export default async function WorkflowPage({
  params,
}: PageProps<"/w/[workspace]/workflows/[workflowId]">) {
  requireImplementerCapability();
  const { workspace: slug, workflowId } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <WorkflowContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      workflowId={workflowId}
      mayStart={can(role, "start_implementer_task")}
    />
  );
}

async function WorkflowContent({
  workspaceId,
  workspaceSlug,
  workflowId,
  mayStart,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workflowId: string;
  mayStart: boolean;
}) {
  const data = await loadWorkflowPage(workflowId, {
    workflows: workflowServiceFor(workspaceId),
    runs: workflowRunServiceFor(workspaceId),
    profiles: profileServiceFor(workspaceId),
  });
  if (data.kind === "not_found") notFound();
  return (
    <WorkflowPageContent
      workspaceSlug={workspaceSlug}
      data={data}
      mayStart={mayStart}
    />
  );
}
