// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The lane runs of a workspace as a dense table (#1078): the ticket, the lane, the project, a compact step track, the status, how long ago
// it started, how long it took and what it spent of its budget. The server renders the first page; while any run on it is active the
// browser asks for it again (`useLiveSnapshot`, like the run page), and "Show more runs" appends the next pages, which are read once.
// Everything a row shows that somebody typed (a ticket title, a lane or project name, a step note) is text, never markup.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "../components/button.tsx";
import { StatusRegion } from "../components/status-region.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { useProductIdentity } from "../product-identity/context.tsx";
import { formatDuration } from "../runs/run-duration.ts";
import { formatUtc } from "../ui/format-time.ts";
import { useLiveSnapshot } from "../ui/use-live-snapshot.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type {
  LaneRunListItemView,
  LaneRunListView,
} from "../workflow-runs/lane-run-list.ts";
import {
  browserWorkflowRunsApi,
  LANE_RUNS_WAITING_POLL_MS,
  WORKFLOW_RUN_POLL_MS,
  type LaneRunsQuery,
  type WorkflowRunsApi,
} from "./api.ts";
import {
  describeRunFailure,
  describeRunPollFailure,
  LANE_RUNS_COPY as COPY,
  PAGE_COPY,
} from "./messages.ts";
import { githubLinkInRepository } from "./github-link.ts";
import { RunTrackView } from "./run-track.tsx";
import { trackOf } from "./run-track.ts";
import { WorkflowRunStatusBadge } from "./status-badge.tsx";
import { formatRelativeTime, formatUsd, laneRunDurationMs } from "./view.ts";

const isActive = (run: Pick<LaneRunListItemView, "status">): boolean =>
  run.status === "running" || run.status === "waiting";

/** Every active run of the page only waits for an answer: nothing moves until somebody gives one, so the page asks less often. */
const onlyWaiting = (snapshot: LaneRunListView): boolean =>
  snapshot.runs.some(isActive) &&
  snapshot.runs.every((run) => !isActive(run) || run.status === "waiting");

/**
 * The runs of the pages in the order they were read, each run once, at the place it first appeared. A run can show up on two pages: the
 * list is sorted by status first, so a run that ends between two reads moves from the active runs to the ended ones.
 */
