// SPDX-License-Identifier: LicenseRef-Proprietary

// The frame of the workspace settings area (#178): the sub-nav with one link per sub-page and the
// shared heading (in the factory, #925: the four tabs, and the second row of a tab with several pages). The settings index ("General", at `/settings`) is the area root and carries no
// breadcrumb; the sub-pages show `Settings / <page>` (epic #165 breadcrumb rule). The links are
// `settings-nav.tsx`; one source (`SETTINGS_SECTIONS`, `settings-sections.ts`) feeds them and the headings.
import type { ReactNode } from "react";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PageHeader } from "../../components/page-header.tsx";
import { workspacePath } from "../paths.ts";
import { SettingsNav } from "./settings-nav.tsx";
import {
  settingsSectionTitle,
  type SettingsSection,
} from "./settings-sections.ts";

export { SettingsNav } from "./settings-nav.tsx";
export {
  SETTINGS_SECTIONS,
  settingsSectionHref,
  type SettingsSection,
} from "./settings-sections.ts";

/**
 * One settings sub-page: the one `h1` of the page, the breadcrumb below the index, the sub-nav and
 * the body. `current` names the section the page is (the sub-nav marks it).
 */
export function SettingsScreen({
  workspaceSlug,
  current,
  showPlan = false,
  showBilling = false,
  showAdvanced,
  description,
  badge,
  children,
}: {
  workspaceSlug: string;
  current: SettingsSection;
  /** The workspace has entitlements (#282), so the sub-nav lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505), so the sub-nav lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  /** Lists the Advanced page. Left out, the settings layout decides (the Owner sees it, #658). */
  showAdvanced?: boolean;
  /** A line under the title (the factory's pages, #925). */
  description?: string;
  /** A short status next to the title (the factory's pages, #925). */
  badge?: ReactNode;
  children: ReactNode;
}) {
  const title = settingsSectionTitle(current);
  return (
    <>
      <PageHeader
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(badge === undefined ? {} : { badge })}
        breadcrumb={
          current === "" ? undefined : (
            <Breadcrumbs
              items={[
                {
                  label: "Settings",
                  href: workspacePath(workspaceSlug, "/settings"),
                },
                { label: title },
              ]}
            />
          )
        }
      />
      <div className="flex flex-col gap-6">
        <SettingsNav
          workspaceSlug={workspaceSlug}
          current={current}
          showPlan={showPlan}
          showBilling={showBilling}
          {...(showAdvanced === undefined ? {} : { showAdvanced })}
        />
        {children}
      </div>
    </>
  );
}
