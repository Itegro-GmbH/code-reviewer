// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The navigation of the workspace settings (#178, #925): the four tabs (General, Members, Billing, Integrations) and, for a tab that
// has more than one page, a second row with its pages. The current tab and page carry `aria-current="page"`, which the styling turns
// into a fill as well, so the location is never shown by colour alone.
//
// "Advanced" (#658) only holds the deletion of the workspace and is the Owner's alone, so only an Owner sees the link. The
// settings layout (`app/(app)/w/[workspace]/settings/layout.tsx`) knows the role and hands it down through
// `SettingsAccessProvider`, so no page has to pass it on; the nav takes it from there unless a caller says it itself. It is a
// promise, read with `use` behind the nav's own <Suspense> boundary: the nav shows without the link until the role is known, and
// the page below stays outside any boundary of the layout, so a page that answers "not found" still answers with status 404.
import { useCapabilities } from "@/capabilities/context";
import { PILL_LINK_CLASS } from "@/components/pill-link";
import Link from "next/link";
import {
  createContext,
  Suspense,
  use,
  useContext,
  type ReactNode,
} from "react";
import {
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  settingsSectionHref,
  settingsTabOf,
  type SettingsSection,
  type SettingsTab,
} from "./settings-sections.ts";

const SettingsAccessContext = createContext<Promise<boolean> | null>(null);

/** Tells every settings navigation below it whether the person may see "Advanced" (the Owner); the answer may still be coming. */
export function SettingsAccessProvider({
  showAdvanced,
  children,
}: {
  showAdvanced: Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <SettingsAccessContext.Provider value={showAdvanced}>
      {children}
    </SettingsAccessContext.Provider>
  );
}

type SettingsNavProps = {
  workspaceSlug: string;
  current: SettingsSection;
  /** The workspace has entitlements (#282): the Plan page is listed. An unlimited workspace has no entry. */
  showPlan?: boolean;
  /** Billing is on (#505): the Billing page is listed, and the Plan page is not (the Billing page takes its place). */
  showBilling?: boolean;
  /** The Advanced page is listed. Left out, the settings layout decides (the Owner sees it). */
  showAdvanced?: boolean;
};

export function SettingsNav(props: SettingsNavProps) {
  return (
    <Suspense fallback={<SettingsLinks {...props} advanced={false} />}>
      <SettingsNavWithAccess {...props} />
    </Suspense>
  );
}

function SettingsNavWithAccess(props: SettingsNavProps) {
  const access = useContext(SettingsAccessContext);
  const advanced =
    props.showAdvanced ?? (access === null ? false : use(access));
  return <SettingsLinks {...props} advanced={advanced} />;
}

function SettingsLinks({
  workspaceSlug,
  current,
  showPlan = false,
  showBilling = false,
  advanced,
}: SettingsNavProps & { advanced: boolean }) {
  const capabilities = useCapabilities();
  const listed = SETTINGS_SECTIONS.filter((section) => {
    if (
      section.capability !== undefined &&
      !capabilities.has(section.capability)
    )
      return false;
    if (section.segment === "plan") return showPlan && !showBilling;
    if (section.segment === "billing") return showBilling;
    if (section.segment === "advanced") return advanced;
    return true;
  });
  const currentTab = settingsTabOf(current);
  // A tab is the first page listed for it; a tab with no page in this deployment (Billing without billing and without a plan) is left out.
  const tabs = SETTINGS_TABS.flatMap(({ tab, label }) => {
    const first = listed.find((section) => section.tab === tab);
    return first === undefined ? [] : [{ tab, label, first }];
  });
  const pages = listed.filter((section) => section.tab === currentTab);
  return (
    <div className="flex flex-col gap-3">
      <nav aria-label="Settings sections">
        <ul className="flex flex-wrap items-center gap-1">
          {tabs.map(({ tab, label, first }) => (
            <li key={tab}>
              <Link
                href={settingsSectionHref(workspaceSlug, first.segment)}
                aria-current={tab === currentTab ? "page" : undefined}
                className={PILL_LINK_CLASS}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {pages.length > 1 ? (
        <nav aria-label={`${tabLabel(currentTab)} pages`}>
          <ul className="flex flex-wrap items-center gap-1">
            {pages.map((section) => (
              <li key={section.segment || "general"}>
                <Link
                  href={settingsSectionHref(workspaceSlug, section.segment)}
                  aria-current={
                    section.segment === current ? "page" : undefined
                  }
                  className={PILL_LINK_CLASS}
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

function tabLabel(tab: SettingsTab): string {
  return SETTINGS_TABS.find((entry) => entry.tab === tab)?.label ?? "Settings";
}
