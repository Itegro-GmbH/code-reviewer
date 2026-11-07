// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The Issues tab of a project (#925, prototype board "3 Project"): the tiles, the table of its issues and the drawer and the start dialog
// that open from it. The table says what GitHub says (state and board status, never mapped) and what the factory adds (the lane on the
// issue and its step) and what the issue waits for: Start (a person starts a lane), Answer (the run asks; the link goes to the question on
// the run page until the ToDo answer panel, #924, exists) or Review (the pull request on GitHub). The server renders the first list and the
// board asks again while a lane is on an issue (and slowly otherwise), the way the runs list does.
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "../components/button.tsx";
import { NativeSelect } from "../components/native-select.tsx";
import { StatusRegion } from "../components/status-region.tsx";
import { Badge } from "../components/ui/badge.tsx";
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
import { describePollFailure } from "../runs/ui/poll-messages.ts";
import { useLiveSnapshot } from "../ui/use-live-snapshot.ts";
import { workspacePath } from "../workspaces/paths.ts";
import type { TicketList, TicketListItem } from "../tracker/service.ts";
import type { WorkflowRunsApi } from "../workflow-pages/api.ts";
import {
  ISSUES_LISTED,
  ISSUES_POLL,
  browserIssuesApi,
  type IssuesApi,
} from "./api.ts";
import { IssueDrawer } from "./issue-drawer.tsx";
import { BOARD_COPY, TILES_COPY, WAITS_COPY } from "./messages.ts";
import { StartLaneDialog } from "./start-lane-dialog.tsx";
import type { StartLane } from "./start-lanes.ts";
import {
  boardTiles,
  formatUsd,
  issuesOf,
  ticketUrl,
  waitsFor,
  type WaitsFor,
} from "./view.ts";

type Filter = "open" | "all";

export function IssuesBoard({
  workspaceSlug,
  repositoryId,
  projectId,
  initial,
  lanes,
  mayStart,
  api: apiProp,
  runsApi,
}: {
  workspaceSlug: string;
  repositoryId: string;
  /** The project of the repository, or null when the repository is no project. */
  projectId: string | null;
  /** The first list, or null when the tickets are not mirrored. */
  initial: TicketList | null;
  lanes: readonly StartLane[];
  /** Whether the person may start a lane (`start_implementer_task`). */
  mayStart: boolean;
  /** Only tests pass these. */
  api?: IssuesApi;
  runsApi?: WorkflowRunsApi;
}) {
  if (initial === null || projectId === null) return <EmptyBoard />;
  return (
    <LiveBoard
      workspaceSlug={workspaceSlug}
      repositoryId={repositoryId}
      projectId={projectId}
      initial={initial}
      lanes={lanes}
      mayStart={mayStart}
      {...(apiProp === undefined ? {} : { api: apiProp })}
      {...(runsApi === undefined ? {} : { runsApi })}
    />
  );
}

function EmptyBoard() {
  return (
    <div className="flex flex-col gap-8">
      <Tiles list={null} />
      <section aria-labelledby="issues-heading" className="flex flex-col gap-3">
        <BoardHeading />
        <BoardTable>
          <TableRow>
            <TableCell colSpan={4} className="whitespace-normal">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{BOARD_COPY.emptyTitle}</EmptyTitle>
                  <EmptyDescription>
                    {BOARD_COPY.emptyDescription}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </TableCell>
          </TableRow>
        </BoardTable>
        <p className="text-xs text-muted-foreground">{BOARD_COPY.footnote}</p>
      </section>
    </div>
  );
}

function BoardHeading() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="issues-heading" className="text-lg leading-7 font-semibold">
        {BOARD_COPY.title}
      </h2>
      <p className="text-sm text-muted-foreground">{BOARD_COPY.hint}</p>
    </div>
  );
}

