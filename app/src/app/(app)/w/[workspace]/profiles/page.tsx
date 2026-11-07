// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { ROLE_NOT_ALLOWED } from "@/copy/messages";
import { requireImplementerCapability } from "@/implementer/shared";
import { PROFILES_COPY } from "@/profiles/ui/messages";
import { ProfilesPageContent, profileRowOf } from "@/profiles/ui/profiles-page";
import { profileServiceFor } from "@/profiles/shared";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";

export const metadata: Metadata = { title: "Profiles" };

// The profiles of the workspace (#925): who works and where. The page exists only in a deployment with the capability `implementer`
// (the access proxy answers it as a path that does not exist everywhere else; `requireImplementerCapability()` is the second wall).
// The list is read here; the drawer reads and saves one profile through the routes of #843. Like those routes, the page is for the
// members that may start a task (`start_implementer_task`).
export default async function ProfilesPage({
  params,
}: PageProps<"/w/[workspace]/profiles">) {
  requireImplementerCapability();
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  return (
    <>
      <PageHeader
        title={PROFILES_COPY.title}
        description={PROFILES_COPY.description}
      />
      {can(role, "start_implementer_task") ? (
        <ProfilesContent
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
        />
      ) : (
        <Alert variant="info" role="status">
          {ROLE_NOT_ALLOWED}
        </Alert>
      )}
    </>
  );
}

async function ProfilesContent({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}) {
  const service = profileServiceFor(workspaceId);
  const { profiles } = await service.list();
  // The harness, the model and the push right are in the current version, which the list does not carry: one read per profile (at most 100).
  const views = await Promise.all(
    profiles.map((profile) => service.get(profile.id)),
  );
  return (
    <ProfilesPageContent
      workspaceSlug={workspaceSlug}
      profiles={views.map(profileRowOf)}
    />
  );
}
