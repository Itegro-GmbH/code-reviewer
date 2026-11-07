// SPDX-License-Identifier: LicenseRef-Proprietary

// The frame of a project's cockpit (#925, prototype board "3 Project"): the header with the repository as the title, its state, the
// trail `Projects / <project>` and the tabs Issues, ToDos, Runs, Lanes and Setup. Every tab is a page of its own below the project's
// address, so a tab is a link, reachable and bookmarkable. The cockpit exists only in the factory; a deployment without it keeps the
// project list and the review settings. The repository name is untrusted GitHub text and is rendered as text.
import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { PILL_LINK_CLASS } from "../../components/pill-link.ts";
import { Badge } from "../../components/ui/badge.tsx";
import { workspacePath } from "../../workspaces/paths.ts";
import { COCKPIT_TABS, type CockpitTab } from "./cockpit-messages.ts";
import type { ProjectRowView } from "./list-view.ts";
import { PROJECT_STATE_BADGE, PROJECT_STATE_LABEL } from "./messages.ts";
import { projectPath } from "./project-cards.tsx";

export function ProjectCockpit({
  workspaceSlug,
  row,
  tab,
  todoCount = null,
  children,
}: {
  workspaceSlug: string;
  row: ProjectRowView;
  /** The tab the page is. */
  tab: CockpitTab;
  /** The open ToDos of the project for the badge of the ToDos tab; `null` until they exist. */
  todoCount?: number | null;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={row.fullName}
        description={`Issues of ${row.fullName}`}
        badge={
          <Badge variant={PROJECT_STATE_BADGE[row.status]}>
            {PROJECT_STATE_LABEL[row.status]}
          </Badge>
        }
        breadcrumb={
          <Breadcrumbs
            items={[
              {
                label: "Projects",
                href: workspacePath(workspaceSlug, "/projects"),
              },
              { label: row.fullName },
            ]}
          />
        }
      />
      <nav aria-label="Project">
        <ul className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
          {COCKPIT_TABS.map((entry) => (
            <li key={entry.segment || "issues"}>
              <Link
                href={projectPath(
                  workspaceSlug,
                  row.repositoryId,
                  entry.segment,
                )}
                aria-current={entry.segment === tab ? "page" : undefined}
                className={PILL_LINK_CLASS}
              >
                {entry.label}
                {entry.segment === "todos" &&
                todoCount !== null &&
                todoCount > 0 ? (
                  <Badge variant="warning" icon={false} className="ml-2">
                    {todoCount}
                  </Badge>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </>
  );
}
