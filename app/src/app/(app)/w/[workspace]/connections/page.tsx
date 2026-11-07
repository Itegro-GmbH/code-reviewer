// SPDX-License-Identifier: LicenseRef-Proprietary

import { redirect } from "next/navigation";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { workspacePath } from "@/workspaces/paths";

// The connections became the Integrations tab of the settings (#925). An old link opens it there, with the query a flow that just
// ended left (`github`, `picker`): only those two, and only as text.
export default async function ConnectionsRedirectPage({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/connections">) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const query = await searchParams;
  const carried = new URLSearchParams();
  for (const key of ["github", "picker"]) {
    const value = query[key];
    if (typeof value === "string") carried.set(key, value);
  }
  const suffix = carried.size === 0 ? "" : `?${carried.toString()}`;
  redirect(
    `${workspacePath(workspace.slug, "/settings/integrations")}${suffix}`,
  );
}
