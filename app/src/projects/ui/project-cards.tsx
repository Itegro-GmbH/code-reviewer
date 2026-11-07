// SPDX-License-Identifier: LicenseRef-Proprietary

// The projects of the factory as cards (#925, prototype board "2 Projects"): the repository, the ticket source in its own words
// ("Issues of <repository>"), the open issues, the lanes that are running and what waits for the person. A project is a repository
// of the GitHub App for now; the open issues and the lanes come with the ticket source (#923) and the lanes (#922), until then a card
// says "–" for them. Repository names are untrusted GitHub text and are rendered as text; a long one wraps instead of widening the card.
import Link from "next/link";
import { Badge } from "../../components/ui/badge.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { NoRepositories } from "./no-repositories.tsx";
import type { ProjectListView, ProjectRowView } from "./list-view.ts";
import { PROJECT_STATE_BADGE, PROJECT_STATE_LABEL } from "./messages.ts";
import { PROJECT_COPY } from "./cockpit-messages.ts";

/** The address of a project's cockpit (its Issues tab). */
export function projectPath(
  workspaceSlug: string,
  repositoryId: string,
  tab = "",
): string {
  return workspacePath(
    workspaceSlug,
    `/projects/${encodeURIComponent(repositoryId)}${tab === "" ? "" : `/${tab}`}`,
  );
}

function ProjectCard({
  workspaceSlug,
  row,
}: {
  workspaceSlug: string;
  row: ProjectRowView;
}) {
  const status = row.status;
  return (
    <li>
      <Link
        href={projectPath(workspaceSlug, row.repositoryId)}
        className="flex h-full flex-col gap-3 rounded-2xl border border-border bg-card p-6 text-foreground no-underline transition-all hover:bg-surface"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-lg leading-7 font-semibold break-words">
              {row.fullName}
            </span>
            <span className="text-sm text-muted-foreground">
              {PROJECT_COPY.ticketSource(row.fullName)}
            </span>
          </span>
          <Badge variant={PROJECT_STATE_BADGE[status]}>
            {PROJECT_STATE_LABEL[status]}
          </Badge>
        </span>
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{PROJECT_COPY.lanesRunning(null)}</span>
          <span>{PROJECT_COPY.openIssues(null)}</span>
          <span>{PROJECT_COPY.waiting(null)}</span>
        </span>
      </Link>
    </li>
  );
}

export function ProjectCards({
  workspaceSlug,
  canConnect,
  view,
}: {
  workspaceSlug: string;
  canConnect: boolean;
  view: ProjectListView;
}) {
  if (view.rows.length === 0)
    return (
      <NoRepositories
        connectionsPath={workspacePath(workspaceSlug, "/settings/integrations")}
        canConnect={canConnect}
      />
    );
  return (
    <section aria-labelledby="projects-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="projects-heading" className="text-lg leading-7 font-semibold">
          {PROJECT_COPY.allProjects(view.rows.length)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {PROJECT_COPY.allProjectsHint}
        </p>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2">
        {view.rows.map((row) => (
          <ProjectCard
            key={row.repositoryId}
            workspaceSlug={workspaceSlug}
            row={row}
          />
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{PROJECT_COPY.footnote}</p>
    </section>
  );
}