function BoardTable({ children }: { children: React.ReactNode }) {
  return (
    <Table aria-label={BOARD_COPY.tableLabel} className="min-w-[760px]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{BOARD_COPY.columns.issue}</TableHead>
          <TableHead scope="col">{BOARD_COPY.columns.github}</TableHead>
          <TableHead scope="col">{BOARD_COPY.columns.lane}</TableHead>
          <TableHead scope="col">{BOARD_COPY.columns.waits}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function Tiles({ list }: { list: TicketList | null }) {
  const tiles = list === null ? null : boardTiles(list);
  const cells = [
    { ...TILES_COPY.open, value: tiles === null ? "–" : String(tiles.open) },
    {
      ...TILES_COPY.working,
      value: tiles === null ? "–" : String(tiles.working),
    },
    {
      ...TILES_COPY.waiting,
      value: tiles === null ? "–" : String(tiles.waiting),
    },
    {
      ...TILES_COPY.spent,
      value: tiles === null ? "–" : formatUsd(tiles.spentUsd),
    },
  ];
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
      {cells.map((tile) => (
        <li
          key={tile.name}
          className="flex flex-col gap-1 rounded-2xl border border-border bg-surface p-4"
        >
          <span className="text-sm text-muted-foreground">{tile.name}</span>
          <span className="font-mono text-3xl leading-9">{tile.value}</span>
          <span className="text-xs text-muted-foreground">{tile.note}</span>
        </li>
      ))}
    </ul>
  );
}

function LiveBoard({
  workspaceSlug,
  repositoryId,
  projectId,
  initial,
  lanes,
  mayStart,
  api: apiProp,
  runsApi,
}: {
  workspaceSlug: string;
  repositoryId: string;
  projectId: string;
  initial: TicketList;
  lanes: readonly StartLane[];
  mayStart: boolean;
  api?: IssuesApi;
  runsApi?: WorkflowRunsApi;
}) {
  const product = useProductIdentity();
  const defaultApi = useMemo(
    () => browserIssuesApi(workspaceSlug),
    [workspaceSlug],
  );
  const api = apiProp ?? defaultApi;
  const { data, failed, failureCode, stopped } = useLiveSnapshot({
    initial,
    fetchLatest: () => api.list(projectId),
    isSettled: (list) => issuesOf(list).every((item) => item.lane === null),
    activeIntervalMs: ISSUES_POLL.activeMs,
    idleIntervalMs: ISSUES_POLL.idleMs,
  });
  const [filter, setFilter] = useState<Filter>("open");
  const [opened, setOpened] = useState<number | null>(null);
  const [starting, setStarting] = useState<number | null>(null);
  const issues = issuesOf(data);
  const shown =
    filter === "open" ? issues.filter((item) => item.state === "open") : issues;
  const openedItem =
    opened === null ? undefined : issues.find((item) => item.number === opened);
  return (
    <div className="flex flex-col gap-8">
      <Tiles list={data} />
      <section aria-labelledby="issues-heading" className="flex flex-col gap-3">
        <BoardHeading />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {BOARD_COPY.filterLabel}
            <NativeSelect
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value === "all" ? "all" : "open")
              }
              className="h-9 w-auto"
            >
              <option value="open">{BOARD_COPY.filterOpen}</option>
              <option value="all">{BOARD_COPY.filterAll}</option>
            </NativeSelect>
          </label>
          <SyncLine data={data} />
        </div>
        <StatusRegion label={BOARD_COPY.updating} className="text-warning">
          {failed
            ? describePollFailure(
                product,
                failureCode,
                stopped,
                BOARD_COPY.updateFailed,
              )
            : ""}
        </StatusRegion>
        <BoardTable>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="whitespace-normal">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      {issues.length === 0
                        ? BOARD_COPY.emptyTitle
                        : BOARD_COPY.noneOpenTitle}
                    </EmptyTitle>
                    <EmptyDescription>
                      {issues.length === 0
                        ? BOARD_COPY.emptyDescription
                        : BOARD_COPY.noneOpenDescription}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          ) : (
            shown.map((item) => (
              <IssueRow
                key={item.number}
                workspaceSlug={workspaceSlug}
                repo={data.repo}
                item={item}
                mayStart={mayStart}
                hasLanes={lanes.length > 0}
                onOpen={() => setOpened(item.number)}
                onStart={() => setStarting(item.number)}
              />
            ))
          )}
        </BoardTable>
        {data.items.length >= ISSUES_LISTED ? (
          <p className="text-xs text-muted-foreground">
            {BOARD_COPY.limited(data.items.length)}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{BOARD_COPY.footnote}</p>
      </section>
      <IssueDrawer
        workspaceSlug={workspaceSlug}
        repositoryId={repositoryId}
        projectId={projectId}
        list={data}
        item={openedItem}
        onClose={() => setOpened(null)}
        {...(apiProp === undefined ? {} : { api: apiProp })}
      />
      <StartLaneDialog
        workspaceSlug={workspaceSlug}
        repo={data.repo}
        issueNumber={starting}
        lanes={lanes}
        onOpenChange={(open) => {
          if (!open) setStarting(null);
        }}
        {...(runsApi === undefined ? {} : { api: runsApi })}
      />
    </div>
  );
}

