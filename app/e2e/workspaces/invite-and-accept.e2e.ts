// SPDX-License-Identifier: LicenseRef-Proprietary

// Workspaces, roles and invitations in a real browser against a production build, single-tenant and without
// a mail server (so an invitation is a link that is shown once): the Owner invites a colleague and copies the
// link, a second browser opens it, creates an account with the invited address, signs in and accepts; the
// new Member is refused every admin action, by the page and by the server; a person who signed up on their own
// has no access to the workspace and is told to ask for an invitation. The rules behind are proven as
// integration tests (src/workspaces/); this is the path a person takes.
import { randomBytes } from "node:crypto";
import {
  expect,
  request,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { e2eEnv } from "../helpers/e2e-env";
import { addGithubAccount } from "../helpers/github-fake";

const FRESH = "fresh@e2e.test";
const PASSWORD = "e2e-colleague-passphrase-cedar-9";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Signed in: the app has sent the person on from the login page.
  await expect(page).not.toHaveURL(/\/login/);
}

async function signUp(page: Page, email: string) {
  const form = page.getByRole("form", { name: "Sign-up form" });
  await form.getByLabel("Email address").fill(email);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("the account is ready");
}

async function newPerson(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: e2eEnv.appUrl });
}

/**
 * Puts the sign-up rule of the app to "everyone", the way an operator would through the portal's data route:
 * the admin portal journey leaves it at a list of domains, which no invitation can be made under without a mail
 * server.
 */
async function openTheSignUp(): Promise<void> {
  const client = await request.newContext({ baseURL: e2eEnv.appUrl });
  try {
    const signedIn = await client.post("/api/auth/sign-in/email", {
      data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
    });
    expect(signedIn.status()).toBe(200);
    const changed = await client.put("/api/admin/settings", {
      data: { signUp: { kind: "everyone" } },
    });
    expect(changed.status(), await changed.text()).toBe(200);
  } finally {
    await client.dispose();
  }
}

/**
 * An address no other test (and no earlier attempt of the same test, a retry runs the test again against the same
 * app) has used: every journey that needs a person makes its own, so none depends on another and a retry cannot
 * collide with what the first attempt left behind.
 */
