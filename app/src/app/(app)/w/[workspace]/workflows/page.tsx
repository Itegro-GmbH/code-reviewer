// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { ROLE_NOT_ALLOWED } from "@/copy/messages";
import { requireImplementerCapability } from "@/implementer/shared";
import {
  loadWorkflowsPage,
  WorkflowsPageContent,
} from "@/workflow-pages/pages";
import { PAGE_COPY } from "@/workflow-pages/messages";
import { workflowServiceFor } from "@/workflows/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Workflows" };

// The workflows of the workspace (#873): the way to a workflow's Start form and its runs. The page exists only in a deployment with
// the capability `implementer` (the access proxy answers it as a path that does not exist everywhere else;
// `requireImplementerCapability()` is the second wall). The workspace is the one in the address, for a member only: the page asks for
// it itself.
export default async function WorkflowsPage({
  params,
}: PageProps<"/w/[workspace]/workflows">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  if (!can(role, "start_implementer_task"))
    return (
      <>
        <PageHeader title={PAGE_COPY.workflowsTitle} />
        <Alert variant="info" role="status">
          {ROLE_NOT_ALLOWED}
        </Alert>
      </>
    );
  return (
    <WorkflowsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}

async function WorkflowsContent({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}) {
  const data = await loadWorkflowsPage({
    workflows: workflowServiceFor(workspaceId),
  });
  return <WorkflowsPageContent workspaceSlug={workspaceSlug} data={data} />;
}
