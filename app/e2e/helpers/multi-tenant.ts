// SPDX-License-Identifier: LicenseRef-Proprietary

// What a person does in a multi-tenant instance before anything else: sign up with email and password, create a
// workspace of their own and connect a GitHub installation to it through GitHub's installation page and
// authorization. The same steps as e2e/workspaces/connect-github.e2e.ts, for the instance at `baseURL`, so that the
// journeys of the operator limits (#285) can have two workspaces on one instance the way a real one does.
import { expect, type Browser, type Page } from "@playwright/test";
import type { GithubAccount } from "./github-fake";

export const PASSWORD = "e2e-operator-passphrase-willow-62";

/** A person signs up with email and password and signs in; they have no workspace yet. */
export async function signUpAndIn(page: Page, email: string): Promise<void> {
  await page.goto("/sign-up");
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("the account is ready");
  await signIn(page, email);
}

/** Signs in with email and password. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** A person with their own browser context, a workspace they own, and nothing connected yet. */
export async function founder(
  browser: Browser,
  baseURL: string,
  email: string,
  workspace: string,
): Promise<{ page: Page; slug: string }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signUpAndIn(page, email);
  await expect(page).toHaveURL(/\/no-access$/);
  const create = page.getByRole("form", { name: "Create a workspace" });
  await create.getByLabel("Name of the workspace").fill(workspace);
  await create.getByRole("button", { name: "Create workspace" }).click();
  const slug = workspace.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/projects$`));
  return { page, slug };
}

/**
 * "Connect GitHub" as a person does it: the button, the installation page of GitHub (the fake offers one pair of
 * buttons per installation it holds), the setup address of the app, GitHub's authorization (one button per
 * account) and the end on the connections page.
 */
export async function connectGithub(
  page: Page,
  slug: string,
  options: { installOn: string; authorizeAs: GithubAccount },
): Promise<void> {
  await page.goto(`/w/${slug}/connections`);
  await page.getByRole("button", { name: "Connect GitHub" }).click();
  await page
    .getByRole("button", {
      name: `Install on ${options.installOn}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: `Authorize ${options.authorizeAs.login}`,
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/connections\\?github=`));
}

/** Switches a repository of the workspace on, as an Owner does it on the Projects page. */
export async function switchRepositoryOn(
  page: Page,
  slug: string,
  repository: string,
): Promise<void> {
  await page.goto(`/w/${slug}/projects`);
  const row = page.getByRole("row").filter({ hasText: repository });
  await expect(row).toBeVisible();
  await row.getByRole("switch", { name: `Review ${repository}` }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
}
