// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { billingPageLinkedFor } from "@/billing/shared";
import { planPageLinkedFor } from "@/usage/shared";
import { SettingsScreen } from "@/workspaces/ui/settings-shell";
import { getMailSender } from "@/mail/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { getInvitationService, getMembersService } from "@/workspaces/shared";
import {
  loadMembersPage,
  MembersPageContent,
} from "@/workspaces/ui/members-page";
import { ROLE_LABEL } from "@/workspaces/ui/role-copy";

export const metadata: Metadata = { title: "Members" };

// Who belongs to the workspace and with which role, and (for an Admin or an Owner) the invitations: the Members tab of the settings
// (#925; the page was `/members` before, which redirects here). The workspace is the one in the address, for a member only; the
// buttons show what the role allows and the routes decide again. The viewer's role is a badge next to the heading.
export default async function MembersPage({
  params,
}: PageProps<"/w/[workspace]/settings/members">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(
    slug,
    "view_members",
  );
  return (
    <MembersContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      workspaceName={workspace.name}
      viewerId={user.id}
      viewerRole={role}
    />
  );
}

async function MembersContent({
  workspaceId,
  workspaceSlug,
  workspaceName,
  viewerId,
  viewerRole,
}: {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  viewerId: string;
  viewerRole: Parameters<typeof loadMembersPage>[1];
}) {
  const [data, showPlan, showBilling] = await Promise.all([
    loadMembersPage(workspaceId, viewerRole, {
      members: getMembersService(),
      invitations: getInvitationService(),
      mail: getMailSender(),
    }),
    planPageLinkedFor(workspaceId),
    billingPageLinkedFor(),
  ]);
  return (
    <SettingsScreen
      workspaceSlug={workspaceSlug}
      current="members"
      showPlan={showPlan}
      showBilling={showBilling}
      description={`Who works in ${workspaceName}.`}
      badge={<Badge variant="outline">{ROLE_LABEL[viewerRole]}</Badge>}
    >
      <MembersPageContent
        workspaceSlug={workspaceSlug}
        viewerId={viewerId}
        viewerRole={viewerRole}
        data={data}
      />
    </SettingsScreen>
  );
}
