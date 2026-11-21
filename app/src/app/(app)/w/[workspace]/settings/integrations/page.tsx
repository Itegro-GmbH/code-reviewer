// SPDX-License-Identifier: LicenseRef-Proprietary

import { getProductIdentity } from "@/product-identity/current";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getCapabilities } from "@/capabilities/shared";
import { lookupSessionId } from "@/auth/session";
import { createInstallationLinkRequestsRepository } from "@/db/repositories/installation-link-requests-repository";
import { createIntegrationsRepository } from "@/db/repositories/integrations-repository";
import { createRepositoriesRepository } from "@/db/repositories/repositories-repository";
import { getDatabase } from "@/db/startup";
import { getInstallationBinding } from "@/installation-binding/shared";
import { loadJiraSection } from "@/jira/ui/jira-page";
import { JIRA_NOT_SET_UP } from "@/jira/ui/messages";
import { JiraSection } from "@/jira/ui/jira-section";
import { getJira } from "@/jira/shared";
import {
  ConnectionsPageContent,
  loadConnectionsPage,
} from "@/installation-binding/ui/connections-page";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { SettingsScreen } from "@/workspaces/ui/settings-shell";

export const metadata: Metadata = { title: "Setup · GitHub and Jira" };

// The GitHub installations linked to the workspace and, for an Owner or Admin, the buttons that connect one
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): the place "GitHub and Jira" of Setup (#925, #1108; the page was
// `/connections` before, which redirects here, and a tab of the settings until #1108). The workspace is the one in the address, for a member only; what a flow that just
// ended said is in the query, as a code of our own list.
export default async function ConnectionsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/settings/integrations">) {
  // A place of the factory's Setup only (the proxy answers the same, `capabilities/routes.ts`; asked again here like a route file).
  if (!getCapabilities().has("implementer")) notFound();
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  const query = await searchParams;
  return (
    <ConnectionsContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      canManage={can(role, "manage_connections")}
      userId={user.id}
      query={{ github: query.github, picker: query.picker, jira: query.jira }}
    />
  );
}

async function ConnectionsContent({
  workspaceId,
  workspaceSlug,
  canManage,
  userId,
  query,
}: {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  userId: string;
  query: { github?: unknown; picker?: unknown; jira?: unknown };
}) {
  const db = getDatabase();
  const sessionId = await lookupSessionId();
  const [showPlan, showBilling] = await Promise.all([
    planPageLinkedFor(workspaceId),
    billingPageLinkedFor(),
  ]);
  const data = await loadConnectionsPage({
    product: getProductIdentity(),
    canManage,
    workspaceId,
    integrations: createIntegrationsRepository(db, workspaceId),
    repositories: createRepositoriesRepository(db, workspaceId),
    linkRequests: createInstallationLinkRequestsRepository(db, workspaceId),
    service: getInstallationBinding().service,
    query,
    actor: sessionId === null ? null : { id: userId, sessionId },
  });
  // The Jira connection (#1037, epic #1034): the card is there where the deployment has the capability `implementer` and the Atlassian
  // app is set up; elsewhere nothing of it is read.
  const jira = await loadJiraSection({
    service: getJira().service,
    workspaceId,
    actor: sessionId === null ? null : { id: userId, sessionId },
    canManage,
    implementer: getCapabilities().has("implementer"),
    query: { jira: query.jira },
  });
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="integrations"
      area="setup"
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <ConnectionsPageContent
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        data={data}
        heading={false}
      />
      {jira.configured ? (
        <div className="mt-6">
          <JiraSection
            workspaceSlug={workspaceSlug}
            canManage={canManage}
            data={jira}
          />
        </div>
      ) : (
        // The sidebar says "GitHub and Jira": where the Atlassian app is not set up the page says so instead of showing GitHub alone.
        <p className="mt-6 text-sm text-muted-foreground">{JIRA_NOT_SET_UP}</p>
      )}
    </SettingsScreen>
  );
}
