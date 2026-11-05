// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireImplementerCapability } from "@/implementer/shared";
import { loadRunPage, RunPageContent } from "@/workflow-pages/pages";
import { workflowRunServiceFor } from "@/workflow-runs/shared";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";

export const metadata: Metadata = { title: "Workflow run" };

// One run of a workflow (#873): its status, budget, steps and their results, updated while it runs. The address names the workspace,
// the workflow and the run by their ids. An id nobody has in this workspace (also the id of a run or workflow of another workspace)
// shows the not-found page and nothing of any other run; with Cache Components the data sits behind the layout's <Suspense>, so the
// response is already streaming and its HTTP status stays 200. The data route answers a real 404.
export default async function WorkflowRunPage({
  params,
}: PageProps<"/w/[workspace]/workflows/[workflowId]/runs/[runId]">) {
  requireImplementerCapability();
  const { workspace: slug, workflowId, runId } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <RunContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      workflowId={workflowId}
      runId={runId}
    />
  );
}

async function RunContent({
  workspaceId,
  workspaceSlug,
  workflowId,
  runId,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workflowId: string;
  runId: string;
}) {
  const data = await loadRunPage(workflowId, runId, {
    workflows: workflowServiceFor(workspaceId),
    runs: workflowRunServiceFor(workspaceId),
  });
  if (data.kind === "not_found") notFound();
  return <RunPageContent workspaceSlug={workspaceSlug} data={data} />;
}
