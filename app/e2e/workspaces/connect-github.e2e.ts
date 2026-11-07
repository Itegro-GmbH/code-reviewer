// SPDX-License-Identifier: LicenseRef-Proprietary

// Binding GitHub installations to workspaces in a real browser (docs/decisions/0001-editions-setup-and-
// accounts.md, section 2.9), in a multi-tenant instance against the fake GitHub: the owner of an organization
// connects its installation through GitHub's installation page and authorization and finds the repositories in
// their workspace; a member of the organization who is not an owner is refused; two workspaces connect two
// installations and each sees only its own repositories; when GitHub does not let the app read a person's role,
// nothing is connected until the instance admin approves the request in the admin portal; and a workspace
// disconnects its installation, which keeps the installation the workspace's and its history stored. The
// instance is the fifth app of the run (playwright.config.ts).
import { expect, test, type Browser, type Page } from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import {
  addGithubAccount,
  addGithubInstallation,
  addGithubOrgMember,
  makeGithubMembershipUnreadable,
  setGithubAppSetupUrl,
  type GithubAccount,
} from "../helpers/github-fake";

const PASSWORD = "e2e-connect-passphrase-willow-61";

const ownerA: GithubAccount = {
  id: 7500001,
  login: "connect-owner-a",
  name: "Connect Owner A",
  email: "connect-owner-a@example.test",
};
const ownerB: GithubAccount = {
  id: 7500002,
  login: "connect-owner-b",
  name: "Connect Owner B",
  email: "connect-owner-b@example.test",
};
const memberOfA: GithubAccount = {
  id: 7500003,
  login: "connect-member-a",
  name: "Connect Member A",
  email: "connect-member-a@example.test",
};
const opaque: GithubAccount = {
  id: 7500004,
  login: "connect-opaque",
  name: "Connect Opaque",
  email: "connect-opaque@example.test",
};

const ORG_A = {
  login: "connect-org-a",
  id: 7600001,
  type: "Organization",
} as const;
const ORG_B = {
  login: "connect-org-b",
  id: 7600002,
  type: "Organization",
} as const;
const ORG_OPAQUE = {
  login: "connect-opaque-org",
  id: 7600003,
  type: "Organization",
} as const;
const REPO_A = "connect-org-a/widgets";
const REPO_B = "connect-org-b/gadgets";
const REPO_OPAQUE = "connect-opaque-org/vault";

