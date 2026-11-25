// SPDX-License-Identifier: LicenseRef-Proprietary

// The sub-pages of the workspace settings: one source for the links of the navigation and the headings of the pages. A deployment
// without the `implementer` capability (code-review.com) lists `SETTINGS_SECTIONS`, one link per page. The factory (#925) has three tabs
// (General, Members, Billing) instead, `FACTORY_SETTINGS_SECTIONS`; a tab with more than one page of its own lists them in a second row.
// The integrations and the LLM keys are not settings there but the places of Setup in the sidebar (ADR 0007, decision 7, #1108): their
// pages keep their addresses below `/settings` and render their own header (`SETUP_SECTIONS`), without these tabs. Review defaults, a
// read only page there, is a page of the General tab; Plan and Advanced belong to the tab they were always next to.
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
  // The members list of the factory's tabs moved here from `/members`; the GitHub App page (`integrations`) is a place of Setup.
  | "members"
  | "integrations"
  // The AI apps connected to the factory MCP (#1144); a page of the General tab of the factory.
  | "ai-apps";

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

export type SettingsTab = "general" | "members" | "billing";

export const SETTINGS_TABS: readonly { tab: SettingsTab; label: string }[] = [
  { tab: "general", label: "General" },
  { tab: "members", label: "Members" },
  { tab: "billing", label: "Billing" },
];

/**
 * The pages below `/settings` that are places of Setup in the factory: the heading of the page is the word of the sidebar, so the two never
 * differ (#1108). They have no tab bar of their own; `SettingsScreen` shows them with `area="setup"`.
 */
export const SETUP_SECTIONS: readonly {
  segment: SettingsSection;
  title: string;
}[] = [
  { segment: "integrations", title: "GitHub and Jira" },
  { segment: "llm", title: "LLM keys" },
];

/** The root of the breadcrumb of a place of Setup. */
export const SETUP_AREA_TITLE = "Setup";

export const FACTORY_SETTINGS_SECTIONS: readonly (SectionEntry & {
  tab: SettingsTab;
})[] = [
  // The `label` is the link in the second row of the tab, the `title` the `h1` of the page and the last crumb.
  { segment: "", tab: "general", label: "Workspace", title: "General" },
  // Read only in the factory: an AI sets the defaults through the API (#1108). It is not an integration, so it is no place of Setup.
  {
    segment: "review-defaults",
    tab: "general",
    label: "Review defaults",
    title: "Review defaults",
    capability: "review",
  },
  {
    segment: "ai-apps",
    tab: "general",
    label: "Connected AI apps",
    title: "Connected AI apps",
  },
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
];

/** The heading of a page of Setup: the word of its sidebar link. */
export function setupSectionTitle(segment: SettingsSection): string {
  return (
    SETUP_SECTIONS.find((section) => section.segment === segment)?.title ??
    settingsSectionTitle(segment)
  );
}

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
