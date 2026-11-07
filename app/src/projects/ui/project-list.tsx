// SPDX-License-Identifier: LicenseRef-Proprietary

// The list of repositories on the Projects page, as a compact table: name (a link to the settings,
// also while the repository is inactive), installation, state, the status of the last run and the
// switch. Everything that comes from GitHub (names, addresses) is untrusted and rendered as text; a
// long name truncates instead of widening the page.
import Link from "next/link";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { StartReviewDialog } from "../../manual-reviews/ui/start-review-dialog.tsx";
import type { ManualReviewApi } from "../../manual-reviews/ui/api.ts";
import { NoRepositories } from "./no-repositories.tsx";
import { ProjectToggle } from "./project-toggle.tsx";
import type { ProjectsApi } from "./api.ts";
import { PROJECT_STATE_BADGE, PROJECT_STATE_LABEL } from "./messages.ts";
import { RunStatusBadge } from "../../runs/ui/status-badge.tsx";
import type { LastRun, ProjectListView, ProjectRowView } from "./list-view.ts";

function LastRunStatus({
  run,
  repositoryId,
  workspaceSlug,
}: {
  run: LastRun | null;
  repositoryId: string;
  workspaceSlug: string;
}) {
  if (run === null)
    return <span className="text-muted-foreground">No run yet</span>;
  // The design board's last run (#633): the status as the badge of the Runs page, the time and the
  // link in small text below it.
  return (
    <div className="flex flex-col items-start gap-1">
      <RunStatusBadge status={run.status} />
      <span className="text-xs text-muted-foreground">
        <time dateTime={run.at}>{formatUtc(run.at)}</time>
        {" · "}
        <Link
          className="text-muted-foreground"
          href={workspacePath(
            workspaceSlug,
            `/runs?repository=${encodeURIComponent(repositoryId)}`,
          )}
        >
          All runs
        </Link>
      </span>
    </div>
  );
}

function blockedReasonOf(
  row: ProjectRowView,
  activationBlocked: string | null,
): string | null {
  if (row.status === "unavailable")
    return "The GitHub App can no longer read this repository.";
  return activationBlocked;
}

export function ProjectList({
  workspaceSlug,
  canManage = true,
  canConnect = true,
  canStartReview = true,
  view,
  activationBlocked,
  api,
  manualReviewApi,
}: {
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  /** Whether the person may switch projects on and off (an Admin or an Owner). */
  canManage?: boolean;
  /** Whether the person may connect GitHub (an Admin or an Owner). */
  canConnect?: boolean;
  /** Whether the person may start a review by hand (`start_review`, every member today): the play button of a row (#655). */
  canStartReview?: boolean;
  view: ProjectListView;
  /** Why no project can be switched on right now (the GitHub App is not configured), or null. */
  activationBlocked: string | null;
  api?: ProjectsApi;
  /** Only tests pass this: the calls of the play button's dialog. */
  manualReviewApi?: ManualReviewApi;
}) {
  if (view.rows.length === 0)
    return (
      <NoRepositories
        connectionsPath={workspacePath(workspaceSlug, "/connections")}
        canConnect={canConnect}
      />
    );
  return (
    <>
      {/* A minimum width: on a narrow window the table scrolls inside its card instead of squeezing the Review column's switch and play button out of their cell. */}
      <Table aria-label="Repositories" className="min-w-[680px] table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[26%]">Name</TableHead>
            <TableHead className="w-[14%]">Installation</TableHead>
            <TableHead className="w-[12%]">Status</TableHead>
            <TableHead className="w-[24%]">Last run</TableHead>
            <TableHead className="w-[24%]">Review</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.rows.map((row) => (
            <TableRow key={row.repositoryId}>
              <TableCell className="min-w-0 align-top whitespace-normal">
                <Link
                  href={workspacePath(
                    workspaceSlug,
                    `/projects/${encodeURIComponent(row.repositoryId)}`,
                  )}
                  className="block truncate font-semibold text-foreground no-underline"
                >
                  {row.fullName}
                </Link>
                {row.url !== null ? (
                  <a
                    href={row.url}
                    rel="noreferrer noopener"
                    target="_blank"
                    aria-label={`${row.fullName} on GitHub`}
                    className="text-xs text-muted-foreground hover:text-foreground no-underline"
                  >
                    On GitHub
                  </a>
                ) : null}
              </TableCell>
              <TableCell className="align-top whitespace-normal break-words text-muted-foreground">
                {row.installation}
              </TableCell>
              <TableCell className="align-top">
                <Badge variant={PROJECT_STATE_BADGE[row.status]}>
                  {PROJECT_STATE_LABEL[row.status]}
                </Badge>
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                <LastRunStatus
                  run={row.lastRun}
                  repositoryId={row.repositoryId}
                  workspaceSlug={workspaceSlug}
                />
                {row.status === "unavailable" && row.switchedOn ? (
                  <p className="text-xs text-muted-foreground">
                    It was on and resumes if the repository comes back.
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="align-top">
                <div className="flex items-center gap-2">
                  <ProjectToggle
                    key={`${row.repositoryId}:${String(row.switchedOn)}`}
                    workspaceSlug={workspaceSlug}
                    canManage={canManage}
                    repositoryId={row.repositoryId}
                    fullName={row.fullName}
                    checked={row.switchedOn}
                    blockedReason={blockedReasonOf(row, activationBlocked)}
                    {...(api === undefined ? {} : { api })}
                  />
                  {canStartReview ? (
                    <StartReviewDialog
                      workspaceSlug={workspaceSlug}
                      repositoryId={row.repositoryId}
                      fullName={row.fullName}
                      startable={row.status === "active"}
                      {...(manualReviewApi === undefined
                        ? {}
                        : { api: manualReviewApi })}
                    />
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {canManage ? null : (
        <p className="mt-3 text-sm text-muted-foreground">
          Members see the switches read only: Only Admins and Owners can switch
          a project on or off.
        </p>
      )}
    </>
  );
}
