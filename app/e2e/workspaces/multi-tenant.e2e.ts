// SPDX-License-Identifier: LicenseRef-Proprietary

// Workspaces in a multi-tenant instance in a real browser: a person who signs up is asked to create a
// workspace and becomes its Owner; they create a second one (a name that is taken gets a numbered address)
// and switch between the two with the switcher; the settings of each have a name of their own, which the
// Owner renames; and another person cannot open either of them. The instance is the fifth app of the run
// (playwright.config.ts).
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";

const PASSWORD = "e2e-founder-passphrase-maple-44";

async function signUpAndIn(page: Page, email: string) {
  await page.goto("/sign-up");
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("the account is ready");
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test.describe("a multi-tenant instance", () => {
  // #101-WM-01, #101-WM-03
  test("@smoke a new person creates a workspace, creates a second one and switches between them", async ({
    page,
  }) => {
    await signUpAndIn(page, "founder@e2e.test");

    // Nothing to join: the person is asked to create a workspace.
    await expect(page).toHaveURL(/\/no-access$/);
    const create = page.getByRole("form", { name: "Create a workspace" });
    await create.getByLabel("Name of the workspace").fill("Team A");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/team-a\/projects$/);
    await expect(page.getByRole("button", { name: /Workspace/ })).toContainText(
      "Team A",
    );

    // The Owner of a workspace synchronizes the connections of their own workspace (the button is there and the
    // route answers for it); the synchronization of the whole instance is the instance admin's, and for them a
    // path that does not exist.
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync from GitHub" }),
    ).toBeVisible();
    expect(
      (await page.request.post("/api/admin/integrations/sync")).status(),
      "the instance's synchronization",
    ).toBe(404);
    const own = await page.request.post("/api/w/team-a/integrations/sync");
    expect(own.status()).toBe(200);
    expect(await own.json()).toEqual({ added: 0, errors: [] });

    // A second workspace with the same name: its address is numbered.
    await page.getByRole("button", { name: /Workspace/ }).click();
    await page.getByRole("menuitem", { name: "Create a workspace" }).click();
    await expect(page).toHaveURL(/\/workspaces\/new$/);
    const again = page.getByRole("form", { name: "Create a workspace" });
    await again.getByLabel("Name of the workspace").fill("Team A");
    await again.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/team-a-2\/projects$/);

    // Both are in the switcher, and the navigation follows the one chosen.
    await page.getByRole("button", { name: /Workspace/ }).click();
    const list = page.getByRole("group", { name: "Your workspaces" });
    await expect(list.getByRole("menuitem")).toHaveCount(2);
    await list.getByRole("menuitem").first().click();
    await expect(page).toHaveURL(/\/w\/team-a\/projects$/);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Members" })
      .click();
    await expect(page).toHaveURL(/\/w\/team-a\/members$/);
    await expect(page.getByText("founder@e2e.test").first()).toBeVisible();

    // The Owner renames the second one; the switcher shows the new name.
    await page.goto("/w/team-a-2/settings");
    const rename = page.getByRole("form", { name: "Workspace name" });
    await rename.getByLabel("Name of the workspace").fill("Team B");
    await rename.getByRole("button", { name: "Save the name" }).click();
    await expect(page.getByRole("status").first()).toContainText("saved");
    await page.getByRole("button", { name: /Workspace/ }).click();
    await expect(
      page.getByRole("group", { name: "Your workspaces" }).getByText("Team B"),
    ).toBeVisible();
    // The start page opens the first workspace.
    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/team-a\/projects$/);
  });

  // #101-WM-06, #101-WM-07
  test("another person cannot open the workspaces of the first, and has workspaces of their own", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
    const page = await context.newPage();
    await signUpAndIn(page, "stranger@e2e.test");
    await expect(page).toHaveURL(/\/no-access$/);

    // Without a workspace of their own, the workspaces of others lead to the page that says what to do.
    await page.goto("/w/team-a/projects");
    await expect(page).toHaveURL(/\/no-access$/);
    const api = await page.request.get("/api/w/team-a/runs");
    expect(api.status()).toBe(403);
    expect(await api.json()).toEqual({ error: "no_workspace_access" });

    const create = page.getByRole("form", { name: "Create a workspace" });
    await page.goto("/no-access");
    await create.getByLabel("Name of the workspace").fill("Mine");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/mine\/projects$/);
    // Now a member of a workspace, the other ones are still a path that does not exist.
    const still = await page.request.get("/api/w/team-a/runs");
    expect(still.status()).toBe(404);
    await context.close();
  });

  // #658-T02, #658-T03
  test("@smoke the Owner deletes a workspace by typing its name and lands on the page without a workspace", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
    const page = await context.newPage();
    await signUpAndIn(page, "closer@e2e.test");
    const create = page.getByRole("form", { name: "Create a workspace" });
    await create.getByLabel("Name of the workspace").fill("Closing Time");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/closing-time\/projects$/);

    // General has no Instance part; the Owner's navigation lists Advanced, which holds Delete workspace only.
    await page.goto("/w/closing-time/settings");
    await expect(page.getByRole("heading", { name: "Instance" })).toHaveCount(
      0,
    );
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("link", { name: "Advanced" }).click();
    await expect(page).toHaveURL(/\/w\/closing-time\/settings\/advanced$/);
    await expect(page.getByRole("button")).toContainText(["Delete workspace…"]);

    await page.getByRole("button", { name: "Delete workspace…" }).click();
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", {
      name: "Delete this workspace",
    });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type Closing Time to confirm").fill("Closing");
    await expect(confirm).toBeDisabled();
    await dialog
      .getByLabel("Type Closing Time to confirm")
      .fill("Closing Time");
    await confirm.click();

    // Nothing is left to open: the person has no workspace any more, and the address is not found.
    await expect(page).toHaveURL(/\/no-access$/);
    await page.goto("/w/closing-time/settings/advanced");
    await expect(page).toHaveURL(/\/no-access$/);
    expect((await page.request.get("/api/w/closing-time/runs")).status()).toBe(
      403,
    );
    expect(
      (
        await page.request.delete("/api/w/closing-time", {
          data: { confirmName: "Closing Time" },
        })
      ).status(),
    ).toBe(403);
    await context.close();
  });

  // #101-WM-04
  test("the instance admin's limit is kept: a person who owns as many workspaces as allowed is refused", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await page.getByLabel("Password").fill(e2eEnv.adminPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // The instance admin has no workspace here: the app sends them to the page that says so.
    await expect(page).toHaveURL(/\/no-access$/);
    await expect(
      page.getByRole("link", { name: "open the admin portal" }),
    ).toBeVisible();
    await page.goto("/admin/limits");
    await page
      .getByLabel("Maximum number of workspaces one user may own")
      .fill("1");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    const response = await page.request.post("/api/workspaces", {
      data: { name: "Admin workspace" },
    });
    expect(response.status()).toBe(200);
    const second = await page.request.post("/api/workspaces", {
      data: { name: "Admin workspace two" },
    });
    expect(second.status()).toBe(409);
    expect(await second.json()).toEqual({ error: "workspace_limit_reached" });
  });
});
