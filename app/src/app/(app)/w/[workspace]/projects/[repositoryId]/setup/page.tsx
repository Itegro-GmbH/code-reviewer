// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getConfigStatusFor } from "@/config-status/shared";
import { requireImplementerCapability } from "@/implementer/shared";
import { projectServiceFor } from "@/projects/shared";
import { SETUP_COPY } from "@/projects/ui/cockpit-messages";
import { loadProjectRow } from "@/projects/ui/list-view";
import { projectPath } from "@/projects/ui/project-cards";
import { ProjectToggle } from "@/projects/ui/project-toggle";
import { SyncButton } from "@/projects/ui/sync-button";
import { TicketSourceCard } from "@/projects/ui/project-tabs";
import { syncStaleness, type SyncState } from "@/projects/ui/sync-staleness";
import { TicketSourceControls } from "@/projects/ui/ticket-source-controls";
import { TrackerError } from "@/tracker/errors";
import { trackerServiceFor } from "@/tracker/shared";
import { ACTIVATION_BLOCKED_TEXT } from "@/projects/ui/projects-page";
import { StartReviewDialog } from "@/manual-reviews/ui/start-review-dialog";
import { requireWorkspace } from "@/workspaces/access-runtime";
import { can } from "@/workspaces/permissions";
import { CockpitFrame } from "../cockpit-frame";

export const metadata: Metadata = { title: "Project · Setup" };

// The setup of one project (#925): its ticket source (one, in its own words, with the board it takes (#937) and the "Resync" of its tickets
// with the hint that they may be out of date), the switch that turns the project on, the re-read of the repositories from GitHub and the way
// to the review settings. The switch and the re-read are the ones of the old project list. Only in a deployment with the capability
// `implementer`: elsewhere the project list has these controls.
export default async function ProjectSetupPage({
  params,
}: PageProps<"/w/[workspace]/projects/[repositoryId]/setup">) {
  requireImplementerCapability();
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
        canChangeSettings={can(role, "change_project_settings")}
        canConnect={can(role, "manage_connections")}
        canStartReview={can(role, "start_review")}
        user={user}
      />
    </CockpitFrame>
  );
}

/** Codes that only say there is nothing to tell: the repository is gone or its project is off, so the page has no hint. */
const NO_STATE_CODES: ReadonlySet<string> = new Set([
  "TRACKER_REPOSITORY_NOT_FOUND",
  "TRACKER_PROJECT_NOT_ACTIVE",
]);

/**
 * Where the ticket cache stands, or null for no hint. A project that is off or a repository that is gone is expected; anything else is
 * logged by its code (never the message) and the page renders without the hint.
 */
async function syncStateOf(
  workspaceId: string,
  repositoryId: string,
): Promise<SyncState | null> {
  try {
    return await trackerServiceFor(workspaceId).syncState(repositoryId);
  } catch (error) {
    const code =
      error instanceof TrackerError
        ? error.code
        : error instanceof Error
          ? error.name
          : "unknown";
    if (!NO_STATE_CODES.has(code))
      console.error(`[setup] reading the sync state failed (${code})`);
    return null;
  }
}

async function SetupContent({
  workspaceId,
  workspaceSlug,
  repositoryId,
  canManage,
  canChangeSettings,
  canConnect,
  canStartReview,
  user,
}: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryId: string;
  canManage: boolean;
  canChangeSettings: boolean;
  canConnect: boolean;
  canStartReview: boolean;
  user: { isInstanceAdmin: boolean };
}) {
  const projects = projectServiceFor(workspaceId);
  const [row, entry, config, sync] = await Promise.all([
    loadProjectRow(repositoryId, { projects }),
    projects.findProject(repositoryId),
    getConfigStatusFor(user),
    syncStateOf(workspaceId, repositoryId),
  ]);
  if (row === undefined) notFound();
  const project = entry?.project ?? null;
  const blockedReason =
    row.status === "unavailable"
      ? "The GitHub App can no longer read this repository."
      : config.githubApp.configured
        ? null
        : ACTIVATION_BLOCKED_TEXT;
  return (
    <div className="flex flex-col gap-8">
      <TicketSourceCard row={row}>
        {project === null ? null : (
          <>
            <TicketSourceControls
              key={project.id}
              workspaceSlug={workspaceSlug}
              projectId={project.id}
              repositoryId={row.repositoryId}
              board={project.ticketSource.board?.projectV2Id ?? null}
              canChange={canManage}
              showResync={canChangeSettings && row.switchedOn}
              staleness={syncStaleness(sync, new Date())}
            />
          </>
        )}
      </TicketSourceCard>
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
