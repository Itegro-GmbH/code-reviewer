// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The runs of one workflow, newest first, as a dense table: status, start, trigger, what was spent of the budget and the version of the
// workflow the run started with (#873). The server renders the first snapshot; while a run runs the browser asks for newer ones, and
// it stops once every run has ended (a run started later shows up with the next visit).
import Link from "next/link";
import { useMemo } from "react";
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
import { formatUtc } from "../ui/format-time.ts";
import { useLiveSnapshot } from "../ui/use-live-snapshot.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { RunSummaryView } from "../workflow-runs/service.ts";
import {
  browserWorkflowRunsApi,
  WORKFLOW_RUN_POLL_MS,
  type WorkflowRunsApi,
} from "./api.ts";
import {
  describeRunFailure,
  describeRunPollFailure,
  PAGE_COPY,
  TRIGGER_COPY,
} from "./messages.ts";
import { WorkflowRunStatusBadge } from "./status-badge.tsx";
import { formatUsd } from "./view.ts";

export type RunListSnapshot = { runs: RunSummaryView[] };

export function WorkflowRunsList({
  workspaceSlug,
  workflowId,
  initial,
  api: apiProp,
}: {
  workspaceSlug: string;
  workflowId: string;
  initial: RunListSnapshot;
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
    fetchLatest: () => api.list(workflowId),
    isSettled: (snapshot) =>
      // A run that waits for an answer (#920) changes when somebody answers, on this page or on the ticket.
      snapshot.runs.every(
        (run) => run.status !== "running" && run.status !== "waiting",
      ),
    activeIntervalMs: WORKFLOW_RUN_POLL_MS,
    idleIntervalMs: null,
  });
  const runPath = (runId: string) =>
    workspacePath(
      workspaceSlug,
      `/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}`,
    );
  return (
    <div className="flex flex-col gap-4">
      <StatusRegion label="Updating the runs">
        {failed ? describeRunPollFailure(product, failureCode, stopped) : null}
      </StatusRegion>
      {data.runs.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{PAGE_COPY.runsHeading}</EmptyTitle>
            <EmptyDescription>{PAGE_COPY.runsEmpty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <caption className="sr-only">{PAGE_COPY.runsHeading}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{PAGE_COPY.columnStatus}</TableHead>
              <TableHead scope="col">{PAGE_COPY.columnStarted}</TableHead>
              <TableHead scope="col">{PAGE_COPY.columnTrigger}</TableHead>
              <TableHead scope="col">{PAGE_COPY.columnBudget}</TableHead>
              <TableHead scope="col">{PAGE_COPY.columnVersion}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.runs.map((run) => {
              const failure = describeRunFailure(run.errorCode);
              return (
                <TableRow key={run.id} data-run-id={run.id}>
                  <TableCell className="align-top whitespace-normal">
                    <Link
                      href={runPath(run.id)}
                      className="no-underline"
                      aria-label={`${PAGE_COPY.openRun}, ${formatUtc(run.createdAt)}`}
                    >
                      <WorkflowRunStatusBadge status={run.status} />
                    </Link>
                    {failure === null ? null : (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {failure}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal text-xs">
                    <time dateTime={run.createdAt}>
                      {formatUtc(run.createdAt)}
                    </time>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal text-xs">
                    {TRIGGER_COPY[run.trigger]}
                    {run.trigger === "manual" ? null : (
                      <span className="block text-muted-foreground">
                        {run.actorLogin}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal text-xs">
                    {formatUsd(run.spentUsd)} {PAGE_COPY.of}{" "}
                    {formatUsd(run.budgetUsd)}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal text-xs">
                    {run.workflowVersion}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
