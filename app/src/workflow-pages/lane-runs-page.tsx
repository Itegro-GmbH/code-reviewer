// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the Runs page (#1078): the two tabs, chosen through the address (`?view=lanes|agents`), and, on the Lane runs tab, the filter
// and the list. `loadLaneRunsPage` gathers the data from the services (passed in, so a test uses real ones against a test database),
// `LaneRunsPageContent` renders it. The Agent runs tab is the page that was there before (`runs/ui/runs-page.tsx`), unchanged.
import Link from "next/link";
import { Button } from "../components/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty.tsx";
import { cn } from "../lib/utils.ts";
import type { ProjectService } from "../projects/service.ts";
import { workspacePath } from "../workspaces/paths.ts";
import { WorkflowRunError } from "../workflow-runs/errors.ts";
import type { LaneRunListView } from "../workflow-runs/lane-run-list.ts";
import type { WorkflowRunService } from "../workflow-runs/service.ts";
import type { WorkflowService } from "../workflows/service.ts";
import type { LaneRunsQuery, WorkflowRunsApi } from "./api.ts";
import {
  LaneRunsFilterToolbar,
  type NamedOption,
} from "./lane-runs-filter.tsx";
import { LaneRunsList } from "./lane-runs-list.tsx";
import { LANE_RUNS_COPY as COPY } from "./messages.ts";

export type RunsView = "lanes" | "agents";

/** The first value of a query parameter (a repeated one counts once). */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Which tab the address asks for. Without the capability `implementer` there are no lane runs: the page is the agent runs, as before.
 * With it, the Lane runs tab is the default, and `?view=agents` asks for the other one.
 */
export function runsViewOf(
  searchParams: Record<string, string | string[] | undefined>,
  hasLanes: boolean,
): RunsView {
  if (!hasLanes) return "agents";
  return first(searchParams.view) === "agents" ? "agents" : "lanes";
}

export type LaneRunsPageData =
  | { kind: "invalid_filter" }
  | {
      kind: "ready";
      filter: LaneRunsQuery;
      snapshot: LaneRunListView;
      projects: NamedOption[];
      lanes: NamedOption[];
    };

export async function loadLaneRunsPage(
  searchParams: Record<string, string | string[] | undefined>,
  deps: {
    runs: Pick<WorkflowRunService, "listWorkspace">;
    workflows: Pick<WorkflowService, "list" | "get">;
    projects: Pick<ProjectService, "listProjects">;
  },
): Promise<LaneRunsPageData> {
  const filter: LaneRunsQuery = {};
  for (const name of ["status", "project", "lane"] as const) {
    const value = first(searchParams[name]);
    if (value !== undefined && value !== "") filter[name] = value;
  }
  const entries = await deps.projects.listProjects();
  // A lane belongs to a project, so the lanes of the workspace are the lanes of its projects (the service lists one project at a time).
  const [listed, laneLists] = await Promise.all([
    deps.runs.listWorkspace(filter).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => {
        // A status that is none, or an id too long to be one: the page says so instead of failing.
        if (
          error instanceof WorkflowRunError &&
          error.code === "WORKFLOW_RUN_REQUEST_INVALID"
        )
          return undefined;
        throw error;
      },
    ),
    Promise.all(
      entries.flatMap((entry) =>
        entry.project === null ? [] : [deps.workflows.list(entry.project.id)],
      ),
    ),
  ]);
  if (listed === undefined) return { kind: "invalid_filter" };
  const { snapshot } = listed;
  // The projects of the workspace that are switched on, the one the address names, and the ones that have runs on this page, so the
  // select can always show what the list shows.
  const named = new Map(
    entries.map((entry) => [entry.repository.id, entry.repository.fullName]),
  );
  const projects = new Map<string, string>();
  for (const entry of entries)
    if (entry.project?.active === true)
      projects.set(entry.repository.id, entry.repository.fullName);
  for (const id of [
    ...(filter.project === undefined ? [] : [filter.project]),
    ...snapshot.runs.map((run) => run.project.id),
  ]) {
    const name = named.get(id);
    if (name !== undefined) projects.set(id, name);
  }
  // The lanes of the projects are the ones that are not archived. The runs of an archived lane are still listed, and the address may name
  // one, so the select has them too: from the runs on this page, and for the lane the address names from the lane itself (the service
  // answers for the workspace only, so an id of another workspace is no lane here and adds none).
  const lanes = new Map<string, string>();
  for (const lane of laneLists.flatMap((list) => list.workflows))
    lanes.set(lane.id, lane.name);
  for (const run of snapshot.runs)
    if (!lanes.has(run.workflowId)) lanes.set(run.workflowId, run.laneName);
  if (filter.lane !== undefined && !lanes.has(filter.lane)) {
    const named = await deps.workflows.get(filter.lane).then(
      (lane) => lane.name,
      () => undefined,
    );
    if (named !== undefined) lanes.set(filter.lane, named);
  }
  return {
    kind: "ready",
    filter,
    snapshot,
    projects: [...projects].map(([id, name]) => ({ id, name })),
    lanes: [...lanes]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The two tabs of the Runs page: links, so the choice is the address. */
export function RunsViewTabs({
  workspaceSlug,
  view,
}: {
  workspaceSlug: string;
  view: RunsView;
}) {
  const tabs: { view: RunsView; label: string }[] = [
    { view: "lanes", label: COPY.tabLanes },
    { view: "agents", label: COPY.tabAgents },
  ];
  return (
    <nav aria-label={COPY.tabsLabel} className="flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          href={`${workspacePath(workspaceSlug, "/runs")}?view=${tab.view}`}
          aria-current={tab.view === view ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-full px-4 text-sm font-medium no-underline",
            tab.view === view
              ? "bg-raised text-foreground"
              : "text-muted-foreground hover:bg-surface",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export function LaneRunsPageContent({
  workspaceSlug,
  data,
  api,
}: {
  workspaceSlug: string;
  data: LaneRunsPageData;
  /** Only tests pass this: a server component cannot hand functions to the client list. */
  api?: WorkflowRunsApi;
}) {
  if (data.kind === "invalid_filter")
    return (
      <Empty className="border border-border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            <h2>{COPY.invalidFilterTitle}</h2>
          </EmptyTitle>
          <EmptyDescription>{COPY.invalidFilterDescription}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="secondary">
            <Link href={`${workspacePath(workspaceSlug, "/runs")}?view=lanes`}>
              {COPY.resetFilter}
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  // Keyed by the filter: another filter is another list, with its own further pages.
  const key = `${data.filter.status ?? ""}|${data.filter.project ?? ""}|${data.filter.lane ?? ""}`;
  return (
    <>
      <LaneRunsFilterToolbar
        filter={data.filter}
        projects={data.projects}
        lanes={data.lanes}
      />
      <LaneRunsList
        key={key}
        workspaceSlug={workspaceSlug}
        filter={data.filter}
        initial={data.snapshot}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
