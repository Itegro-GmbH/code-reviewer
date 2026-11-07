// SPDX-License-Identifier: LicenseRef-Proprietary

// The frame of a project's cockpit (#925, prototype board "3 Project"): the header with the repository as the title, its state, the
// trail `Projects / <project>` and the tabs Issues, ToDos, Runs, Lanes and Setup. Every tab is a page of its own below the project's
// address, so a tab is a link, reachable and bookmarkable. A deployment without the factory (`factory` false) has no issues, ToDos
// or lanes to show: it lists Runs and Setup only. The repository name is untrusted GitHub text and is rendered as text.
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

/** The tabs a deployment has: the factory all of them, any other only the runs and the setup. */
export function cockpitTabsFor(factory: boolean) {
  return COCKPIT_TABS.filter(
    (tab) => factory || tab.segment === "runs" || tab.segment === "setup",
  );
}

export function ProjectCockpit({
  workspaceSlug,
  row,
  tab,
  factory,
  todoCount = null,
  children,
}: {
  workspaceSlug: string;
  row: ProjectRowView;
  /** The tab the page is. */
  tab: CockpitTab;
  /** The deployment has the factory (issues, ToDos and lanes). */
  factory: boolean;
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
          {cockpitTabsFor(factory).map((entry) => (
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
