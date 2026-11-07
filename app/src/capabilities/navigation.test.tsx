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

describe("the places of the factory in the sidebar", () => {
  // #756-T01, #818-T10, #873-T90, #925: without the capability `implementer` no list has a place of the Implementer, whatever the
  // product, and the list is the old one of code-review.com.
  it("has none of the places of the Implementer in a list without the capability: code-review.com's, the factory's without it, a review-only set", () => {
    for (const product of [
      identityFor("code-review-com"),
      identityFor("factory"),
    ])
      for (const set of [
        undefined,
        createCapabilitySet(PRODUCTS["code-review-com"].default),
        createCapabilitySet(FACTORY),
        createCapabilitySet(["review"]),
        createCapabilitySet([]),
      ])
        for (const place of [
          "Implementer",
          "Environments",
          "Workflows",
          "Runners",
          "ToDos",
          "Profiles",
        ])
          expect(
            navItemsFor("/w/acme", product, set).map((item) => item.label),
          ).not.toContain(place);
  });
});

describe("the sidebar of the factory (#925)", () => {
  const WITH_IMPLEMENTER = createCapabilitySet([
    "review",
    "dynamic-review",
    "implementer",
  ]);

  // #925: the sidebar of the factory is the prototype's: ToDos, Projects, Runs, Profiles, Runners, Settings, in that order.
  it("is ToDos, Projects, Runs, Profiles, Runners and Settings for the factory, with the addresses of the pages", () => {
    expect(
      navItemsFor("/w/acme", identityFor("factory"), WITH_IMPLEMENTER).map(
        (item) => [item.label, item.href],
      ),
    ).toEqual([
      ["ToDos", "/w/acme/todos"],
      ["Projects", "/w/acme/projects"],
      ["Runs", "/w/acme/runs"],
      ["Profiles", "/w/acme/profiles"],
      ["Runners", "/w/acme/runners"],
      ["Settings", "/w/acme/settings"],
    ]);
  });

  // #925
  it("carries the count of open ToDos on the ToDos place only", () => {
    const items = navItemsFor(
      "/w/acme",
      identityFor("factory"),
      WITH_IMPLEMENTER,
    );

    expect(
      items.filter((item) => item.badge !== undefined).map((i) => i.label),
    ).toEqual(["ToDos"]);
  });

  // #925
  it("is Projects in the factory too: the area is the project cockpit, no longer named QA", () => {
    expect(
      navItemsFor("/w/acme", identityFor("factory"), WITH_IMPLEMENTER).map(
        (item) => item.label,
      ),
    ).toContain("Projects");
  });

  // #925: the places of the old sidebar are gone from it; their pages are tabs of the settings or lead from the pages that need them.
  it("has no Implementer, Environments, Workflows, Connections or Members place any more", () => {
    const names = navItemsFor(
      "/w/acme",
      identityFor("factory"),
      WITH_IMPLEMENTER,
    ).map((item) => item.label);

    for (const gone of [
      "Implementer",
      "Environments",
      "Workflows",
      "Connections",
      "Members",
    ])
      expect(names).not.toContain(gone);
  });

  // #925
  it("is what the rendered sidebar shows with the capability, marked as the current page on its page", () => {
    navigation.pathname = "/w/acme/profiles";
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
      expect.arrayContaining(["ToDos", "Projects", "Profiles", "Runners"]),
    );
    expect(
      screen
        .getByRole("link", { name: "Profiles" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "Runners" })
        .getAttribute("aria-current"),
    ).toBeNull();

    rerender(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={identityFor("factory")} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );
    expect(labels()).not.toContain("Profiles");
  });

  // #925: Settings is the current place on every page of its tabs.
  it("keeps Settings the current place on a page below it", () => {
    navigation.pathname = "/w/acme/settings/members";
    render(
      <CapabilitiesProvider capabilities={FACTORY}>
        <AppShell product={identityFor("factory")} userMenu={<span>menu</span>}>
          <h1>Page</h1>
        </AppShell>
      </CapabilitiesProvider>,
    );

    expect(
      screen
        .getByRole("link", { name: "Settings" })
        .getAttribute("aria-current"),
    ).toBe("page");
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

describe("the settings navigation of the factory (#925)", () => {
  const WITH_IMPLEMENTER: Capability[] = [...FACTORY, "implementer"];
  const tabs = () =>
    screen
      .getAllByRole("link", {
        name: /^(General|Members|Billing|Integrations)$/,
      })
      .map((link) => link.textContent);
  const links = () =>
    screen
      .getAllByRole("link")
      .map((link) => link.textContent)
      .filter((text): text is string => text !== null);

  // #731-T06, #925
  it.each([
    ["Owner", true],
    ["Admin", false],
    ["Member", false],
  ])(
    "lists no Billing tab in the factory set, and Advanced only for the Owner, for the %s",
    (_role, advanced) => {
      render(
        <CapabilitiesProvider capabilities={WITH_IMPLEMENTER}>
          <SettingsNav
            workspaceSlug="acme"
            current=""
            showBilling
            showAdvanced={advanced}
          />
        </CapabilitiesProvider>,
      );

      expect(tabs()).toEqual(["General", "Members", "Integrations"]);
      expect(links().includes("Advanced")).toBe(advanced);
    },
  );

  // #731-T06, #925
  it("lists Review defaults only with review, and the Billing tab only with billing", () => {
    const { rerender } = render(
      <CapabilitiesProvider capabilities={["implementer"]}>
        <SettingsNav workspaceSlug="acme" current="integrations" showBilling />
      </CapabilitiesProvider>,
    );
    expect(links()).not.toContain("Review defaults");
    expect(tabs()).not.toContain("Billing");

    rerender(
      <CapabilitiesProvider capabilities={["review", "billing", "implementer"]}>
        <SettingsNav workspaceSlug="acme" current="integrations" showBilling />
      </CapabilitiesProvider>,
    );
    expect(links()).toContain("Review defaults");
    expect(tabs()).toContain("Billing");
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
