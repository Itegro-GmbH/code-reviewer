// SPDX-License-Identifier: LicenseRef-Proprietary

// The pages of the workspace settings: one source for the links of the navigation and the headings of the pages. The settings have
// four tabs (General, Members, Billing, Integrations, #925); a tab with more than one page of its own lists them in a second row.
// The addresses of the pages that existed before the tabs stay: Review defaults, LLM, Plan and Advanced are now pages of the tab
// they belong to, not a tab of their own.
import type { Capability } from "../../capabilities/capability.ts";
import { PLAN_NAV_LABEL, PLAN_PAGE_TITLE } from "../../copy/plan-usage.ts";
import { workspacePath } from "../paths.ts";
import {
  BILLING_NAV_LABEL,
  BILLING_PAGE_TITLE,
} from "../../workspace-billing/messages.ts";

export type SettingsTab = "general" | "members" | "billing" | "integrations";

export type SettingsSection =
  | ""
  | "members"
  | "billing"
  | "plan"
  | "integrations"
  | "llm"
  | "review-defaults"
  | "advanced";

export const SETTINGS_TABS: readonly { tab: SettingsTab; label: string }[] = [
  { tab: "general", label: "General" },
  { tab: "members", label: "Members" },
  { tab: "billing", label: "Billing" },
  { tab: "integrations", label: "Integrations" },
];

export const SETTINGS_SECTIONS: readonly {
  segment: SettingsSection;
  tab: SettingsTab;
  /** The link in the second row of the tab. */
  label: string;
  /** The `h1` of the page and the last crumb. */
  title: string;
  /** Listed only in a deployment that has this capability (src/capabilities/). */
  capability?: Capability;
}[] = [
  { segment: "", tab: "general", label: "Workspace", title: "General" },
  { segment: "advanced", tab: "general", label: "Advanced", title: "Advanced" },
  { segment: "members", tab: "members", label: "Members", title: "Members" },
  // Only listed while billing is on (`showBilling`), and then instead of the Plan page (#505).
  {
    segment: "billing",
    tab: "billing",
    label: BILLING_NAV_LABEL,
    title: BILLING_PAGE_TITLE,
    capability: "billing",
  },
  // Only listed while the workspace has entitlements (`showPlan`); the page itself exists for everybody.
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

/** The tab a page belongs to. */
export function settingsTabOf(segment: SettingsSection): SettingsTab {
  return (
    SETTINGS_SECTIONS.find((section) => section.segment === segment)?.tab ??
    "general"
  );
}

/** The address of a settings page: the index lives at `/settings`, the others below it. */
export function settingsSectionHref(
  workspaceSlug: string,
  segment: SettingsSection,
): string {
  return workspacePath(
    workspaceSlug,
    segment === "" ? "/settings" : `/settings/${segment}`,
  );
}
