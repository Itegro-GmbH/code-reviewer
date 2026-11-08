// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The navigation of the workspace settings of the factory (#925): four tabs (General, Members, Billing, Integrations) and, for a tab with several pages,
// a second row; and the Plan entry (#282): it exists only for a workspace that has entitlements, and its address is the one the
// operator's page and the refusal notice send people to.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilitiesProvider } from "../../capabilities/context.tsx";
import { SettingsAccessProvider } from "./settings-nav.tsx";
import { SettingsNav, type SettingsSection } from "./settings-shell.tsx";

afterEach(cleanup);

// Every test here is about the factory: the tabs exist only with the capability `implementer`; the other deployments have the
// one row of pages of `settings-shell.test.tsx`.
function inFactory(children: ReactNode) {
  return (
    <CapabilitiesProvider
      capabilities={["review", "dynamic-review", "billing", "implementer"]}
    >
      {children}
    </CapabilitiesProvider>
  );
}

function linksOf(name: string): string[] {
  return within(screen.getByRole("navigation", { name }))
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

function tabs(options: {
  current?: SettingsSection;
  showPlan?: boolean;
  showBilling?: boolean;
  showAdvanced?: boolean;
}): string[] {
  render(
    inFactory(
      <SettingsNav
        workspaceSlug="acme"
        current={options.current ?? ""}
        showAdvanced={options.showAdvanced ?? true}
        {...(options.showPlan === undefined
          ? {}
          : { showPlan: options.showPlan })}
        {...(options.showBilling === undefined
          ? {}
          : { showBilling: options.showBilling })}
      />,
    ),
  );
  return linksOf("Settings sections");
}

describe("the settings tabs", () => {
  // #925
  it("are General, Members and Integrations, and Billing only where there is a plan or billing", () => {
    expect(tabs({})).toEqual(["General", "Members", "Integrations"]);
  });

  // #282-T01
  it("has no Plan page unless the workspace has entitlements", () => {
    expect(tabs({ current: "" })).not.toContain("Billing");
  });

  // #925
  it("lists and marks the tab of the page that is open even where nothing else would list it", () => {
    expect(tabs({ current: "plan" })).toContain("Billing");

    expect(
      screen
        .getByRole("link", { name: "Billing" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  // #282-T01
  it("lists the Billing tab for a workspace that has entitlements, and it leads to the Plan page", () => {
    expect(tabs({ showPlan: true })).toEqual([
      "General",
      "Members",
      "Billing",
      "Integrations",
    ]);
    expect(
      screen.getByRole("link", { name: "Billing" }).getAttribute("href"),
    ).toBe("/w/acme/settings/plan");
  });

  // #505-T11
  it("lists the Billing tab, leading to the Billing page, while billing is on, instead of the Plan page", () => {
    tabs({ showPlan: true, showBilling: true });

    expect(
      screen.getByRole("link", { name: "Billing" }).getAttribute("href"),
    ).toBe("/w/acme/settings/billing");
  });

  // #505-T01
  it("lists Billing for a workspace that has no entitlements too, while billing is on", () => {
    expect(tabs({ showBilling: true })).toContain("Billing");
  });

  // #925
  it("marks the tab of the current page, also for a page that moved under it", () => {
    tabs({ current: "llm" });

    expect(
      screen
        .getByRole("link", { name: "Integrations" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "General" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  // #925
  it("links each tab to its first page: Members and the GitHub App page are pages of the settings", () => {
    tabs({});

    expect(
      screen.getByRole("link", { name: "Members" }).getAttribute("href"),
    ).toBe("/w/acme/settings/members");
    expect(
      screen.getByRole("link", { name: "Integrations" }).getAttribute("href"),
    ).toBe("/w/acme/settings/integrations");
    expect(
      screen.getByRole("link", { name: "General" }).getAttribute("href"),
    ).toBe("/w/acme/settings");
  });
});

describe("the second row of a tab", () => {
  // #925
  it("lists the pages of Integrations: the GitHub App, the LLM key and the review defaults, and marks the current one", () => {
    tabs({ current: "llm" });

    expect(linksOf("Integrations pages")).toEqual([
      "GitHub App",
      "LLM",
      "Review defaults",
    ]);
    expect(
      within(screen.getByRole("navigation", { name: "Integrations pages" }))
        .getByRole("link", { name: "LLM" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  // #658-T02, #925
  it("lists Advanced under General only for the Owner: the layout says so, and without it there is no entry", () => {
    tabs({ current: "", showAdvanced: true });
    expect(linksOf("General pages")).toEqual(["Workspace", "Advanced"]);
    cleanup();

    tabs({ current: "", showAdvanced: false });
    // One page is no row to choose from.
    expect(
      screen.queryByRole("navigation", { name: "General pages" }),
    ).toBeNull();
  });

  // #658-T02
  it("takes Advanced from the settings layout when the caller does not say", async () => {
    // The answer of the layout is a promise the navigation waits for, so a component suspends inside the render.
    const renderWithin = async (showAdvanced: boolean) => {
      let view: ReturnType<typeof render> | undefined;
      await act(async () => {
        view = render(
          inFactory(
            <SettingsAccessProvider
              showAdvanced={Promise.resolve(showAdvanced)}
            >
              <SettingsNav workspaceSlug="acme" current="" />
            </SettingsAccessProvider>,
          ),
        );
      });
      return view;
    };

    const owner = await renderWithin(true);
    expect(screen.getByRole("link", { name: "Advanced" })).toBeTruthy();
    owner?.unmount();

    const other = await renderWithin(false);
    expect(screen.getByRole("link", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Advanced" })).toBeNull();
    other?.unmount();

    // Outside a layout (a page rendered alone) nobody gets the entry.
    render(inFactory(<SettingsNav workspaceSlug="acme" current="" />));
    expect(screen.queryByRole("link", { name: "Advanced" })).toBeNull();
  });
});
