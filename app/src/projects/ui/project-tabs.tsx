// SPDX-License-Identifier: LicenseRef-Proprietary

// The contents of the tabs of a project's cockpit (#925). Issues, ToDos and Lanes show what the prototype shows, with what has no data
// yet empty: the issues come with the ticket source (#923), the ToDos with the answer panel (#924) and the lanes of a project with
// the lane rework (#922). The Lanes tab lists the workspace's lanes (workflows) until a lane belongs to a project.
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
  ISSUES_COPY,
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

const TILES = [
  { name: "Open issues", note: "closed this month: –" },
  { name: "Lanes working", note: "issues with a lane on them" },
  { name: "Wait for you", note: "questions, reviews, red checks" },
  { name: "Spent this month", note: "all lanes of this project" },
] as const;

export function IssuesTab() {
  return (
    <div className="flex flex-col gap-8">
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
        {TILES.map((tile) => (
          <li
            key={tile.name}
            className="flex flex-col gap-1 rounded-2xl border border-border bg-surface p-4"
          >
            <span className="text-sm text-muted-foreground">{tile.name}</span>
            <span className="font-mono text-3xl leading-9">–</span>
            <span className="text-xs text-muted-foreground">{tile.note}</span>
          </li>
        ))}
      </ul>
      <section aria-labelledby="issues-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="issues-heading" className="text-lg leading-7 font-semibold">
            {ISSUES_COPY.title}
          </h2>
          <p className="text-sm text-muted-foreground">{ISSUES_COPY.hint}</p>
        </div>
        <Table aria-label="Issues" className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Issue</TableHead>
              <TableHead scope="col">In GitHub</TableHead>
              <TableHead scope="col">Lane</TableHead>
              <TableHead scope="col">Waits for</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={4} className="whitespace-normal">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{ISSUES_COPY.emptyTitle}</EmptyTitle>
                    <EmptyDescription>
                      {ISSUES_COPY.emptyDescription}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="text-xs text-muted-foreground">{ISSUES_COPY.footnote}</p>
      </section>
    </div>
  );
}

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