function SyncLine({ data }: { data: TicketList }) {
  const text = data.sync.inProgress
    ? BOARD_COPY.syncing
    : data.sync.lastFullSyncAt === null
      ? BOARD_COPY.neverSynced
      : BOARD_COPY.lastSync(formatUtc(data.sync.lastFullSyncAt));
  return <span className="text-xs text-muted-foreground">{text}</span>;
}

function IssueRow({
  workspaceSlug,
  repo,
  item,
  mayStart,
  hasLanes,
  onOpen,
  onStart,
}: {
  workspaceSlug: string;
  repo: string;
  item: TicketListItem;
  mayStart: boolean;
  hasLanes: boolean;
  onOpen: () => void;
  onStart: () => void;
}) {
  const address = ticketUrl(repo, item);
  return (
    <TableRow data-issue={item.number}>
      <TableCell className="min-w-0 align-top whitespace-normal">
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onOpen}
            aria-label={BOARD_COPY.openIssue(item.number)}
            className="cursor-pointer border-0 bg-transparent p-0 text-left font-semibold break-words text-foreground"
          >
            <span className="font-mono text-muted-foreground">
              #{item.number}
            </span>{" "}
            {item.title}
          </button>
          <div className="flex flex-wrap items-center gap-1">
            {item.type === null ? null : (
              <Badge variant="info" icon={false}>
                {item.type}
              </Badge>
            )}
            {item.labels.map((label) => (
              <Badge key={label.name} variant="neutral" icon={false}>
                {label.name}
              </Badge>
            ))}
            {address === undefined ? null : (
              <a
                href={address}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Issue #${String(item.number)} on GitHub`}
                className="text-xs"
              >
                GitHub
              </a>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-col gap-1">
          <Badge variant={item.state === "open" ? "success" : "neutral"}>
            {item.state}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {item.boardStatus ?? BOARD_COPY.noBoardStatus}
          </span>
        </div>
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        {item.lane === null ? (
          <span className="text-xs text-muted-foreground">
            {BOARD_COPY.noLane}
          </span>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="font-semibold break-words">{item.lane.name}</span>
            {item.lane.step === null ? null : (
              <span className="text-xs text-muted-foreground">
                {BOARD_COPY.step(item.lane.step)}
              </span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        <WaitsCell
          workspaceSlug={workspaceSlug}
          number={item.number}
          waits={waitsFor(repo, item)}
          mayStart={mayStart}
          hasLanes={hasLanes}
          onStart={onStart}
        />
      </TableCell>
    </TableRow>
  );
}

function WaitsCell({
  workspaceSlug,
  number,
  waits,
  mayStart,
  hasLanes,
  onStart,
}: {
  workspaceSlug: string;
  number: number;
  waits: WaitsFor | undefined;
  mayStart: boolean;
  hasLanes: boolean;
  onStart: () => void;
}) {
  if (waits === undefined)
    return <span className="text-muted-foreground">{WAITS_COPY.none}</span>;
  if (waits.kind === "answer")
    return (
      <Button asChild size="sm">
        <Link
          href={workspacePath(
            workspaceSlug,
            `/workflows/${encodeURIComponent(waits.workflowId)}/runs/${encodeURIComponent(waits.runId)}`,
          )}
          aria-label={WAITS_COPY.answerLabel(number)}
        >
          {WAITS_COPY.answer}
        </Link>
      </Button>
    );
  if (waits.kind === "review")
    return (
      <Button asChild size="sm" variant="secondary">
        <a
          href={waits.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={WAITS_COPY.reviewLabel(number)}
        >
          {WAITS_COPY.review}
        </a>
      </Button>
    );
  const reason = !mayStart
    ? WAITS_COPY.notAllowed
    : !hasLanes
      ? WAITS_COPY.noLanes
      : undefined;
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        onClick={onStart}
        disabled={reason !== undefined}
        aria-label={WAITS_COPY.startLabel(number)}
        title={reason}
      >
        {WAITS_COPY.start}
      </Button>
    </span>
  );
}
