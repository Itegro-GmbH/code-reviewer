// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getConfigStatusFor } from "@/config-status/shared";
import { projectServiceFor } from "@/projects/shared";
import { SETUP_COPY } from "@/projects/ui/cockpit-messages";
import { loadProjectRow } from "@/projects/ui/list-view";
import { projectPath } from "@/projects/ui/project-cards";
import { ProjectToggle } from "@/projects/ui/project-toggle";
import { SyncButton } from "@/projects/ui/sync-button";
import { TicketSourceCard } from "@/projects/ui/project-tabs";
import { ACTIVATION_BLOCKED_TEXT } from "@/projects/ui/projects-page";
import { StartReviewDialog } from "@/manual-reviews/ui/start-review-dialog";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · Setup" };

// The setup of one project (#925): its ticket source (one, in its own words), the switch that turns the project on, the re-read of the
// repositories from GitHub and the way to the review settings. The switch and the re-read are the ones of the old project list.
export default async function ProjectSetupPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/setup">) {
  const { workspace: slug, repositoryId } = await params;
  const { workspace, role, user } = await requireWorkspace(slug);
  return (
    <CockpitFrame
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      repositoryId={repositoryId}
      tab="setup"
    >
      <SetupContent
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
        repositoryId={repositoryId}
        canManage={can(role, "manage_projects")}
        canConnect={can(role, "manage_connections")}
        canStartReview={can(role, "start_review")}
        user={user}
      />
    </CockpitFrame>
  );
}

async function SetupContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  canManage,
  canConnect,
  canStartReview,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  canManage: boolean;
  canConnect: boolean;
  canStartReview: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const [row, config] = await Promise.all([
    loadProjectRow(repositoryId, { projects: projectServiceFor(workspaceId) }),
    getConfigStatusFor(user),
  ]);
  if (row === undefined) notFound();
  const blockedReason =
    row.status === "unavailable"
      ? "The GitHub App can no longer read this repository."
      : config.githubApp.configured
        ? null
        : ACTIVATION_BLOCKED_TEXT;
  return (
    <div className="flex flex-col gap-8">
      <TicketSourceCard row={row} />
      <section
        aria-labelledby="setup-switch-heading"
        className="flex max-w-[45rem] flex-col gap-3"
      >
        <h2
          id="setup-switch-heading"
          className="text-lg leading-7 font-semibold"
        >
          {SETUP_COPY.switchTitle}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <ProjectToggle
            key={`${row.repositoryId}:${String(row.switchedOn)}`}
            workspaceSlug={workspaceSlug}
            canManage={canManage}
            repositoryId={row.repositoryId}
            fullName={row.fullName}
            checked={row.switchedOn}
            blockedReason={blockedReason}
          />
          {canStartReview ? (
            <StartReviewDialog
              workspaceSlug={workspaceSlug}
              repositoryId={row.repositoryId}
              fullName={row.fullName}
              startable={row.status === "active"}
            />
          ) : null}
          {canConnect ? <SyncButton workspaceSlug={workspaceSlug} /> : null}
        </div>
      </section>
      <section
        aria-labelledby="setup-review-heading"
        className="flex max-w-[45rem] flex-col gap-2"
      >
        <h2
          id="setup-review-heading"
          className="text-lg leading-7 font-semibold"
        >
          {SETUP_COPY.review}
        </h2>
        <p className="text-sm text-muted-foreground">{SETUP_COPY.reviewHint}</p>
        <p>
          <Link href={projectPath(workspaceSlug, row.repositoryId, "review")}>
            {SETUP_COPY.reviewLink}
          </Link>
        </p>
      </section>
    </div>
  );
}
