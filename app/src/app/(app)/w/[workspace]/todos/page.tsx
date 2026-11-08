// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireImplementerCapability } from "@/implementer/shared";
import { TodosPageContent } from "@/todos/ui/todos-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "ToDos" };

// What waits for the person across the projects of the workspace (#925): a question of an agent, a review that is asked for. The list
// is read by the page itself from `GET /api/w/<slug>/todos` (what it shows depends on who looks), with the answer panel next to it. The
// page exists only in a deployment with the capability `implementer` (the access proxy answers it as a path that does not exist
// everywhere else; `requireImplementerCapability()` is the second wall).
export default async function TodosPage({
  params,
}: PageProps<"/w/[workspace]/todos">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader
        title="ToDos"
        description="Everything that waits for you, across your projects."
      />
      <TodosPageContent
        workspaceSlug={workspace.slug}
        actor={{
          mayAct: can(role, "start_implementer_task"),
          hasLogin: user.githubLogin !== null,
        }}
      />
    </>
  );
}
