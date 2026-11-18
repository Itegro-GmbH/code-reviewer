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
import {
  laneNodesFor,
  type LaneNodesByKey,
  type LaneNodeView,
} from "../workflow-runs/lane-nodes.ts";
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
  TRIGGER_COPY,
} from "./messages.ts";
import { githubLinkInRepository } from "./github-link.ts";
import { jiraIssueLink } from "./jira-link.ts";
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
  inLane,
  api: apiProp,
}: {
  workspaceSlug: string;
  /** What the address asked for: the list keeps to it while it polls and when it loads more. */
  filter: LaneRunsQuery;
  initial: LaneRunListView;
  /**
   * The list is the Runs section of one lane's page (#1080): `filter.lane` is the page's own, so an empty list is no filter's doing, and the
   * lane and the project are the page's too (no column for them). `canStart` is whether the page offers to start the lane (a member who may,
   * a lane that is not archived and has a form): the empty text promises "Run now" only then.
   */
  inLane?: { canStart: boolean };
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
    laneNodes: LaneNodesByKey;
    nextCursor: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const runs = mergeRunPages(data.runs, more?.runs ?? []);
  // The nodes of a lane version never change, so the entries of every page read so far can be pooled.
  const laneNodes = { ...more?.laneNodes, ...data.laneNodes };
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
      laneNodes: { ...more?.laneNodes, ...result.data.laneNodes },
      nextCursor: result.data.nextCursor,
    });
  }

  const filtered =
    filter.status !== undefined ||
    filter.project !== undefined ||
    (filter.lane !== undefined && inLane === undefined);
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
              {filtered
                ? COPY.emptyFiltered
                : inLane === undefined
                  ? COPY.emptyDescription
                  : inLane.canStart
                    ? COPY.emptyInLaneStartable
                    : COPY.emptyInLane}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <caption className="sr-only">{COPY.listLabel}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{COPY.columnTicket}</TableHead>
              {inLane === undefined ? (
                <>
                  <TableHead scope="col">{COPY.columnLane}</TableHead>
                  <TableHead scope="col">{COPY.columnProject}</TableHead>
                </>
              ) : null}
              <TableHead scope="col">{COPY.columnSteps}</TableHead>
              <TableHead scope="col">{COPY.columnStatus}</TableHead>
              <TableHead scope="col">{COPY.columnTrigger}</TableHead>
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
                nodes={laneNodesFor(laneNodes, run.nodesKey)}
                now={data.now}
                workspaceSlug={workspaceSlug}
                inLane={inLane !== undefined}
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
  nodes,
  now,
  workspaceSlug,
  inLane,
}: {
  run: LaneRunListItemView;
  /** The top-level nodes of the lane version of the run (`laneNodes` of the list, by `run.nodesKey`). */
  nodes: readonly LaneNodeView[];
  now: string;
  workspaceSlug: string;
  /** On the page of one lane the row has no lane and project cell, and the ticket column links to the run. */
  inLane: boolean;
}) {
  const failure = describeRunFailure(run.errorCode);
  const duration = laneRunDurationMs(run, now);
  const track = trackOf(nodes, run.steps, run.status);
  const ticketUrl =
    run.ticket === null
      ? undefined
      : run.ticket.githubRepository !== null
        ? githubLinkInRepository(
            `https://github.com/${run.ticket.githubRepository}/issues/${encodeURIComponent(run.ticket.key)}`,
            run.ticket.githubRepository,
          )
        : jiraIssueLink(run.ticket.jiraSiteUrl, run.ticket.key);
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
      {inLane ? null : (
        <>
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
        </>
      )}
      <TableCell className="min-w-36 max-w-56 align-top whitespace-normal">
        <RunTrackView track={track} />
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        {inLane ? (
          // The lane cell, which links to the run elsewhere, is not in this row: the status is the link.
          <Link
            href={runPath}
            className="no-underline"
            aria-label={`${COPY.openRun}: ${run.laneName}, ${COPY.version} ${String(run.workflowVersion)}, ${formatUtc(run.createdAt)}`}
          >
            <WorkflowRunStatusBadge status={run.status} />
          </Link>
        ) : (
          <WorkflowRunStatusBadge status={run.status} />
        )}
        {failure === null ? null : (
          <span className="mt-1 block text-xs text-muted-foreground">
            {failure}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal text-xs">
        {TRIGGER_COPY[run.trigger]}
        {run.trigger === "manual" ? null : (
          <span className="block text-muted-foreground">{run.actorLogin}</span>
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
