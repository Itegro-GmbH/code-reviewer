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

export const metadata: Metadata = { title: "Settings · Integrations" };

// The GitHub installations linked to the workspace and, for an Owner or Admin, the buttons that connect one
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): the Integrations tab of the settings (#925; the page was
// `/connections` before, which redirects here). The workspace is the one in the address, for a member only; what a flow that just
// ended said is in the query, as a code of our own list.
export default async function ConnectionsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/settings/integrations">) {
  // A tab of the factory's settings only (the proxy answers the same, `capabilities/routes.ts`; asked again here like a route file).
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
  // The Jira connection (#1037, epic #1034): the card is there where the Atlassian app is set up, or while the workspace still has a
  // connection (it can then be seen and removed).
  const jira = await loadJiraSection({
    service: getJira().service,
    workspaceId,
    actor: sessionId === null ? null : { id: userId, sessionId },
    canManage,
    query: { jira: query.jira },
  });
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="integrations"
      showPlan={showPlan}
      showBilling={showBilling}
    >
      <ConnectionsPageContent
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        data={data}
        heading={false}
      />
      {jira.configured || jira.connections.length > 0 ? (
        <div className="mt-6">
          <JiraSection
            workspaceSlug={workspaceSlug}
            canManage={canManage}
            data={jira}
          />
        </div>
      ) : null}
    </SettingsScreen>
  );
}
