// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireImplementerCapability } from "@/implementer/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspacePath } from "@/workspaces/paths";

export const metadata: Metadata = { title: "Workflows" };

// There is no list of the workflows of a workspace any more (#922): a lane belongs to a project and is listed in the Lanes tab of its
// cockpit, so this address leads to the projects. A workflow's own page (its Start form and its runs) is below it as before. The page
// exists only in a deployment with the capability `implementer` (the access proxy answers it as a path that does not exist everywhere
// else; `requireImplementerCapability()` is the second wall).
export default async function WorkflowsPage({
  params,
}: PageProps<"/w/[workspace]/workflows">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  redirect(workspacePath(workspace.slug, "/projects"));
}
