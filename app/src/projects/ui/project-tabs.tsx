// SPDX-License-Identifier: LicenseRef-Proprietary

// The contents of the tabs of a project's cockpit (#925). ToDos, Lanes and Setup show what the prototype shows, with what has no data
// yet empty: the ToDos come with the answer panel (#924). The Issues tab is `src/issues/` (the ticket mirror, #923); the Lanes tab lists the lanes of the project (#922).
import Link from "next/link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { formatUtc } from "../../ui/format-time.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import {
  LANES_COPY,
  PROJECT_TODOS_COPY,
  SETUP_COPY,
} from "./cockpit-messages.ts";
import type { ProjectRowView } from "./list-view.ts";

/** What the Lanes tab shows of a lane (a workflow of the workspace until lanes belong to projects). */
export type LaneRow = {
  id: string;
  name: string;
  version: number;
  updatedAt: string;
};

export function ProjectTodosTab() {
  return (
    <section aria-labelledby="project-todos" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="project-todos" className="text-lg leading-7 font-semibold">
          {PROJECT_TODOS_COPY.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {PROJECT_TODOS_COPY.hint}
        </p>
      </div>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{PROJECT_TODOS_COPY.emptyTitle}</EmptyTitle>
          <EmptyDescription>
            {PROJECT_TODOS_COPY.emptyDescription}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}

export function LanesTab({
  workspaceSlug,
  lanes,
}: {
  workspaceSlug: string;
  lanes: readonly LaneRow[];
}) {
  return (
    <section aria-labelledby="lanes-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="lanes-heading" className="text-lg leading-7 font-semibold">
          {LANES_COPY.title} · {lanes.length}
        </h2>
        <p className="text-sm text-muted-foreground">{LANES_COPY.hint}</p>
      </div>
      {lanes.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{LANES_COPY.emptyTitle}</EmptyTitle>
            <EmptyDescription>{LANES_COPY.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table aria-label="Lanes">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{LANES_COPY.name}</TableHead>
              <TableHead scope="col">{LANES_COPY.version}</TableHead>
              <TableHead scope="col">{LANES_COPY.updated}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lanes.map((lane) => (
              <TableRow key={lane.id} data-lane-id={lane.id}>
                <TableCell className="min-w-0 whitespace-normal">
                  <Link
                    href={workspacePath(
                      workspaceSlug,
                      `/workflows/${encodeURIComponent(lane.id)}`,
                    )}
                    className="font-semibold break-words text-foreground no-underline"
                  >
                    {lane.name}
                  </Link>
                </TableCell>
                <TableCell className="text-xs">{lane.version}</TableCell>
                <TableCell className="text-xs">
                  <time dateTime={lane.updatedAt}>
                    {formatUtc(lane.updatedAt)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="text-xs text-muted-foreground">{LANES_COPY.note}</p>
      <p className="text-sm text-muted-foreground">
        {LANES_COPY.taskNote}{" "}
        <Link href={workspacePath(workspaceSlug, "/implementer")}>
          {LANES_COPY.taskLink}
        </Link>
      </p>
    </section>
  );
}

const SOURCE_STATE = {
  active: { label: SETUP_COPY.stateOk, variant: "success" },
  inactive: { label: SETUP_COPY.stateOff, variant: "neutral" },
  unavailable: { label: SETUP_COPY.stateGone, variant: "warning" },
} as const;

/** The ticket source card of the Setup tab: exactly one per project, in its own words. */
export function TicketSourceCard({ row }: { row: ProjectRowView }) {
  const state = SOURCE_STATE[row.status];
  return (
    <section
      aria-labelledby="ticket-source-heading"
      className="flex max-w-[45rem] flex-col gap-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="ticket-source-heading"
          className="text-lg leading-7 font-semibold"
        >
          {SETUP_COPY.title}
        </h2>
        <p className="text-sm text-muted-foreground">{SETUP_COPY.hint}</p>
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {SETUP_COPY.kind}
          </span>
          <Badge variant={state.variant}>{state.label}</Badge>
        </div>
        <span className="font-semibold break-words">{row.fullName}</span>
        <span className="text-sm text-muted-foreground break-words">
          {SETUP_COPY.note(row.installation)}
        </span>
        {row.url !== null ? (
          <a
            href={row.url}
            rel="noreferrer noopener"
            target="_blank"
            aria-label={`${row.fullName} on GitHub`}
            className="text-sm"
          >
            On GitHub
          </a>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{SETUP_COPY.footnote}</p>
    </section>
  );
}