export function mergeRunPages(
  ...pages: readonly (readonly LaneRunListItemView[])[]
): LaneRunListItemView[] {
  const seen = new Set<string>();
  return pages.flat().filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

export function LaneRunsList({
  workspaceSlug,
  filter,
  initial,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** What the address asked for: the list keeps to it while it polls and when it loads more. */
  filter: LaneRunsQuery;
  initial: LaneRunListView;
  /** Only tests pass this. */
  api?: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  const defaultApi = useMemo(
    () => browserWorkflowRunsApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.listWorkspace(filter),
    // Polls while any run of the first page is running or waits for an answer (an answer is given on the run page or on the ticket).
    isSettled: (snapshot) => !snapshot.runs.some(isActive),
    activeIntervalMs: (snapshot) =>
      onlyWaiting(snapshot) ? LANE_RUNS_WAITING_POLL_MS : WORKFLOW_RUN_POLL_MS,
    idleIntervalMs: null,
  });
  // The pages after the first: read when asked, not polled. A run that moved up to the first page meanwhile is shown once, there.
  const [more, setMore] = useState<{
    runs: LaneRunListItemView[];
    nextCursor: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const runs = mergeRunPages(data.runs, more?.runs ?? []);
  const nextCursor = more === null ? data.nextCursor : more.nextCursor;

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loading) return;
    setLoading(true);
    setLoadFailed(false);
    const result = await api.listWorkspace({ ...filter, cursor: nextCursor });
    setLoading(false);
    if (!result.ok) {
      setLoadFailed(true);
      return;
    }
    setMore({
      runs: mergeRunPages(more?.runs ?? [], result.data.runs),
      nextCursor: result.data.nextCursor,
    });
  }

  const filtered =
    filter.status !== undefined ||
    filter.project !== undefined ||
    filter.lane !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <StatusRegion label={COPY.updating}>
        {failed ? describeRunPollFailure(product, failureCode, stopped) : null}
        {loadFailed ? COPY.loadMoreFailed : null}
      </StatusRegion>
      {runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{COPY.emptyTitle}</EmptyTitle>
            <EmptyDescription>
              {filtered ? COPY.emptyFiltered : COPY.emptyDescription}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <caption className="sr-only">{COPY.listLabel}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{COPY.columnTicket}</TableHead>
              <TableHead scope="col">{COPY.columnLane}</TableHead>
              <TableHead scope="col">{COPY.columnProject}</TableHead>
              <TableHead scope="col">{COPY.columnSteps}</TableHead>
              <TableHead scope="col">{COPY.columnStatus}</TableHead>
              <TableHead scope="col">{COPY.columnStarted}</TableHead>
              <TableHead scope="col">{COPY.columnDuration}</TableHead>
              <TableHead scope="col">{COPY.columnSpent}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <LaneRunRow
                key={run.id}
                run={run}
                now={data.now}
                workspaceSlug={workspaceSlug}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {nextCursor === null ? null : (
        <div>
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? COPY.loadingMore : COPY.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

function LaneRunRow({
  run,
  now,
  workspaceSlug,
}: {
  run: LaneRunListItemView;
  now: string;
  workspaceSlug: string;
}) {
  const failure = describeRunFailure(run.errorCode);
  const duration = laneRunDurationMs(run, now);
  const track = trackOf(run.nodes, run.steps, run.status);
  const ticketUrl =
    run.ticket?.githubRepository == null
      ? undefined
      : githubLinkInRepository(
          `https://github.com/${run.ticket.githubRepository}/issues/${encodeURIComponent(run.ticket.key)}`,
          run.ticket.githubRepository,
        );
  const runPath = workspacePath(
    workspaceSlug,
    `/workflows/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`,
  );
  return (
    <TableRow
      data-run-id={run.id}
      // A discarded run stays listed, greyed (#921).
      className={run.status === "discarded" ? "opacity-60" : undefined}
    >
      <TableCell className="max-w-64 align-top whitespace-normal text-xs">
        {run.ticket === null ? (
          <span className="text-muted-foreground">{COPY.noTicket}</span>
        ) : (
          <>
            {ticketUrl === undefined ? (
              <span className="font-medium">{run.ticket.label}</span>
            ) : (
              <a
                href={ticketUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium"
                aria-label={`${COPY.openTicket} ${run.ticket.label}`}
              >
                {run.ticket.label}
              </a>
            )}
            <span className="block break-words text-muted-foreground">
              {run.ticket.title ?? COPY.ticketUntitled}
            </span>
          </>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        <Link
          href={runPath}
          className="font-medium"
          aria-label={`${COPY.openRun}: ${run.laneName}, ${COPY.version} ${String(run.workflowVersion)}, ${formatUtc(run.createdAt)}`}
        >
          {run.laneName}
        </Link>
        <span className="block text-muted-foreground">
          {COPY.version} {run.workflowVersion}
        </span>
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        {run.project.name ?? (
          <span className="text-muted-foreground">{COPY.projectGone}</span>
        )}
      </TableCell>
      <TableCell className="min-w-36 max-w-56 align-top whitespace-normal">
        <RunTrackView track={track} />
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <WorkflowRunStatusBadge status={run.status} />
        {failure === null ? null : (
          <span className="mt-1 block text-xs text-muted-foreground">
            {failure}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        <time dateTime={run.createdAt} title={formatUtc(run.createdAt)}>
          {formatRelativeTime(run.createdAt, now)}
        </time>
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        {duration === null ? COPY.notAvailable : formatDuration(duration)}
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        {formatUsd(run.spentUsd)} {PAGE_COPY.of} {formatUsd(run.budgetUsd)}
      </TableCell>
    </TableRow>
  );
}
