// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCapabilities } from "@/capabilities/shared";
import { Badge } from "@/components/ui/badge";
import { getMailSender } from "@/mail/shared";
import { PageHeader } from "@/components/page-header";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspacePath } from "@/workspaces/paths";
import { getInvitationService, getMembersService } from "@/workspaces/shared";
import {
  loadMembersPage,
  MembersPageContent,
} from "@/workspaces/ui/members-page";
import { ROLE_LABEL } from "@/workspaces/ui/role-copy";

export const metadata: Metadata = { title: "Members" };

// Who belongs to the workspace and with which role, and (for an Admin or an Owner) the invitations. The
// workspace is the one in the address, for a member only; the buttons show what the role allows and the
// routes decide again. The viewer's role is a badge next to the title; Members is its own area root, so
// it shows no breadcrumb (lead decision 2026-10-13, epic #165). In the factory (#925) the members are a tab of the settings and this
// address redirects there.
export default async function MembersPage({
  params,
}: PageProps<"/w/[workspace]/members">) {
  const { workspace: slug } = await params;
  const { workspace, role, user } = await requireWorkspace(
    slug,
    "view_members",
  );
  if (getCapabilities().has("implementer"))
    redirect(workspacePath(workspace.slug, "/settings/members"));
  return (
    <>
      <PageHeader
        title="Members"
        description={`Who works in ${workspace.name}.`}
        badge={<Badge variant="outline">{ROLE_LABEL[role]}</Badge>}
      />
      <MembersContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        viewerId={user.id}
        viewerRole={role}
      />
    </>
  );
}

async function MembersContent({
  workspaceId,
  workspaceSlug,
  viewerId,
  viewerRole,
}: {
  workspaceId: string;
  workspaceSlug: string;
  viewerId: string;
  viewerRole: Parameters<typeof loadMembersPage>[1];
}) {
  const data = await loadMembersPage(workspaceId, viewerRole, {
    members: getMembersService(),
    invitations: getInvitationService(),
    mail: getMailSender(),
  });
  return (
    <MembersPageContent
      workspaceSlug={workspaceSlug}
      viewerId={viewerId}
      viewerRole={viewerRole}
      data={data}
    />
  );
}
