// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// A navigation entry of a capability the deployment does not have is not rendered, for anybody (#731): the workspace
// sidebar, the settings sub-navigation and the admin menu all read the capability set the root layout hands down.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/members" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AdminNav } from "../admin/ui/admin-nav.tsx";
import { adminNavGroupsFor } from "../admin/ui/nav-items.ts";
import { AppShell } from "../shell/app-shell.tsx";
import { navGroupsFor, navItemsFor } from "../shell/nav-items.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { identityFor } from "../product-identity/identities.ts";
import { workspaceHome } from "../workspaces/paths.ts";
import { SettingsNav } from "../workspaces/ui/settings-nav.tsx";
import { CapabilitiesProvider } from "./context.tsx";
import { createCapabilitySet, type Capability } from "./capability.ts";
import { PRODUCTS } from "./products.ts";

afterEach(() => {
  cleanup();
  navigation.pathname = "/w/acme/members";
});

const FACTORY: Capability[] = ["review", "dynamic-review"];
const labels = () =>
  screen.queryAllByRole("link").map((link) => link.textContent);

describe("the workspace sidebar", () => {
  // #731-T06
  it("lists Projects and Runs where the deployment has review, and the rest of the workspace always", () => {
    render(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).toEqual(
      expect.arrayContaining([
        "Projects",
        "Runs",
        "Connections",
        "Members",
        "Settings",
      ]),
    );
  });

  // #731-T06
  it("leaves Projects and Runs out without review, for every person: the sidebar knows no roles", () => {
    render(
      <CapabilitiesProvider capabilities={[]}>
        <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).not.toContain("Projects");
    expect(labels()).not.toContain("Runs");
    expect(labels()).toEqual(
      expect.arrayContaining(["Connections", "Members", "Settings"]),
    );
  });

  it("shows the whole product where no capability set was provided", () => {
    render(
      <AppShell product={getProductIdentity()} userMenu={<span>menu</span>}>
        <h1>Page</h1>
      </AppShell>,
    );

    expect(labels()).toEqual(expect.arrayContaining(["Projects", "Runs"]));
  });

  it("has the pure lists agree, and starts a workspace on a page it has", () => {
    const none = createCapabilitySet([]);
    const product = getProductIdentity();
    expect(
      navItemsFor("/w/acme", product, none).map((item) => item.label),
    ).toEqual(["Connections", "Members", "Settings"]);
    expect(navGroupsFor("/w/acme", product, none)).toHaveLength(1);
    expect(workspaceHome("acme")).toBe("/w/acme/projects");
    expect(workspaceHome("acme", createCapabilitySet(FACTORY))).toBe(
      "/w/acme/projects",
    );
    expect(workspaceHome("acme", none)).toBe("/w/acme/connections");
  });
});

describe("the name of the QA area in the sidebar", () => {
  // #757-T01
  it("is Projects for code-review.com, with the address it always had", () => {
    const product = identityFor("code-review-com");

    expect(
      navItemsFor("/w/acme", product).map((item) => [item.label, item.href]),
    ).toEqual([
      ["Projects", "/w/acme/projects"],
      ["Runs", "/w/acme/runs"],
      ["Connections", "/w/acme/connections"],
      ["Members", "/w/acme/members"],
      ["Settings", "/w/acme/settings"],
    ]);
  });

  // #757-T02
  it("is QA for the factory, and the address stays /projects", () => {
    const product = identityFor("factory");

    expect(
      navItemsFor("/w/acme", product).map((item) => [item.label, item.href]),
    ).toEqual([
      ["QA", "/w/acme/projects"],
      ["Runs", "/w/acme/runs"],
      ["Connections", "/w/acme/connections"],
      ["Members", "/w/acme/members"],
      ["Settings", "/w/acme/settings"],
    ]);
  });

  // #757-T02
  it("is what the rendered sidebar of the factory shows", () => {
    render(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={identityFor("factory")} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).toEqual(expect.arrayContaining(["QA", "Runs"]));
    expect(labels()).not.toContain("Projects");
  });
});

