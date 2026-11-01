// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { ROLE_NOT_ALLOWED } from "@/copy/messages";
import {
  operatorMaximumCents,
  requireImplementerCapability,
} from "@/implementer/shared";
import { ImplementerForm } from "@/implementer/ui/implementer-form";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Implementer" };

// The form that sends a task to the agent (#756): repository, base branch, a new branch, the task and the model. The page exists
// only in a deployment with the capability `implementer` (the access proxy answers it as a path that does not exist everywhere
// else; `requireImplementerCapability()` is the second wall). The workspace is the one in the address, for a member only: the page
// asks for it itself. The form loads the repositories, branches and models through the routes of #755, so the page reads no secret
// and no token; the server hands it only the operator's maximum cost per task.
export default async function ImplementerPage({
  params,
}: PageProps<"/w/[workspace]/implementer">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader
        title="Implementer"
        description="Describe a task and the agent works on a new branch of one of your repositories."
      />
      {can(role, "start_implementer_task") ? (
        <ImplementerContent workspaceSlug={workspace.slug} />
      ) : (
        <Alert variant="info" role="status">
          {ROLE_NOT_ALLOWED}
        </Alert>
      )}
    </>
  );
}

async function ImplementerContent({
  workspaceSlug,
}: {
  workspaceSlug: string;
}) {
  return (
    <ImplementerForm
      workspaceSlug={workspaceSlug}
      operatorMaximumCents={await operatorMaximumCents()}
    />
  );
}
