// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { operatorMaximumCents } from "@/implementer/shared";
import { runsServiceFor } from "@/runs/shared";
import {
  loadRunDetailPage,
  RunDetailPageContent,
} from "@/runs/ui/run-detail-page";
import { requireWorkspace } from "@/workspaces/access-runtime";

export const metadata: Metadata = { title: "Run" };

// One run: what it was about, its status and times, the link to the review comment and the end of
// its log. The address names the workspace and the run by its id. An id nobody has in this workspace (also
// the id of a run of another workspace) shows the not-found page and nothing of any other run; with Cache
// Components the data sits behind the layout's <Suspense>, so the response is already streaming and its HTTP
// status stays 200 (a status of 404 would need the lookup before the first byte). The data route
// `GET /api/w/:workspace/runs/:id` answers a real 404.
export default async function RunPage({
  params,
}: PageProps<"/w/[workspace]/runs/[id]">) {
  const { workspace: slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  return (
    <RunContent
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      id={id}
    />
  );
}

async function RunContent({
  workspaceId,
  workspaceSlug,
  id,
}: {
  workspaceId: string;
  workspaceSlug: string;
  id: string;
}) {
  const data = await loadRunDetailPage(id, {
    runs: runsServiceFor(workspaceId),
  });
  if (data.kind === "not_found") notFound();
  // #841: the "Continue" form under a task needs the operator's maximum for its cost field; a review has no such form.
  return (
    <RunDetailPageContent
      workspaceSlug={workspaceSlug}
      data={data}
      {...(data.snapshot.run.implementer === undefined
        ? {}
        : { operatorMaximumCents: await operatorMaximumCents() })}
    />
  );
}
