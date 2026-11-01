// SPDX-License-Identifier: LicenseRef-Proprietary

import { getProductIdentity } from "@/product-identity/current";
import type { Metadata } from "next";
import { getConfigStatusFor } from "@/config-status/shared";
import { configAudienceOf } from "@/config-status/status";
import { getWorkspaceLlm } from "@/llm/shared";
import { llmAccessAttention } from "@/llm/ui/llm-access-notice";
import { projectServiceFor } from "@/projects/shared";
import { lastRunSourceFor } from "@/runs/shared";
import {
  loadProjectsPage,
  ProjectsPageContent,
} from "@/projects/ui/projects-page";
import { SyncButton } from "@/projects/ui/sync-button";
import { PageHeader } from "@/components/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

// The area is named by the product of the deployment (#757): a function, not a constant of the module, like the root layout's title.
export function generateMetadata(): Metadata {
  return { title: getProductIdentity().qaAreaName };
}

// The repositories the GitHub App can read, each with a switch: a repository is reviewed only while
// its project is on. The workspace is the one in the address, for a member only: the page asks for it
// itself (the second guard behind the proxy), and everything below works in that workspace.
export default async function ProjectsPage({
  params,
}: PageProps<"/w/[workspace]/projects">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  const canManage = can(role, "manage_projects");
  const canConnect = can(role, "manage_connections");
  return (
    <>
      <PageHeader
        title={getProductIdentity().qaAreaName}
        description={`The repositories ${getProductIdentity().name} watches.`}
        actions={
          // The synchronization of the workspace: it reads the workspace's own connections, for an Owner or
          // an Admin (the instance admin's synchronization of everything is a route of the admin portal).
          canConnect ? <SyncButton workspaceSlug={workspace.slug} /> : null
        }
      />
      <ProjectsContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        canManage={canManage}
        canConnect={canConnect}
        canStartReview={can(role, "start_review")}
        canManageLlmKey={can(role, "manage_llm_key")}
        user={user}
      />
    </>
  );
}

async function ProjectsContent({
  workspaceId,
  workspaceSlug,
  canManage,
  canConnect,
  canStartReview,
  canManageLlmKey,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  canConnect: boolean;
  canStartReview: boolean;
  canManageLlmKey: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const data = await loadProjectsPage({
    projects: projectServiceFor(workspaceId),
    // The status of each repository's newest run comes from the jobs table.
    lastRuns: lastRunSourceFor(workspaceId),
    // Only the instance admin gets the names of the variables that are wrong.
    config: () => getConfigStatusFor(user),
  });
  // The workspace's LLM hint is a row of the page's one "Needs attention" strip, not its own region.
  const llmNotice = llmAccessAttention({
    product: getProductIdentity(),
    workspaceSlug,
    summary: await getWorkspaceLlm().summaryFor(workspaceId),
    canManage: canManageLlmKey,
  });
  return (
    <ProjectsPageContent
      product={getProductIdentity()}
      workspaceSlug={workspaceSlug}
      audience={configAudienceOf(user)}
      canManage={canManage}
      canConnect={canConnect}
      canStartReview={canStartReview}
      llmNotice={llmNotice}
      data={data}
    />
  );
}