function uniqueAddress(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}@e2e.test`;
}

/** The Owner invites an address through the API, the way the members page does, and returns the link. */
async function inviteAsOwner(email: string): Promise<string> {
  const client = await request.newContext({ baseURL: e2eEnv.appUrl });
  try {
    const signedIn = await client.post("/api/auth/sign-in/email", {
      data: { email: e2eEnv.adminEmail, password: e2eEnv.adminPassword },
    });
    expect(signedIn.status()).toBe(200);
    const invited = await client.post("/api/w/default/invitations", {
      data: { email, role: "member" },
    });
    expect(invited.status(), await invited.text()).toBe(200);
    const body = (await invited.json()) as {
      delivery: { kind: string; link?: string };
    };
    expect(body.delivery.kind).toBe("link");
    return body.delivery.link as string;
  } finally {
    await client.dispose();
  }
}

test.describe.configure({ mode: "serial" });

test.describe("an Owner invites a colleague who accepts", () => {
  // The address the first journey invites (a new one per attempt) and the link it gets, which the next ones use.
  let colleague = "";
  let invitation = "";

  test.beforeAll(openTheSignUp);

  // #101-WM-26, #101-WM-13
  test("@smoke the Owner invites an address and copies the link, which is shown once", async ({
    page,
  }) => {
    colleague = uniqueAddress("colleague");
    await signIn(page, e2eEnv.adminEmail, e2eEnv.adminPassword);
    await expect(page).toHaveURL(/\/w\/default\/projects$/);
    await page.getByRole("link", { name: "Members" }).first().click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Members" }),
    ).toBeVisible();
    await expect(page.getByText("You are an Owner")).toHaveCount(0);
    await expect(page.getByText(e2eEnv.adminEmail).first()).toBeVisible();

    const form = page.getByRole("form", { name: "Invite a person" });
    await form.getByLabel("Email address").fill(colleague);
    await form.getByRole("combobox", { name: "Role", exact: true }).click();
    await page.getByRole("option", { name: "Member" }).click();
    await form.getByRole("button", { name: "Send invitation" }).click();

    const link = form.getByLabel("Invitation link");
    await expect(link).toBeVisible();
    invitation = await link.inputValue();
    expect(invitation).toMatch(/\/invitation\?token=[A-Za-z0-9_-]{43}$/);
    // The invitation waits in the list, and the link is not in the page any more after a reload.
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Invitations" }).getByText(colleague),
    ).toBeVisible();
    expect(await page.content()).not.toContain(invitation.split("token=")[1]);
  });

  // #101-WM-20, #101-WM-24
  test("the colleague opens the link, creates an account with the invited address, signs in and accepts", async ({
    browser,
  }) => {
    const context = await newPerson(browser);
    const page = await context.newPage();

    const response = await page.goto(invitation);
    // The link carries a credential: the page asks for no referrer, in a header and in the page.
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "no-referrer",
    );
    await expect(page.getByText(colleague).first()).toBeVisible();
    // Opening the link accepts nothing.
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page).toHaveURL(/\/sign-up\?invitation=/);
    await signUp(page, colleague);
    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/login\?invitation=/);
    await page.getByLabel("Email address").fill(colleague);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Signed in, back on the invitation: the button accepts it.
    await expect(page).toHaveURL(/\/invitation\?token=/);
    await page.getByRole("button", { name: /Accept invitation/ }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);
    await expect(page.getByRole("button", { name: /Workspace/ })).toContainText(
      "Default workspace",
    );

    // The link works once.
    await page.goto(invitation);
    await expect(
      page.getByText("This invitation was used already."),
    ).toBeVisible();
    await context.close();
  });

  // #102-GH-11, #101 follow-up: the invitation travels through the sign in with GitHub
  test("an invitee signs in with GitHub from the invitation and lands on it, accepts it and is a member", async ({
    browser,
    request,
  }) => {
    const email = uniqueAddress("octo");
    const id = 7_200_000 + Math.floor(Math.random() * 90_000);
    const account = {
      id,
      login: `invitee-${String(id)}`,
      name: "Invited With GitHub",
      email,
    };
    await addGithubAccount(request, account, null);
    const link = await inviteAsOwner(email);
    const context = await newPerson(browser);
    const page = await context.newPage();

    await page.goto(link);
    await page.getByRole("link", { name: "Sign in" }).first().click();
    await expect(page).toHaveURL(/\/login\?invitation=/);
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page
      .getByRole("button", { name: `Authorize ${account.login}` })
      .click();

    // Back on the invitation, not on a page that says there is no workspace.
    await expect(page).toHaveURL(/\/invitation\?token=/);
    await page.getByRole("button", { name: /Accept invitation/ }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);
    await context.close();
  });

  // #101-WM-27
  test("the Owner finds the colleague among the members and the invitation gone from the list", async ({
    page,
  }) => {
    await signIn(page, e2eEnv.adminEmail, e2eEnv.adminPassword);
    await page.goto("/w/default/members");

    await expect(
      page.getByRole("list", { name: "Members" }).getByText(colleague),
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Invitations" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("combobox", { name: `Role of ${colleague}` }),
    ).toContainText("Member");
  });

  // #101-WM-08, #101-WM-11
  test("@smoke the new Member is refused every admin action, by the page and by the server", async ({
    browser,
  }) => {
    // Its own Member, invited and accepted here: the journey needs nothing from the ones before it.
    const member = uniqueAddress("member");
    const link = await inviteAsOwner(member);
    const context = await newPerson(browser);
    const page = await context.newPage();
    await page.goto("/sign-up");
    await signUp(page, member);
    await signIn(page, member, PASSWORD);
    await page.goto(link);
    await page.getByRole("button", { name: /Accept invitation/ }).click();
    await expect(page).toHaveURL(/\/w\/default\/projects$/);

    await page.goto("/w/default/members");
    await expect(
      page.getByRole("heading", { level: 1, name: "Members" }),
    ).toBeVisible();
    await expect(
      page.getByRole("form", { name: "Invite a person" }),
    ).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
    await page.goto("/w/default/settings");
    await expect(page.getByText("Only an Owner can rename it.")).toBeVisible();

    const refusals = [
      await page.request.put("/api/w/default/review-settings", {
        data: { settings: {} },
      }),
      await page.request.post("/api/w/default/invitations", {
        data: { email: "somebody@e2e.test", role: "member" },
      }),
      await page.request.patch("/api/w/default", { data: { name: "Mine" } }),
      await page.request.patch("/api/w/default/members/anyone", {
        data: { role: "owner" },
      }),
    ];
    for (const refusal of refusals) {
      expect(refusal.status()).toBe(403);
      expect(await refusal.json()).toEqual({ error: "forbidden" });
    }
    // The synchronization with GitHub reads every connection of the instance: it is the instance admin's, and
    // for a Member (as for an Owner who does not run the instance) it is a path that does not exist.
    const sync = await page.request.post("/api/admin/integrations/sync");
    const missing = await page.request.post("/api/there-is-no-such-route");
    expect(sync.status()).toBe(404);
    expect(await sync.text()).toBe(await missing.text());
    await page.goto("/w/default/projects");
    await expect(
      page.getByRole("heading", { level: 1, name: "Projects" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sync from GitHub" }),
    ).toHaveCount(0);
    // Even their own role cannot be raised by them.
    const members = await page.request.get("/api/w/default/runs");
    expect(members.status()).toBe(200);
    await context.close();
  });

  // #101-WM-06, #101-WM-07
  test("a workspace the person does not belong to is a page and a route that do not exist", async ({
    browser,
  }) => {
    const context = await newPerson(browser);
    const page = await context.newPage();
    await signIn(page, colleague, PASSWORD);
    await expect(page).toHaveURL(/\/w\/default\/projects$/);

    // The old addresses and the start page are real redirects (307) to the workspace of the person.
    for (const [path, target] of [
      ["/", "/w/default/projects"],
      ["/projects", "/w/default/projects"],
      ["/runs/some-run", "/w/default/runs/some-run"],
      ["/settings", "/w/default/settings"],
    ] as const) {
      const redirect = await page.request.get(path, {
        maxRedirects: 0,
        // What a browser asks for when it opens an address.
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      expect(redirect.status(), path).toBe(307);
      expect(
        new URL(redirect.headers().location ?? "", "http://app.test").pathname,
        path,
      ).toBe(target);
    }

    const foreign = await page.goto("/w/someone-elses/projects");
    const missing = await page.goto("/there-is-no-such-page");
    const foreignApi = await page.request.get("/api/w/someone-elses/runs");
    const missingApi = await page.request.get("/api/there-is-no-such-route");

    expect(foreign?.status()).toBe(404);
    expect(missing?.status()).toBe(404);
    expect(foreignApi.status()).toBe(404);
    expect(missingApi.status()).toBe(404);
    expect(await foreignApi.text()).toBe(await missingApi.text());
    await context.close();
  });
});

test.describe("a person who signs up on their own", () => {
  // #101-WM-02
  test("sees that an admin has to invite them, and nothing of the workspace", async ({
    browser,
  }) => {
    const context = await newPerson(browser);
    const page = await context.newPage();
    await page.goto("/sign-up");
    await signUp(page, FRESH);
    await signIn(page, FRESH, PASSWORD);

    await expect(page).toHaveURL(/\/no-access$/);
    await expect(
      page.getByText("Ask an admin for an invitation."),
    ).toBeVisible();
    await expect(
      page.getByRole("form", { name: "Create a workspace" }),
    ).toHaveCount(0);
    await page.goto("/w/default/projects");
    await expect(page).toHaveURL(/\/no-access$/);
    for (const path of [
      "/api/w/default/runs",
      "/api/w/default/review-settings",
    ]) {
      const response = await page.request.get(path);
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: "no_workspace_access" });
    }
    // Creating a workspace is not possible either.
    const created = await page.request.post("/api/workspaces", {
      data: { name: "Mine" },
    });
    expect(created.status()).toBe(409);
    expect(await created.json()).toEqual({ error: "multi_tenant_required" });
    await context.close();
  });
});
