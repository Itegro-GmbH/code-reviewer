// SPDX-License-Identifier: LicenseRef-Proprietary

// The sub-pages of the workspace settings: one source for the links of the navigation and the headings of the pages. A deployment
// without the `implementer` capability (code-review.com) lists `SETTINGS_SECTIONS`, one link per page. The factory (#925) has four tabs
// (General, Members, Billing, Integrations) instead, `FACTORY_SETTINGS_SECTIONS`; a tab with more than one page of its own lists
// them in a second row. The addresses of the pages that existed before the tabs stay: Review defaults, LLM, Plan and Advanced are
// then pages of the tab they belong to, not a tab of their own.
import type { Capability } from "../../capabilities/capability.ts";
import { PLAN_NAV_LABEL, PLAN_PAGE_TITLE } from "../../copy/plan-usage.ts";
import { workspacePath } from "../paths.ts";
import {
  BILLING_NAV_LABEL,
  BILLING_PAGE_TITLE,
} from "../../workspace-billing/messages.ts";

export type SettingsSection =
  | ""
  | "review-defaults"
  | "llm"
  | "plan"
  | "billing"
  | "advanced"
  // The pages of the factory's tabs: the members list and the GitHub App page moved here from `/members` and `/connections`.
  | "members"
  | "integrations";

type SectionEntry = {
  segment: SettingsSection;
  label: string;
  title: string;
  /** Listed only in a deployment that has this capability (src/capabilities/). */
  capability?: Capability;
};

export const SETTINGS_SECTIONS: readonly SectionEntry[] = [
  { segment: "", label: "General", title: "General" },
  {
    segment: "review-defaults",
    label: "Review defaults",
    title: "Review defaults",
    capability: "review",
  },
  { segment: "llm", label: "LLM", title: "LLM" },
  // Only listed while the workspace has entitlements (`showPlan`); the page itself exists for everybody.
  { segment: "plan", label: PLAN_NAV_LABEL, title: PLAN_PAGE_TITLE },
  // Only listed while billing is on (`showBilling`), and then instead of the Plan page (#505).
  {
    segment: "billing",
    label: BILLING_NAV_LABEL,
    title: BILLING_PAGE_TITLE,
    capability: "billing",
  },
  { segment: "advanced", label: "Advanced", title: "Advanced" },
];

export type SettingsTab = "general" | "members" | "billing" | "integrations";

export const SETTINGS_TABS: readonly { tab: SettingsTab; label: string }[] = [
  { tab: "general", label: "General" },
  { tab: "members", label: "Members" },
  { tab: "billing", label: "Billing" },
  { tab: "integrations", label: "Integrations" },
];

export const FACTORY_SETTINGS_SECTIONS: readonly (SectionEntry & {
  tab: SettingsTab;
})[] = [
  // The `label` is the link in the second row of the tab, the `title` the `h1` of the page and the last crumb.
  { segment: "", tab: "general", label: "Workspace", title: "General" },
  { segment: "advanced", tab: "general", label: "Advanced", title: "Advanced" },
  { segment: "members", tab: "members", label: "Members", title: "Members" },
  {
    segment: "billing",
    tab: "billing",
    label: BILLING_NAV_LABEL,
    title: BILLING_PAGE_TITLE,
    capability: "billing",
  },
  {
    segment: "plan",
    tab: "billing",
    label: PLAN_NAV_LABEL,
    title: PLAN_PAGE_TITLE,
  },
  {
    segment: "integrations",
    tab: "integrations",
    label: "GitHub App",
    title: "Integrations",
  },
  { segment: "llm", tab: "integrations", label: "LLM", title: "LLM" },
  {
    segment: "review-defaults",
    tab: "integrations",
    label: "Review defaults",
    title: "Review defaults",
    capability: "review",
  },
];

/** The heading of a page: the same in both lists, which differ in the links only. */
export function settingsSectionTitle(segment: SettingsSection): string {
  return (
    [...SETTINGS_SECTIONS, ...FACTORY_SETTINGS_SECTIONS].find(
      (section) => section.segment === segment,
    )?.title ?? "Settings"
  );
}

/** The tab a page belongs to in the factory. */
export function settingsTabOf(segment: SettingsSection): SettingsTab {
  return (
    FACTORY_SETTINGS_SECTIONS.find((section) => section.segment === segment)
      ?.tab ?? "general"
  );
}

/** The address of a settings sub-page: the index lives at `/settings`, the others below it. */
export function settingsSectionHref(
  workspaceSlug: string,
  segment: SettingsSection,
): string {
  return workspacePath(
    workspaceSlug,
    segment === "" ? "/settings" : `/settings/${segment}`,
  );
}
