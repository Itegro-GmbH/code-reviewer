// SPDX-License-Identifier: LicenseRef-Proprietary

// A smoke per page that the shell of the factory (#925) touches, in a real browser against a production build next to the fake GitHub.
// This app is code-review.com (no `implementer` capability): it looks and navigates as before the shell, so the sidebar, the settings
// navigation, Members and Connections, and the address of a project are asserted in their old form, and the places that belong to the
// factory (its tabs, ToDos, Profiles) do not exist. The factory's layout is covered by the capability journey of the hosted lane and
// the component tests.
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
  test("@smoke the sidebar and the settings navigation are the ones of code-review.com: one row of pages, no tabs", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText([
      "Projects",
      "Runs",
      "Connections",
      "Members",
      "Settings",
    ]);
    await nav.getByRole("link", { name: "Settings" }).click();
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await expect(
      sections.getByRole("link", { name: "General", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "Members" })).toHaveCount(
      0,
    );
    await expect(
      sections.getByRole("link", { name: "Integrations" }),
    ).toHaveCount(0);

    for (const name of ["Review defaults", "LLM"]) {
      await sections.getByRole("link", { name, exact: true }).click();

      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      await expect(
        sections.getByRole("link", { name, exact: true }),
      ).toHaveAttribute("aria-current", "page");
    }
    // One row: no second navigation of a tab.
    await expect(page.getByRole("navigation", { name: /pages$/ })).toHaveCount(
      0,
    );
  });

  // #925
  test("@smoke Members and Connections are the pages they were, at their own addresses; the settings tabs do not exist", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const slug = /\/w\/([a-z0-9-]+)\//.exec(page.url())?.[1] ?? "default";

    await page.goto(`/w/${slug}/members`);
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/members$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Members" }),
    ).toBeVisible();

    await page.goto(`/w/${slug}/connections`);
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/connections$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Connections" }),
    ).toBeVisible();

    for (const tab of ["members", "integrations"]) {
      await page.goto(`/w/${slug}/settings/${tab}`);

      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();
    }
  });

  // #925
  test("@smoke a project's own address is its review settings, and the cockpit tabs and the review address do not exist", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    await page.getByRole("link", { name: REPOSITORY, exact: true }).click();
    // The project's address is the review settings (the page it always was), not a redirect.
    await expect(
      page.getByRole("heading", { level: 1, name: REPOSITORY }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/projects\/[^/]+$/);
    await expect(page.getByRole("navigation", { name: "Project" })).toHaveCount(
      0,
    );
    const repositoryPath = page.url();

    for (const tab of ["review", "runs", "setup", "lanes", "todos"]) {
      await page.goto(`${repositoryPath}/${tab}`);

      await expect(
        page.getByRole("heading", { level: 1, name: "Page not found" }),
      ).toBeVisible();
    }
  });

  // #925
  test("a project of another workspace or one that does not exist is the page that is not found", async ({
    page,
  }) => {
    await signInThroughTheForm(page, account);
    const slug = /\/w\/([a-z0-9-]+)\//.exec(page.url())?.[1] ?? "default";

    // The data sits behind the layout's Suspense, so the response is already streaming and its status stays 200: what is
    // proven is the page, not the status.
    await page.goto(`/w/${slug}/projects/no-such-project`);

    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  });
});