/** A person signs up with email and password and signs in; they have no workspace yet. */
async function signUpAndIn(page: Page, email: string): Promise<void> {
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

/** A person with their own browser, a workspace they own, and nothing connected yet. */
async function founder(
  browser: Browser,
  email: string,
  workspace: string,
): Promise<{ page: Page; slug: string }> {
  const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
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
async function connectGithub(
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

test.describe.configure({ mode: "serial" });

test.describe("connecting GitHub to a workspace", () => {
  test.beforeAll(async ({ request }) => {
    for (const account of [ownerA, ownerB, memberOfA, opaque])
      await addGithubAccount(request, account, null);
    await addGithubInstallation(request, { id: 9700001, account: ORG_A }, [
      { id: 9710001, fullName: REPO_A },
    ]);
    await addGithubInstallation(request, { id: 9700002, account: ORG_B }, [
      { id: 9710002, fullName: REPO_B },
    ]);
    await addGithubInstallation(request, { id: 9700003, account: ORG_OPAQUE }, [
      { id: 9710003, fullName: REPO_OPAQUE },
    ]);
    await addGithubOrgMember(request, {
      org: ORG_A.login,
      login: ownerA.login,
      role: "admin",
    });
    await addGithubOrgMember(request, {
      org: ORG_A.login,
      login: memberOfA.login,
      role: "member",
    });
    await addGithubOrgMember(request, {
      org: ORG_B.login,
      login: ownerB.login,
      role: "admin",
    });
    await addGithubOrgMember(request, {
      org: ORG_OPAQUE.login,
      login: opaque.login,
      role: "admin",
    });
    await makeGithubMembershipUnreadable(request, ORG_OPAQUE.login);
    // GitHub sends the person back to this app after an installation.
    await setGithubAppSetupUrl(
      request,
      `${e2eEnv.multiAppUrl}/github/connected`,
    );
  });

  // #103-IB-03, #103-IB-02
  test("@smoke the owner of an organization connects its installation and finds the repositories in the workspace", async ({
    browser,
  }) => {
    const { page, slug } = await founder(
      browser,
      "connect-a@e2e.test",
      "Connect A",
    );
    // Nothing is connected yet: the Projects page says how to connect GitHub.
    await expect(
      page.getByRole("heading", { name: "No repositories yet" }),
    ).toBeVisible();

    await connectGithub(page, slug, {
      installOn: ORG_A.login,
      authorizeAs: ownerA,
    });

    await expect(page.getByRole("status").first()).toContainText(
      "GitHub is connected",
    );
    const connections = page.getByRole("list", { name: "Installations" });
    await expect(connections.getByRole("listitem")).toHaveCount(1);
    await expect(connections).toContainText(ORG_A.login);
    await expect(connections).toContainText("Connected");
    await page.goto(`/w/${slug}/projects`);
    await expect(
      page.getByRole("row").filter({ hasText: REPO_A }),
    ).toBeVisible();
    await page.context().close();
  });

  // #103-IB-04
  test("a member of the organization who is not an owner is refused, and nothing is connected", async ({
    browser,
  }) => {
    const { page, slug } = await founder(
      browser,
      "connect-m@e2e.test",
      "Connect M",
    );

    await connectGithub(page, slug, {
      installOn: ORG_A.login,
      authorizeAs: memberOfA,
    });

    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Only the owner of a personal account" }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Installations" })).toHaveCount(
      0,
    );
    await page.goto(`/w/${slug}/projects`);
    await expect(
      page.getByRole("heading", { name: "No repositories yet" }),
    ).toBeVisible();
    await page.context().close();
  });

  // #103-IB-18
  test("two workspaces connect different installations and each sees only its own repositories", async ({
    browser,
  }) => {
    const b = await founder(browser, "connect-b@e2e.test", "Connect B");
    await connectGithub(b.page, b.slug, {
      installOn: ORG_B.login,
      authorizeAs: ownerB,
    });
    await expect(b.page.getByRole("status").first()).toContainText(
      "GitHub is connected",
    );

    await b.page.goto(`/w/${b.slug}/projects`);
    await expect(
      b.page.getByRole("row").filter({ hasText: REPO_B }),
    ).toBeVisible();
    await expect(
      b.page.getByRole("row").filter({ hasText: REPO_A }),
    ).toHaveCount(0);
    // The workspace of the first journey does not see these.
    const a = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
    const pageA = await a.newPage();
    await pageA.goto("/login");
    await pageA.getByLabel("Email address").fill("connect-a@e2e.test");
    await pageA.getByLabel("Password").fill(PASSWORD);
    await pageA.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(pageA).toHaveURL(/\/w\/connect-a\/projects$/);
    await expect(
      pageA.getByRole("row").filter({ hasText: REPO_A }),
    ).toBeVisible();
    await expect(
      pageA.getByRole("row").filter({ hasText: REPO_B }),
    ).toHaveCount(0);
    // Reading the connections again from GitHub does not bring a foreign installation in.
    await pageA.getByRole("button", { name: "Sync from GitHub" }).click();
    await expect(pageA.getByRole("status")).toContainText(
      "No new repositories.",
    );
    await expect(
      pageA.getByRole("row").filter({ hasText: REPO_B }),
    ).toHaveCount(0);
    await a.close();
    await b.page.context().close();
  });

  // #103-IB-19, #103-IB-20, #103-IB-23
  test("when GitHub does not let the app read the role, nothing is connected until the instance admin approves the request", async ({
    browser,
  }) => {
    const o = await founder(browser, "connect-o@e2e.test", "Connect O");

    await connectGithub(o.page, o.slug, {
      installOn: ORG_OPAQUE.login,
      authorizeAs: opaque,
    });

    await expect(o.page.getByRole("status").first()).toContainText(
      "code-review.com admin has to approve",
    );
    await expect(
      o.page.getByRole("list", { name: "Installations" }),
    ).toHaveCount(0);
    const requests = o.page.getByRole("list", {
      name: "Requests for the code-review.com admin",
    });
    await expect(requests).toContainText(ORG_OPAQUE.login);
    await expect(requests).toContainText("Waiting for a code-review.com admin");
    await o.page.goto(`/w/${o.slug}/projects`);
    await expect(
      o.page.getByRole("heading", { name: "No repositories yet" }),
    ).toBeVisible();

    // The instance admin sees who asked and the evidence, and approves.
    const adminContext = await browser.newContext({
      baseURL: e2eEnv.multiAppUrl,
    });
    const admin = await adminContext.newPage();
    await admin.goto("/login");
    await admin.getByLabel("Email address").fill(e2eEnv.adminEmail);
    await admin.getByLabel("Password").fill(e2eEnv.adminPassword);
    await admin.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signed in: the admin lands on a page of the app (they may have a workspace of their own by now).
    await expect(admin).toHaveURL(/\/(no-access|w\/[a-z0-9-]+\/projects)$/);
    await admin.goto("/admin/approvals");
    // The screen header carries the one action; the three states are tabs (#183).
    await expect(
      admin.getByRole("heading", { level: 1, name: "Approvals" }),
    ).toBeVisible();
    await expect(
      admin.getByRole("button", { name: "Sync from GitHub" }),
    ).toBeVisible();
    const waiting = admin
      .getByRole("list", { name: "Requests waiting for a decision" })
      .getByRole("listitem")
      .filter({ hasText: ORG_OPAQUE.login });
    await expect(waiting).toBeVisible();
    // The evidence is behind a disclosure, closed at first (#183).
    await waiting
      .getByRole("button", { name: `Evidence for ${ORG_OPAQUE.login}` })
      .click();
    await expect(waiting).toContainText("connect-o@e2e.test");
    await expect(waiting).toContainText(`GitHub account ${opaque.login}`);
    await expect(waiting).toContainText("Connect O");
    await expect(waiting).toContainText(
      "Can their token use the installation?Yes",
    );
    await expect(waiting).toContainText("Could not be read");
    await waiting
      .getByRole("button", { name: `Approve ${ORG_OPAQUE.login}` })
      .click();
    await expect(waiting).toHaveCount(0);

    // The workspace now has the connection and its repositories.
    await o.page.goto(`/w/${o.slug}/connections`);
    await expect(
      o.page.getByRole("list", { name: "Installations" }),
    ).toContainText(ORG_OPAQUE.login);
    await expect(
      o.page.getByRole("list", {
        name: "Requests for the code-review.com admin",
      }),
    ).toContainText("Approved");
    await o.page.goto(`/w/${o.slug}/projects`);
    await expect(
      o.page.getByRole("row").filter({ hasText: REPO_OPAQUE }),
    ).toBeVisible();
    await adminContext.close();
    await o.page.context().close();
  });

  // #103-IB-14
  test("a workspace disconnects its installation: the repositories go, the connection stays the workspace's", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: e2eEnv.multiAppUrl });
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel("Email address").fill("connect-a@e2e.test");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/connect-a\/projects$/);

    await page.goto("/w/connect-a/connections");
    await page
      .getByRole("button", { name: `Disconnect ${ORG_A.login}` })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("button", { name: `Confirm disconnecting ${ORG_A.login}` })
      .click();

    const connections = page.getByRole("list", { name: "Installations" });
    await expect(connections).toContainText("Disconnected");
    await expect(
      page.getByRole("button", { name: `Disconnect ${ORG_A.login}` }),
    ).toHaveCount(0);
    await page.goto("/w/connect-a/projects");
    await expect(
      page.getByRole("heading", { name: "No repositories yet" }),
    ).toBeVisible();
    // GitHub still has the installation and the app keeps it for the workspace: the same person cannot connect it
    // to a second workspace of theirs either.
    await page.goto("/workspaces/new");
    const create = page.getByRole("form", { name: "Create a workspace" });
    await create.getByLabel("Name of the workspace").fill("Connect A2");
    await create.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/connect-a2\/projects$/);
    await connectGithub(page, "connect-a2", {
      installOn: ORG_A.login,
      authorizeAs: ownerA,
    });
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "connected already and cannot be connected here" }),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Installations" })).toHaveCount(
      0,
    );
    await context.close();
  });
});
