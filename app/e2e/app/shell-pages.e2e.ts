// SPDX-License-Identifier: LicenseRef-Proprietary

// A smoke per page of the app shell (#925), in a real browser against a production build next to the fake GitHub: every page of the
// product (code-review.com: no ToDos, Profiles or Runners, which belong to the factory and are covered by the capability journey of the
// hosted lane and the component tests) opens from the sidebar or its tab, shows its heading, and the old addresses lead to their new place.
import { expect, test } from "@playwright/test";
import { syncFromGithubAsAdmin } from "../helpers/admin-api";
import {
  addGithubAccount,
  addGithubInstallation,
  GITHUB_APP_OWNER_ACCOUNT,
  signInThroughTheForm,
  type GithubAccount,
} from "../helpers/github-fake";
import { e2eEnv } from "../helpers/e2e-env";

const account: GithubAccount = {
  id: 7300025,
  login: "shell-journey",
  name: "Shell Journey",
  email: "shell-journey@example.test",
};
const REPOSITORY = "shell-journey/widgets";

test.describe("the pages of the app shell", () => {
  test.beforeAll(async ({ request }) => {
    await addGithubAccount(request, account);
    await addGithubInstallation(
      request,
      { id: 9100025, account: GITHUB_APP_OWNER_ACCOUNT },
      [{ id: 9200025, fullName: REPOSITORY }],
    );
    await syncFromGithubAsAdmin(e2eEnv.appUrl);
  });

  // #925
  test("@smoke the tabs of the settings open one after the other, each marked as the current one", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Settings" })
      .click();
    const tabs = page.getByRole("navigation", { name: "Settings sections" });

    for (const [tab, heading] of [
      ["Members", "Members"],
      ["Integrations", "Integrations"],
      ["General", "General"],
    ] as const) {
      await tabs.getByRole("link", { name: tab, exact: true }).click();

      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expect(
        tabs.getByRole("link", { name: tab, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }

    // The LLM key and the review defaults are pages of the Integrations tab.
    await tabs.getByRole("link", { name: "Integrations" }).click();
    const pages = page.getByRole("navigation", { name: "Integrations pages" });
    await pages.getByRole("link", { name: "LLM" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "LLM" }),
    ).toBeVisible();
    await expect(
      tabs.getByRole("link", { name: "Integrations" }),
    ).toHaveAttribute("aria-current", "page");
    await pages.getByRole("link", { name: "Review defaults" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Review defaults" }),
    ).toBeVisible();
  });

  // #925
  test("@smoke the old addresses of Members and Connections lead to their tabs of the settings", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const slug = /\/w\/([a-z0-9-]+)\//.exec(page.url())?.[1] ?? "default";

    await page.goto(`/w/${slug}/members`);
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/settings/members$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Members" }),
    ).toBeVisible();

    await page.goto(`/w/${slug}/connections`);
    await expect(page).toHaveURL(
      new RegExp(`/w/${slug}/settings/integrations$`),
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Integrations" }),
    ).toBeVisible();
  });

  // #925
  test("@smoke a project opens its runs and its setup, and its own address opens the review settings where there is no factory", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    // Without the factory the project's address is the review settings (the page it always was).
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/review$/);
    const repositoryPath = page.url().replace(/\/review$/, "");

    await page.goto(`${repositoryPath}/setup`);
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Project" });
    await expect(tabs.getByRole("link")).toHaveText(["Runs", "Setup"]);
    await expect(tabs.getByRole("link", { name: "Setup" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("heading", { level: 2, name: "Ticket source" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open the review settings" }),
    ).toBeVisible();

    await tabs.getByRole("link", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/runs$/);
    await expect(tabs.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  // #925
  test("a project of another workspace or one that does not exist is the page that is not found, on every tab", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const slug = /\/w\/([a-z0-9-]+)\//.exec(page.url())?.[1] ?? "default";

    for (const tab of ["runs", "setup"]) {
      // The data sits behind the layout's Suspense, so the response is already streaming and its status stays 200: what is
      // proven is the page, not the status.
      await page.goto(`/w/${slug}/projects/no-such-project/${tab}`);

      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();
    }
  });
});
