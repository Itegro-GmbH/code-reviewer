// SPDX-License-Identifier: LicenseRef-Proprietary

// The content of the Runs page: the filter toolbar, then the list. `loadRunsPage` gathers the data
// from the services (passed in, so a test uses real ones against a test database), `RunsPageContent`
// renders it. The page file only wires the real services. The filter is the address
// (`?repository=...&status=...`), so it survives a reload and the back button; the toolbar is
// controlled from that filter, so neither the toolbar nor the list needs a remount key when the
// address changes (a page that stays mounted behind another one, Cache Components).
import Link from "next/link";
import { Button } from "../../components/button.tsx";
import { ProductName } from "../../components/brand.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";
import type { ProjectService } from "../../projects/service.ts";
import { noRunsYet, type LastRunSource } from "../../projects/ui/list-view.ts";
import { agentRunsPath } from "./agent-runs-path.ts";
import { parseRunsFilter, type RunsService } from "../runs-service.ts";
import type { RunsSnapshot } from "../run-view.ts";
import type { RunsApi, RunsFilter } from "./api.ts";
import { RunsFilterToolbar } from "./runs-filter.tsx";
import { RunsList } from "./runs-list.tsx";
import type { ProductIdentity } from "@/product-identity/identity.ts";

export type RunsPageData =
  | { kind: "invalid_filter" }
  | {
      kind: "ready";
      filter: RunsFilter;
      snapshot: RunsSnapshot;
      /** The projects the filter offers: repositories that are switched on or have had runs. */
      projects: { id: string; name: string }[];
    };

/** The first value of a query parameter (a repeated one counts once). */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function loadRunsPage(
  searchParams: Record<string, string | string[] | undefined>,
  deps: {
    runs: Pick<RunsService, "list">;
    projects: Pick<ProjectService, "listProjects">;
    /** Which repositories have runs; without it only switched-on projects are offered. */
    lastRuns?: LastRunSource;
  },
): Promise<RunsPageData> {
  const parsed = parseRunsFilter({
    repositoryId: first(searchParams.repository),
    status: first(searchParams.status),
  });
  if (!parsed.ok) return { kind: "invalid_filter" };
  const { filter } = parsed;
  const [snapshot, entries] = await Promise.all([
    deps.runs.list(filter),
    deps.projects.listProjects(),
  ]);
  // A repository that only holds saved settings (never switched on) can have no runs: leave it out.
  // A project that was switched off keeps its place as long as it has runs, and the repository the
  // address names stays so the select can show it.
  const withRuns = await (deps.lastRuns ?? noRunsYet)(
    entries.map((entry) => entry.repository.id),
  );
  return {
    kind: "ready",
    filter,
    snapshot,
    projects: entries
      .filter(
        (entry) =>
          entry.project?.active === true ||
          withRuns.has(entry.repository.id) ||
          (entry.project !== null &&
            entry.repository.id === filter.repositoryId),
      )
      .map((entry) => ({
        id: entry.repository.id,
        name: entry.repository.fullName,
      })),
  };
}

export function RunsPageContent({
  product,
  workspaceSlug,
  data,
  api,
}: {
  /** The product whose name the page uses in its sentences. */
  product: ProductIdentity;
  /** The workspace of the page: every link and call stays in it. */
  workspaceSlug: string;
  data: RunsPageData;
  /** Only tests pass this: a server component cannot hand functions to the client list. */
  api?: RunsApi;
}) {
  if (data.kind === "invalid_filter")
    return (
      <Empty className="border border-border bg-card">
        <EmptyHeader>
          <EmptyTitle>
            <h2>This filter is not valid</h2>
          </EmptyTitle>
          <EmptyDescription>
            The project or status in the address is not one{" "}
            <ProductName product={product} /> knows.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="secondary">
            <Link href={agentRunsPath(workspaceSlug)}>Reset filter</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <>
      <RunsFilterToolbar
        workspaceSlug={workspaceSlug}
        filter={data.filter}
        projects={data.projects}
      />
      {/* The list is not keyed: the filter is a prop and the snapshot is new server data, which
          `useLiveSnapshot` starts from without the component being thrown away. */}
      <RunsList
        workspaceSlug={workspaceSlug}
        initial={data.snapshot}
        filter={data.filter}
        {...(api === undefined ? {} : { api })}
      />
    </>
  );
}
