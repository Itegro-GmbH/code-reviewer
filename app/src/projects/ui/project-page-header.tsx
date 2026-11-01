// SPDX-License-Identifier: LicenseRef-Proprietary

// The header of the project page (#174): one h1 with the repository's full name and its state badge
// and the trail `Projects / <project> / Settings` (the area has the name its product gives it, #757: QA in the
// factory). A review is started from the project list (#655), not here. The trail starts at the
// list of the area (its root, epic #165 breadcrumb rule); the repository name is untrusted GitHub
// text and is rendered as text, never as markup.
import { Badge } from "../../components/ui/badge.tsx";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { ProjectRowView } from "./list-view.ts";
import { PROJECT_STATE_BADGE, PROJECT_STATE_LABEL } from "./messages.ts";

export function ProjectPageHeader({
  product,
  workspaceSlug,
  row,
}: {
  /** The product whose name for the area the trail starts with. */
  product: ProductIdentity;
  workspaceSlug: string;
  row: ProjectRowView;
}) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={row.fullName}
        badge={
          <Badge variant={PROJECT_STATE_BADGE[row.status]}>
            {PROJECT_STATE_LABEL[row.status]}
          </Badge>
        }
        breadcrumb={
          <Breadcrumbs
            items={[
              {
                label: product.qaAreaName,
                href: workspacePath(workspaceSlug, "/projects"),
              },
              // The repository is the subject of the page, not a page of its own.
              { label: row.fullName },
              { label: "Settings" },
            ]}
          />
        }
      />
    </div>
  );
}
