// SPDX-License-Identifier: LicenseRef-Proprietary

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspacePath } from "@/workspaces/paths";

// Members became a tab of the settings (#925): an old bookmark or link opens the same list there.
export default async function MembersRedirectPage({
  params,
}: PageProps<"/w/[workspace]/members">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  redirect(workspacePath(workspace.slug, "/settings/members"));
}
