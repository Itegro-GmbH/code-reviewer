// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { billingPageLinkedFor } from "@/billing/shared";
import { getCapabilities } from "@/capabilities/shared";
import { ConnectedAppsList } from "@/factory-mcp/ui/connected-apps";
import { AI_APPS_COPY } from "@/factory-mcp/ui/messages";
import { getConnectedAppsService } from "@/factory-mcp/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { SettingsScreen } from "@/workspaces/ui/settings-shell";

export const metadata: Metadata = { title: "Connected AI apps" };

// The AI apps connected to the factory MCP in this workspace (#1144, epic #1143): who connected which app with which scope, and the revoke
// button. An Owner or Admin sees every connection, a Member their own. A page of the factory's settings only (the proxy answers the same).
export default async function AiAppsPage({
  params,
}: PageProps<"/w/[workspace]/settings/ai-apps">) {
  if (!getCapabilities().has("implementer")) notFound();
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  const [apps, showPlan, showBilling] = await Promise.all([
    getConnectedAppsService().list(workspace.id, { userId: user.id, role }),
    planPageLinkedFor(workspace.id),
    billingPageLinkedFor(),
  ]);
  return (
    <SettingsScreen
      workspaceSlug={workspace.slug}
      current="ai-apps"
      showPlan={showPlan}
      showBilling={showBilling}
      description={AI_APPS_COPY.description}
    >
      <ConnectedAppsList workspaceSlug={workspace.slug} apps={apps} />
    </SettingsScreen>
  );
}