describe("the Implementer item in the sidebar", () => {
  const WITH_IMPLEMENTER = createCapabilitySet([
    "review",
    "dynamic-review",
    "implementer",
  ]);

  // #756-T01: the sidebar has no input for a role, so the item is the same for an Owner, an Admin, a Member and the instance
  // admin: it depends on the capability set alone.
  it("sits between the QA area and Runs where the deployment has the capability, and points to the page", () => {
    const product = identityFor("factory");

    expect(
      navItemsFor("/w/acme", product, WITH_IMPLEMENTER).map((item) => [
        item.label,
        item.href,
      ]),
    ).toEqual([
      ["QA", "/w/acme/projects"],
      ["Implementer", "/w/acme/implementer"],
      ["Runs", "/w/acme/runs"],
      ["Connections", "/w/acme/connections"],
      ["Members", "/w/acme/members"],
      ["Settings", "/w/acme/settings"],
    ]);
  });

  // #756-T01
  it("is not in the list of code-review.com, nor of the factory without the capability", () => {
    for (const product of [
      identityFor("code-review-com"),
      identityFor("factory"),
    ]) {
      expect(
        navItemsFor("/w/acme", product).map((item) => item.label),
      ).not.toContain("Implementer");
      expect(
        navItemsFor(
          "/w/acme",
          product,
          createCapabilitySet(PRODUCTS["code-review-com"].default),
        ).map((item) => item.label),
      ).not.toContain("Implementer");
      expect(
        navItemsFor("/w/acme", product, createCapabilitySet(FACTORY)).map(
          (item) => item.label,
        ),
      ).not.toContain("Implementer");
    }
  });

  // #756-T01
  it("is what the rendered sidebar shows with the capability, marked as the current page on its page, and is absent without it", () => {
    navigation.pathname = "/w/acme/implementer";
    const { rerender } = render(
      <CapabilitiesProvider
        capabilities={[...FACTORY, "implementer" satisfies Capability]}
      >
        <AppShell product={identityFor("factory")} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(labels()).toEqual(
      expect.arrayContaining(["QA", "Implementer", "Runs"]),
    );
    expect(
      screen.getByRole("link", { name: "Implementer" }).getAttribute("href"),
    ).toBe("/w/acme/implementer");
    expect(
      screen
        .getByRole("link", { name: "Implementer" })
        .getAttribute("aria-current"),
    ).toBe("page");

    rerender(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={identityFor("factory")} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );
    expect(labels()).not.toContain("Implementer");
  });
});

describe("the settings navigation", () => {
  const sections = () =>
    screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((text): text is string => text !== null);

  // #731-T06
  it.each([
    ["Owner", true],
    ["Admin", false],
    ["Member", false],
  ])(
    "lists neither Billing nor anything of billing in the factory set, for the %s",
    (_role, advanced) => {
      render(
        <CapabilitiesProvider capabilities={FACTORY}>
          <SettingsNav
            workspaceSlug="acme"
            current=""
            showPlan
            showBilling
            showAdvanced={advanced}
          />
        </CapabilitiesProvider>,
      );

      expect(sections()).not.toContain("Billing");
      expect(sections()).toContain("Review defaults");
      expect(sections().includes("Advanced")).toBe(advanced);
    },
  );

  // #731-T06
  it("lists Review defaults only with review, and Billing only with billing", () => {
    const { rerender } = render(
      <CapabilitiesProvider capabilities={[]}>
        <SettingsNav workspaceSlug="acme" current="" showBilling />
      </CapabilitiesProvider>,
    );
    expect(sections()).not.toContain("Review defaults");
    expect(sections()).not.toContain("Billing");

    rerender(
      <CapabilitiesProvider capabilities={["review", "billing"]}>
        <SettingsNav workspaceSlug="acme" current="" showBilling />
      </CapabilitiesProvider>,
    );
    expect(sections()).toContain("Review defaults");
    expect(sections()).toContain("Billing");
  });
});

describe("the admin menu", () => {
  // #731-T06
  it("has no Billing section and no Runs section without those capabilities, and a group never stays empty", () => {
    render(
      <SidebarProvider>
        <CapabilitiesProvider capabilities={FACTORY}>
          <AdminNav />
        </CapabilitiesProvider>
      </SidebarProvider>,
    );

    expect(labels()).not.toContain("Billing");
    expect(labels()).not.toContain("Payment reviews");
    expect(labels()).toContain("Runs");
    expect(labels()).toEqual(
      expect.arrayContaining(["Overview", "Integrations", "Mail", "Catalog"]),
    );
  });

  it("lists the sections of the capabilities it has", () => {
    const names = (set: Capability[]) =>
      adminNavGroupsFor(createCapabilitySet(set)).flatMap((group) =>
        group.items.map((item) => item.label),
      );

    expect(names(["review", "dynamic-review", "billing"])).toContain("Billing");
    expect(names(["review", "billing"])).toContain("Runs");
    expect(names(["billing"])).not.toContain("Runs");
    expect(names([])).toEqual(
      expect.arrayContaining(["Overview", "General", "Mail", "Catalog"]),
    );
  });
});
