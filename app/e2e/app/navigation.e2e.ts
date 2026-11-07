// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the frame around the signed in app in a real browser: the sidebar places load one after
// the other inside the same frame and signing out lands on the login page, on a desktop window and on
// a phone-sized one (where the sidebar sits behind the "Toggle Sidebar" trigger and opens as a
// drawer, and the page must not scroll sideways). The details of the navigation and the menus are
// proven as component tests.
import { expect, test } from "@playwright/test";
import {
  addGithubAccount,
  signInThroughTheForm,
  signOutThroughTheMenu,
  type GithubAccount,
} from "../helpers/github-fake";

const account: GithubAccount = {
  id: 7300001,
  login: "nav-journey",
  name: "Nav Journey",
  email: "nav-journey@example.test",
};

test.describe("the app frame", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
  });

  // CR-36-T09
  test("@smoke a signed in person opens Projects, Runs, Settings and Members of the workspace in the same frame and signs out", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const nav = page.getByRole("navigation", { name: "Main" });

    // The Settings link opens the area root; its `h1` is the first sub-page, "General" (#178).
    const places = [
      { link: "Projects", heading: "Projects", title: "Projects" },
      { link: "Runs", heading: "Runs", title: "Runs" },
      { link: "Settings", heading: "General", title: "Settings · General" },
      { link: "Members", heading: "Members", title: "Members" },
    ];
    for (const { link, heading, title } of places) {
      await nav.getByRole("link", { name: link }).click();

      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expect(nav.getByRole("link", { name: link })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page).toHaveTitle(`${title} · code-review.com`);
      await expect(page.getByRole("banner")).toBeVisible();
    }

    await signOutThroughTheMenu(page, account);

    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByRole("button", { name: "Sign in with GitHub" }),
    ).toBeVisible();
  });

  // #633-T03
  test("a signed in person who opens an address that does not exist gets the page that is not found and a way back", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);

    const visit = await page.goto("/w/default/no-such-page");

    expect(visit?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to the start page" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
  });

  test.describe("on a narrow window", () => {
    test.use({ viewport: { width: 375, height: 812 } });

    // #168-T05, CR-36-T10
    test("@smoke a person on a phone opens the drawer, switches from Projects to Runs and the page does not scroll sideways", async ({
      page,
    }) => {
      await signInThroughTheForm(page, account);
      await expect(
        page.getByRole("heading", { level: 1, name: "Projects" }),
      ).toBeVisible();
      const trigger = page.getByRole("button", { name: "Toggle Sidebar" });
      const runs = page.getByRole("link", { name: "Runs" });
      await expect(runs).toBeHidden();

      await trigger.click();
      const nav = page.getByRole("navigation", { name: "Main" });
      await expect(nav.getByRole("link")).toHaveText([
        "Projects",
        "Runs",
        "Connections",
        "Members",
        "Settings",
      ]);
      await nav.getByRole("link", { name: "Runs" }).click();

      await expect(
        page.getByRole("heading", { level: 1, name: "Runs" }),
      ).toBeVisible();
      await expect(runs).toBeHidden();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
