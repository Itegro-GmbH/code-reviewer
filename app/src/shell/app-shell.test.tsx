// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the frame around every signed in page: the sidebar with its two groups of workspace
// places, the current one marked, the brand link, the skip link and the user menu slot, and the
// narrow-screen drawer (its trigger advertises the drawer it opens, Escape closes it and returns the
// focus, a chosen link closes it, a page change closes it). Whether it looks right is checked by
// eye; the same drawer is a journey in e2e/app/navigation.e2e.ts.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/w/acme/runs" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { AppShell } from "./app-shell.tsx";
import { getProductIdentity } from "../product-identity/current.ts";

// jsdom cannot navigate; a click on a link would only print a "not implemented" notice.
const keepPageInPlace = (event: Event) => event.preventDefault();
beforeEach(() => document.addEventListener("click", keepPageInPlace));

// The shim of the setup file (matchMedia always "desktop"); a narrow-screen test replaces it and
// this puts it back.
const desktopMatchMedia = window.matchMedia;
afterEach(() => {
  document.removeEventListener("click", keepPageInPlace);
  window.matchMedia = desktopMatchMedia;
  cleanup();
  navigation.pathname = "/w/acme/runs";
});

function renderShell() {
  return render(
    <AppShell product={getProductIdentity()} userMenu={<span>user menu</span>}>
      <h1>Page content</h1>
    </AppShell>,
  );
}

function narrowScreen() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function mainNavigation() {
  return screen.getByRole("navigation", { name: "Main" });
}

describe("the sidebar", () => {
  // #168-T01
  it("shows the workspace places in two groups, separated, and marks only the current page", () => {
    renderShell();

    const nav = mainNavigation();
    const groups = nav.querySelectorAll('[data-slot="sidebar-group"]');

    expect(groups).toHaveLength(2);
    expect(
      Array.from(groups[0].querySelectorAll("a")).map((link) => [
        link.textContent,
        link.getAttribute("href"),
        link.getAttribute("aria-current"),
      ]),
    ).toEqual([
      ["Projects", "/w/acme/projects", null],
      ["Runs", "/w/acme/runs", "page"],
    ]);
    expect(
      Array.from(groups[1].querySelectorAll("a")).map(
        (link) => link.textContent,
      ),
    ).toEqual(["Connections", "Members", "Settings"]);
    expect(
      nav.querySelectorAll('[data-slot="sidebar-separator"]'),
    ).toHaveLength(1);
  });

  it("keeps a place marked while a page below it is open", () => {
    navigation.pathname = "/w/acme/runs/42";
    renderShell();

    expect(
      screen.getByRole("link", { name: "Runs" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "Projects" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("marks nothing on a page that is not one of the places, but still shows the places", () => {
    navigation.pathname = "/w/acme/runs-archive";
    renderShell();

    expect(mainNavigation()).toBeTruthy();
    expect(document.querySelector("[aria-current]")).toBeNull();
  });

  // #101-WM-03
  it("shows the places of the workspace in the address and of no other, so switching changes every link", () => {
    navigation.pathname = "/w/other-team/runs";
    renderShell();

    expect(
      within(mainNavigation())
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/w/other-team/projects",
      "/w/other-team/runs",
      "/w/other-team/connections",
      "/w/other-team/members",
      "/w/other-team/settings",
    ]);
  });

  // #101-WM-01
  it.each(["/no-access", "/workspaces/new", "/invitations", "/"])(
    "has no sidebar on %s, which is outside any workspace",
    (path) => {
      navigation.pathname = path;
      renderShell();

      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    },
  );
});

describe("the frame", () => {
  it("sends the brand link to the start page, which opens the first workspace of the person", () => {
    renderShell();

    expect(
      screen
        .getByRole("link", { name: "code-review.com" })
        .getAttribute("href"),
    ).toBe("/");
  });

  it("puts the content in the main landmark and offers a way to skip the navigation", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(
      within(main).getByRole("heading", { name: "Page content" }),
    ).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip.getAttribute("href")).toBe(`#${main.id}`);
  });

  it("shows the workspace switcher and the user menu it is given in the header, and a way to open the sidebar", () => {
    render(
      <AppShell
        product={getProductIdentity()}
        userMenu={<span>user menu</span>}
        workspaceSwitcher={<span>workspace switcher</span>}
      >
        <h1>Page content</h1>
      </AppShell>,
    );

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("user menu")).toBeTruthy();
    expect(within(banner).getByText("workspace switcher")).toBeTruthy();
    expect(
      within(banner).getByRole("button", { name: "Toggle Sidebar" }),
    ).toBeTruthy();
  });

  it("has no trigger on a page outside a workspace, where there is no sidebar to open", () => {
    navigation.pathname = "/invitations";
    renderShell();

    expect(screen.queryByRole("button", { name: "Toggle Sidebar" })).toBeNull();
  });
});

describe("the drawer on a narrow screen", () => {
  it("advertises the drawer it opens with aria-expanded and aria-controls", async () => {
    const user = userEvent.setup();
    narrowScreen();
    renderShell();
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    const controls = trigger.getAttribute("aria-controls");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(controls).toBeTruthy();

    await user.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(controls ?? "")).not.toBeNull();
  });

  // CR-36-T07
  it("closes with Escape and puts the focus back on the trigger", async () => {
    const user = userEvent.setup();
    narrowScreen();
    renderShell();
    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    await user.click(trigger);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // CR-36-T07
  it("closes after a place is chosen", async () => {
    const user = userEvent.setup();
    narrowScreen();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const nav = screen.getByRole("navigation", { name: "Main" });

    await user.click(within(nav).getByRole("link", { name: "Settings" }));

    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  // CR-36-T07, #168-T01
  it("closes when the page changes without a link, such as back and forward", async () => {
    const user = userEvent.setup();
    narrowScreen();
    const { rerender } = renderShell();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();

    navigation.pathname = "/w/acme/projects";
    rerender(
      <AppShell
        product={getProductIdentity()}
        userMenu={<span>user menu</span>}
      >
        <h1>Page content</h1>
      </AppShell>,
    );

    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });
});
